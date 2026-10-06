// 今日の様子（決定論のテンプレート側）と「昨日まで」との比較
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { createFakeContext } from '../src/state/fakes.js';
import { buildAndSendSummary, buildSummary, compareWithRecent } from '../src/state/summary.js';
import { jstDate } from '../src/time.js';
import type { Day, DaySignals } from '../src/types.js';

const HH = 'hh_t';
const D = '2026-10-01';

function signals(p: Partial<DaySignals> = {}): DaySignals {
  return { unclearCount: 0, noAnswerCount: 0, repeatedQuestions: 0, urgentCount: 0, ...p };
}

function pastDay(date: string, s: Partial<DaySignals> = {}): Day {
  return { hh: HH, date, isDayservice: false, plan: [], planApproved: null, tasks: {}, summary: null, signals: signals(s) };
}

async function seed() {
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold(HH));
  const today: Day = {
    hh: HH, date: D, isDayservice: false, plan: [], planApproved: null, summary: null,
    signals: signals({ noAnswerCount: 3, urgentCount: 1 }),
    tasks: {
      dress: { state: 'done', status: 'done', at: jstDate(D, '08:45'), evidence: '着替えたよ', recheckCount: 1, promptIds: [], lastTurnId: 'tn_dress' },
      lunch: { state: 'escalated', status: 'no_answer', at: jstDate(D, '12:30'), recheckCount: 1, promptIds: [], lastTurnId: 'tn_lunch', escalatedAt: jstDate(D, '12:30') },
      water: { state: 'asked', status: 'no_answer', at: jstDate(D, '15:31'), recheckCount: 0, promptIds: [], lastTurnId: 'tn_water' },
      teeth: { state: 'asked', status: 'unclear', at: jstDate(D, '08:16'), recheckCount: 1, promptIds: [], lastTurnId: 'tn_teeth' },
      medicine: { state: 'pending', recheckCount: 0, promptIds: [] },
    },
  };
  await store.putDay(today);
  await store.putNotice({
    id: 'nt_1', hh: HH, date: D, level: 'urgent', reason: '痛みの訴え', evidence: '「腰がちょっと痛い」', turnId: 'tn_pain',
    steps: [], state: 'open', createdAt: jstDate(D, '11:32'),
  });
  for (const [dt, n] of [['2026-09-30', 0], ['2026-09-29', 1], ['2026-09-28', 0]] as const) {
    await store.putDay(pastDay(dt, { noAnswerCount: n }));
  }
  return store;
}

test('useLlm:false で決定論の要約。文ごとの引用と changeNote', async () => {
  const store = await seed();
  const s = await buildSummary({ store }, HH, D, { useLlm: false });

  assert.deepEqual(s.sentences.slice(0, 5), [
    '08:16 の歯磨きは、本人の返事か分からなかったため判定していません。',
    '08:45 に着替えを確認しました（「着替えたよ」）。',
    '11:32 に「腰がちょっと痛い」という訴えがあり、家族へお知らせしました。',
    '12:30 の昼食は、もう一度声をかけても確認できず、家族へお知らせしました。',
    '15:31 の水分の声かけには、返事がありませんでした。',
  ]);
  assert.equal(s.sentences.length, 6);   // pending の服薬は載せない。最後は changeNote
  assert.deepEqual(s.citations, [
    { sentenceIndex: 0, turnId: 'tn_teeth' },
    { sentenceIndex: 1, turnId: 'tn_dress' },
    { sentenceIndex: 2, turnId: 'tn_pain' },
    { sentenceIndex: 3, turnId: 'tn_lunch' },
    { sentenceIndex: 4, turnId: 'tn_water' },
  ]);
  assert.equal(s.changeNote, '最近 3 日と比べて、返事が取れない声かけが増えています。確認をお願いします。最近 3 日と比べて、質問の繰り返しは増えていません。');
  assert.equal(s.sentences[5], s.changeNote);
  assert.equal(s.text, s.sentences.join(''));
});

test('buildAndSendSummary: day.summary に保存し、家族へ info、台帳 summary_sent', async () => {
  const store = await seed();
  const { ctx, familyNotify } = createFakeContext({ store });
  const now = jstDate(D, '18:00');
  const s = await buildAndSendSummary(ctx, HH, D, now, { useLlm: false });
  assert.equal(s.sentAt?.getTime(), now.getTime());
  assert.equal((await store.getDay(HH, D))!.summary?.text, s.text);
  assert.equal(familyNotify.calls.length, 1);
  assert.equal(familyNotify.calls[0].reason, '今日の様子');
  assert.equal(familyNotify.calls[0].level, 'info');
  assert.ok((await store.listLedger(HH, D)).some(e => e.name === 'summary_sent'));
});

test('compareWithRecent: 断定しない言い回し', () => {
  assert.match(compareWithRecent(signals(), []), /比べられる過去の記録がまだない/);
  assert.equal(
    compareWithRecent(signals({ repeatedQuestions: 1 }), [pastDay('a', { repeatedQuestions: 1 }), pastDay('b')]),
    '最近 2 日と比べて、質問の繰り返しは増えていません。',
  );
  assert.match(
    compareWithRecent(signals({ repeatedQuestions: 3 }), [pastDay('a'), pastDay('b'), pastDay('c', { repeatedQuestions: 1 })]),
    /同じ質問を短い間に繰り返すことが増えているようです/,
  );
});

test('記録が何も無い日でも要約は作れる', async () => {
  const store = new MemoryStore();
  await store.putDay({ ...pastDay(D), tasks: {} });
  const s = await buildSummary({ store }, HH, D, { useLlm: false });
  assert.equal(s.sentences[0], '今日はまだ声かけの記録がありません。');
  assert.deepEqual(s.citations, []);
});
