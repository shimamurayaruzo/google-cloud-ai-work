// 一日の流れ: 日の作成、朝の計画、声かけの積み込みと取り出し、返事の無い声かけの締め切り。
// 時刻の起動は Scheduler / Tasks（api/ の /internal/*）から。ここは呼ばれたら 1 回分の処理をするだけ。

import { logError, logEvent } from '../log.js';
import type { AppContext } from '../services.js';
import { addMinutes, dateKey, hhmm, jstDate } from '../time.js';
import {
  newId, TASK_LABELS, type DateKey, type Day, type Household, type HouseholdId, type Prompt, type TaskKey,
} from '../types.js';
import { NotFoundError } from './errors.js';
import { currentDegraded, recordIncident } from '../ops/health.js';
import { appendLedger } from './ledger.js';
import { currentL4, reassuranceDue } from './l4.js';
import { emptyRecord, transition } from './machine.js';
import { defaultPromptText, findPlanItem, inSleepHours, resolvePlan } from './plan.js';
import { processReply } from './turn.js';
import { REASSURANCE_SAY } from '../agent/rules.js';

/** 計画を作るとき、これより前に過ぎた声かけは話さない（expired で作る）。朝の計画が遅れて走ったときの一斉発話を防ぐ */
const STALE_PLAN_MINUTES = 30;

async function requireHousehold(ctx: Pick<AppContext, 'store'>, hh: HouseholdId): Promise<Household> {
  const h = await ctx.store.getHousehold(hh);
  if (!h) throw new NotFoundError(`household not found: ${hh}`);
  return h;
}

function emptySignals(): Day['signals'] {
  return { unclearCount: 0, noAnswerCount: 0, repeatedQuestions: 0, urgentCount: 0 };
}

/**
 * その日の Day を返す。無ければ計画の雛形から作る（tasks は計画に出てくる項目を pending、signals は 0）。
 * opts.isDayservice を渡すと曜日よりも優先する（再生モード用）。既にある日と違えば計画を入れ替える。
 */
export async function ensureDay(
  ctx: Pick<AppContext, 'store' | 'clock'>,
  hh: HouseholdId,
  date: DateKey,
  opts: { isDayservice?: boolean } = {},
): Promise<Day> {
  const existing = await ctx.store.getDay(hh, date);
  if (existing && (opts.isDayservice === undefined || opts.isDayservice === existing.isDayservice)) return existing;

  const household = await requireHousehold(ctx, hh);
  const { isDayservice, items } = resolvePlan(household, date, opts.isDayservice);

  if (existing) {
    // 再生モードで曜日と違うデイ指定が来たとき: 計画だけ入れ替え、足りない項目を pending で足す
    await ctx.store.updateDay(hh, date, { isDayservice, plan: items });
    for (const i of items) {
      if (!existing.tasks[i.task]) await ctx.store.setTask(hh, date, i.task, emptyRecord());
    }
    return (await ctx.store.getDay(hh, date))!;
  }

  const tasks: Day['tasks'] = {};
  for (const i of items) tasks[i.task] = emptyRecord();
  const day: Day = {
    hh, date, isDayservice, plan: items, planApproved: null, tasks, summary: null, signals: emptySignals(),
    createdAt: ctx.clock(),
  };
  await ctx.store.putDay(day);
  return day;
}

/**
 * 朝の計画（/internal/plan）。計画の各項目を queued の声かけとして積み、家族へ「今日の声かけ計画」を送る。
 * 既に声かけがある日は作り直さない（Scheduler の再実行に耐える）。
 */
export async function planDay(
  ctx: AppContext,
  hh: HouseholdId,
  date: DateKey,
  now: Date,
): Promise<{ day: Day; prompts: Prompt[] }> {
  const day = await ensureDay(ctx, hh, date);
  const existing = await ctx.store.listPrompts(hh, date);
  if (existing.length > 0) return { day, prompts: existing };

  const household = await requireHousehold(ctx, hh);
  const staleBefore = addMinutes(now, -STALE_PLAN_MINUTES).getTime();
  // 就寝時間帯（criteria 3-3 ★8）の声かけは作らない
  const items = day.plan.filter(item => !inSleepHours(household, jstDate(date, item.time)));
  const prompts: Prompt[] = items.map(item => {
    const scheduledAt = jstDate(date, item.time);
    return {
      id: newId('pr'),
      hh, date,
      task: item.task,
      text: item.text ?? defaultPromptText(item.task, household, false),
      scheduledAt,
      isRecheck: false,
      state: scheduledAt.getTime() < staleBefore ? 'expired' : 'queued',
      expression: 'smile',
    };
  });
  for (const p of prompts) await ctx.store.putPrompt(p);

  const lines = items.map(i => `${i.time} ${TASK_LABELS[i.task]}`);
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'plan', name: 'plan_proposed',
    args: { isDayservice: day.isDayservice, items: day.plan.map(i => ({ time: i.time, task: i.task })) },
  });
  logEvent('plan_proposed', { hh, date, isDayservice: day.isDayservice, count: prompts.length });

  try {
    await ctx.familyNotify.notify({
      hh, date, level: 'info', reason: '今日の声かけ計画',
      evidence: `${day.isDayservice ? 'デイの日' : 'デイ以外の日'}: ${lines.join('、')}`,
      turnId: null, now,
    });
  } catch (error) {
    // 計画そのものはできているので、通知の失敗で朝の処理を止めない
    logError('plan_notify_failed', error, { hh, date });
      }
  return { day, prompts };
}

/** 家族が朝の計画を承認した */
export async function approvePlan(ctx: AppContext, hh: HouseholdId, date: DateKey, by: string, now: Date): Promise<Day> {
  const day = await ctx.store.getDay(hh, date);
  if (!day) throw new NotFoundError(`day not found: ${hh}/${date}`);
  const planApproved = { by, at: now };
  await ctx.store.updateDay(hh, date, { planApproved });
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'plan', name: 'plan_approved', actor: `member:${by}`, args: { by },
  });
  logEvent('plan_approved', { hh, date });
  return { ...day, planApproved };
}

/** 声かけを 1 つ積む（queued）。文言は opts.text → 計画の text → 既定の文言 */
export async function enqueuePrompt(
  ctx: Pick<AppContext, 'store' | 'clock'>,
  hh: HouseholdId,
  date: DateKey,
  task: TaskKey,
  opts: { isRecheck?: boolean; text?: string; at?: Date } = {},
): Promise<Prompt> {
  const household = await requireHousehold(ctx, hh);
  const day = await ensureDay(ctx, hh, date);
  const at = opts.at ?? ctx.clock();
  const isRecheck = opts.isRecheck ?? false;
  const item = findPlanItem(day.plan, task, at);
  const text = opts.text
    ?? (isRecheck ? defaultPromptText(task, household, true) : item?.text ?? defaultPromptText(task, household, false));
  const prompt: Prompt = {
    id: newId('pr'), hh, date, task, text, scheduledAt: at, isRecheck, state: 'queued', expression: 'smile',
  };
  await ctx.store.putPrompt(prompt);
  return prompt;
}

/**
 * 声かけを「話した」にする。同じ項目の delivered のまま返事が無い古い声かけは expired にする。
 * 状態機械を asked に進め、台帳 prompt_sent を書く。synthesize が true なら音声合成を試す。
 */
export async function deliverPrompt(
  ctx: AppContext,
  prompt: Prompt,
  now: Date,
  opts: { synthesize?: boolean } = {},
): Promise<Prompt> {
  const { hh, date } = prompt;
  for (const p of await ctx.store.listPrompts(hh, date)) {
    if (p.id !== prompt.id && p.task === prompt.task && p.state === 'delivered') {
      await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
    }
  }

  let ttsUrl: string | undefined;
  if (opts.synthesize) {
    // 運用エージェントが端末の読み上げへ切り替えている間は、音声合成を呼ばない
    const degraded = currentDegraded(await ctx.store.getHealth(hh, dateKey(now)), now);
    if (degraded?.tts !== 'device') {
      try {
        const r = await ctx.tts.synthesize(prompt.text);
        ttsUrl = r.url;
        if (r.incident) {
          await recordIncident(ctx.store, hh, r.incident, 'fallback', undefined, now);
        }
      } catch (error) {
        // 音声が作れなくても端末の読み上げで話せるので、声かけは止めない
        logError('tts_failed', error, { hh, promptId: prompt.id });
        await recordIncident(ctx.store, hh, 'tts_error', 'fallback', 'synthesize_threw', now);
      }
    }
  }

  const delivered: Prompt = { ...prompt, state: 'delivered', deliveredAt: now, ...(ttsUrl ? { ttsUrl } : {}) };
  await ctx.store.updatePrompt(hh, date, prompt.id, {
    state: 'delivered', deliveredAt: now, ...(ttsUrl ? { ttsUrl } : {}),
  });

  // 安心文と痛みの聞き直しは確認項目の一巡ではないので、状態機械を動かさない
  if (!prompt.isReassurance && !prompt.followup) {
    const day = await ensureDay(ctx, hh, date);
    const { next } = transition(day.tasks[prompt.task], {
      type: 'asked', promptId: prompt.id, at: now, isRecheck: prompt.isRecheck,
    });
    await ctx.store.setTask(hh, date, prompt.task, next);
  }

  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'prompt_sent',
    args: {
      promptId: prompt.id, task: prompt.task, isRecheck: prompt.isRecheck, text: prompt.text,
      ...(prompt.isReassurance ? { isReassurance: true } : {}), ...(prompt.followup ? { followup: true } : {}),
    },
  });
  logEvent('prompt_sent', { hh, date, promptId: prompt.id, task: prompt.task, isRecheck: prompt.isRecheck, isReassurance: prompt.isReassurance ?? false });
  return delivered;
}

/**
 * 端末が「次に話す声かけ」を取りに来たとき（GET /api/device/next-prompt）。
 * 今日の期限が来た queued の先頭を delivered にして返す。killSwitch なら null（L4 の安心文も出さない）。
 * - L4 モード中（day.l4）: 通常の声かけは出さず、3 分ごとに安心文（isReassurance）だけを返す。
 *   該当の通知が acked / closed になっていたら解除して通常に戻る（state/l4.ts）
 * - 就寝時間帯（policy.sleepHours）: 通常の声かけは出さない。期限が来た声かけは話さずに expired にする
 * 再確認の声かけで、その項目が既に rechecking でなくなっていれば（済んだ等）話さずに expired にする。
 */
export async function nextPrompt(ctx: AppContext, hh: HouseholdId, now: Date): Promise<Prompt | null> {
  const household = await requireHousehold(ctx, hh);
  if (household.killSwitch) return null;
  const date = dateKey(now);
  const day = await ensureDay(ctx, hh, date);

  const l4 = await currentL4(ctx, hh, date, day, now);
  if (l4) return nextReassurance(ctx, hh, date, l4, now);

  const due = await ctx.store.listDuePrompts(hh, date, now);
  if (due.length === 0) return null;
  if (inSleepHours(household, now)) {
    for (const p of due) await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
    logEvent('prompts_expired_sleep_hours', { hh, date, count: due.length });
    return null;
  }
  for (const p of due) {
    if (p.isReassurance) {
      await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
      continue;
    }
    if (p.isRecheck && day.tasks[p.task]?.state !== 'rechecking') {
      await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
      continue;
    }
    return deliverPrompt(ctx, p, now, { synthesize: true });
  }
  return null;
}

/** L4 モードの安心文。直近の安心文（無ければ L4 を立てた時刻）から 3 分以上たっていれば 1 つ作って話す */
async function nextReassurance(
  ctx: AppContext, hh: HouseholdId, date: DateKey, l4: NonNullable<Day['l4']>, now: Date,
): Promise<Prompt | null> {
  const prompts = await ctx.store.listPrompts(hh, date);
  const last = prompts
    .filter(p => p.isReassurance && p.deliveredAt)
    .map(p => new Date(p.deliveredAt!))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  if (!reassuranceDue(l4, last, now)) return null;
  const prompt: Prompt = {
    id: newId('pr'), hh, date, task: l4.task ?? 'greeting', text: REASSURANCE_SAY,
    scheduledAt: now, isRecheck: false, state: 'queued', expression: 'worry', isReassurance: true,
  };
  await ctx.store.putPrompt(prompt);
  return deliverPrompt(ctx, prompt, now, { synthesize: true });
}

/**
 * delivered のまま olderThanMinutes 分以上返事の無い声かけを、返事なし（replyText=null）のターンとして処理する。
 * /internal/health から呼ぶ想定。処理した件数を返す。
 */
export async function expireUnansweredPrompts(
  ctx: AppContext,
  hh: HouseholdId,
  now: Date,
  olderThanMinutes = 10,
): Promise<number> {
  const date = dateKey(now);
  const limit = addMinutes(now, -olderThanMinutes).getTime();
  const stale = (await ctx.store.listPrompts(hh, date))
    .filter(p => p.state === 'delivered' && (p.deliveredAt ?? p.scheduledAt).getTime() <= limit);
  const household = await requireHousehold(ctx, hh);
  const sleeping = inSleepHours(household, now);
  let n = 0;
  for (const p of stale) {
    // 安心文は質問ではない。就寝時間帯は無反応判定の対象外（criteria 3-3）。どちらも返事なしとして扱わない
    if (p.isReassurance || sleeping) {
      await ctx.store.updatePrompt(hh, date, p.id, { state: 'expired' });
      continue;
    }
    try {
      await processReply(ctx, { hh, date, promptId: p.id, replyText: null, source: 'ipad', now });
      n += 1;
    } catch (error) {
      logError('expire_prompt_failed', error, { hh, promptId: p.id, at: hhmm(now) });
    }
  }
  return n;
}
