// 通知の作成・送信・段階上げ（docs/02 §4 notify_family, §5 通知の段階上げ）。
//   createNotifier()     … LINE / メール / Slack(運用専用) の薄い層
//   createFamilyNotify() … notices の一生（open → waiting → acked / escalated、静かな時間帯は deferred）
// 家族への通知は「自動」の権限段階（docs/01 §6.1）。本人の返事の全文は載せない（evidence は 80 文字まで）。
// criteria v2: info（L2）は 1 日 5 件まで（超えたら deferred / daily_cap。夕方の要約にまとめ、翌朝には送らない）。
// 「確認した」に「誤報だった」を付けられる（ack の opts.falseAlarm）。誤報は day.signals.falseAlarmCount に数える。

import { config } from '../config.js';
import { logError, logEvent, logWarn } from '../log.js';
import { recordIncident } from '../ops/health.js';
import type {
  FamilyNotify, Notifier, NotifyRequest, OutboundMessage, SendResult, TaskScheduler,
} from '../services.js';
import type { Store } from '../store/types.js';
import { toDate } from '../store/types.js';
import {
  addMinutes, dateKey, hhmm, hm, inQuietHours, jstDate, shiftDateKey, type Clock,
} from '../time.js';
import type {
  Channel, Household, HouseholdId, LedgerEntry, Member, Notice, NoticeLevel, NoticeOrigin, NoticeStep,
} from '../types.js';
import { L4_SAY, REASSURANCE_SAY } from '../agent/rules.js';
import { newId, TASK_LABELS } from '../types.js';
import { sendEmail } from './email.js';
import { sendLine } from './line.js';
import { maskEmail, maskId, truncate } from './mask.js';
import { sendSlack } from './slack.js';

export { parseAckPostback, parseNoticePostback, ackPostbackData, falseAlarmPostbackData } from './line.js';

// ---------------------------------------------------------------------------
// 文面（report-design v2 2 節の型）
//   L2【お知らせ】… 返信不要の一文を末尾に
//   L3【確認をお願いします】HH:MM … 原文（80 文字まで）、何が AI から分からないか、具体的な行動 1 つ、「話せたら『確認した』」
//   L4【至急】HH:MM … 何が起きたか、本人に伝えている定型文、電話を促す。
//        L4 の語由来は「必要と思われたら 119 番へ」、無反応由来は ①家の電話 ②iPad の呼びかけ ③近くの人（119 には触れない）
// 住所・持病・薬は通知本文に載せない（report-design 0 節）。
// ---------------------------------------------------------------------------

const LEVEL_MARK: Record<NoticeLevel, string> = {
  urgent: '【至急】',
  check: '【確認をお願いします】',
  info: '【お知らせ】',
};

export function levelMark(level: NoticeLevel): string {
  return LEVEL_MARK[level];
}

/** evidence の最大文字数（本人の言葉を丸ごと載せない） */
export const EVIDENCE_MAX = 80;
/** 「今日の様子」は全文を送る（本人の言葉は要約側で 20〜40 文字の抜粋にしてある） */
const SUMMARY_EVIDENCE_MAX = 4000;
/** 1 日の L2（info）の上限（criteria 5 節 ★11）。今日の様子・計画・端末の沈黙は数えない */
export const DAILY_INFO_CAP = 5;
const CAP_EXEMPT: ReadonlySet<NoticeOrigin> = new Set(['summary', 'plan', 'device']);

export function countsTowardInfoCap(n: { level: NoticeLevel; origin?: NoticeOrigin }): boolean {
  return n.level === 'info' && !CAP_EXEMPT.has(n.origin ?? 'other');
}

const NO_REPLY_NEEDED = 'この通知への返信は不要です。';
const PRESS_ACK = '話せたら「確認した」を押してください。';
const UNCERTAIN_LINE = '判定は未確定です（AI の確信度が低いため、念のためお知らせします）。';

export interface NoticeMessageOptions {
  resend?: boolean;
  /** 呼び方（callName）・連絡先（contacts）・就寝時間帯を文面に使う */
  household?: Household | null;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstSentence(s: string): string {
  const i = s.indexOf('。');
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

function quoteOf(n: Notice): string {
  return truncate(oneLine(n.evidence ?? '').replace(/^「|」$/g, ''), EVIDENCE_MAX);
}

/** 通知の文面。title は段階の印と時刻、body は report-design 2 節の型 */
export function buildNoticeMessage(n: Notice, opts: NoticeMessageOptions = {}): OutboundMessage {
  const prefix = opts.resend ? '【再送】' : '';
  const h = opts.household ?? null;
  const callName = h?.person?.callName?.trim() || 'ご本人';
  const homePhone = h?.contacts?.homePhone?.trim();
  const nearby = h?.contacts?.nearby;
  const createdAt = n.createdAt instanceof Date ? n.createdAt : new Date(n.createdAt);
  const time = hm(createdAt);
  const quote = quoteOf(n);
  const origin: NoticeOrigin = n.origin ?? 'other';
  const lines: string[] = [];
  let title: string;

  if (n.level === 'info' && origin === 'summary') {
    // 今日の様子: 1 行目（見出し）を題に、残りを本文に
    const text = (n.evidence ?? '').trim();
    const [head, ...rest] = text.split('\n');
    title = `${prefix}${head || n.reason}`;
    const msg: OutboundMessage = { title, body: rest.join('\n').trim(), noticeId: n.id };
    if (config.serviceUrl) msg.url = `${config.serviceUrl.replace(/\/$/, '')}/`;
    return msg;
  }

  if (n.level === 'urgent') {
    title = `${prefix}${LEVEL_MARK.urgent}${time}`;
    if (origin === 'no_answer') {
      lines.push(`${firstSentence(n.reason)}。`);
      lines.push(`まず①家の電話${homePhone ? `（${homePhone}）` : ''}にかけて、声を聞いてください。②iPad の通話ボタンで呼びかけてください（スピーカーから大きな音が出ます）。`);
      if (nearby?.name && nearby.phone) lines.push(`次に③近くの ${nearby.name}さん（電話 ${nearby.phone}）に見に行ってもらってください。`);
      lines.push(`iPad からは 3 分ごとに「${REASSURANCE_SAY}」とだけ伝えています。`);
      lines.push('お返事がない理由（昼寝・入浴・聞こえなかった等）は、AI からは分かりません。');
    } else {
      lines.push(quote
        ? `${time} の声かけに、${callName}が「${quote}」とおっしゃいました。`
        : `${time} ${n.reason}。`);
      if (origin === 'fire') lines.push('火事・煙の可能性があります。');
      lines.push(`AI は「${L4_SAY}」と一度お伝えし、これ以上は質問をせず、3 分ごとに「${REASSURANCE_SAY}」とだけ伝えています。`);
      lines.push('どの程度か、動けるかは、AI からは分かりません。');
      if (n.uncertain) lines.push(UNCERTAIN_LINE);
      lines.push(homePhone ? `お電話（家の電話 ${homePhone}）で声を聞いてください。` : 'お電話で声を聞いてください。');
      lines.push(origin === 'fire' ? '火事・煙のときは 119 番へ。' : '必要と思われたら 119 番へ。');
    }
    if (origin === 'no_answer' && n.uncertain) lines.push(UNCERTAIN_LINE);
  } else if (n.level === 'check') {
    title = `${prefix}${LEVEL_MARK.check}${time}`;
    const call = homePhone ? `家の電話（${homePhone}）にかけてみてください。` : 'お電話で声を聞いてください。';
    switch (origin) {
      case 'pain':
      case 'pain_followup': {
        if (origin === 'pain_followup') lines.push(`${n.reason.split('。')[0]}。`);
        if (quote) lines.push(`${callName}が「${quote}」とおっしゃいました。`);
        else if (origin === 'pain') lines.push(`${callName}が${firstSentence(n.reason)}。`);
        lines.push('どの程度痛いか、動けるかは、AI からは分かりません。');
        if (n.uncertain) lines.push(UNCERTAIN_LINE);
        lines.push(`お早めに${call}`);
        lines.push(PRESS_ACK);
        if (origin === 'pain') {
          const followAt = addMinutes(createdAt, 180);
          const sleeping = h ? inQuietHours(followAt, h.policy?.sleepHours ?? { from: '21:30', to: '07:30' }) : false;
          if (!sleeping && dateKey(followAt) === dateKey(createdAt)) {
            lines.push(`3 時間ほど後（${hm(followAt)} ごろ）に一度、様子を聞き直してお知らせします。`);
          }
        }
        break;
      }
      case 'no_answer':
        lines.push(`${firstSentence(n.reason)}。`);
        lines.push('お返事がない理由（昼寝・入浴・聞こえなかった等）は、AI からは分かりません。');
        if (n.uncertain) lines.push(UNCERTAIN_LINE);
        lines.push(`家の電話${homePhone ? `（${homePhone}）` : ''}にかけてみてください。`);
        lines.push(PRESS_ACK);
        lines.push('次の声かけ（15 分後）でもお返事がなければ、あらためてお知らせします。');
        break;
      case 'not_done':
        lines.push(`${firstSentence(n.reason)}。`);
        if (quote) lines.push(`お返事: ${quote}`);
        lines.push('実際にできたかどうかは、AI からは分かりません。');
        if (n.uncertain) lines.push(UNCERTAIN_LINE);
        lines.push(call);
        lines.push(PRESS_ACK);
        break;
      case 'contact':
        lines.push(quote ? `${callName}から「${quote}」と頼まれました（こちらからは連絡していません）。` : `${n.reason}。`);
        if (n.uncertain) lines.push(UNCERTAIN_LINE);
        lines.push(`ご都合のよいときに、${call}`);
        lines.push(PRESS_ACK);
        break;
      default:
        lines.push(`${oneLine(n.reason)}${/[。）]$/.test(n.reason) ? '' : '。'}`);
        if (quote) lines.push(`根拠: ${quote}`);
        lines.push('それ以上のことは、AI からは分かりません。');
        if (n.uncertain) lines.push(UNCERTAIN_LINE);
        lines.push(call);
        lines.push(PRESS_ACK);
    }
  } else {
    title = `${prefix}${LEVEL_MARK.info}`;
    if (origin === 'repeat') {
      lines.push(oneLine(n.reason));
      if (quote) lines.push(quote);
      lines.push('夕方の「今日の様子」にも載せます。');
    } else if (origin === 'not_done') {
      lines.push(`${firstSentence(n.reason)}。`);
      if (quote) lines.push(`お返事: ${quote}`);
    } else {
      title = `${prefix}${LEVEL_MARK.info}${n.reason}`;
      // お風呂（origin bath）は「体を洗い始めました」「お風呂から上がりました」の両方があるので、項目は「お風呂」とだけ書く
      if (n.task && origin !== 'plan' && origin !== 'device') {
        lines.push(`項目: ${origin === 'bath' ? 'お風呂' : (TASK_LABELS[n.task] ?? n.task)}`);
      }
      const ev = truncate(oneLine(n.evidence ?? ''), origin === 'plan' ? 300 : EVIDENCE_MAX);
      if (ev) lines.push(ev);
    }
    if (n.uncertain) lines.push(UNCERTAIN_LINE);
    lines.push(NO_REPLY_NEEDED);
  }

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
    n: Notice, member: Member, channels: Channel[], now: Date, resend: boolean, household: Household | null,
  ): Promise<{ step: NoticeStep; ok: boolean }> {
    const msg = buildNoticeMessage(n, { resend, household });
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

  /** 「誤報だった」をその通知の日の signals.falseAlarmCount に数える（変化評価と夕方の要約の材料） */
  async function countFalseAlarm(hh: HouseholdId, date: string): Promise<void> {
    try {
      const day = await store.getDay(hh, date);
      if (!day) return;
      await store.updateDay(hh, date, { signals: { ...day.signals, falseAlarmCount: (day.signals.falseAlarmCount ?? 0) + 1 } });
    } catch (e) {
      logError('false_alarm_count_error', e, { hh, date });
    }
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
  async function deliverFrom(
    n: Notice, members: Member[], start: number, now: Date, ledgerDate: string, household: Household | null,
  ): Promise<Notice> {
    const steps = [...n.steps];
    let delivered: Member | null = null;
    let last: Member | null = null;
    for (let i = start; i < members.length && !delivered; i++) {
      const member = members[i];
      last = member;
      const { step, ok } = await sendToMember(n, member, notifier.channelsFor(member), now, false, household);
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
    // L2（info）は返信を求めないので、次の人への段階上げを予約しない（criteria 1 節）。届かなかったときだけ再試行する
    if (waitFor && (n.level !== 'info' || !delivered)) await scheduleEscalate(n, waitFor.waitMinutes, now);
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
    return deliverFrom(n, members, 0, now, ledgerDate, household);
  }

  /** 全員未確認: 全員にメールで再送し escalated（メールが使えない人は LINE で再送） */
  async function finalEscalate(n: Notice, members: Member[], now: Date, household: Household | null): Promise<Notice> {
    const steps = [...n.steps];
    let deliveredCount = 0;
    for (const member of members) {
      const channels: Channel[] = [];
      if (member.email) channels.push('email');
      if (member.line?.userId) channels.push('line');
      if (channels.length === 0) channels.push('email');
      const { step, ok } = await sendToMember(n, member, channels, now, true, household);
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
    // 由来が違えば別の通知（例: 同じ帰宅の項目で「痛み」と「連絡の依頼」）
    if ((n.origin ?? 'other') !== (req.origin ?? 'other')) return false;
    // 項目があれば項目で、無ければ（端末の沈黙など）reason で同じものとみなす
    return req.task ? n.task === req.task : !n.task && n.reason === req.reason;
  }

  return {
    async notify(req: NotifyRequest): Promise<Notice> {
      const { hh, now } = req;
      const todays = await store.listNotices(hh, req.date);
      const existing = todays.find(n => isSameItem(n, req));
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
        evidence: truncate(req.evidence ?? '', req.origin === 'summary' ? SUMMARY_EVIDENCE_MAX : EVIDENCE_MAX),
        turnId: req.turnId ?? null,
        steps: [],
        state: 'open',
        createdAt: now,
      };
      if (req.task) notice.task = req.task;
      if (req.origin) notice.origin = req.origin;
      if (req.uncertain) notice.uncertain = true;

      // L2（info）は 1 日 5 件まで。超えた分は送らず、夕方の「お知らせの続き」にまとめる（criteria 5 節 ★11）
      if (countsTowardInfoCap(notice)) {
        const sent = todays.filter(n => countsTowardInfoCap(n) && n.state !== 'deferred').length;
        if (sent >= DAILY_INFO_CAP) {
          notice.state = 'deferred';
          notice.deferredReason = 'daily_cap';
          await store.putNotice(notice);
          await ledger({
            hh, date: req.date, at: now, actor: 'agent', kind: 'notice', name: 'notice_sent',
            args: { level: notice.level, reason: notice.reason, memberId: null, channel: null },
            result: { delivered: false, reason: 'daily_cap', sentToday: sent },
            noticeId: notice.id, turnId: notice.turnId,
          });
          logEvent('notice_deferred', { hh, noticeId: notice.id, level: notice.level, reason: 'daily_cap' });
          return notice;
        }
      }

      const quiet = household?.policy?.quietHours;
      if (req.level !== 'urgent' && quiet && inQuietHours(now, quiet)) {
        notice.state = 'deferred';
        notice.deferredReason = 'quiet_hours';
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

    async ack(hh, noticeId, memberId, now, opts) {
      const n = await store.getNotice(hh, noticeId);
      if (!n) return null;
      const newlyFalseAlarm = opts?.falseAlarm === true && !n.falseAlarm;
      const steps = n.steps.map(s => ({ ...s }));
      let idx = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].memberId === memberId) { idx = i; break; }
      }
      if (idx < 0) idx = steps.length - 1;
      if (idx >= 0 && !steps[idx].ackedAt) steps[idx].ackedAt = now;
      const wasAcked = n.state === 'acked';
      await save(n, { steps, state: 'acked', ackedBy: n.ackedBy ?? memberId, ...(newlyFalseAlarm ? { falseAlarm: true } : {}) });
      if (!wasAcked || newlyFalseAlarm) {
        await ledger({
          hh, date: dateKey(now), at: now, actor: `member:${memberId}`, kind: 'notice', name: 'notice_acked',
          args: { memberId, falseAlarm: n.falseAlarm === true }, result: { state: 'acked' }, noticeId, turnId: n.turnId,
        });
        logEvent('notice_acked', { hh, noticeId, memberId, falseAlarm: n.falseAlarm === true });
      }
      if (newlyFalseAlarm) await countFalseAlarm(hh, n.date);
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
      if (nextIndex >= 0) return deliverFrom(n, members, nextIndex, now, dateKey(now), household);
      if (members.length === 0) return n;
      return finalEscalate(n, members, now, household);
    },

    async flushDeferred(hh, now) {
      const due = (await store.listOpenNotices(hh))
        .filter(n => n.state === 'deferred')
        // 1 日の上限で回した L2 は翌朝に送らない（その日の夕方の要約に載せてある）
        .filter(n => n.deferredReason !== 'daily_cap')
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
