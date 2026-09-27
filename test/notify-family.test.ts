import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNoticeMessage, createFamilyNotify, quietHoursEnd } from '../src/notify/index.js';
import type { NotifyRequest } from '../src/services.js';
import { FakeNotifier, FakeStore, FakeTasks, household, jst, member } from './notify-fakes.js';

const HH = 'hh_test';
const DATE = '2026-09-27';

function setup(members = [member('m1', 1), member('m2', 2)]) {
  const store = new FakeStore();
  store.households.set(HH, household(members, HH));
  const notifier = new FakeNotifier();
  const tasks = new FakeTasks();
  const fn = createFamilyNotify({ store: store.asStore(), notifier, tasks, clock: () => jst(DATE, '12:00') });
  return { store, notifier, tasks, fn };
}

function req(p: Partial<NotifyRequest> = {}): NotifyRequest {
  return {
    hh: HH, date: DATE, level: 'check', reason: '着替えが確認できません', evidence: 'まだ',
    turnId: 'tn_1', task: 'dress', now: jst(DATE, '09:00'), ...p,
  };
}

test('urgent は静かな時間帯でも即送信し、waitMinutes 後の escalate を予約する', async () => {
  const { store, notifier, tasks, fn } = setup();
  const now = jst(DATE, '23:00');
  const n = await fn.notify(req({ level: 'urgent', reason: '転んだと話しています', evidence: '転んじゃった', task: undefined, now }));

  assert.equal(n.state, 'waiting');
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].memberId, 'm1');
  assert.equal(notifier.sent[0].channel, 'line');
  assert.match(notifier.sent[0].msg.title, /^🔴 緊急：転んだ/);
  assert.equal(notifier.sent[0].msg.noticeId, n.id);
  assert.equal(tasks.scheduled.length, 1);
  assert.equal(tasks.scheduled[0].path, '/internal/escalate');
  assert.deepEqual(tasks.scheduled[0].body, { hh: HH, noticeId: n.id });
  assert.equal(tasks.scheduled[0].runAt.getTime(), now.getTime() + 10 * 60_000);

  const saved = store.notices.get(n.id)!;
  assert.equal(saved.state, 'waiting');
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].ackedAt, null);
  const sent = store.ledger.find(e => e.name === 'notice_sent')!;
  assert.equal(sent.actor, 'agent');
  assert.equal(sent.kind, 'notice');
  assert.equal(sent.noticeId, n.id);
  assert.equal(sent.turnId, 'tn_1');
  assert.deepEqual(sent.args, { level: 'urgent', reason: '転んだと話しています', memberId: 'm1', channel: 'line', order: 1 });
});

test('check は静かな時間帯なら deferred にして翌朝まで送らない', async () => {
  const { store, notifier, tasks, fn } = setup();
  const n = await fn.notify(req({ now: jst(DATE, '22:00') }));
  assert.equal(n.state, 'deferred');
  assert.equal(n.deferredUntil?.getTime(), jst('2026-09-28', '07:30').getTime());
  assert.equal(notifier.sent.length, 0);
  assert.equal(tasks.scheduled.length, 0);
  assert.equal(store.notices.get(n.id)!.state, 'deferred');

  // 日付をまたいだ深夜も同じ朝
  assert.equal(quietHoursEnd(jst('2026-09-28', '01:00'), { from: '21:30', to: '07:30' }).getTime(), jst('2026-09-28', '07:30').getTime());
});

test('同じ日・同じ項目・同じ level の open/waiting があれば新しく作らない', async () => {
  const { store, notifier, fn } = setup();
  const a = await fn.notify(req());
  const b = await fn.notify(req({ evidence: '別の返事', now: jst(DATE, '09:20') }));
  assert.equal(b.id, a.id);
  assert.equal(store.notices.size, 1);
  assert.equal(notifier.sent.length, 1);

  // level が違えば別の通知
  const c = await fn.notify(req({ level: 'urgent' }));
  assert.notEqual(c.id, a.id);
  assert.equal(store.notices.size, 2);
});

test('ack で acked になり、台帳に notice_acked（actor member:）', async () => {
  const { store, fn } = setup();
  const n = await fn.notify(req());
  const acked = await fn.ack(HH, n.id, 'm1', jst(DATE, '09:05'));
  assert.equal(acked?.state, 'acked');
  assert.equal(acked?.ackedBy, 'm1');
  const saved = store.notices.get(n.id)!;
  assert.equal(saved.state, 'acked');
  assert.equal(saved.steps[0].ackedAt?.getTime(), jst(DATE, '09:05').getTime());
  const e = store.ledger.find(x => x.name === 'notice_acked')!;
  assert.equal(e.actor, 'member:m1');

  // acked の後の escalate は何もしない
  const after = await fn.escalate(HH, n.id, jst(DATE, '09:10'));
  assert.equal(after?.state, 'acked');
  assert.equal(store.notices.get(n.id)!.steps.length, 1);
  assert.equal(await fn.ack(HH, 'nt_none', 'm1', jst(DATE, '09:05')), null);
});

test('escalate で 2 人目へ、次が居なければ全員に再送して escalated', async () => {
  const { store, notifier, tasks, fn } = setup();
  const n = await fn.notify(req());
  assert.equal(notifier.sent.at(-1)?.memberId, 'm1');

  const e1 = await fn.escalate(HH, n.id, jst(DATE, '09:10'));
  assert.equal(e1?.state, 'waiting');
  assert.equal(notifier.sent.at(-1)?.memberId, 'm2');
  assert.equal(tasks.scheduled.length, 2);

  const e2 = await fn.escalate(HH, n.id, jst(DATE, '09:20'));
  assert.equal(e2?.state, 'escalated');
  const resend = notifier.sent.slice(2);
  assert.deepEqual(resend.map(s => s.memberId), ['m1', 'm2']);
  assert.ok(resend.every(s => s.channel === 'email'));
  assert.ok(resend.every(s => s.msg.title.startsWith('【再送】')));
  assert.equal(tasks.scheduled.length, 2, 'escalated の後は予約しない');
  assert.ok(store.ledgerNames().includes('notice_escalated'));
  assert.equal(store.notices.get(n.id)!.steps.length, 4);

  // escalated の後にもう一度呼ばれても何もしない
  await fn.escalate(HH, n.id, jst(DATE, '09:30'));
  assert.equal(notifier.sent.length, 4);
});

test('members が空でも例外にならず open のまま、台帳に no_members', async () => {
  const { store, notifier, tasks, fn } = setup([]);
  const n = await fn.notify(req({ level: 'urgent' }));
  assert.equal(n.state, 'open');
  assert.equal(notifier.sent.length, 0);
  assert.equal(tasks.scheduled.length, 0);
  const e = store.ledger.find(x => x.name === 'notice_sent')!;
  assert.deepEqual(e.result, { delivered: false, reason: 'no_members' });
});

test('flushDeferred が静かな時間帯明けに deferred を送る', async () => {
  const { store, notifier, fn } = setup();
  const a = await fn.notify(req({ now: jst(DATE, '22:00') }));
  const b = await fn.notify(req({ level: 'info', task: 'medicine', reason: '薬の返事があいまい', now: jst(DATE, '22:10') }));
  assert.equal(notifier.sent.length, 0);

  assert.equal(await fn.flushDeferred(HH, jst('2026-09-28', '07:00')), 0, 'まだ朝になっていない');
  assert.equal(await fn.flushDeferred(HH, jst('2026-09-28', '07:30')), 2);
  assert.equal(notifier.sent.length, 2);
  assert.equal(store.notices.get(a.id)!.state, 'waiting');
  assert.equal(store.notices.get(b.id)!.state, 'waiting');
  assert.equal(await fn.flushDeferred(HH, jst('2026-09-28', '08:00')), 0, '二度は送らない');
});

test('届かない人は飛ばして次の人へ。失敗は step の error と notify_error incident に残る', async () => {
  const { store, notifier, tasks, fn } = setup();
  notifier.failFor.add('m1');
  const n = await fn.notify(req({ level: 'urgent', now: jst(DATE, '10:00') }));
  const saved = store.notices.get(n.id)!;
  assert.equal(saved.state, 'waiting');
  assert.equal(saved.steps.length, 2);
  assert.match(saved.steps[0].error ?? '', /line:http_500/);
  assert.equal(saved.steps[1].memberId, 'm2');
  assert.equal(saved.steps[1].error, undefined);
  assert.equal(tasks.scheduled.length, 1);
  const health = store.health.get(`${HH}/${DATE}`)!;
  assert.equal(health.incidents.length, 1);
  assert.equal(health.incidents[0].kind, 'notify_error');
  assert.equal(health.incidents[0].action, 'retry');
  assert.ok(store.ledgerNames().includes('health_incident'));
});

test('文面: 印＋reason、evidence は 80 文字まで、家族画面へ誘導', () => {
  const long = 'あ'.repeat(200);
  const msg = buildNoticeMessage({
    id: 'nt_x', hh: HH, date: DATE, level: 'info', reason: '端末が応答していません', evidence: long,
    turnId: null, steps: [], state: 'open', createdAt: new Date(),
  });
  assert.equal(msg.title, '🟢 お知らせ：端末が応答していません');
  assert.ok(!msg.body.includes(long));
  assert.ok(Array.from(msg.body.split('\n')[0]).length <= 80);
  assert.match(msg.body, /家族画面で確認/);
  assert.equal(msg.noticeId, 'nt_x');
});
