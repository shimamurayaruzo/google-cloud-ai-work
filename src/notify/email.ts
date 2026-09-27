// メール送信。提出版にはメール送信基盤が無いのでログだけ残して not_configured を返す。
// 将来 SendGrid / Gmail API などを差すのはこの関数（呼び出し側は変えなくてよい）。

import { logEvent } from '../log.js';
import type { OutboundMessage, SendResult } from '../services.js';
import { maskEmail } from './mask.js';

export async function sendEmail(to: string, msg: OutboundMessage): Promise<SendResult> {
  logEvent('email_stub', { to: maskEmail(to), title: msg.title, noticeId: msg.noticeId });
  return { ok: false, error: 'not_configured' };
}
