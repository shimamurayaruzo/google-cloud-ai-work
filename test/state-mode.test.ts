// 起動モード（寝室／お風呂）と、寝室モードの「ときたまの声かけ」（docs/02 §11.2・§11.3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { createFakeContext } from '../src/state/fakes.js';
import { ensureDay, expireUnansweredPrompts, nextPrompt, planDay } from '../src/state/day.js';
import { processReply } from '../src/state/turn.js';
import {
  BATH_DONE_SAY, BATH_END_SAY, BATH_EXIT_DONE_REASON, BATH_EXIT_NO_ANSWER_REASON, BATH_EXIT_NOT_YET_REASON, BATH_EXIT_TEXT,
  BATH_NO_ANSWER_REASON, BATH_START_SAY, BATH_TEETH_TEXT, BATH_WASH_RECHECK_TEXT, BATH_WASH_TEXT,
  IDLE_WATER_TEXT, exitReplyStatus, handleBathReturn, modeOf, switchMode,
} from '../src/state/mode.js';
import { buildSummary } from '../src/state/summary.js';
import { jstDate } from '../src/time.js';
import { L4_SAY, RulesTurnRunner } from '../src/agent/rules.js';

const HH = 'hh_m';
const THU = '2026-10-01';   // デイ以外の日
const TUE = '2026-09-29';   // デイの日

async function setup(date = THU) {
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold(HH));
  const fake = createFakeContext({ store, turnRunner: new RulesTurnRunner(), clock: () => jstDate(date, '08:00') });
  await ensureDay(fake.ctx, HH, date);
  return fake;
}
type Fake = Awaited<ReturnType<typeof setup>>;
const at = (t: string, date = THU) => jstDate(date, t);

/** お風呂に切り替え、「体を洗いましょうか」を話したところまで */
async function bathUntilWash(fake: Fake) {
  await switchMode(fake.ctx, HH, 'bath', 'family', at('19:30'));
  const start = await nextPrompt(fake.ctx, HH, at('19:30'));
  assert.equal(start!.text, BATH_START_SAY);
  const wash = await nextPrompt(fake.ctx, HH, at('19:40'));
  assert.equal(wash!.text, BATH_WASH_TEXT);
  return wash!;
}

/** 洗う「はい」（19:41）→ 歯磨き（19:56）→「お風呂から上がりましたか？」（20:06）を話したところまで */
async function bathUntilExit(fake: Fake) {
  const wash = await bathUntilWash(fake);
  await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: 'はい', source: 'test', now: at('19:41') });
  const teeth = await nextPrompt(fake.ctx, HH, at('19:56'));
  assert.equal(teeth!.bathStep, 'teeth');
  await processReply(fake.ctx, { hh: HH, promptId: teeth!.id, replyText: 'みがいたよ', source: 'test', now: at('19:57') });
  assert.equal(await nextPrompt(fake.ctx, HH, at('20:05')), null);
  const exit = await nextPrompt(fake.ctx, HH, at('20:06'));
  assert.equal(exit!.bathStep, 'exit');
  assert.equal(exit!.task, 'bath');
  assert.equal(exit!.text, BATH_EXIT_TEXT);
  assert.equal(exit!.isRecheck, false);
  assert.equal(exit!.expectsReply ?? true, true);
  assert.equal((await fake.store.getHousehold(HH))!.bath!.exitAskedAt!.getTime(), at('20:06').getTime());
  return exit!;
}

// ---------------------------------------------------------------------------
// お風呂モード
// ---------------------------------------------------------------------------

test('お風呂へ切替: 最初の一言（返事を求めない）と 10 分後の「体を洗いましょうか」を積む。寝室の声かけは配信しない（queued のまま）', async () => {
  const fake = await setup();
  await planDay(fake.ctx, HH, THU, at('06:00'));
  const r = await switchMode(fake.ctx, HH, 'bath', 'family', at('19:30'));
  assert.equal(r.changed, true);
  assert.equal(r.say, BATH_START_SAY);
  assert.equal(modeOf(r.household), 'bath');
  assert.equal(r.household.modeChangedBy, 'family');
  assert.equal(r.household.bath!.startedAt.getTime(), at('19:30').getTime());

  const bathPrompts = (await fake.store.listPrompts(HH, THU)).filter(p => p.bathStep);
  assert.deepEqual(bathPrompts.map(p => [p.bathStep, p.task, p.scheduledAt.getTime(), p.expectsReply ?? true]), [
    ['start', 'bath', at('19:30').getTime(), false],
    ['wash', 'bath', at('19:40').getTime(), true],
  ]);

  const start = await nextPrompt(fake.ctx, HH, at('19:31'));
  assert.equal(start!.bathStep, 'start');
  assert.equal(start!.expectsReply, false);
  // 19:00 の夕食（期限が来ている）は出さない
  assert.equal(await nextPrompt(fake.ctx, HH, at('19:35')), null);
  const wash = await nextPrompt(fake.ctx, HH, at('19:41'));
  assert.equal(wash!.bathStep, 'wash');
  const prompts = await fake.store.listPrompts(HH, THU);
  assert.equal(prompts.find(p => p.task === 'dinner')!.state, 'queued');
  assert.equal(prompts.find(p => p.task === 'medicine')!.state, 'queued');
  // お風呂の声かけは状態機械を動かさない（夕食・服薬は pending のまま）
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.tasks.dinner?.state, 'pending');
  assert.equal((await fake.store.getHousehold(HH))!.bath!.washAskedAt!.getTime(), at('19:41').getTime());

  const e = (await fake.store.listLedger(HH, THU)).find(x => x.name === 'mode_changed')!;
  assert.equal(e.actor, 'member:family');
  assert.deepEqual({ from: (e.args as any).from, to: (e.args as any).to }, { from: 'bedroom', to: 'bath' });

  // 同じモードへの切替は何もしない
  const again = await switchMode(fake.ctx, HH, 'bath', 'device', at('19:42'));
  assert.equal(again.changed, false);
  assert.equal((await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').length, 1);
});

test('洗う「はい」→ 家族へ info「体を洗い始めました」、本人には「ゆっくりどうぞ」。15 分後に歯磨き、その 10 分後に「上がりましたか」、さらに 30 分後の時間切れの戻りを予約', async () => {
  const fake = await setup();
  const wash = await bathUntilWash(fake);
  const r = await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: 'はい', source: 'test', now: at('19:41') });
  assert.equal(r.turn.classified.status, 'done');
  assert.equal(r.say, BATH_DONE_SAY);
  assert.ok(!/家族/.test(r.say));
  assert.deepEqual(r.notices.map(n => [n.level, n.origin, n.reason]), [['info', 'bath', '体を洗い始めました']]);

  const h = (await fake.store.getHousehold(HH))!;
  assert.equal(h.bath!.washDoneAt!.getTime(), at('19:41').getTime());
  assert.equal(h.bath!.returnAt!.getTime(), at('20:36').getTime());
  const teeth = (await fake.store.listPrompts(HH, THU)).find(p => p.bathStep === 'teeth')!;
  assert.equal(teeth.task, 'teeth');
  assert.equal(teeth.text, BATH_TEETH_TEXT);
  assert.equal(teeth.scheduledAt.getTime(), at('19:56').getTime());
  const exit = (await fake.store.listPrompts(HH, THU)).find(p => p.bathStep === 'exit')!;
  assert.equal(exit.task, 'bath');
  assert.equal(exit.text, BATH_EXIT_TEXT);
  assert.equal(exit.scheduledAt.getTime(), at('20:06').getTime());
  const ret = fake.tasks.scheduled.find(s => s.path === '/internal/bath-return')!;
  assert.equal(ret.runAt.getTime(), at('20:36').getTime());
  assert.deepEqual(ret.body, { hh: HH, startedAt: at('19:30').toISOString(), reason: 'timeout' });
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.bath?.state, 'done');

  // 歯磨きは記録のみ。通知しない
  const tp = await nextPrompt(fake.ctx, HH, at('19:56'));
  assert.equal(tp!.id, teeth.id);
  const tr = await processReply(fake.ctx, { hh: HH, promptId: tp!.id, replyText: 'まだ', source: 'test', now: at('19:57') });
  assert.equal(tr.notices.length, 0);
  assert.equal(tr.followUp, null);
  assert.equal(fake.familyNotify.calls.length, 1);
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.teeth?.status, 'not_yet');
});

test('洗う声かけに返事なし ×2 → 2 分後に再確認、それも無ければ check「様子を見に行ってください」。L4 にはしない', async () => {
  const fake = await setup();
  const wash = await bathUntilWash(fake);
  const r1 = await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: null, source: 'test', now: at('19:41') });
  assert.equal(r1.turn.classified.status, 'no_answer');
  assert.equal(r1.notices.length, 0);
  assert.equal(r1.say, '');
  assert.equal(r1.followUp!.at.getTime(), at('19:42').getTime());   // 声かけ（19:40）から 2 分後

  const re = await nextPrompt(fake.ctx, HH, at('19:43'));
  assert.equal(re!.bathStep, 'wash_recheck');
  assert.equal(re!.text, BATH_WASH_RECHECK_TEXT);
  const r2 = await processReply(fake.ctx, { hh: HH, promptId: re!.id, replyText: null, source: 'test', now: at('19:44') });
  assert.deepEqual(r2.notices.map(n => [n.level, n.origin, n.reason]), [['check', 'bath', BATH_NO_ANSWER_REASON]]);
  assert.ok(!fake.familyNotify.calls.some(c => c.level === 'urgent'));
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.l4 ?? null, null);
  assert.equal(day.tasks.bath?.state, 'escalated');
  const h = (await fake.store.getHousehold(HH))!;
  assert.ok(h.bath!.noAnswerNotifiedAt);
  // 歯磨きは積まず、10 分後に「上がりましたか」（時間切れの戻りはその 30 分後）
  assert.ok(!(await fake.store.listPrompts(HH, THU)).some(p => p.bathStep === 'teeth'));
  const exit = (await fake.store.listPrompts(HH, THU)).find(p => p.bathStep === 'exit')!;
  assert.equal(exit.scheduledAt.getTime(), at('19:54').getTime());
  assert.equal(h.bath!.returnAt!.getTime(), at('20:24').getTime());
});

test('「まだ」→ 2 分後に 1 回だけ再確認。再確認も「まだ」なら記録して歯磨きと戻りへ進む（通知しない）', async () => {
  const fake = await setup();
  const wash = await bathUntilWash(fake);
  const r1 = await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: 'まだ', source: 'test', now: at('19:41') });
  assert.equal(r1.followUp!.at.getTime(), at('19:42').getTime());
  const re = await nextPrompt(fake.ctx, HH, at('19:43'));
  const r2 = await processReply(fake.ctx, { hh: HH, promptId: re!.id, replyText: 'まだよ', source: 'test', now: at('19:44') });
  assert.equal(r2.notices.length, 0);
  assert.equal(r2.followUp, null);
  assert.equal(fake.familyNotify.calls.length, 0);
  assert.ok((await fake.store.listPrompts(HH, THU)).some(p => p.bathStep === 'teeth'));
});

test('話したまま返事が届かないお風呂の声かけは、3 分（notifyAfter − recheck）で返事なしとして締める', async () => {
  const fake = await setup();
  await bathUntilWash(fake);
  assert.equal(await expireUnansweredPrompts(fake.ctx, HH, at('19:42'), 10), 0);
  assert.equal(await expireUnansweredPrompts(fake.ctx, HH, at('19:43'), 10), 1);
  const re = await nextPrompt(fake.ctx, HH, at('19:43'));   // 締めが遅れたので再確認は今すぐ
  assert.equal(re!.bathStep, 'wash_recheck');
  assert.equal(await expireUnansweredPrompts(fake.ctx, HH, at('19:46'), 10), 1);
  assert.deepEqual(fake.familyNotify.calls.map(c => [c.level, c.origin]), [['check', 'bath']]);
  // 返事を求めない最初の一言は締めても無反応にしない
  assert.equal((await fake.store.getDay(HH, THU))!.signals.noAnswerCount, 2);
});

test('お風呂の間の L4 の語は寝室と同じ（urgent ＋ L4 モード）', async () => {
  const fake = await setup();
  const wash = await bathUntilWash(fake);
  const r = await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: '転んで立てない', source: 'test', now: at('19:41') });
  assert.equal(r.say, L4_SAY);
  assert.deepEqual(r.notices.map(n => n.level), ['urgent']);
  assert.ok((await fake.store.getDay(HH, THU))!.l4);
  // L4 の間は安心文だけ（お風呂の声かけより優先）
  const a = await nextPrompt(fake.ctx, HH, at('19:44'));
  assert.equal(a!.isReassurance, true);
});

test('寝室へ戻す: お風呂の残りと 30 分以上前に期限が来た寝室の声かけは expired。「ゆっくり休んでくださいね」を先に話す', async () => {
  const fake = await setup();
  await planDay(fake.ctx, HH, THU, at('06:00'));
  await switchMode(fake.ctx, HH, 'bath', 'family', at('19:30'));
  const r = await switchMode(fake.ctx, HH, 'bedroom', 'family', at('20:05'));
  assert.equal(r.say, BATH_END_SAY);
  assert.equal(r.household.bath, null);
  const prompts = await fake.store.listPrompts(HH, THU);
  assert.equal(prompts.find(p => p.task === 'dinner')!.state, 'expired');    // 19:00（30 分以上前）
  assert.equal(prompts.find(p => p.task === 'medicine')!.state, 'queued');   // 19:40（25 分前）
  assert.equal(prompts.find(p => p.bathStep === 'wash')!.state, 'expired');
  const first = await nextPrompt(fake.ctx, HH, at('20:06'));
  assert.equal(first!.text, BATH_END_SAY);
  const second = await nextPrompt(fake.ctx, HH, at('20:06'));
  assert.equal(second!.task, 'medicine');
});

test('自動の戻り（/internal/bath-return）: 予約したときのお風呂なら by system で寝室へ。別のお風呂の古い予約は何もしない', async () => {
  const fake = await setup();
  await switchMode(fake.ctx, HH, 'bath', 'family', at('19:30'));
  const other = await handleBathReturn(fake.ctx, HH, at('20:00'), at('18:00').toISOString());
  assert.equal(other.switched, false);
  assert.equal(other.reason, 'other_session');
  const r = await handleBathReturn(fake.ctx, HH, at('20:00'), at('19:30').toISOString());
  assert.equal(r.switched, true);
  assert.equal(modeOf(r.household), 'bedroom');
  assert.equal(r.household.modeChangedBy, 'system');
  const e = (await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').at(-1)!;
  assert.equal(e.actor, 'system');
  // 寝室のときは何もしない
  assert.equal((await handleBathReturn(fake.ctx, HH, at('20:01'))).reason, 'not_bath');
});

test('戻りの予約が届かなくても、nextPrompt が戻りの時刻を過ぎていれば寝室へ戻す（時間切れは知らせない）', async () => {
  const fake = await setup();
  const wash = await bathUntilWash(fake);
  await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: 'はい', source: 'test', now: at('19:41') });
  await nextPrompt(fake.ctx, HH, at('19:56'));   // 歯磨き
  // 端末が「上がりましたか」（20:06）を取りに来ないまま、時間切れ（20:36）＋ 2 分を過ぎた
  const p = await nextPrompt(fake.ctx, HH, at('20:39'));
  assert.equal(modeOf((await fake.store.getHousehold(HH))!), 'bedroom');
  assert.equal(p!.text, BATH_END_SAY);
  assert.equal((await fake.store.listPrompts(HH, THU)).find(x => x.bathStep === 'exit')!.state, 'expired');
  assert.deepEqual(fake.familyNotify.calls.map(c => c.reason), ['体を洗い始めました']);
  const e = (await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').at(-1)!;
  assert.equal((e.args as any).reason, 'timeout');
});

// ---------------------------------------------------------------------------
// お風呂から上がったか（2026-10-07 島村さん「お風呂を出るときに LINE で知らせてほしい」）
// ---------------------------------------------------------------------------

test('「上がりましたか」への返事の分類: はい・上がった・出たよ は done、まだ・入ってる・洗ってる は not_yet', () => {
  assert.equal(exitReplyStatus('はい', 'done'), 'done');
  assert.equal(exitReplyStatus('上がったよ', 'unclear'), 'done');
  assert.equal(exitReplyStatus('出たよ', 'unclear'), 'done');
  assert.equal(exitReplyStatus('もう出ました', 'unclear'), 'done');
  assert.equal(exitReplyStatus('まだ', 'not_yet'), 'not_yet');
  assert.equal(exitReplyStatus('まだ上がってない', 'not_yet'), 'not_yet');
  assert.equal(exitReplyStatus('入ってる', 'unclear'), 'not_yet');
  assert.equal(exitReplyStatus('洗ってる', 'done'), 'not_yet');
  assert.equal(exitReplyStatus(null, 'no_answer'), 'no_answer');
  assert.equal(exitReplyStatus('（テレビ）出たよ', 'unclear'), 'unclear');
});

test('上がった「はい」→ 家族へ info「お風呂から上がりました」（時刻と抜粋）、本人には「ゆっくり休んでくださいね」、その場で寝室へ（by system）', async () => {
  const fake = await setup();
  const exit = await bathUntilExit(fake);
  const r = await processReply(fake.ctx, { hh: HH, promptId: exit.id, replyText: '上がったよ', source: 'test', now: at('20:07') });
  assert.equal(r.turn.classified.status, 'done');
  assert.equal(r.say, BATH_END_SAY);
  assert.ok(!/家族/.test(r.say));
  assert.equal(r.followUp, null);
  assert.deepEqual(r.notices.map(n => [n.level, n.origin, n.reason]), [['info', 'bath', BATH_EXIT_DONE_REASON]]);
  const call = fake.familyNotify.calls.at(-1)!;
  assert.match(call.evidence, /20:07/);
  assert.match(call.evidence, /上がったよ/);

  const h = (await fake.store.getHousehold(HH))!;
  assert.equal(modeOf(h), 'bedroom');
  assert.equal(h.modeChangedBy, 'system');
  assert.equal(h.bath, null);
  const e = (await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').at(-1)!;
  assert.equal(e.actor, 'system');
  assert.equal((e.args as any).reason, 'exit_done');
  // 「ゆっくり休んでくださいね」は返事への一言で言ったので、終わりの一言は積まない（二重に話さない）
  assert.ok(!(await fake.store.listPrompts(HH, THU)).some(p => p.bathStep === 'end'));
  // 時間切れの予約（20:36）が後から届いても何もしない
  assert.equal((await handleBathReturn(fake.ctx, HH, at('20:36'), at('19:30').toISOString())).reason, 'not_bath');
  assert.deepEqual(fake.familyNotify.calls.map(c => c.reason), ['体を洗い始めました', BATH_EXIT_DONE_REASON]);
});

test('上がった「まだ」×2 → 5 分後にもう一度だけ。それも「まだ」なら 10 分後に寝室へ戻し、そのとき info「お風呂モードを終えました（まだ入っているとのことでした）」', async () => {
  const fake = await setup();
  const exit = await bathUntilExit(fake);
  const r1 = await processReply(fake.ctx, { hh: HH, promptId: exit.id, replyText: 'まだ', source: 'test', now: at('20:07') });
  assert.equal(r1.turn.classified.status, 'not_yet');
  assert.equal(r1.notices.length, 0);
  assert.equal(r1.followUp!.at.getTime(), at('20:12').getTime());
  assert.equal(await nextPrompt(fake.ctx, HH, at('20:11')), null);
  const re = await nextPrompt(fake.ctx, HH, at('20:12'));
  assert.equal(re!.bathStep, 'exit');
  assert.equal(re!.isRecheck, true);
  assert.equal(re!.text, BATH_EXIT_TEXT);

  const r2 = await processReply(fake.ctx, { hh: HH, promptId: re!.id, replyText: 'まだよ', source: 'test', now: at('20:13') });
  assert.equal(r2.turn.classified.status, 'not_yet');
  assert.equal(r2.notices.length, 0);
  assert.equal(r2.followUp, null);
  const h = (await fake.store.getHousehold(HH))!;
  assert.equal(modeOf(h), 'bath');
  assert.equal(h.bath!.returnAt!.getTime(), at('20:23').getTime());
  assert.equal(h.bath!.returnReason, 'exit_not_yet');
  const ret = fake.tasks.scheduled.filter(s => s.path === '/internal/bath-return').at(-1)!;
  assert.equal(ret.runAt.getTime(), at('20:23').getTime());
  assert.deepEqual(ret.body, { hh: HH, startedAt: at('19:30').toISOString(), reason: 'exit_not_yet' });

  // 早く届いた予約は何もしない
  assert.equal((await handleBathReturn(fake.ctx, HH, at('20:15'), at('19:30').toISOString())).reason, 'not_due');
  // 20:23 の戻り（本番の body には reason があるが、無くても bath.returnReason で同じに動く）
  const back = await handleBathReturn(fake.ctx, HH, at('20:23'), at('19:30').toISOString());
  assert.equal(back.switched, true);
  assert.equal(modeOf(back.household), 'bedroom');
  assert.equal(back.household.modeChangedBy, 'system');
  assert.deepEqual([back.notice!.level, back.notice!.origin, back.notice!.reason], ['info', 'bath', BATH_EXIT_NOT_YET_REASON]);
  const call = fake.familyNotify.calls.at(-1)!;
  assert.match(call.evidence, /20:07「まだ」/);
  assert.match(call.evidence, /20:13「まだよ」/);
  assert.ok(!fake.familyNotify.calls.some(c => c.level !== 'info'));
  const e = (await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').at(-1)!;
  assert.deepEqual([(e.args as any).reason, (e.args as any).notice], ['exit_not_yet', 'info']);
  // 寝室に戻ったら「ゆっくり休んでくださいね」
  assert.equal((await nextPrompt(fake.ctx, HH, at('20:23')))!.text, BATH_END_SAY);
});

test('上がったか 返事なし ×2 → 2 分後に再確認、それも無ければ check「様子を見に行ってください」で寝室へ戻す。L4 にはしない', async () => {
  const fake = await setup();
  const exit = await bathUntilExit(fake);
  const r1 = await processReply(fake.ctx, { hh: HH, promptId: exit.id, replyText: null, source: 'test', now: at('20:07') });
  assert.equal(r1.turn.classified.status, 'no_answer');
  assert.equal(r1.notices.length, 0);
  assert.equal(r1.say, '');
  assert.equal(r1.followUp!.at.getTime(), at('20:08').getTime());   // 声かけ（20:06）から 2 分後
  const re = await nextPrompt(fake.ctx, HH, at('20:08'));
  assert.equal(re!.bathStep, 'exit');
  assert.equal(re!.isRecheck, true);

  const r2 = await processReply(fake.ctx, { hh: HH, promptId: re!.id, replyText: null, source: 'test', now: at('20:09') });
  assert.deepEqual(r2.notices.map(n => [n.level, n.origin, n.reason]), [['check', 'bath', BATH_EXIT_NO_ANSWER_REASON]]);
  assert.match(fake.familyNotify.calls.at(-1)!.evidence, /20:06 から 2 回/);
  assert.ok(!fake.familyNotify.calls.some(c => c.level === 'urgent'));
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.l4 ?? null, null);
  assert.equal(day.tasks.bath?.state, 'escalated');
  const h = (await fake.store.getHousehold(HH))!;
  assert.equal(modeOf(h), 'bedroom');
  assert.equal(h.modeChangedBy, 'system');
  const e = (await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').at(-1)!;
  assert.equal((e.args as any).reason, 'exit_no_answer');
  // 返事が無いので一言は言えていない → 寝室に戻ったら「ゆっくり休んでくださいね」
  assert.equal((await nextPrompt(fake.ctx, HH, at('20:10')))!.text, BATH_END_SAY);
  assert.deepEqual(fake.familyNotify.calls.map(c => c.level), ['info', 'check']);
});

test('上がったか: 端末が返事なしを送れなくても /internal/health が 3 分で締め、再確認にも返事が無ければ check', async () => {
  const fake = await setup();
  await bathUntilExit(fake);
  assert.equal(await expireUnansweredPrompts(fake.ctx, HH, at('20:09'), 10), 1);
  const re = await nextPrompt(fake.ctx, HH, at('20:09'));
  assert.equal(re!.isRecheck, true);
  assert.equal(await expireUnansweredPrompts(fake.ctx, HH, at('20:12'), 10), 1);
  assert.deepEqual(fake.familyNotify.calls.map(c => [c.level, c.reason]), [['info', '体を洗い始めました'], ['check', BATH_EXIT_NO_ANSWER_REASON]]);
  assert.equal(modeOf((await fake.store.getHousehold(HH))!), 'bedroom');
});

test('家族が途中で手動で寝室へ戻したときは「お風呂モードを終えました」を送らない（台帳 mode_changed には reason: manual で残す）', async () => {
  const fake = await setup();
  const exit = await bathUntilExit(fake);
  await processReply(fake.ctx, { hh: HH, promptId: exit.id, replyText: 'まだ', source: 'test', now: at('20:07') });
  const re = await nextPrompt(fake.ctx, HH, at('20:12'));
  await processReply(fake.ctx, { hh: HH, promptId: re!.id, replyText: 'まだよ', source: 'test', now: at('20:13') });
  assert.equal((await fake.store.getHousehold(HH))!.bath!.returnReason, 'exit_not_yet');

  const r = await switchMode(fake.ctx, HH, 'bedroom', 'family', at('20:15'));
  assert.equal(r.changed, true);
  assert.equal(r.notice, undefined);
  assert.equal(r.say, BATH_END_SAY);
  const e = (await fake.store.listLedger(HH, THU)).filter(x => x.name === 'mode_changed').at(-1)!;
  assert.equal(e.actor, 'member:family');
  assert.deepEqual([(e.args as any).reason, (e.args as any).notice], ['manual', null]);
  // 予約してあった 20:23 の戻りが後から届いても何もしない
  assert.equal((await handleBathReturn(fake.ctx, HH, at('20:23'), at('19:30').toISOString())).reason, 'not_bath');
  assert.deepEqual(fake.familyNotify.calls.map(c => c.reason), ['体を洗い始めました']);

  // iPad の家族用ボタン（device）でも同じ
  const dev = await setup();
  await bathUntilExit(dev);
  const d = await switchMode(dev.ctx, HH, 'bedroom', 'device', at('20:07'));
  assert.equal(d.notice, undefined);
  assert.deepEqual(dev.familyNotify.calls.map(c => c.reason), ['体を洗い始めました']);
});

test('停止中でも切替はできる（声かけは積まない）', async () => {
  const fake = await setup();
  await fake.store.updateHousehold(HH, { killSwitch: true });
  const r = await switchMode(fake.ctx, HH, 'bath', 'device', at('19:30'));
  assert.equal(r.changed, true);
  assert.equal(r.say, undefined);
  assert.equal(modeOf(r.household), 'bath');
  assert.equal((await fake.store.listPrompts(HH, THU)).length, 0);
  assert.equal((await fake.store.listLedger(HH, THU)).at(-1)!.actor, 'member:device');
});

test('夕方の要約: お風呂の声かけへの返事は「お返事の記録」に載る', async () => {
  const fake = await setup();
  const wash = await bathUntilWash(fake);
  await processReply(fake.ctx, { hh: HH, promptId: wash.id, replyText: 'はい', source: 'test', now: at('19:41') });
  const s = await buildSummary(fake.ctx, HH, THU, { useLlm: false });
  assert.ok(s.sections!.replies.some(l => /お風呂（体を洗う）の声かけに「はい」/.test(l)));
});

// ---------------------------------------------------------------------------
// ときたまの声かけ
// ---------------------------------------------------------------------------

test('ときたまの声かけ: 計画の声かけから離れた時間に、時刻と曜日 → お水 を交互に。返事は求めない。台帳 idle_chat_sent', async () => {
  const fake = await setup();
  const h = (await fake.store.getHousehold(HH))!;
  await fake.store.updateHousehold(HH, { policy: { ...h.policy, idleChatMinutes: 30 } });
  const p1 = await nextPrompt(fake.ctx, HH, at('13:00'));
  assert.equal(p1!.task, 'talk');
  assert.equal(p1!.text, '今は 13 時です。今日は木曜日ですよ');
  assert.equal(p1!.expectsReply, false);
  assert.equal(p1!.idleChat, true);
  assert.equal(p1!.state, 'delivered');
  assert.equal(await nextPrompt(fake.ctx, HH, at('13:20')), null);   // 30 分たっていない
  const p2 = await nextPrompt(fake.ctx, HH, at('13:31'));
  assert.equal(p2!.text, IDLE_WATER_TEXT);
  const p3 = await nextPrompt(fake.ctx, HH, at('14:02'));
  assert.equal(p3!.text, '今は 14 時 2 分です。今日は木曜日ですよ');
  assert.equal((await fake.store.listLedger(HH, THU)).filter(e => e.name === 'idle_chat_sent').length, 3);
  // 状態機械は動かさない・返事が無くても無反応にしない
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.talk, undefined);
  assert.equal(await expireUnansweredPrompts(fake.ctx, HH, at('15:00'), 10), 0);
  assert.equal((await fake.store.getDay(HH, THU))!.signals.noAnswerCount, 0);
});

test('ときたまの声かけ: 計画の声かけが前後 45 分にある・就寝時間帯・無効（0）・デイで不在の間・お風呂の間は出さない', async () => {
  const fake = await setup();
  assert.equal(await nextPrompt(fake.ctx, HH, at('11:20')), null);   // 12:00 の昼食まで 40 分
  assert.equal(await nextPrompt(fake.ctx, HH, at('14:50')), null);   // 15:30 の水分まで 40 分
  assert.equal(await nextPrompt(fake.ctx, HH, at('22:30')), null);   // 就寝時間帯
  assert.ok(await nextPrompt(fake.ctx, HH, at('13:50')));

  const off = await setup();
  const h = (await off.store.getHousehold(HH))!;
  await off.store.updateHousehold(HH, { policy: { ...h.policy, idleChatMinutes: 0 } });
  assert.equal(await nextPrompt(off.ctx, HH, at('13:50')), null);

  const tue = await setup(TUE);
  assert.equal(await nextPrompt(tue.ctx, HH, at('13:00', TUE)), null);   // デイで不在（9:00 お迎え〜16:00 帰宅）

  const bath = await setup();
  await switchMode(bath.ctx, HH, 'bath', 'family', at('13:00'));
  const s = await nextPrompt(bath.ctx, HH, at('13:01'));
  assert.equal(s!.bathStep, 'start');
  assert.equal(await nextPrompt(bath.ctx, HH, at('13:02')), null);
});

test('ときたまの声かけへの返事は本人からの発話として扱う（居場所に答える。夕方の「お返事の記録」には載らない）', async () => {
  const fake = await setup();
  const p = await nextPrompt(fake.ctx, HH, at('13:50'));
  const r = await processReply(fake.ctx, { hh: HH, promptId: p!.id, replyText: '島村さんはどこ行ったの', source: 'test', now: at('13:51') });
  assert.equal(r.turn.kind, 'utterance');
  assert.equal(r.turn.utteranceKind, 'whereabouts');
  assert.equal(r.turn.promptId, p!.id);
  assert.equal(r.say, '島村さんは出かけています。もうすぐ帰ってきますよ。');
  assert.equal((await fake.store.getPrompt(HH, THU, p!.id))!.state, 'answered');
  const s = await buildSummary(fake.ctx, HH, THU, { useLlm: false });
  assert.ok(!s.text.includes('どこ行った'));
});
