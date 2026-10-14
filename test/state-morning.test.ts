// 朝の流れ（モーニング・シーケンス。docs/03 §5、2026-10-14 家族の要望）
//  8:00 にまず起こす（緊迫感のある言い方を 3 つ順に、返事があるまで 1 分おき・60 回まで）→ おむつ → 洗顔・歯磨き → 着替え を、返事があってから順に進める。
//  段階表（L3/L4）には乗せない。上限で check を 1 回だけ、その工程で待つ。10:30 で終了。9:00 のお迎えは時刻どおり。
//  工程①への返事は 起きた／起きたくない／体調が悪い／どれでもない に分ける（2026-10-14 夜）。
//  工程②〜④の not_yet は「では、できたら教えてくださいね」、2 分後に「〜できましたか？」で確認（返事なしは 5 分後に元の声かけ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { createFakeContext, KeywordTurnRunner } from '../src/state/fakes.js';
import { RulesTurnRunner } from '../src/agent/rules.js';
import { ensureDay, expireUnansweredPrompts, nextPrompt, planDay } from '../src/state/day.js';
import { processReply } from '../src/state/turn.js';
import { buildSummary } from '../src/state/summary.js';
import { runScenario } from '../src/state/replay.js';
import {
  DEFAULT_MORNING_POLICY, MORNING_DIAPER_TEXT, MORNING_DRESS_TEXT, MORNING_FACE_TEXT, MORNING_NOT_YET_SAY,
  MORNING_REFUSE_SAY, MORNING_UNWELL_SAY, classifyWakeReply, morningPolicyOf,
} from '../src/state/morning.js';
import { jstDate } from '../src/time.js';
import type { TurnRunner } from '../src/services.js';
import type { Household, Prompt, Scenario } from '../src/types.js';

const HH = 'hh_m';
const WED = '2026-10-14';   // デイの日（月・水・金・土）
const THU = '2026-10-15';   // デイ以外の日
const WAKE1 = '島村かよこさん！ おはようございます。朝の 8 時です。起きてください';
const WAKE2 = '島村かよこさん、起きてください。朝ですよ';
const WAKE3 = '島村かよこさん！ 聞こえますか。起きる時間です';
const DAY_DRESS = '今日はデイサービスで出かける日ですよ。9 時にお迎えが来ます。お着替えをしましょう';
const DIAPER_FOLLOWUP = 'おむつは替えられましたか？';
const FACE_FOLLOWUP = 'お顔と歯磨きはできましたか？';
const DRESS_FOLLOWUP = 'お着替えはできましたか？';

async function setup(opts: { runner?: TurnRunner; patch?: (h: Household) => Household } = {}) {
  const store = new MemoryStore();
  let h = defaultHousehold(HH);
  h = { ...h, person: { ...h.person, wakeName: '島村かよこさん' } };
  if (opts.patch) h = opts.patch(h);
  await store.putHousehold(h);
  return createFakeContext({ store, turnRunner: opts.runner ?? new KeywordTurnRunner(), clock: () => jstDate(WED, '06:00') });
}
type Fake = Awaited<ReturnType<typeof setup>>;

const at = (time: string, date = WED) => jstDate(date, time);
async function next(fake: Fake, time: string, date = WED): Promise<Prompt | null> {
  return nextPrompt(fake.ctx, HH, at(time, date));
}
async function reply(fake: Fake, p: Prompt, text: string | null, time: string, date = WED) {
  return processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: text, source: 'test', now: at(time, date) });
}
async function day(fake: Fake, date = WED) {
  return (await fake.store.getDay(HH, date))!;
}

/** 起こす → おむつまで進める（8:00 に起こし、8:00 に返事） */
async function wakeUp(fake: Fake, date = WED): Promise<Prompt> {
  const w = (await next(fake, '08:00', date))!;
  await reply(fake, w, 'はい', '08:00', date);
  return (await next(fake, '08:01', date))!;
}

test('既定: policy.morning が未設定でも有効（08:00〜10:30、起こす 1 分×60 回、ほか 5 分×6 回・まだのあと 2 分で確認）。seed も同じ値', () => {
  const h = defaultHousehold(HH);
  assert.deepEqual(h.policy.morning, { ...DEFAULT_MORNING_POLICY });
  const { morning: _m, ...rest } = h.policy;
  assert.deepEqual(morningPolicyOf({ policy: rest }), { ...DEFAULT_MORNING_POLICY });
  assert.equal(morningPolicyOf({ policy: { ...rest, morning: { ...DEFAULT_MORNING_POLICY, enabled: false } } }).enabled, false);
});

test('planDay: 朝の流れの日は 8:00〜10:30 の起床・おむつ・歯磨き・洗顔・着替え・持ち物の声かけを作らない。お迎え以降は今までどおり', async () => {
  const fake = await setup();
  const { prompts } = await planDay(fake.ctx, HH, WED, at('06:00'));
  const tasks = prompts.map(p => p.task);
  for (const t of ['greeting', 'diaper', 'teeth', 'face', 'dress', 'belongings'] as const) assert.ok(!tasks.includes(t), t);
  assert.deepEqual(tasks, ['pickup', 'return', 'water', 'dinner', 'medicine', 'bedtime']);
  assert.match(fake.familyNotify.calls[0].evidence, /08:00 朝の流れ（起こす→おむつ→洗顔・歯磨き→着替え/);
  // デイ以外の日も 10:30 の水分・昼食は残る
  const thu = await planDay(fake.ctx, HH, THU, at('06:00', THU));
  assert.deepEqual(thu.prompts.map(p => p.task), ['water', 'lunch', 'water', 'dinner', 'medicine', 'bedtime']);
});

test('起こす: 8:00 に名前を呼び、返事が無ければ 1 分おきに言い方を強めて繰り返す。「起きたよ」で工程②（おむつ）へ', async () => {
  const fake = await setup();
  await planDay(fake.ctx, HH, WED, at('06:00'));
  assert.equal(await next(fake, '07:59'), null);
  const w1 = (await next(fake, '08:00'))!;
  assert.equal(w1.text, WAKE1);
  assert.equal(w1.task, 'greeting');
  assert.equal(w1.morningStep, 1);
  assert.equal(w1.isRecheck, false);
  const r1 = await reply(fake, w1, null, '08:00');   // 端末の「返事なし」
  assert.equal(r1.notices.length, 0);
  assert.equal(fake.tasks.scheduled.length, 0);       // 再確認の予約はしない（朝の流れが繰り返す）
  assert.equal(await nextPrompt(fake.ctx, HH, new Date(at('08:00').getTime() + 50_000)), null);   // 1 分たっていない
  const w2 = (await next(fake, '08:01'))!;
  assert.equal(w2.text, WAKE2);
  assert.equal(w2.isRecheck, true);
  await reply(fake, w2, null, '08:01');
  assert.equal((await next(fake, '08:02'))!.text, WAKE3);
  const w4 = (await next(fake, '08:03'))!;
  assert.equal(w4.text, WAKE1);   // 3 つを順に使い、最初に戻る
  assert.equal((await day(fake)).morning!.repeats, 4);
  const r2 = await reply(fake, w4, '起きたよ', '08:04');
  assert.equal(r2.turn.classified.status, 'done');
  assert.equal(r2.notices.length, 0);
  const d = await day(fake);
  assert.equal(d.tasks.greeting?.state, 'done');
  assert.equal(d.morning!.step, 2);
  assert.equal(d.morning!.repeats, 0);
  const p = (await next(fake, '08:04'))!;
  assert.equal(p.text, MORNING_DIAPER_TEXT);   // ほかの工程は穏やかな言い方
  assert.equal(p.task, 'diaper');
  assert.equal(p.morningStep, 2);
  const names = (await fake.store.listLedger(HH, WED)).map(e => e.name);
  assert.ok(names.includes('morning_step'));
});

test('起こす: 判定できない音（テレビ等）では起きたとみなさない。一言は言わず、1 分後にまた起こす', async () => {
  const fake = await setup();
  const w = (await next(fake, '08:00'))!;
  const r = await reply(fake, w, '（テレビの音）続いては天気です', '08:00');
  assert.equal(r.say, '');
  assert.equal(r.turn.classified.status, 'unclear');
  assert.equal(r.notices.length, 0);
  const d = await day(fake);
  assert.equal(d.morning!.step, 1);
  assert.notEqual(d.tasks.greeting?.state, 'done');
  const w2 = (await next(fake, '08:01'))!;
  assert.equal(w2.text, WAKE2);
  assert.equal(w2.morningStep, 1);
});

test('起こす: 返事の 3 種類（規則のみ）。起きたくない側を先に見る（「起きたくない」は「起きた」を含む）', () => {
  for (const t of ['起きた', '起きたよ', '起きてる', '起きます', '起きる', 'はい', 'うん', 'おはよう', '分かった', 'うーん、おはよう']) {
    assert.equal(classifyWakeReply(t), 'awake', t);
  }
  for (const t of ['起きたくない', 'まだ寝る', '寝かせて', '眠い', 'いや', '嫌', 'あとで', 'まだ', 'まだ眠い', 'ううん']) {
    assert.equal(classifyWakeReply(t), 'refuse', t);
  }
  for (const t of ['体調が悪い', '具合が悪い', '気分が悪い', 'しんどい', 'だるい', '気持ち悪い', '頭が痛い', '痛い', '起き上がれない']) {
    assert.equal(classifyWakeReply(t), 'unwell', t);
  }
  for (const t of ['（テレビの音）', 'ニュースです', 'あら']) assert.equal(classifyWakeReply(t), 'none', t);
  assert.equal(classifyWakeReply(null), 'no_answer');
  assert.equal(classifyWakeReply('  '), 'no_answer');
});

test('起こす:「起きたくない」→ 工程①のまま、一言は refuseSay、1 分後にまた起こす（回数は数え続ける）', async () => {
  const fake = await setup();
  const w1 = (await next(fake, '08:00'))!;
  const r = await reply(fake, w1, '起きたくない', '08:00');
  assert.equal(r.say, MORNING_REFUSE_SAY);
  assert.equal(r.say, 'がんばって起きてください。それとも体調が悪いのですか？');
  assert.equal(r.turn.classified.status, 'not_yet');
  assert.equal(r.notices.length, 0);
  let d = await day(fake);
  assert.equal(d.morning!.step, 1);
  assert.notEqual(d.tasks.greeting?.state, 'done');
  assert.equal(await nextPrompt(fake.ctx, HH, new Date(at('08:00').getTime() + 50_000)), null);
  const w2 = (await next(fake, '08:01'))!;
  assert.equal(w2.text, WAKE2);
  assert.equal(w2.morningStep, 1);
  d = await day(fake);
  assert.equal(d.morning!.repeats, 2);
  // 「まだ寝る」も同じ。その後「起きたよ」で工程②へ
  assert.equal((await reply(fake, w2, 'まだ寝る', '08:01')).say, MORNING_REFUSE_SAY);
  const w3 = (await next(fake, '08:02'))!;
  assert.equal(w3.text, WAKE3);
  await reply(fake, w3, '起きたよ', '08:02');
  assert.equal((await day(fake)).morning!.step, 2);
  assert.equal((await next(fake, '08:02'))!.text, MORNING_DIAPER_TEXT);
  assert.equal(fake.familyNotify.calls.length, 0);
});

test('起こす: refuseSay は policy.morning.refuseSay で変えられる', async () => {
  const fake = await setup({ patch: h => ({ ...h, policy: { ...h.policy, morning: { ...h.policy.morning!, refuseSay: 'もう朝ですよ。起きましょうね' } } }) });
  const w = (await next(fake, '08:00'))!;
  assert.equal((await reply(fake, w, '眠い', '08:00')).say, 'もう朝ですよ。起きましょうね');
});

test('起こす:「具合が悪い」→ 家族へ check を 1 回、一言は「横になっていてください」、起こすのをやめて朝の流れを終える（cutoff）', async () => {
  const fake = await setup();
  await planDay(fake.ctx, HH, WED, at('06:00'));
  const planCalls = fake.familyNotify.calls.length;
  const w1 = (await next(fake, '08:00'))!;
  await reply(fake, w1, null, '08:00');
  const w2 = (await next(fake, '08:01'))!;
  const r = await reply(fake, w2, '具合が悪い', '08:01');
  assert.equal(r.say, MORNING_UNWELL_SAY);
  assert.equal(r.say, '分かりました。無理をしないで、横になっていてください');
  assert.ok(!/家族/.test(r.say));
  assert.deepEqual(r.notices.map(n => n.level), ['check']);
  const calls = fake.familyNotify.calls.slice(planCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'check');
  assert.equal(calls[0].reason, '起こしの声かけに『体調が悪い』とのお返事です');
  assert.match(calls[0].evidence, /具合が悪い/);
  const d = await day(fake);
  assert.equal(d.morning!.result, 'cutoff');
  assert.equal(d.morning!.step, 1);
  assert.equal(d.l4 ?? null, null);
  // 起こす声かけは止まる（1 分後も 10 分後も出ない）
  for (const time of ['08:02', '08:03', '08:10']) {
    const p = await next(fake, time);
    assert.ok(!p || p.morningStep == null, time);
  }
  assert.equal(fake.familyNotify.calls.length - planCalls, 1);
  assert.ok((await fake.store.listLedger(HH, WED)).some(e => e.name === 'morning_finished' && (e.args as { why?: string }).why === 'unwell'));
  // 残りの工程は夕方の要約に「未確認」（「お返事がありませんでした」とは書かない）
  const s = await buildSummary(fake.ctx, HH, WED, { useLlm: false });
  assert.ok(s.sections!.concerns.some(l => /^8:01 朝の流れを「起こす声かけ」のところで終えました。起床の挨拶・おむつ交換・洗顔・歯磨き・着替えは未確認です。$/.test(l)),
    JSON.stringify(s.sections!.concerns));
});

test('起こす:「頭が痛い」は痛みの check（会話ターン）だけ。体調が悪いの check は重ねず、起こすのをやめる', async () => {
  const fake = await setup({ runner: new RulesTurnRunner() });
  const w = (await next(fake, '08:00'))!;
  const r = await reply(fake, w, '頭が痛い', '08:00');
  assert.deepEqual(r.notices.map(n => [n.level, n.origin]), [['check', 'pain']]);
  assert.equal(fake.familyNotify.calls.length, 1);
  assert.equal(r.say, MORNING_UNWELL_SAY);
  assert.equal((await day(fake)).morning!.result, 'cutoff');
  const p = await next(fake, '08:01');
  assert.ok(!p || p.morningStep == null);
});

test('朝の流れの最中は 8:05 の時刻ベースのおむつが出ない（起きていないのに進まない）', async () => {
  const fake = await setup();
  await planDay(fake.ctx, HH, WED, at('06:00'));
  const w1 = (await next(fake, '08:00'))!;
  await reply(fake, w1, null, '08:01');
  const w2 = (await next(fake, '08:05'))!;   // 8:05 に出るのは起こす声かけ
  assert.equal(w2.task, 'greeting');
  assert.equal(w2.morningStep, 1);
  assert.ok(!(await fake.store.listPrompts(HH, WED)).some(p => p.task === 'diaper'));
});

test('工程②で「まだ」→「では、できたら教えてくださいね」、2 分後に「おむつは替えられましたか？」。済んだら工程③（洗顔・歯磨き）、done なら歯磨きも済み → 工程④（デイの日の文言）→ 完了', async () => {
  const fake = await setup();
  const d1 = await wakeUp(fake);
  assert.equal(d1.text, MORNING_DIAPER_TEXT);
  const r = await reply(fake, d1, 'まだ', '08:01');
  assert.equal(r.notices.length, 0);
  assert.equal(r.say, MORNING_NOT_YET_SAY);
  assert.equal(r.say, 'では、できたら教えてくださいね');
  assert.equal((await day(fake)).tasks.diaper?.state, 'rechecking');
  assert.equal((await day(fake)).morning!.awaitingDone, true);
  assert.equal(await next(fake, '08:02'), null);   // 2 分たっていない
  const d2 = (await next(fake, '08:03'))!;
  assert.equal(d2.text, DIAPER_FOLLOWUP);
  assert.equal(d2.isRecheck, true);
  assert.equal(d2.morningStep, 2);
  assert.equal((await day(fake)).morning!.repeats, 2);   // 数え方は変えない
  await reply(fake, d2, '替えたよ', '08:04');
  assert.equal((await day(fake)).tasks.diaper?.state, 'done');

  const f = (await next(fake, '08:04'))!;
  assert.equal(f.text, MORNING_FACE_TEXT);
  assert.equal(f.task, 'face');
  await reply(fake, f, '洗ったよ', '08:10');
  const mid = await day(fake);
  assert.equal(mid.tasks.face?.state, 'done');
  assert.equal(mid.tasks.teeth?.state, 'done');

  const dr = (await next(fake, '08:10'))!;
  assert.equal(dr.text, DAY_DRESS);
  assert.equal(dr.task, 'dress');
  await reply(fake, dr, '着替えたよ', '08:15');
  const end = await day(fake);
  assert.equal(end.tasks.dress?.state, 'done');
  assert.equal(end.morning!.result, 'done');
  assert.ok(end.morning!.finishedAt);
  assert.equal(await next(fake, '08:20'), null);
  assert.ok((await fake.store.listLedger(HH, WED)).some(e => e.name === 'morning_finished'));
  assert.equal(fake.familyNotify.calls.length, 0);
});

test('工程②〜④:「今から替える」「着替えます」も not_yet（2 分後に確認）。返事なしは今までどおり 5 分後に元の声かけ', async () => {
  const fake = await setup();
  const d1 = await wakeUp(fake);
  const r1 = await reply(fake, d1, '今から替える', '08:01');
  assert.equal(r1.turn.classified.status, 'not_yet');
  assert.equal(r1.say, MORNING_NOT_YET_SAY);
  const d2 = (await next(fake, '08:03'))!;
  assert.equal(d2.text, DIAPER_FOLLOWUP);
  // 確認に返事なし → 5 分後に元の声かけ
  const r2 = await reply(fake, d2, null, '08:03');
  assert.notEqual(r2.say, MORNING_NOT_YET_SAY);
  assert.equal((await day(fake)).morning!.awaitingDone, undefined);
  assert.equal(await next(fake, '08:05'), null);
  const d3 = (await next(fake, '08:08'))!;
  assert.equal(d3.text, MORNING_DIAPER_TEXT);
  await reply(fake, d3, '替えたよ', '08:08');
  const f = (await next(fake, '08:08'))!;
  assert.equal((await reply(fake, f, 'これから洗います', '08:09')).say, MORNING_NOT_YET_SAY);
  const f2 = (await next(fake, '08:11'))!;
  assert.equal(f2.text, FACE_FOLLOWUP);
  await reply(fake, f2, '洗ったよ', '08:12');
  const dr = (await next(fake, '08:12'))!;
  assert.equal(dr.text, DAY_DRESS);
  const r3 = await reply(fake, dr, '着替えます', '08:13');
  assert.equal(r3.turn.classified.status, 'not_yet');
  assert.equal(r3.say, MORNING_NOT_YET_SAY);
  assert.equal((await next(fake, '08:15'))!.text, DRESS_FOLLOWUP);
  assert.equal(fake.familyNotify.calls.length, 0);
});

test('工程②〜④の not_yet の一言・確認の言い回し・間隔は policy.morning で変えられる', async () => {
  const fake = await setup({
    patch: h => ({ ...h, policy: { ...h.policy, morning: {
      ...h.policy.morning!, stepFollowupMinutes: 3, notYetSay: '終わったら呼んでくださいね', followupTexts: { diaper: 'おむつ、どうですか？' },
    } } }),
  });
  const d1 = await wakeUp(fake);
  assert.equal((await reply(fake, d1, 'まだ', '08:01')).say, '終わったら呼んでくださいね');
  assert.equal(await next(fake, '08:03'), null);
  assert.equal((await next(fake, '08:04'))!.text, 'おむつ、どうですか？');
});

test('デイ以外の日の工程④は「お着替えをしましょうか」', async () => {
  const fake = await setup();
  const d1 = await wakeUp(fake, THU);
  await reply(fake, d1, '替えたよ', '08:02', THU);
  const f = (await next(fake, '08:02', THU))!;
  await reply(fake, f, 'はい、洗った', '08:03', THU);
  const dr = (await next(fake, '08:03', THU))!;
  assert.equal(dr.text, MORNING_DRESS_TEXT);
});

test('工程②で 6 回取れなければ check を 1 回だけ。以後も同じ工程で待ち（勝手に進まない）、段階表の L3/L4 は出ない', async () => {
  const fake = await setup();
  let p = await wakeUp(fake);
  let t = 1;   // 8:01 から 5 分おき
  for (let i = 1; i <= 6; i += 1) {
    // 返事なしのあとは元の声かけ、「まだ」のあとは確認の言い回し（数え方・上限は同じ）
    assert.equal(p.text, i % 2 ? (i === 1 ? MORNING_DIAPER_TEXT : DIAPER_FOLLOWUP) : MORNING_DIAPER_TEXT, `${i} 回目`);
    const time = `08:${String(t + 1).padStart(2, '0')}`;
    const r = await reply(fake, p, i % 2 ? null : 'まだ', time);
    if (i < 6) {
      assert.equal(r.notices.length, 0, `${i} 回目は通知なし`);
      t += 5;
      p = (await next(fake, `08:${String(t).padStart(2, '0')}`))!;
    } else {
      assert.deepEqual(r.notices.map(n => n.level), ['check']);
    }
  }
  const calls = fake.familyNotify.calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'check');
  assert.equal(calls[0].reason, '朝の声かけに返事がありません（おむつ）');
  assert.equal(calls[0].task, 'diaper');
  // 待ち続ける: 声かけは出さず、工程は② のまま、通知も重ねない
  for (const time of ['08:40', '08:50', '09:30', '10:00']) assert.equal(await next(fake, time), null, time);
  const d = await day(fake);
  assert.equal(d.morning!.step, 2);
  assert.equal(d.morning!.notified, true);
  assert.equal(d.morning!.result, null);
  assert.equal(fake.familyNotify.calls.length, 1);
  assert.ok(!fake.familyNotify.calls.some(c => c.level === 'urgent'));
  assert.equal(d.l4 ?? null, null);
  assert.equal(d.signals.noAnswerCount, 0);   // 朝の流れの繰り返しは無反応の記録に数えない
  assert.ok(!(await fake.store.listPrompts(HH, WED)).some(x => x.task === 'face'));
});

test('上限のあと家族が「確認した」を押したら、同じ工程の声かけをもう一度始める（お願いは重ねない）', async () => {
  const fake = await setup({ patch: h => ({ ...h, policy: { ...h.policy, morning: { ...h.policy.morning!, stepMaxRepeats: 2 } } }) });
  const p1 = await wakeUp(fake);
  await reply(fake, p1, null, '08:02');
  const p2 = (await next(fake, '08:06'))!;
  const r2 = await reply(fake, p2, null, '08:07');
  assert.equal(r2.notices.length, 1);
  assert.equal(await next(fake, '08:20'), null);
  await fake.familyNotify.ack(HH, r2.notices[0].id, 'mem_1', at('08:25'));
  const p3 = (await next(fake, '08:26'))!;
  assert.equal(p3.text, MORNING_DIAPER_TEXT);
  await reply(fake, p3, null, '08:27');
  const p4 = (await next(fake, '08:31'))!;
  await reply(fake, p4, null, '08:32');
  assert.equal(await next(fake, '08:40'), null);
  assert.equal(fake.familyNotify.calls.length, 1);
});

test('起こす声かけは 60 回まで（1 分おき）。返事なしが続いても L3/L4 にならず、上限で check が 1 回', async () => {
  const fake = await setup({ runner: new RulesTurnRunner() });
  let minute = 0;
  for (let i = 1; i <= 60; i += 1) {
    const time = `${String(8 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const p = (await next(fake, time))!;
    assert.equal(p?.morningStep, 1, `${i} 回目 ${time}`);
    const r = await reply(fake, p, null, time);
    assert.ok(!r.notices.some(n => n.level === 'urgent'), `${i} 回目`);
    if (i < 60) assert.equal(r.notices.length, 0, `${i} 回目`);
    minute += 1;
  }
  assert.deepEqual(fake.familyNotify.calls.map(c => [c.level, c.reason]), [['check', '朝の声かけに返事がありません（起こす声かけ）']]);
  const d = await day(fake);
  assert.equal(d.l4 ?? null, null);
  assert.equal(d.morning!.step, 1);
  assert.equal(await next(fake, '09:05'), null);
  assert.ok(!(await fake.store.listPrompts(HH, WED)).some(p => p.task === 'diaper'));
});

test('起こす声かけの文言は policy.morning.wakeTexts で変えられる（{name}・{hour}）。名前が無ければ callName', async () => {
  const fake = await setup({ patch: h => ({ ...h, person: { ...h.person, wakeName: undefined }, policy: { ...h.policy, morning: { ...h.policy.morning!, wakeTexts: ['{name}、{hour} 時ですよ！', '{name}、朝です！'] } } }) });
  assert.equal((await next(fake, '08:00'))!.text, 'お母さん、8 時ですよ！');
  assert.equal((await next(fake, '08:01'))!.text, 'お母さん、朝です！');
  assert.equal((await next(fake, '08:02'))!.text, 'お母さん、8 時ですよ！');
});

test('9:00 のお迎えは時刻どおりに出て、朝の流れはそこで終える（cutoff）。残りは夕方の要約に「未確認」', async () => {
  const fake = await setup();
  await planDay(fake.ctx, HH, WED, at('06:00'));
  const d1 = await wakeUp(fake);
  await reply(fake, d1, 'まだ', '08:02');
  const pk = (await next(fake, '09:00'))!;
  assert.equal(pk.task, 'pickup');
  assert.equal(pk.text, 'お迎えは来ましたか？');
  const d = await day(fake);
  assert.equal(d.morning!.result, 'cutoff');
  assert.equal(await next(fake, '09:01'), null);
  const s = await buildSummary(fake.ctx, HH, WED, { useLlm: false });
  assert.ok(s.sections!.concerns.some(l => /^9:00 朝の流れを「おむつ」のところで終えました。おむつ交換・洗顔・歯磨き・着替えは未確認です。$/.test(l)),
    JSON.stringify(s.sections!.concerns));
});

test('10:30 を過ぎたら朝の流れを終える（cutoff）。待っていた工程から後ろは「未確認」', async () => {
  const fake = await setup();
  const w = (await next(fake, '08:00', THU))!;
  await reply(fake, w, null, '08:01', THU);
  const p = await next(fake, '10:30', THU);
  assert.notEqual(p?.morningStep, 1);
  const d = await day(fake, THU);
  assert.equal(d.morning!.result, 'cutoff');
  assert.equal(d.morning!.step, 1);
  const s = await buildSummary(fake.ctx, HH, THU, { useLlm: false });
  assert.ok(s.sections!.concerns.some(l => /^10:30 朝の流れを終えました（起こす声かけに、お返事がありませんでした）。起床の挨拶・おむつ交換・洗顔・歯磨き・着替えは未確認です。$/.test(l)),
    JSON.stringify(s.sections!.concerns));
  // 返事なしの繰り返しは「お返事の記録」に 1 回ずつは載せない
  assert.ok(!s.sections!.replies.some(l => /起床の挨拶の声かけには、お返事がありませんでした/.test(l)));
});

test('朝の流れの最中でも L4 の語はいつもどおり至急（L4 モード）。その間は朝の声かけを出さない', async () => {
  const fake = await setup();
  const d1 = await wakeUp(fake);
  const r = await reply(fake, d1, '転んだ、助けて', '08:02');
  assert.deepEqual(r.notices.map(n => n.level), ['urgent']);
  assert.ok((await day(fake)).l4);
  const p = await next(fake, '08:10');
  assert.equal(p?.isReassurance, true);
});

test('返事の無い朝の声かけを /internal/health が締めても段階表に乗せない（通知なし、同じ工程で待つ）', async () => {
  const fake = await setup();
  const d1 = await wakeUp(fake);
  const n = await expireUnansweredPrompts(fake.ctx, HH, at('08:20'), 10);
  assert.equal(n, 1);
  assert.equal(fake.familyNotify.calls.length, 0);
  const d = await day(fake);
  assert.equal(d.morning!.step, 2);
  assert.equal(d.tasks.diaper?.state, 'rechecking');
  assert.equal(d.tasks.diaper?.status, 'no_answer');
  const again = (await next(fake, '08:20'))!;
  assert.equal(again.text, d1.text);
});

test('朝の流れを止めた世帯（enabled: false）は今までどおり時刻ベース', async () => {
  const fake = await setup({ patch: h => ({ ...h, policy: { ...h.policy, morning: { ...h.policy.morning!, enabled: false } } }) });
  const { prompts } = await planDay(fake.ctx, HH, WED, at('06:00'));
  assert.equal(prompts[0].task, 'greeting');
  const p = (await next(fake, '08:00'))!;
  assert.equal(p.text, 'おはようございます。よく眠れましたか？');
  assert.equal(p.morningStep, undefined);
  await ensureDay(fake.ctx, HH, WED);
  assert.equal((await day(fake)).morning, undefined);
});

test('再生モード: morning.json（台本の morning: true）が全件一致', async () => {
  const scenario = JSON.parse(await readFile(new URL('../eval/scenarios/morning.json', import.meta.url), 'utf8')) as Scenario;
  const { ctx, store, familyNotify } = createFakeContext({ turnRunner: new RulesTurnRunner() });
  const r = await runScenario(ctx, 'hh_demo', scenario, { withSummary: true });
  assert.equal(r.failCount, 0, JSON.stringify(r.steps.filter(s => s.pass === false), null, 2));
  assert.equal(r.passCount, scenario.turns.filter(t => t.expect).length);
  assert.deepEqual(r.steps.filter(s => s.morningStep).map(s => s.morningStep), [1, 1, 1, 2, 2, 3, 4]);
  assert.equal((await store.getDay('hh_demo', scenario.date))!.morning!.result, 'done');
  assert.ok(!familyNotify.calls.some(c => c.level === 'urgent' || c.level === 'check'));
});
