// ルート（src/api/index.ts）のテスト。Store とサービスはフェイク、Express の req/res は最小のモック。
// createRouter は state/ や agent/ など他担当のモジュールを import する。まだ揃っていないときは
// ルートのテストを skip し、静的配信のパス検査（他モジュールに依存しない）だけ走らせる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';

process.env.APP_PASSPHRASE = 'test-passphrase';
process.env.DEVICE_TOKENS = 'hh_test:device-token-1';
process.env.INTERNAL_TOKEN = 'internal-token-xyz';
process.env.HOUSEHOLD_ID = 'hh_test';
process.env.LINE_CHANNEL_SECRET = 'line-secret-abc';

const auth = await import('../src/api/auth.js');
const { HttpError } = await import('../src/api/router.js');
const staticMod = await import('../src/api/static.js');

type CreateRouter = typeof import('../src/api/index.js').createRouter;
let createRouter: CreateRouter | null = null;
let skipReason: string | false = false;
try {
  createRouter = (await import('../src/api/index.js')).createRouter;
} catch (e) {
  const err = e as { code?: string; message?: string };
  if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|does not provide an export/.test(err.message ?? '')) {
    skipReason = `他モジュール待ち: ${err.message?.split('\n')[0]}`;
  } else {
    throw e;
  }
}

// ---- フェイク ----
const NOW = new Date('2026-09-27T09:00:00+09:00');

function household() {
  return {
    id: 'hh_test', name: 'テスト世帯', timezone: 'Asia/Tokyo' as const,
    person: { callName: 'お母さん', wording: { diaper: 'おむつ' } },
    members: [
      { id: 'mem_2', name: '次男', order: 2, email: 'b@example.com', waitMinutes: 10 },
      { id: 'mem_1', name: '長男', order: 1, email: 'a@example.com', waitMinutes: 10, line: { userId: 'U_secret' } },
    ],
    plan: { weekday: { default: [{ time: '08:00', task: 'greeting' as const }], dayservice: [] }, dayserviceDays: ['Tue' as const, 'Fri' as const] },
    policy: { recheckOnce: true, recheckMinutes: 15 },
    killSwitch: false,
  };
}

function createFakeStore() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const data = {
    household: household() as ReturnType<typeof household> & Record<string, unknown>,
    prompts: [
      { id: 'pr_late', hh: 'hh_test', date: '2026-09-27', task: 'lunch', text: 'お昼ですよ', scheduledAt: new Date('2026-09-27T12:00:00+09:00'), isRecheck: false, state: 'queued', expression: 'smile' },
      { id: 'pr_soon', hh: 'hh_test', date: '2026-09-27', task: 'water', text: 'お茶をどうぞ', scheduledAt: new Date('2026-09-27T10:00:00+09:00'), isRecheck: false, state: 'queued', expression: 'smile' },
      { id: 'pr_done', hh: 'hh_test', date: '2026-09-27', task: 'greeting', text: 'おはよう', scheduledAt: new Date('2026-09-27T08:00:00+09:00'), isRecheck: false, state: 'answered', expression: 'smile' },
    ],
    turns: [
      {
        id: 'tn_1', hh: 'hh_test', date: '2026-09-01', promptId: 'pr_x', task: 'greeting',
        promptedAt: new Date('2026-09-01T08:00:00+09:00'), promptText: 'おはようございます',
        replyText: 'あ'.repeat(60), replySource: 'ipad', repliedAt: new Date('2026-09-01T08:00:30+09:00'),
        classified: { status: 'done', note: '', by: 'rules' }, toolCalls: [], say: 'よかったです', expression: 'smile', latencyMs: 5,
      },
    ],
    ledger: [] as unknown[],
  };
  const impl: Record<string, (...args: any[]) => unknown> = {
    async getHousehold(hh: string) { return hh === 'hh_test' ? data.household : null; },
    async updateHousehold(_hh: string, patch: Record<string, unknown>) { Object.assign(data.household, patch); },
    async recordHeartbeat() {},
    async listPrompts() { return data.prompts; },
    async getDay() { return null; },
    async listTurns(_hh: string, date: string) { return data.turns.filter(t => t.date === date); },
    async listNotices() { return []; },
    async getHealth() { return null; },
    async appendLedger(e: unknown) { data.ledger.push(e); },
  };
  const store = new Proxy({}, {
    get(_t, name: string) {
      if (name === 'then') return undefined;
      const f = impl[name];
      if (!f) return async () => { throw new Error(`フェイク store に ${name} がありません`); };
      return async (...args: unknown[]) => { calls.push({ name, args }); return f(...args); };
    },
  });
  return { store, calls, data };
}

function createCtx() {
  const fake = createFakeStore();
  const unused = new Proxy({}, { get: (_t, n) => (n === 'then' ? undefined : async () => { throw new Error(`使わないはず: ${String(n)}`); }) });
  const notifyCalls: Array<{ name: string; args: unknown[] }> = [];
  const familyNotify = {
    async ack(...args: unknown[]) { notifyCalls.push({ name: 'ack', args }); return { id: args[1], state: 'acked' }; },
    async escalate(...args: unknown[]) { notifyCalls.push({ name: 'escalate', args }); return args[1] === 'nt_1' ? { id: 'nt_1', state: 'waiting', steps: [{}, {}] } : null; },
    async flushDeferred() { return 0; },
    async notify() { throw new Error('使わないはず'); },
  };
  const ctx = {
    store: fake.store, clock: () => NOW, turnRunner: unused, notifier: unused, familyNotify, tasks: unused, tts: unused,
  };
  return { ctx: ctx as never, notifyCalls, ...fake };
}

// ---- req/res のモック ----
interface MockRes { statusCode: number; headers: Record<string, string>; body: unknown; headersSent: boolean; location?: string }

function mockReq(init: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string> }): Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  return { method: init.method ?? 'GET', path: init.path, protocol: 'http', headers, body: init.body ?? {}, query: init.query ?? {} } as unknown as Request;
}

function mockRes(): MockRes & Response {
  const r: MockRes & Record<string, unknown> = { statusCode: 200, headers: {}, body: undefined, headersSent: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.set = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (b: unknown) => { r.body = b; r.headersSent = true; return r; };
  r.redirect = (c: number, url: string) => { r.statusCode = c; r.location = url; r.headersSent = true; return r; };
  return r as unknown as MockRes & Response;
}

/** index.ts と同じ扱い（HttpError → JSON、未マッチ → 404） */
async function call(router: ReturnType<CreateRouter>, req: Request) {
  const res = mockRes();
  try {
    const matched = await router.dispatch(req, res);
    if (!matched) res.status(404).send(JSON.stringify({ ok: false, error: 'no route' }));
  } catch (e) {
    if (e instanceof HttpError) res.status(e.status).send(JSON.stringify({ ok: false, error: e.message }));
    else throw e;
  }
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* HTML など */ }
  return { status: res.statusCode, headers: res.headers, text, json };
}

const familyCookie = () => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.makeSessionToken())}`;

// ---- 静的配信のパス検査（他モジュールに依存しない） ----
test('resolveWebPath: .. や \\ や隠しファイル、未知の拡張子を拒否する', () => {
  assert.ok(staticMod.resolveWebPath('index.html'));
  assert.ok(staticMod.resolveWebPath('dev/device.html'));
  assert.equal(staticMod.resolveWebPath('../package.json'), null);
  assert.equal(staticMod.resolveWebPath('dev/../../package.json'), null);
  assert.equal(staticMod.resolveWebPath('dev\\..\\x.html'), null);
  assert.equal(staticMod.resolveWebPath('.env'), null);
  assert.equal(staticMod.resolveWebPath('dev/.secret.json'), null);
  assert.equal(staticMod.resolveWebPath('index.ts'), null);
  assert.equal(staticMod.resolveWebPath(''), null);
});

// ---- ルート ----
test('GET /healthz → { ok: true }', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const r = await call(createRouter!(ctx), mockReq({ path: '/healthz' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('GET / と /family は web/ の HTML を返し、.. は 404', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const router = createRouter!(ctx);
  const top = await call(router, mockReq({ path: '/' }));
  assert.equal(top.status, 200);
  assert.match(top.headers['content-type'], /text\/html/);
  const fam = await call(router, mockReq({ path: '/family' }));
  assert.equal(fam.status, 200);
  assert.match(fam.text, /家族 API の確認ページ/);
  const bad = await call(router, mockReq({ path: '/dev/..%2F..%2Fpackage.json' }));
  assert.equal(bad.status, 404);
});

test('POST /api/device/heartbeat: 生存信号を記録し、次の予定と停止スイッチを返す', { skip: skipReason }, async () => {
  const { ctx, calls } = createCtx();
  const r = await call(createRouter!(ctx), mockReq({
    method: 'POST', path: '/api/device/heartbeat',
    headers: { 'X-Device-Token': 'device-token-1', 'content-type': 'application/json' },
    body: { hh: 'hh_test', batteryPct: 80, appVersion: '0.1.0' },
  }));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.killSwitch, false);
  assert.deepEqual(r.json.nextPrompt, { at: new Date('2026-09-27T10:00:00+09:00').toISOString(), task: 'water' });
  const hb = calls.find(c => c.name === 'recordHeartbeat');
  assert.ok(hb);
  assert.deepEqual(hb!.args[0], { hh: 'hh_test', at: NOW, batteryPct: 80, appVersion: '0.1.0' });
});

test('POST /api/device/heartbeat: トークンなしは 401、世帯違いは 403', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const router = createRouter!(ctx);
  const r1 = await call(router, mockReq({ method: 'POST', path: '/api/device/heartbeat', body: { hh: 'hh_test' } }));
  assert.equal(r1.status, 401);
  const r2 = await call(router, mockReq({ method: 'POST', path: '/api/device/heartbeat', headers: { 'X-Device-Token': 'device-token-1' }, body: { hh: 'hh_other' } }));
  assert.equal(r2.status, 403);
});

test('GET /api/family/today: 返事は 40 文字まで、家族は名前と順番だけ', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const r = await call(createRouter!(ctx), mockReq({ path: '/api/family/today', query: { date: '2026-09-01' }, headers: { cookie: familyCookie() } }));
  assert.equal(r.status, 200);
  assert.equal(r.json.date, '2026-09-01');
  assert.equal(r.json.day, null);
  assert.equal(r.json.turns.length, 1);
  assert.equal(Array.from(r.json.turns[0].replyText as string).length, 41); // 40 文字 + …
  assert.ok((r.json.turns[0].replyText as string).endsWith('…'));
  assert.deepEqual(r.json.household, { killSwitch: false, members: [{ name: '長男', order: 1 }, { name: '次男', order: 2 }] });
  assert.ok(!r.text.includes('U_secret'), 'LINE の userId を出さない');
  assert.ok(Array.isArray(r.json.notices));
  assert.equal(r.json.health, null);
});

test('GET /api/family/today: 未ログインは 401、日付の形が違えば 400', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const router = createRouter!(ctx);
  const r1 = await call(router, mockReq({ path: '/api/family/today' }));
  assert.equal(r1.status, 401);
  const r2 = await call(router, mockReq({ path: '/api/family/today', query: { date: '9/1' }, headers: { cookie: familyCookie() } }));
  assert.equal(r2.status, 400);
});

test('POST /api/family/kill-switch: 世帯を更新し台帳に残す', { skip: skipReason }, async () => {
  const { ctx, data } = createCtx();
  const r = await call(createRouter!(ctx), mockReq({
    method: 'POST', path: '/api/family/kill-switch',
    headers: { cookie: familyCookie(), 'content-type': 'application/json' }, body: { on: true },
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, killSwitch: true });
  assert.equal(data.household.killSwitch, true);
  const e = data.ledger[0] as { name: string; actor: string; kind: string };
  assert.equal(e.name, 'kill_switch_on');
  assert.equal(e.actor, 'member:family');
});

test('PUT /api/family/settings: 検証して保存。LINE の登録は残る', { skip: skipReason }, async () => {
  const { ctx, data } = createCtx();
  const router = createRouter!(ctx);
  const headers = { cookie: familyCookie(), 'content-type': 'application/json' };
  const bad = await call(router, mockReq({ method: 'PUT', path: '/api/family/settings', headers, body: { plan: { weekday: { default: [{ time: '8:00', task: 'nap' }], dayservice: [] }, dayserviceDays: [] } } }));
  assert.equal(bad.status, 400);
  const good = await call(router, mockReq({
    method: 'PUT', path: '/api/family/settings', headers,
    body: {
      person: { callName: 'かあさん' },
      members: [
        { id: 'mem_1', name: '長男', order: 2, email: 'a@example.com', waitMinutes: 15, line: { userId: 'U_hack' } },
        { id: 'mem_2', name: '次男', order: 1, email: '', waitMinutes: 5 },
      ],
    },
  }));
  assert.equal(good.status, 200, good.text);
  assert.deepEqual(good.json.changed.sort(), ['members', 'person']);
  assert.equal(data.household.person.callName, 'かあさん');
  assert.deepEqual(data.household.person.wording, { diaper: 'おむつ' });
  const m1 = data.household.members.find(m => m.id === 'mem_1')!;
  assert.deepEqual(m1.line, { userId: 'U_secret' });
  assert.equal(data.household.members[0].id, 'mem_2');
  assert.equal((data.ledger[0] as { name: string }).name, 'settings_change');
});

test('GET /api/family/capabilities: 4 段階の一覧', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const r = await call(createRouter!(ctx), mockReq({ path: '/api/family/capabilities', headers: { cookie: familyCookie() } }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.levels.map((l: { key: string }) => l.key), ['auto', 'auto_with_evidence', 'after_approval', 'never']);
});

test('POST /api/family/login: 合言葉で Cookie が出る', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const router = createRouter!(ctx);
  const okRes = await call(router, mockReq({ method: 'POST', path: '/api/family/login', headers: { 'content-type': 'application/json' }, body: { passphrase: 'test-passphrase' } }));
  assert.equal(okRes.status, 200);
  assert.match(okRes.headers['set-cookie'], /^mimamori_session=/);
  const ng = await call(router, mockReq({ method: 'POST', path: '/api/family/login', headers: { 'content-type': 'application/json' }, body: { passphrase: 'x' } }));
  assert.equal(ng.status, 401);
});

test('POST /internal/prompt: 認証なしは 401', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const r = await call(createRouter!(ctx), mockReq({ method: 'POST', path: '/internal/prompt', body: { task: 'water' } }));
  assert.equal(r.status, 401);
});

function lineReq(payload: unknown, secret = 'line-secret-abc'): Request {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const req = mockReq({ method: 'POST', path: '/webhook/line', headers: { 'x-line-signature': sig, 'content-type': 'application/json' }, body: payload });
  (req as unknown as { rawBody: Buffer }).rawBody = raw;
  return req;
}

test('POST /webhook/line: 友だち追加で LINE 未登録の家族（順番の若い人）に userId を登録', { skip: skipReason }, async () => {
  const { ctx, data } = createCtx();
  const r = await call(createRouter!(ctx), lineReq({ events: [{ type: 'follow', source: { type: 'user', userId: 'U_new' } }] }));
  assert.equal(r.status, 200);
  assert.equal(r.json.handled, 1);
  const m2 = data.household.members.find(m => m.id === 'mem_2') as { line?: { userId: string } };
  assert.deepEqual(m2.line, { userId: 'U_new' });
  const m1 = data.household.members.find(m => m.id === 'mem_1') as { line?: { userId: string } };
  assert.deepEqual(m1.line, { userId: 'U_secret' });
  assert.equal((data.ledger[0] as { name: string }).name, 'line_follow');
});

test('POST /webhook/line: 「確認した」postback は送った人の memberId で ack', { skip: skipReason }, async () => {
  const { ctx, notifyCalls } = createCtx();
  const r = await call(createRouter!(ctx), lineReq({ events: [{ type: 'postback', source: { userId: 'U_secret' }, postback: { data: 'ack:nt_1' } }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(notifyCalls[0], { name: 'ack', args: ['hh_test', 'nt_1', 'mem_1', NOW] });
});

test('POST /webhook/line: 「誤報だった」postback（false:）は falseAlarm 付きで ack', { skip: skipReason }, async () => {
  const { ctx, notifyCalls } = createCtx();
  const r = await call(createRouter!(ctx), lineReq({ events: [{ type: 'postback', source: { userId: 'U_secret' }, postback: { data: 'false:nt_1' } }] }));
  assert.equal(r.status, 200);
  assert.equal(r.json.handled, 1);
  assert.deepEqual(notifyCalls[0], { name: 'ack', args: ['hh_test', 'nt_1', 'mem_1', NOW, { falseAlarm: true }] });
});

test('POST /api/family/notices/:nt/ack: body の falseAlarm を渡す。真偽値以外は 400', { skip: skipReason }, async () => {
  const { ctx, notifyCalls } = createCtx();
  const router = createRouter!(ctx);
  const headers = { cookie: familyCookie(), 'content-type': 'application/json' };
  const r = await call(router, mockReq({ method: 'POST', path: '/api/family/notices/nt_1/ack', headers, body: { falseAlarm: true } }));
  assert.equal(r.status, 200);
  assert.deepEqual(notifyCalls[0].args.slice(0, 3), ['hh_test', 'nt_1', 'family']);
  assert.deepEqual(notifyCalls[0].args[4], { falseAlarm: true });
  const plain = await call(router, mockReq({ method: 'POST', path: '/api/family/notices/nt_1/ack', headers, body: {} }));
  assert.equal(plain.status, 200);
  assert.equal(notifyCalls[1].args.length, 4);
  const bad = await call(router, mockReq({ method: 'POST', path: '/api/family/notices/nt_1/ack', headers, body: { falseAlarm: 'yes' } }));
  assert.equal(bad.status, 400);
});

test('POST /webhook/line: 署名が違えば 401 で何もしない', { skip: skipReason }, async () => {
  const { ctx, notifyCalls } = createCtx();
  const r = await call(createRouter!(ctx), lineReq({ events: [{ type: 'postback', source: { userId: 'U_secret' }, postback: { data: 'ack:nt_1' } }] }, 'wrong-secret'));
  assert.equal(r.status, 401);
  assert.equal(notifyCalls.length, 0);
});

test('POST /internal/escalate: X-Internal-Token で通り、無い通知は 404', { skip: skipReason }, async () => {
  const { ctx } = createCtx();
  const router = createRouter!(ctx);
  const headers = { 'X-Internal-Token': 'internal-token-xyz', 'content-type': 'application/json' };
  const r = await call(router, mockReq({ method: 'POST', path: '/internal/escalate', headers, body: { noticeId: 'nt_1' } }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, hh: 'hh_test', notice: { id: 'nt_1', state: 'waiting', steps: 2 } });
  const r404 = await call(router, mockReq({ method: 'POST', path: '/internal/escalate', headers, body: { noticeId: 'nt_x' } }));
  assert.equal(r404.status, 404);
  const r400 = await call(router, mockReq({ method: 'POST', path: '/internal/escalate', headers, body: {} }));
  assert.equal(r400.status, 400);
});

// ---- 端から端まで（本物の MemoryStore と state/、送信などは state/fakes.ts） ----
test('端から端まで: 計画 → 承認 → 声かけ → 返事 → 今日の様子 → 設定の往復 → 再生', { skip: skipReason }, async () => {
  const { MemoryStore } = await import('../src/store/index.js');
  const { createFakeContext } = await import('../src/state/fakes.js');
  const { defaultHousehold } = await import('../src/seed/household.js');
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold('hh_test'));
  let now = new Date('2026-09-29T06:00:00+09:00'); // 火曜（デイの日）
  const { ctx } = createFakeContext({ store, clock: () => now });
  const router = createRouter!(ctx);
  const internal = { 'X-Internal-Token': 'internal-token-xyz', 'content-type': 'application/json' };
  const fam = { cookie: familyCookie(), 'content-type': 'application/json' };
  const dev = { 'X-Device-Token': 'device-token-1', 'content-type': 'application/json' };

  const plan = await call(router, mockReq({ method: 'POST', path: '/internal/plan', headers: internal, body: {} }));
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.date, '2026-09-29');
  assert.equal(plan.json.isDayservice, true);
  assert.ok(plan.json.prompts.length > 0);

  const getPlan = await call(router, mockReq({ path: '/api/family/plan', headers: fam }));
  assert.equal(getPlan.status, 200);
  assert.equal(getPlan.json.planApproved, null);
  const approve = await call(router, mockReq({ method: 'POST', path: '/api/family/plan/approve', headers: fam, body: { date: '2026-09-29' } }));
  assert.equal(approve.status, 200, approve.text);
  assert.equal(approve.json.planApproved.by, 'family');

  now = new Date('2026-09-29T08:00:30+09:00');
  const hb = await call(router, mockReq({ method: 'POST', path: '/api/device/heartbeat', headers: dev, body: { hh: 'hh_test', appVersion: 't' } }));
  assert.equal(hb.status, 200);
  assert.ok(hb.json.nextPrompt);

  const next = await call(router, mockReq({ path: '/api/device/next-prompt', headers: dev, query: { hh: 'hh_test' } }));
  assert.equal(next.status, 200, next.text);
  assert.equal(next.json.prompt.task, 'greeting');
  assert.ok(next.json.prompt.text);

  now = new Date('2026-09-29T08:01:00+09:00');
  const reply = await call(router, mockReq({ method: 'POST', path: '/api/device/reply', headers: dev, body: { hh: 'hh_test', promptId: next.json.prompt.id, text: 'うん、まあまあ', source: 'ipad' } }));
  assert.equal(reply.status, 200, reply.text);
  assert.match(reply.json.turnId, /^tn_/);
  assert.ok(['smile', 'listen', 'think', 'worry'].includes(reply.json.expression));
  assert.ok('followUp' in reply.json);

  const noText = await call(router, mockReq({ method: 'POST', path: '/api/device/reply', headers: dev, body: { promptId: next.json.prompt.id } }));
  assert.equal(noText.status, 400);
  const unknownPrompt = await call(router, mockReq({ method: 'POST', path: '/api/device/reply', headers: dev, body: { promptId: 'pr_nope', noAnswer: true } }));
  assert.equal(unknownPrompt.status, 404, unknownPrompt.text);

  const today = await call(router, mockReq({ path: '/api/family/today', headers: fam }));
  assert.equal(today.status, 200);
  assert.equal(today.json.turns.length, 1);
  assert.equal(today.json.turns[0].id, reply.json.turnId);
  assert.ok(today.json.health?.lastHeartbeatAt, '生存信号が記録されている');

  const turn = await call(router, mockReq({ path: `/api/family/turn/${reply.json.turnId}`, headers: fam }));
  assert.equal(turn.status, 200);
  assert.equal(turn.json.turn.replyText, 'うん、まあまあ');

  // 設定: GET の形をそのまま PUT に戻せる（recheckMinutes: 0 を含む）
  const settings = await call(router, mockReq({ path: '/api/family/settings', headers: fam }));
  const { name, person, plan: p2, policy, members } = settings.json;
  const put = await call(router, mockReq({ method: 'PUT', path: '/api/family/settings', headers: fam, body: { name, person, plan: p2, policy, members } }));
  assert.equal(put.status, 200, put.text);

  const ledger = await call(router, mockReq({ path: '/api/family/ledger', headers: fam }));
  const names = ledger.json.entries.map((e: { name: string }) => e.name);
  assert.ok(names.includes('settings_change'));

  const scen = await call(router, mockReq({ path: '/api/family/replay/scenarios', headers: fam }));
  assert.ok(scen.json.names.includes('dayservice-day'));
  const turnsBefore = (await store.listTurns('hh_test', '2026-09-29')).length;
  const ledgerBefore = (await store.listLedger('hh_test', '2026-09-29')).length;
  const replay = await call(router, mockReq({ method: 'POST', path: '/api/family/replay', headers: fam, body: { name: 'dayservice-day' } }));
  assert.equal(replay.status, 200, replay.text);
  assert.ok(replay.json.steps.length > 0);
  assert.equal(typeof replay.json.passCount, 'number');
  // 再生は本番の store に何も書かない
  assert.equal((await store.listTurns('hh_test', '2026-09-29')).length, turnsBefore);
  assert.equal((await store.listLedger('hh_test', '2026-09-29')).length, ledgerBefore);

  const badName = await call(router, mockReq({ method: 'POST', path: '/api/family/replay', headers: fam, body: { name: '../secret' } }));
  assert.equal(badName.status, 400);
});
