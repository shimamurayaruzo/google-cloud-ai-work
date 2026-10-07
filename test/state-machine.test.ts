// 確認項目の状態機械（docs/02 §5、docs/criteria.md v2 3-1・3-3・5 節の段階表）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRecheck, transition, type TransitionResult } from '../src/state/machine.js';
import { defaultHousehold } from '../src/seed/household.js';
import type { Classification, TaskRecord } from '../src/types.js';

const at = new Date('2026-10-01T08:00:00+09:00');
const classified = (status: Classification, recheckAllowed: boolean, escalateAllowed?: boolean, extra: Record<string, unknown> = {}) =>
  ({ type: 'classified' as const, status, at, turnId: 'tn_1', recheckAllowed, escalateAllowed, evidence: 'はい', task: 'dress' as const, ...extra });

/** 初回＋再確認 2 回（maxRechecks 2）で同じ分類を n 回続けたときの各回の結果 */
function run(status: Classification, times: number, opts: { maxRechecks?: number; escalateAllowed?: boolean; oneShot?: boolean } = {}): TransitionResult[] {
  const max = opts.maxRechecks ?? 2;
  let rec = transition(undefined, { type: 'asked', promptId: 'pr_0', at }).next;
  const out: TransitionResult[] = [];
  for (let i = 0; i < times; i++) {
    if (i > 0) rec = transition(rec, { type: 'asked', promptId: `pr_${i}`, at, isRecheck: true }).next;
    const r = transition(rec, classified(status, rec.recheckCount < max && !opts.oneShot, opts.escalateAllowed, {
      oneShot: opts.oneShot, promptedAt: new Date(at.getTime() + i * 15 * 60_000),
    }));
    out.push(r);
    rec = r.next;
  }
  return out;
}

test('pending → asked（記録が無いときも pending から始まる）', () => {
  const { next, notify } = transition(undefined, { type: 'asked', promptId: 'pr_1', at });
  assert.equal(next.state, 'asked');
  assert.deepEqual(next.promptIds, ['pr_1']);
  assert.equal(notify, undefined);
});

test('asked → done', () => {
  const asked = transition(undefined, { type: 'asked', promptId: 'pr_1', at }).next;
  const { next } = transition(asked, classified('done', true));
  assert.equal(next.state, 'done');
  assert.equal(next.status, 'done');
  assert.equal(next.evidence, 'はい');
  assert.equal(next.lastTurnId, 'tn_1');
});

for (const status of ['not_yet', 'no_answer', 'unclear'] as const) {
  test(`asked → ${status}（1 回目）は rechecking、通知なし（recheckCount+1、failCount 1）`, () => {
    const [r1] = run(status, 1);
    assert.equal(r1.next.state, 'rechecking');
    assert.equal(r1.next.recheckCount, 1);
    assert.equal(r1.next.failCount, 1);
    assert.equal(r1.notify, undefined);
  });
}

test('段階表 not_yet ×3: rechecking → rechecking＋L2 info「まだのようです」→ escalated＋L3 check「確認してください」', () => {
  const [r1, r2, r3] = run('not_yet', 3);
  assert.equal(r1.next.state, 'rechecking');
  assert.equal(r1.notify, undefined);
  assert.equal(r2.next.state, 'rechecking');
  assert.equal(r2.next.failCount, 2);
  assert.deepEqual(r2.notify, { level: 'info', reason: '着替えがまだのようです', origin: 'not_done', stage: 'not_yet_info' });
  assert.equal(r3.next.state, 'escalated');
  assert.equal(r3.final, true);
  assert.deepEqual(r3.notify, { level: 'check', reason: '着替えを確認してください', origin: 'not_done', stage: 'not_done_check' });
  assert.ok(r3.next.escalatedAt);
});

test('段階表 unclear ×3 も not_yet と同じ段階', () => {
  const rs = run('unclear', 3);
  assert.deepEqual(rs.map(r => r.notify?.level ?? null), [null, 'info', 'check']);
});

test('段階表 no_answer ×3: rechecking → rechecking＋L3 check「8:00 から 2 回…家の電話」→ escalated＋L4 urgent', () => {
  const [r1, r2, r3] = run('no_answer', 3);
  assert.equal(r1.next.state, 'rechecking');
  assert.equal(r1.notify, undefined);
  assert.equal(r1.next.noAnswerStreak, 1);
  assert.equal(r2.next.state, 'rechecking');
  assert.equal(r2.notify?.level, 'check');
  assert.equal(r2.notify?.origin, 'no_answer');
  assert.equal(r2.notify?.reason, '8:00 から 2 回の声かけに返事がありません。家の電話にかけてみてください。話せたら『確認した』を押してください');
  assert.equal(r3.next.state, 'escalated');
  assert.equal(r3.final, true);
  assert.equal(r3.notify?.level, 'urgent');
  assert.equal(r3.notify?.stage, 'no_answer_urgent');
  assert.equal(r3.notify?.reason, '8:00 から 3 回の声かけに、お返事がありません');
});

test('返事があれば連続無反応は数え直し（no_answer → まだ → no_answer は L3 の無反応にならない）', () => {
  let rec = transition(undefined, { type: 'asked', promptId: 'pr_0', at }).next;
  rec = transition(rec, classified('no_answer', true)).next;
  rec = transition(rec, classified('not_yet', true)).next;
  assert.equal(rec.noAnswerStreak, 0);
  assert.equal(rec.noAnswerSince, undefined);
  const r3 = transition(rec, classified('no_answer', false));
  // 3 回目（最後）なので escalated。連続無反応は 1 回だけなので L4 ではなく L3「確認してください」
  assert.equal(r3.next.state, 'escalated');
  assert.equal(r3.notify?.level, 'check');
  assert.equal(r3.notify?.stage, 'not_done_check');
});

test('escalate: false の項目は取れなくても通知しない（3 回目は asked のまま）', () => {
  const rs = run('no_answer', 3, { escalateAllowed: false });
  assert.deepEqual(rs.map(r => r.next.state), ['rechecking', 'rechecking', 'asked']);
  assert.ok(rs.every(r => r.notify === undefined));
  assert.equal(rs[2].next.status, 'no_answer');
});

test('recheckMinutes: 0（1 回のみ）は再確認せず n=1 で asked のまま、通知なし', () => {
  const [r1] = run('no_answer', 1, { oneShot: true });
  assert.equal(r1.next.state, 'asked');
  assert.equal(r1.next.recheckCount, 0);
  assert.equal(r1.notify, undefined);
  // 次の声かけ（例: 水分の 2 回目）は新しい一巡
  const again = transition(r1.next, { type: 'asked', promptId: 'pr_9', at });
  assert.equal(again.next.failCount, 0);
});

test('recheckOnce の世帯（maxRechecks なし）は 2 回目が最後で L3 check（従来どおり）', () => {
  const rs = run('not_yet', 2, { maxRechecks: 1 });
  assert.deepEqual(rs.map(r => r.next.state), ['rechecking', 'escalated']);
  assert.equal(rs[1].notify?.level, 'check');
  const na = run('no_answer', 2, { maxRechecks: 1 });
  assert.equal(na[1].notify?.stage, 'no_answer_check');
});

test('rechecking → done。escalated の後に重ねて通知しない。新しい一巡でも同じ日は 1 回だけ', () => {
  const r: TaskRecord = { state: 'rechecking', recheckCount: 1, failCount: 1, promptIds: ['pr_1'] };
  const asked = transition(r, { type: 'asked', promptId: 'pr_2', at, isRecheck: true }).next;
  assert.equal(asked.state, 'rechecking');
  assert.deepEqual(asked.promptIds, ['pr_1', 'pr_2']);
  assert.equal(transition(asked, classified('done', false)).next.state, 'done');

  const [, , r3] = run('not_yet', 3);
  const again = transition(r3.next, classified('no_answer', false));
  assert.equal(again.next.state, 'escalated');
  assert.equal(again.notify, undefined);
  const newRound = transition(r3.next, { type: 'asked', promptId: 'pr_3', at }).next;
  assert.equal(newRound.state, 'asked');
  assert.equal(newRound.recheckCount, 0);
  assert.equal(newRound.failCount, 0);
  const last = transition(newRound, classified('not_yet', false));
  assert.equal(last.next.state, 'escalated');
  assert.equal(last.notify, undefined);
});

test('escalated → done', () => {
  const r: TaskRecord = { state: 'escalated', recheckCount: 1, promptIds: ['pr_1'], escalatedAt: at };
  assert.equal(transition(r, classified('done', false)).next.state, 'done');
});

test('suspend → suspended', () => {
  const r: TaskRecord = { state: 'asked', recheckCount: 0, promptIds: ['pr_1'] };
  const { next, notify } = transition(r, { type: 'suspend' });
  assert.equal(next.state, 'suspended');
  assert.equal(notify, undefined);
});

test('transition は元の記録を書き換えない', () => {
  const r: TaskRecord = { state: 'asked', recheckCount: 0, promptIds: ['pr_1'] };
  transition(r, { type: 'asked', promptId: 'pr_2', at });
  transition(r, classified('not_yet', true));
  assert.deepEqual(r, { state: 'asked', recheckCount: 0, promptIds: ['pr_1'] });
});

test('canRecheck: maxRechecks（既定の世帯は 2）が優先。無ければ recheckOnce なら 1 回、そうでなければ 2 回', () => {
  const seeded = defaultHousehold('hh_t');
  const once = { ...seeded, policy: { ...seeded.policy, maxRechecks: undefined } };
  const twice = { ...once, policy: { ...once.policy, recheckOnce: false } };
  const rec = (n: number): TaskRecord => ({ state: 'asked', recheckCount: n, promptIds: [] });
  assert.equal(seeded.policy.maxRechecks, 2);
  assert.equal(canRecheck(seeded, rec(1)), true);
  assert.equal(canRecheck(seeded, rec(2)), false);
  assert.equal(canRecheck(once, undefined), true);
  assert.equal(canRecheck(once, rec(0)), true);
  assert.equal(canRecheck(once, rec(1)), false);
  assert.equal(canRecheck(twice, rec(1)), true);
  assert.equal(canRecheck(twice, rec(2)), false);
});
