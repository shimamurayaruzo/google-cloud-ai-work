// 声かけ計画: 曜日による雛形の選択、既定の文言、再確認までの分の決め方。
// 文言の出所は docs/03_声かけ計画_初期値.md。

import { dateKey, hhmm, jstDate, minutesBetween, toMinutes, weekdayKey } from '../time.js';
import type { DateKey, Household, PlanItem, TaskKey } from '../types.js';

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
): number {
  const base = item?.recheckMinutes && item.recheckMinutes > 0 ? item.recheckMinutes : household.policy.recheckMinutes;
  const pickup = household.plan.pickupTime;
  const date = dateKey(now);
  if (!pickup || !isDayserviceDate(household, date)) return base;
  const remaining = minutesBetween(now, jstDate(date, pickup));
  if (remaining <= 0) return base;            // お迎え後は逆算しない
  const half = Math.floor(remaining / 2);
  if (half >= base) return base;              // 残りに余裕がある
  return Math.max(5, half);
}
