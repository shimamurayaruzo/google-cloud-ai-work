// 内部用 API。docs/02 §3.3。Cloud Scheduler と Cloud Tasks から呼ばれる。
// 認証は requireInternal（OIDC か X-Internal-Token）。
// body の hh / date は省略可（省略時は config.defaultHouseholdId と今日 JST）。

import type { Request, Response } from 'express';
import type { AppContext } from '../services.js';
import { enqueuePrompt, expireUnansweredPrompts, planDay } from '../state/day.js';
import { handleRecheck } from '../state/turn.js';
import { buildAndSendSummary } from '../state/summary.js';
import { runHealthCheck } from '../ops/health.js';
import { logEvent } from '../log.js';
import type { Prompt } from '../types.js';
import { requireInternal } from './auth.js';
import { HttpError, ok, type Router } from './router.js';
import { bodyOf, requireString, str, toDateKey, toHousehold, toTaskKey } from './util.js';

function target(req: Request, now: Date) {
  const body = bodyOf(req);
  return { body, hh: toHousehold(body.hh), date: toDateKey(body.date, now) };
}

export function registerInternalRoutes(router: Router, ctx: AppContext): void {
  // Scheduler 06:00: 夜のうちに溜めた通知を送り、その日の計画を作って家族に承認依頼
  router.post('/internal/plan', async (req: Request, res: Response) => {
    await requireInternal(req);
    const now = ctx.clock();
    const { hh, date } = target(req, now);
    const flushed = await ctx.familyNotify.flushDeferred(hh, now);
    const { day, prompts } = await planDay(ctx, hh, date, now);
    logEvent('internal_plan', { hh, date, flushed, prompts: prompts.length });
    ok(res, {
      ok: true, hh, date, flushed,
      isDayservice: day.isDayservice,
      planApproved: day.planApproved,
      prompts: prompts.map((p: Prompt) => ({ id: p.id, task: p.task, scheduledAt: p.scheduledAt })),
    });
  });

  // Scheduler／Tasks: 指定の確認項目の声かけを「次に話す」に積む
  router.post('/internal/prompt', async (req: Request, res: Response) => {
    await requireInternal(req);
    const now = ctx.clock();
    const { body, hh, date } = target(req, now);
    const task = toTaskKey(body.task);
    const text = str(body.text);
    const prompt = await enqueuePrompt(ctx, hh, date, task, { at: now, ...(text ? { text: text.slice(0, 200) } : {}) });
    ok(res, { ok: true, hh, date, prompt: { id: prompt.id, task: prompt.task, scheduledAt: prompt.scheduledAt, state: prompt.state } });
  });

  // Tasks: 再確認（1 回まで。回数の判定は state/ 側）
  router.post('/internal/recheck', async (req: Request, res: Response) => {
    await requireInternal(req);
    const now = ctx.clock();
    const { body, hh, date } = target(req, now);
    const task = toTaskKey(body.task);
    const promptId = requireString(body.promptId, 'promptId');
    await handleRecheck(ctx, { hh, date, task, promptId, now });
    ok(res, { ok: true, hh, date, task, promptId });
  });

  // Tasks: 通知の段階上げ（次の通知先へ）
  router.post('/internal/escalate', async (req: Request, res: Response) => {
    await requireInternal(req);
    const now = ctx.clock();
    const { body, hh } = target(req, now);
    const noticeId = requireString(body.noticeId, 'noticeId');
    const notice = await ctx.familyNotify.escalate(hh, noticeId, now);
    if (!notice) throw new HttpError(404, 'この通知は見つかりません');
    ok(res, { ok: true, hh, notice: { id: notice.id, state: notice.state, steps: notice.steps.length } });
  });

  // Scheduler 18:00: 日次要約を作り、家族に送る
  router.post('/internal/summary', async (req: Request, res: Response) => {
    await requireInternal(req);
    const now = ctx.clock();
    const { hh, date } = target(req, now);
    const summary = await buildAndSendSummary(ctx, hh, date, now);
    ok(res, { ok: true, hh, date, summary });
  });

  // Scheduler 5 分ごと: 答えのない声かけを締め、生存信号・エラー・TTS を点検
  router.post('/internal/health', async (req: Request, res: Response) => {
    await requireInternal(req);
    const now = ctx.clock();
    const { hh } = target(req, now);
    const expired = await expireUnansweredPrompts(ctx, hh, now);
    const report = await runHealthCheck(ctx, hh, now);
    ok(res, { ok: true, hh, expired, report });
  });
}
