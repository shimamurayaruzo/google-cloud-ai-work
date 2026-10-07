// 起動モード（docs/02 §11）: 寝室（bedroom）とお風呂（bath）。切り替えは家族が iPad の画面か家族画面から行う。
// 時刻による自動切替はしない（お風呂から寝室への自動の戻りだけは、お風呂の流れの最後に /internal/bath-return で行う）。
//
// お風呂モード（§11.3。iPad は脱衣所。安全確認の場にしない）:
//   切替直後          「お風呂の時間ですね。ゆっくりどうぞ」（返事は聞かない）。寝室の声かけは配信しない（queued のまま）
//   +washAfterMinutes 「そろそろ体を洗いましょうか」
//                       はい等 → washDoneAt、家族へ L2 info「体を洗い始めました」（origin bath）、本人には「ゆっくりどうぞ」
//                       まだ   → recheckMinutes（2 分）後に再確認を 1 回
//                       返事なし → 2 分後に再確認。それも返事なしなら L3 check「お風呂で声かけに返事がありません。様子を見に行ってください」
//                                 L4 にはしない（criteria 3-3「入浴中の無反応」。基準 v2 の段階表ではなく、この流れを使う）
//   +teethAfterMinutes「歯を磨きましょう」… 記録のみ。通知しない
//   +returnAfterMinutes 寝室へ自動で戻す（by system）。「ゆっくり休んでくださいね」
//   お風呂の間の L4 の語・痛みの語は寝室と同じ（urgent / check）。
//
// 寝室モードの「ときたまの声かけ」（§11.2）: 直近 idleChatMinutes 分に声かけが無く、前後 45 分に計画の声かけも無いとき、
//   talk の軽い声かけを 1 つ（時刻と曜日／お水）。返事は求めない。就寝時間帯・L4 中・お風呂の間・デイで不在の間は出さない。

import { logError, logEvent } from '../log.js';
import type { AppContext } from '../services.js';
import { addMinutes, dateKey, hhmm, hm, jaWeekday, spokenTime, toMinutes } from '../time.js';
import {
  newId, type BathPolicy, type BathState, type BathStep, type Classification, type Day, type Expression, type Household,
  type HouseholdId, type HouseholdMode, type LedgerEntry, type ModeChangedBy, type Notice, type Prompt, type ReplySource,
  type TaskKey, type TaskRecord, type Turn,
} from '../types.js';
import {
  L4_SAY, PAIN_FOLLOWUP_MINUTES, PAIN_SAY, analyzeReply, excerpt as ruleExcerpt, l4Reason, painFollowupText, painReason,
  rulesConfidence,
} from '../agent/rules.js';
import { deliverPrompt, enqueuePrompt } from './day.js';
import { NotFoundError } from './errors.js';
import { appendLedger, excerpt } from './ledger.js';
import { startL4 } from './l4.js';
import { emptyRecord } from './machine.js';
import { inSleepHours } from './plan.js';
import { TURN_TTL_MINUTES, safeNotify, scheduleFollowup, type ProcessReplyResult } from './turn.js';
import { currentWhereabouts, whereaboutsSay } from './whereabouts.js';

export const DEFAULT_BATH_POLICY: Readonly<BathPolicy> = {
  washAfterMinutes: 10, teethAfterMinutes: 15, returnAfterMinutes: 10, recheckMinutes: 2, notifyAfterMinutes: 5,
};
export const DEFAULT_IDLE_CHAT_MINUTES = 90;
/** ときたまの声かけを出さない「計画の声かけの前後」の幅（分） */
export const IDLE_CHAT_PLAN_MARGIN_MINUTES = 45;
/** 寝室に戻ったとき、これより前に期限が来ていた寝室の声かけは話さない（expired） */
export const STALE_BEDROOM_MINUTES = 30;

export const BATH_START_SAY = 'お風呂の時間ですね。ゆっくりどうぞ';
export const BATH_WASH_TEXT = 'そろそろ体を洗いましょうか';
export const BATH_WASH_RECHECK_TEXT = '体を洗えそうですか？';
export const BATH_TEETH_TEXT = '歯を磨きましょう';
export const BATH_END_SAY = 'ゆっくり休んでくださいね';
export const BATH_DONE_SAY = 'ゆっくりどうぞ。';
export const BATH_DONE_REASON = '体を洗い始めました';
export const BATH_NO_ANSWER_REASON = 'お風呂で声かけに返事がありません。様子を見に行ってください';
export const IDLE_WATER_TEXT = 'お水を一口どうですか';

export function modeOf(h: Pick<Household, 'mode'>): HouseholdMode {
  return h.mode === 'bath' ? 'bath' : 'bedroom';
}

function minutesOr(v: unknown, fallback: number, min = 0): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.round(v) : fallback;
}

/** お風呂モードの間隔（未設定の項目は既定 10/15/10/2/5） */
export function bathPolicyOf(h: Pick<Household, 'policy'>): BathPolicy {
  const b: Partial<BathPolicy> = h.policy?.bath ?? {};
  return {
    washAfterMinutes: minutesOr(b.washAfterMinutes, DEFAULT_BATH_POLICY.washAfterMinutes, 1),
    teethAfterMinutes: minutesOr(b.teethAfterMinutes, DEFAULT_BATH_POLICY.teethAfterMinutes, 1),
    returnAfterMinutes: minutesOr(b.returnAfterMinutes, DEFAULT_BATH_POLICY.returnAfterMinutes, 1),
    recheckMinutes: minutesOr(b.recheckMinutes, DEFAULT_BATH_POLICY.recheckMinutes, 1),
    notifyAfterMinutes: minutesOr(b.notifyAfterMinutes, DEFAULT_BATH_POLICY.notifyAfterMinutes, 1),
  };
}

/** お風呂の声かけに返事が無いと判断するまでの分（「体を洗いましょうか」から notifyAfterMinutes で家族へ届くように） */
export function bathNoAnswerMinutes(h: Pick<Household, 'policy'>): number {
  const p = bathPolicyOf(h);
  return Math.max(1, p.notifyAfterMinutes - p.recheckMinutes);
}

/** ときたまの声かけの間隔（既定 90。0 で無効） */
export function idleChatMinutesOf(h: Pick<Household, 'policy'>): number {
  return minutesOr(h.policy?.idleChatMinutes, DEFAULT_IDLE_CHAT_MINUTES, 0);
}

function actorOf(by: ModeChangedBy): LedgerEntry['actor'] {
  return by === 'system' ? 'system' : by === 'family' ? 'member:family' : 'member:device';
}

function asDate(v: Date | string | undefined): Date | undefined {
  if (v == null) return undefined;
  return v instanceof Date ? v : new Date(v);
}

async function requireHousehold(ctx: Pick<AppContext, 'store'>, hh: HouseholdId): Promise<Household> {
  const h = await ctx.store.getHousehold(hh);
  if (!h) throw new NotFoundError(`household not found: ${hh}`);
  return h;
}

/** お風呂の声かけを 1 つ積む（日付は話す時刻の日付） */
async function enqueueBathPrompt(
  ctx: Pick<AppContext, 'store' | 'clock'>, hh: HouseholdId, step: BathStep, at: Date,
): Promise<Prompt> {
  const task: TaskKey = step === 'teeth' ? 'teeth' : 'bath';
  const text = step === 'start' ? BATH_START_SAY
    : step === 'wash' ? BATH_WASH_TEXT
    : step === 'wash_recheck' ? BATH_WASH_RECHECK_TEXT
    : step === 'teeth' ? BATH_TEETH_TEXT
    : BATH_END_SAY;
  const expectsReply = step !== 'start' && step !== 'end';
  return enqueuePrompt(ctx, hh, dateKey(at), task, {
    text, at, isRecheck: step === 'wash_recheck',
    extra: { bathStep: step, ...(expectsReply ? {} : { expectsReply: false }) },
  });
}

export interface SwitchModeResult {
  household: Household;
  /** 切り替えで積んだ最初の一言（端末へは next-prompt で届く）。同じモードへの切替・停止中は無し */
  say?: string;
  changed: boolean;
}

/**
 * 起動モードを切り替える。同じモードへの切替は何もしない。停止中（killSwitch）でも切替はする（声かけは積まない）。
 *  bedroom → bath: bath = { startedAt }。最初の一言（返事を求めない）と +washAfterMinutes の「体を洗いましょうか」を積む。
 *                  話したまま返事を待っている寝室の声かけは、無反応として扱わないように expired にする（前のお風呂の残りも）
 *  bath → bedroom: bath = null。お風呂の残りの声かけと、30 分以上前に期限が来た寝室の声かけを expired。「ゆっくり休んでくださいね」を積む
 */
export async function switchMode(
  ctx: Pick<AppContext, 'store' | 'clock'>,
  hh: HouseholdId,
  mode: HouseholdMode,
  by: ModeChangedBy,
  now: Date,
): Promise<SwitchModeResult> {
  const before = await requireHousehold(ctx, hh);
  const from = modeOf(before);
  if (from === mode) return { household: before, changed: false };
  const date = dateKey(now);
  let say: string | undefined;
  let expired = 0;

  if (mode === 'bath') {
    const bath: BathState = { startedAt: now };
    await ctx.store.updateHousehold(hh, { mode, modeChangedAt: now, modeChangedBy: by, bath, updatedAt: now });
    for (const p of await ctx.store.listPrompts(hh, date)) {
      // 話したまま返事を待っている寝室の声かけと、前のお風呂の残り（まだ話していない「ゆっくり休んでくださいね」など）
      const waitingBedroom = p.state === 'delivered' && !p.bathStep;
      const leftoverBath = p.bathStep && (p.state === 'queued' || p.state === 'delivered');
      if (waitingBedroom || leftoverBath) {
        await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
        expired += 1;
      }
    }
    if (!before.killSwitch) {
      const policy = bathPolicyOf(before);
      await enqueueBathPrompt(ctx, hh, 'start', now);
      await enqueueBathPrompt(ctx, hh, 'wash', addMinutes(now, policy.washAfterMinutes));
      say = BATH_START_SAY;
    }
  } else {
    await ctx.store.updateHousehold(hh, { mode, modeChangedAt: now, modeChangedBy: by, bath: null, updatedAt: now });
    const staleBefore = addMinutes(now, -STALE_BEDROOM_MINUTES).getTime();
    for (const p of await ctx.store.listPrompts(hh, date)) {
      const leftoverBath = p.bathStep && (p.state === 'queued' || p.state === 'delivered');
      const staleBedroom = !p.bathStep && p.state === 'queued' && p.scheduledAt.getTime() <= staleBefore;
      if (leftoverBath || staleBedroom) {
        await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
        expired += 1;
      }
    }
    if (!before.killSwitch) {
      await enqueueBathPrompt(ctx, hh, 'end', now);
      say = BATH_END_SAY;
    }
  }

  await appendLedger(ctx, {
    hh, date, at: now, actor: actorOf(by), kind: 'system', name: 'mode_changed',
    args: { from, to: mode, by, expiredPrompts: expired, killSwitch: before.killSwitch },
  });
  logEvent('mode_changed', { hh, date, from, to: mode, by, expired });
  return { household: await requireHousehold(ctx, hh), ...(say ? { say } : {}), changed: true };
}

/** お風呂の自動の戻りの時刻を過ぎているか（Cloud Tasks が届かなかったときの保険。nextPrompt が使う） */
export function bathReturnOverdue(h: Pick<Household, 'mode' | 'bath'>, now: Date, graceMinutes = 2): boolean {
  if (modeOf(h) !== 'bath' || !h.bath?.returnAt) return false;
  const at = asDate(h.bath.returnAt)!;
  return now.getTime() >= addMinutes(at, graceMinutes).getTime();
}

/**
 * /internal/bath-return: お風呂から寝室へ自動で戻す（by system）。
 * 予約したときのお風呂（startedAt）と今のお風呂が違えば何もしない（家族が切り替え直したあとの古い予約）。
 */
export async function handleBathReturn(
  ctx: Pick<AppContext, 'store' | 'clock'>,
  hh: HouseholdId,
  now: Date,
  startedAt?: string,
): Promise<{ switched: boolean; reason?: string; household: Household }> {
  const h = await requireHousehold(ctx, hh);
  if (modeOf(h) !== 'bath' || !h.bath) return { switched: false, reason: 'not_bath', household: h };
  if (startedAt) {
    const want = new Date(startedAt).getTime();
    const have = asDate(h.bath.startedAt)!.getTime();
    if (Number.isFinite(want) && want !== have) return { switched: false, reason: 'other_session', household: h };
  }
  const r = await switchMode(ctx, hh, 'bedroom', 'system', now);
  return { switched: r.changed, household: r.household };
}

/** 声かけを話したとき（day.ts の deliverPrompt）: 洗う・歯磨きの声かけの時刻を bath に残す */
export async function noteBathPromptDelivered(ctx: Pick<AppContext, 'store'>, prompt: Prompt, now: Date): Promise<void> {
  if (prompt.bathStep !== 'wash' && prompt.bathStep !== 'teeth') return;
  const h = await ctx.store.getHousehold(prompt.hh);
  if (!h || modeOf(h) !== 'bath' || !h.bath) return;
  const patch: Partial<BathState> = prompt.bathStep === 'wash'
    ? (h.bath.washAskedAt ? {} : { washAskedAt: now })
    : (h.bath.teethAskedAt ? {} : { teethAskedAt: now });
  if (Object.keys(patch).length === 0) return;
  await ctx.store.updateHousehold(prompt.hh, { bath: { ...h.bath, ...patch } });
}

// ---------------------------------------------------------------------------
// お風呂の声かけへの返事（state/turn.ts の processReply から。洗う・その再確認・歯磨き）
// ---------------------------------------------------------------------------

/**
 * お風呂の声かけ（bathStep が wash / wash_recheck / teeth）への返事を規則で処理する。状態機械（段階表）は使わない。
 * L4 の語・痛みの語は寝室と同じ（urgent ＋ L4 モード／check ＋ 3 時間後の聞き直し）。
 * 寝室に戻ったあとに届いた返事は記録だけ（お風呂の流れは進めない）。
 */
export async function processBathReply(
  ctx: AppContext,
  a: { household: Household; day: Day; prompt: Prompt; replyText: string | null; source: ReplySource; now: Date },
): Promise<ProcessReplyResult> {
  const { household, day, prompt, replyText, source, now } = a;
  const { hh, date, task } = prompt;
  const step = prompt.bathStep!;
  const analysis = analyzeReply(task, replyText, household);
  const status: Classification = analysis.status;
  const inBath = modeOf(household) === 'bath' && household.bath != null;
  const policy = bathPolicyOf(household);
  const turnId = newId('tn');
  const notices: Notice[] = [];
  let say = '';
  let expression: Expression = 'listen';
  let note = analysis.note;
  let followUp: { at: Date; task: TaskKey } | null = null;
  let state: TaskRecord['state'] = status === 'done' ? 'done' : 'asked';
  let bath: BathState | null = inBath ? { ...household.bath! } : null;
  let l4Started = false;

  // 先に保存（通知の引用先にするため）。一言は最後に決めて書き直す
  const turn: Turn = {
    id: turnId, hh, date, promptId: prompt.id, task,
    promptedAt: prompt.deliveredAt ?? prompt.scheduledAt,
    promptText: prompt.text,
    replyText,
    replySource: source,
    repliedAt: now,
    classified: { status, note, by: 'rules', confidence: rulesConfidence(status), uncertain: status === 'unclear' },
    toolCalls: [],
    say: '',
    expression,
    latencyMs: 0,
    expiresAt: addMinutes(now, TURN_TTL_MINUTES),
  };
  await ctx.store.putTurn(turn);
  await ctx.store.updatePrompt(hh, date, prompt.id, { state: replyText == null ? 'expired' : 'answered' });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'reply_received', turnId,
    args: { promptId: prompt.id, task, source, reply: excerpt(replyText), bathStep: step },
  });

  // ---- L4 の語・痛みの語（寝室と同じ） ----
  let alerted = false;
  if (analysis.l4) {
    const n = await safeNotify(ctx, {
      hh, date, level: 'urgent', reason: l4Reason(analysis.l4), evidence: ruleExcerpt(replyText, 40), turnId, task, now,
      origin: analysis.l4.group === 'fire' ? 'fire' : 'l4_words',
    });
    if (n) {
      notices.push(n);
      l4Started = Boolean(await startL4(ctx, hh, date, day, n, task, now));
    }
    say = L4_SAY; expression = 'worry'; alerted = true;
  } else if (analysis.pain) {
    const n = await safeNotify(ctx, {
      hh, date, level: 'check', reason: painReason(analysis.pain), evidence: ruleExcerpt(replyText, 40), turnId, task, now, origin: 'pain',
    });
    if (n) notices.push(n);
    await scheduleFollowup(ctx, household, {
      hh, date, now, turnId, noticeId: n?.id,
      intent: {
        type: 'followup', minutes: PAIN_FOLLOWUP_MINUTES, task, text: painFollowupText(analysis.pain),
        reason: `痛みの聞き直し（${analysis.pain.part ?? '場所は不明'}）`,
      },
    });
    say = PAIN_SAY; expression = 'worry'; alerted = true;
  }

  // ---- お風呂の流れ（L4 になったら止める。L4 モードが優先） ----
  if (inBath && bath && !analysis.l4) {
    if (step === 'wash' || step === 'wash_recheck') {
      if (status === 'done') {
        bath.washDoneAt = now;
        if (!alerted) {
          const n = await safeNotify(ctx, {
            hh, date, level: 'info', reason: BATH_DONE_REASON, evidence: ruleExcerpt(replyText, 30), turnId, task, now, origin: 'bath',
          });
          if (n) notices.push(n);
          // 本人には「ゆっくりどうぞ」だけ。「家族に知らせました」とは言わない
          say = BATH_DONE_SAY; expression = 'smile';
        }
        bath = await scheduleTeethAndReturn(ctx, hh, bath, now, policy, true);
      } else if (step === 'wash') {
        // まだ・返事なし・判定できない → 声かけから 2 分後に 1 回だけ再確認（返事なしの締めが遅れたときは今すぐ）
        const askedAt = prompt.deliveredAt ? asDate(prompt.deliveredAt)! : now;
        const at = new Date(Math.max(now.getTime(), addMinutes(askedAt, policy.recheckMinutes).getTime()));
        const queued = (await ctx.store.listPrompts(hh, date)).some(p => p.bathStep === 'wash_recheck' && p.state === 'queued');
        if (!queued) await enqueueBathPrompt(ctx, hh, 'wash_recheck', at);
        followUp = { at, task };
        state = 'rechecking';
        if (!alerted) {
          say = status === 'no_answer' ? '' : 'わかりました。また少ししたら声をかけますね。';
          expression = 'listen';
        }
      } else if (status === 'no_answer') {
        // 再確認にも返事が無い → 家族へ check（L4 にはしない）
        const since = asDate(bath.washAskedAt) ?? prompt.deliveredAt ?? prompt.scheduledAt;
        if (!bath.noAnswerNotifiedAt) {
          const n = await safeNotify(ctx, {
            hh, date, level: 'check', reason: BATH_NO_ANSWER_REASON,
            evidence: `${hm(since)} から 2 回の声かけ（お風呂）に返事がありません`, turnId, task, now, origin: 'bath',
          });
          if (n) notices.push(n);
          bath.noAnswerNotifiedAt = now;
        }
        state = 'escalated';
        note = 'お風呂の声かけに 2 回返事なし（家族へ確認のお願い。L4 にはしない）';
        bath = await scheduleTeethAndReturn(ctx, hh, bath, now, policy, false);
      } else {
        // 再確認でも「まだ」等 → 記録して、そのまま歯磨きと戻りへ進む（3 回目は聞かない）
        if (!alerted) { say = 'わかりました。'; expression = 'listen'; }
        bath = await scheduleTeethAndReturn(ctx, hh, bath, now, policy, true);
      }
    } else if (step === 'teeth' && !alerted) {
      // 歯磨きは記録のみ。通知しない
      say = status === 'done' ? '歯磨き、できましたね。すっきりしましたね。' : status === 'not_yet' ? 'わかりました。' : '';
      expression = status === 'done' ? 'smile' : 'listen';
    }
    await ctx.store.updateHousehold(hh, { bath });
  } else if (!inBath && !alerted && replyText) {
    say = status === 'done' ? BATH_DONE_SAY : '';
  }

  // ---- 確認項目の記録（段階表は使わない） ----
  const prev = day.tasks[task] ?? emptyRecord();
  const record: TaskRecord = {
    ...prev,
    state,
    status,
    at: now,
    promptIds: prev.promptIds.includes(prompt.id) ? [...prev.promptIds] : [...prev.promptIds, prompt.id],
    lastTurnId: turnId,
    recheckCount: (prev.recheckCount ?? 0) + (state === 'rechecking' ? 1 : 0),
    ...(replyText ? { evidence: excerpt(replyText, 30) ?? undefined } : {}),
  };
  if (record.evidence === undefined) delete record.evidence;
  await ctx.store.setTask(hh, date, task, record);

  turn.say = say;
  turn.expression = expression;
  turn.classified = { ...turn.classified, note };
  await ctx.store.putTurn(turn);

  const signals = { ...day.signals };
  if (status === 'no_answer') signals.noAnswerCount += 1;
  if (status === 'unclear') signals.unclearCount += 1;
  if (l4Started) signals.urgentCount += 1;
  await ctx.store.updateDay(hh, date, { signals });

  await appendLedger(ctx, {
    hh, date, at: now, kind: 'tool_result', name: 'turn_classified', turnId,
    args: { task, promptId: prompt.id, bathStep: step },
    result: { status, note, by: 'rules', taskState: state, notices: notices.map(n => n.level) },
  });
  logEvent('turn_classified', { hh, date, task, turnId, status, by: 'rules', bathStep: step, reply: excerpt(replyText) });
  return { turn, followUp, say, expression, intents: [], notices };
}

/** 歯磨きの声かけ（teeth なら）と、寝室への自動の戻り（/internal/bath-return）を予約する。既に予約してあれば何もしない */
async function scheduleTeethAndReturn(
  ctx: AppContext, hh: HouseholdId, bath: BathState, now: Date, policy: BathPolicy, teeth: boolean,
): Promise<BathState> {
  if (bath.returnAt) return bath;
  let returnAt = addMinutes(now, policy.returnAfterMinutes);
  if (teeth) {
    const teethAt = addMinutes(now, policy.teethAfterMinutes);
    await enqueueBathPrompt(ctx, hh, 'teeth', teethAt);
    returnAt = addMinutes(teethAt, policy.returnAfterMinutes);
  }
  const startedAt = asDate(bath.startedAt)!;
  try {
    await ctx.tasks.schedule('/internal/bath-return', { hh, startedAt: startedAt.toISOString() }, returnAt);
  } catch (error) {
    // 予約に失敗しても、nextPrompt が戻りの時刻を見て寝室へ戻す（bathReturnOverdue）
    logError('bath_return_schedule_failed', error, { hh });
  }
  await appendLedger(ctx, {
    hh, date: dateKey(now), at: now, kind: 'tool_call', name: 'tool_call',
    args: { name: 'schedule_bath_return', teeth, runAt: returnAt }, result: { scheduled: true },
  });
  return { ...bath, returnAt };
}

// ---------------------------------------------------------------------------
// 寝室モードの「ときたまの声かけ」
// ---------------------------------------------------------------------------

/** 「今は 10 時 30 分です。今日は火曜日ですよ」 */
export function timeAndWeekdayText(now: Date): string {
  return `今は ${spokenTime(hhmm(now))}です。今日は${jaWeekday(now)}曜日ですよ`;
}

/** デイの日の不在の間（お迎え〜帰宅の声かけ）か */
function inDayserviceAbsence(day: Day, household: Household, nowMin: number): boolean {
  if (!day.isDayservice) return false;
  const pickup = day.plan.find(i => i.task === 'pickup')?.time ?? household.plan.pickupTime;
  const back = day.plan.find(i => i.task === 'return')?.time;
  if (!pickup || !back) return false;
  return nowMin >= toMinutes(pickup) && nowMin <= toMinutes(back);
}

/**
 * 条件がそろえば talk の声かけを 1 つ作って話す（返事は求めない）。そろわなければ null。
 * 条件: 寝室モード・idleChatMinutes > 0・就寝時間帯でない・L4 でない・停止中でない・デイで不在の間でない・
 *       直近 idleChatMinutes 分に話した声かけが無い・前後 45 分に計画の声かけ（積まれた声かけ）が無い
 */
export async function maybeIdleChat(ctx: AppContext, household: Household, day: Day, now: Date): Promise<Prompt | null> {
  const minutes = idleChatMinutesOf(household);
  if (minutes <= 0 || household.killSwitch || modeOf(household) !== 'bedroom') return null;
  if (inSleepHours(household, now) || day.l4) return null;
  const nowMin = toMinutes(hhmm(now));
  if (inDayserviceAbsence(day, household, nowMin)) return null;
  if (day.plan.some(i => Math.abs(toMinutes(i.time) - nowMin) <= IDLE_CHAT_PLAN_MARGIN_MINUTES)) return null;
  const { hh, date } = day;
  const prompts = await ctx.store.listPrompts(hh, date);
  const since = addMinutes(now, -minutes).getTime();
  if (prompts.some(p => p.deliveredAt && asDate(p.deliveredAt)!.getTime() >= since)) return null;
  const margin = IDLE_CHAT_PLAN_MARGIN_MINUTES * 60_000;
  if (prompts.some(p => p.state === 'queued' && !p.isReassurance && Math.abs(p.scheduledAt.getTime() - now.getTime()) <= margin)) return null;

  const n = prompts.filter(p => p.idleChat).length;
  const kind = n % 2 === 0 ? 'time' : 'water';
  const prompt: Prompt = {
    id: newId('pr'), hh, date, task: 'talk', text: kind === 'time' ? timeAndWeekdayText(now) : IDLE_WATER_TEXT,
    scheduledAt: now, isRecheck: false, state: 'queued', expression: 'smile', expectsReply: false, idleChat: true,
  };
  await ctx.store.putPrompt(prompt);
  const delivered = await deliverPrompt(ctx, prompt, now, { synthesize: true });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'idle_chat_sent', args: { promptId: prompt.id, kind, minutes },
  });
  logEvent('idle_chat_sent', { hh, date, promptId: prompt.id, kind });
  return delivered;
}

// ---------------------------------------------------------------------------
// 画面へ返す形（GET/POST /api/device/mode、/api/family/mode）
// ---------------------------------------------------------------------------

export interface ModeView {
  mode: HouseholdMode;
  bath: BathState | null;
  whereabouts: { place: string; backAt: string | null; say: string } | null;
  killSwitch: boolean;
}

export function modeView(h: Household, now: Date): ModeView {
  const w = currentWhereabouts(h, now);
  return {
    mode: modeOf(h),
    bath: modeOf(h) === 'bath' ? (h.bath ?? null) : null,
    whereabouts: w ? { place: w.place, backAt: w.backAt ?? null, say: whereaboutsSay(h, now) } : null,
    killSwitch: h.killSwitch,
  };
}
