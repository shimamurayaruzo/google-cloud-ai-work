// 声かけ計画: 曜日による雛形の選択、既定の文言、再確認までの分の決め方。
// 文言の出所は docs/03_声かけ計画_初期値.md。

import { dateKey, hhmm, inQuietHours, jstDate, minutesBetween, toMinutes, weekdayKey } from '../time.js';
import type { Classification, DateKey, Household, PlanItem, TaskKey } from '../types.js';

/** その日がデイの日か（household.plan.dayserviceDays の曜日） */
export function isDayserviceDate(household: Household, date: DateKey): boolean {
  return household.plan.dayserviceDays.includes(weekdayKey(jstDate(date, '12:00')));
}

/** 曜日で default / dayservice の雛形を選ぶ。isDayservice を渡すと曜日より優先する（再生モード用） */
export function resolvePlan(
  household: Household,
  date: DateKey,
  isDayserviceOverride?: boolean,
): { isDayservice: boolean; items: PlanItem[] } {
  const isDayservice = isDayserviceOverride ?? isDayserviceDate(household, date);
  const src = isDayservice ? household.plan.weekday.dayservice : household.plan.weekday.default;
  const items = src
    .map(i => ({ ...i }))
    .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  return { isDayservice, items };
}

/** 計画の中から、その項目で at の時刻に一番近い（at 以前で最後の）もの。無ければ最初のもの */
export function findPlanItem(items: PlanItem[], task: TaskKey, at?: Date): PlanItem | undefined {
  const same = items.filter(i => i.task === task).sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  if (same.length === 0) return undefined;
  if (!at) return same[0];
  const t = toMinutes(hhmm(at));
  let found = same[0];
  for (const i of same) if (toMinutes(i.time) <= t) found = i;
  return found;
}

/**
 * 既定の声かけの文言。計画に text が無いときと再確認のときに使う。
 * 再確認は責めない別の言い回しにする（docs/03 §2 の原則、§4 の台本）。
 */
export function defaultPromptText(task: TaskKey, household: Household, isRecheck: boolean): string {
  const w = household.person.wording;
  const diaper = w.diaper ?? 'おむつ';
  const place = w.medicinePlace ?? '決めた場所';
  const count = w.medicineCount ?? '';
  if (isRecheck) {
    const recheck: Record<TaskKey, string> = {
      greeting: 'おはようございます。お目覚めですか？',
      diaper: `${diaper}、替えられましたか？`,
      teeth: '歯、磨けましたか？',
      face: 'お顔、洗えましたか？',
      dress: 'そろそろお着替えどうですか？',
      belongings: '持ち物、かばんに入りましたか？',
      pickup: 'お迎えの車、来ましたか？',
      lunch: 'お昼ご飯、食べられましたか？',
      water: 'お茶、飲めましたか？',
      return: 'おかえりなさい。疲れていませんか？',
      dinner: '夕ご飯、食べられましたか？',
      medicine: 'お薬、飲めましたか？',
      bedtime: 'そろそろお休みの準備はできましたか？',
      bath: '体を洗えそうですか？',
      talk: 'お変わりありませんか？',
    };
    return recheck[task];
  }
  const first: Record<TaskKey, string> = {
    greeting: 'おはようございます。よく眠れましたか？',
    diaper: `まず、${diaper}を新しいのに替えましょうか`,
    teeth: '歯を磨きましょう',
    face: '顔を洗ってさっぱりしましょう',
    dress: 'お着替えは済みましたか？',
    belongings: '持ち物はかばんに入っていますか？',
    pickup: 'お迎えは来ましたか？',
    lunch: 'お昼ご飯は食べましたか？何を食べましたか？',
    water: 'お茶を一杯どうですか？',
    return: 'おかえりなさい。今日はどうでしたか？',
    dinner: '夕ご飯は食べましたか？',
    medicine: `ご飯のあとのお薬を飲みましょう。${place}に${count ? ` ${count}` : ''}あります`,
    bedtime: '歯を磨いて、そろそろお休みしましょう',
    bath: 'そろそろ体を洗いましょうか',
    talk: 'お水を一口どうですか',
  };
  return first[task];
}

/**
 * 再確認までの分。
 * 既定は計画の recheckMinutes（0 や未指定なら policy.recheckMinutes）。
 * デイの日でお迎え時刻（pickupTime）があり、お迎えまでの残りが短いときは、残り時間の半分（最小 5 分）に縮める。
 */
export function recheckDelayMinutes(
  household: Household,
  item: PlanItem | undefined,
  _task: TaskKey,
  now: Date,
  /** その日がデイの日か（省略時は曜日から） */
  isDayservice?: boolean,
): number {
  const base = item?.recheckMinutes && item.recheckMinutes > 0 ? item.recheckMinutes : household.policy.recheckMinutes;
  const pickup = household.plan.pickupTime;
  const date = dateKey(now);
  if (!pickup || !(isDayservice ?? isDayserviceDate(household, date))) return base;
  const remaining = minutesBetween(now, jstDate(date, pickup));
  if (remaining <= 0) return base;            // お迎え後は逆算しない
  const half = Math.floor(remaining / 2);
  if (half >= base) return base;              // 残りに余裕がある
  return Math.max(5, half);
}

// ---------------------------------------------------------------------------
// criteria v2 の再確認の間隔・上限・就寝時間帯
// ---------------------------------------------------------------------------

/** 返事が無いときの再確認の間隔（criteria 3-3 ★7: 初回から 15 分後、30 分後） */
export const NO_ANSWER_RECHECK_MINUTES = 15;
/** 予定が無い日の「まだ」の再確認の間隔（criteria 3-1 ★4） */
export const NO_SCHEDULE_RECHECK_MINUTES = 30;
/** 再確認の上限の既定（criteria 5 節 ★3: 初回＋再確認 2 回 = 計 3 回） */
export const DEFAULT_MAX_RECHECKS = 2;
/** 就寝時間帯の既定（criteria 3-3 ★8。docs/03 の 21:00 の声かけは含めない） */
export const DEFAULT_SLEEP_HOURS = { from: '21:30', to: '07:30' } as const;

/** 再確認の上限。policy.maxRechecks があればそれ、無ければ recheckOnce（1 回）／そうでなければ 2 回 */
export function maxRechecksOf(household: Household): number {
  const m = household.policy.maxRechecks;
  if (typeof m === 'number' && Number.isFinite(m) && m >= 0) return Math.floor(m);
  return household.policy.recheckOnce ? 1 : DEFAULT_MAX_RECHECKS;
}

/** 就寝時間帯（未設定なら既定 21:30〜07:30） */
export function sleepHoursOf(household: Household): { from: string; to: string } {
  return household.policy.sleepHours ?? DEFAULT_SLEEP_HOURS;
}

/** 就寝時間帯に入っているか（声かけをしない・無反応判定の対象外） */
export function inSleepHours(household: Household, d: Date): boolean {
  return inQuietHours(d, sleepHoursOf(household));
}

/**
 * 再確認までの分（criteria v2 3-1・3-3）。
 *  - 返事なし … 常に 15 分（次も 15 分。初回から 30 分で 3 回目）
 *  - まだ・判定できない … デイの日はお迎えから逆算（recheckDelayMinutes）、予定が無い日は計画の recheckMinutes、無ければ 30 分
 */
export function recheckIntervalMinutes(
  household: Household,
  item: PlanItem | undefined,
  task: TaskKey,
  status: Classification,
  isDayservice: boolean,
  now: Date,
): number {
  if (status === 'no_answer') return NO_ANSWER_RECHECK_MINUTES;
  if (!isDayservice) {
    // 家族が計画で時刻を決めている項目（docs/03 の 8:05→8:20 など）はそれを優先し、無ければ 30 分（criteria ★4）
    return item?.recheckMinutes && item.recheckMinutes > 0 ? item.recheckMinutes : NO_SCHEDULE_RECHECK_MINUTES;
  }
  return recheckDelayMinutes(household, item, task, now, isDayservice);
}
