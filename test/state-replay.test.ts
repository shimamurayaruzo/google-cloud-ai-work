// 再生モード: 台本を流して、ステップ数と期待値の一致が数えられる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from '../src/store/memory.js';
import { demoHousehold } from '../src/seed/household.js';
import { createFakeContext, KeywordTurnRunner } from '../src/state/fakes.js';
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
  // 16:00 の「痛い」は urgent
  assert.ok(r.steps.find(s => s.at === '16:00')!.notices.some(n => n.startsWith('urgent')));
  assert.ok(familyNotify.calls.some(c => c.level === 'urgent'));
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
