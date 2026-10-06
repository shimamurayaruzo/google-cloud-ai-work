// 台帳（追記のみ）を書く小さな道具。state/ の中で使う。運用の記録（incidents）は ops/health.ts の recordIncident。
// イベント名は docs/02 §6 と log.ts の LedgerEventName に揃える。

import type { LedgerEventName } from '../log.js';
import type { AppContext } from '../services.js';
import {
  newId, type DateKey, type HouseholdId, type LedgerEntry, type LedgerKind, type NoticeId, type TurnId,
} from '../types.js';

export interface LedgerInput {
  hh: HouseholdId;
  date: DateKey;
  at: Date;
  kind: LedgerKind;
  name: LedgerEventName;
  actor?: LedgerEntry['actor'];
  args?: Record<string, unknown>;
  result?: unknown;
  turnId?: TurnId | null;
  noticeId?: NoticeId | null;
}

export async function appendLedger(ctx: Pick<AppContext, 'store'>, e: LedgerInput): Promise<LedgerEntry> {
  const entry: LedgerEntry = {
    id: newId('lg'),
    hh: e.hh,
    date: e.date,
    at: e.at,
    actor: e.actor ?? 'agent',
    kind: e.kind,
    name: e.name,
    args: e.args,
    result: e.result,
    turnId: e.turnId ?? null,
    noticeId: e.noticeId ?? null,
  };
  await ctx.store.appendLedger(entry);
  return entry;
}

/** 本人の返事をログや台帳に出すときの短い抜粋（全文は出さない） */
export function excerpt(text: string | null | undefined, max = 20): string | null {
  if (text == null) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
