// 確認項目の状態機械（docs/02 §5）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRecheck, transition } from '../src/state/machine.js';
import { defaultHousehold } from '../src/seed/household.js';
import type { TaskRecord } from '../src/types.js';

const at = new Date('2026-10-01T08:00:00+09:00');
const classified = (status: 'done' | 'not_yet' | 'no_answer' | 'unclear', recheckAllowed: boolean, escalateAllowed?: boolean) =>
  ({ type: 'classified' as const, status, at, turnId: 'tn_1', recheckAllowed, escalateAllowed, evidence: 'はい' });

test('pending → asked（記録が無いときも pending から始まる）', () => {
  const { next, escalate } = transition(undefined, { type: 'asked', promptId: 'pr_1', at });
  assert.equal(next.state, 'asked');
  assert.deepEqual(next.promptIds, ['pr_1']);
  assert.equal(escalate, false);
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
  test(`asked → ${status} で再確認できるなら rechecking（recheckCount+1）`, () => {
    const asked = transition(undefined, { type: 'asked', promptId: 'pr_1', at }).next;
    const { next, escalate } = transition(asked, classified(status, true));
    assert.equal(next.state, 'rechecking');
    assert.equal(next.recheckCount, 1);
    assert.equal(escalate, false);
  });
}

test('rechecking → 再確認の声かけでも rechecking のまま → done', () => {
  const r: TaskRecord = { state: 'rechecking', recheckCount: 1, promptIds: ['pr_1'] };
  const asked = transition(r, { type: 'asked', promptId: 'pr_2', at, isRecheck: true }).next;
  assert.equal(asked.state, 'rechecking');
  assert.deepEqual(asked.promptIds, ['pr_1', 'pr_2']);
  assert.equal(transition(asked, classified('done', false)).next.state, 'done');
});

test('rechecking → 取れない → escalated（escalate: true）。もう一度取れなくても escalate は 1 回だけ', () => {
  const r: TaskRecord = { state: 'rechecking', recheckCount: 1, promptIds: ['pr_1'] };
  const first = transition(r, classified('no_answer', false));
  assert.equal(first.next.state, 'escalated');
  assert.equal(first.escalate, true);
  assert.ok(first.next.escalatedAt);

  const again = transition(first.next, classified('no_answer', false));
  assert.equal(again.next.state, 'escalated');
  assert.equal(again.escalate, false);

  // 同じ日に新しい声かけ（新しい一巡）で、また取れなくても重ねて上げない
  const newRound = transition(first.next, { type: 'asked', promptId: 'pr_3', at }).next;
  assert.equal(newRound.state, 'asked');
  assert.equal(newRound.recheckCount, 0);
  const third = transition(newRound, classified('not_yet', false));
  assert.equal(third.next.state, 'escalated');
  assert.equal(third.escalate, false);
});

test('家族へ上げない項目（escalateAllowed: false）は取れなくても asked のまま、escalate しない', () => {
  const asked = transition(undefined, { type: 'asked', promptId: 'pr_1', at }).next;
  const { next, escalate } = transition(asked, classified('no_answer', false, false));
  assert.equal(next.state, 'asked');
  assert.equal(next.status, 'no_answer');
  assert.equal(escalate, false);
});

test('escalated → done', () => {
  const r: TaskRecord = { state: 'escalated', recheckCount: 1, promptIds: ['pr_1'], escalatedAt: at };
  assert.equal(transition(r, classified('done', false)).next.state, 'done');
});

test('suspend → suspended', () => {
  const r: TaskRecord = { state: 'asked', recheckCount: 0, promptIds: ['pr_1'] };
  const { next, escalate } = transition(r, { type: 'suspend' });
  assert.equal(next.state, 'suspended');
  assert.equal(escalate, false);
});

test('transition は元の記録を書き換えない', () => {
  const r: TaskRecord = { state: 'asked', recheckCount: 0, promptIds: ['pr_1'] };
  transition(r, { type: 'asked', promptId: 'pr_2', at });
  transition(r, classified('not_yet', true));
  assert.deepEqual(r, { state: 'asked', recheckCount: 0, promptIds: ['pr_1'] });
});

test('canRecheck: recheckOnce なら 1 回まで、そうでなければ 2 回まで', () => {
  const once = defaultHousehold('hh_t');
  const twice = { ...once, policy: { ...once.policy, recheckOnce: false } };
  const rec = (n: number): TaskRecord => ({ state: 'asked', recheckCount: n, promptIds: [] });
  assert.equal(canRecheck(once, undefined), true);
  assert.equal(canRecheck(once, rec(0)), true);
  assert.equal(canRecheck(once, rec(1)), false);
  assert.equal(canRecheck(twice, rec(1)), true);
  assert.equal(canRecheck(twice, rec(2)), false);
});
