// 通知の作成・送信・段階上げ（docs/02 §4 notify_family, §5 通知の段階上げ）。
//   createNotifier()     … LINE / メール / Slack(運用専用) の薄い層
//   createFamilyNotify() … notices の一生（open → waiting → acked / escalated、静かな時間帯は deferred）
// 家族への通知は「自動」の権限段階（docs/01 §6.1）。本人の返事の全文は載せない（evidence は 80 文字まで）。

import { config } from '../config.js';
import { logError, logEvent, logWarn } from '../log.js';
import { recordIncident } from '../ops/health.js';
import type {
  FamilyNotify, Notifier, NotifyRequest, OutboundMessage, SendResult, TaskScheduler,
} from '../services.js';
import type { Store } from '../store/types.js';
import { toDate } from '../store/types.js';
import {
  addMinutes, dateKey, hhmm, inQuietHours, jstDate, shiftDateKey, type Clock,
} from '../time.js';
import type {
  Channel, Household, HouseholdId, LedgerEntry, Member, Notice, NoticeLevel, NoticeStep,
} from '../types.js';
import { newId, TASK_LABELS } from '../types.js';
import { sendEmail } from './email.js';
import { sendLine } from './line.js';
import { maskEmail, maskId, truncate } from './mask.js';
import { sendSlack } from './slack.js';

export { parseAckPostback, ackPostbackData } from './line.js';

// ---------------------------------------------------------------------------
// 文面
// ---------------------------------------------------------------------------

const LEVEL_MARK: Record<NoticeLevel, string> = {
  urgent: '🔴 緊急',
  check: '🟡 確認してほしい',
  info: '🟢 お知らせ',
};

export function levelMark(level: NoticeLevel): string {
  return LEVEL_MARK[level];
}

/** evidence の最大文字数（本人の言葉を丸ごと載せない） */
export const EVIDENCE_MAX = 80;

/** 通知の文面。title = 印＋reason、body = evidence（80 文字まで）＋「家族画面で確認」 */
export function buildNoticeMessage(n: Notice, opts: { resend?: boolean } = {}): OutboundMessage {
  const prefix = opts.resend ? '【再送】' : '';
  const title = `${prefix}${levelMark(n.level)}：${n.reason}`;
  const lines: string[] = [];
  if (n.task) lines.push(`項目: ${TASK_LABELS[n.task] ?? n.task}`);
  const evidence = truncate(n.evidence.replace(/\s+/g, ' ').trim(), EVIDENCE_MAX);
  if (evidence) lines.push(evidence);
  lines.push('くわしくは家族画面で確認してください。');
  const msg: OutboundMessage = { title, body: lines.join('\n'), noticeId: n.id };
  if (config.serviceUrl) msg.url = `${config.serviceUrl.replace(/\/$/, '')}/`;
  return msg;
}

// ---------------------------------------------------------------------------
// Notifier（送信チャネルの薄い層）
// ---------------------------------------------------------------------------

export function createNotifier(): Notifier {
  return {
    async send(member: Member, channel: Channel, msg: OutboundMessage): Promise<SendResult> {
      switch (channel) {
        case 'line':
          if (!member.line?.userId) return { ok: false, error: 'not_configured' };
          return sendLine(member.line.userId, msg);
        case 'email':
          if (!member.email) return { ok: false, error: 'not_configured' };
          return sendEmail(member.email, msg);
        case 'slack':
          // SLACK_WEBHOOK_URL は運用専用。家族向けには使わない
          return { ok: false, error: 'not_for_family' };
        default:
          return { ok: false, error: 'unknown_channel' };
      }
    },
    async sendOps(text: string): Promise<SendResult> {
      if (!config.slackWebhookUrl) return { ok: false, error: 'not_configured' };
      return sendSlack(config.slackWebhookUrl, text);
    },
    channelsFor(member: Member): Channel[] {
      return member.line?.userId ? ['line', 'email'] : ['email'];
    },
  };
}

// ---------------------------------------------------------------------------
// FamilyNotify（通知の一生）
// ---------------------------------------------------------------------------

export interface FamilyNotifyDeps {
  store: Store;
  notifier: Notifier;
  tasks: TaskScheduler;
  clock: Clock;
}

/** 設定されていないだけ（障害ではない）エラー */
const NOT_CONFIGURED = new Set(['not_configured', 'no_user_id', 'not_for_family']);

const ACTIVE_STATES: ReadonlySet<Notice['state']> = new Set(['open', 'waiting', 'deferred']);

/** 静かな時間帯の終わり（now より後の最初の quiet.to） */
export function quietHoursEnd(now: Date, quiet: { from: string; to: string }): Date {
  const today = dateKey(now);
  const end = jstDate(today, quiet.to);
  if (end.getTime() > now.getTime()) return end;
  return jstDate(shiftDateKey(today, 1), quiet.to);
}

function sortedMembers(h: Household | null): Member[] {
  return [...(h?.members ?? [])].sort((a, b) => a.order - b.order);
}

function maskMember(m: Member, channel: Channel): string {
  if (channel === 'line') return maskId(m.line?.userId);
  if (channel === 'email') return maskEmail(m.email);
  return '';
}

export function createFamilyNotify(deps: FamilyNotifyDeps): FamilyNotify {
  const { store, notifier, tasks } = deps;

  async function ledger(e: Omit<LedgerEntry, 'id'>): Promise<void> {
    try {
      await store.appendLedger({ id: newId('lg'), ...e });
    } catch (err) {
      logError('ledger_write_error', err, { hh: e.hh, name: e.name, noticeId: e.noticeId });
    }
  }

  async function incident(hh: HouseholdId, detail: string, now: Date): Promise<void> {
    try {
      await recordIncident(store, hh, 'notify_error', 'retry', detail, now);
    } catch (e) {
      logError('health_incident_error', e, { hh });
    }
  }

  async function save(n: Notice, patch: Partial<Notice>): Promise<void> {
    Object.assign(n, patch);
    await store.updateNotice(n.hh, n.id, patch);
  }

  /** 1 人に、使えるチャネルを順に試す。step を 1 つ作って返す（全部失敗なら error 付き） */
  async function sendToMember(
    n: Notice, member: Member, channels: Channel[], now: Date, resend: boolean,
  ): Promise<{ step: NoticeStep; ok: boolean }> {
    const msg = buildNoticeMessage(n, { resend });
    const errors: string[] = [];
    let realError = false;
    let lastChannel: Channel = channels[0] ?? 'email';
    for (const channel of channels) {
      lastChannel = channel;
      let r: SendResult;
      try {
        r = await notifier.send(member, channel, msg);
      } catch (e) {
        logError('notify_error', e, { hh: n.hh, noticeId: n.id, memberId: member.id, channel });
        r = { ok: false, error: 'exception' };
      }
      if (r.ok) {
        if (errors.length) {
          logWarn('notify_channel_fallback', { hh: n.hh, noticeId: n.id, memberId: member.id, failed: errors, channel });
        }
        if (realError) await incident(n.hh, `${errors.join(',')} → ${channel}:ok`, now);
        return { step: { memberId: member.id, channel, sentAt: now, ackedAt: null }, ok: true };
      }
      const err = r.error ?? 'unknown';
      errors.push(`${channel}:${err}`);
      if (!NOT_CONFIGURED.has(err)) realError = true;
      logWarn('notify_send_failed', {
        hh: n.hh, noticeId: n.id, memberId: member.id, channel, to: maskMember(member, channel), error: err,
      });
    }
    const detail = errors.length ? errors.join(',') : 'no_channel';
    logError('notify_error', new Error(`送信できませんでした: ${detail}`), { hh: n.hh, noticeId: n.id, memberId: member.id });
    await incident(n.hh, detail, now);
    return { step: { memberId: member.id, channel: lastChannel, sentAt: now, ackedAt: null, error: detail }, ok: false };
  }

  async function scheduleEscalate(n: Notice, waitMinutes: number, now: Date): Promise<void> {
    const runAt = addMinutes(now, Math.max(1, waitMinutes));
    try {
      await tasks.schedule('/internal/escalate', { hh: n.hh, noticeId: n.id }, runAt);
    } catch (e) {
      logError('notify_error', e, { hh: n.hh, noticeId: n.id, what: 'escalate_schedule_failed' });
      await incident(n.hh, 'escalate_schedule_failed', now);
    }
  }

  /**
   * members[start] から順に送る。届かなかった人（全チャネル失敗）はその場で次の人へ進む
   * （届いていない人の「確認した」を待っても意味がないので）。
   * 届いた人がいれば waiting にして、その人の waitMinutes 後に /internal/escalate を予約する。
   * 誰にも届かなければ最後の人の waitMinutes 後に予約する（escalate が全員への再送＝再試行になる）。
   */
  async function deliverFrom(n: Notice, members: Member[], start: number, now: Date, ledgerDate: string): Promise<Notice> {
    const steps = [...n.steps];
    let delivered: Member | null = null;
    let last: Member | null = null;
    for (let i = start; i < members.length && !delivered; i++) {
      const member = members[i];
      last = member;
      const { step, ok } = await sendToMember(n, member, notifier.channelsFor(member), now, false);
      steps.push(step);
      await ledger({
        hh: n.hh, date: ledgerDate, at: now, actor: 'agent', kind: 'notice', name: 'notice_sent',
        args: { level: n.level, reason: n.reason, memberId: member.id, channel: step.channel, order: member.order },
        result: ok ? { delivered: true } : { delivered: false, error: step.error },
        noticeId: n.id, turnId: n.turnId,
      });
      if (ok) delivered = member;
    }
    await save(n, { steps, state: 'waiting' });
    const waitFor = delivered ?? last;
    if (waitFor) await scheduleEscalate(n, waitFor.waitMinutes, now);
    logEvent('notice_sent', {
      hh: n.hh, noticeId: n.id, level: n.level, delivered: Boolean(delivered), memberId: waitFor?.id,
    });
    return n;
  }

  /** 送信の本体（notify と flushDeferred で共有）。members が空なら open のまま */
  async function deliver(n: Notice, household: Household | null, now: Date, ledgerDate: string): Promise<Notice> {
    const members = sortedMembers(household);
    if (members.length === 0) {
      logWarn('notice_no_members', { hh: n.hh, noticeId: n.id });
      await save(n, { state: 'open' });
      await ledger({
        hh: n.hh, date: ledgerDate, at: now, actor: 'agent', kind: 'notice', name: 'notice_sent',
        args: { level: n.level, reason: n.reason, memberId: null, channel: null },
        result: { delivered: false, reason: 'no_members' },
        noticeId: n.id, turnId: n.turnId,
      });
      return n;
    }
    return deliverFrom(n, members, 0, now, ledgerDate);
  }

  /** 全員未確認: 全員にメールで再送し escalated（メールが使えない人は LINE で再送） */
  async function finalEscalate(n: Notice, members: Member[], now: Date): Promise<Notice> {
    const steps = [...n.steps];
    let deliveredCount = 0;
    for (const member of members) {
      const channels: Channel[] = [];
      if (member.email) channels.push('email');
      if (member.line?.userId) channels.push('line');
      if (channels.length === 0) channels.push('email');
      const { step, ok } = await sendToMember(n, member, channels, now, true);
      steps.push(step);
      if (ok) deliveredCount++;
    }
    await save(n, { steps, state: 'escalated' });
    await ledger({
      hh: n.hh, date: dateKey(now), at: now, actor: 'agent', kind: 'notice', name: 'notice_escalated',
      args: { level: n.level, reason: n.reason, memberIds: members.map(m => m.id), channel: 'email' },
      result: { delivered: deliveredCount, total: members.length },
      noticeId: n.id, turnId: n.turnId,
    });
    logEvent('notice_escalated', { hh: n.hh, noticeId: n.id, delivered: deliveredCount, total: members.length });
    return n;
  }

  function isSameItem(n: Notice, req: NotifyRequest): boolean {
    if (n.level !== req.level || !ACTIVE_STATES.has(n.state)) return false;
    // 項目があれば項目で、無ければ（端末の沈黙など）reason で同じものとみなす
    return req.task ? n.task === req.task : !n.task && n.reason === req.reason;
  }

  return {
    async notify(req: NotifyRequest): Promise<Notice> {
      const { hh, now } = req;
      const existing = (await store.listNotices(hh, req.date)).find(n => isSameItem(n, req));
      if (existing) {
        logEvent('notice_deduped', { hh, noticeId: existing.id, level: req.level, task: req.task ?? null });
        return existing;
      }

      const household = await store.getHousehold(hh);
      if (!household) logWarn('notice_household_missing', { hh });

      const notice: Notice = {
        id: newId('nt'),
        hh,
        date: req.date,
        level: req.level,
        reason: req.reason,
        evidence: truncate(req.evidence ?? '', EVIDENCE_MAX),
        turnId: req.turnId ?? null,
        steps: [],
        state: 'open',
        createdAt: now,
      };
      if (req.task) notice.task = req.task;

      const quiet = household?.policy?.quietHours;
      if (req.level !== 'urgent' && quiet && inQuietHours(now, quiet)) {
        notice.state = 'deferred';
        notice.deferredUntil = quietHoursEnd(now, quiet);
        await store.putNotice(notice);
        await ledger({
          hh, date: req.date, at: now, actor: 'agent', kind: 'notice', name: 'notice_sent',
          args: { level: notice.level, reason: notice.reason, memberId: null, channel: null },
          result: { delivered: false, reason: 'quiet_hours', deferredUntil: notice.deferredUntil.toISOString() },
          noticeId: notice.id, turnId: notice.turnId,
        });
        logEvent('notice_deferred', { hh, noticeId: notice.id, level: notice.level, until: hhmm(notice.deferredUntil) });
        return notice;
      }

      await store.putNotice(notice);
      return deliver(notice, household, now, req.date);
    },

    async ack(hh, noticeId, memberId, now) {
      const n = await store.getNotice(hh, noticeId);
      if (!n) return null;
      const steps = n.steps.map(s => ({ ...s }));
      let idx = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].memberId === memberId) { idx = i; break; }
      }
      if (idx < 0) idx = steps.length - 1;
      if (idx >= 0 && !steps[idx].ackedAt) steps[idx].ackedAt = now;
      const wasAcked = n.state === 'acked';
      await save(n, { steps, state: 'acked', ackedBy: n.ackedBy ?? memberId });
      if (!wasAcked) {
        await ledger({
          hh, date: dateKey(now), at: now, actor: `member:${memberId}`, kind: 'notice', name: 'notice_acked',
          args: { memberId }, result: { state: 'acked' }, noticeId, turnId: n.turnId,
        });
        logEvent('notice_acked', { hh, noticeId, memberId });
      }
      return n;
    },

    async escalate(hh, noticeId, now) {
      const n = await store.getNotice(hh, noticeId);
      if (!n) return null;
      if (n.state !== 'waiting') {
        logEvent('notice_escalate_skipped', { hh, noticeId, state: n.state });
        return n;
      }
      const household = await store.getHousehold(hh);
      const members = sortedMembers(household);
      const tried = new Set(n.steps.map(s => s.memberId));
      const maxOrder = Math.max(-Infinity, ...members.filter(m => tried.has(m.id)).map(m => m.order));
      const nextIndex = members.findIndex(m => m.order > maxOrder && !tried.has(m.id));
      if (nextIndex >= 0) return deliverFrom(n, members, nextIndex, now, dateKey(now));
      if (members.length === 0) return n;
      return finalEscalate(n, members, now);
    },

    async flushDeferred(hh, now) {
      const due = (await store.listOpenNotices(hh))
        .filter(n => n.state === 'deferred')
        .filter(n => {
          const until = toDate(n.deferredUntil);
          return !until || until.getTime() <= now.getTime();
        })
        .sort((a, b) => (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0));
      if (due.length === 0) return 0;
      const household = await store.getHousehold(hh);
      let count = 0;
      for (const n of due) {
        try {
          await deliver(n, household, now, dateKey(now));
          count++;
        } catch (e) {
          logError('notify_error', e, { hh, noticeId: n.id, what: 'flush_deferred' });
        }
      }
      logEvent('notice_flushed', { hh, count });
      return count;
    },
  };
}
