// 端末（iPad の顔画面）用 API。docs/02 §3.1。
// 端末は判断しない。返す say と expression をそのまま出す。
// 本人の返事の全文はログに出さない（長さだけ）。

import type { Request, Response } from 'express';
import type { AppContext } from '../services.js';
import { nextPrompt } from '../state/day.js';
import { processReply } from '../state/turn.js';
import { modeOf, modeView, switchMode } from '../state/mode.js';
import { handleUtterance } from '../state/utterance.js';
import { logEvent } from '../log.js';
import { dateKey } from '../time.js';
import type { HouseholdId, HouseholdMode, Prompt, ReplySource } from '../types.js';
import { requireDevice } from './auth.js';
import { HttpError, ok, type Router } from './router.js';
import { bodyOf, requireString, str } from './util.js';

/** 次に話す予定の声かけ（queued のうち scheduledAt が一番早いもの。未来のものも含む） */
export async function upcomingPrompt(ctx: AppContext, hh: HouseholdId, now: Date): Promise<{ at: string; task: string } | null> {
  const prompts = await ctx.store.listPrompts(hh, dateKey(now));
  const queued = prompts
    .filter(p => p.state === 'queued')
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const p = queued[0];
  return p ? { at: new Date(p.scheduledAt).toISOString(), task: p.task } : null;
}

export function promptForDevice(p: Prompt | null) {
  if (!p) return null;
  return {
    id: p.id,
    task: p.task,
    text: p.text,
    ...(p.ttsUrl ? { ttsUrl: p.ttsUrl } : {}),
    expression: p.expression,
    // L4 モードの安心文。質問ではないので、端末は返事を待たずに読み上げるだけでよい
    ...(p.isReassurance ? { isReassurance: true } : {}),
    // 返事を求めない声かけ（お風呂の最初と最後の一言・ときたまの声かけ）。端末は返事を待たない（noAnswer も送らない）
    ...(p.expectsReply === false ? { expectsReply: false } : {}),
    // お風呂モードの声かけの段（start / wash / wash_recheck / teeth / end）。字幕を大きく短くする目印
    ...(p.bathStep ? { bathStep: p.bathStep } : {}),
  };
}

export function toMode(v: unknown): HouseholdMode {
  if (v === 'bedroom' || v === 'bath') return v;
  throw new HttpError(400, 'mode は bedroom か bath です');
}

export function registerDeviceRoutes(router: Router, ctx: AppContext): void {
  // 生存信号（60 秒ごと）
  router.post('/api/device/heartbeat', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const body = bodyOf(req);
    const now = ctx.clock();
    const batteryPct = typeof body.batteryPct === 'number' && Number.isFinite(body.batteryPct) ? body.batteryPct : undefined;
    const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, 40) : undefined;
    await ctx.store.recordHeartbeat({
      hh, at: now,
      ...(batteryPct !== undefined ? { batteryPct } : {}),
      ...(appVersion !== undefined ? { appVersion } : {}),
    });
    const household = await ctx.store.getHousehold(hh);
    ok(res, {
      ok: true,
      killSwitch: household?.killSwitch ?? false,
      nextPrompt: await upcomingPrompt(ctx, hh, now),
    });
  });

  // 次に話す声かけ（今話してよいもの）。mode はその時点の起動モード（docs/02 §11.4）
  router.get('/api/device/next-prompt', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const p = await nextPrompt(ctx, hh, ctx.clock());
    const household = await ctx.store.getHousehold(hh);
    ok(res, { prompt: promptForDevice(p), mode: household ? modeOf(household) : 'bedroom' });
  });

  // 起動モード（iPad 右上の家族用ボタン。docs/02 §11.4）
  router.get('/api/device/mode', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const household = await ctx.store.getHousehold(hh);
    if (!household) throw new HttpError(404, `世帯 ${hh} が見つかりません`);
    ok(res, modeView(household, ctx.clock()));
  });

  router.post('/api/device/mode', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const mode = toMode(bodyOf(req).mode);
    const now = ctx.clock();
    const r = await switchMode(ctx, hh, mode, 'device', now);
    ok(res, modeView(r.household, now));
  });

  // 本人からの発話（声かけへの返事ではないもの。docs/02 §11.2）
  router.post('/api/device/utterance', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const body = bodyOf(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'text（文字起こしした発話）を送ってください');
    const source: ReplySource = body.source === 'test' ? 'test' : 'ipad';
    const now = ctx.clock();
    logEvent('device_utterance', { hh, source, textLength: text.length });
    const r = await handleUtterance(ctx, { hh, text: text.slice(0, 500), source, now });
    ok(res, { turnId: r.turn.id, say: r.say, expression: r.expression, kind: r.kind });
  });

  // 本人の返事（1 ターン）
  router.post('/api/device/reply', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const body = bodyOf(req);
    const promptId = requireString(body.promptId, 'promptId');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const noAnswer = body.noAnswer === true;
    let replyText: string | null;
    if (text) {
      replyText = text.slice(0, 500);
    } else if (noAnswer) {
      replyText = null;
    } else if (str(body.audioBase64)) {
      // 未決（docs/02 §10）: 提出版は端末側の文字起こしのみ
      throw new HttpError(400, '音声の文字起こしはまだ受け付けていません。text を送ってください');
    } else {
      throw new HttpError(400, 'text を送るか、返事がなかったときは noAnswer: true を送ってください');
    }
    const source: ReplySource = body.source === 'test' ? 'test' : 'ipad';
    const now = ctx.clock();
    logEvent('device_reply', { hh, promptId, source, noAnswer: replyText === null, textLength: replyText?.length ?? 0 });
    const result = await processReply(ctx, { hh, promptId, replyText, source, now });
    ok(res, {
      turnId: result.turn.id,
      say: result.say,
      expression: result.expression,
      followUp: result.followUp ? { at: new Date(result.followUp.at).toISOString(), task: result.followUp.task } : null,
    });
  });

  // 生活音の大きさ（録音しない。数値のみ）
  router.post('/api/device/noise-level', async (req: Request, res: Response) => {
    const hh = requireDevice(req);
    const body = bodyOf(req);
    const rms = body.rms;
    if (typeof rms !== 'number' || !Number.isFinite(rms) || rms < 0) {
      throw new HttpError(400, 'rms は 0 以上の数値で送ってください');
    }
    let at = ctx.clock();
    if (body.at != null) {
      const d = new Date(String(body.at));
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'at は ISO 8601 の時刻で送ってください');
      at = d;
    }
    await ctx.store.recordNoise({ hh, at, rms });
    ok(res, { ok: true });
  });
}
