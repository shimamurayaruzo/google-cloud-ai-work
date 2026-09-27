// 会話ターンの中核。本人の返事 1 回を TurnRunner（ADK か規則）に渡し、返ってきた「やりたいこと」（Intent）を
// 状態機械・予約・通知・台帳に落とす。副作用はすべてここで起きる（TurnRunner は決めるだけ）。

import { logError, logEvent } from '../log.js';
import type { AppContext, Intent, TurnInput, TurnOutcome } from '../services.js';
import { addMinutes, dateKey, hhmm, shiftDateKey } from '../time.js';
import {
  newId, TASK_LABELS, type Classification, type DateKey, type Day, type Expression, type HouseholdId, type Notice,
  type Prompt, type PromptId, type ReplySource, type TaskKey, type TaskRecord, type Turn,
} from '../types.js';
import { ensureDay, enqueuePrompt } from './day.js';
import { NotFoundError } from './errors.js';
import { RulesTurnRunner } from '../agent/rules.js';
import { currentDegraded, recordIncident } from '../ops/health.js';
import { appendLedger, excerpt } from './ledger.js';
import { canRecheck, transition } from './machine.js';
import { defaultPromptText, findPlanItem, recheckDelayMinutes } from './plan.js';

export { NotFoundError };

/** replyText の保存期間（Firestore の TTL で消す） */
const TURN_TTL_MINUTES = 7 * 24 * 60;
/** 「同じ質問の繰り返し」を数える窓 */
const REPEAT_WINDOW_MINUTES = 30;
/** 要約に引用する本人の言葉の長さ */
const EVIDENCE_MAX = 30;

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
    classified: outcome.classified,
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

  const applied = await applyIntents(ctx, { household, day, prompt, item, turnId, replyText, outcome, now, recheckAllowed, familyApprovedShare });

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
      degraded: outcome.degraded?.reason ?? null, taskState: applied.taskState,
    },
  });
  if (outcome.degraded) {
    await recordIncident(ctx.store, hh, 'llm_error', 'fallback', outcome.degraded.reason, now);
  }
  logEvent('turn_classified', {
    hh, date, task, turnId, status, by: outcome.classified.by,
    degraded: outcome.degraded?.reason ?? null, reply: excerpt(replyText), latencyMs: outcome.latencyMs,
    followUp: applied.followUp ? applied.followUp.at.toISOString() : null,
  });

  return {
    turn,
    followUp: applied.followUp,
    say: outcome.say,
    expression: outcome.expression,
    intents: outcome.intents,
    notices: applied.notices,
  };
}

// ---------------------------------------------------------------------------
// Intent の適用
// ---------------------------------------------------------------------------

interface ApplyArgs {
  household: NonNullable<Awaited<ReturnType<AppContext['store']['getHousehold']>>>;
  day: Day;
  prompt: Prompt;
  item: ReturnType<typeof findPlanItem>;
  turnId: string;
  replyText: string | null;
  outcome: TurnOutcome;
  now: Date;
  recheckAllowed: boolean;
  familyApprovedShare: boolean;
}

async function applyIntents(ctx: AppContext, a: ApplyArgs): Promise<{
  followUp: { at: Date; task: TaskKey } | null;
  notices: Notice[];
  taskState: TaskRecord['state'] | undefined;
}> {
  const { household, day, prompt, turnId, outcome, now } = a;
  const { hh, date, task } = prompt;
  const tasks: Day['tasks'] = { ...day.tasks };
  const notices: Notice[] = [];
  let followUp: { at: Date; task: TaskKey } | null = null;

  // ---- 止めている間: 状態は suspended、道具は動かさない（blocked の記録だけ残す） ----
  if (household.killSwitch) {
    const { next } = transition(tasks[task], { type: 'suspend', at: now });
    await ctx.store.setTask(hh, date, task, next);
    for (const i of outcome.intents) {
      if (i.type === 'blocked') await ledgerBlocked(ctx, hh, date, now, turnId, i.tool, i.args, i.reason);
    }
    return { followUp: null, notices, taskState: next.state };
  }

  // ---- record: 先に全部適用する（再確認・通知はその結果を見る） ----
  const records = outcome.intents.filter((i): i is Extract<Intent, { type: 'record' }> => i.type === 'record');
  if (!records.some(r => r.task === task)) {
    records.unshift({ type: 'record', task, status: outcome.classified.status, note: outcome.classified.note });
  }
  const before = tasks[task];
  let escalatedThisTurn = false;
  for (const r of records) {
    const isPromptTask = r.task === task;
    // 声かけとは別の項目は「済んだ」と言われたときだけ反映する（例: 洗顔を聞いたら「もう着替えたよ」）
    if (!isPromptTask && r.status !== 'done') continue;
    const item = findPlanItem(day.plan, r.task, prompt.scheduledAt);
    const { next, escalate } = transition(tasks[r.task], {
      type: 'classified',
      status: r.status,
      at: now,
      evidence: a.replyText ? excerpt(a.replyText, EVIDENCE_MAX) ?? undefined : undefined,
      turnId,
      recheckAllowed: isPromptTask ? a.recheckAllowed : false,
      escalateAllowed: item?.escalate !== false,
    });
    tasks[r.task] = next;
    await ctx.store.setTask(hh, date, r.task, next);
    if (escalate) {
      escalatedThisTurn = true;
      const n = await safeNotify(ctx, {
        hh, date, level: 'check',
        reason: `${TASK_LABELS[r.task]}が確認できませんでした`,
        evidence: escalationEvidence(prompt, a.replyText, r.status, now),
        turnId, task: r.task, now,
      });
      if (n) notices.push(n);
    }
  }

  // ---- 再確認: この声かけの項目が今のターンで rechecking に入ったときだけ予約する ----
  // 時刻は状態機械が決める（計画の recheckMinutes、お迎えからの逆算）。エージェントの minutes はそれより短いときだけ採る
  const after = tasks[task];
  const recheckIntent = outcome.intents.find((i): i is Extract<Intent, { type: 'recheck' }> => i.type === 'recheck');
  const enteredRecheck = after?.state === 'rechecking' && (after.recheckCount > (before?.recheckCount ?? 0));
  if (enteredRecheck) {
    const planned = recheckDelayMinutes(household, a.item, task, now);
    const minutes = recheckIntent ? Math.max(5, Math.min(recheckIntent.minutes, planned)) : planned;
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
  for (const i of outcome.intents) {
    if (i.type === 'notify') {
      // 状態機械が既に check で家族へ上げたターンは、同じ趣旨の check を重ねない
      if (i.level === 'check' && escalatedThisTurn) continue;
      const n = await safeNotify(ctx, {
        hh, date, level: i.level, reason: i.reason, evidence: i.evidence, turnId, task, now,
      });
      if (n) notices.push(n);
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

  return { followUp, notices, taskState: tasks[task]?.state };
}

async function safeNotify(ctx: AppContext, req: Parameters<AppContext['familyNotify']['notify']>[0]): Promise<Notice | null> {
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

function escalationEvidence(prompt: Prompt, replyText: string | null, status: Classification, now: Date): string {
  const what = replyText
    ? `「${excerpt(replyText, EVIDENCE_MAX)}」`
    : status === 'no_answer' ? '返事がありませんでした' : '返事が確認できませんでした';
  return `${hhmm(now)} ${TASK_LABELS[prompt.task]}の再確認（「${excerpt(prompt.text, 30)}」）に ${what}`;
}

// ---------------------------------------------------------------------------
// 再確認（Tasks から /internal/recheck）
// ---------------------------------------------------------------------------

/**
 * 予約した再確認の時刻が来た。その項目がまだ rechecking なら、別の言い回しで声かけを積む。
 * 済んだ・家族へ上げた・止めている、のどれかなら何もしない（null）。同じ再確認が既に積まれていればそれを返す。
 */
export async function handleRecheck(
  ctx: AppContext,
  args: { hh: HouseholdId; date: DateKey; task: TaskKey; promptId?: PromptId; now: Date },
): Promise<Prompt | null> {
  const { hh, date, task, now } = args;
  const household = await ctx.store.getHousehold(hh);
  if (!household) throw new NotFoundError(`household not found: ${hh}`);
  if (household.killSwitch) return null;
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
    classified: { status, note: '会話ターンが失敗したため判定しない', by: 'rules' },
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
