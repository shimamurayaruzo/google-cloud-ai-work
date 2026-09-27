// 声かけ計画: 曜日の選び方、既定の文言、再確認までの分
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPromptText, findPlanItem, recheckDelayMinutes, resolvePlan } from '../src/state/plan.js';
import { defaultHousehold, demoHousehold } from '../src/seed/household.js';
import { jstDate } from '../src/time.js';

const h = defaultHousehold('hh_t');

test('火曜（2026-09-29）と金曜はデイ、木曜（2026-10-01）と日曜は default', () => {
  const tue = resolvePlan(h, '2026-09-29');
  assert.equal(tue.isDayservice, true);
  assert.ok(tue.items.some(i => i.task === 'pickup'));
  assert.equal(resolvePlan(h, '2026-10-02').isDayservice, true);

  const thu = resolvePlan(h, '2026-10-01');
  assert.equal(thu.isDayservice, false);
  assert.ok(thu.items.some(i => i.task === 'lunch'));
  assert.ok(!thu.items.some(i => i.task === 'pickup'));
  assert.equal(resolvePlan(h, '2026-10-04').isDayservice, false);
});

test('isDayservice の上書き（再生モード）と時刻順', () => {
  const r = resolvePlan(h, '2026-10-01', true);
  assert.equal(r.isDayservice, true);
  const times = r.items.map(i => i.time);
  assert.deepEqual(times, [...times].sort());
});

test('雛形は docs/03 の値（朝の順番、薬の文言、デモ世帯）', () => {
  const d = h.plan.weekday.dayservice;
  assert.deepEqual(d.slice(0, 4).map(i => i.task), ['greeting', 'diaper', 'teeth', 'face']);
  assert.equal(d.find(i => i.task === 'medicine')!.text, 'ご飯のあとのお薬を飲みましょう。黒い机の上に 2 錠あります');
  assert.deepEqual(h.plan.dayserviceDays, ['Tue', 'Fri']);
  assert.equal(h.members[0].line, undefined);
  assert.equal(h.members[0].email, undefined);
  assert.equal(demoHousehold().id, 'hh_demo');
  assert.equal(demoHousehold().name, 'テスト世帯');
});

test('findPlanItem: 同じ項目が 2 回ある日（水分 10:30 と 15:30）は時刻で選ぶ', () => {
  const items = resolvePlan(h, '2026-10-01').items;
  assert.equal(findPlanItem(items, 'water', jstDate('2026-10-01', '15:31'))!.time, '15:30');
  assert.equal(findPlanItem(items, 'water', jstDate('2026-10-01', '10:40'))!.time, '10:30');
  assert.equal(findPlanItem(items, 'pickup'), undefined);
});

test('defaultPromptText: 初回と再確認で言い回しを変える', () => {
  assert.equal(defaultPromptText('dress', h, true), 'そろそろお着替えどうですか？');
  assert.equal(defaultPromptText('face', h, true), 'お顔、洗えましたか？');
  assert.equal(defaultPromptText('medicine', h, true), 'お薬、飲めましたか？');
  assert.equal(defaultPromptText('medicine', h, false), 'ご飯のあとのお薬を飲みましょう。黒い机の上に 2 錠あります');
  assert.equal(defaultPromptText('diaper', h, false), 'まず、おむつを新しいのに替えましょうか');
});

test('recheckDelayMinutes: 計画の分 → お迎え前は残りの半分（最小 5 分）', () => {
  const tue = '2026-09-29';
  const dress = findPlanItem(resolvePlan(h, tue).items, 'dress')!;   // recheckMinutes 10
  assert.equal(recheckDelayMinutes(h, dress, 'dress', jstDate(tue, '08:35')), 10);  // 残り 25 分 → 半分 12 ≥ 10
  assert.equal(recheckDelayMinutes(h, dress, 'dress', jstDate(tue, '08:45')), 7);   // 残り 15 分 → 7
  assert.equal(recheckDelayMinutes(h, dress, 'dress', jstDate(tue, '08:55')), 5);   // 残り 5 分 → 2 → 最小 5
  assert.equal(recheckDelayMinutes(h, dress, 'dress', jstDate(tue, '09:10')), 10);  // お迎え後は逆算しない
});

test('recheckDelayMinutes: デイ以外の日は逆算しない。計画が無い・0 なら policy', () => {
  const thu = '2026-10-01';
  const dress = findPlanItem(resolvePlan(h, thu).items, 'dress')!;   // 15
  assert.equal(recheckDelayMinutes(h, dress, 'dress', jstDate(thu, '08:50')), 15);
  assert.equal(recheckDelayMinutes(h, undefined, 'dress', jstDate(thu, '08:50')), 15);
  const water = findPlanItem(resolvePlan(h, thu).items, 'water')!;  // 0（1回のみ）
  assert.equal(recheckDelayMinutes(h, water, 'water', jstDate(thu, '10:30')), 15);
});
