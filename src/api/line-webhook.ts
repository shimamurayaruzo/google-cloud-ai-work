// LINE Webhook（POST /webhook/line）。docs/02 §3.3。
//  - follow: 友だち追加した人の userId を、順番の若い「LINE 未登録」の家族に登録する
//  - postback "ack:<noticeId>": 通知の「確認した」ボタン
//  - message「確認した」「OK」: 直近の開いている通知を確認済みにする
// 署名が正しければ、処理に失敗しても 200 を返す（LINE の再送で同じ処理が重ならないように）。
// userId やメッセージ本文はログに出さない。

import type { Request, Response } from 'express';
import { config } from '../config.js';
import type { AppContext } from '../services.js';
import { logError, logEvent, logWarn } from '../log.js';
import { parseAckPostback } from '../notify/index.js';
import type { Household, HouseholdId, Member } from '../types.js';
import { verifyLineSignature } from './auth.js';
import { json, ok, type Router } from './router.js';
import { bodyOf, writeLedger } from './util.js';

interface LineEvent {
  type?: string;
  source?: { type?: string; userId?: string };
  postback?: { data?: string };
  message?: { type?: string; text?: string };
}

const ACK_WORDS = ['確認した', '確認しました', 'かくにんした', 'ok', 'ｏｋ', 'オッケー'];

export function isAckText(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[。！!]+$/u, '');
  return ACK_WORDS.includes(t);
}

function memberByLineUser(h: Household, userId: string | undefined): Member | undefined {
  if (!userId) return undefined;
  return h.members.find(m => m.line?.userId === userId);
}

async function onFollow(ctx: AppContext, hh: HouseholdId, h: Household, userId: string, now: Date): Promise<void> {
  if (memberByLineUser(h, userId)) return; // 登録済み
  const target = [...h.members].sort((a, b) => a.order - b.order).find(m => !m.line?.userId);
  if (!target) {
    logWarn('line_follow_unmatched', { hh, reason: 'LINE 未登録の家族がいません' });
    return;
  }
  const members = h.members.map(m => (m.id === target.id ? { ...m, line: { userId } } : m));
  await ctx.store.updateHousehold(hh, { members, updatedAt: now });
  h.members = members;
  await writeLedger(ctx, hh, now, { actor: 'system', kind: 'system', name: 'line_follow', args: { memberId: target.id } });
  logEvent('line_follow', { hh, memberId: target.id });
}

async function onAck(ctx: AppContext, hh: HouseholdId, noticeId: string, memberId: string, now: Date): Promise<void> {
  const n = await ctx.familyNotify.ack(hh, noticeId, memberId, now);
  logEvent('line_ack', { hh, noticeId, memberId, found: Boolean(n) });
}

export async function handleLineEvents(ctx: AppContext, hh: HouseholdId, events: LineEvent[]): Promise<number> {
  const h = await ctx.store.getHousehold(hh);
  if (!h) {
    logWarn('line_webhook_no_household', { hh });
    return 0;
  }
  let handled = 0;
  for (const ev of events) {
    const now = ctx.clock();
    const userId = ev.source?.userId;
    try {
      if (ev.type === 'follow' && userId) {
        await onFollow(ctx, hh, h, userId, now);
        handled++;
      } else if (ev.type === 'postback') {
        const noticeId = parseAckPostback(ev.postback?.data);
        if (noticeId && /^[A-Za-z0-9_-]{1,80}$/.test(noticeId)) {
          const member = memberByLineUser(h, userId);
          await onAck(ctx, hh, noticeId, member?.id ?? 'line:unknown', now);
          handled++;
        }
      } else if (ev.type === 'message' && ev.message?.type === 'text' && isAckText(ev.message.text ?? '')) {
        const open = await ctx.store.listOpenNotices(hh);
        const latest = open.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (latest) {
          const member = memberByLineUser(h, userId);
          await onAck(ctx, hh, latest.id, member?.id ?? 'line:unknown', now);
          handled++;
        }
      }
    } catch (error) {
      logError('line_event_failed', error, { hh, type: ev.type ?? null });
    }
  }
  return handled;
}

export function registerLineWebhook(router: Router, ctx: AppContext): void {
  router.post('/webhook/line', async (req: Request, res: Response) => {
    if (!config.line.channelSecret) {
      json(res, 503, { ok: false, error: 'LINE_CHANNEL_SECRET が設定されていません' });
      return;
    }
    if (!verifyLineSignature(req)) {
      logWarn('line_signature_invalid', {});
      json(res, 401, { ok: false, error: '署名が正しくありません' });
      return;
    }
    const events = Array.isArray(bodyOf(req).events) ? (bodyOf(req).events as LineEvent[]) : [];
    let handled = 0;
    try {
      handled = await handleLineEvents(ctx, config.defaultHouseholdId, events);
    } catch (error) {
      logError('line_webhook_failed', error, {});
    }
    ok(res, { ok: true, handled });
  });
}
