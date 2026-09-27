import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFamilyNotify } from '../src/notify/index.js';
import { currentDegraded, healthReportLine, recordIncident, runHealthCheck } from '../src/ops/health.js';
import type { AppContext } from '../src/services.js';
import { FakeNotifier, FakeStore, FakeTasks, household, jst, member } from './notify-fakes.js';

const HH = 'hh_test';
const DATE = '2026-09-27';

function setup() {
  const store = new FakeStore();
  store.households.set(HH, household([member('m1', 1)], HH));
  const notifier = new FakeNotifier();
  const tasks = new FakeTasks();
  const clock = () => jst(DATE, '12:00');
  const familyNotify = createFamilyNotify({ store: store.asStore(), notifier, tasks, clock });
  const ctx = {
    store: store.asStore(), clock, notifier, familyNotify, tasks,
    turnRunner: { run: async () => { throw new Error('not used'); } },
    tts: { synthesize: async () => ({}) },
  } as AppContext;
  return { store, notifier, tasks, ctx };
}

test('生存信号が 10 分以上ないと 1 日 1 回だけ家族へ通知し、戻ったら health_recovered', async () => {
  const { store, notifier, ctx } = setup();
  store.health.set(`${HH}/${DATE}`, { hh: HH, date: DATE, lastHeartbeatAt: jst(DATE, '11:45'), incidents: [] });

  // 5 分前なら何もしない
  const ok = await runHealthCheck(ctx, HH, jst(DATE, '11:50'));
  assert.equal(ok.heartbeatLost, false);
  assert.equal(ok.actions.length, 0);
  assert.equal(notifier.ops.length, 0, '処置が無ければ Slack に送らない');

  const r1 = await runHealthCheck(ctx, HH, jst(DATE, '12:00'));
  assert.equal(r1.heartbeatLost, true);
  assert.equal(r1.heartbeatAgeMin, 15);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].msg.title, /端末が応答していません/);
  assert.match(notifier.sent[0].msg.body, /最後の生存信号 11:45/);
  assert.ok(store.ledgerNames().includes('heartbeat_lost'));
  assert.ok(store.health.get(`${HH}/${DATE}`)!.heartbeatLostNotifiedAt);

  const r2 = await runHealthCheck(ctx, HH, jst(DATE, '12:05'));
  assert.equal(r2.heartbeatLost, true);
  assert.equal(notifier.sent.length, 1, '同じ日に二度は知らせない');
  assert.equal(store.ledgerNames().filter(n => n === 'heartbeat_lost').length, 1);

  // 端末が戻る
  const h = store.health.get(`${HH}/${DATE}`)!;
  store.health.set(`${HH}/${DATE}`, { ...h, lastHeartbeatAt: jst(DATE, '12:09') });
  const r3 = await runHealthCheck(ctx, HH, jst(DATE, '12:10'));
  assert.equal(r3.heartbeatLost, false);
  assert.equal(r3.recovered, true);
  assert.ok(store.ledgerNames().includes('health_recovered'));
  assert.equal(store.health.get(`${HH}/${DATE}`)!.heartbeatLostSince, null);

  const r4 = await runHealthCheck(ctx, HH, jst(DATE, '12:15'));
  assert.equal(r4.recovered, false, '復旧は一度だけ');
  assert.equal(store.ledgerNames().filter(n => n === 'health_recovered').length, 1);
});

test('直近 5 分に TTS の失敗が 3 件あると degraded を書き、Slack に 1 行だけ報告する', async () => {
  const { store, notifier, ctx } = setup();
  store.health.set(`${HH}/${DATE}`, { hh: HH, date: DATE, lastHeartbeatAt: jst(DATE, '11:59'), incidents: [] });
  await recordIncident(store.asStore(), HH, 'tts_timeout', 'fallback', undefined, jst(DATE, '11:40')); // 窓の外
  await recordIncident(store.asStore(), HH, 'tts_timeout', 'fallback', undefined, jst(DATE, '11:56'));
  await recordIncident(store.asStore(), HH, 'tts_timeout', 'fallback', undefined, jst(DATE, '11:58'));
  await recordIncident(store.asStore(), HH, 'tts_error', 'fallback', undefined, jst(DATE, '11:59'));
  await recordIncident(store.asStore(), HH, 'llm_error', 'retry', undefined, jst(DATE, '11:59'));

  const now = jst(DATE, '12:00');
  const r = await runHealthCheck(ctx, HH, now);
  assert.equal(r.recentIncidents.tts_timeout, 2);
  assert.equal(r.recentIncidents.tts_error, 1);
  assert.equal(r.recentIncidents.llm_error, 1);
  assert.equal(r.degraded?.tts, 'device');
  assert.equal(r.degraded?.llm, undefined, 'LLM は 1 件なので再試行のまま');

  const h = store.health.get(`${HH}/${DATE}`)!;
  assert.equal(h.degraded?.tts, 'device');
  assert.equal(h.degraded?.until.getTime(), now.getTime() + 30 * 60_000);
  assert.equal(h.lastCheckAt?.getTime(), now.getTime());
  assert.equal(h.lastHeartbeatAt?.getTime(), jst(DATE, '11:59').getTime(), '生存信号を消さない');
  assert.equal(h.incidents.length, 5, 'incidents を消さない');
  assert.equal(currentDegraded(h, jst(DATE, '12:20'))?.tts, 'device');
  assert.equal(currentDegraded(h, jst(DATE, '12:31')), null);

  assert.equal(notifier.ops.length, 1);
  assert.ok(!notifier.ops[0].includes('\n'), 'Slack は 1 行');
  assert.match(notifier.ops[0], /端末の読み上げに切替/);
  assert.match(notifier.ops[0], /TTS失敗3/);
  assert.equal(notifier.sent.length, 0, '家族には送らない');

  // 期限が切れたら解除して health_recovered
  const later = await runHealthCheck(ctx, HH, jst(DATE, '12:40'));
  assert.equal(later.degraded, null);
  assert.equal(later.recovered, true);
  assert.equal(store.health.get(`${HH}/${DATE}`)!.degraded, null);
  assert.ok(store.ledgerNames().includes('health_recovered'));
});

test('recordIncident は health に追記し台帳に health_incident（actor ops）', async () => {
  const { store } = setup();
  await recordIncident(store.asStore(), HH, 'notify_error', 'retry', 'line:http_500', jst(DATE, '10:00'));
  const h = store.health.get(`${HH}/${DATE}`)!;
  assert.equal(h.incidents.length, 1);
  assert.equal(h.incidents[0].resolvedAt, null);
  const e = store.ledger.find(x => x.name === 'health_incident')!;
  assert.equal(e.actor, 'ops');
  assert.equal(e.kind, 'health');
});

test('healthReportLine は件数と処置だけの 1 行', () => {
  const line = healthReportLine({
    hh: HH, date: DATE, checkedAt: jst(DATE, '12:00'), heartbeatAgeMin: 3, heartbeatLost: false,
    recentIncidents: { tts_timeout: 1, tts_error: 0, llm_error: 0, device_silent: 0, notify_error: 0 },
    actions: ['音声合成の失敗 1 件/5分（再試行で継続）'], recovered: false, degraded: null,
  });
  assert.equal(line, '[見守り運用] hh_test 2026-09-27 12:00｜端末: OK（3分前）｜直近5分: TTS失敗1・AI失敗0・通知失敗0｜処置: 音声合成の失敗 1 件/5分（再試行で継続）');
});
