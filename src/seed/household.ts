// 世帯の初期値。出所は docs/03_声かけ計画_初期値.md（家族からの聞き取り、2026-09-26 版）。
// 文言と時刻は docs/03 の表をそのまま入れている。変えるときは docs/03 を先に直す。
//
// PlanItem の決まり（この世帯の雛形での使い方）:
//   recheckMinutes: 0   … 「1回のみ」。再確認しない（state/turn.ts が recheckAllowed=false にする）
//   escalate: false     … 取れなくても家族へは通知せず、夕方の要約にだけ載せる
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
      recheckOnce: true,
      recheckMinutes: 15,
      quietHours: { from: '21:30', to: '07:30' },
    },
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
