import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCloudScheduler, createInlineScheduler, type CloudTasksLike } from '../src/tasks/index.js';

test('inline: schedule が予約を返し、runAt に自分の path へ X-Internal-Token 付きで POST する', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let resolveCalled!: () => void;
  const called = new Promise<void>(r => { resolveCalled = r; });
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    resolveCalled();
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  const s = createInlineScheduler({ port: 18080, internalToken: 'test-token', fetchImpl: fakeFetch });
  const runAt = new Date();
  const task = await s.schedule('/internal/escalate', { hh: 'hh_test', noticeId: 'nt_1' }, runAt);

  assert.match(task.id, /^inline_\d+$/);
  assert.equal(task.path, '/internal/escalate');
  assert.equal(task.runAt, runAt);
  assert.equal(s.listPending().length, 1);
  assert.deepEqual(s.listPending()[0].body, { hh: 'hh_test', noticeId: 'nt_1' });

  // タイマーは unref されているので、テストの間だけプロセスを生かしておく
  const guard = setTimeout(() => {}, 2000);
  await called;
  clearTimeout(guard);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:18080/internal/escalate');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Internal-Token'], 'test-token');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { hh: 'hh_test', noticeId: 'nt_1' });
  assert.equal(s.listPending().length, 0);
});

test('inline: 未来の予約は clear で取り消せる', async () => {
  let called = 0;
  const fakeFetch = (async () => { called++; return new Response('', { status: 200 }); }) as typeof fetch;
  const s = createInlineScheduler({ port: 18080, internalToken: 't', fetchImpl: fakeFetch });
  const a = await s.schedule('/internal/recheck', { n: 1 }, new Date(Date.now() + 60_000));
  const b = await s.schedule('/internal/recheck', { n: 2 }, new Date(Date.now() + 60_000));
  assert.notEqual(a.id, b.id);
  assert.equal(s.listPending().length, 2);
  s.clear();
  assert.equal(s.listPending().length, 0);
  assert.equal(called, 0);
});

function fakeCloudClient() {
  const requests: Array<Record<string, unknown>> = [];
  const client: CloudTasksLike = {
    queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
    async createTask(req) {
      requests.push(req);
      return [{ name: `projects/p/locations/l/queues/q/tasks/t${requests.length}` }];
    },
  };
  return { client, requests };
}

test('cloud: サービスアカウントがあれば OIDC、無ければ X-Internal-Token', async () => {
  const runAt = new Date('2026-09-27T01:00:00.250Z');

  const oidc = fakeCloudClient();
  const s1 = createCloudScheduler({
    client: oidc.client, projectId: 'proj', region: 'asia-northeast1', queue: 'mimamori',
    serviceUrl: 'https://svc.example.run.app/', serviceAccountEmail: 'tasks@proj.iam.gserviceaccount.com', internalToken: '',
  });
  const t1 = await s1.schedule('/internal/recheck', { hh: 'hh_test' }, runAt);
  assert.equal(t1.id, 'projects/p/locations/l/queues/q/tasks/t1');
  const r1 = oidc.requests[0] as { parent: string; task: { httpRequest: Record<string, unknown>; scheduleTime: { seconds: number; nanos: number } } };
  assert.equal(r1.parent, 'projects/proj/locations/asia-northeast1/queues/mimamori');
  assert.equal(r1.task.httpRequest.url, 'https://svc.example.run.app/internal/recheck');
  assert.deepEqual(r1.task.httpRequest.oidcToken, { serviceAccountEmail: 'tasks@proj.iam.gserviceaccount.com', audience: 'https://svc.example.run.app' });
  assert.equal((r1.task.httpRequest.headers as Record<string, string>)['X-Internal-Token'], undefined);
  assert.deepEqual(JSON.parse(Buffer.from(String(r1.task.httpRequest.body), 'base64').toString()), { hh: 'hh_test' });
  assert.equal(r1.task.scheduleTime.seconds, Math.floor(runAt.getTime() / 1000));
  assert.equal(r1.task.scheduleTime.nanos, 250_000_000);

  const tok = fakeCloudClient();
  const s2 = createCloudScheduler({
    client: tok.client, serviceUrl: 'https://svc.example.run.app', serviceAccountEmail: '', internalToken: 'secret',
  });
  await s2.schedule('/internal/escalate', {}, runAt);
  const r2 = tok.requests[0] as { task: { httpRequest: Record<string, unknown> } };
  assert.equal(r2.task.httpRequest.oidcToken, undefined);
  assert.equal((r2.task.httpRequest.headers as Record<string, string>)['X-Internal-Token'], 'secret');
});

test('cloud: SERVICE_URL や認証が無ければ schedule 時に Error', async () => {
  const { client } = fakeCloudClient();
  await assert.rejects(
    createCloudScheduler({ client, serviceUrl: '', serviceAccountEmail: 'sa@x', internalToken: 't' }).schedule('/internal/plan', {}, new Date()),
    /SERVICE_URL/,
  );
  await assert.rejects(
    createCloudScheduler({ client, serviceUrl: 'https://x', serviceAccountEmail: '', internalToken: '' }).schedule('/internal/plan', {}, new Date()),
    /TASKS_SERVICE_ACCOUNT/,
  );
});
