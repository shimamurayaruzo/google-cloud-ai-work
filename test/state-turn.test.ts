// 会話ターンの中核（processReply / handleRecheck）と一日の流れ（planDay / nextPrompt / expireUnansweredPrompts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { createFakeContext } from '../src/state/fakes.js';
import { deliverPrompt, enqueuePrompt, ensureDay, expireUnansweredPrompts, nextPrompt, planDay } from '../src/state/day.js';
import { handleRecheck, NotFoundError, processReply } from '../src/state/turn.js';
import { addMinutes, jstDate } from '../src/time.js';
import type { Intent, TurnInput, TurnOutcome, TurnRunner } from '../src/services.js';
import type { Classification, TaskKey } from '../src/types.js';
import { L4_SAY, REASSURANCE_SAY, RulesTurnRunner } from '../src/agent/rules.js';

const HH = 'hh_t';
const THU = '2026-10-01';   // デイ以外の日

/** 手書きの TurnRunner: 返事の文字列 → 固定の分類と Intent */
class ScriptedRunner implements TurnRunner {
  readonly inputs: TurnInput[] = [];
  constructor(private script: (input: TurnInput) => { status: Classification; intents?: Intent[] }) {}
  async run(input: TurnInput): Promise<TurnOutcome> {
    this.inputs.push(input);
    const { status, intents } = this.script(input);
    return {
      classified: { status, note: 'scripted', by: 'rules' },
      say: 'はい',
      expression: 'smile',
      toolCalls: [],
      intents: intents ?? [
        { type: 'record', task: input.prompt.task, status, note: 'scripted' },
        ...(status !== 'done' && input.recheckAllowed ? [{ type: 'recheck', minutes: 15, reason: status } as Intent] : []),
      ],
      latencyMs: 3,
    };
  }
}

const byReply = (input: TurnInput): { status: Classification } => {
  const t = input.replyText;
  if (t == null) return { status: 'no_answer' };
  if (t.includes('まだ')) return { status: 'not_yet' };
  if (t.includes('？')) return { status: 'unclear' };
  return { status: 'done' };
};

async function setup(runner: TurnRunner = new ScriptedRunner(byReply)) {
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold(HH));
  const fake = createFakeContext({ store, turnRunner: runner, clock: () => jstDate(THU, '08:00') });
  await ensureDay(fake.ctx, HH, THU);
  return fake;
}

async function ask(fake: Awaited<ReturnType<typeof setup>>, task: TaskKey, time: string, isRecheck = false) {
  const now = jstDate(THU, time);
  const p = await enqueuePrompt(fake.ctx, HH, THU, task, { at: now, isRecheck });
  return deliverPrompt(fake.ctx, p, now);
}

test('not_yet → 再確認が予約され followUp が返る（予定の無い日でも計画の recheckMinutes を優先。docs/03 の着替えは 15 分）。state は rechecking', async () => {
  const fake = await setup();
  const p = await ask(fake, 'dress', '08:40');
  const now = jstDate(THU, '08:41');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: 'まだ', source: 'test', now });

  assert.equal(r.turn.classified.status, 'not_yet');
  assert.equal(fake.tasks.scheduled.length, 1);
  assert.equal(fake.tasks.scheduled[0].path, '/internal/recheck');
  assert.deepEqual(fake.tasks.scheduled[0].body, { hh: HH, date: THU, task: 'dress', promptId: p.id });
  assert.ok(r.followUp);
  assert.equal(r.followUp!.task, 'dress');
  assert.equal(r.followUp!.at.getTime(), addMinutes(now, 15).getTime());
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.tasks.dress?.state, 'rechecking');
  assert.equal(day.tasks.dress?.evidence, 'まだ');
  assert.equal((await fake.store.getPrompt(HH, THU, p.id))!.state, 'answered');
  const turn = (await fake.store.getTurn(HH, r.turn.id))!;
  assert.equal(turn.replyText, 'まだ');
  assert.ok(turn.expiresAt && turn.expiresAt.getTime() > now.getTime());
  const names = (await fake.store.listLedger(HH, THU)).map(e => e.name);
  for (const n of ['prompt_sent', 'reply_received', 'turn_classified', 'recheck_scheduled']) assert.ok(names.includes(n), n);
});

test('not_yet ×3: 2 回目で L2 info「まだのようです」、3 回目で escalated と L3 check（エージェントが check を重ねても 1 回）', async () => {
  const runner = new ScriptedRunner(input => {
    const s = byReply(input);
    const intents: Intent[] = [{ type: 'record', task: input.prompt.task, status: s.status, note: '' }];
    if (input.recheckAllowed) intents.push({ type: 'recheck', minutes: 15, reason: '' });
    else intents.push({ type: 'notify', level: 'check', reason: '着替えが確認できません', evidence: 'まだ' });
    return { status: s.status, intents };
  });
  const fake = await setup(runner);
  const p1 = await ask(fake, 'dress', '08:40');
  await processReply(fake.ctx, { hh: HH, promptId: p1.id, replyText: 'まだ', source: 'test', now: jstDate(THU, '08:41') });

  // Tasks から再確認
  const re = await handleRecheck(fake.ctx, { hh: HH, date: THU, task: 'dress', promptId: p1.id, now: jstDate(THU, '09:11') });
  assert.ok(re);
  assert.equal(re!.isRecheck, true);
  assert.equal(re!.text, 'そろそろお着替えどうですか？');
  // 同じ再確認がもう一度届いても二重に積まない
  const dup = await handleRecheck(fake.ctx, { hh: HH, date: THU, task: 'dress', promptId: p1.id, now: jstDate(THU, '09:11') });
  assert.equal(dup!.id, re!.id);

  const p2 = await nextPrompt(fake.ctx, HH, jstDate(THU, '09:11'));
  assert.equal(p2!.id, re!.id);
  const r2 = await processReply(fake.ctx, { hh: HH, promptId: p2!.id, replyText: 'まだよ', source: 'test', now: jstDate(THU, '09:12') });
  assert.equal(runner.inputs[1].recheckAllowed, true);   // 再確認は計 2 回まで
  assert.ok(r2.followUp);
  assert.deepEqual(r2.notices.map(n => n.level), ['info']);
  assert.equal(r2.notices[0].reason, '着替えがまだのようです');
  assert.match(r2.notices[0].evidence, /8:40「まだ」／9:11「まだよ」/);   // 2 回分の返事の抜粋
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.dress?.state, 'rechecking');

  await handleRecheck(fake.ctx, { hh: HH, date: THU, task: 'dress', now: jstDate(THU, '09:42') });
  const p3 = await nextPrompt(fake.ctx, HH, jstDate(THU, '09:42'));
  const r3 = await processReply(fake.ctx, { hh: HH, promptId: p3!.id, replyText: 'まだ', source: 'test', now: jstDate(THU, '09:43') });
  assert.equal(runner.inputs[2].recheckAllowed, false);
  assert.equal(r3.followUp, null);
  assert.equal(r3.say, 'わかりました。また後で声をかけますね。');   // 本人には家族に知らせたことを言わない
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.tasks.dress?.state, 'escalated');
  assert.equal(day.tasks.dress?.failCount, 3);
  const checks = fake.familyNotify.calls.filter(c => c.level === 'check');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].task, 'dress');
  assert.equal(checks[0].reason, '着替えを確認してください');
  assert.equal(checks[0].origin, 'not_done');
  assert.equal(checks[0].turnId, r3.turn.id);
  assert.equal(r3.notices.length, 1);
  assert.equal(fake.tasks.scheduled.length, 2);

  // escalated の後の再確認は何もしない
  assert.equal(await handleRecheck(fake.ctx, { hh: HH, date: THU, task: 'dress', now: jstDate(THU, '10:10') }), null);
});

test('urgent の notify が familyNotify に届き、signals.urgentCount が増える', async () => {
  const runner = new ScriptedRunner(input => ({
    status: 'done',
    intents: [
      { type: 'record', task: input.prompt.task, status: 'done', note: '' },
      { type: 'notify', level: 'urgent', reason: '痛みの訴え', evidence: '「腰が痛い」' },
    ],
  }));
  const fake = await setup(runner);
  const p = await ask(fake, 'water', '10:30');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: '腰が痛い', source: 'test', now: jstDate(THU, '10:31') });
  assert.equal(fake.familyNotify.calls.length, 1);
  assert.equal(fake.familyNotify.calls[0].level, 'urgent');
  assert.equal(fake.familyNotify.calls[0].turnId, r.turn.id);
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.signals.urgentCount, 1);
  // 至急の通知を作ったターンで L4 モードが立ち、一言は定型文
  assert.equal(day.l4?.noticeId, r.notices[0].id);
  assert.equal(r.say, L4_SAY);
});

test('blocked と承認の無い share_external は台帳に tool_blocked で残る。承認があれば tool_call', async () => {
  const runner = new ScriptedRunner(input => ({
    status: 'done',
    intents: [
      { type: 'record', task: input.prompt.task, status: 'done', note: '' },
      { type: 'blocked', tool: 'call_outside', args: { who: '息子' }, reason: 'never_allowed' },
      { type: 'share_external', recipient: 'doctor', summary: '今週の様子' },
    ],
  }));
  const fake = await setup(runner);
  const p = await ask(fake, 'lunch', '12:00');
  await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: '食べたよ。電話して', source: 'test', now: jstDate(THU, '12:01') });
  let ledger = await fake.store.listLedger(HH, THU);
  const blocked = ledger.filter(e => e.name === 'tool_blocked');
  assert.deepEqual(blocked.map(e => (e.args as { tool: string }).tool).sort(), ['call_outside', 'share_external']);
  assert.ok(blocked.every(e => e.kind === 'blocked'));

  await fake.store.putApproval({
    id: 'ap_1', hh: HH, kind: 'share_external', payload: {}, requestedAt: jstDate(THU, '07:00'),
    decidedAt: jstDate(THU, '07:30'), decidedBy: 'mem_1', decision: 'approved',
  });
  const p2 = await ask(fake, 'medicine', '19:40');
  await processReply(fake.ctx, { hh: HH, promptId: p2.id, replyText: '飲んだ', source: 'test', now: jstDate(THU, '19:41') });
  assert.equal(runner.inputs[1].familyApprovedShare, true);
  ledger = await fake.store.listLedger(HH, THU);
  const call = ledger.find(e => e.name === 'tool_call');
  assert.ok(call);
  assert.deepEqual(call!.result, { executed: true, recipient: 'doctor' });
});

test('signals: 無反応・判定不能・同じ質問の繰り返しが数えられる', async () => {
  const fake = await setup();
  const p1 = await ask(fake, 'water', '10:30');
  await processReply(fake.ctx, { hh: HH, promptId: p1.id, replyText: null, source: 'test', now: jstDate(THU, '10:31') });
  const p2 = await ask(fake, 'medicine', '19:40');
  await processReply(fake.ctx, { hh: HH, promptId: p2.id, replyText: '何の薬？', source: 'test', now: jstDate(THU, '19:41') });
  const p3 = await ask(fake, 'medicine', '19:45', true);
  await processReply(fake.ctx, { hh: HH, promptId: p3.id, replyText: '何の薬？', source: 'test', now: jstDate(THU, '19:46') });
  const s = (await fake.store.getDay(HH, THU))!.signals;
  assert.equal(s.noAnswerCount, 1);
  assert.equal(s.unclearCount, 2);
  assert.equal(s.repeatedQuestions, 1);
});

test('「1回のみ」の項目（水分）は再確認せず、家族へも上げない', async () => {
  const fake = await setup();
  const p = await ask(fake, 'water', '10:30');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: null, source: 'test', now: jstDate(THU, '10:31') });
  assert.equal(r.followUp, null);
  assert.equal(fake.tasks.scheduled.length, 0);
  assert.equal(fake.familyNotify.calls.length, 0);
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.water?.state, 'asked');
});

test('prompt が無ければ NotFoundError', async () => {
  const fake = await setup();
  await assert.rejects(
    processReply(fake.ctx, { hh: HH, promptId: 'pr_none', replyText: 'はい', source: 'test', now: jstDate(THU, '10:00') }),
    NotFoundError,
  );
});

test('killSwitch: 項目は suspended、再確認も通知もしない。nextPrompt は null', async () => {
  const fake = await setup();
  const p = await ask(fake, 'dress', '08:40');
  await fake.store.updateHousehold(HH, { killSwitch: true });
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: 'まだ', source: 'test', now: jstDate(THU, '08:41') });
  assert.equal(r.followUp, null);
  assert.equal(fake.tasks.scheduled.length, 0);
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.dress?.state, 'suspended');
  await enqueuePrompt(fake.ctx, HH, THU, 'water', { at: jstDate(THU, '10:30') });
  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '10:31')), null);
});

test('会話ターンが落ちたら unclear（返事なしなら no_answer）にして再確認へ。llm_error を記録', async () => {
  const broken: TurnRunner = { run: async () => { throw new Error('boom'); } };
  const fake = await setup(broken);
  const p = await ask(fake, 'dress', '08:40');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: 'うーん', source: 'test', now: jstDate(THU, '08:41') });
  assert.equal(r.turn.classified.status, 'unclear');
  assert.ok(r.followUp);
  const h = await fake.store.getHealth(HH, THU);
  assert.equal(h?.incidents.at(-1)?.kind, 'llm_error');
});

test('運用エージェントが llm=rules に切り替えている間は ctx.turnRunner を呼ばない', async () => {
  const runner = new ScriptedRunner(byReply);
  const fake = await setup(runner);
  await fake.store.putHealth({
    hh: HH, date: THU, lastHeartbeatAt: null, incidents: [],
    degraded: { llm: 'rules', until: jstDate(THU, '23:00') },
  });
  const p = await ask(fake, 'dinner', '19:00');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: '食べたよ', source: 'test', now: jstDate(THU, '19:01') });
  assert.equal(runner.inputs.length, 0);
  assert.equal(r.turn.classified.by, 'rules');
});

test('planDay → nextPrompt: 計画を積み、家族へ info、期限の来た先頭を delivered にして TTS を試す', async () => {
  const fake = await setup();
  const { prompts } = await planDay(fake.ctx, HH, THU, jstDate(THU, '06:00'));
  assert.equal(prompts.length, 11);
  assert.ok(prompts.every(p => p.state === 'queued'));
  assert.equal(fake.familyNotify.calls[0].reason, '今日の声かけ計画');
  // 二度目は作り直さない
  assert.equal((await planDay(fake.ctx, HH, THU, jstDate(THU, '06:05'))).prompts.length, 11);
  assert.equal(fake.familyNotify.calls.length, 1);

  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '07:59')), null);
  const p = await nextPrompt(fake.ctx, HH, jstDate(THU, '08:06'));
  assert.equal(p!.task, 'greeting');
  assert.equal(p!.state, 'delivered');
  assert.deepEqual(fake.tts.texts, ['おはようございます。よく眠れましたか？']);
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.greeting?.state, 'asked');
  // 次の取り出しで diaper。greeting は同じ項目ではないので delivered のまま
  const p2 = await nextPrompt(fake.ctx, HH, jstDate(THU, '08:06'));
  assert.equal(p2!.task, 'diaper');

  // 返事の無い声かけを締め切る（no_answer のターンとして処理）
  const n = await expireUnansweredPrompts(fake.ctx, HH, jstDate(THU, '08:20'), 10);
  assert.equal(n, 2);
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.tasks.greeting?.status, 'no_answer');
  assert.equal(day.signals.noAnswerCount, 2);
});

test('planDay が遅れて走ったら、30 分以上前の声かけは expired で作る', async () => {
  const fake = await setup();
  const { prompts } = await planDay(fake.ctx, HH, THU, jstDate(THU, '12:00'));
  assert.equal(prompts.find(p => p.task === 'greeting')!.state, 'expired');
  assert.equal(prompts.find(p => p.task === 'lunch')!.state, 'queued');
});

// ---------------------------------------------------------------------------
// criteria v2: 無反応の段階、L4 モード、就寝時間帯、痛みの聞き直し、確信度
// ---------------------------------------------------------------------------

test('no_answer ×3: 15 分ごとに再確認、2 回目で L3 check（家の電話）、3 回目で L4 urgent と L4 モード（本人への発話なし）', async () => {
  const fake = await setup();
  const p1 = await ask(fake, 'lunch', '12:00');
  const r1 = await processReply(fake.ctx, { hh: HH, promptId: p1.id, replyText: null, source: 'test', now: jstDate(THU, '12:05') });
  assert.equal(r1.followUp!.at.getTime(), jstDate(THU, '12:20').getTime());   // 返事なしは常に 15 分
  assert.equal(r1.notices.length, 0);
  const p2 = await ask(fake, 'lunch', '12:20', true);
  const r2 = await processReply(fake.ctx, { hh: HH, promptId: p2.id, replyText: null, source: 'test', now: jstDate(THU, '12:25') });
  assert.deepEqual(r2.notices.map(n => [n.level, n.origin]), [['check', 'no_answer']]);
  assert.match(r2.notices[0].reason, /^12:00 から 2 回の声かけに返事がありません/);
  assert.equal(r2.followUp!.at.getTime(), jstDate(THU, '12:40').getTime());
  const p3 = await ask(fake, 'lunch', '12:40', true);
  const r3 = await processReply(fake.ctx, { hh: HH, promptId: p3.id, replyText: null, source: 'test', now: jstDate(THU, '12:45') });
  assert.deepEqual(r3.notices.map(n => [n.level, n.origin]), [['urgent', 'no_answer']]);
  assert.equal(r3.say, '');
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.tasks.lunch?.state, 'escalated');
  assert.equal(day.l4?.noticeId, r3.notices[0].id);
  assert.equal(day.l4?.origin, 'no_answer');
  assert.ok((await fake.store.listLedger(HH, THU)).some(e => e.name === 'l4_started'));
});

test('L4 モード: 通常の声かけを止め、3 分ごとに安心文。返事は判定せず通知の根拠に追記。「確認した」で解除', async () => {
  const fake = await setup(new RulesTurnRunner());
  const p = await ask(fake, 'water', '10:30');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: '転んで動けないの', source: 'test', now: jstDate(THU, '10:31') });
  assert.equal(r.say, L4_SAY);
  const noticeId = r.notices.find(n => n.level === 'urgent')!.id;
  // L4 の間に期限が来た通常の声かけ
  await enqueuePrompt(fake.ctx, HH, THU, 'lunch', { at: jstDate(THU, '10:32') });

  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '10:33')), null);   // 3 分たっていない
  const a1 = await nextPrompt(fake.ctx, HH, jstDate(THU, '10:34'));
  assert.equal(a1!.isReassurance, true);
  assert.equal(a1!.text, REASSURANCE_SAY);
  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '10:36')), null);
  const a2 = await nextPrompt(fake.ctx, HH, jstDate(THU, '10:37'));
  assert.equal(a2!.isReassurance, true);
  assert.notEqual(a2!.id, a1!.id);
  // 安心文は状態機械を動かさない
  assert.equal((await fake.store.getDay(HH, THU))!.tasks.lunch?.state, 'pending');

  // L4 中の返事: LLM（TurnRunner）を呼ばず、安心文を返し、通知の根拠に追記
  const rr = await processReply(fake.ctx, { hh: HH, promptId: a2!.id, replyText: '痛くて立てない', source: 'test', now: jstDate(THU, '10:38') });
  assert.equal(rr.say, REASSURANCE_SAY);
  assert.equal(rr.notices.length, 0);
  assert.equal(rr.turn.kind, 'l4');
  const n = (await fake.store.getNotice(HH, noticeId))!;
  assert.match(n.evidence, /10:38「痛くて立てない」/);
  assert.ok((await fake.store.listLedger(HH, THU)).some(e => e.name === 'reply_received' && (e.args as { l4?: boolean }).l4 === true));

  // 停止中は安心文も出さない
  await fake.store.updateHousehold(HH, { killSwitch: true });
  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '10:45')), null);
  await fake.store.updateHousehold(HH, { killSwitch: false });

  // 「確認した」で解除。L4 の間に期限が来た声かけは話さずに expired
  await fake.familyNotify.ack(HH, noticeId, 'mem_1', jstDate(THU, '10:50'));
  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '10:51')), null);
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.l4, null);
  assert.ok((await fake.store.listLedger(HH, THU)).some(e => e.name === 'l4_cleared'));
  assert.equal((await fake.store.listPrompts(HH, THU)).find(x => x.task === 'lunch')!.state, 'expired');
  // 通常に戻る
  await enqueuePrompt(fake.ctx, HH, THU, 'water', { at: jstDate(THU, '11:00') });
  assert.equal((await nextPrompt(fake.ctx, HH, jstDate(THU, '11:00')))!.task, 'water');
});

test('就寝時間帯: 計画に声かけを作らず、nextPrompt は通常の声かけを出さない。無反応判定の対象外', async () => {
  const fake = await setup();
  const h = (await fake.store.getHousehold(HH))!;
  const plan = { ...h.plan, weekday: { ...h.plan.weekday, default: [...h.plan.weekday.default, { time: '22:00', task: 'bedtime' as const }] } };
  await fake.store.updateHousehold(HH, { plan });
  const store2 = fake.store;
  await store2.putDay({ ...(await store2.getDay(HH, THU))!, plan: [...(await store2.getDay(HH, THU))!.plan, { time: '22:00', task: 'bedtime' }] });
  const { prompts } = await planDay(fake.ctx, HH, THU, jstDate(THU, '06:00'));
  assert.ok(!prompts.some(p => p.task === 'bedtime' && p.scheduledAt.getTime() === jstDate(THU, '22:00').getTime()));

  // 21:20 の再確認が残っていても、21:30 以降は話さない
  const late = await enqueuePrompt(fake.ctx, HH, THU, 'bedtime', { at: jstDate(THU, '21:25'), isRecheck: false });
  assert.equal(await nextPrompt(fake.ctx, HH, jstDate(THU, '21:40')), null);
  assert.equal((await fake.store.getPrompt(HH, THU, late.id))!.state, 'expired');

  // 21:20 に話して返事が無いまま就寝時間帯に入った声かけは、返事なしとして扱わない
  const p = await ask(fake, 'medicine', '21:20');
  const n = await expireUnansweredPrompts(fake.ctx, HH, jstDate(THU, '21:45'), 10);
  assert.equal(n, 0);
  assert.equal((await fake.store.getPrompt(HH, THU, p.id))!.state, 'expired');
  assert.equal((await fake.store.getDay(HH, THU))!.signals.noAnswerCount, 0);
  // 再確認の予約も就寝時間帯なら積まない
  assert.equal(await handleRecheck(fake.ctx, { hh: HH, date: THU, task: 'medicine', now: jstDate(THU, '22:00') }), null);
});

test('痛み: L3 check と 3 時間後の聞き直しを積む。聞き直しに「まだ痛い」なら L3 を再送、状態機械は動かさない', async () => {
  const fake = await setup(new RulesTurnRunner());
  const p = await ask(fake, 'water', '10:30');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: 'ありがとう。でも腰が痛いの', source: 'test', now: jstDate(THU, '10:31') });
  assert.deepEqual(r.notices.map(n => [n.level, n.origin]), [['check', 'pain']]);
  assert.equal((await fake.store.getDay(HH, THU))!.l4 ?? null, null);
  const follow = (await fake.store.listPrompts(HH, THU)).find(x => x.followup);
  assert.ok(follow);
  assert.equal(follow!.scheduledAt.getTime(), jstDate(THU, '13:31').getTime());
  assert.equal(follow!.followup!.noticeId, r.notices[0].id);
  assert.match(follow!.text, /腰が痛いとおっしゃっていましたが、今はどうですか/);

  const waterBefore = (await fake.store.getDay(HH, THU))!.tasks.water;
  const d = await nextPrompt(fake.ctx, HH, jstDate(THU, '13:31'));
  assert.equal(d!.id, follow!.id);
  const fr = await processReply(fake.ctx, { hh: HH, promptId: d!.id, replyText: 'まだ腰が痛い', source: 'test', now: jstDate(THU, '13:32') });
  assert.equal(fr.turn.kind, 'followup');
  assert.equal(fr.turn.followupNoticeId, r.notices[0].id);
  assert.deepEqual(fr.notices.map(n => [n.level, n.origin]), [['check', 'pain_followup']]);
  assert.deepEqual((await fake.store.getDay(HH, THU))!.tasks.water, waterBefore);

  // 聞き直しに「動けない」なら L4
  const fake2 = await setup(new RulesTurnRunner());
  const q = await ask(fake2, 'water', '10:30');
  await processReply(fake2.ctx, { hh: HH, promptId: q.id, replyText: '膝が痛い', source: 'test', now: jstDate(THU, '10:31') });
  const f2 = await nextPrompt(fake2.ctx, HH, jstDate(THU, '13:31'));
  const fr2 = await processReply(fake2.ctx, { hh: HH, promptId: f2!.id, replyText: 'もう動けない', source: 'test', now: jstDate(THU, '13:32') });
  assert.equal(fr2.notices[0].level, 'urgent');
  assert.equal(fr2.say, L4_SAY);
  assert.ok((await fake2.store.getDay(HH, THU))!.l4);
});

test('判定未確定（確信度 < 0.7）でも check は即時に送り、uncertain を付ける', async () => {
  const runner: TurnRunner = {
    async run(input) {
      return {
        classified: { status: 'done', note: '', by: 'llm', confidence: 0.5, uncertain: true }, say: 'はい', expression: 'smile', toolCalls: [], latencyMs: 0,
        intents: [
          { type: 'record', task: input.prompt.task, status: 'done', note: '', confidence: 0.5 },
          { type: 'notify', level: 'check', reason: '腰が痛いとおっしゃいました。', evidence: '腰が…', origin: 'pain' },
        ],
      };
    },
  };
  const fake = await setup(runner);
  const p = await ask(fake, 'water', '10:30');
  const r = await processReply(fake.ctx, { hh: HH, promptId: p.id, replyText: '腰が…かな', source: 'test', now: jstDate(THU, '10:31') });
  assert.equal(r.turn.classified.uncertain, true);
  assert.equal(r.turn.classified.confidence, 0.5);
  assert.equal(fake.familyNotify.calls[0].uncertain, true);
});
