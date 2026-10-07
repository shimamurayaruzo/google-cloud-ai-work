// 世帯の初期値。出所は docs/03_声かけ計画_初期値.md（家族からの聞き取り、2026-09-26 版）。
// 文言と時刻は docs/03 の表をそのまま入れている。変えるときは docs/03 を先に直す。
//
// PlanItem の決まり（この世帯の雛形での使い方）:
//   recheckMinutes: 0   … 「1回のみ」。再確認しない（state/machine.ts の oneShot。n=1 で asked のまま終わる）
//   escalate: false     … 取れなくても家族へは通知せず、夕方の要約にだけ載せる（L4 の語・痛みの通知は項目に関係なく出す）
//   再確認の間隔は criteria v2 で状態機械が決める: 返事なしは 15 分、予定の無い日の「まだ」は 30 分、
//   デイの日は recheckMinutes をお迎えから逆算して使う（state/plan.ts の recheckIntervalMinutes）
// 個人情報（LINE の userId、メールアドレス）はここに書かない。家族画面の設定から入れる。

import { config } from '../config.js';
import type { Household, HouseholdId, PlanItem } from '../types.js';

/** デイの日（火・金） */
function dayservicePlan(): PlanItem[] {
  return [
    { time: '08:00', task: 'greeting', text: 'おはようございます。よく眠れましたか？', recheckMinutes: 10, escalate: true },
    { time: '08:05', task: 'diaper', text: 'まず、おむつを新しいのに替えましょうか', recheckMinutes: 15, escalate: true },
    { time: '08:15', task: 'teeth', text: '歯を磨きましょう', recheckMinutes: 15, escalate: false },
    { time: '08:25', task: 'face', text: '顔を洗ってさっぱりしましょう', recheckMinutes: 15, escalate: false },
    { time: '08:35', task: 'dress', text: '今日はデイサービスの日です。9時にお迎えが来ます。お着替えは済みましたか？', recheckMinutes: 10, escalate: true },
    { time: '08:50', task: 'belongings', text: '持ち物はかばんに入っていますか？', recheckMinutes: 0, escalate: false },
    { time: '09:00', task: 'pickup', text: 'お迎えは来ましたか？', recheckMinutes: 15, escalate: true },
    // 9:30〜16:00 は不在。声かけなし（端末の生存監視のみ）
    { time: '16:00', task: 'return', text: 'おかえりなさい。今日はどうでしたか？', recheckMinutes: 20, escalate: true },
    { time: '16:30', task: 'water', text: 'お茶を一杯どうですか？', recheckMinutes: 0, escalate: false },
    // 18:00 は家族へ「今日の様子」（声かけではない）
    { time: '19:00', task: 'dinner', text: '夕ご飯は食べましたか？', recheckMinutes: 30, escalate: false },
    { time: '19:40', task: 'medicine', text: 'ご飯のあとのお薬を飲みましょう。黒い机の上に 2 錠あります', recheckMinutes: 20, escalate: true },
    // 夜は家族へ通知しない（翌朝の要約に載せる）
    { time: '21:00', task: 'bedtime', text: '歯を磨いて、そろそろお休みしましょう', recheckMinutes: 20, escalate: false },
  ];
}

/** デイ以外の日（週末も同じ） */
function defaultPlan(): PlanItem[] {
  return [
    { time: '08:00', task: 'greeting', text: 'おはようございます。よく眠れましたか？', recheckMinutes: 10, escalate: true },
    { time: '08:05', task: 'diaper', text: 'まず、おむつを新しいのに替えましょうか', recheckMinutes: 15, escalate: true },
    { time: '08:15', task: 'teeth', text: '歯を磨きましょう', recheckMinutes: 15, escalate: false },
    { time: '08:25', task: 'face', text: '顔を洗ってさっぱりしましょう', recheckMinutes: 15, escalate: false },
    { time: '08:40', task: 'dress', text: 'お着替えは済みましたか？', recheckMinutes: 15, escalate: true },
    { time: '10:30', task: 'water', text: 'お茶を一杯どうですか？', recheckMinutes: 0, escalate: false },
    { time: '12:00', task: 'lunch', text: 'お昼ご飯は食べましたか？何を食べましたか？', recheckMinutes: 30, escalate: true },
    // 14:30 の思い出モードは提出版に入れない（docs/01 §5.4）
    { time: '15:30', task: 'water', text: 'お茶を一杯どうですか？', recheckMinutes: 0, escalate: false },
    { time: '19:00', task: 'dinner', text: '夕ご飯は食べましたか？', recheckMinutes: 30, escalate: false },
    { time: '19:40', task: 'medicine', text: 'ご飯のあとのお薬を飲みましょう。黒い机の上に 2 錠あります', recheckMinutes: 20, escalate: true },
    { time: '21:00', task: 'bedtime', text: '歯を磨いて、そろそろお休みしましょう', recheckMinutes: 20, escalate: false },
  ];
}

export function defaultHousehold(id: HouseholdId = config.defaultHouseholdId): Household {
  return {
    id,
    name: '島村家',
    timezone: 'Asia/Tokyo',
    person: {
      callName: 'お母さん',
      wording: {
        diaper: 'おむつ',
        medicine: '脳の薬',
        medicinePlace: '黒い机の上',
        medicineCount: '2 錠',
      },
    },
    members: [{ id: 'mem_1', name: '島村', order: 1, waitMinutes: 10 }],
    plan: {
      weekday: { default: defaultPlan(), dayservice: dayservicePlan() },
      dayserviceDays: ['Tue', 'Fri'],
      pickupTime: '09:00',
    },
    policy: {
      // recheckOnce は互換のため残す。maxRechecks があればそちらが優先（criteria v2 5 節: 初回＋再確認 2 回 = 計 3 回）
      recheckOnce: true,
      maxRechecks: 2,
      recheckMinutes: 15,
      // 通知を翌朝に回す時間帯（L2/L3）
      quietHours: { from: '21:30', to: '07:30' },
      // 就寝時間帯（声かけをしない・無反応判定の対象外。criteria 3-3 ★8。21:00 の声かけは含めない）
      sleepHours: { from: '21:30', to: '07:30' },
    },
    // 通知文に書く連絡先（家の電話・近くの人）は個人情報なのでここには書かない。家族画面の設定から入れる
    killSwitch: false,
  };
}

/** 審査員向けのデモ世帯（中身は同じ計画。名前と ID だけ分ける） */
export function demoHousehold(): Household {
  return {
    ...defaultHousehold('hh_demo'),
    name: 'テスト世帯',
    members: [{ id: 'mem_demo_1', name: 'テスト家族', order: 1, waitMinutes: 10 }],
  };
}
