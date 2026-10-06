// 会話ターンの決定論の層（LLM を呼ばない）。
// 1) LLM が使えないとき（停止中・タイムアウト・例外・AGENT_MODE=rules）の代替
// 2) LLM の結果に最低限の保証をかける postProcess
// 確実に判定できるもの（無反応・緊急語・外部連絡の依頼・テレビの音）はここで決め、
// 文脈が要るものだけ LLM に任せる（docs/01 §6.2「止まる設計」）。

import { TASK_KEYS, TASK_LABELS } from '../types.js';
import type { Classification, Expression, Household, TaskKey } from '../types.js';
import type { Intent, TurnInput, TurnOutcome, TurnRunner } from '../services.js';
import { hhmm, toMinutes } from '../time.js';

// ---------------------------------------------------------------------------
// 緊急語
// ---------------------------------------------------------------------------

/** 家族へ即時に知らせる語（部分一致）。医療の判断はしない。語があれば知らせるだけ */
export const URGENT_KEYWORDS: readonly string[] = [
  '痛い', '痛く', '痛む', 'いたい', '転ん', '転倒', 'ころん', '倒れ', '助けて', 'たすけて',
  '苦しい', '苦し', 'くるしい', '血', '息が', '動けない', 'うごけない',
];

/** 緊急語の誤検知を減らすための除外（否定形・複合語）。検出の前に取り除く */
const URGENT_EXCLUDE: RegExp[] = [
  /(痛|いた|苦し|くるし)く(は|も)?(ない|なかった|ありません|なくなった)/g,
  /(転ん|ころん)で(は|も)?(ない|いない|ません)/g,
  /倒れて(は|も)?(ない|いない|ません)/g,
  /血圧|血糖/g,
];

/** 本人の発話か分からない印（文字起こしが付けるもの） */
const NOISE_MARKER = /^\s*[（(]\s*(テレビ|ラジオ|雑音|来客|音)/;
/** 緊急語を拾わない印（機械の音。来客の声は人が言っているので緊急語は拾う） */
const MACHINE_MARKER = /^\s*[（(]\s*(テレビ|ラジオ|雑音|音)/;
/** ニュース・番組の口調（本人向けの発話ではない） */
const BROADCAST_TONE = /続いては|天気です|天気予報|気象情報|ニュースです|お伝えします|番組|ご覧の|提供は|コマーシャル|CMの|速報/;

/** 返事に緊急語があれば根拠の語を返す。テレビ・雑音の印が付いた文は対象外 */
export function detectUrgent(text: string | null | undefined): string | null {
  if (!text) return null;
  if (MACHINE_MARKER.test(text)) return null;
  let t = text;
  for (const re of URGENT_EXCLUDE) t = t.replace(re, '');
  for (const w of URGENT_KEYWORDS) {
    if (t.includes(w)) return w;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 返事の分析
// ---------------------------------------------------------------------------

/** 外部（家族以外を含む）への連絡の依頼 */
const CONTACT_REQUEST = /(電話|でんわ|連絡|れんらく)[^。！？!?]{0,6}?(して|かけて|ちょうだい|頂戴|ください|頼む|たのむ)|呼んで|よんで/;

const NOT_YET = /まだ|あとで|後で|これから|今から|いまから|待って|まって|(て|で)(い)?ない|いらない|要らない|いいえ|後にする|あとにする/;

const GENERIC_DONE = ['した', 'しました', '済んだ', '済ん', 'すんだ', '済ませ', '終わった', 'おわった', 'できた', 'できました', 'やった', 'はい', 'はーい', 'うん', 'ええ', 'そうよ', 'そうだよ'];

const TASK_DONE: Record<TaskKey, string[]> = {
  greeting: ['おはよう', '眠れ', 'ねむれ', '寝れ', 'まあまあ', '起きた', '元気'],
  diaper: ['替えた', 'かえた', '替えました', '取り替え', 'とりかえ'],
  teeth: ['磨いた', 'みがいた', '磨きました'],
  face: ['洗った', 'あらった', '洗いました'],
  dress: ['着替えた', 'きがえた', '着替えました', '着た'],
  belongings: ['入れた', '入って', 'いれた', 'はいって', '持った', 'もった', 'あるよ', 'あります'],
  pickup: ['来た', 'きた', '来ました', '行ってきます', 'いってきます', '行ってくる'],
  lunch: ['食べた', 'たべた', '食べました', 'いただいた'],
  water: ['飲んだ', 'のんだ', '飲みます', '飲む', 'のむ', 'いただきます', 'もらう'],
  return: ['ただいま', '帰った', '帰りました', '帰ってきた', 'かえってきた'],
  dinner: ['食べた', 'たべた', '食べました', 'いただいた'],
  medicine: ['飲んだ', 'のんだ', '飲みました'],
  bedtime: ['おやすみ', '寝る', '寝ます', 'ねる', '磨いた', '替えた'],
};

/** 何か返事があれば「済み」としてよい項目（起床の挨拶・帰宅は返事そのものが確認になる） */
const ANY_REPLY_IS_DONE: TaskKey[] = ['greeting', 'return'];

const MED_WHAT = /(何|なん|なに)の(薬|くすり)|(薬|くすり)[^。]{0,4}(何|なに|なん)|これ(何|なに|なん)/;
const MED_WHERE = /どこ/;

export interface ReplyAnalysis {
  status: Classification;
  /** 分類の根拠（短く。本人の言葉は抜粋のみ） */
  note: string;
  /** 緊急語（根拠の語） */
  urgentWord: string | null;
  /** 「電話して」などの外部連絡の依頼 */
  contactRequest: boolean;
  /** 服薬の質問への答え（呼び方の決まりから） */
  medicineAnswer: string | null;
}

/** 返事の抜粋（ログ・note・evidence 用。全文は残さない） */
export function excerpt(text: string | null | undefined, max = 30): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

function wordingOf(h: Household, key: string, fallback: string): string {
  const v = h.person.wording?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function analyzeReply(task: TaskKey, replyText: string | null, household: Household): ReplyAnalysis {
  const text = (replyText ?? '').trim();
  if (!text) {
    return { status: 'no_answer', note: '返事なし', urgentWord: null, contactRequest: false, medicineAnswer: null };
  }
  const urgentWord = detectUrgent(text);
  const contactRequest = !MACHINE_MARKER.test(text) && CONTACT_REQUEST.test(text);
  const base = { urgentWord, contactRequest, medicineAnswer: null as string | null };

  // 入力を疑う: 本人の発話か分からないものは判定しない
  if (NOISE_MARKER.test(text) || BROADCAST_TONE.test(text)) {
    return { ...base, status: 'unclear', note: '本人の発話か分からない（テレビ・来客・雑音の可能性）' };
  }

  // 服薬の質問: 決めた言葉で答えるだけ。まだ飲んでいないので not_yet
  const aboutMedicine = task === 'medicine' || /薬|くすり/.test(text);
  const asksWhat = MED_WHAT.test(text);
  const asksWhere = MED_WHERE.test(text);
  if (aboutMedicine && (asksWhat || asksWhere)) {
    const parts: string[] = [];
    if (asksWhat) parts.push(`${wordingOf(household, 'medicine', 'いつものお薬')}ですよ。`);
    if (asksWhere) parts.push(`${wordingOf(household, 'medicinePlace', 'いつもの場所')}にありますよ。`);
    return { ...base, medicineAnswer: parts.join(''), status: 'not_yet', note: `服薬の質問「${excerpt(text, 12)}」` };
  }

  if (NOT_YET.test(text)) {
    return { ...base, status: 'not_yet', note: `「${excerpt(text, 20)}」` };
  }
  const own = [...GENERIC_DONE, ...TASK_DONE[task]];
  if (own.some(w => text.includes(w))) {
    return { ...base, status: 'done', note: `「${excerpt(text, 20)}」` };
  }
  if (ANY_REPLY_IS_DONE.includes(task)) {
    return { ...base, status: 'done', note: `返事あり「${excerpt(text, 20)}」` };
  }
  // 別の項目の語彙だけに当たる（例: 服薬の確認に「食べた」）→ 曖昧なので判定しない
  const other = TASK_KEYS.find(k => k !== task && TASK_DONE[k].some(w => text.includes(w)));
  if (other) {
    return { ...base, status: 'unclear', note: `別の項目（${TASK_LABELS[other]}）の返事の可能性「${excerpt(text, 16)}」` };
  }
  return { ...base, status: 'unclear', note: `判定できない返事「${excerpt(text, 16)}」` };
}

// ---------------------------------------------------------------------------
// 再確認の分数
// ---------------------------------------------------------------------------

/** お迎えの前に残しておく余裕（分） */
const PICKUP_BUFFER_MIN = 15;
export const MIN_RECHECK = 5;
export const MAX_RECHECK = 60;

/**
 * 再確認までの分。計画の recheckMinutes → policy.recheckMinutes の順。
 * デイの日でお迎え前なら、お迎えの 15 分前までに再確認できるよう短縮する（5 分以上）。
 * 例: 8:35 に着替え「まだ」、お迎え 9:00 → 10 分後（8:45）。
 */
export function recheckMinutesFor(input: TurnInput): number {
  const task = input.prompt.task;
  const planItem = input.day.plan.find(p => p.task === task);
  let minutes = planItem?.recheckMinutes ?? input.household.policy.recheckMinutes ?? 15;
  const pickup = input.household.plan.pickupTime;
  if (input.day.isDayservice && pickup) {
    const untilPickup = toMinutes(pickup) - toMinutes(hhmm(input.now));
    if (untilPickup > 0) minutes = Math.min(minutes, untilPickup - PICKUP_BUFFER_MIN);
  }
  return clamp(Math.round(minutes), MIN_RECHECK, MAX_RECHECK);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

// ---------------------------------------------------------------------------
// 本人へ返す一言（責めない、短い、固定文）
// ---------------------------------------------------------------------------

function doneSay(task: TaskKey, h: Household): string {
  switch (task) {
    case 'greeting': return 'よかったです。今日もよろしくお願いしますね。';
    case 'diaper': return `${wordingOf(h, 'diaper', 'おむつ')}、替えられましたね。さっぱりしましたね。`;
    case 'teeth': return '歯磨き、できましたね。すっきりしましたね。';
    case 'face': return 'さっぱりしましたね。';
    case 'dress': return 'お着替え、できましたね。';
    case 'belongings': return 'よかったです。準備ばっちりですね。';
    case 'pickup': return 'いってらっしゃい。楽しんできてくださいね。';
    case 'lunch': return 'よかったです。ごちそうさまでした。';
    case 'water': return 'よかったです。';
    case 'return': return 'おかえりなさい。ゆっくり休んでくださいね。';
    case 'dinner': return 'よかったです。ごちそうさまでした。';
    case 'medicine': return 'お薬、飲めましたね。ありがとうございます。';
    case 'bedtime': return 'おやすみなさい。ゆっくり休んでくださいね。';
  }
}

/** 規則で決めた一言（LLM の最終テキストが無いときにも使う） */
export function fixedSay(status: Classification, task: TaskKey, household: Household, opts: {
  recheck: boolean; urgent: boolean; contactRequest: boolean; medicineAnswer: string | null;
}): string {
  if (opts.urgent) return 'それは心配ですね。ご家族に知らせますね。';
  if (opts.medicineAnswer) return opts.medicineAnswer;
  let s: string;
  switch (status) {
    case 'done': s = doneSay(task, household); break;
    case 'not_yet': s = opts.recheck ? 'わかりました。また少ししたら声をかけますね。' : 'わかりました。'; break;
    case 'no_answer': s = opts.recheck ? 'また少ししたら声をかけますね。' : 'また声をかけますね。'; break;
    case 'unclear': s = 'また後で声をかけますね。'; break;
  }
  if (opts.contactRequest) s = 'ご家族に伝えておきますね。' + (status === 'done' ? s : '');
  return s;
}

export function expressionFor(status: Classification, urgent: boolean): Expression {
  if (urgent) return 'worry';
  switch (status) {
    case 'done': return 'smile';
    case 'not_yet': return 'listen';
    default: return 'think';
  }
}

// ---------------------------------------------------------------------------
// 規則だけの TurnRunner
// ---------------------------------------------------------------------------

/** 停止中（killSwitch）の応答。道具は何も使わない */
export function killSwitchOutcome(startedAt: number): TurnOutcome {
  return {
    classified: { status: 'unclear', note: '停止中', by: 'rules' },
    say: '少し休みますね。',
    expression: 'think',
    toolCalls: [],
    intents: [],
    latencyMs: Date.now() - startedAt,
  };
}

/** 規則で record intent を作る（postProcess の補完にも使う） */
export function ruleRecord(input: TurnInput, a?: ReplyAnalysis): Extract<Intent, { type: 'record' }> {
  const r = a ?? analyzeReply(input.prompt.task, input.replyText, input.household);
  return { type: 'record', task: input.prompt.task, status: r.status, note: r.note };
}

const CONTACT_REASON = '本人から外部への連絡を頼まれました（こちらからは連絡していません）';
const DEPARTURE_REASON = '準備完了、デイへ出発';

/** お迎えが来て出発したら家族へ info で短く知らせる（docs/03 §4、docs/01 §5.1）。urgent/check があるときは足さない */
function wantsDepartureNotice(task: TaskKey, status: Classification, hasHigherNotice: boolean): boolean {
  return task === 'pickup' && status === 'done' && !hasHigherNotice;
}

export function buildRulesOutcome(input: TurnInput, startedAt = Date.now()): TurnOutcome {
  const task = input.prompt.task;
  const a = analyzeReply(task, input.replyText, input.household);
  const intents: Intent[] = [ruleRecord(input, a)];
  const urgent = Boolean(a.urgentWord);

  if (a.urgentWord) {
    intents.push({ type: 'notify', level: 'urgent', reason: `「${a.urgentWord}」という発話があった`, evidence: excerpt(input.replyText, 40) });
  }
  if (a.contactRequest) {
    intents.push({ type: 'notify', level: 'check', reason: CONTACT_REASON, evidence: excerpt(input.replyText, 40) });
  }
  if (wantsDepartureNotice(task, a.status, urgent || a.contactRequest)) {
    intents.push({ type: 'notify', level: 'info', reason: DEPARTURE_REASON, evidence: excerpt(input.replyText, 40) });
  }
  // 痛みなどを訴えた人に同じ確認を繰り返さない（家族へ知らせたので再確認は入れない）
  const wantsRecheck = a.status !== 'done' && !urgent && input.recheckAllowed;
  if (wantsRecheck) {
    intents.push({ type: 'recheck', minutes: recheckMinutesFor(input), reason: `${TASK_LABELS[task]}: ${a.status}` });
  }
  return {
    classified: { status: a.status, note: a.note, by: 'rules' },
    say: fixedSay(a.status, task, input.household, { recheck: wantsRecheck, urgent, contactRequest: a.contactRequest, medicineAnswer: a.medicineAnswer }),
    expression: expressionFor(a.status, urgent),
    toolCalls: [],
    intents,
    latencyMs: Date.now() - startedAt,
  };
}

export class RulesTurnRunner implements TurnRunner {
  async run(input: TurnInput): Promise<TurnOutcome> {
    const startedAt = Date.now();
    if (input.household.killSwitch) return killSwitchOutcome(startedAt);
    const out = postProcess(buildRulesOutcome(input, startedAt), input);
    out.latencyMs = Date.now() - startedAt;
    return out;
  }
}

// ---------------------------------------------------------------------------
// LLM の結果に決定論の保証をかける
// ---------------------------------------------------------------------------

const MAX_SAY_CHARS = 80;
const MAX_SAY_SENTENCES = 2;

/** 本人へ返す一言を整える: Markdown 記号・絵文字を除き、2 文・80 文字以内 */
export function sanitizeSay(raw: string): string {
  let s = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')            // [文](url) → 文
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // 見出し・引用・箇条書き
    .replace(/[*_`~#|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*\n+\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const sentences = s.match(/[^。！？!?]+[。！？!?]*/g) ?? [];
  s = sentences.slice(0, MAX_SAY_SENTENCES).join('').trim();
  if (s.length > MAX_SAY_CHARS) {
    const cut = s.slice(0, MAX_SAY_CHARS);
    const lastEnd = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    s = lastEnd >= 10 ? cut.slice(0, lastEnd + 1) : cut;
  }
  return s;
}

/**
 * LLM（または規則）の結果に決定論の保証をかける。
 * - record intent はちょうど 1 つ（無ければ規則で補う、複数なら最初）。項目はこのターンの項目に固定
 * - 緊急語があるのに notify(urgent) が無ければ足す。外部連絡の依頼に notify(check) が無ければ足す
 * - お迎え（pickup）が done で urgent/check が無ければ notify(info「準備完了、デイへ出発」)を足す
 * - 同じ段階の notify は 1 件に
 * - recheckAllowed=false なら recheck を消す。recheck は 1 つ、分は 5 以上・規則の分数（お迎えからの逆算）以下に丸める
 * - done 以外で recheck が無く、再確認できて緊急でもなければ recheck を補う
 * - 承認のない share_external は blocked に変える（beforeToolCallback との二重の守り）
 * - say は Markdown 除去、2 文・80 文字以内。空なら規則の固定文
 * - blocked intent はそのまま残す（台帳に「止めた」を残すため）
 */
export function postProcess(outcome: TurnOutcome, input: TurnInput): TurnOutcome {
  const task = input.prompt.task;
  const analysis = analyzeReply(task, input.replyText, input.household);
  const intents: Intent[] = [];
  let record: Extract<Intent, { type: 'record' }> | null = null;
  let recheck: Extract<Intent, { type: 'recheck' }> | null = null;
  const notifyLevels = new Set<string>();

  for (const it of outcome.intents) {
    switch (it.type) {
      case 'record':
        if (!record) { record = { ...it, task }; intents.push(record); }
        break;
      case 'recheck':
        if (!input.recheckAllowed || recheck) break;
        // 規則の分数（お迎えからの逆算を含む）より長くはしない
        recheck = { ...it, minutes: clamp(Math.min(Math.round(it.minutes), recheckMinutesFor(input)), MIN_RECHECK, MAX_RECHECK) };
        intents.push(recheck);
        break;
      case 'notify':
        if (notifyLevels.has(it.level)) break;
        notifyLevels.add(it.level);
        intents.push(it);
        break;
      case 'share_external':
        if (input.familyApprovedShare) intents.push(it);
        else intents.push({ type: 'blocked', tool: 'share_external', args: { recipient: it.recipient }, reason: '家族の承認がない' });
        break;
      case 'blocked':
        intents.push(it);
        break;
    }
  }

  if (!record) {
    record = ruleRecord(input, analysis);
    intents.unshift(record);
  }
  if (analysis.urgentWord && !notifyLevels.has('urgent')) {
    notifyLevels.add('urgent');
    intents.push({ type: 'notify', level: 'urgent', reason: `「${analysis.urgentWord}」という発話があった`, evidence: excerpt(input.replyText, 40) });
  }
  if (analysis.contactRequest && !notifyLevels.has('check')) {
    notifyLevels.add('check');
    intents.push({ type: 'notify', level: 'check', reason: CONTACT_REASON, evidence: excerpt(input.replyText, 40) });
  }

  if (!notifyLevels.has('info') && wantsDepartureNotice(task, record.status, notifyLevels.has('urgent') || notifyLevels.has('check'))) {
    notifyLevels.add('info');
    intents.push({ type: 'notify', level: 'info', reason: DEPARTURE_REASON, evidence: excerpt(input.replyText, 40) });
  }

  const urgent = notifyLevels.has('urgent');
  // 取れなかった項目は再確認の対象（docs/02 §4, §5）。痛みなどの訴えがあるときは同じ確認を繰り返さない
  if (!recheck && !urgent && input.recheckAllowed && record.status !== 'done') {
    recheck = { type: 'recheck', minutes: recheckMinutesFor(input), reason: `${TASK_LABELS[task]}: ${record.status}（規則で補完）` };
    intents.push(recheck);
  }
  let say = sanitizeSay(outcome.say ?? '');
  if (!say) {
    say = fixedSay(record.status, task, input.household, {
      recheck: Boolean(recheck), urgent, contactRequest: analysis.contactRequest, medicineAnswer: analysis.medicineAnswer,
    });
  }

  return {
    ...outcome,
    classified: { status: record.status, note: record.note, by: outcome.classified.by },
    say,
    expression: expressionFor(record.status, urgent),
    intents,
  };
}
