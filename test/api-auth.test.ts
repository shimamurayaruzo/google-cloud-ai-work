// 認証（src/api/auth.ts）のテスト。ネットワーク不要。
// config は読み込み時に環境変数を読むので、先に環境変数を決めてから動的に import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Request } from 'express';

process.env.APP_PASSPHRASE = 'test-passphrase';
process.env.DEVICE_TOKENS = 'hh_test:device-token-1,hh_other:device-token-2';
process.env.INTERNAL_TOKEN = 'internal-token-xyz';
process.env.LINE_CHANNEL_SECRET = 'line-secret-abc';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
delete process.env.TASKS_SERVICE_ACCOUNT;

const auth = await import('../src/api/auth.js');
const { HttpError } = await import('../src/api/router.js');

function mockReq(init: {
  method?: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string>; rawBody?: Buffer;
} = {}): Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    method: init.method ?? 'GET', path: '/', protocol: 'http', headers,
    body: init.body ?? {}, query: init.query ?? {}, rawBody: init.rawBody,
  } as unknown as Request;
}

function cookieReq(token: string): Request {
  return mockReq({ headers: { cookie: `other=1; ${auth.SESSION_COOKIE}=${encodeURIComponent(token)}` } });
}

async function rejectsWithStatus(p: Promise<unknown> | (() => unknown), status: number): Promise<void> {
  try {
    if (typeof p === 'function') await p(); else await p;
  } catch (e) {
    assert.ok(e instanceof HttpError, `HttpError を期待: ${String(e)}`);
    assert.equal((e as InstanceType<typeof HttpError>).status, status);
    return;
  }
  assert.fail(`status ${status} で失敗するはず`);
}

// ---- 合言葉 ----
test('合言葉: 一致・不一致', () => {
  assert.equal(auth.passphraseMatches('test-passphrase'), true);
  assert.equal(auth.passphraseMatches('test-passphrasE'), false);
  assert.equal(auth.passphraseMatches(''), false);
  assert.equal(auth.passphraseMatches(undefined), false);
});

test('合言葉 Cookie: 発行したトークンで認証が通る', () => {
  const token = auth.makeSessionToken();
  assert.match(token, /^\d+\.[0-9a-f]{64}$/);
  assert.equal(auth.isFamilyAuthed(cookieReq(token)), true);
  assert.doesNotThrow(() => auth.requireFamily(cookieReq(token)));
});

test('合言葉 Cookie: 期限切れは通らない', () => {
  const issuedAt = Date.now() - (auth.SESSION_TTL_SEC + 60) * 1000;
  const token = auth.makeSessionToken(issuedAt);
  assert.equal(auth.isFamilyAuthed(cookieReq(token)), false);
  // 期限の直前なら通る
  const fresh = auth.makeSessionToken(Date.now() - (auth.SESSION_TTL_SEC - 60) * 1000);
  assert.equal(auth.isFamilyAuthed(cookieReq(fresh)), true);
});

test('合言葉 Cookie: 改ざんは通らない', () => {
  const token = auth.makeSessionToken();
  const [exp, sig] = token.split('.');
  // 期限を延ばす
  assert.equal(auth.isFamilyAuthed(cookieReq(`${Number(exp) + 3600}.${sig}`)), false);
  // 署名を 1 文字変える
  const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  assert.equal(auth.isFamilyAuthed(cookieReq(`${exp}.${flipped}`)), false);
  // 形が違う
  assert.equal(auth.isFamilyAuthed(cookieReq('garbage')), false);
  assert.equal(auth.isFamilyAuthed(cookieReq(`abc.${sig}`)), false);
  // Cookie なし
  assert.equal(auth.isFamilyAuthed(mockReq()), false);
});

test('requireFamily: 未認証は 401、書き込みは JSON 以外 415', async () => {
  await rejectsWithStatus(() => auth.requireFamily(mockReq()), 401);
  const token = auth.makeSessionToken();
  const post = mockReq({ method: 'POST', headers: { cookie: `${auth.SESSION_COOKIE}=${token}`, 'content-type': 'application/x-www-form-urlencoded' } });
  await rejectsWithStatus(() => auth.requireFamily(post), 415);
  const postJson = mockReq({ method: 'POST', headers: { cookie: `${auth.SESSION_COOKIE}=${token}`, 'content-type': 'application/json; charset=utf-8' } });
  assert.doesNotThrow(() => auth.requireFamily(postJson));
});

test('safeNextPath: 外部への戻り先は既定の /family に', () => {
  assert.equal(auth.safeNextPath('/family?tab=plan'), '/family?tab=plan');
  assert.equal(auth.safeNextPath('//evil.example.com'), '/family');
  assert.equal(auth.safeNextPath('https://evil.example.com'), '/family');
  assert.equal(auth.safeNextPath('/\\evil.example.com'), '/family');
  assert.equal(auth.safeNextPath(undefined), '/family');
});

test('sessionCookieHeader: HttpOnly・SameSite・https なら Secure', () => {
  const h = auth.sessionCookieHeader(mockReq({ headers: { 'x-forwarded-proto': 'https' } }), 'tok');
  assert.match(h, /^mimamori_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(auth.sessionCookieHeader(mockReq(), 'tok'), /Secure/);
});

test('renderLoginPage: エラー文と next はエスケープされる', () => {
  const html = auth.renderLoginPage({ next: '/family"><script>', error: '<b>x</b>' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

// ---- 端末 ----
test('requireDevice: 正しいトークンで世帯が決まる', () => {
  assert.equal(auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'device-token-1' } })), 'hh_test');
  assert.equal(auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'device-token-2' } })), 'hh_other');
  assert.equal(auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'device-token-1' }, body: { hh: 'hh_test' } })), 'hh_test');
  assert.equal(auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'device-token-1' }, query: { hh: 'hh_test' } })), 'hh_test');
});

test('requireDevice: トークンなし・違うトークンは 401、世帯の食い違いは 403', async () => {
  await rejectsWithStatus(() => auth.requireDevice(mockReq()), 401);
  await rejectsWithStatus(() => auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'nope' } })), 401);
  await rejectsWithStatus(() => auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'device-token-1' }, body: { hh: 'hh_other' } })), 403);
  await rejectsWithStatus(() => auth.requireDevice(mockReq({ headers: { 'X-Device-Token': 'device-token-1' }, query: { hh: 'hh_other' } })), 403);
});

// ---- 内部 ----
test('requireInternal: X-Internal-Token が一致すれば通る', async () => {
  await auth.requireInternal(mockReq({ method: 'POST', headers: { 'X-Internal-Token': 'internal-token-xyz' } }));
});

test('requireInternal: 違う内部トークン・認証なしは 401', async () => {
  await rejectsWithStatus(auth.requireInternal(mockReq({ method: 'POST', headers: { 'X-Internal-Token': 'wrong' } })), 401);
  await rejectsWithStatus(auth.requireInternal(mockReq({ method: 'POST' })), 401);
});

test('requireInternal: OIDC はサービスアカウントで email_verified のときだけ通る（検証は差し替え）', async () => {
  const req = () => mockReq({ method: 'POST', headers: { Authorization: 'Bearer fake.id.token' } });
  try {
    auth.setIdTokenVerifierForTest(async () => ({ email: 'scheduler@test-project.iam.gserviceaccount.com', email_verified: true } as never));
    await auth.requireInternal(req());

    auth.setIdTokenVerifierForTest(async () => ({ email: '123-compute@developer.gserviceaccount.com', email_verified: true } as never));
    await auth.requireInternal(req());

    auth.setIdTokenVerifierForTest(async () => ({ email: 'someone@gmail.com', email_verified: true } as never));
    await rejectsWithStatus(auth.requireInternal(req()), 401);

    auth.setIdTokenVerifierForTest(async () => ({ email: 'sa@other-project.iam.gserviceaccount.com', email_verified: true } as never));
    await rejectsWithStatus(auth.requireInternal(req()), 401);

    auth.setIdTokenVerifierForTest(async () => ({ email: 'scheduler@test-project.iam.gserviceaccount.com', email_verified: false } as never));
    await rejectsWithStatus(auth.requireInternal(req()), 401);

    auth.setIdTokenVerifierForTest(async () => { throw new Error('bad token'); });
    await rejectsWithStatus(auth.requireInternal(req()), 401);
  } finally {
    auth.setIdTokenVerifierForTest(null);
  }
});

// ---- LINE ----
test('verifyLineSignature: rawBody の HMAC-SHA256(base64) と一致すれば true', () => {
  const raw = Buffer.from(JSON.stringify({ destination: 'x', events: [{ type: 'follow' }] }), 'utf8');
  const sig = crypto.createHmac('sha256', 'line-secret-abc').update(raw).digest('base64');
  assert.equal(auth.verifyLineSignature(mockReq({ method: 'POST', headers: { 'x-line-signature': sig }, rawBody: raw })), true);
  // 本文が 1 文字違う
  const tampered = Buffer.from(raw.toString('utf8').replace('follow', 'Follow'), 'utf8');
  assert.equal(auth.verifyLineSignature(mockReq({ method: 'POST', headers: { 'x-line-signature': sig }, rawBody: tampered })), false);
  // 署名なし
  assert.equal(auth.verifyLineSignature(mockReq({ method: 'POST', rawBody: raw })), false);
});

test('verifyLineSignature: rawBody が無ければ JSON.stringify(body) で比べる', () => {
  const body = { events: [] };
  const sig = crypto.createHmac('sha256', 'line-secret-abc').update(JSON.stringify(body)).digest('base64');
  assert.equal(auth.verifyLineSignature(mockReq({ method: 'POST', headers: { 'x-line-signature': sig }, body })), true);
});
