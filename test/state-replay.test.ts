// 再生モード: 台本を流して、ステップ数と期待値の一致が数えられる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from '../src/store/memory.js';
import { demoHousehold } from '../src/seed/household.js';
import { createFakeContext, KeywordTurnRunner } from '../src/state/fakes.js';
import { RulesTurnRunner } from '../src/agent/rules.js';
import { judgeStep, runScenario } from '../src/state/replay.js';
import type { Scenario } from '../src/types.js';

async function load(name: string): Promise<Scenario> {
  return JSON.parse(await readFile(new URL(`../eval/scenarios/${name}.json`, import.meta.url), 'utf8')) as Scenario;
}

test('dayservice-day.json を流すと 14 ステップ、期待値のある 13 件がすべて一致', async () => {
  const scenario = await load('dayservice-day');
  const store = new MemoryStore();
  const h = demoHousehold();
  await store.putHousehold(h);
  const { ctx, tasks, familyNotify } = createFakeContext({ store, turnRunner: new KeywordTurnRunner() });
  const r = await runScenario(ctx, h.id, scenario, { withSummary: true });

  assert.equal(r.date, '2026-09-29');
  assert.equal(r.steps.length, scenario.turns.length);
  assert.equal(r.passCount + r.failCount, scenario.turns.filter(t => t.expect).length);
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));

  // 08:40 の洗顔と 08:45 の着替えは再確認の言い回し
  assert.equal(r.steps.find(s => s.at === '08:40')!.prompt, 'お顔、洗えましたか？');
  assert.equal(r.steps.find(s => s.at === '08:45')!.prompt, 'そろそろお着替えどうですか？');
  // 08:35 の着替えは、お迎え（9:00）までの残りから再確認を 10 分後に
  assert.equal(r.steps.find(s => s.at === '08:35')!.followUpAt, '08:45');
  // 16:00 の「痛い」は L3（check）。L4（urgent）は転倒などの語だけ（criteria v2 3-2）
  assert.ok(r.steps.find(s => s.at === '16:00')!.notices.some(n => n.startsWith('check')));
  assert.ok(!familyNotify.calls.some(c => c.level === 'urgent'));
  assert.ok(tasks.scheduled.length >= 3);

  const day = (await store.getDay(h.id, '2026-09-29'))!;
  assert.equal(day.isDayservice, true);
  assert.equal(day.tasks.face?.state, 'done');
  assert.equal(day.tasks.medicine?.state, 'done');
  assert.ok(r.summary && r.summary.sentences.length > 0);
});

test('weekday.json: 昼食に 2 回返事が無いと check が 1 回', async () => {
  const scenario = await load('weekday');
  const { ctx, familyNotify } = createFakeContext({ turnRunner: new KeywordTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario);   // 世帯が無ければデモ世帯を入れる
  assert.equal(r.steps.length, 6);
  assert.equal(r.failCount, 0);
  assert.equal(familyNotify.calls.filter(c => c.level === 'check').length, 1);
});

test('judgeStep: notify の指定が無いときは urgent / check が出ていないこと', () => {
  assert.equal(judgeStep({ status: 'done' }, 'done', [{ level: 'info' }]), true);
  assert.equal(judgeStep({ status: 'done' }, 'done', [{ level: 'check' }]), false);
  assert.equal(judgeStep({ status: 'done', notify: 'urgent' }, 'done', []), false);
  assert.equal(judgeStep({ status: 'done', notify: 'urgent' }, 'not_yet', [{ level: 'urgent' }]), false);
});

test('no-answer-escalation.json（規則）: 無反応 2 回目で check、3 回目で urgent と L4 モード', async () => {
  const scenario = await load('no-answer-escalation');
  const { ctx, store, familyNotify } = createFakeContext({ turnRunner: new RulesTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario, { withSummary: true });
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));
  assert.equal(r.passCount, 4);
  assert.deepEqual(familyNotify.calls.map(c => c.level), ['check', 'urgent']);
  assert.equal(r.steps.at(-1)!.say, '');   // 返事が無くて L4 になったときは本人への発話なし
  const day = (await store.getDay('hh_demo', scenario.date))!;
  assert.ok(day.l4);
  assert.match(r.summary!.sentences[1], /2 件、確認をお願いしたい/);
});

test('dress-three-times.json（規則）: 着替え 2 回目で info、3 回目で check、本人には「また後で声をかけますね」', async () => {
  const scenario = await load('dress-three-times');
  const { ctx, familyNotify } = createFakeContext({ turnRunner: new RulesTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario);
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));
  assert.equal(r.passCount, 4);
  assert.deepEqual(familyNotify.calls.filter(c => c.task === 'dress').map(c => c.level), ['info', 'check']);
  assert.equal(r.steps[2].say, 'わかりました。また後で声をかけますね。');
});

test('dayservice-day.json（規則）: 全件一致、16:00 は check と聞き直しの予約', async () => {
  const scenario = await load('dayservice-day');
  const { ctx, store } = createFakeContext({ turnRunner: new RulesTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario, { withSummary: true });
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));
  const follow = (await store.listPrompts('hh_demo', scenario.date)).find(p => p.followup);
  assert.ok(follow);
  assert.equal(follow!.state, 'queued');
  assert.ok(r.summary!.sections!.concerns.some(l => /腰がちょっと痛い/.test(l) && /聞き直す予定/.test(l)));
});

test('bath.json（規則）: お風呂モードの台本が全件一致。洗う無反応 ×2 は check で、L4 にはならない', async () => {
  const scenario = await load('bath');
  const { ctx, store, familyNotify, tasks } = createFakeContext({ turnRunner: new RulesTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario, { withSummary: true });
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));
  assert.equal(r.passCount, scenario.turns.filter(t => t.expect).length);
  // 「上がりましたか」に「はい」（20:05）→ その場で寝室へ（時間切れの自動の戻りのステップは入らない）
  const exit = r.steps.find(s => s.at === '20:05' && s.kind === 'turn')!;
  assert.equal(exit.mode, 'bedroom');
  assert.deepEqual(exit.notices, ['info: お風呂から上がりました']);
  assert.ok(!r.steps.some(s => s.kind === 'mode' && s.modeBy === 'system'));
  assert.deepEqual(familyNotify.calls.map(c => [c.level, c.origin]), [['info', 'bath'], ['info', 'bath'], ['check', 'bath']]);
  assert.ok(!familyNotify.calls.some(c => c.level === 'urgent'));
  assert.equal((await store.getDay('hh_demo', scenario.date))!.l4 ?? null, null);
  assert.equal(tasks.scheduled.filter(s => s.path === '/internal/bath-return').length, 2);
  assert.equal((await store.getHousehold('hh_demo'))!.mode, 'bedroom');
});

test('bath-no-answer.json（規則）: 洗う無反応 ×2 → check、「上がりましたか」無反応 ×2 → check で寝室へ。L4 にはならない', async () => {
  const scenario = await load('bath-no-answer');
  const { ctx, store, familyNotify } = createFakeContext({ turnRunner: new RulesTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario);
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));
  assert.equal(r.passCount, scenario.turns.filter(t => t.expect).length);
  assert.deepEqual(familyNotify.calls.map(c => [c.level, c.reason]), [
    ['check', 'お風呂で声かけに返事がありません。様子を見に行ってください'],
    ['check', 'お風呂から上がったか確認できませんでした。様子を見に行ってください'],
  ]);
  assert.equal((await store.getDay('hh_demo', scenario.date))!.l4 ?? null, null);
  assert.equal((await store.getHousehold('hh_demo'))!.modeChangedBy, 'system');
});
