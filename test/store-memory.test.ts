// MemoryStore の主要メソッド
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { jstDate } from '../src/time.js';
import type { Day, LedgerEntry, Notice, Prompt, Turn } from '../src/types.js';

const HH = 'hh_test';

function day(date: string, signals: Partial<Day['signals']> = {}): Day {
  return {
    hh: HH, date, isDayservice: false, plan: [], planApproved: null, tasks: {}, summary: null,
    signals: { unclearCount: 0, noAnswerCount: 0, repeatedQuestions: 0, urgentCount: 0, ...signals },
  };
}

function prompt(id: string, time: string, state: Prompt['state'] = 'queued'): Prompt {
  return {
    id, hh: HH, date: '2026-10-01', task: 'water', text: 'お茶を一杯どうですか？',
    scheduledAt: jstDate('2026-10-01', time), isRecheck: false, state, expression: 'smile',
  };
}

test('households: 深いコピーで返す（呼び出し側の変更が漏れない）', async () => {
  const s = new MemoryStore();
  await s.putHousehold(defaultHousehold(HH));
  const h = (await s.getHousehold(HH))!;
  h.plan.weekday.default[0].text = '書き換え';
  h.killSwitch = true;
  const again = (await s.getHousehold(HH))!;
  assert.equal(again.plan.weekday.default[0].text, 'おはようございます。よく眠れましたか？');
  assert.equal(again.killSwitch, false);
  await s.updateHousehold(HH, { killSwitch: true });
  assert.equal((await s.getHousehold(HH))!.killSwitch, true);
  assert.equal((await s.listHouseholds()).length, 1);
  await assert.rejects(s.updateHousehold('hh_none', { killSwitch: true }));
});

test('days: putDay / setTask / updateDay。日が無ければ setTask は throw', async () => {
  const s = new MemoryStore();
  await assert.rejects(s.setTask(HH, '2026-10-01', 'water', { state: 'pending', recheckCount: 0, promptIds: [] }));
  await s.putDay(day('2026-10-01'));
  await s.setTask(HH, '2026-10-01', 'water', { state: 'done', status: 'done', recheckCount: 0, promptIds: ['pr_1'], at: new Date() });
  await s.updateDay(HH, '2026-10-01', { planApproved: { by: 'mem_1', at: new Date() } });
  const d = (await s.getDay(HH, '2026-10-01'))!;
  assert.equal(d.tasks.water?.state, 'done');
  assert.ok(d.tasks.water?.at instanceof Date);
  assert.equal(d.planApproved?.by, 'mem_1');
});

test('listRecentDays: date を含まず、新しい順に N 件', async () => {
  const s = new MemoryStore();
  for (const dt of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) await s.putDay(day(dt));
  const r = await s.listRecentDays(HH, '2026-09-30', 3);
  assert.deepEqual(r.map(d => d.date), ['2026-09-29', '2026-09-28', '2026-09-27']);
});

test('prompts: listDuePrompts は queued かつ期限が来たものを時刻順', async () => {
  const s = new MemoryStore();
  await s.putPrompt(prompt('pr_c', '15:30'));
  await s.putPrompt(prompt('pr_a', '10:30'));
  await s.putPrompt(prompt('pr_b', '12:00', 'delivered'));
  await s.putPrompt(prompt('pr_d', '08:00'));
  const due = await s.listDuePrompts(HH, '2026-10-01', jstDate('2026-10-01', '13:00'));
  assert.deepEqual(due.map(p => p.id), ['pr_d', 'pr_a']);
  await s.updatePrompt(HH, '2026-10-01', 'pr_d', { state: 'answered' });
  assert.equal((await s.getPrompt(HH, '2026-10-01', 'pr_d'))!.state, 'answered');
  assert.equal((await s.listPrompts(HH, '2026-10-01')).length, 4);
});

test('turns: getTurn は日付なしで引ける。listTurns はその日の返事の時刻順', async () => {
  const s = new MemoryStore();
  const base: Omit<Turn, 'id' | 'date' | 'repliedAt'> = {
    hh: HH, promptId: 'pr_1', task: 'water', promptedAt: new Date(), promptText: 'x', replyText: 'はい', replySource: 'test',
    classified: { status: 'done', note: '', by: 'rules' }, toolCalls: [], say: '', expression: 'smile', latencyMs: 1,
  };
  await s.putTurn({ ...base, id: 'tn_2', date: '2026-10-01', repliedAt: jstDate('2026-10-01', '12:00') });
  await s.putTurn({ ...base, id: 'tn_1', date: '2026-10-01', repliedAt: jstDate('2026-10-01', '08:00') });
  await s.putTurn({ ...base, id: 'tn_3', date: '2026-10-02', repliedAt: jstDate('2026-10-02', '08:00') });
  assert.equal((await s.getTurn(HH, 'tn_3'))!.date, '2026-10-02');
  assert.equal(await s.getTurn(HH, 'tn_x'), null);
  assert.deepEqual((await s.listTurns(HH, '2026-10-01')).map(t => t.id), ['tn_1', 'tn_2']);
});

test('notices: listOpenNotices は open / waiting / deferred', async () => {
  const s = new MemoryStore();
  const mk = (id: string, state: Notice['state']): Notice => ({
    id, hh: HH, date: '2026-10-01', level: 'check', reason: 'r', evidence: 'e', turnId: null, steps: [], state,
    createdAt: new Date(),
  });
  for (const [id, st] of [['nt_1', 'open'], ['nt_2', 'acked'], ['nt_3', 'waiting'], ['nt_4', 'deferred'], ['nt_5', 'closed']] as const) {
    await s.putNotice(mk(id, st));
  }
  assert.deepEqual((await s.listOpenNotices(HH)).map(n => n.id).sort(), ['nt_1', 'nt_3', 'nt_4']);
  await s.updateNotice(HH, 'nt_1', { state: 'acked' });
  assert.equal((await s.listOpenNotices(HH)).length, 2);
  assert.equal((await s.listNotices(HH, '2026-10-01')).length, 5);
});

test('ledger: 追記した順に残り、日付で絞れる', async () => {
  const s = new MemoryStore();
  const at = new Date();
  const mk = (id: string, date: string): LedgerEntry => ({ id, hh: HH, date, at, actor: 'agent', kind: 'prompt', name: 'prompt_sent' });
  await s.appendLedger(mk('lg_1', '2026-10-01'));
  await s.appendLedger(mk('lg_2', '2026-10-02'));
  await s.appendLedger(mk('lg_3', '2026-10-01'));
  assert.deepEqual((await s.listLedger(HH, '2026-10-01')).map(e => e.id), ['lg_1', 'lg_3']);
});

test('health: 生存信号と生活音', async () => {
  const s = new MemoryStore();
  const at = jstDate('2026-10-01', '09:00');
  await s.recordHeartbeat({ hh: HH, at, batteryPct: 80 });
  assert.equal((await s.getHealth(HH, '2026-10-01'))!.lastHeartbeatAt?.getTime(), at.getTime());
  await s.recordNoise({ hh: HH, at: jstDate('2026-10-01', '08:50'), rms: 0.1 });
  await s.recordNoise({ hh: HH, at: jstDate('2026-10-01', '09:05'), rms: 0.2 });
  assert.equal((await s.listRecentNoise(HH, at)).length, 1);
});

test('criteria v2 の新しい項目（day.l4・通知の falseAlarm/deferredReason/origin・確信度・安心文）が出し入れで残る', async () => {
  const s = new MemoryStore();
  await s.putDay(day('2026-10-01'));
  const since = jstDate('2026-10-01', '10:31');
  await s.updateDay(HH, '2026-10-01', { l4: { noticeId: 'nt_1', since, task: 'water', reason: '「転んだ」とおっしゃいました', origin: 'l4_words' } });
  assert.equal((await s.getDay(HH, '2026-10-01'))!.l4!.since.getTime(), since.getTime());
  await s.updateDay(HH, '2026-10-01', { l4: null });
  assert.equal((await s.getDay(HH, '2026-10-01'))!.l4, null);

  await s.putNotice({
    id: 'nt_1', hh: HH, date: '2026-10-01', level: 'info', reason: 'x', evidence: '', turnId: null, steps: [], state: 'deferred',
    createdAt: since, deferredReason: 'daily_cap', origin: 'not_done', uncertain: true,
  });
  await s.updateNotice(HH, 'nt_1', { state: 'acked', falseAlarm: true });
  const n = (await s.getNotice(HH, 'nt_1'))!;
  assert.deepEqual([n.state, n.falseAlarm, n.deferredReason, n.origin, n.uncertain], ['acked', true, 'daily_cap', 'not_done', true]);

  await s.putPrompt({ ...prompt('pr_r', '10:34', 'delivered'), isReassurance: true, followup: { reason: '痛みの聞き直し', noticeId: 'nt_1' } });
  const p = (await s.getPrompt(HH, '2026-10-01', 'pr_r'))!;
  assert.equal(p.isReassurance, true);
  assert.equal(p.followup?.noticeId, 'nt_1');
});

test('Firestore に書く前に undefined を入れ子まで落とす（Date はそのまま）', async () => {
  const { stripUndefined } = await import('../src/store/firestore.js');
  const at = new Date('2026-10-01T01:00:00Z');
  const out = stripUndefined({
    a: 1, b: undefined, l4: null, since: at,
    classified: { status: 'done', confidence: undefined, uncertain: false },
    list: [1, undefined, { x: undefined, y: 2 }],
  });
  assert.deepEqual(out, { a: 1, l4: null, since: at, classified: { status: 'done', uncertain: false }, list: [1, { y: 2 }] });
  assert.ok((out as { since: Date }).since instanceof Date);
});
