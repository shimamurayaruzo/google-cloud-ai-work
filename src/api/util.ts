// api/ の中だけで使う小さな道具（入力の取り出し、日付・世帯の既定値）。

import type { Request } from 'express';
import { config } from '../config.js';
import { dateKey } from '../time.js';
import { TASK_KEYS, newId, type DateKey, type HouseholdId, type LedgerEntry, type TaskKey } from '../types.js';
import { HttpError } from './router.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** クエリの文字列値（配列やオブジェクトは無視） */
export function qstr(req: Request, name: string): string | undefined {
  const v = (req.query as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** body をオブジェクトとして取り出す（無ければ空） */
export function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** "YYYY-MM-DD" を検証する。省略時は now の JST 日付 */
export function toDateKey(v: unknown, now: Date): DateKey {
  if (v == null || v === '') return dateKey(now);
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00+09:00`).getTime())) {
    throw new HttpError(400, 'date は YYYY-MM-DD で指定してください');
  }
  return v;
}

/** 世帯 ID。省略時は config.defaultHouseholdId（提出版は 1 世帯） */
export function toHousehold(v: unknown): HouseholdId {
  if (v == null || v === '') return config.defaultHouseholdId;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new HttpError(400, 'hh の形が正しくありません');
  return v;
}

export function toTaskKey(v: unknown): TaskKey {
  if (typeof v === 'string' && (TASK_KEYS as readonly string[]).includes(v)) return v as TaskKey;
  throw new HttpError(400, `task は ${TASK_KEYS.join(' / ')} のどれかです`);
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `${name} を指定してください`);
  return v;
}

/** 本人の言葉を画面に出すときの短縮（全文は turn の詳細でだけ返す） */
export function truncate(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('') + '…';
}

export function header(req: Request, name: string): string | undefined {
  const v = req.headers?.[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

/** 台帳に 1 行足す（追記のみ）。id と date と at はここで決める */
export async function writeLedger(
  ctx: { store: { appendLedger(e: LedgerEntry): Promise<void> } },
  hh: HouseholdId,
  now: Date,
  entry: Omit<LedgerEntry, 'id' | 'hh' | 'date' | 'at'>,
): Promise<LedgerEntry> {
  const e: LedgerEntry = { id: newId('lg'), hh, date: dateKey(now), at: now, ...entry };
  await ctx.store.appendLedger(e);
  return e;
}
