// Cloud Logging 向け JSON 1 行ログ。イベント名は docs/02 §6 の台帳イベント名と同じものを使う。
export type LedgerEventName =
  | 'prompt_sent' | 'reply_received' | 'turn_classified' | 'tool_call' | 'tool_blocked'
  | 'recheck_scheduled' | 'notice_sent' | 'notice_acked' | 'notice_escalated'
  | 'approval_requested' | 'approval_decided' | 'summary_sent' | 'plan_proposed' | 'plan_approved'
  | 'kill_switch_on' | 'kill_switch_off' | 'heartbeat_lost' | 'health_incident' | 'health_recovered'
  | 'followup_scheduled' | 'followup_skipped' | 'l4_started' | 'l4_cleared';

export function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ severity: 'INFO', event, timestamp: new Date().toISOString(), ...data }));
}

export function logWarn(event: string, data: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ severity: 'WARNING', event, timestamp: new Date().toISOString(), ...data }));
}

export function logError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  const e = error as { message?: string; stack?: string } | undefined;
  console.error(JSON.stringify({
    severity: 'ERROR', event, timestamp: new Date().toISOString(),
    message: e?.message ?? String(error), stack: e?.stack, ...data,
  }));
}
