// 審査員向けのデモ世帯 hh_demo に、架空の 14 日分（今日の前日まで）の記録を入れる（docs/02 §11.5）。
// 家族画面の「昨日までとの比較」や日ごとの記録が空にならないようにするため。中身はすべて架空のサンプル
// （世帯名「テスト世帯」、本人「お母さん」、家族「はなこ」）。各日の要約の「この記録について」にも架空であることを書く。
//
// 実行（リポジトリの直下で）:
//   gcloud auth application-default login   … 済んでいれば不要
//   NODE_EXTRA_CA_CERTS="$LOCALAPPDATA/Google/Cloud SDK/ca-bundle.pem" FIRESTORE_DATABASE=develop npx tsx scripts/seed-demo-history.ts
//   オプション: --days 14（日数）、--today 2026-10-07（基準日。省略時は今日 JST）、--dry-run（書かずに中身だけ表示）
//
// 本番（default）への書き込みは --force-default を付けたときだけ（seed-dev と同じ）。
// 対象の日（今日の前日から N 日）の hh_demo の記録（days・prompts・turns・notices・ledger）は消してから入れ直す。
// 何度流しても同じ中身になる（日付から決まる疑似乱数）。世帯（households/hh_demo）が無ければ demoHousehold を入れる。
// 返事の本文（turns）は本番と同じく TTL（expiresAt）で消えるので、デモの前日までに流し直すこと（expiresAt は実行時から 7 日）。

import { FirestoreStore, stripUndefined } from '../src/store/firestore.js';
import { MemoryStore } from '../src/store/memory.js';
import { demoHousehold } from '../src/seed/household.js';
import { config } from '../src/config.js';
import { resolvePlan } from '../src/state/plan.js';
import { SECTION_TITLES, buildSummary } from '../src/state/summary.js';
import { emptyRecord } from '../src/state/machine.js';
import { addMinutes, dateKey, hhmm, jstDate, shiftDateKey } from '../src/time.js';
import type {
  Classification, Day, DaySummary, Expression, Household, LedgerEntry, Notice, NoticeLevel, NoticeOrigin, Prompt, TaskKey,
  TaskRecord, Turn,
} from '../src/types.js';

const HH = 'hh_demo';
const MEMBER = 'mem_demo_1';
const SAMPLE_NOTE = 'この日の記録は、審査用の架空のサンプルです。';

// ---- 引数 ----
const argv = process.argv.slice(2);
function argOf(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const database = process.env.FIRESTORE_DATABASE ?? 'develop';
const forceDefault = argv.includes('--force-default');
const dryRun = argv.includes('--dry-run');
const DAYS = Math.max(1, Math.min(31, Number(argOf('--days') ?? 14)));
const today = argOf('--today') ?? dateKey(new Date());

if (database === 'default' && !forceDefault && !dryRun) {
  console.error('本番（default）データベースには書きません。本当に書くときは --force-default を付けてください。');
  process.exit(1);
}

// ---- 日付から決まる疑似乱数（何度流しても同じ） ----
function rngFor(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// ---- 架空の返事 ----
const REPLIES: Partial<Record<TaskKey, readonly string[]>> = {
  greeting: ['おはよう', 'うん、まあまあ', 'よく寝たよ', 'おはようさん'],
  diaper: ['替えたよ', 'うん、替えた'],
  teeth: ['はいはい', '磨いたよ'],
  face: ['洗ったよ', 'さっぱりした'],
  dress: ['着替えたよ', '着たよ'],
  pickup: ['来たよ、行ってきます'],
  lunch: ['食べた', 'うどん食べたよ', 'おにぎり食べた'],
  water: ['飲んだよ', 'いただきます'],
  return: ['ただいま', '楽しかったよ'],
  dinner: ['食べた', 'おいしかった'],
  medicine: ['飲んだよ'],
  bedtime: ['はい、おやすみ'],
};
const DONE_SAY: Partial<Record<TaskKey, string>> = {
  greeting: 'よかったです。今日もよろしくお願いしますね。', diaper: 'おむつ、替えられましたね。さっぱりしましたね。',
  teeth: '歯磨き、できましたね。すっきりしましたね。', face: 'さっぱりしましたね。', dress: 'お着替え、できましたね。',
  pickup: 'いってらっしゃい。楽しんできてくださいね。', lunch: 'よかったです。ごちそうさまでした。', water: 'よかったです。',
  return: 'おかえりなさい。ゆっくり休んでくださいね。', dinner: 'よかったです。ごちそうさまでした。',
  medicine: 'お薬、飲めましたね。ありがとうございます。', bedtime: 'おやすみなさい。ゆっくり休んでくださいね。', bath: 'ゆっくりどうぞ。',
};

type NoticeKind = 'bath_info' | 'pain_check' | 'departure_info' | 'no_answer_false_alarm';

interface DayData {
  day: Day;
  prompts: Prompt[];
  turns: Turn[];
  notices: Notice[];
  ledger: LedgerEntry[];
}

const expiresAt = addMinutes(new Date(), 7 * 24 * 60);

function buildDay(h: Household, date: string, index: number, spike: boolean): DayData {
  const r = rngFor(`${HH}/${date}`);
  const { isDayservice, items } = resolvePlan(h, date);
  const prompts: Prompt[] = [];
  const turns: Turn[] = [];
  const notices: Notice[] = [];
  const ledger: LedgerEntry[] = [];
  const tasks: Day['tasks'] = {};
  let seq = 0;
  let lg = 0;
  const addLedger = (e: Omit<LedgerEntry, 'id' | 'hh' | 'date'>) => {
    ledger.push({ id: `lg_demo_${date}_${String(++lg).padStart(3, '0')}`, hh: HH, date, ...e });
  };

  // 計画の項目はすべて済み（声かけの記録としては、その日に選んだ 3〜5 件だけ返事を残す）
  for (const it of items) {
    const at = jstDate(date, it.time);
    tasks[it.task] = { ...emptyRecord(), state: 'done', status: 'done', at: addMinutes(at, 1), failCount: 0, noAnswerStreak: 0 };
  }

  function addTurn(task: TaskKey, time: string, reply: string | null, status: Classification, opts: {
    text?: string; say?: string; expression?: Expression; kind?: Turn['kind']; utteranceKind?: Turn['utteranceKind'];
  } = {}): Turn {
    seq += 1;
    const promptedAt = jstDate(date, time);
    const repliedAt = addMinutes(promptedAt, reply == null ? 5 : 1);
    const id = `tn_demo_${date}_${seq}`;
    const promptId = opts.kind === 'utterance' ? 'utterance' : `pr_demo_${date}_${seq}`;
    const text = opts.text ?? items.find(i => i.task === task)?.text ?? '';
    if (opts.kind !== 'utterance') {
      prompts.push({
        id: promptId, hh: HH, date, task, text, scheduledAt: promptedAt, isRecheck: false,
        state: reply == null ? 'expired' : 'answered', deliveredAt: promptedAt, expression: 'smile',
        ...(task === 'bath' ? { bathStep: 'wash' as const } : {}),
      });
      addLedger({ at: promptedAt, actor: 'agent', kind: 'prompt', name: 'prompt_sent', args: { promptId, task, isRecheck: false, text }, turnId: null, noticeId: null });
    }
    const turn: Turn = {
      id, hh: HH, date, promptId, task, promptedAt, promptText: opts.kind === 'utterance' ? '' : text,
      replyText: reply, replySource: 'test', repliedAt,
      classified: { status, note: reply ? `「${reply.slice(0, 20)}」` : '返事なし', by: 'rules', confidence: 1, uncertain: false },
      ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.utteranceKind ? { utteranceKind: opts.utteranceKind } : {}),
      toolCalls: [], say: opts.say ?? (status === 'done' ? DONE_SAY[task] ?? 'よかったです。' : ''),
      expression: opts.expression ?? (status === 'done' ? 'smile' : 'listen'), latencyMs: 0, expiresAt,
    };
    turns.push(turn);
    addLedger({
      at: repliedAt, actor: 'agent', kind: 'prompt', name: opts.kind === 'utterance' ? 'utterance_received' : 'reply_received',
      args: { promptId, task, source: 'test', reply: reply ? reply.slice(0, 20) : null }, turnId: id, noticeId: null,
    });
    if (opts.kind !== 'utterance') {
      addLedger({ at: repliedAt, actor: 'agent', kind: 'tool_result', name: 'turn_classified', args: { task, promptId }, result: { status, by: 'rules' }, turnId: id, noticeId: null });
      const prev = tasks[task] ?? emptyRecord();
      const rec: TaskRecord = {
        ...prev, state: status === 'done' ? 'done' : prev.state === 'done' ? 'asked' : prev.state, status, at: repliedAt,
        promptIds: [...prev.promptIds, promptId], lastTurnId: id,
        ...(reply ? { evidence: reply.slice(0, 30) } : {}),
      };
      tasks[task] = rec;
    }
    return turn;
  }

  function addNotice(level: NoticeLevel, origin: NoticeOrigin, reason: string, evidence: string, turn: Turn, opts: { falseAlarm?: boolean } = {}): void {
    const createdAt = addMinutes(turn.repliedAt, 0);
    const ackedAt = level === 'info' ? null : addMinutes(createdAt, 6);
    const n: Notice = {
      id: `nt_demo_${date}_${notices.length + 1}`, hh: HH, date, level, reason, evidence, turnId: turn.id, task: turn.task,
      steps: [{ memberId: MEMBER, channel: 'line', sentAt: createdAt, ackedAt }],
      state: level === 'info' ? 'closed' : 'acked', createdAt, origin,
      ...(ackedAt ? { ackedBy: MEMBER } : {}), ...(opts.falseAlarm ? { falseAlarm: true } : {}),
    };
    notices.push(n);
    addLedger({ at: createdAt, actor: 'agent', kind: 'notice', name: 'notice_sent', args: { level, reason }, turnId: turn.id, noticeId: n.id });
    if (ackedAt) {
      addLedger({ at: ackedAt, actor: `member:${MEMBER}`, kind: 'notice', name: 'notice_acked', args: { memberId: MEMBER, falseAlarm: opts.falseAlarm === true }, turnId: turn.id, noticeId: n.id });
    }
  }

  // ---- 計画の声かけへの返事（3〜5 件） ----
  addLedger({ at: jstDate(date, '06:00'), actor: 'agent', kind: 'plan', name: 'plan_proposed', args: { isDayservice, items: items.map(i => ({ time: i.time, task: i.task })) }, turnId: null, noticeId: null });
  const candidates = items.filter(i => REPLIES[i.task] && i.task !== 'pickup' && i.task !== 'return');
  const count = randInt(r, 3, 4);
  const chosen = [...candidates].sort(() => r() - 0.5).slice(0, count).sort((a, b) => (a.time < b.time ? -1 : 1));
  let noAnswerCount = 0;
  let unclearCount = 0;
  for (const it of chosen) {
    // 日によって「まだ」→ 再確認で済み、を 1 件
    if (it.task === 'dress' && r() < 0.5) {
      addTurn('dress', it.time, 'まだ', 'not_yet', { say: 'わかりました。また少ししたら声をかけますね。' });
      addTurn('dress', hhmm(addMinutes(jstDate(date, it.time), 15)), '着替えたよ', 'done', { text: 'そろそろお着替えどうですか？' });
      continue;
    }
    if (it.task === 'medicine' && r() < 0.5) {
      addTurn('medicine', it.time, '何の薬？', 'not_yet', { say: '脳の薬ですよ。' });
      continue;
    }
    addTurn(it.task, it.time, pick(r, REPLIES[it.task]!), 'done');
  }

  // ---- その日のお知らせ（2 日に 1 件ほど） ----
  const kinds: NoticeKind[] = ['bath_info', 'pain_check', 'departure_info', 'no_answer_false_alarm', 'bath_info', 'departure_info', 'bath_info'];
  if (index % 2 === 0) {
    let kind = kinds[(index / 2) % kinds.length];
    if (kind === 'departure_info' && !isDayservice) kind = 'bath_info';
    if (kind === 'bath_info') {
      const t = addTurn('bath', '20:10', 'はい', 'done', { text: 'そろそろ体を洗いましょうか', say: 'ゆっくりどうぞ。' });
      addNotice('info', 'bath', '体を洗い始めました', 'はい', t);
    } else if (kind === 'departure_info') {
      const t = addTurn('pickup', '09:00', '来たよ、行ってきます', 'done');
      addNotice('info', 'departure', '準備完了、デイへ出発', '来たよ、行ってきます', t);
    } else if (kind === 'pain_check') {
      const task: TaskKey = isDayservice ? 'return' : 'water';
      const time = isDayservice ? '16:00' : '15:30';
      const reply = isDayservice ? '疲れた。腰がちょっと痛い' : 'ありがとう。でも腰が痛いの';
      const t = addTurn(task, time, reply, 'done', { say: 'それはつらいですね。無理をしないでくださいね。', expression: 'worry' });
      addNotice('check', 'pain', '腰が痛いとおっしゃいました。どの程度か、動けるかは分かりません。', reply, t);
      // 3 時間後の聞き直し
      const f = addTurn(task, isDayservice ? '19:00' : '18:30', 'もう大丈夫よ', 'done', {
        text: 'さっき腰が痛いとおっしゃっていましたが、今はどうですか？', kind: 'followup', say: 'よかったです。無理をしないでくださいね。',
      });
      f.followupNoticeId = notices.at(-1)!.id;
    } else {
      const task: TaskKey = isDayservice ? 'water' : 'lunch';
      const t1 = isDayservice ? '16:30' : '12:00';
      const t2 = isDayservice ? '16:45' : '12:15';
      addTurn(task, t1, null, 'no_answer', { say: 'また少ししたら声をかけますね。' });
      const t = addTurn(task, t2, null, 'no_answer', { say: 'また少ししたら声をかけますね。', text: isDayservice ? 'お茶、飲めましたか？' : 'お昼ご飯、食べられましたか？' });
      noAnswerCount += 2;
      addNotice('check', 'no_answer', `${t1.replace(/^0/, '')} から 2 回の声かけに返事がありません。家の電話にかけてみてください。話せたら『確認した』を押してください`, `${t1} 返事なし／${t2} 返事なし`, t, { falseAlarm: true });
      // 家族が電話して、昼寝だったと分かった（その後のお返事）
      addTurn(task, isDayservice ? '17:00' : '12:30', isDayservice ? '飲んだよ' : '食べたよ、寝てたの', 'done', { text: isDayservice ? 'お茶、飲めましたか？' : 'お昼ご飯、食べられましたか？' });
    }
  }
  if (r() < 0.3) {
    addTurn('water', isDayservice ? '16:30' : '10:30', '（テレビの音）', 'unclear', { say: 'また後で声をかけますね。', expression: 'think' });
    turns.at(-1)!.classified = { status: 'unclear', note: '本人の声か分からない（テレビ・来客・雑音の可能性）', by: 'rules', confidence: 0.5, uncertain: true };
    unclearCount += 1;
  }

  // ---- 本人からの質問（同じ質問の回数の材料）。ふだん 1〜3 回、ある 2 日だけ 5〜6 回 ----
  const repeated = spike ? randInt(r, 5, 6) : randInt(r, 1, 3);
  const qTime = isDayservice ? '17:10' : '14:00';
  addTurn('talk', qTime, 'はなこはどこに行ったの', 'done', { kind: 'utterance', utteranceKind: 'whereabouts', say: 'はなこさんは、お仕事に行っています。18 時ごろ帰ります。' });

  const falseAlarmCount = notices.filter(n => n.falseAlarm).length;
  const day: Day = {
    hh: HH, date, isDayservice, plan: items,
    planApproved: { by: 'family', at: jstDate(date, '07:10') },
    tasks,
    summary: null,
    signals: { unclearCount, noAnswerCount, repeatedQuestions: repeated, urgentCount: 0, ...(falseAlarmCount ? { falseAlarmCount } : {}) },
    l4: null,
    createdAt: jstDate(date, '06:00'),
  };
  addLedger({ at: jstDate(date, '07:10'), actor: 'member:family', kind: 'plan', name: 'plan_approved', args: { by: 'family' }, turnId: null, noticeId: null });
  return { day, prompts, turns, notices, ledger };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 要約の「昨日までとの比較」を、それまでのサンプルの日と比べた文に差し替え、「この記録について」に架空であることを足す */
function patchSummary(summary: DaySummary, day: Day, previous: Day[]): DaySummary {
  const q = day.signals.repeatedQuestions;
  let comparison: string[];
  const home = previous.filter(d => !d.isDayservice);
  if (day.isDayservice) {
    comparison = [`同じ質問の記録は、今日は ${q} 回でした。`, '本日はデイサービスの予定があるため、在宅日どうしの回数比較には含めていません。'];
  } else if (home.length === 0) {
    comparison = [`同じ質問の記録は、今日は ${q} 回でした。比べる在宅日の記録がまだありません。`];
  } else {
    const med = median(home.map(d => d.signals.repeatedQuestions));
    const fmt = String(Math.round(med * 10) / 10);
    comparison = [q >= med + 3 && q >= med * 1.5
      ? `同じ質問の記録は今日 ${q} 回で、それまでの在宅日（1 日 ${fmt} 回ほど）より多めでした。`
      : `同じ質問の記録は今日 ${q} 回で、それまでの在宅日（1 日 ${fmt} 回ほど）と比べて、目立った増え方はありません。`];
  }
  const sections = { ...(summary.sections ?? {}) };
  sections.comparison = comparison;
  sections.about = [...(sections.about ?? []), SAMPLE_NOTE];
  const sentences: string[] = [];
  const titleOf = (k: string) => (SECTION_TITLES as Record<string, string>)[k];
  // 見出し・結論・各節を同じ順で組み直す（引用の位置は「お返事の記録」〜「お知らせの続き」なので変わらない）
  sentences.push(...(sections.heading ?? []), ...(sections.conclusion ?? []));
  for (const k of Object.keys(SECTION_TITLES)) {
    sentences.push(titleOf(k));
    for (const l of sections[k] ?? []) sentences.push(`・${l}`);
  }
  return {
    ...summary, sentences, text: sentences.join('\n'), sections, changeNote: comparison.join(''),
    sentAt: jstDate(day.date, '18:00'),
  };
}

// ---------------------------------------------------------------------------

const h = demoHousehold();
const dates = Array.from({ length: DAYS }, (_, i) => shiftDateKey(today, -(DAYS - i)));   // 古い順
// 増えている 2 日: 一番新しい在宅日 2 日
const homeDates = dates.filter(d => !resolvePlan(h, d).isDayservice);
const spikes = new Set(homeDates.slice(-2));

// まずメモリで組み立て、要約は本物の buildSummary（決定論）で作る
const mem = new MemoryStore();
await mem.putHousehold(h);
const built: DayData[] = [];
for (const [i, date] of dates.entries()) {
  const d = buildDay(h, date, DAYS - i, spikes.has(date));
  await mem.putDay(d.day);
  for (const p of d.prompts) await mem.putPrompt(p);
  for (const t of d.turns) await mem.putTurn(t);
  for (const n of d.notices) await mem.putNotice(n);
  const s = await buildSummary({ store: mem }, HH, date, { useLlm: false });
  d.day.summary = patchSummary(s, d.day, built.map(b => b.day));
  await mem.updateDay(HH, date, { summary: d.day.summary });
  d.ledger.push({
    id: `lg_demo_${date}_999`, hh: HH, date, at: jstDate(date, '18:00'), actor: 'agent', kind: 'summary', name: 'summary_sent',
    args: { sentences: d.day.summary.sentences.length, citations: d.day.summary.citations.length }, turnId: null, noticeId: null,
  });
  built.push(d);
}

console.log(`対象: ${config.projectId}/${database} households/${HH}（${h.name}）、${dates[0]} 〜 ${dates.at(-1)}（${DAYS} 日、基準日 ${today}）`);
for (const d of built) {
  const s = d.day.signals;
  console.log(`  ${d.day.date} ${d.day.isDayservice ? 'デイ' : '在宅'} turns=${d.turns.length} notices=${d.notices.map(n => `${n.level}${n.falseAlarm ? '(誤報)' : ''}`).join(',') || '-'} 同じ質問=${s.repeatedQuestions}${spikes.has(d.day.date) ? '（多め）' : ''} 無反応=${s.noAnswerCount} ledger=${d.ledger.length}`);
}
if (dryRun) {
  console.log('\n--dry-run のため書き込みません。最後の日の要約:');
  console.log(built.at(-1)!.day.summary!.text);
  process.exit(0);
}

// ---- Firestore へ（対象の日の hh_demo の記録を消してから入れる） ----
const store = new FirestoreStore({ projectId: config.projectId, databaseId: database });
const db = store.db;
const hhRef = db.collection('households').doc(HH);
const existing = await store.getHousehold(HH);
if (!existing) {
  await store.putHousehold({ ...h, createdAt: new Date() });
  console.log(`世帯が無かったので入れました: households/${HH}`);
} else {
  // 既にある世帯は丸ごと上書きしない（LINE の登録などを残す）。docs/02 §11 の項目が無ければ足し、旧い家族名だけ架空の「はなこ」に
  const patch: Partial<Household> = {};
  if (existing.mode === undefined) { patch.mode = 'bedroom'; patch.bath = null; }
  if (existing.whereabouts === undefined) patch.whereabouts = null;
  if (existing.policy.idleChatMinutes === undefined || existing.policy.bath === undefined) {
    patch.policy = { ...existing.policy, idleChatMinutes: existing.policy.idleChatMinutes ?? h.policy.idleChatMinutes, bath: existing.policy.bath ?? h.policy.bath };
  }
  if (existing.members.some(m => m.id === MEMBER && m.name === 'テスト家族')) {
    patch.members = existing.members.map(m => (m.id === MEMBER && m.name === 'テスト家族' ? { ...m, name: 'はなこ' } : m));
  }
  if (Object.keys(patch).length > 0) {
    await store.updateHousehold(HH, patch);
    console.log(`世帯に足した項目: ${Object.keys(patch).join(', ')}`);
  }
}

async function deleteDocs(refs: FirebaseFirestore.DocumentReference[]): Promise<number> {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
}

let removed = 0;
for (const date of dates) {
  const dayRef = hhRef.collection('days').doc(date);
  const [pr, tn, nt, lg, ptr] = await Promise.all([
    dayRef.collection('prompts').listDocuments(),
    dayRef.collection('turns').listDocuments(),
    hhRef.collection('notices').where('date', '==', date).get(),
    hhRef.collection('ledger').where('date', '==', date).get(),
    hhRef.collection('turns').where('date', '==', date).get(),
  ]);
  removed += await deleteDocs([...pr, ...tn, ...nt.docs.map(d => d.ref), ...lg.docs.map(d => d.ref), ...ptr.docs.map(d => d.ref)]);
}
console.log(`消した記録: ${removed} 件`);

let written = 0;
for (const d of built) {
  await store.putDay(d.day);
  for (const p of d.prompts) { await store.putPrompt(p); written += 1; }
  for (const t of d.turns) { await store.putTurn(t); written += 1; }
  for (const n of d.notices) { await store.putNotice(n); written += 1; }
  for (let i = 0; i < d.ledger.length; i += 400) {
    const batch = db.batch();
    for (const e of d.ledger.slice(i, i + 400)) batch.set(hhRef.collection('ledger').doc(e.id), stripUndefined(e) as FirebaseFirestore.DocumentData);
    await batch.commit();
  }
  written += d.ledger.length + 1;
}
console.log(`書き込み: ${built.length} 日、${written} 件。完了`);

// 確かめ: 今日から見た直近 14 日が読めるか
const recent = await store.listRecentDays(HH, today, 14);
console.log(`確認: listRecentDays(${today}, 14) = ${recent.length} 日（${recent.map(d => d.date).at(-1)} 〜 ${recent[0]?.date}）`);
