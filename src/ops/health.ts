// 運用エージェントの最小形（docs/02 §7、docs/01 §6.2 自己復旧）。
// /internal/health から 5 分ごとに runHealthCheck を呼ぶ。
// コードの修正やデプロイはしない。処置は「家族へ知らせる」「代替へ切り替える（health.degraded）」「Slack へ 1 行報告」だけ。
// Slack には件数と処置だけを書き、母の会話内容は流さない。

import type { AppContext } from '../services.js';
import type { Store } from '../store/types.js';
import { toDate } from '../store/types.js';
import type {
  DateKey, DegradedMode, HealthDay, HouseholdId, Incident, IncidentAction, IncidentKind, LedgerEntry,
} from '../types.js';
import { newId } from '../types.js';
import { addMinutes, dateKey, hhmm, minutesBetween, shiftDateKey } from '../time.js';
import { logError, logEvent } from '../log.js';

/** 生存信号がこの分数以上ないと途絶とみなす */
export const HEARTBEAT_LOST_MINUTES = 10;
/** incidents を数える窓 */
export const INCIDENT_WINDOW_MINUTES = 5;
/** この件数以上で代替へ切り替える */
export const DEGRADE_THRESHOLD = 3;
/** 代替を続ける分 */
export const DEGRADE_MINUTES = 30;
/** 生存信号途絶の通知の reason（家族画面・重複判定で使う） */
export const HEARTBEAT_LOST_REASON = '端末が応答していません';

const INCIDENT_KINDS: IncidentKind[] = ['tts_timeout', 'tts_error', 'llm_error', 'device_silent', 'notify_error'];

function emptyHealth(hh: HouseholdId, date: DateKey): HealthDay {
  return { hh, date, lastHeartbeatAt: null, incidents: [] };
}

async function appendLedger(store: Store, e: Omit<LedgerEntry, 'id'>): Promise<void> {
  try {
    await store.appendLedger({ id: newId('lg'), ...e });
  } catch (err) {
    logError('ledger_write_error', err, { hh: e.hh, name: e.name });
  }
}

/**
 * health/{date} に incident を 1 件追記し、台帳に health_incident（actor 'ops'）を書く。
 * detail には会話内容を入れない（チャネル名やエラー種別だけ）。
 */
export async function recordIncident(
  store: Store, hh: HouseholdId, kind: IncidentKind, action: IncidentAction, detail: string | undefined, now: Date,
): Promise<void> {
  const date = dateKey(now);
  const current = (await store.getHealth(hh, date)) ?? emptyHealth(hh, date);
  const incident: Incident = { at: now, kind, action, resolvedAt: null };
  if (detail) incident.detail = detail;
  await store.putHealth({ ...current, incidents: [...(current.incidents ?? []), incident] });
  logEvent('health_incident', { hh, kind, action, detail });
  await appendLedger(store, {
    hh, date, at: now, actor: 'ops', kind: 'health', name: 'health_incident',
    args: { kind, action }, ...(detail ? { result: { detail } } : {}),
  });
}

export interface HealthReport {
  hh: HouseholdId;
  date: DateKey;
  checkedAt: Date;
  heartbeatAgeMin: number | null;
  heartbeatLost: boolean;
  /** 直近 INCIDENT_WINDOW_MINUTES 分の件数 */
  recentIncidents: Record<IncidentKind, number>;
  /** 行った処置（日本語の短い文） */
  actions: string[];
  recovered: boolean;
  /** 点検後に有効な代替（なければ null） */
  degraded: DegradedMode | null;
}

function activeDegraded(d: DegradedMode | null | undefined, now: Date): DegradedMode | null {
  if (!d) return null;
  const until = toDate(d.until);
  if (!until || until.getTime() <= now.getTime()) return null;
  return { ...d, until };
}

/** state/ から使う: いま有効な代替（期限切れなら null）。health は getHealth(hh, dateKey(now)) の結果 */
export function currentDegraded(health: HealthDay | null | undefined, now: Date): DegradedMode | null {
  return activeDegraded(health?.degraded, now);
}

export async function runHealthCheck(ctx: AppContext, hh: HouseholdId, now: Date): Promise<HealthReport> {
  const { store } = ctx;
  const date = dateKey(now);
  const yDate = shiftDateKey(date, -1);
  const [household, today, yest] = await Promise.all([
    store.getHousehold(hh), store.getHealth(hh, date), store.getHealth(hh, yDate),
  ]);

  const actions: string[] = [];
  let recovered = false;
  const patch: Partial<HealthDay> = {};

  // ---- 1. 生存信号 ----
  const hbCandidates = [toDate(today?.lastHeartbeatAt), toDate(yest?.lastHeartbeatAt)]
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  const lastHb = hbCandidates.length ? new Date(Math.max(...hbCandidates.map(d => d.getTime()))) : null;
  const heartbeatAgeMin = lastHb ? minutesBetween(lastHb, now) : null;
  const heartbeatLost = heartbeatAgeMin === null || heartbeatAgeMin >= HEARTBEAT_LOST_MINUTES;
  const lostSince = today && today.heartbeatLostSince !== undefined
    ? toDate(today.heartbeatLostSince) ?? null
    : toDate(yest?.heartbeatLostSince) ?? null;

  if (heartbeatLost) {
    if (!lostSince) patch.heartbeatLostSince = now;
    if (!today?.heartbeatLostNotifiedAt) {
      const evidence = lastHb ? `最後の生存信号 ${hhmm(lastHb)}` : '生存信号の記録がありません';
      await appendLedger(store, {
        hh, date, at: now, actor: 'ops', kind: 'health', name: 'heartbeat_lost',
        args: { lastHeartbeatAt: lastHb?.toISOString() ?? null, ageMin: heartbeatAgeMin },
      });
      try {
        await recordIncident(store, hh, 'device_silent', 'notify', evidence, now);
      } catch (e) {
        logError('health_incident_error', e, { hh });
      }
      if (household?.killSwitch) {
        actions.push(`端末の沈黙を検知（停止中のため家族への通知は省略、${evidence}）`);
      } else {
        try {
          await ctx.familyNotify.notify({
            hh, date, level: 'info', reason: HEARTBEAT_LOST_REASON, evidence, turnId: null, now,
          });
          actions.push(`端末の沈黙を家族へ通知（${evidence}）`);
        } catch (e) {
          logError('heartbeat_notify_error', e, { hh });
          actions.push(`端末の沈黙を検知したが家族への通知に失敗（${evidence}）`);
        }
      }
      patch.heartbeatLostNotifiedAt = now;
    }
  } else if (lostSince) {
    patch.heartbeatLostSince = null;
    recovered = true;
    await appendLedger(store, {
      hh, date, at: now, actor: 'ops', kind: 'health', name: 'health_recovered',
      args: { what: 'heartbeat', lostSince: lostSince.toISOString() },
    });
    actions.push(`端末の生存信号が復旧（${hhmm(lostSince)} から途絶）`);
    // 静かな時間帯で翌朝に回していた「応答していません」は、もう送らない
    try {
      const open = await store.listOpenNotices(hh);
      for (const n of open) {
        if (n.state === 'deferred' && n.reason === HEARTBEAT_LOST_REASON) {
          await store.updateNotice(hh, n.id, { state: 'closed' });
        }
      }
    } catch (e) {
      logError('heartbeat_notice_close_error', e, { hh });
    }
  }

  // ---- 2. 直近の incidents ----
  const since = addMinutes(now, -INCIDENT_WINDOW_MINUTES).getTime();
  const recentIncidents = Object.fromEntries(INCIDENT_KINDS.map(k => [k, 0])) as Record<IncidentKind, number>;
  for (const inc of [...(yest?.incidents ?? []), ...(today?.incidents ?? [])]) {
    const at = toDate(inc.at);
    if (!at || at.getTime() < since || at.getTime() > now.getTime()) continue;
    if (inc.kind in recentIncidents) recentIncidents[inc.kind] += 1;
  }
  const ttsFails = recentIncidents.tts_timeout + recentIncidents.tts_error;
  const llmFails = recentIncidents.llm_error;

  const prevDegraded = activeDegraded(today?.degraded, now)
    ?? (today?.degraded === undefined ? activeDegraded(yest?.degraded, now) : null);
  let degraded: DegradedMode | null = prevDegraded ? { ...prevDegraded } : null;
  let degradedChanged = !today?.degraded && prevDegraded !== null; // 昨日から持ち越す
  const until = addMinutes(now, DEGRADE_MINUTES);

  if (ttsFails >= DEGRADE_THRESHOLD) {
    degraded = { ...(degraded ?? {}), tts: 'device', until };
    degradedChanged = true;
    actions.push(`音声合成の失敗 ${ttsFails} 件/${INCIDENT_WINDOW_MINUTES}分 → 端末の読み上げに切替（${hhmm(until)} まで）`);
    await appendLedger(store, {
      hh, date, at: now, actor: 'ops', kind: 'health', name: 'health_incident',
      args: { kind: 'tts', action: 'fallback', count: ttsFails }, result: { until: until.toISOString() },
    });
  } else if (ttsFails > 0) {
    actions.push(`音声合成の失敗 ${ttsFails} 件/${INCIDENT_WINDOW_MINUTES}分（再試行で継続）`);
  }

  if (llmFails >= DEGRADE_THRESHOLD) {
    degraded = { ...(degraded ?? {}), llm: 'rules', until };
    degradedChanged = true;
    actions.push(`会話 AI の失敗 ${llmFails} 件/${INCIDENT_WINDOW_MINUTES}分 → 規則の判定に切替（${hhmm(until)} まで）`);
    await appendLedger(store, {
      hh, date, at: now, actor: 'ops', kind: 'health', name: 'health_incident',
      args: { kind: 'llm', action: 'fallback', count: llmFails }, result: { until: until.toISOString() },
    });
  } else if (llmFails > 0) {
    actions.push(`会話 AI の失敗 ${llmFails} 件/${INCIDENT_WINDOW_MINUTES}分（再試行で継続）`);
  }

  if (recentIncidents.notify_error > 0) {
    actions.push(`家族への通知の送信失敗 ${recentIncidents.notify_error} 件/${INCIDENT_WINDOW_MINUTES}分`);
  }

  if (degradedChanged) {
    patch.degraded = degraded;
  } else if (!degraded && today?.degraded) {
    // 期限切れの代替を片付ける（今回また切り替えていないとき）
    patch.degraded = null;
    recovered = true;
    await appendLedger(store, {
      hh, date, at: now, actor: 'ops', kind: 'health', name: 'health_recovered',
      args: { what: 'degraded', was: { tts: today.degraded.tts ?? null, llm: today.degraded.llm ?? null } },
    });
    actions.push('代替を解除（通常の音声合成・会話 AI に戻す）');
  }

  // ---- 3. 書き込みと報告 ----
  // recordIncident や通知の失敗記録が途中で health を書いているので、読み直してから重ねる
  const fresh = (await store.getHealth(hh, date)) ?? emptyHealth(hh, date);
  await store.putHealth({ ...fresh, ...patch, lastCheckAt: now });

  const report: HealthReport = {
    hh, date, checkedAt: now, heartbeatAgeMin, heartbeatLost, recentIncidents, actions, recovered, degraded,
  };
  logEvent('health_check', {
    hh, heartbeatAgeMin, heartbeatLost, recentIncidents, actions: actions.length, recovered,
    degraded: degraded ? { tts: degraded.tts, llm: degraded.llm, until: degraded.until.toISOString() } : null,
  });

  if (actions.length > 0) {
    try {
      await ctx.notifier.sendOps(healthReportLine(report));
    } catch (e) {
      logError('ops_report_error', e, { hh });
    }
  }
  return report;
}

/** Slack 用 1 行。件数と処置だけ（会話内容は入れない） */
export function healthReportLine(r: HealthReport): string {
  const hb = r.heartbeatAgeMin === null
    ? '端末: 生存信号なし'
    : r.heartbeatLost ? `端末: 応答なし ${r.heartbeatAgeMin}分` : `端末: OK（${r.heartbeatAgeMin}分前）`;
  const c = r.recentIncidents;
  const counts = `直近${INCIDENT_WINDOW_MINUTES}分: TTS失敗${c.tts_timeout + c.tts_error}・AI失敗${c.llm_error}・通知失敗${c.notify_error}`;
  const acts = r.actions.length ? r.actions.join(' / ') : 'なし';
  return `[見守り運用] ${r.hh} ${r.date} ${hhmm(r.checkedAt)}｜${hb}｜${counts}｜処置: ${acts}`;
}
