import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLineMessages, parseAckPostback, parseNoticePostback, sendLine } from '../src/notify/line.js';
import { sendSlack } from '../src/notify/slack.js';
import { sendEmail } from '../src/notify/email.js';
import { maskEmail, maskId } from '../src/notify/mask.js';
import { createNotifier } from '../src/notify/index.js';
import { member } from './notify-fakes.js';

test('LINE: noticeId があれば本文＋「確認した」「誤報だった」postback ボタン', () => {
  const msgs = buildLineMessages({ title: '【至急】14:05', body: '転んじゃった', noticeId: 'nt_abc', url: 'https://x.run.app/' }) as Array<Record<string, any>>;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].type, 'text');
  assert.equal(msgs[0].text, '【至急】14:05\n転んじゃった');
  assert.equal(msgs[1].type, 'template');
  assert.ok(msgs[1].altText.startsWith('【至急】14:05'));
  assert.equal(msgs[1].template.actions[0].data, 'ack:nt_abc');
  assert.equal(msgs[1].template.actions[1].label, '誤報だった');
  assert.equal(msgs[1].template.actions[1].data, 'false:nt_abc');
  assert.equal(msgs[1].template.actions[2].uri, 'https://x.run.app/');
  assert.ok(msgs[1].template.actions.length <= 4);   // buttons template の上限
  assert.equal(parseAckPostback(msgs[1].template.actions[0].data), 'nt_abc');
  assert.equal(parseAckPostback('other'), null);
  assert.deepEqual(parseNoticePostback('ack:nt_abc'), { noticeId: 'nt_abc', falseAlarm: false });
  assert.deepEqual(parseNoticePostback('false:nt_abc'), { noticeId: 'nt_abc', falseAlarm: true });
  assert.equal(parseNoticePostback('false:'), null);
  assert.equal(parseNoticePostback('nope:nt_abc'), null);
});

test('LINE: noticeId が無ければ text だけ', () => {
  const msgs = buildLineMessages({ title: 't', body: 'b' }) as Array<Record<string, any>>;
  assert.deepEqual(msgs, [{ type: 'text', text: 't\nb' }]);
});

test('トークン未設定の LINE とメール（スタブ）は not_configured', async () => {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    assert.deepEqual(await sendLine('U123', { title: 't', body: 'b' }), { ok: false, error: 'not_configured' });
  }
  assert.deepEqual(await sendEmail('a@example.com', { title: 't', body: 'b' }), { ok: false, error: 'not_configured' });
});

test('Slack: Webhook に text を POST。URL が空なら not_configured', async () => {
  assert.deepEqual(await sendSlack('', 'x'), { ok: false, error: 'not_configured' });
  const orig = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await sendSlack('https://hooks.slack.test/abc', '1 行'), { ok: true });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls[0].url, 'https://hooks.slack.test/abc');
  assert.deepEqual(JSON.parse(calls[0].body), { text: '1 行' });
});

test('Notifier: チャネルの順番と、家族に Slack を使わないこと', async () => {
  const n = createNotifier();
  assert.deepEqual(n.channelsFor(member('a', 1)), ['line', 'email']);
  assert.deepEqual(n.channelsFor(member('b', 1, { line: undefined })), ['email']);
  assert.deepEqual(await n.send(member('c', 1), 'slack', { title: 't', body: 'b' }), { ok: false, error: 'not_for_family' });
  assert.deepEqual(await n.send(member('d', 1, { line: undefined }), 'line', { title: 't', body: 'b' }), { ok: false, error: 'not_configured' });
});

test('マスク: userId とメールをそのまま出さない', () => {
  assert.equal(maskId('U1234567890abcdef'), 'U123***ef');
  assert.equal(maskEmail('shima@example.com'), 's***@e***.com');
});
