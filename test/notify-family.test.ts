import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNoticeMessage, createFamilyNotify, quietHoursEnd } from '../src/notify/index.js';
import type { NotifyRequest } from '../src/services.js';
import type { Notice } from '../src/types.js';
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
  assert.equal(notifier.sent[0].msg.title, '【至急】23:00');
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

const baseNotice = (p: Partial<Notice>): Notice => ({
  id: 'nt_x', hh: HH, date: DATE, level: 'info', reason: '', evidence: '', turnId: null, steps: [], state: 'open',
  createdAt: jst(DATE, '11:32'), ...p,
});

test('文面 L2: 【お知らせ】、evidence は 80 文字まで、末尾に返信不要', () => {
  const long = 'あ'.repeat(200);
  const msg = buildNoticeMessage(baseNotice({ reason: '端末が応答していません', evidence: long, origin: 'device' }));
  assert.equal(msg.title, '【お知らせ】端末が応答していません');
  assert.ok(!msg.body.includes(long));
  assert.ok(Array.from(msg.body.split('\n')[0]).length <= 80);
  assert.equal(msg.body.split('\n').at(-1), 'この通知への返信は不要です。');
  assert.equal(msg.noticeId, 'nt_x');
});

test('文面 L3（痛み）: 時刻・原文・分からないこと・家の電話・「確認した」・聞き直しの予定。住所や持病は載せない', () => {
  const h = { ...household([member('m1', 1)], HH), contacts: { homePhone: '03-1234-5678' } };
  const msg = buildNoticeMessage(baseNotice({
    level: 'check', origin: 'pain', reason: '腰が痛いとおっしゃいました。どの程度か、動けるかは分かりません。', evidence: 'ちょっと腰が痛いの', task: 'return',
  }), { household: h });
  assert.equal(msg.title, '【確認をお願いします】11:32');
  assert.deepEqual(msg.body.split('\n'), [
    'お母さんが「ちょっと腰が痛いの」とおっしゃいました。',
    'どの程度痛いか、動けるかは、AI からは分かりません。',
    'お早めに家の電話（03-1234-5678）にかけてみてください。',
    '話せたら「確認した」を押してください。',
    '3 時間ほど後（14:32 ごろ）に一度、様子を聞き直してお知らせします。',
  ]);
  // 判定未確定ならその旨を添える。家の電話が未設定なら番号の文を省く
  const u = buildNoticeMessage(baseNotice({ level: 'check', origin: 'pain', reason: '痛い', evidence: '痛い', uncertain: true }), { household: household([], HH) });
  assert.match(u.body, /判定は未確定です/);
  assert.match(u.body, /お早めにお電話で声を聞いてください。/);
});

test('文面 L3（返事なし）と L4（返事なし）: 119 に触れず、①家の電話 ②iPad ③近くの人', () => {
  const h = { ...household([], HH), contacts: { homePhone: '03-1234-5678', nearby: { name: '佐藤', phone: '090-0000-0000' } } };
  const l3 = buildNoticeMessage(baseNotice({
    level: 'check', origin: 'no_answer', createdAt: jst(DATE, '09:20'),
    reason: '9:00 から 2 回の声かけに返事がありません。家の電話にかけてみてください。話せたら『確認した』を押してください',
  }), { household: h });
  assert.equal(l3.title, '【確認をお願いします】9:20');
  assert.match(l3.body, /^9:00 から 2 回の声かけに返事がありません。\n/);
  assert.match(l3.body, /家の電話（03-1234-5678）にかけてみてください。/);
  assert.match(l3.body, /話せたら「確認した」を押してください。/);

  const l4 = buildNoticeMessage(baseNotice({
    level: 'urgent', origin: 'no_answer', createdAt: jst(DATE, '09:35'), reason: '9:00 から 3 回の声かけに、お返事がありません',
  }), { household: h });
  assert.equal(l4.title, '【至急】9:35');
  assert.match(l4.body, /①家の電話（03-1234-5678）/);
  assert.match(l4.body, /②iPad の通話ボタン/);
  assert.match(l4.body, /③近くの 佐藤さん（電話 090-0000-0000）/);
  assert.match(l4.body, /3 分ごとに「ご家族に連絡しました。無理に立ち上がらず、そのままお待ちください。」/);
  assert.ok(!l4.body.includes('119'));
  // 近くの人が未設定なら③を省く
  assert.ok(!buildNoticeMessage(baseNotice({ level: 'urgent', origin: 'no_answer', reason: 'x' }), { household: household([], HH) }).body.includes('③'));
});

test('文面 L4（L4 の語）: 原文・本人に伝えている定型文・電話・「必要と思われたら 119 番へ」', () => {
  const msg = buildNoticeMessage(baseNotice({
    level: 'urgent', origin: 'l4_words', createdAt: jst(DATE, '14:05'), reason: '「転んだ」とおっしゃいました', evidence: '転んだ',
  }), { household: household([], HH) });
  assert.equal(msg.title, '【至急】14:05');
  assert.match(msg.body, /14:05 の声かけに、お母さんが「転んだ」とおっしゃいました。/);
  assert.match(msg.body, /「大丈夫ですか。ご家族に連絡します。そのまま動かずにお待ちください。」と一度お伝えし/);
  assert.match(msg.body, /お電話で声を聞いてください。/);
  assert.match(msg.body, /必要と思われたら 119 番へ。/);
});

test('L2（info）は 1 日 5 件まで。6 件目は deferred / daily_cap で送らず、翌朝にも送らない。今日の様子は数えない', async () => {
  const { store, notifier, fn } = setup();
  for (let i = 0; i < 5; i++) {
    const n = await fn.notify(req({ level: 'info', task: undefined, reason: `お知らせ ${i}`, origin: 'other', now: jst(DATE, `1${i}:00`) }));
    assert.equal(n.state, 'waiting');
  }
  const capped = await fn.notify(req({ level: 'info', task: undefined, reason: 'お知らせ 6', origin: 'not_done', now: jst(DATE, '16:00') }));
  assert.equal(capped.state, 'deferred');
  assert.equal(capped.deferredReason, 'daily_cap');
  assert.equal(notifier.sent.length, 5);
  assert.ok(store.ledger.some(e => (e.result as { reason?: string } | undefined)?.reason === 'daily_cap'));
  // check / urgent と今日の様子は上限の対象外
  assert.equal((await fn.notify(req({ now: jst(DATE, '16:10') }))).state, 'waiting');
  assert.equal((await fn.notify(req({ level: 'info', task: undefined, reason: '今日の様子', origin: 'summary', evidence: '今日の様子 9月27日（日）\n…', now: jst(DATE, '18:00') }))).state, 'waiting');
  assert.equal(await fn.flushDeferred(HH, jst('2026-09-28', '08:00')), 0);
});

test('L2（info）は返信を求めないので段階上げを予約しない', async () => {
  const { tasks, fn } = setup();
  await fn.notify(req({ level: 'info', task: undefined, reason: '準備完了、デイへ出発', origin: 'departure' }));
  assert.equal(tasks.scheduled.length, 0);
});

test('ack に falseAlarm: 確認済み＋誤報の記録、台帳 notice_acked に falseAlarm、その日の signals.falseAlarmCount を数える', async () => {
  const { store, fn } = setup();
  store.days.set(`${HH}/${DATE}`, {
    hh: HH, date: DATE, isDayservice: false, plan: [], planApproved: null, tasks: {}, summary: null,
    signals: { unclearCount: 0, noAnswerCount: 0, repeatedQuestions: 0, urgentCount: 1 },
  });
  const n = await fn.notify(req({ level: 'urgent', origin: 'l4_words' }));
  const acked = await fn.ack(HH, n.id, 'm1', jst(DATE, '09:05'), { falseAlarm: true });
  assert.equal(acked?.state, 'acked');
  assert.equal(acked?.falseAlarm, true);
  assert.equal(store.notices.get(n.id)!.falseAlarm, true);
  const e = store.ledger.filter(x => x.name === 'notice_acked');
  assert.equal(e.length, 1);
  assert.equal((e[0].args as { falseAlarm: boolean }).falseAlarm, true);
  assert.equal(store.days.get(`${HH}/${DATE}`)!.signals.falseAlarmCount, 1);
  // 2 度押しても数は増えない。「確認した」の後から「誤報だった」も付けられる
  await fn.ack(HH, n.id, 'm1', jst(DATE, '09:06'), { falseAlarm: true });
  assert.equal(store.days.get(`${HH}/${DATE}`)!.signals.falseAlarmCount, 1);
  const m = await fn.notify(req({ level: 'check', origin: 'pain' }));
  await fn.ack(HH, m.id, 'm1', jst(DATE, '09:10'));
  await fn.ack(HH, m.id, 'm1', jst(DATE, '09:11'), { falseAlarm: true });
  assert.equal(store.notices.get(m.id)!.falseAlarm, true);
  assert.equal(store.days.get(`${HH}/${DATE}`)!.signals.falseAlarmCount, 2);
});

test('同じ項目でも由来が違えば別の通知（痛みと連絡の依頼）', async () => {
  const { store, fn } = setup();
  const a = await fn.notify(req({ origin: 'pain', task: 'return' }));
  const b = await fn.notify(req({ origin: 'contact', task: 'return' }));
  assert.notEqual(a.id, b.id);
  assert.equal(store.notices.size, 2);
});
