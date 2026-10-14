// 朝の流れ（モーニング・シーケンス。docs/03 §5、2026-10-14 家族の要望）。
//
// 2026-10-14 の本番: 8:00 の起床の声かけに返事が無いまま、8:05 に時刻どおり「おむつを替えましょうか」が出て、
// 起きていないのに計画の時刻で進んでしまった。そこで policy.morning.enabled の日は、
//   ① 起こす（名前を呼ぶ。緊迫感のある言い方を 3 つ順に。返事があるまで wakeRepeatMinutes（1）分おき、最大 wakeMaxRepeats（60）回）
//   ② おむつ（diaper） ③ 洗顔・歯磨き（face。done なら teeth も done） ④ 着替え（dress。デイの日は文言が変わる）
// を、本人の返事があってから順に進める。②〜④は「まだ」・返事なし・判定できないなら stepRepeatMinutes 分後に同じ声かけ
// （最大 stepMaxRepeats 回）。上限に達したら家族へ確認のお願い（check）を 1 回だけ送り、その工程で待つ（勝手に進まない）。
// 家族がその通知を「確認した」にしたら、同じ工程の声かけをもう一度始める。endTime を過ぎたら、またはお迎え（pickup）の
// 声かけを話したら朝の流れを終える（cutoff）。残りの工程は夕方の要約に「未確認」として載る（state/summary.ts）。
//
// 工程①への返事は規則だけで 3 種類に分ける（classifyWakeReply。2026-10-14 夜の家族の要望。LLM の分類は使わない）:
//   起きた（はい・おはよう・起きた 等）→ 工程②へ ／ 起きたくない（まだ寝る・眠い・いや 等）→ 工程①のまま、一言は refuseSay、
//   1 分おきの起こす声かけを続ける ／ 体調が悪い（具合が悪い・しんどい・痛い 等。痛み・L4 の語は rules が先に拾う）→ 一言は
//   「分かりました。無理をしないで、横になっていてください」、家族へ check を 1 回（痛み・至急の通知を出したターンはそれだけ）、
//   起こす声かけを止めて朝の流れを終える（cutoff）。どれでもない返事（テレビの音・判定できない）は起きたとみなさず続ける（一言なし）。
// 工程②〜④で not_yet（「まだ」「今から替える」「着替えます」）のときは、一言「では、できたら教えてくださいね」（notYetSay）、
// stepFollowupMinutes（2）分後に確認の言い回し（「おむつは替えられましたか？」等。followupTexts）で聞く。返事なしは 5 分後に元の声かけ。
//
// 朝の流れの繰り返しは、起こすための繰り返しであって無反応の異常検知ではないので、基準 v2 の段階表（L3/L4。state/machine.ts）
// には乗せない。L4 の語（転んだ・助けて等）・痛みの言葉はいつもどおり（会話ターンの通知がそのまま出る）。
//
// 時刻ベースの声かけとの関係: planDay は 8:00〜10:30 の greeting / diaper / teeth / face / dress / belongings を作らない。
// それ以外（pickup・昼・夕など）は今までどおり時刻で出る。

import { detectL4, detectPain, isLikelyNotPerson } from '../agent/rules.js';
import { logEvent } from '../log.js';
import type { AppContext, TurnOutcome } from '../services.js';
import { addMinutes, hhmm, hm, spokenTime } from '../time.js';
import {
  type Classification, type DateKey, type Day, type DayMorning, type Household, type HouseholdId,
  type MorningPolicy, type Notice, type PlanItem, type Prompt, type TaskKey, type TaskRecord, type TurnId,
} from '../types.js';
import { deliverPrompt, enqueuePrompt } from './day.js';
import { appendLedger, excerpt } from './ledger.js';
import { emptyRecord, transition } from './machine.js';
import { safeNotify } from './turn.js';

export const DEFAULT_MORNING_POLICY: Readonly<MorningPolicy> = {
  enabled: true, startTime: '08:00', endTime: '10:30',
  wakeRepeatMinutes: 1, wakeMaxRepeats: 60, stepRepeatMinutes: 5, stepMaxRepeats: 6, stepFollowupMinutes: 2,
};

/**
 * 起こす声かけの既定（2026-10-14 家族の追加の要望: 緊迫感のある言い方、名前を毎回呼ぶ、回数で少し強める）。
 * 1 回目から順に使い、最後まで行ったら最初に戻る。{name} は wakeName（無ければ callName）、{hour} はその時刻の「時」
 */
export const DEFAULT_WAKE_TEXTS: readonly string[] = [
  '{name}！ おはようございます。朝の {hour} 時です。起きてください',
  '{name}、起きてください。朝ですよ',
  '{name}！ 聞こえますか。起きる時間です',
];

/** 朝の流れが時刻ベースの声かけの代わりに受け持つ項目（この時間帯の計画の声かけは作らない） */
export const MORNING_PLAN_TASKS: readonly TaskKey[] = ['greeting', 'diaper', 'teeth', 'face', 'dress', 'belongings'];
/** 工程 1〜4 の項目 */
export const MORNING_STEP_TASKS: readonly TaskKey[] = ['greeting', 'diaper', 'face', 'dress'];
export const MORNING_LAST_STEP = MORNING_STEP_TASKS.length;
/** 家族への文面で使う工程の名前 */
export const MORNING_STEP_LABELS: readonly string[] = ['起こす声かけ', 'おむつ', '洗顔・歯磨き', '着替え'];

export const MORNING_DIAPER_TEXT = 'おむつやパンツは濡れていませんか？ 新しいのに替えましょうか';
export const MORNING_FACE_TEXT = '顔を洗って、歯を磨きましょうね';
export const MORNING_DRESS_TEXT = 'お着替えをしましょうか';
/** 起きた（工程①に「起きた」の返事があった）ときの一言（会話ターンが done と判定しなかったときに使う） */
export const MORNING_AWAKE_SAY = 'おはようございます。';
/** 工程①に「起きたくない」「まだ寝たい」等のときの一言（policy.morning.refuseSay で変えられる） */
export const MORNING_REFUSE_SAY = 'がんばって起きてください。それとも体調が悪いのですか？';
/** 工程①に「体調が悪い」等のときの一言。家族に知らせたことは本人に言わない */
export const MORNING_UNWELL_SAY = '分かりました。無理をしないで、横になっていてください';
/** そのときの家族への確認のお願い（check）の理由 */
export const MORNING_UNWELL_REASON = '起こしの声かけに『体調が悪い』とのお返事です';
/** 工程②〜④で not_yet のときの一言（policy.morning.notYetSay で変えられる） */
export const MORNING_NOT_YET_SAY = 'では、できたら教えてくださいね';
/** 工程②〜④で not_yet のあと stepFollowupMinutes 分後に出す確認の言い回し（policy.morning.followupTexts で変えられる） */
export const MORNING_FOLLOWUP_TEXTS: Readonly<Partial<Record<TaskKey, string>>> = {
  diaper: 'おむつは替えられましたか？',
  face: 'お顔と歯磨きはできましたか？',
  dress: 'お着替えはできましたか？',
};

// ---- 工程①（起こす）への返事の 3 種類（規則のみ。部分一致。体調が悪い → 起きたくない → 起きた の順に見る） ----
// 痛み・L4 の語は rules の detectPain / detectL4 でも拾う（通知は会話ターンの check / urgent）。テレビ等の印は isLikelyNotPerson。
// 「起きたくない」は「起きた」を含むので、起きたくない側を先に見る。

/** 体調が悪い（家族へ check、起こす声かけを止めて朝の流れを終える） */
export const WAKE_UNWELL_WORDS: readonly string[] = [
  '体調が悪い', '体調悪い', '具合が悪い', '具合悪い', 'ぐあいがわるい', '気分が悪い', '気分悪い',
  '気持ち悪い', '気持ちが悪い', 'きもちわるい', '調子が悪い', '調子悪い', 'しんどい', 'だるい', 'ダルい',
  '頭が痛い', '痛い', '熱がある', '熱っぽい', '吐き気', 'はきけ',
];
/** 起きたくない・まだ寝たい（工程①のまま、一言は refuseSay、起こす声かけは続ける） */
export const WAKE_REFUSE_WORDS: readonly string[] = [
  '起きたくない', 'おきたくない', '起きない', 'おきない', '起きられない', '起きれない', 'おきれない',
  'まだ', '寝かせて', 'ねかせて', '寝たい', 'ねたい', '寝ていたい', '寝てたい',
  '眠い', 'ねむい', '眠たい', 'ねむたい', '疲れた', 'つかれた', 'くたびれた',
  'いや', '嫌', 'ううん', 'いいえ', 'あとで', '後で', '待って', 'まって', 'もうちょっと', 'もう少し', 'もうすこし', 'うるさい',
];
/** 起きた（工程②へ） */
export const WAKE_AWAKE_WORDS: readonly string[] = [
  '起きた', 'おきた', '起きてる', 'おきてる', '起きてます', '起きました', '起きます', 'おきます', '起きる', 'おきる',
  'はい', 'はーい', 'うん', 'ええ', 'おはよう', '分かった', 'わかった', '分かりました', 'わかりました', '了解',
];

/** 工程①への返事の種類。no_answer は返事なし、none は起きたとみなさない返事（テレビの音・判定できない） */
export type WakeReply = 'awake' | 'refuse' | 'unwell' | 'none' | 'no_answer';

/** 工程①（起こす）への返事を分ける（規則のみ） */
export function classifyWakeReply(replyText: string | null | undefined): WakeReply {
  const t = (replyText ?? '').trim();
  if (!t) return 'no_answer';
  if (isLikelyNotPerson(t)) return 'none';
  if (detectL4(t) || detectPain(t) || WAKE_UNWELL_WORDS.some(w => t.includes(w))) return 'unwell';
  if (WAKE_REFUSE_WORDS.some(w => t.includes(w))) return 'refuse';
  if (WAKE_AWAKE_WORDS.some(w => t.includes(w))) return 'awake';
  return 'none';
}

const WAKE_STATUS: Record<WakeReply, Classification> = {
  awake: 'done', refuse: 'not_yet', unwell: 'not_yet', none: 'unclear', no_answer: 'no_answer',
};
const WAKE_NOTE: Record<WakeReply, string> = {
  awake: '起きた', refuse: '起きたくない', unwell: '体調が悪い', none: '起きたか分からない', no_answer: '返事なし',
};

/** 工程②〜④の「これからする」（「今から替える」「着替えます」）。済んだの言い方（〜た・ました・済んだ）があれば当てない */
const WILL_DO = /今から|いまから|これから|ます(よ|ね|わ)?[。！!]?$|(する|やる|替える|かえる|着る|洗う|あらう|磨く|みがく)(よ|ね|わ|から)?[。！!]?$/;
const PAST_DONE = /た(よ|ね|わ|の|って)?([。！!、]|$)|ました|済|すんだ|終わ|おわ/;

/**
 * 朝の流れの声かけへの会話ターンの分類を、朝の流れの決まりで揃える（turn.ts から。L4・痛み・連絡の依頼の intents はそのまま）。
 *  工程①: classifyWakeReply の結果で status を決める（起きた → done、起きたくない・体調が悪い → not_yet、どれでもない → unclear）
 *  工程②〜④: 「今から替える」「着替えます」のような「これからする」は not_yet にする
 */
export function normalizeMorningOutcome(
  step: number, replyText: string | null, outcome: TurnOutcome,
): { outcome: TurnOutcome; wake?: WakeReply } {
  const text = (replyText ?? '').trim();
  let status: Classification | null = null;
  let note = '';
  let wake: WakeReply | undefined;
  if (step === 1) {
    wake = classifyWakeReply(replyText);
    status = WAKE_STATUS[wake];
    note = wake === 'no_answer' ? '返事なし' : `起こす声かけ: ${WAKE_NOTE[wake]}「${excerpt(text, 16)}」`;
  } else if (text && outcome.classified.status !== 'not_yet' && outcome.classified.status !== 'no_answer'
    && !isLikelyNotPerson(text) && WILL_DO.test(text) && !PAST_DONE.test(text)) {
    status = 'not_yet';
    note = `これからする「${excerpt(text, 16)}」`;
  }
  if (status == null) return { outcome };
  const confidence = status === 'unclear' ? 0.5 : 1;
  const st = status;
  const task = morningStepTask(step);
  const intents = outcome.intents.map(i => (i.type === 'record' && i.task === task ? { ...i, status: st, note, confidence } : i));
  return {
    outcome: { ...outcome, classified: { status: st, note, by: 'rules', confidence, uncertain: confidence < 0.7 }, intents },
    ...(wake ? { wake } : {}),
  };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function intOr(v: unknown, fallback: number, min = 1): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.round(v) : fallback;
}

/** 朝の流れの設定。未設定なら既定（enabled: true）。項目ごとに足りないものも既定で埋める */
export function morningPolicyOf(h: Pick<Household, 'policy'>): MorningPolicy {
  const m: Partial<MorningPolicy> = h.policy?.morning ?? {};
  const d = DEFAULT_MORNING_POLICY;
  return {
    enabled: typeof m.enabled === 'boolean' ? m.enabled : d.enabled,
    startTime: typeof m.startTime === 'string' && HHMM_RE.test(m.startTime) ? m.startTime : d.startTime,
    endTime: typeof m.endTime === 'string' && HHMM_RE.test(m.endTime) ? m.endTime : d.endTime,
    wakeRepeatMinutes: intOr(m.wakeRepeatMinutes, d.wakeRepeatMinutes),
    wakeMaxRepeats: intOr(m.wakeMaxRepeats, d.wakeMaxRepeats),
    stepRepeatMinutes: intOr(m.stepRepeatMinutes, d.stepRepeatMinutes),
    stepMaxRepeats: intOr(m.stepMaxRepeats, d.stepMaxRepeats),
    stepFollowupMinutes: intOr(m.stepFollowupMinutes, d.stepFollowupMinutes),
    ...(Array.isArray(m.wakeTexts) && m.wakeTexts.some(t => typeof t === 'string' && t.trim())
      ? { wakeTexts: m.wakeTexts.filter(t => typeof t === 'string' && t.trim()) } : {}),
    ...(typeof m.refuseSay === 'string' && m.refuseSay.trim() ? { refuseSay: m.refuseSay.trim() } : {}),
    ...(typeof m.notYetSay === 'string' && m.notYetSay.trim() ? { notYetSay: m.notYetSay.trim() } : {}),
    ...(m.followupTexts && typeof m.followupTexts === 'object' ? followupTextsOf(m.followupTexts) : {}),
  };
}

function followupTextsOf(v: Partial<Record<TaskKey, string>>): { followupTexts?: Partial<Record<TaskKey, string>> } {
  const out: Partial<Record<TaskKey, string>> = {};
  for (const [k, t] of Object.entries(v)) if (typeof t === 'string' && t.trim()) out[k as TaskKey] = t.trim();
  return Object.keys(out).length > 0 ? { followupTexts: out } : {};
}

/** 工程①で「起きたくない」等のときの一言 */
export function refuseSayOf(h: Pick<Household, 'policy'>): string {
  return morningPolicyOf(h).refuseSay ?? MORNING_REFUSE_SAY;
}

/** 工程②〜④で not_yet のときの一言 */
export function notYetSayOf(h: Pick<Household, 'policy'>): string {
  return morningPolicyOf(h).notYetSay ?? MORNING_NOT_YET_SAY;
}

/** 起こす声かけの n 回目（1 始まり）の文言 */
export function wakeText(household: Household, n: number, now: Date): string {
  const p = morningPolicyOf(household);
  const texts = p.wakeTexts ?? DEFAULT_WAKE_TEXTS;
  const tpl = texts[(Math.max(1, n) - 1) % texts.length];
  const name = household.person.wakeName?.trim() || household.person.callName?.trim() || '';
  const hour = String(Number(hhmm(now).slice(0, 2)));
  const named = name ? tpl.replace(/\{name\}/g, name) : tpl.replace(/\{name\}[、！!,]?\s*/g, '');
  return named.replace(/\{hour\}/g, hour);
}

/** "HH:MM" が朝の流れの時間帯（startTime 以上 endTime 未満）か */
export function inMorningWindow(policy: MorningPolicy, time: string): boolean {
  return time >= policy.startTime && time < policy.endTime;
}

/** planDay で作らない計画の項目か（朝の流れが有効で、受け持つ項目が時間帯に入っている） */
export function replacedByMorning(h: Pick<Household, 'policy'>, item: PlanItem): boolean {
  const p = morningPolicyOf(h);
  return p.enabled && MORNING_PLAN_TASKS.includes(item.task) && inMorningWindow(p, item.time);
}

export function morningStepTask(step: number): TaskKey {
  return MORNING_STEP_TASKS[Math.min(Math.max(step, 1), MORNING_LAST_STEP) - 1];
}

function stepLabel(step: number): string {
  return MORNING_STEP_LABELS[Math.min(Math.max(step, 1), MORNING_LAST_STEP) - 1];
}

function repeatMinutesOf(p: MorningPolicy, m: Pick<DayMorning, 'step' | 'awaitingDone'>): number {
  if (m.step === 1) return p.wakeRepeatMinutes;
  return m.awaitingDone ? p.stepFollowupMinutes : p.stepRepeatMinutes;
}

function maxRepeatsOf(p: MorningPolicy, step: number): number {
  return step === 1 ? p.wakeMaxRepeats : p.stepMaxRepeats;
}

/**
 * 工程の声かけの文言。n はその工程で何回目か（1 始まり。起こす声かけの言い方を変えるのに使う）。
 * followup は工程②〜④で not_yet のあとの確認の言い回し（「おむつは替えられましたか？」等）
 */
export function morningStepText(step: number, household: Household, isDayservice: boolean, now: Date, n = 1, followup = false): string {
  if (followup && step >= 2) {
    const task = morningStepTask(step);
    const t = morningPolicyOf(household).followupTexts?.[task] ?? MORNING_FOLLOWUP_TEXTS[task];
    if (t) return t;
  }
  switch (step) {
    case 1: return wakeText(household, n, now);
    case 2: return MORNING_DIAPER_TEXT;
    case 3: return MORNING_FACE_TEXT;
    default: {
      if (!isDayservice) return MORNING_DRESS_TEXT;
      const pickup = household.plan.pickupTime;
      const when = pickup && HHMM_RE.test(pickup) ? `${spokenTime(pickup)}にお迎えが来ます。` : 'お迎えが来ます。';
      return `今日はデイサービスで出かける日ですよ。${when}お着替えをしましょう`;
    }
  }
}

/** 朝の流れがまだ続いているか（始まっていて、終わっていない） */
export function morningActive(day: Pick<Day, 'morning'>): boolean {
  return Boolean(day.morning && day.morning.result == null);
}

/** 終えたときに「未確認」になる項目（いまの工程から後ろ。③は歯磨きも）。既に済んだ項目は除く */
export function remainingMorningTasks(day: Pick<Day, 'morning' | 'tasks'>): TaskKey[] {
  const m = day.morning;
  if (!m || m.result === 'done') return [];
  const out: TaskKey[] = [];
  for (let s = m.step; s <= MORNING_LAST_STEP; s += 1) {
    const t = morningStepTask(s);
    const keys: TaskKey[] = t === 'face' ? ['face', 'teeth'] : [t];
    for (const k of keys) if (day.tasks[k]?.state !== 'done') out.push(k);
  }
  return out;
}

function asDate(v: Date | string | undefined): Date | undefined {
  if (v == null) return undefined;
  return v instanceof Date ? v : new Date(v);
}

async function saveMorning(ctx: Pick<AppContext, 'store'>, hh: HouseholdId, date: DateKey, m: DayMorning): Promise<void> {
  await ctx.store.updateDay(hh, date, { morning: m });
}

/** 朝の流れを終える（台帳 morning_finished）。既に終わっていれば何もしない */
export async function finishMorning(
  ctx: Pick<AppContext, 'store'>,
  hh: HouseholdId,
  date: DateKey,
  day: Pick<Day, 'morning' | 'tasks'>,
  result: 'done' | 'cutoff' | 'timeout',
  now: Date,
  why?: string,
): Promise<DayMorning | null> {
  const m = day.morning;
  if (!m || m.result != null) return null;
  const remaining = result === 'done' ? [] : remainingMorningTasks(day);
  const next: DayMorning = { ...m, result, finishedAt: now };
  await saveMorning(ctx, hh, date, next);
  day.morning = next;
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'system', name: 'morning_finished',
    args: { result, step: m.step, remaining, ...(why ? { why } : {}) },
  });
  logEvent('morning_finished', { hh, date, result, step: m.step, remaining, why: why ?? null });
  return next;
}

/** endTime を過ぎていて、まだ続いていれば cutoff で終える（nextPrompt の最初に呼ぶ） */
export async function closeMorningIfOver(
  ctx: Pick<AppContext, 'store'>, household: Household, day: Day, now: Date,
): Promise<void> {
  if (!morningActive(day)) return;
  const p = morningPolicyOf(household);
  if (hhmm(now) >= p.endTime) {
    await finishMorning(ctx, household.id, day.date, day, 'cutoff', now, 'end_time');
  }
}

/** 上限に達したときの家族への確認のお願い（1 回だけ）。送れたら通知を返す */
async function notifyCapped(
  ctx: Pick<AppContext, 'store' | 'familyNotify'>,
  household: Household,
  day: Pick<Day, 'date'>,
  m: DayMorning,
  now: Date,
  turnId: TurnId | null,
  lastReply?: { text: string | null; status: Classification },
): Promise<Notice | null> {
  const since = asDate(m.startedAt) ?? now;
  const step = m.step;
  const reply = lastReply?.text && lastReply.status !== 'unclear' ? `（最後のお返事「${excerpt(lastReply.text, 20)}」）` : '';
  const stepSince = step === 1 ? `${hm(since)} から` : '';
  return safeNotify(ctx, {
    hh: household.id, date: day.date, level: 'check', origin: 'other', task: morningStepTask(step), turnId, now,
    reason: `朝の声かけに返事がありません（${stepLabel(step)}）`,
    evidence: `${stepSince}${stepLabel(step)}を ${m.repeats} 回声をかけました${reply}`,
  });
}

/**
 * nextPrompt から呼ぶ。朝の流れの時間帯で、まだ終わっていなければ、いまの工程の声かけを作って話す。
 * handled が true のときは、prompt が null でも他の声かけ（ときたまの声かけ）を出さない（朝の流れの最中なので）。
 * 呼ぶ側で、寝室モード・就寝時間帯外・L4 でない・killSwitch でないことを確かめておく。
 */
export async function nextMorningPrompt(
  ctx: AppContext,
  household: Household,
  day: Day,
  now: Date,
): Promise<{ handled: boolean; prompt: Prompt | null }> {
  const p = morningPolicyOf(household);
  if (!p.enabled) return { handled: false, prompt: null };
  if (!inMorningWindow(p, hhmm(now))) return { handled: false, prompt: null };
  const hh = household.id;
  const date = day.date;
  let m = day.morning;
  if (m && m.result != null) return { handled: false, prompt: null };
  if (!m) {
    m = { step: 1, startedAt: now, repeats: 0, result: null };
    await appendLedger(ctx, {
      hh, date, at: now, kind: 'system', name: 'morning_step',
      args: { step: 1, task: morningStepTask(1), result: 'started' },
    });
    logEvent('morning_started', { hh, date });
  }

  const last = asDate(m.stepAskedAt);
  if (last && now.getTime() < addMinutes(last, repeatMinutesOf(p, m)).getTime()) {
    if (m !== day.morning) { await saveMorning(ctx, hh, date, m); day.morning = m; }
    return { handled: true, prompt: null };
  }

  if (m.repeats >= maxRepeatsOf(p, m.step)) {
    // 上限: 家族へ 1 回だけ確認のお願い。以後はこの工程で待つ。家族が「確認した」を押したら、同じ工程をもう一度始める
    if (!m.notified) {
      const n = await notifyCapped(ctx, household, day, m, now, null);
      m = { ...m, notified: true, ...(n ? { noticeId: n.id } : {}) };
      await saveMorning(ctx, hh, date, m);
      day.morning = m;
      await appendLedger(ctx, {
        hh, date, at: now, kind: 'system', name: 'morning_step', noticeId: n?.id ?? null,
        args: { step: m.step, task: morningStepTask(m.step), result: 'notified', repeats: m.repeats },
      });
      return { handled: true, prompt: null };
    }
    const notice = m.noticeId ? await ctx.store.getNotice(hh, m.noticeId) : null;
    if (!notice || (notice.state !== 'acked' && notice.state !== 'closed')) return { handled: true, prompt: null };
    // 家族が確認した → 同じ工程の声かけをもう一度（上限の数えは 0 から。確認のお願いは同じ工程では重ねない。
    // noticeId を外すので、もう一度上限に達したら、その後はこの工程で待つ）
    m = { ...m, repeats: 0 };
    delete m.stepAskedAt;
    delete m.noticeId;
    delete m.awaitingDone;
    await appendLedger(ctx, {
      hh, date, at: now, kind: 'system', name: 'morning_step', noticeId: notice.id,
      args: { step: m.step, task: morningStepTask(m.step), result: 'resumed' },
    });
  }

  return { handled: true, prompt: await askMorningStep(ctx, household, day, m, now) };
}

/** いまの工程の声かけを作って話す（数えを 1 つ進める）。再生モードからも使う */
export async function askMorningStep(
  ctx: AppContext,
  household: Household,
  day: Day,
  m: DayMorning,
  now: Date,
): Promise<Prompt> {
  const hh = household.id;
  const date = day.date;
  const task = morningStepTask(m.step);
  const text = morningStepText(m.step, household, day.isDayservice, now, m.repeats + 1, Boolean(m.awaitingDone));
  const next: DayMorning = { ...m, repeats: m.repeats + 1, stepAskedAt: now };
  await saveMorning(ctx, hh, date, next);
  day.morning = next;
  const prompt = await enqueuePrompt(ctx, hh, date, task, {
    text, at: now, isRecheck: m.repeats > 0, extra: { morningStep: m.step },
  });
  return deliverPrompt(ctx, prompt, now, { synthesize: true });
}

/** 再生モード用: 朝の流れが無ければ始めて、いまの工程の声かけを（間隔・上限を見ずに）話す。終わっていれば null */
export async function askMorningForReplay(ctx: AppContext, household: Household, day: Day, now: Date): Promise<Prompt | null> {
  if (day.morning && day.morning.result != null) return null;
  const m: DayMorning = day.morning ?? { step: 1, startedAt: now, repeats: 0, result: null };
  return askMorningStep(ctx, household, day, m, now);
}

export interface MorningReplyResult {
  notices: Notice[];
  /** 工程①で起きたとみなしたとき、②〜④で済んだとき */
  advanced: boolean;
  /** 返事を処理したあとの工程（終わったら null） */
  step: number | null;
  /** 工程①への返事の種類（いまの工程①への返事のときだけ。遅れた返事には付けない） */
  wake?: WakeReply;
  /** 工程②〜④で not_yet（一言は notYetSay、stepFollowupMinutes 分後に確認の言い回し） */
  notYet?: boolean;
}

function doneRecord(prev: TaskRecord | undefined, a: { now: Date; turnId: TurnId; replyText: string | null }): TaskRecord {
  const { next } = transition(prev, {
    type: 'classified', status: 'done', at: a.now, turnId: a.turnId, recheckAllowed: false,
    evidence: a.replyText ? excerpt(a.replyText, 30) ?? undefined : undefined,
  });
  return next;
}

/**
 * 朝の流れの声かけへの返事（turn.ts の applyIntents から。会話ターンの分類と L4・痛みの通知は済んでいる）。
 *  工程①: classifyWakeReply で分ける。起きた → greeting を done、工程②へ。起きたくない・どれでもない・返事なし → 工程①で待つ。
 *         体調が悪い → 家族へ check を 1 回（alerted＝痛み・至急の通知を出したターンなら出さない）、朝の流れを cutoff で終える
 *  工程②〜④: done なら項目を done（③は teeth も）にして次へ。それ以外はこの工程で待つ（状態は rechecking）。
 *         not_yet なら awaitingDone（次は stepFollowupMinutes 分後に確認の言い回し）
 *  上限に達して取れなければ、家族へ check を 1 回だけ（notified）。段階表の通知は出さない
 * tasks はその場で書き換える（呼ぶ側の記録と揃えるため）。
 */
export async function applyMorningReply(
  ctx: AppContext,
  a: {
    household: Household; day: Day; prompt: Prompt; tasks: Day['tasks'];
    status: Classification; replyText: string | null; turnId: TurnId; now: Date;
    /** このターンで痛み・至急の通知を出した（体調が悪いの check を重ねない） */
    alerted?: boolean;
  },
): Promise<MorningReplyResult> {
  const { household, prompt, tasks, status, replyText, turnId, now } = a;
  const { hh, date } = prompt;
  const fresh = await ctx.store.getDay(hh, date);
  const m = fresh?.morning ?? a.day.morning;
  const promptStep = prompt.morningStep ?? 0;
  const notices: Notice[] = [];

  const markDone = async (task: TaskKey) => {
    const rec = doneRecord(tasks[task], { now, turnId, replyText });
    tasks[task] = rec;
    await ctx.store.setTask(hh, date, task, rec);
  };

  // 終わった後・別の工程の声かけへの遅れた返事: 済みなら記録だけ（進めない・数えない）
  if (!m || m.result != null || m.step !== promptStep) {
    if (status === 'done' && promptStep === 3) await markDone('teeth');
    await appendLedger(ctx, {
      hh, date, at: now, kind: 'system', name: 'morning_step', turnId,
      args: { step: promptStep, task: prompt.task, result: status, stale: true },
    });
    return { notices, advanced: false, step: m && m.result == null ? m.step : null };
  }

  const step = m.step;
  const task = morningStepTask(step);
  const wake = step === 1 ? classifyWakeReply(replyText) : undefined;
  const awake = step === 1 ? wake === 'awake' : status === 'done';

  if (wake === 'unwell') {
    // 体調が悪い: 起こす声かけを止めて朝の流れを終える。家族へは 1 回だけ（痛み・至急の通知を出したターンは重ねない）
    let n: Notice | null = null;
    if (!a.alerted) {
      n = await safeNotify(ctx, {
        hh, date, level: 'check', origin: 'other', task, turnId, now,
        reason: MORNING_UNWELL_REASON,
        evidence: `${hm(now)} 起こす声かけへのお返事「${excerpt(replyText, 30)}」`,
      });
      if (n) notices.push(n);
    }
    await appendLedger(ctx, {
      hh, date, at: now, kind: 'system', name: 'morning_step', turnId, noticeId: n?.id ?? null,
      args: { step, task, result: status, wake, repeats: m.repeats, ...(n ? { notified: true } : {}) },
    });
    logEvent('morning_step', { hh, date, step, task, result: status, wake, repeats: m.repeats });
    await finishMorning(ctx, hh, date, { morning: m, tasks }, 'cutoff', now, 'unwell');
    return { notices, advanced: false, step: null, wake };
  }

  if (awake) {
    await markDone(task);
    if (task === 'face') await markDone('teeth');
    let nextStep = step + 1;
    // 先に「済んだ」と言われていた工程は飛ばす（例: おむつの声かけに「もう着替えたよ」）
    while (nextStep <= MORNING_LAST_STEP && tasks[morningStepTask(nextStep)]?.state === 'done') nextStep += 1;
    await appendLedger(ctx, {
      hh, date, at: now, kind: 'system', name: 'morning_step', turnId,
      args: { step, task, result: status, repeats: m.repeats, next: nextStep <= MORNING_LAST_STEP ? nextStep : null },
    });
    logEvent('morning_step', { hh, date, step, task, result: status, next: nextStep <= MORNING_LAST_STEP ? nextStep : null });
    if (nextStep > MORNING_LAST_STEP) {
      const day = { morning: m, tasks };
      await finishMorning(ctx, hh, date, day, 'done', now);
      return { notices, advanced: true, step: null };
    }
    const next: DayMorning = { step: nextStep, startedAt: m.startedAt, repeats: 0, result: null };
    await saveMorning(ctx, hh, date, next);
    return { notices, advanced: true, step: nextStep, ...(wake ? { wake } : {}) };
  }

  // 取れなかった: この工程で待つ（rechecking）。上限に達していれば家族へ 1 回だけ
  const rec: TaskRecord = { ...(tasks[task] ?? emptyRecord()), state: 'rechecking' };
  tasks[task] = rec;
  await ctx.store.setTask(hh, date, task, rec);
  // 工程②〜④の not_yet は、次の声かけを stepFollowupMinutes 分後に確認の言い回しで（返事なし・判定できないは元の声かけを 5 分後）
  const notYet = step >= 2 && status === 'not_yet';
  let next: DayMorning = m;
  if (step >= 2 && Boolean(m.awaitingDone) !== notYet) {
    next = { ...m };
    if (notYet) next.awaitingDone = true; else delete next.awaitingDone;
    await saveMorning(ctx, hh, date, next);
  }
  const policy = morningPolicyOf(household);
  if (m.repeats >= maxRepeatsOf(policy, step) && !m.notified) {
    const n = await notifyCapped(ctx, household, { date }, m, now, turnId, { text: replyText, status });
    if (n) notices.push(n);
    next = { ...next, notified: true, ...(n ? { noticeId: n.id } : {}) };
    await saveMorning(ctx, hh, date, next);
  }
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'system', name: 'morning_step', turnId,
    args: {
      step, task, result: status, repeats: m.repeats, ...(wake ? { wake } : {}), ...(notYet ? { awaitingDone: true } : {}),
      ...(next.notified && !m.notified ? { notified: true } : {}),
    },
  });
  logEvent('morning_step', { hh, date, step, task, result: status, repeats: m.repeats, wake: wake ?? null });
  return { notices, advanced: false, step, ...(wake ? { wake } : {}), ...(notYet ? { notYet } : {}) };
}

