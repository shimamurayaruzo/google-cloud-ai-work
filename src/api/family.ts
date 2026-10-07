// 家族画面用 API。docs/02 §3.2。認証は合言葉 Cookie（requireFamily）。
// 世帯は config.defaultHouseholdId（提出版は 1 世帯）。?hh= があればそれを使う。
// フィールド名は src/api/README.md の例と揃える（馬場さんの画面が使う）。

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../services.js';
import { approvePlan, ensureDay } from '../state/day.js';
import { logEvent } from '../log.js';
import { dateKey } from '../time.js';
import {
  TASK_KEYS, TASK_LABELS, newId,
  type DateKey, type Day, type Household, type HouseholdId, type Member, type Turn,
} from '../types.js';
import { CAPABILITIES } from './capabilities.js';
import { familyLoginHandlers, requireFamily } from './auth.js';
import { listScenarioNames, runReplay, scenarioFromBody } from './replay.js';
import { HttpError, ok, type Router } from './router.js';
import { bodyOf, qstr, toDateKey, toHousehold, truncate, writeLedger } from './util.js';

const ACTOR = 'member:family' as const;
/** 合言葉ログインなので、誰が承認したかは「家族」までしか分からない */
const APPROVER = 'family';
const REPLY_PREVIEW_CHARS = 40;

function hhOf(req: Request): HouseholdId {
  return toHousehold(qstr(req, 'hh'));
}

async function mustHousehold(ctx: AppContext, hh: HouseholdId): Promise<Household> {
  const h = await ctx.store.getHousehold(hh);
  if (!h) throw new HttpError(404, `世帯 ${hh} が見つかりません`);
  return h;
}

/** 今日なら日を用意して返す（計画を雛形から作る）。過去・未来は読むだけ */
async function loadDay(ctx: AppContext, hh: HouseholdId, date: DateKey, now: Date): Promise<Day | null> {
  if (date === dateKey(now)) return ensureDay(ctx, hh, date);
  return ctx.store.getDay(hh, date);
}

function turnPreview(t: Turn) {
  return {
    id: t.id,
    task: t.task,
    promptId: t.promptId,
    promptedAt: t.promptedAt,
    promptText: t.promptText,
    replyText: truncate(t.replyText, REPLY_PREVIEW_CHARS),
    replySource: t.replySource,
    repliedAt: t.repliedAt,
    classified: t.classified,
    say: t.say,
    expression: t.expression,
    blockedCount: t.toolCalls.filter(c => c.blocked).length,
  };
}

function memberPublic(m: Member) {
  return { id: m.id, name: m.name, order: m.order, email: m.email ?? '', waitMinutes: m.waitMinutes, lineLinked: Boolean(m.line?.userId) };
}

// ---- 設定の検証（PUT /api/family/settings） ----
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM（例 08:05）で書いてください');
const PlanItemSchema = z.object({
  time: HHMM,
  task: z.enum(TASK_KEYS),
  text: z.string().max(200).optional(),
  /** 0 は「1 回のみ（再確認しない）」（src/seed/household.ts の決まり） */
  recheckMinutes: z.number().int().min(0).max(180).optional(),
  escalate: z.boolean().optional(),
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const SettingsSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  person: z.object({
    callName: z.string().min(1).max(30).optional(),
    wording: z.record(z.string().max(40), z.string().max(100)).optional(),
  }).optional(),
  plan: z.object({
    weekday: z.object({
      default: z.array(PlanItemSchema).max(40),
      dayservice: z.array(PlanItemSchema).max(40),
    }),
    dayserviceDays: z.array(z.enum(WEEKDAYS)).max(7),
    pickupTime: HHMM.optional(),
  }).optional(),
  policy: z.object({
    recheckOnce: z.boolean().optional(),
    recheckMinutes: z.number().int().min(1).max(180).optional(),
    /** 1 確認あたりの再確認の上限（criteria 5 節。既定 2 = 計 3 回） */
    maxRechecks: z.number().int().min(0).max(5).optional(),
    quietHours: z.object({ from: HHMM, to: HHMM }).optional(),
    /** 就寝時間帯（criteria 3-3 ★8。声かけをしない） */
    sleepHours: z.object({ from: HHMM, to: HHMM }).optional(),
  }).optional(),
  /** 通知文に書く連絡先。空文字で消す */
  contacts: z.object({
    homePhone: z.string().max(20).regex(/^[0-9+\-() ]*$/, '電話番号は数字・+・-・括弧で書いてください').optional(),
    nearby: z.object({ name: z.string().min(1).max(30), phone: z.string().min(1).max(20).regex(/^[0-9+\-() ]+$/, '電話番号は数字・+・-・括弧で書いてください') }).nullable().optional(),
  }).optional(),
  members: z.array(z.object({
    id: z.string().max(64).optional(),
    name: z.string().min(1).max(40),
    order: z.number().int().min(1).max(20),
    email: z.union([z.email(), z.literal('')]).optional(),
    waitMinutes: z.number().int().min(1).max(240),
    // line.userId は LINE の友だち追加でだけ決まる。ここで送られても無視する
  })).min(1).max(10).optional(),
});

/** 検証済みの設定を今の世帯に重ねた patch を作る。line.userId は既存のまま残す */
export function buildSettingsPatch(current: Household, input: z.infer<typeof SettingsSchema>): Partial<Household> {
  const patch: Partial<Household> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.person) {
    patch.person = {
      callName: input.person.callName ?? current.person.callName,
      wording: input.person.wording ?? current.person.wording,
    };
  }
  if (input.plan) {
    patch.plan = {
      weekday: input.plan.weekday,
      dayserviceDays: input.plan.dayserviceDays,
      ...(input.plan.pickupTime ? { pickupTime: input.plan.pickupTime } : {}),
    };
  }
  if (input.policy) {
    patch.policy = { ...current.policy, ...input.policy };
  }
  if (input.contacts) {
    const next: NonNullable<Household['contacts']> = { ...(current.contacts ?? {}) };
    if (input.contacts.homePhone !== undefined) {
      if (input.contacts.homePhone.trim()) next.homePhone = input.contacts.homePhone.trim();
      else delete next.homePhone;
    }
    if (input.contacts.nearby !== undefined) {
      if (input.contacts.nearby) next.nearby = input.contacts.nearby;
      else delete next.nearby;
    }
    patch.contacts = next;
  }
  if (input.members) {
    const orders = input.members.map(m => m.order);
    if (new Set(orders).size !== orders.length) throw new HttpError(400, '通知先の順番（order）が重なっています');
    const byId = new Map(current.members.map(m => [m.id, m]));
    patch.members = input.members
      .map(m => {
        const prev = m.id ? byId.get(m.id) : undefined;
        const next: Member = {
          id: prev?.id ?? newId('mem'),
          name: m.name,
          order: m.order,
          waitMinutes: m.waitMinutes,
          ...(m.email ? { email: m.email } : {}),
          ...(prev?.line ? { line: prev.line } : {}),
        };
        return next;
      })
      .sort((a, b) => a.order - b.order);
  }
  return patch;
}

export function registerFamilyRoutes(router: Router, ctx: AppContext): void {
  // ---- ログイン（認証なしで呼べる） ----
  router.post('/api/family/login', familyLoginHandlers.api);
  router.post('/api/family/logout', familyLoginHandlers.apiLogout);
  router.get('/api/family/session', familyLoginHandlers.session);

  // ---- 今日の様子 ----
  router.get('/api/family/today', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const now = ctx.clock();
    const date = toDateKey(qstr(req, 'date'), now);
    const household = await mustHousehold(ctx, hh);
    const [day, prompts, turns, notices, health] = await Promise.all([
      loadDay(ctx, hh, date, now),
      ctx.store.listPrompts(hh, date),
      ctx.store.listTurns(hh, date),
      ctx.store.listNotices(hh, date),
      ctx.store.getHealth(hh, date),
    ]);
    ok(res, {
      date,
      day,
      /** L4 モード（至急の通知のあと、3 分ごとに安心文だけを流している間）。無ければ null */
      l4: day?.l4 ?? null,
      prompts,
      turns: turns.map(turnPreview),
      notices,
      health,
      household: {
        killSwitch: household.killSwitch,
        members: [...household.members].sort((a, b) => a.order - b.order).map(m => ({ name: m.name, order: m.order })),
      },
      taskLabels: TASK_LABELS,
    });
  });

  // ---- 引用から飛ぶ先 ----
  router.get('/api/family/turn/:turnId', async (req: Request, res: Response, params) => {
    requireFamily(req);
    const turn = await ctx.store.getTurn(hhOf(req), params.turnId);
    if (!turn) throw new HttpError(404, 'このターンは見つかりません（7 日を過ぎて削除された可能性があります）');
    ok(res, { turn });
  });

  // ---- 朝の計画 ----
  router.get('/api/family/plan', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const now = ctx.clock();
    const date = toDateKey(qstr(req, 'date'), now);
    const day = await loadDay(ctx, hh, date, now);
    ok(res, {
      date,
      isDayservice: day?.isDayservice ?? null,
      plan: day?.plan ?? null,
      planApproved: day?.planApproved ?? null,
      taskLabels: TASK_LABELS,
    });
  });

  router.post('/api/family/plan/approve', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const now = ctx.clock();
    const date = toDateKey(bodyOf(req).date, now);
    const day = await approvePlan(ctx, hh, date, APPROVER, now);
    ok(res, { ok: true, date, planApproved: day.planApproved });
  });

  // ---- 承認 ----
  router.get('/api/family/approvals', async (req: Request, res: Response) => {
    requireFamily(req);
    const all = qstr(req, 'all') === '1';
    const approvals = await ctx.store.listApprovals(hhOf(req), !all);
    ok(res, { approvals });
  });

  router.post('/api/family/approvals/:ap', async (req: Request, res: Response, params) => {
    requireFamily(req);
    const hh = hhOf(req);
    const body = bodyOf(req);
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new HttpError(400, 'decision は approved か rejected です');
    }
    const edited = body.editedPayload;
    if (edited !== undefined && (edited === null || typeof edited !== 'object' || Array.isArray(edited))) {
      throw new HttpError(400, 'editedPayload はオブジェクトで送ってください');
    }
    const approval = await ctx.store.getApproval(hh, params.ap);
    if (!approval) throw new HttpError(404, 'この承認依頼は見つかりません');
    if (approval.decision !== null) throw new HttpError(409, 'この承認依頼はすでに決まっています');
    const now = ctx.clock();
    const editedPayload = edited as Record<string, unknown> | undefined;
    await ctx.store.updateApproval(hh, approval.id, {
      decision,
      decidedAt: now,
      decidedBy: ACTOR,
      ...(editedPayload ? { editedPayload } : {}),
    });
    await writeLedger(ctx, hh, now, {
      actor: ACTOR, kind: 'approval', name: 'approval_decided',
      args: { approvalId: approval.id, kind: approval.kind, decision, edited: Boolean(editedPayload) },
    });
    logEvent('approval_decided', { hh, approvalId: approval.id, kind: approval.kind, decision });
    let executed = false;
    if (decision === 'approved' && approval.kind === 'share_external') {
      // 提出版は実際の送信をしない（範囲外）。承認後に実行した、という記録だけ残す
      const payload = editedPayload ?? approval.payload;
      await writeLedger(ctx, hh, now, {
        actor: 'agent', kind: 'tool_call', name: 'tool_call',
        args: { name: 'share_external', approvalId: approval.id, recipient: payload.recipient ?? null },
        result: { executed: true, note: '提出版では外部への実送信は行いません' },
      });
      executed = true;
    }
    const updated = await ctx.store.getApproval(hh, approval.id);
    ok(res, { ok: true, approval: updated, executed });
  });

  // ---- 行動台帳 ----
  router.get('/api/family/ledger', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const date = toDateKey(qstr(req, 'date'), ctx.clock());
    const entries = await ctx.store.listLedger(hh, date);
    ok(res, { date, entries });
  });

  // ---- 設定 ----
  router.get('/api/family/settings', async (req: Request, res: Response) => {
    requireFamily(req);
    const h = await mustHousehold(ctx, hhOf(req));
    ok(res, {
      name: h.name,
      person: h.person,
      plan: h.plan,
      policy: h.policy,
      contacts: h.contacts ?? {},
      members: [...h.members].sort((a, b) => a.order - b.order).map(memberPublic),
      killSwitch: h.killSwitch,
      taskKeys: TASK_KEYS,
      taskLabels: TASK_LABELS,
    });
  });

  router.put('/api/family/settings', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const parsed = SettingsSchema.safeParse(bodyOf(req));
    if (!parsed.success) {
      const msg = parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.') || '(設定)'}: ${i.message}`).join(' / ');
      throw new HttpError(400, `設定の形が正しくありません: ${msg}`);
    }
    const current = await mustHousehold(ctx, hh);
    const patch = buildSettingsPatch(current, parsed.data);
    const fields = Object.keys(patch);
    if (fields.length === 0) throw new HttpError(400, '変える項目がありません');
    const now = ctx.clock();
    await ctx.store.updateHousehold(hh, { ...patch, updatedAt: now });
    await writeLedger(ctx, hh, now, { actor: ACTOR, kind: 'system', name: 'settings_change', args: { fields } });
    logEvent('settings_change', { hh, fields });
    const h = await mustHousehold(ctx, hh);
    ok(res, {
      ok: true,
      changed: fields,
      settings: {
        name: h.name, person: h.person, plan: h.plan, policy: h.policy, contacts: h.contacts ?? {},
        members: [...h.members].sort((a, b) => a.order - b.order).map(memberPublic),
        killSwitch: h.killSwitch,
      },
    });
  });

  // ---- 今すぐ止める／再開 ----
  router.post('/api/family/kill-switch', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const on = bodyOf(req).on;
    if (typeof on !== 'boolean') throw new HttpError(400, 'on は true か false です');
    await mustHousehold(ctx, hh);
    const now = ctx.clock();
    await ctx.store.updateHousehold(hh, { killSwitch: on, updatedAt: now });
    const name = on ? 'kill_switch_on' : 'kill_switch_off';
    await writeLedger(ctx, hh, now, { actor: ACTOR, kind: 'system', name, args: { on } });
    logEvent(name, { hh });
    ok(res, { ok: true, killSwitch: on });
  });

  // ---- できること・できないこと ----
  router.get('/api/family/capabilities', (req: Request, res: Response) => {
    requireFamily(req);
    ok(res, CAPABILITIES);
  });

  // ---- 通知の「確認した」（LINE が無い間の代わり）。body { falseAlarm: true } で「誤報だった」 ----
  router.post('/api/family/notices/:nt/ack', async (req: Request, res: Response, params) => {
    requireFamily(req);
    const hh = hhOf(req);
    const falseAlarm = bodyOf(req).falseAlarm;
    if (falseAlarm !== undefined && typeof falseAlarm !== 'boolean') throw new HttpError(400, 'falseAlarm は true か false です');
    const notice = falseAlarm === true
      ? await ctx.familyNotify.ack(hh, params.nt, APPROVER, ctx.clock(), { falseAlarm: true })
      : await ctx.familyNotify.ack(hh, params.nt, APPROVER, ctx.clock());
    if (!notice) throw new HttpError(404, 'この通知は見つかりません');
    ok(res, { ok: true, notice });
  });

  // ---- 再生モード ----
  router.get('/api/family/replay/scenarios', async (req: Request, res: Response) => {
    requireFamily(req);
    ok(res, { names: await listScenarioNames() });
  });

  router.post('/api/family/replay', async (req: Request, res: Response) => {
    requireFamily(req);
    const hh = hhOf(req);
    const body = bodyOf(req);
    const scenario = await scenarioFromBody(body);
    const agent = qstr(req, 'agent') === 'adk' ? 'adk' : 'rules';
    const withSummary = body.withSummary !== false && qstr(req, 'summary') !== '0';
    logEvent('replay_started', { hh, scenario: scenario.name ?? null, turns: scenario.turns.length, agent });
    const result = await runReplay(ctx, hh, scenario, { agent, withSummary });
    ok(res, result);
  });
}

