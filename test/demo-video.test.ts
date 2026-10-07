// デモ動画の録画（scripts/video/）のために src に足した 2 つの小さな仕組みのテスト。
//  - STORE=memory の createStore は、既定の世帯とデモ世帯を最初から入れておく
//  - POST /internal/replay-into-store は DEMO_MODE=true のときだけ登録され、渡した ctx の Store に台本を流す（本番では 404）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

process.env.INTERNAL_TOKEN = 'internal-token-demo';

const { Router, HttpError } = await import('../src/api/router.js');
const { registerInternalRoutes } = await import('../src/api/internal.js');
const { createFakeContext } = await import('../src/state/fakes.js');
const { createStore } = await import('../src/store/index.js');
const { demoHousehold } = await import('../src/seed/household.js');

function mockReq(init: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
  return { method: init.method ?? 'GET', path: init.path, protocol: 'http', headers, body: init.body ?? {}, query: {} } as unknown as Request;
}

async function call(router: InstanceType<typeof Router>, req: Request) {
  const res: Record<string, unknown> & { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.set = () => res;
  res.send = (b: unknown) => { res.body = b; return res; };
  try {
    const matched = await router.dispatch(req, res as unknown as Response);
    if (!matched) { res.statusCode = 404; res.body = JSON.stringify({ ok: false, error: 'no route' }); }
  } catch (e) {
    if (e instanceof HttpError) { res.statusCode = e.status; res.body = JSON.stringify({ ok: false, error: e.message }); } else throw e;
  }
  return { status: res.statusCode, json: JSON.parse(String(res.body)) };
}

function routerWith(demoMode: string | undefined) {
  const prev = process.env.DEMO_MODE;
  if (demoMode === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demoMode;
  try {
    const { ctx, store } = createFakeContext();
    const router = new Router();
    registerInternalRoutes(router, ctx);
    return { router, store };
  } finally {
    if (prev === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prev;
  }
}

const TOKEN = { 'X-Internal-Token': 'internal-token-demo', 'Content-Type': 'application/json' };
const SCENARIO = {
  name: 'テスト', date: '2026-09-29', isDayservice: true,
  turns: [{ at: '08:00', task: 'greeting', reply: 'うん、まあまあ', expect: { status: 'done' } }],
};

test('STORE=memory の createStore は既定の世帯とデモ世帯を入れておく', async () => {
  const prev = process.env.STORE;
  process.env.STORE = 'memory';
  try {
    const store = createStore();
    const demo = await store.getHousehold('hh_demo');
    assert.equal(demo?.name, demoHousehold().name);
    const all = await store.listHouseholds();
    assert.equal(all.length, 2);
  } finally {
    if (prev === undefined) delete process.env.STORE; else process.env.STORE = prev;
  }
});

test('DEMO_MODE が無ければ /internal/replay-into-store は無い（404）', async () => {
  const { router } = routerWith(undefined);
  const r = await call(router, mockReq({ method: 'POST', path: '/internal/replay-into-store', headers: TOKEN, body: { name: 'weekday' } }));
  assert.equal(r.status, 404);
  const r2 = await call(routerWith('false').router, mockReq({ method: 'POST', path: '/internal/replay-into-store', headers: TOKEN, body: { name: 'weekday' } }));
  assert.equal(r2.status, 404);
});

test('DEMO_MODE=true なら台本を ctx の Store に流す（日付の差し替えつき）', async () => {
  const { router, store } = routerWith('true');
  const r = await call(router, mockReq({
    method: 'POST', path: '/internal/replay-into-store', headers: TOKEN,
    body: { hh: 'hh_demo', scenario: SCENARIO, date: '2026-09-30', withSummary: false },
  }));
  assert.equal(r.status, 200);
  assert.equal(r.json.date, '2026-09-30');
  assert.equal(r.json.passCount, 1);
  assert.equal(r.json.summary, undefined);
  const turns = await store.listTurns('hh_demo', '2026-09-30');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].replyText, 'うん、まあまあ');
});

test('/internal/replay-into-store も内部の認証が要り、日付の形を確かめる', async () => {
  const { router } = routerWith('true');
  const noAuth = await call(router, mockReq({ method: 'POST', path: '/internal/replay-into-store', body: { scenario: SCENARIO } }));
  assert.equal(noAuth.status, 401);
  const badDate = await call(router, mockReq({ method: 'POST', path: '/internal/replay-into-store', headers: TOKEN, body: { scenario: SCENARIO, date: '9/30' } }));
  assert.equal(badDate.status, 400);
});
