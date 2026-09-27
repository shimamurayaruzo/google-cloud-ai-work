// 時刻は JST（Asia/Tokyo）で扱う。テストと再生モードでは now を差し替える。
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

const TZ = 'Asia/Tokyo';

/** "YYYY-MM-DD"（JST） */
export function dateKey(d: Date): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "HH:MM"（JST） */
export function hhmm(d: Date): string {
  const p = parts(d);
  return `${p.hour}:${p.minute}`;
}

/** 曜日 "Sun".."Sat"（JST） */
export function weekdayKey(d: Date): Weekday {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d) as Weekday;
}
export type Weekday = 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';

/** JST の日付 "YYYY-MM-DD" と "HH:MM" から Date を作る */
export function jstDate(dateKeyStr: string, time: string): Date {
  return new Date(`${dateKeyStr}T${time}:00+09:00`);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

/** "HH:MM" 同士の比較用に分に直す */
export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** 静かな時間帯（例 21:30〜07:30、日付をまたぐ）に入っているか */
export function inQuietHours(d: Date, quiet: { from: string; to: string } | undefined): boolean {
  if (!quiet) return false;
  const now = toMinutes(hhmm(d));
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** 前後 N 日の日付キー（JST）。offset は -1 で昨日 */
export function shiftDateKey(dateKeyStr: string, offsetDays: number): string {
  const d = new Date(`${dateKeyStr}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return dateKey(d);
}

function parts(d: Date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
