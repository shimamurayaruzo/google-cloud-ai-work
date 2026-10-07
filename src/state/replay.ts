// 再生モード（審査員向け）。台本（eval/scenarios/*.json、docs/02 §9）を 1 ターンずつ流し、
// 判定・再確認・通知が起きる様子と、期待値（expect）との一致を返す。
//
// ctx は呼び出し側（api/replay.ts、scripts/replay.ts）が組む。ここでは store の種類を仮定しないが、
// 本番の Firestore・本物の送信・Cloud Tasks を渡さないこと（台本の日付で通知や予約が本当に出てしまう）。
// 時刻は ctx.clock を使わず、各ステップの now = jstDate(scenario.date, at)。

import type { AppContext, Intent } from '../services.js';
import { hhmm, jstDate } from '../time.js';
import type {
  Classification, DateKey, DaySummary, HouseholdId, Notice, Scenario, ScenarioTurn, TaskKey,
} from '../types.js';
import { demoHousehold } from '../seed/household.js';
import { deliverPrompt, enqueuePrompt, ensureDay } from './day.js';
import { defaultPromptText } from './plan.js';
import { buildSummary } from './summary.js';
import { processReply } from './turn.js';

export interface ReplayStep {
  at: string;
  task: TaskKey;
  prompt: string;
  reply: string | null;
  status: Classification;
  say: string;
  intents: Intent[];
  /** このステップで作られた通知（"level: reason" の形） */
  notices: string[];
  /** 再確認を予約したときの時刻 "HH:MM"（JST） */
  followUpAt?: string | null;
  turnId?: string;
  expected?: ScenarioTurn['expect'];
  pass?: boolean;
}

export interface ReplayResult {
  date: DateKey;
  name?: string;
  steps: ReplayStep[];
  summary?: DaySummary;
  passCount: number;
  failCount: number;
}

/**
 * 期待値との比較。
 *  - status は一致すること
 *  - expect.notify があれば、そのレベルの通知がこのステップで作られていること
 *  - expect.notify が無ければ、urgent / check の通知が作られていないこと（info は問わない）
 */
export function judgeStep(expect: NonNullable<ScenarioTurn['expect']>, status: Classification, notices: Pick<Notice, 'level'>[]): boolean {
  if (status !== expect.status) return false;
  if (expect.notify) return notices.some(n => n.level === expect.notify);
  return !notices.some(n => n.level === 'urgent' || n.level === 'check');
}

export async function runScenario(
  ctx: AppContext,
  hh: HouseholdId,
  scenario: Scenario,
  opts: { withSummary?: boolean; useLlm?: boolean } = {},
): Promise<ReplayResult> {
  const date = scenario.date;
  let household = await ctx.store.getHousehold(hh);
  if (!household) {
    // 世帯が無い空の Store でも流せるように、デモ世帯を入れる
    household = { ...demoHousehold(), id: hh };
    await ctx.store.putHousehold(household);
  }
  await ensureDay(ctx, hh, date, { isDayservice: scenario.isDayservice });

  const steps: ReplayStep[] = [];
  let passCount = 0;
  let failCount = 0;

  const turns = [...scenario.turns].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const t of turns) {
    const now = jstDate(date, t.at);
    const day = await ensureDay(ctx, hh, date);
    const rechecking = day.tasks[t.task]?.state === 'rechecking';
    // 痛みの聞き直し・L4 の安心文は台本の声かけとは別なので使わない
    const queued = (await ctx.store.listPrompts(hh, date))
      .find(p => p.task === t.task && p.state === 'queued' && !p.followup && !p.isReassurance);
    const prompt = queued ?? await enqueuePrompt(ctx, hh, date, t.task, {
      isRecheck: rechecking,
      text: rechecking ? defaultPromptText(t.task, household, true) : undefined,
      at: now,
    });
    const delivered = await deliverPrompt(ctx, prompt, now, { synthesize: false });
    const res = await processReply(ctx, {
      hh, date, promptId: delivered.id, replyText: t.reply, source: 'replay', now,
    });

    const status = res.turn.classified.status;
    const step: ReplayStep = {
      at: t.at,
      task: t.task,
      prompt: delivered.text,
      reply: t.reply,
      status,
      say: res.say,
      intents: res.intents,
      notices: res.notices.map(n => `${n.level}: ${n.reason}`),
      followUpAt: res.followUp ? hhmm(res.followUp.at) : null,
      turnId: res.turn.id,
    };
    if (t.expect) {
      step.expected = t.expect;
      step.pass = judgeStep(t.expect, status, res.notices);
      if (step.pass) passCount += 1; else failCount += 1;
    }
    steps.push(step);
  }

  const result: ReplayResult = { date, name: scenario.name, steps, passCount, failCount };
  if (opts.withSummary) {
    result.summary = await buildSummary(ctx, hh, date, { useLlm: opts.useLlm ?? false });
  }
  return result;
}

