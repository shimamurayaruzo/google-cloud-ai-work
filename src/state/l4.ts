// L4 モード（docs/criteria.md v2 1 節 L4・3-2・3-3・5 節）。
// 至急の通知（L4 の語、または 3 回続けて返事なし）を作ったターンで day.l4 を立てる。立っている間は:
//  - 通常の声かけを出さない（state/day.ts の nextPrompt）
//  - 3 分ごとに安心の一文だけを流す（質問はしない）
//  - 本人の返事は判定せず、台帳と通知の根拠に追記するだけ（state/turn.ts）
// 家族が「確認した」（または「誤報だった」）を押して通知が acked / closed になったら、次の nextPrompt で解除する。

import { logEvent } from '../log.js';
import type { AppContext } from '../services.js';
import { addMinutes } from '../time.js';
import type { DateKey, Day, DayL4, HouseholdId, Notice, TaskKey } from '../types.js';
import { appendLedger } from './ledger.js';

/** 安心の一文の間隔（分） */
export const REASSURANCE_INTERVAL_MINUTES = 3;

/** L4 を立てる（既に立っていれば何もしない） */
export async function startL4(
  ctx: Pick<AppContext, 'store'>,
  hh: HouseholdId,
  date: DateKey,
  day: Pick<Day, 'l4'>,
  notice: Notice,
  task: TaskKey | undefined,
  now: Date,
): Promise<DayL4 | null> {
  if (day.l4) return null;
  const l4: DayL4 = { noticeId: notice.id, since: now, reason: notice.reason };
  if (task) l4.task = task;
  if (notice.origin) l4.origin = notice.origin;
  await ctx.store.updateDay(hh, date, { l4 });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'system', name: 'l4_started', noticeId: notice.id, turnId: notice.turnId,
    args: { task: task ?? null, origin: notice.origin ?? null },
  });
  logEvent('l4_started', { hh, date, noticeId: notice.id, origin: notice.origin ?? null });
  return l4;
}

/**
 * いま有効な L4（無ければ null）。該当の通知が acked / closed（または見つからない）なら解除して null を返す。
 * 解除のとき、L4 の間に期限が来た声かけは話さずに expired にする（古い催促を転倒の直後に流さない）。
 */
export async function currentL4(
  ctx: Pick<AppContext, 'store'>,
  hh: HouseholdId,
  date: DateKey,
  day: Pick<Day, 'l4'>,
  now: Date,
): Promise<DayL4 | null> {
  const l4 = day.l4;
  if (!l4) return null;
  const notice = await ctx.store.getNotice(hh, l4.noticeId);
  if (notice && notice.state !== 'acked' && notice.state !== 'closed') return l4;

  await clearL4(ctx, hh, date, l4, notice, now);
  return null;
}

/** L4 を下ろす（台帳 l4_cleared）。L4 の間に期限が来た声かけは話さずに expired にする */
async function clearL4(
  ctx: Pick<AppContext, 'store'>, hh: HouseholdId, date: DateKey, l4: DayL4, notice: Notice | null, now: Date,
): Promise<void> {
  await ctx.store.updateDay(hh, date, { l4: null });
  let expired = 0;
  for (const p of await ctx.store.listDuePrompts(hh, date, now)) {
    await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
    expired += 1;
  }
  await appendLedger(ctx, {
    hh, date, at: now, actor: 'system', kind: 'system', name: 'l4_cleared', noticeId: l4.noticeId,
    args: { ackedBy: notice?.ackedBy ?? null, falseAlarm: notice?.falseAlarm ?? false, expiredPrompts: expired },
  });
  logEvent('l4_cleared', { hh, date, noticeId: l4.noticeId, falseAlarm: notice?.falseAlarm ?? false });
}

/**
 * 家族が「確認した」（「誤報だった」を含む）を押した直後に呼ぶ。その通知が L4 を立てたものなら、その場で L4 を下ろす
 * （nextPrompt 側の解除は保険として残る）。下ろしたら true
 */
export async function clearL4ForNotice(
  ctx: Pick<AppContext, 'store'>, hh: HouseholdId, noticeId: string, now: Date,
): Promise<boolean> {
  const notice = await ctx.store.getNotice(hh, noticeId);
  if (!notice || (notice.state !== 'acked' && notice.state !== 'closed')) return false;
  const day = await ctx.store.getDay(hh, notice.date);
  if (!day?.l4 || day.l4.noticeId !== noticeId) return false;
  await clearL4(ctx, hh, notice.date, day.l4, notice, now);
  return true;
}

/** 次の安心文を流してよいか（L4 を立てた時刻、または直近の安心文から 3 分以上） */
export function reassuranceDue(l4: DayL4, lastReassuranceAt: Date | null, now: Date): boolean {
  const since = l4.since instanceof Date ? l4.since : new Date(l4.since);
  const last = lastReassuranceAt && lastReassuranceAt.getTime() > since.getTime() ? lastReassuranceAt : since;
  return now.getTime() >= addMinutes(last, REASSURANCE_INTERVAL_MINUTES).getTime();
}
