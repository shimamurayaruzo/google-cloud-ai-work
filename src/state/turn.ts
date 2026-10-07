// 会話ターンの中核。本人の返事 1 回を TurnRunner（ADK か規則）に渡し、返ってきた「やりたいこと」（Intent）を
// 状態機械・予約・通知・台帳に落とす。副作用はすべてここで起きる（TurnRunner は決めるだけ）。
//
// criteria v2 の反映:
//  - 段階表（state/machine.ts）が決めた通知（L2 info／L3 check／L4 urgent）をここで送る
//  - 至急の通知（L4 の語、3 回続けて返事なし）を作ったターンで L4 モード（day.l4）を立てる（state/l4.ts）
//  - L4 モード中の返事は LLM を呼ばず、台帳と通知の根拠に追記するだけ（質問しない。一言は安心文）
//  - 痛みの言葉は 3 時間後の聞き直し（followup）を予約する。聞き直しへの返事は規則で扱う

import { logError, logEvent } from '../log.js';
import type { AppContext, Intent, NotifyRequest, TurnInput, TurnOutcome } from '../services.js';
import { addMinutes, dateKey, hhmm, hm, shiftDateKey } from '../time.js';
import {
  newId, TASK_LABELS, type Classification, type DateKey, type Day, type Expression, type Household, type HouseholdId,
  type Notice, type Prompt, type PromptId, type ReplySource, type TaskKey, type TaskRecord, type Turn,
} from '../types.js';
import { ensureDay, enqueuePrompt } from './day.js';
import { NotFoundError } from './errors.js';
import {
  L4_SAY, REASSURANCE_SAY, RulesTurnRunner, analyzeReply, excerpt as ruleExcerpt, isLikelyNotPerson, l4Reason,
} from '../agent/rules.js';
import { currentDegraded, recordIncident } from '../ops/health.js';
import { appendLedger, excerpt } from './ledger.js';
import { currentL4, startL4 } from './l4.js';
import { canRecheck, transition, type StageNotice } from './machine.js';
import { defaultPromptText, findPlanItem, inSleepHours, recheckIntervalMinutes } from './plan.js';

export { NotFoundError };

/** replyText の保存期間（Firestore の TTL で消す） */
const TURN_TTL_MINUTES = 7 * 24 * 60;
/** 「同じ質問の繰り返し」を数える窓 */
const REPEAT_WINDOW_MINUTES = 30;
/** 要約に引用する本人の言葉の長さ */
const EVIDENCE_MAX = 30;
/** L4 中の返事を通知の根拠に追記するときの全体の上限 */
const L4_EVIDENCE_MAX = 300;
/** 最後の声かけ（n=3）で取れなかったときの一言（criteria 3-1。家族に知らせたことは言わない） */
const FINAL_SAY = 'わかりました。また後で声をかけますね。';

export interface ProcessReplyArgs {
  hh: HouseholdId;
  promptId: PromptId;
  replyText: string | null;
  source: ReplySource;
  now: Date;
  /** 声かけの日付。省略時は now の日付（見つからなければ前日も探す。日付をまたいだ返事のため） */
  date?: DateKey;
}

export interface ProcessReplyResult {
  turn: Turn;
  followUp: { at: Date; task: TaskKey } | null;
  say: string;
  expression: Expression;
  /** TurnRunner が決めた Intent（再生モードの表示用） */
  intents: Intent[];
  /** このターンで作った通知 */
  notices: Notice[];
}

/** 返事 1 回の処理（POST /api/device/reply、再生モード、返事の無い声かけの締め切り） */
export async function processReply(ctx: AppContext, args: ProcessReplyArgs): Promise<ProcessReplyResult> {
  const { hh, promptId, replyText, source, now } = args;
  const household = await ctx.store.getHousehold(hh);
  if (!household) throw new NotFoundError(`household not found: ${hh}`);

  const prompt = await findPrompt(ctx, hh, promptId, args.date ?? dateKey(now), args.date === undefined);
  if (!prompt) throw new NotFoundError(`prompt not found: ${promptId}`);
  const date = prompt.date;
  const task = prompt.task;

  const day = await ensureDay(ctx, hh, date);

  // ---- L4 モード中: 判定しない。返事は記録と通知の根拠への追記だけ ----
  if (!household.killSwitch) {
    const noticeId = day.l4?.noticeId;
    const l4 = await currentL4(ctx, hh, date, day, now);
    if (l4) return processL4Reply(ctx, { prompt, replyText, source, now, noticeId: l4.noticeId });
    day.l4 = null;
    // 解除の後に届いた安心文への返事も判定しない（確認項目の返事ではないため）
    if (prompt.isReassurance) return processL4Reply(ctx, { prompt, replyText, source, now, noticeId });
  }
  // ---- 痛みの聞き直しへの返事: 規則で扱い、状態機械は動かさない ----
  if (prompt.followup && !household.killSwitch) {
    return processFollowupReply(ctx, { household, day, prompt, replyText, source, now });
  }

  const item = findPlanItem(day.plan, task, prompt.scheduledAt);
  const recheckAllowed = !household.killSwitch && canRecheck(household, day.tasks[task]) && item?.recheckMinutes !== 0;
  const approvals = await ctx.store.listApprovals(hh);
  const familyApprovedShare = approvals.some(a =>
    a.kind === 'share_external' && a.decision === 'approved' && a.decidedAt != null && dateKey(a.decidedAt) === date);
  const todayTurns = await ctx.store.listTurns(hh, date);
  const recentTurns = todayTurns.slice(-5).map(t => ({
    task: t.task, replyText: t.replyText, status: t.classified.status, at: t.repliedAt,
  }));

  const input: TurnInput = {
    household, day, prompt, replyText, source, now, recheckAllowed, familyApprovedShare, recentTurns,
  };
  // 運用エージェントが LLM を規則へ切り替えている間は、規則だけで分類する（docs/02 §7）
  const degraded = currentDegraded(await ctx.store.getHealth(hh, dateKey(now)), now);
  const runner = degraded?.llm === 'rules' ? rulesRunner() : ctx.turnRunner;
  let outcome: TurnOutcome;
  try {
    outcome = await runner.run(input);
  } catch (error) {
    // 会話ターンが落ちても本人を待たせない。判定せず unclear にして再確認へ（docs/02 §7）
    logError('turn_runner_failed', error, { hh, date, task });
    outcome = fallbackOutcome(input, error);
  }

  const turnId = newId('tn');
  const turn: Turn = {
    id: turnId, hh, date, promptId, task,
    promptedAt: prompt.deliveredAt ?? prompt.scheduledAt,
    promptText: prompt.text,
    replyText,
    replySource: source,
    repliedAt: now,
    classified: cleanClassified(outcome.classified),
    toolCalls: outcome.toolCalls,
    say: outcome.say,
    expression: outcome.expression,
    latencyMs: outcome.latencyMs,
    expiresAt: addMinutes(now, TURN_TTL_MINUTES),
  };
  // 通知の引用先として先に保存しておく
  await ctx.store.putTurn(turn);
  await ctx.store.updatePrompt(hh, date, promptId, { state: 'answered' });

  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'reply_received', turnId,
    args: { promptId, task, source, reply: excerpt(replyText) },
  });

  const applied = await applyIntents(ctx, {
    household, day, prompt, item, turnId, replyText, outcome, now, recheckAllowed, familyApprovedShare, todayTurns,
  });

  // L4 を立てたターン・最後の声かけで取れなかったターンは、一言を決まった文にする
  let say = outcome.say;
  let expression = outcome.expression;
  if (applied.l4Started) {
    // L4 の語なら定型文を 1 回。返事が無くて L4 になったときは本人への発話なし（以後は 3 分ごとの安心文）
    say = applied.l4Started === 'no_answer' ? '' : L4_SAY;
    expression = 'worry';
  } else if (applied.finalStage) {
    say = FINAL_SAY;
  }
  if (say !== turn.say || expression !== turn.expression) {
    turn.say = say;
    turn.expression = expression;
    await ctx.store.putTurn(turn);
  }

  // ---- 変化評価の元データ ----
  const signals = { ...day.signals };
  const status = outcome.classified.status;
  if (status === 'unclear') signals.unclearCount += 1;
  if (status === 'no_answer') signals.noAnswerCount += 1;
  signals.urgentCount += applied.notices.filter(n => n.level === 'urgent').length;
  if (isRepeatedQuestion(replyText, todayTurns, now)) signals.repeatedQuestions += 1;
  await ctx.store.updateDay(hh, date, { signals });

  await appendLedger(ctx, {
    hh, date, at: now, kind: 'tool_result', name: 'turn_classified', turnId,
    args: { task, promptId },
    result: {
      status, note: outcome.classified.note, by: outcome.classified.by,
      confidence: outcome.classified.confidence ?? null, uncertain: outcome.classified.uncertain ?? false,
      degraded: outcome.degraded?.reason ?? null, taskState: applied.taskState, stage: applied.stage ?? null,
    },
  });
  if (outcome.degraded) {
    await recordIncident(ctx.store, hh, 'llm_error', 'fallback', outcome.degraded.reason, now);
  }
  logEvent('turn_classified', {
    hh, date, task, turnId, status, by: outcome.classified.by, uncertain: outcome.classified.uncertain ?? false,
    degraded: outcome.degraded?.reason ?? null, reply: excerpt(replyText), latencyMs: outcome.latencyMs,
    followUp: applied.followUp ? applied.followUp.at.toISOString() : null, stage: applied.stage ?? null,
  });

  return {
    turn,
    followUp: applied.followUp,
    say,
    expression,
    intents: outcome.intents,
    notices: applied.notices,
  };
}

/** Turn.classified に undefined を入れない（Firestore に undefined を書かない） */
function cleanClassified(c: TurnOutcome['classified']): Turn['classified'] {
  const out: Turn['classified'] = { status: c.status, note: c.note, by: c.by };
  if (typeof c.confidence === 'number') out.confidence = c.confidence;
  if (typeof c.uncertain === 'boolean') out.uncertain = c.uncertain;
  return out;
}

// ---------------------------------------------------------------------------
// Intent の適用
// ---------------------------------------------------------------------------

interface ApplyArgs {
  household: Household;
  day: Day;
  prompt: Prompt;
  item: ReturnType<typeof findPlanItem>;
  turnId: string;
  replyText: string | null;
  outcome: TurnOutcome;
  now: Date;
  recheckAllowed: boolean;
  familyApprovedShare: boolean;
  todayTurns: Turn[];
}

interface ApplyResult {
  followUp: { at: Date; task: TaskKey } | null;
  notices: Notice[];
  taskState: TaskRecord['state'] | undefined;
  /** 段階表の通知の段階（あれば） */
  stage?: StageNotice['stage'];
  /** 最後の声かけで取れず、L4 以外の通知で終えた */
  finalStage?: boolean;
  /** L4 を立てた由来（l4_words / fire / no_answer） */
  l4Started?: string;
}

async function applyIntents(ctx: AppContext, a: ApplyArgs): Promise<ApplyResult> {
  const { household, day, prompt, turnId, outcome, now } = a;
  const { hh, date, task } = prompt;
  const tasks: Day['tasks'] = { ...day.tasks };
  const notices: Notice[] = [];
  let followUp: { at: Date; task: TaskKey } | null = null;
  const uncertain = outcome.classified.uncertain === true;

  // ---- 止めている間: 状態は suspended、道具は動かさない（blocked の記録だけ残す） ----
  if (household.killSwitch) {
    const { next } = transition(tasks[task], { type: 'suspend', at: now });
    await ctx.store.setTask(hh, date, task, next);
    for (const i of outcome.intents) {
      if (i.type === 'blocked') await ledgerBlocked(ctx, hh, date, now, turnId, i.tool, i.args, i.reason);
    }
    return { followUp: null, notices, taskState: next.state };
  }

  const notifyIntents = outcome.intents.filter((i): i is Extract<Intent, { type: 'notify' }> => i.type === 'notify');
  // L4 の語・痛みを訴えたターンは、同じ確認を繰り返さず段階表の通知も重ねない（その通知を優先する）
  const alerted = notifyIntents.some(i => i.level === 'urgent' || i.origin === 'pain');

  // ---- record: 先に全部適用する（再確認・通知はその結果を見る） ----
  const records = outcome.intents.filter((i): i is Extract<Intent, { type: 'record' }> => i.type === 'record');
  if (!records.some(r => r.task === task)) {
    records.unshift({ type: 'record', task, status: outcome.classified.status, note: outcome.classified.note });
  }
  const before = tasks[task];
  let stage: StageNotice | undefined;
  let finalStage = false;
  for (const r of records) {
    const isPromptTask = r.task === task;
    // 声かけとは別の項目は「済んだ」と言われたときだけ反映する（例: 洗顔を聞いたら「もう着替えたよ」）
    if (!isPromptTask && r.status !== 'done') continue;
    const item = findPlanItem(day.plan, r.task, prompt.scheduledAt);
    const result = transition(tasks[r.task], {
      type: 'classified',
      status: r.status,
      at: now,
      evidence: a.replyText ? excerpt(a.replyText, EVIDENCE_MAX) ?? undefined : undefined,
      turnId,
      recheckAllowed: isPromptTask ? a.recheckAllowed && !alerted : false,
      escalateAllowed: item?.escalate !== false && !alerted,
      oneShot: isPromptTask && item?.recheckMinutes === 0,
      promptedAt: prompt.deliveredAt ?? prompt.scheduledAt,
      task: r.task,
    });
    tasks[r.task] = result.next;
    await ctx.store.setTask(hh, date, r.task, result.next);
    if (isPromptTask && result.notify) {
      stage = result.notify;
      finalStage = Boolean(result.final) && result.notify.level !== 'urgent';
      const n = await safeNotify(ctx, {
        hh, date, level: result.notify.level, reason: result.notify.reason, origin: result.notify.origin,
        evidence: stageEvidence(a.todayTurns, result.next, prompt, a.replyText, r.status, now),
        turnId, task: r.task, now, ...(uncertain ? { uncertain } : {}),
      });
      if (n) notices.push(n);
    }
  }

  // ---- 再確認: この声かけの項目が今のターンで rechecking に入ったときだけ予約する ----
  // 時刻は状態機械側が決める（返事なしは 15 分、予定の無い日のまだは 30 分、デイの日はお迎えから逆算）。
  // criteria v2 の間隔を守るため、エージェントの minutes は台帳に残すだけで使わない
  const after = tasks[task];
  const recheckIntent = outcome.intents.find((i): i is Extract<Intent, { type: 'recheck' }> => i.type === 'recheck');
  const enteredRecheck = after?.state === 'rechecking' && (after.recheckCount > (before?.recheckCount ?? 0));
  if (enteredRecheck) {
    const status = after.status ?? outcome.classified.status;
    const planned = recheckIntervalMinutes(household, a.item, task, status, day.isDayservice, now);
    const minutes = planned;
    const runAt = addMinutes(now, minutes);
    try {
      await ctx.tasks.schedule('/internal/recheck', { hh, date, task, promptId: prompt.id }, runAt);
      followUp = { at: runAt, task };
      await appendLedger(ctx, {
        hh, date, at: now, kind: 'tool_call', name: 'recheck_scheduled', turnId,
        args: { task, minutes, requestedMinutes: recheckIntent?.minutes ?? null, reason: recheckIntent?.reason ?? 'state_machine' },
        result: { runAt },
      });
      logEvent('recheck_scheduled', { hh, date, task, minutes });
    } catch (error) {
      logError('recheck_schedule_failed', error, { hh, date, task });
    }
  } else if (recheckIntent) {
    await ledgerBlocked(ctx, hh, date, now, turnId, 'schedule_recheck', { minutes: recheckIntent.minutes },
      after?.state === 'done' ? 'already_done' : 'recheck_not_allowed');
  }

  // ---- 通知・外部共有・止めた道具（エージェントが出した順） ----
  let painNotice: Notice | null = null;
  for (const i of outcome.intents) {
    if (i.type === 'notify') {
      // 段階表が既に家族へ知らせたターンは、同じ趣旨（取れない）の check / info を重ねない
      if (stage && i.level !== 'urgent' && (!i.origin || i.origin === 'other' || i.origin === 'not_done')) continue;
      const n = await safeNotify(ctx, {
        hh, date, level: i.level, reason: i.reason, evidence: i.evidence, turnId, task, now,
        ...(i.origin ? { origin: i.origin } : {}), ...(uncertain ? { uncertain } : {}),
      });
      if (n) {
        notices.push(n);
        if (i.origin === 'pain') painNotice = n;
      }
    } else if (i.type === 'share_external') {
      if (!a.familyApprovedShare) {
        await ledgerBlocked(ctx, hh, date, now, turnId, 'share_external', { recipient: i.recipient }, 'no_family_approval');
        continue;
      }
      // 医師・ケアマネへの実際の送信は提出版の範囲外。家族の承認のもとで「実行した」記録だけ残す
      await appendLedger(ctx, {
        hh, date, at: now, kind: 'tool_call', name: 'tool_call', turnId,
        args: { name: 'share_external', recipient: i.recipient, summary: excerpt(i.summary, 80) },
        result: { executed: true, recipient: i.recipient },
      });
      logEvent('tool_call', { hh, date, name: 'share_external', recipient: i.recipient, turnId });
    } else if (i.type === 'blocked') {
      await ledgerBlocked(ctx, hh, date, now, turnId, i.tool, i.args, i.reason);
    }
  }

  // ---- 聞き直しの予約（痛みの 3 時間後。回数制限の対象外） ----
  for (const i of outcome.intents) {
    if (i.type !== 'followup') continue;
    await scheduleFollowup(ctx, household, { hh, date, now, turnId, intent: i, noticeId: painNotice?.id });
  }

  // ---- L4 モード: 至急の通知を作ったターンで立てる ----
  let l4Started: string | undefined;
  const urgentNotice = notices.find(n => n.level === 'urgent');
  if (urgentNotice) {
    const l4 = await startL4(ctx, hh, date, day, urgentNotice, task, now);
    if (l4) l4Started = urgentNotice.origin ?? 'l4_words';
  }

  return {
    followUp, notices, taskState: tasks[task]?.state,
    ...(stage ? { stage: stage.stage } : {}),
    ...(finalStage ? { finalStage } : {}),
    ...(l4Started ? { l4Started } : {}),
  };
}

async function scheduleFollowup(
  ctx: AppContext,
  household: Household,
  a: { hh: HouseholdId; date: DateKey; now: Date; turnId: string; intent: Extract<Intent, { type: 'followup' }>; noticeId?: string },
): Promise<void> {
  const { hh, date, now, turnId, intent } = a;
  const runAt = addMinutes(now, Math.max(1, Math.round(intent.minutes)));
  // 就寝時間帯・日付をまたぐときは聞き直さない（夕方の要約には痛みの記録が載る）
  if (inSleepHours(household, runAt) || dateKey(runAt) !== date) {
    await appendLedger(ctx, {
      hh, date, at: now, kind: 'tool_call', name: 'followup_skipped', turnId, noticeId: a.noticeId ?? null,
      args: { task: intent.task, minutes: intent.minutes, reason: intent.reason }, result: { why: 'sleep_hours_or_next_day' },
    });
    return;
  }
  const p = await enqueuePrompt(ctx, hh, date, intent.task, { at: runAt, text: intent.text });
  const followup = { reason: intent.reason, ...(a.noticeId ? { noticeId: a.noticeId } : {}) };
  await ctx.store.updatePrompt(hh, date, p.id, { followup });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'tool_call', name: 'followup_scheduled', turnId, noticeId: a.noticeId ?? null,
    args: { task: intent.task, minutes: intent.minutes, reason: intent.reason, promptId: p.id }, result: { runAt },
  });
  logEvent('followup_scheduled', { hh, date, task: intent.task, at: hhmm(runAt) });
}

async function safeNotify(ctx: AppContext, req: NotifyRequest): Promise<Notice | null> {
  try {
    return await ctx.familyNotify.notify(req);
  } catch (error) {
    // notify_error の incident は notify/ 側が書く。ここではログだけ残して会話を続ける
    logError('family_notify_failed', error, { hh: req.hh, level: req.level });
    return null;
  }
}

async function ledgerBlocked(
  ctx: AppContext, hh: HouseholdId, date: DateKey, now: Date, turnId: string,
  tool: string, args: Record<string, unknown>, reason: string,
): Promise<void> {
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'blocked', name: 'tool_blocked', turnId, args: { tool, args }, result: { reason },
  });
  logEvent('tool_blocked', { hh, date, tool, reason, turnId });
}

/**
 * 段階表の通知の根拠: この一巡で取れなかった返事の抜粋を時刻つきで並べる（criteria 3-1「2 回分の返答原文」）。
 * 例「8:35「まだ」／8:45「まだよ」」「9:00 返事なし／9:15 返事なし」
 */
function stageEvidence(
  todayTurns: Turn[], record: TaskRecord, prompt: Prompt, replyText: string | null, status: Classification, now: Date,
): string {
  const n = Math.max(1, record.failCount ?? 1);
  const promptIds = new Set(record.promptIds);
  const prev = todayTurns
    .filter(t => t.task === prompt.task && promptIds.has(t.promptId) && t.id !== record.lastTurnId && t.classified.status !== 'done' && t.kind !== 'l4' && t.kind !== 'followup')
    .slice(-(n - 1));
  // 本人以外の声・音の可能性が高いものは原文を家族に送らない（criteria 2）
  const one = (at: Date, text: string | null, st: Classification) =>
    text && !isLikelyNotPerson(text) ? `${hm(at)}「${excerpt(text, 20)}」`
      : st === 'no_answer' ? `${hm(at)} 返事なし`
      : text ? `${hm(at)} 本人の声か分からない音` : `${hm(at)} 返事が確認できず`;
  const items = n > 1 ? prev.map(t => one(t.promptedAt ?? t.repliedAt, t.replyText, t.classified.status)) : [];
  items.push(one(prompt.deliveredAt ?? now, replyText, status));
  return `${TASK_LABELS[prompt.task]}: ${items.join('／')}`;
}

// ---------------------------------------------------------------------------
// L4 モード中の返事（判定しない）
// ---------------------------------------------------------------------------

async function processL4Reply(
  ctx: AppContext,
  a: { prompt: Prompt; replyText: string | null; source: ReplySource; now: Date; noticeId?: string },
): Promise<ProcessReplyResult> {
  const { prompt, replyText, source, now } = a;
  const { hh, date, task } = prompt;
  const turnId = newId('tn');
  const turn: Turn = {
    id: turnId, hh, date, promptId: prompt.id, task,
    promptedAt: prompt.deliveredAt ?? prompt.scheduledAt,
    promptText: prompt.text,
    replyText,
    replySource: source,
    repliedAt: now,
    classified: { status: replyText == null ? 'no_answer' : 'unclear', note: 'L4 の間の返事（判定しない）', by: 'rules' },
    kind: 'l4',
    toolCalls: [],
    say: REASSURANCE_SAY,
    expression: 'worry',
    latencyMs: 0,
    expiresAt: addMinutes(now, TURN_TTL_MINUTES),
  };
  await ctx.store.putTurn(turn);
  await ctx.store.updatePrompt(hh, date, prompt.id, { state: replyText == null ? 'expired' : 'answered' });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'reply_received', turnId, noticeId: a.noticeId ?? null,
    args: { promptId: prompt.id, task, source, reply: excerpt(replyText), l4: true },
  });
  // 返事として確認できた言葉と時刻を通知の根拠に追記する（report-design 2 節 L4）
  if (a.noticeId && replyText && !isLikelyNotPerson(replyText)) {
    const n = await ctx.store.getNotice(hh, a.noticeId);
    if (n) {
      const add = `${hm(now)}「${ruleExcerpt(replyText, 30)}」`;
      const evidence = Array.from(n.evidence ? `${n.evidence}／${add}` : add).slice(0, L4_EVIDENCE_MAX).join('');
      await ctx.store.updateNotice(hh, a.noticeId, { evidence });
    }
  }
  logEvent('l4_reply', { hh, date, noticeId: a.noticeId, noAnswer: replyText == null, reply: excerpt(replyText) });
  return { turn, followUp: null, say: REASSURANCE_SAY, expression: 'worry', intents: [], notices: [] };
}

// ---------------------------------------------------------------------------
// 痛みの聞き直しへの返事（criteria 3-2: まだ痛い → L3 を再送、動けない → L4、返事なし → L3 を再送）
// ---------------------------------------------------------------------------

async function processFollowupReply(
  ctx: AppContext,
  a: { household: Household; day: Day; prompt: Prompt; replyText: string | null; source: ReplySource; now: Date },
): Promise<ProcessReplyResult> {
  const { household, day, prompt, replyText, source, now } = a;
  const { hh, date, task } = prompt;
  const analysis = analyzeReply(task, replyText, household);
  const noise = analysis.status === 'unclear' && /本人の発話か分からない/.test(analysis.note);
  let status: Classification;
  let note: string;
  let say: string;
  let expression: Expression = 'listen';
  let notify: Omit<NotifyRequest, 'hh' | 'date' | 'turnId' | 'now'> | null = null;
  if (replyText == null) {
    status = 'no_answer'; note = '聞き直しに返事なし'; say = '';
    notify = { level: 'check', origin: 'pain_followup', task, reason: '痛みの聞き直しに、お返事がありませんでした', evidence: `${hm(now)} 返事なし` };
  } else if (noise) {
    status = 'unclear'; note = analysis.note; say = 'また後で声をかけますね。'; expression = 'think';
  } else if (analysis.l4) {
    status = 'not_yet'; note = `聞き直し「${ruleExcerpt(replyText, 16)}」`; say = L4_SAY; expression = 'worry';
    notify = { level: 'urgent', origin: analysis.l4.group === 'fire' ? 'fire' : 'l4_words', task, reason: l4Reason(analysis.l4), evidence: ruleExcerpt(replyText, 40) };
  } else if (analysis.pain) {
    status = 'not_yet'; note = `聞き直し「${ruleExcerpt(replyText, 16)}」`; say = 'それはつらいですね。無理をしないでくださいね。'; expression = 'worry';
    notify = {
      level: 'check', origin: 'pain_followup', task,
      reason: `聞き直したところ、まだ${analysis.pain.part ? `${analysis.pain.part}が` : ''}痛いとおっしゃいました。どの程度か、動けるかは分かりません。`,
      evidence: ruleExcerpt(replyText, 40),
    };
  } else {
    status = 'done'; note = `聞き直し「${ruleExcerpt(replyText, 16)}」`; say = 'よかったです。無理をしないでくださいね。'; expression = 'smile';
  }

  const turnId = newId('tn');
  const turn: Turn = {
    id: turnId, hh, date, promptId: prompt.id, task,
    promptedAt: prompt.deliveredAt ?? prompt.scheduledAt,
    promptText: prompt.text,
    replyText,
    replySource: source,
    repliedAt: now,
    classified: { status, note, by: 'rules', confidence: status === 'unclear' ? 0.5 : 1.0, uncertain: status === 'unclear' },
    kind: 'followup',
    ...(prompt.followup?.noticeId ? { followupNoticeId: prompt.followup.noticeId } : {}),
    toolCalls: [],
    say,
    expression,
    latencyMs: 0,
    expiresAt: addMinutes(now, TURN_TTL_MINUTES),
  };
  await ctx.store.putTurn(turn);
  await ctx.store.updatePrompt(hh, date, prompt.id, { state: 'answered' });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'reply_received', turnId,
    args: { promptId: prompt.id, task, source, reply: excerpt(replyText), followup: true },
  });

  const notices: Notice[] = [];
  let l4Started = false;
  if (notify) {
    const n = await safeNotify(ctx, { hh, date, turnId, now, ...notify });
    if (n) {
      notices.push(n);
      if (n.level === 'urgent') l4Started = Boolean(await startL4(ctx, hh, date, day, n, task, now));
    }
  }
  if (status === 'no_answer' || l4Started) {
    const signals = { ...day.signals };
    if (status === 'no_answer') signals.noAnswerCount += 1;
    if (l4Started) signals.urgentCount += 1;
    await ctx.store.updateDay(hh, date, { signals });
  }
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'tool_result', name: 'turn_classified', turnId,
    args: { task, promptId: prompt.id, followup: true }, result: { status, note, by: 'rules' },
  });
  logEvent('turn_classified', { hh, date, task, turnId, status, by: 'rules', followup: true, reply: excerpt(replyText) });
  return { turn, followUp: null, say, expression, intents: [], notices };
}

// ---------------------------------------------------------------------------
// 再確認（Tasks から /internal/recheck）
// ---------------------------------------------------------------------------

/**
 * 予約した再確認の時刻が来た。その項目がまだ rechecking なら、別の言い回しで声かけを積む。
 * 済んだ・家族へ上げた・止めている・就寝時間帯、のどれかなら何もしない（null）。同じ再確認が既に積まれていればそれを返す。
 */
export async function handleRecheck(
  ctx: AppContext,
  args: { hh: HouseholdId; date: DateKey; task: TaskKey; promptId?: PromptId; now: Date },
): Promise<Prompt | null> {
  const { hh, date, task, now } = args;
  const household = await ctx.store.getHousehold(hh);
  if (!household) throw new NotFoundError(`household not found: ${hh}`);
  if (household.killSwitch) return null;
  if (inSleepHours(household, now)) return null;
  const day = await ctx.store.getDay(hh, date);
  if (!day || day.tasks[task]?.state !== 'rechecking') return null;
  const queued = (await ctx.store.listPrompts(hh, date)).find(p => p.task === task && p.isRecheck && p.state === 'queued');
  if (queued) return queued;   // Tasks の再送で二重に積まない
  return enqueuePrompt(ctx, hh, date, task, {
    isRecheck: true, text: defaultPromptText(task, household, true), at: now,
  });
}

// ---------------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------------

let rules: RulesTurnRunner | null = null;
function rulesRunner(): RulesTurnRunner {
  rules ??= new RulesTurnRunner();
  return rules;
}

async function findPrompt(ctx: AppContext, hh: HouseholdId, id: PromptId, date: DateKey, tryPrevDay: boolean): Promise<Prompt | null> {
  const p = await ctx.store.getPrompt(hh, date, id);
  if (p || !tryPrevDay) return p;
  return ctx.store.getPrompt(hh, shiftDateKey(date, -1), id);
}

function fallbackOutcome(input: TurnInput, error: unknown): TurnOutcome {
  const reason = (error as { message?: string } | undefined)?.message ?? String(error);
  const status: Classification = input.replyText == null ? 'no_answer' : 'unclear';
  return {
    classified: { status, note: '会話ターンが失敗したため判定しない', by: 'rules', confidence: status === 'unclear' ? 0.5 : 1.0, uncertain: status === 'unclear' },
    say: input.replyText == null ? 'また少ししたら声をかけますね。' : 'ごめんなさい、もう一度聞かせてくださいね。',
    expression: 'think',
    toolCalls: [],
    intents: [{ type: 'record', task: input.prompt.task, status, note: '会話ターンの失敗' }],
    latencyMs: 0,
    degraded: { reason: `turn_runner_error: ${reason.slice(0, 120)}` },
  };
}

/** 質問らしい発話か（「何の薬？」「どこ？」など） */
export function isQuestion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  return /[？?]$/.test(t) || /(何|なに|なん|どこ|いつ|どうして|だれ|誰)/.test(t);
}

function normalizeQuestion(text: string): string {
  return text.replace(/[\s、。！!？?…・「」]/g, '').replace(/(ですか|なの|かな|だっけ)$/, '');
}

/** 直近 30 分に同じ質問があれば、今回で「繰り返し」とみなす（今回を含めて 2 回以上） */
export function isRepeatedQuestion(
  replyText: string | null,
  todayTurns: Array<Pick<Turn, 'replyText' | 'repliedAt'>>,
  now: Date,
): boolean {
  if (!replyText || !isQuestion(replyText)) return false;
  const key = normalizeQuestion(replyText);
  if (!key) return false;
  const since = addMinutes(now, -REPEAT_WINDOW_MINUTES).getTime();
  return todayTurns.some(t =>
    t.replyText != null && t.repliedAt.getTime() >= since && t.repliedAt.getTime() <= now.getTime()
    && normalizeQuestion(t.replyText) === key);
}
