// 認証 3 種類（docs/02 §3）: 家族（合言葉 Cookie）、端末（X-Device-Token）、内部（OIDC か内部トークン）。
// 加えて LINE Webhook の署名検証。
// 合言葉ロックは旧 index.js から移植（Cookie 名と既定の戻り先だけ変えた）。

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { config } from '../config.js';
import { logEvent, logWarn } from '../log.js';
import type { HouseholdId } from '../types.js';
import { HttpError, json } from './router.js';
import { bodyOf, header, qstr } from './util.js';

// ===========================================================================
// 家族: 合言葉ロック
// ===========================================================================

export const SESSION_COOKIE = 'mimamori_session';
export const SESSION_TTL_SEC = 60 * 60 * 12;
const DEFAULT_NEXT = '/family';

function passphrase(): string {
  return config.appPassphrase ?? '';
}

function sessionSecret(): Buffer {
  return crypto.createHash('sha256').update('mimamori-session:' + passphrase()).digest();
}

function sign(exp: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(exp).digest('hex');
}

/** "有効期限(秒).署名" のトークン。nowMs はテスト用 */
export function makeSessionToken(nowMs: number = Date.now()): string {
  const exp = String(Math.floor(nowMs / 1000) + SESSION_TTL_SEC);
  return exp + '.' + sign(exp);
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = header(req, 'cookie') ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // 壊れた Cookie は無視
      }
    }
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 合言葉 Cookie が有効か。合言葉が未設定なら常に false（家族画面は開けない） */
export function isFamilyAuthed(req: Request, nowMs: number = Date.now()): boolean {
  if (!passphrase()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(nowMs / 1000)) return false;
  return safeEqual(sig, sign(exp));
}

export function passphraseMatches(input: unknown = ''): boolean {
  if (!passphrase()) return false;
  return safeEqual(String(input ?? ''), passphrase());
}

export function safeNextPath(value: unknown = ''): string {
  const v = typeof value === 'string' ? value : '';
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : DEFAULT_NEXT;
}

export function sessionCookieHeader(req: Request, token: string, maxAge: number = SESSION_TTL_SEC): string {
  const proto = header(req, 'x-forwarded-proto') ?? req.protocol;
  const secure = proto === 'https';
  return (
    SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
    (secure ? '; Secure' : '')
  );
}

export function escapeHtml(value: unknown = ''): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderLoginPage({ next = DEFAULT_NEXT, error = '' }: { next?: string; error?: string } = {}): string {
  const notConfigured = !passphrase();
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>合言葉の入力</title>
  <style>
    body { font-family: sans-serif; background: #f4f6f3; color: #1f2a24; margin: 0; }
    .box { max-width: 420px; margin: 80px auto; background: #fff; border: 1px solid #d9dfda; border-radius: 8px; padding: 28px; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    p { font-size: 14px; color: #4a5650; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; font-size: 16px; border: 1px solid #d9dfda; border-radius: 6px; }
    button { margin-top: 12px; width: 100%; padding: 10px; font-size: 15px; background: #1f6f5b; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
    .err { color: #b4443c; font-size: 13px; }
    a { color: #1f6f5b; }
  </style>
</head>
<body>
  <div class="box">
    <h1>合言葉の入力</h1>
    ${notConfigured
      ? '<p class="err">サーバー側で APP_PASSPHRASE が設定されていません。Cloud Run の環境変数に合言葉を設定してください。</p>'
      : '<p>家族の画面（今日の様子・承認・設定）は、合言葉を知っている人だけが開けます。</p>'}
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <input type="password" name="passphrase" placeholder="合言葉" autocomplete="current-password" ${notConfigured ? 'disabled' : ''}>
      <button type="submit" ${notConfigured ? 'disabled' : ''}>入る</button>
    </form>
    <p><a href="/">トップへ戻る</a></p>
  </div>
</body>
</html>`;
}

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(html);
}

/** 家族 API の入口で呼ぶ。未認証は 401 JSON。
 *  書き込み（GET 以外）は Content-Type: application/json を必須にして、他サイトのフォームからの送信を防ぐ。 */
export function requireFamily(req: Request): void {
  if (!isFamilyAuthed(req)) {
    throw new HttpError(401, '合言葉でログインしてください');
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = header(req, 'content-type') ?? '';
    if (!ct.toLowerCase().includes('application/json')) {
      throw new HttpError(415, 'Content-Type: application/json で送ってください');
    }
  }
}

export const familyLoginHandlers = {
  /** GET /login */
  page(req: Request, res: Response): void {
    sendHtml(res, 200, renderLoginPage({ next: safeNextPath(qstr(req, 'next')) }));
  },

  /** POST /login（form: passphrase, next） */
  form(req: Request, res: Response): void {
    const body = bodyOf(req);
    const next = safeNextPath(body.next);
    if (passphraseMatches(body.passphrase)) {
      logEvent('login_success', { next });
      res.set('Set-Cookie', sessionCookieHeader(req, makeSessionToken()));
      res.redirect(303, next);
      return;
    }
    logEvent('login_failed', {});
    sendHtml(res, 401, renderLoginPage({ next, error: '合言葉が違います。' }));
  },

  /** POST /api/family/login（JSON: { passphrase }）→ { ok } */
  api(req: Request, res: Response): void {
    const body = bodyOf(req);
    if (!passphrase()) {
      json(res, 503, { ok: false, error: 'サーバー側で合言葉（APP_PASSPHRASE）が設定されていません' });
      return;
    }
    if (passphraseMatches(body.passphrase)) {
      logEvent('login_success', { via: 'api' });
      res.set('Set-Cookie', sessionCookieHeader(req, makeSessionToken()));
      json(res, 200, { ok: true });
      return;
    }
    logEvent('login_failed', { via: 'api' });
    json(res, 401, { ok: false, error: '合言葉が違います' });
  },

  /** GET/POST /logout → Cookie を消して / へ */
  logout(req: Request, res: Response): void {
    res.set('Set-Cookie', sessionCookieHeader(req, '', 0));
    res.redirect(303, '/');
  },

  /** POST /api/family/logout → { ok } */
  apiLogout(req: Request, res: Response): void {
    res.set('Set-Cookie', sessionCookieHeader(req, '', 0));
    json(res, 200, { ok: true });
  },

  /** GET /api/family/session → { ok, authed, passphraseConfigured }（画面の出し分け用。認証は不要） */
  session(req: Request, res: Response): void {
    json(res, 200, { ok: true, authed: isFamilyAuthed(req), passphraseConfigured: Boolean(passphrase()) });
  },
};

// ===========================================================================
// 端末: X-Device-Token
// ===========================================================================

/** X-Device-Token を DEVICE_TOKENS と照合して世帯 ID を返す。
 *  body / query に hh があれば、トークンの世帯と一致するか確かめる。 */
export function requireDevice(req: Request): HouseholdId {
  const token = header(req, 'x-device-token') ?? '';
  if (!token) throw new HttpError(401, '端末トークン（X-Device-Token）がありません');
  let found: HouseholdId | null = null;
  for (const [hh, t] of Object.entries(config.deviceTokens)) {
    if (t && safeEqual(token, t)) { found = hh; break; }
  }
  if (!found) throw new HttpError(401, '端末トークンが正しくありません');
  const claimed = bodyOf(req).hh ?? qstr(req, 'hh');
  if (claimed != null && claimed !== '' && claimed !== found) {
    throw new HttpError(403, '端末トークンと世帯（hh）が一致しません');
  }
  return found;
}

// ===========================================================================
// 内部: Scheduler / Tasks
// ===========================================================================

export type IdTokenVerifier = (idToken: string, audience: string | undefined) => Promise<TokenPayload | undefined>;

let oauthClient: OAuth2Client | null = null;
const defaultVerifier: IdTokenVerifier = async (idToken, audience) => {
  oauthClient ??= new OAuth2Client();
  const ticket = await oauthClient.verifyIdToken({ idToken, audience });
  return ticket.getPayload();
};
let verifier: IdTokenVerifier = defaultVerifier;

/** テスト用: OIDC の検証を差し替える（null で元に戻す） */
export function setIdTokenVerifierForTest(fn: IdTokenVerifier | null): void {
  verifier = fn ?? defaultVerifier;
}

let warnedNoAudience = false;

/** OIDC のサービスアカウントとして受け入れるか。
 *  TASKS_SERVICE_ACCOUNT があればそれだけ。無ければ同じプロジェクトの SA（*.iam.gserviceaccount.com）と
 *  Compute 既定 SA（Cloud Run の既定。Tasks の OIDC に使われる）。 */
export function isAllowedServiceAccount(email: string | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (config.tasksServiceAccount) return e === config.tasksServiceAccount.toLowerCase();
  if (e.endsWith(`@${config.projectId.toLowerCase()}.iam.gserviceaccount.com`)) return true;
  return e.endsWith('-compute@developer.gserviceaccount.com');
}

/** /internal/* の入口。X-Internal-Token（両方非空で一致）か、Google 署名の OIDC ID トークンで通す */
export async function requireInternal(req: Request): Promise<void> {
  const given = header(req, 'x-internal-token') ?? '';
  if (given && config.internalToken && safeEqual(given, config.internalToken)) return;

  const authz = header(req, 'authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  if (m) {
    const audience = config.serviceUrl || undefined;
    if (!audience && !warnedNoAudience) {
      warnedNoAudience = true;
      logWarn('internal_auth_no_audience', { message: 'SERVICE_URL が未設定のため OIDC の audience を確かめていません' });
    }
    let payload: TokenPayload | undefined;
    try {
      payload = await verifier(m[1].trim(), audience);
    } catch (error) {
      logWarn('internal_auth_failed', { reason: (error as Error)?.message ?? 'verify failed' });
      throw new HttpError(401, 'OIDC トークンを確かめられませんでした');
    }
    if (payload?.email_verified && isAllowedServiceAccount(payload.email)) return;
    logWarn('internal_auth_rejected', { reason: 'service account not allowed' });
    throw new HttpError(401, 'このサービスアカウントからは呼べません');
  }
  throw new HttpError(401, '内部 API の認証がありません');
}

// ===========================================================================
// LINE Webhook の署名
// ===========================================================================

/** x-line-signature と HMAC-SHA256(channelSecret, 生の本文) の base64 を比べる */
export function verifyLineSignature(req: Request): boolean {
  const secret = config.line.channelSecret;
  if (!secret) return false;
  const sig = header(req, 'x-line-signature') ?? '';
  if (!sig) return false;
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const body = raw ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
  return safeEqual(sig, expected);
}
