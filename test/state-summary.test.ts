// 今日の様子（report-design v2 1 節の型）と「昨日までとの比較」（criteria v2 3-4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { createFakeContext } from '../src/state/fakes.js';
import {
  ABOUT_TEXT, BASELINE_DAYS, buildAndSendSummary, buildSummary, compareRepeatedQuestions, keepsFacts,
} from '../src/state/summary.js';
import { jstDate, shiftDateKey } from '../src/time.js';
import type { Classification, Day, DaySignals, Notice, TaskKey, Turn } from '../src/types.js';

const HH = 'hh_t';
const D = '2026-10-01';   // 木曜（在宅日）

function signals(p: Partial<DaySignals> = {}): DaySignals {
  return { unclearCount: 0, noAnswerCount: 0, repeatedQuestions: 0, urgentCount: 0, ...p };
}

function pastDay(date: string, s: Partial<DaySignals> = {}, isDayservice = false): Day {
  return { hh: HH, date, isDayservice, plan: [], planApproved: null, tasks: {}, summary: null, signals: signals(s) };
}

let seq = 0;
function turn(time: string, task: TaskKey, replyText: string | null, status: Classification, extra: Partial<Turn> = {}): Turn {
  seq += 1;
  const at = jstDate(D, time);
  return {
    id: `tn_${seq}`, hh: HH, date: D, promptId: `pr_${seq}`, task, promptedAt: at, promptText: '…', replyText,
    replySource: 'test', repliedAt: new Date(at.getTime() + 60_000),
    classified: { status, note: '', by: 'rules', confidence: status === 'unclear' ? 0.5 : 1, uncertain: status === 'unclear' },
    toolCalls: [], say: '', expression: 'smile', latencyMs: 1, ...extra,
  };
}

function notice(p: Partial<Notice> & Pick<Notice, 'id' | 'level'>): Notice {
  return { hh: HH, date: D, reason: '', evidence: '', turnId: null, steps: [], state: 'waiting', createdAt: jstDate(D, '12:00'), ...p };
}

async function seed() {
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold(HH));
  await store.putDay({ ...pastDay(D, { repeatedQuestions: 1, noAnswerCount: 2 }), tasks: {} });
  const pain = turn('11:30', 'water', 'ちょっと腰が痛いの', 'done');
  const turns = [
    turn('08:40', 'dress', 'まだ', 'not_yet'),
    turn('09:10', 'dress', '着替えたよ', 'done'),
    turn('10:30', 'water', '（テレビの音）続いては天気です', 'unclear'),
    pain,
    turn('12:00', 'lunch', null, 'no_answer'),
    turn('12:15', 'lunch', 'うーん、どうだったかしら', 'done', { classified: { status: 'done', note: '', by: 'llm', confidence: 0.4, uncertain: true } }),
    turn('14:31', 'water', 'もう大丈夫よ', 'done', { kind: 'followup', followupNoticeId: 'nt_pain' }),
    turn('16:00', 'water', '疲れた', 'done'),
  ];
  for (const t of turns) await store.putTurn(t);
  await store.putNotice(notice({
    id: 'nt_pain', level: 'check', origin: 'pain', task: 'water', turnId: pain.id, createdAt: jstDate(D, '11:31'),
    reason: '腰が痛いとおっしゃいました。どの程度か、動けるかは分かりません。', evidence: 'ちょっと腰が痛いの',
  }));
  await store.putNotice(notice({
    id: 'nt_contact', level: 'check', origin: 'contact', task: 'lunch', turnId: 'tn_x', createdAt: jstDate(D, '13:00'),
    reason: '本人から外部への連絡を頼まれました', evidence: '妹に電話して', falseAlarm: true, state: 'acked',
  }));
  await store.putNotice(notice({
    id: 'nt_cap', level: 'info', origin: 'not_done', task: 'lunch', createdAt: jstDate(D, '15:00'),
    reason: '昼食がまだのようです', evidence: '昼食: 12:00 返事なし', state: 'deferred', deferredReason: 'daily_cap',
  }));
  await store.putNotice(notice({ id: 'nt_dep', level: 'info', origin: 'departure', reason: '準備完了', createdAt: jstDate(D, '09:00') }));
  return { store, turns };
}

test('report-design v2 の型: 見出し・結論・お返事の記録・気になったこと・お知らせの続き・比較・この記録について', async () => {
  const { store, turns } = await seed();
  const s = await buildSummary({ store }, HH, D, { useLlm: false });
  const sec = s.sections!;

  assert.deepEqual(sec.heading, ['今日の様子 10月1日（木）']);
  assert.deepEqual(sec.conclusion, ['今日は 2 件、確認をお願いしたいことがあります。']);
  // 8:40 の「まだ」は、同じ着替えの次のお返事（9:10）が済みなので書かない（最終状態だけを書く）
  assert.deepEqual(sec.replies, [
    '9:10 着替えの声かけに「着替えたよ」とお返事がありました。',
    '11:30 水分の声かけに「ちょっと腰が痛いの」とお返事がありました。',
    '12:00 昼食の声かけには、お返事がありませんでした。',
    '16:00 水分の声かけに「疲れた」とお返事がありました。',
  ]);
  assert.deepEqual(sec.concerns, [
    '11:31 「ちょっと腰が痛いの」とおっしゃいました。そのときにお知らせ済みです。14:31 に聞き直したところ「もう大丈夫よ」とのことでした。',
    '13:00 「妹に電話して」と頼まれました（こちらからは連絡していません）。そのときにお知らせ済みです。ご家族が「誤報だった」と記録されました。',
    '16:01 「疲れた」とおっしゃいました。',
  ]);
  assert.deepEqual(sec.continued, [
    '12:15 昼食の声かけへのお返事「うーん、どうだったかしら」は、AI では判断できませんでした。',
    '15:00 昼食がまだのようです（昼食: 12:00 返事なし）。',
    'お母さんのお声か分からない音や声が 1 回ありました（内容は載せていません）。',
  ]);
  assert.match(sec.comparison[0], /記録を集めている期間です（1 日目）/);
  assert.deepEqual(sec.about, [ABOUT_TEXT]);

  // テレビの音の原文は家族に送らない
  assert.ok(!s.text.includes('天気です'));
  // 語彙: 「発言」「訴え」「発話」は使わない
  assert.ok(!/発言|訴え|発話/.test(s.text));
  // 見出しの並びと text
  assert.deepEqual(s.sentences.filter(x => !x.startsWith('・')), [
    '今日の様子 10月1日（木）', '今日は 2 件、確認をお願いしたいことがあります。',
    'お返事の記録', '気になったこと', 'お知らせの続き', '昨日までとの比較', 'この記録について',
  ]);
  assert.equal(s.text, s.sentences.join('\n'));
  assert.equal(s.changeNote, sec.comparison.join(''));
  // 引用: 「お返事の記録」「気になったこと」の各行にターン
  const cited = (line: string) => s.citations.find(c => s.sentences[c.sentenceIndex] === `・${line}`)?.turnId;
  assert.equal(cited(sec.replies[0]), turns[1].id);
  assert.equal(cited(sec.concerns[0]), turns[3].id);
  assert.equal(cited(sec.concerns[2]), turns[7].id);
});

test('何も無い日: 結論は「確認をお願いする返答はありませんでした」、気になったこと・お知らせの続きは「ありません。」', async () => {
  const store = new MemoryStore();
  await store.putDay({ ...pastDay(D), tasks: {} });
  const s = await buildSummary({ store }, HH, D, { useLlm: false });
  assert.deepEqual(s.sections!.conclusion, ['今日の記録には、確認をお願いする返答はありませんでした。']);
  assert.deepEqual(s.sections!.concerns, ['ありません。']);
  assert.deepEqual(s.sections!.continued, ['ありません。']);
  assert.deepEqual(s.citations, []);
});

/** 直近 14 日（新しい順）。在宅日の同じ質問の回数を並べる */
function history(counts: number[], opts: { dayserviceAt?: number[] } = {}): Day[] {
  return counts.map((n, i) => pastDay(shiftDateKey(D, -(i + 1)), { repeatedQuestions: n }, opts.dayserviceAt?.includes(i) ?? false));
}

test('比較: 14 日未満は基線期間（L2/L3 を出さない）', () => {
  const r = compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 20 }), history([20, 2, 2]), ['痛みなどのお返事']);
  assert.equal(r.baseline, true);
  assert.equal(r.alert, null);
  assert.equal(r.lines[0], '記録を集めている期間です（4 日目）。');
});

test('比較: 中央値＋3 回かつ 1.5 倍が 2 日連続で L2 info。今日だけなら出さない', () => {
  const base = Array(BASELINE_DAYS - 1).fill(2);
  const two = compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 7 }), history([6, ...base]));
  assert.equal(two.alert?.level, 'info');
  assert.match(two.alert!.reason, /ここ 2 日は 1 日 6 回・7 回と、その前の 2 週間（1 日 2 回ほど）より増えています/);
  assert.match(two.lines[0], /多めでした/);
  assert.ok(!/認知症|進ん/.test(two.alert!.reason));

  const one = compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 7 }), history([2, ...base]));
  assert.equal(one.alert, null);
  // 中央値＋3 に届かない（2→4 は 2 倍でも＋2）
  assert.equal(compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 4 }), history([4, ...base])).alert, null);
});

test('比較: 前の在宅日の 2 倍以上＋同じ日の体調のサインで L3 check。サインが無ければ L3 にしない', () => {
  const base = Array(BASELINE_DAYS - 1).fill(2);
  const r = compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 4 }), history([2, ...base]), ['食事の「いらない」']);
  assert.equal(r.alert?.level, 'check');
  assert.match(r.alert!.reason, /体調の確認をお願いします/);
  assert.equal(compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 4 }), history([2, ...base]), []).alert, null);
});

test('比較: デイの日は在宅日どうしの比較に含めない。前の在宅日はデイの日を飛ばす', () => {
  const base = Array(BASELINE_DAYS - 1).fill(2);
  const dayservice = compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 9 }, true), history([8, ...base]));
  assert.equal(dayservice.alert, null);
  assert.match(dayservice.lines[1], /デイサービスの予定があるため/);
  // 昨日がデイの日（回数 0）でも、その前の在宅日（6 回）と 2 日連続で数える
  const skip = compareRepeatedQuestions(pastDay(D, { repeatedQuestions: 7 }), history([0, 6, ...base.slice(1)], { dayserviceAt: [0] }));
  assert.equal(skip.alert?.level, 'info');
});

test('buildAndSendSummary: 比較の L2 を先に 1 件、続けて今日の様子（全文）。day.summary に sections も保存', async () => {
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold(HH));
  await store.putDay(pastDay(D, { repeatedQuestions: 7 }));
  for (const d of history([6, ...Array(BASELINE_DAYS - 1).fill(2)])) await store.putDay(d);
  const { ctx, familyNotify } = createFakeContext({ store });
  const now = jstDate(D, '18:00');
  const s = await buildAndSendSummary(ctx, HH, D, now, { useLlm: false });
  assert.deepEqual(familyNotify.calls.map(c => [c.level, c.origin]), [['info', 'repeat'], ['info', 'summary']]);
  assert.equal(familyNotify.calls[1].evidence, s.text);
  const saved = (await store.getDay(HH, D))!.summary!;
  assert.equal(saved.text, s.text);
  assert.equal(saved.sentAt?.getTime(), now.getTime());
  assert.ok(saved.sections?.comparison.some(l => /お知らせを 1 件お送りしました/.test(l)));
  const ledger = (await store.listLedger(HH, D)).find(e => e.name === 'summary_sent')!;
  assert.equal((ledger.result as { alert: { level: string } }).alert.level, 'info');
  // 同じ日にもう一度作っても L2 は重ねない
  await buildAndSendSummary(ctx, HH, D, jstDate(D, '18:05'), { useLlm: false });
  assert.equal(familyNotify.calls.filter(c => c.origin === 'repeat').length, 1);
});

test('LLM の言い回しの検査: 時刻と「」の言葉が変わったら使わない', () => {
  const orig = '8:40 着替えの声かけに「まだ」とお返事がありました（まだのようでした）。';
  assert.equal(keepsFacts(orig, '8:40 お着替えの声かけには「まだ」とのお返事でした。'), true);
  assert.equal(keepsFacts(orig, '8:45 お着替えの声かけには「まだ」とのお返事でした。'), false);
  assert.equal(keepsFacts(orig, '8:40 お着替えはまだのようでした。'), false);
  assert.equal(keepsFacts(orig, '8:40 「まだ」という発言がありました。'), false);
});
