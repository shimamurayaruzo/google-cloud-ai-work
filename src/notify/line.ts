// LINE Messaging API の push 送信（docs/02 §4 notify_family, §5 段階上げ）。
// トークンは Cloud Run の環境変数 LINE_CHANNEL_ACCESS_TOKEN にだけ置く。

import { config } from '../config.js';
import { logError, logEvent, logWarn } from '../log.js';
import type { OutboundMessage, SendResult } from '../services.js';
import { maskId, truncate } from './mask.js';

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const TIMEOUT_MS = 10_000;

/** 「確認した」ボタンの postback データ。/webhook/line で `ack:<noticeId>` を解釈する */
export function ackPostbackData(noticeId: string): string {
  return `ack:${noticeId}`;
}

/** postback の data から noticeId を取り出す（形が違えば null） */
export function parseAckPostback(data: string | undefined | null): string | null {
  if (!data || !data.startsWith('ack:')) return null;
  const id = data.slice(4).trim();
  return id.length > 0 ? id : null;
}

/** push API に渡す messages を作る（テストしやすいよう分けてある） */
export function buildLineMessages(msg: OutboundMessage): unknown[] {
  const text = truncate(`${msg.title}\n${msg.body}`, 4900);
  const textMessage = { type: 'text', text };
  if (!msg.noticeId) return [textMessage];

  // buttons template の本文は 160 文字まで（タイトル付きは 60）なので、
  // 全文は text で送り、ボタンだけを 2 通目の template にする。
  const actions: unknown[] = [
    { type: 'postback', label: '確認した', data: ackPostbackData(msg.noticeId), displayText: '確認した' },
  ];
  if (msg.url && msg.url.startsWith('https://')) {
    actions.push({ type: 'uri', label: '家族画面を開く', uri: msg.url });
  }
  const buttons = {
    type: 'template',
    altText: truncate(`${msg.title} ${msg.body}`.replace(/\s+/g, ' '), 400),
    template: {
      type: 'buttons',
      text: '内容を見たら「確認した」を押してください。押されないと次の方へ知らせます。',
      actions,
    },
  };
  return [textMessage, buttons];
}

export async function sendLine(userId: string, msg: OutboundMessage): Promise<SendResult> {
  const token = config.line.channelAccessToken;
  if (!token) return { ok: false, error: 'not_configured' };
  if (!userId) return { ok: false, error: 'no_user_id' };

  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages: buildLineMessages(msg) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = truncate(await res.text().catch(() => ''), 200);
      logWarn('line_send_failed', { to: maskId(userId), status: res.status, detail, noticeId: msg.noticeId });
      return { ok: false, error: `http_${res.status}` };
    }
    logEvent('line_sent', { to: maskId(userId), noticeId: msg.noticeId });
    return { ok: true };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const error = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
    logError('line_send_error', e, { to: maskId(userId), noticeId: msg.noticeId });
    return { ok: false, error };
  }
}
