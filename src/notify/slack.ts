// Slack Incoming Webhook。運用エージェントの報告専用（家族向けには使わない）。
// 母の会話内容は流さない。件数と処置だけ。

import { logError, logWarn } from '../log.js';
import type { SendResult } from '../services.js';

const TIMEOUT_MS = 10_000;

export async function sendSlack(webhookUrl: string, text: string): Promise<SendResult> {
  if (!webhookUrl) return { ok: false, error: 'not_configured' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Webhook URL は秘密なのでログに出さない
      logWarn('slack_send_failed', { status: res.status });
      return { ok: false, error: `http_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    logError('slack_send_error', e);
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' };
  }
}
