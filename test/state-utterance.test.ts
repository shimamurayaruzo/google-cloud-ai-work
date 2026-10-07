// 本人からの発話（声かけへの返事ではないもの。docs/02 §11.2）: 居場所・薬・L4・痛み・テレビ・会話
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { defaultHousehold } from '../src/seed/household.js';
import { createFakeContext } from '../src/state/fakes.js';
import { ensureDay } from '../src/state/day.js';
import { handleUtterance } from '../src/state/utterance.js';
import { buildSummary } from '../src/state/summary.js';
import { jstDate } from '../src/time.js';
import { L4_SAY, PAIN_SAY, RulesTurnRunner } from '../src/agent/rules.js';
import { CHAT_FALLBACK_SAY, oneSentence, type ChatReplyFn } from '../src/agent/chat.js';

const HH = 'hh_u';
const THU = '2026-10-01';
const at = (t: string) => jstDate(THU, t);

async function setup() {
  const store = new MemoryStore();
  await store.putHousehold(defaultHousehold(HH));   // 家族（順番 1）は「島村」
  const fake = createFakeContext({ store, turnRunner: new RulesTurnRunner(), clock: () => at('08:00') });
  await ensureDay(fake.ctx, HH, THU);
  return fake;
}
type Fake = Awaited<ReturnType<typeof setup>>;
const neverChat: ChatReplyFn = async () => { throw new Error('LLM を呼ばないはず'); };

function say(fake: Fake, text: string, time: string, opts: Parameters<typeof handleUtterance>[2] = { agentMode: 'rules', chat: neverChat }) {
  return handleUtterance(fake.ctx, { hh: HH, text, source: 'test', now: at(time) }, opts);
}

test('居場所（登録あり）: 何度聞かれても同じ文。「さっきも」は言わない。30 分以内の 2 回目から繰り返しとして数える', async () => {
  const fake = await setup();
  await fake.store.updateHousehold(HH, { whereabouts: { place: 'お仕事', backAt: '18:00', updatedAt: at('08:30') } });
  const r1 = await say(fake, '島村さんはどこ？', '10:00');
  const r2 = await say(fake, 'あの子どこ行ったの', '10:10');
  assert.equal(r1.kind, 'whereabouts');
  assert.equal(r1.say, '島村さんは、お仕事に行っています。18 時ごろ帰ります。');
  assert.equal(r2.say, r1.say);
  assert.ok(!/さっき|前にも|また/.test(r2.say));
  assert.equal(r1.notices.length, 0);
  assert.equal((await fake.store.getDay(HH, THU))!.signals.repeatedQuestions, 1);
  const r3 = await say(fake, 'いつ帰ってくるの', '11:00');   // 30 分より後は数えない
  assert.equal(r3.say, r1.say);
  assert.equal((await fake.store.getDay(HH, THU))!.signals.repeatedQuestions, 1);
});

test('居場所: 帰る時刻を過ぎたら「もうすぐ帰ってきます」、未登録・前の日の登録なら「出かけています」', async () => {
  const fake = await setup();
  await fake.store.updateHousehold(HH, { whereabouts: { place: '買い物', backAt: '15:30', updatedAt: at('13:00') } });
  assert.equal((await say(fake, 'みんないないね', '15:30')).say, '島村さんは、もうすぐ帰ってきます。');
  assert.equal((await say(fake, 'どこ行ったの', '14:00')).say, '島村さんは、買い物に行っています。15 時 30 分ごろ帰ります。');

  const none = await setup();
  assert.equal((await say(none, '島村は？', '10:00')).say, '島村さんは出かけています。もうすぐ帰ってきますよ。');
  await none.store.updateHousehold(HH, { whereabouts: { place: 'お仕事', backAt: '18:00', updatedAt: jstDate('2026-09-30', '08:00') } });
  assert.equal((await say(none, 'どこにいるの', '10:00')).say, '島村さんは出かけています。もうすぐ帰ってきますよ。');
});

test('薬の質問は決まり文句で答える（「薬はどこ」は居場所ではなく薬）', async () => {
  const fake = await setup();
  const r1 = await say(fake, '何の薬？', '19:41');
  assert.equal(r1.kind, 'medicine');
  assert.equal(r1.say, '脳の薬ですよ。');
  const r2 = await say(fake, '薬はどこにあるの', '19:42');
  assert.equal(r2.kind, 'medicine');
  assert.equal(r2.say, '黒い机の上にありますよ。');
});

test('L4 の語 → urgent と L4 モード、本人には定型文。痛み → check と 3 時間後の聞き直し', async () => {
  const fake = await setup();
  const r = await say(fake, '転んで動けないの', '10:00');
  assert.equal(r.kind, 'notice');
  assert.equal(r.say, L4_SAY);
  assert.deepEqual(r.notices.map(n => [n.level, n.origin]), [['urgent', 'l4_words']]);
  assert.equal(r.notices[0].turnId, r.turn.id);
  const day = (await fake.store.getDay(HH, THU))!;
  assert.equal(day.l4?.noticeId, r.notices[0].id);
  assert.equal(day.signals.urgentCount, 1);
  // L4 の間の発話は判定せず、安心文を返し、通知の根拠に追記
  const r2 = await say(fake, 'いたい', '10:02');
  assert.equal(r2.notices.length, 0);
  assert.match((await fake.store.getNotice(HH, r.notices[0].id))!.evidence, /10:02「いたい」/);

  const p = await setup();
  const rp = await say(p, '腰が痛いのよ', '10:00');
  assert.equal(rp.say, PAIN_SAY);
  assert.deepEqual(rp.notices.map(n => [n.level, n.origin]), [['check', 'pain']]);
  const follow = (await p.store.listPrompts(HH, THU)).find(x => x.followup)!;
  assert.equal(follow.scheduledAt.getTime(), at('13:00').getTime());
  assert.equal(follow.followup!.noticeId, rp.notices[0].id);
  assert.equal((await p.store.getDay(HH, THU))!.l4 ?? null, null);
});

test('テレビ・雑音の印 → 返事をしない（ignored）。記録は turn に残す（unclear）', async () => {
  const fake = await setup();
  const r = await say(fake, '（テレビ）続いては天気予報です', '10:00');
  assert.equal(r.kind, 'ignored');
  assert.equal(r.say, '');
  assert.equal(r.turn.classified.status, 'unclear');
  assert.equal(r.notices.length, 0);
});

test('それ以外: AGENT_MODE=rules なら LLM を呼ばず固定文', async () => {
  const fake = await setup();
  const r = await say(fake, '今日はいい天気ねえ', '10:00');
  assert.equal(r.kind, 'chat');
  assert.equal(r.say, CHAT_FALLBACK_SAY);
  assert.equal(r.turn.classified.by, 'rules');
});

test('それ以外（LLM）: 確信度 0.7 以上はそのまま、低い・言ってはいけない文・失敗は固定文、本人向けでなければ返事をしない', async () => {
  const fake = await setup();
  const llm = (out: { say: string; confidence: number; addressed: boolean }): ChatReplyFn => async () => out;
  const ok = await say(fake, '今日はいい天気ねえ', '10:00', { agentMode: 'adk', chat: llm({ say: '本当ですね、気持ちがいいですね。', confidence: 0.9, addressed: true }) });
  assert.equal(ok.say, '本当ですね、気持ちがいいですね。');
  assert.equal(ok.turn.classified.by, 'llm');
  const low = await say(fake, 'あれはなんだっけ', '10:01', { agentMode: 'adk', chat: llm({ say: 'えっと', confidence: 0.4, addressed: true }) });
  assert.equal(low.say, CHAT_FALLBACK_SAY);
  const bad = await say(fake, 'さみしいわ', '10:02', { agentMode: 'adk', chat: llm({ say: 'ご家族に連絡しますね。', confidence: 0.95, addressed: true }) });
  assert.equal(bad.say, CHAT_FALLBACK_SAY);
  const tv = await say(fake, 'それでは次のコーナー', '10:03', { agentMode: 'adk', chat: llm({ say: 'はい', confidence: 0.9, addressed: false }) });
  assert.equal(tv.kind, 'ignored');
  assert.equal(tv.say, '');
  const broken = await say(fake, 'ねえ', '10:04', { agentMode: 'adk', chat: async () => { throw new Error('timeout'); } });
  assert.equal(broken.say, CHAT_FALLBACK_SAY);
  assert.equal((await fake.store.getHealth(HH, THU))!.incidents.at(-1)!.kind, 'llm_error');
});

test('停止中は「少し休みますね」だけ。L4 の語でも通知しない', async () => {
  const fake = await setup();
  await fake.store.updateHousehold(HH, { killSwitch: true });
  const r = await say(fake, '助けて', '10:00');
  assert.equal(r.say, '少し休みますね。');
  assert.equal(r.notices.length, 0);
  assert.equal(fake.familyNotify.calls.length, 0);
});

test('Turn は kind utterance・task talk で 7 日の TTL 付きで残り、台帳は 20 文字まで。夕方の「お返事の記録」には載らない', async () => {
  const fake = await setup();
  const text = '島村さんはどこに行ったのかしらねえ、さっきからずっと待っているのよ';
  const r = await say(fake, text, '10:00');
  const t = (await fake.store.getTurn(HH, r.turn.id))!;
  assert.equal(t.kind, 'utterance');
  assert.equal(t.task, 'talk');
  assert.equal(t.promptId, 'utterance');
  assert.equal(t.replyText, text);
  assert.equal(t.utteranceKind, 'whereabouts');
  assert.equal(t.expiresAt!.getTime(), at('10:00').getTime() + 7 * 24 * 60 * 60_000);
  const e = (await fake.store.listLedger(HH, THU)).find(x => x.name === 'utterance_received')!;
  assert.equal((e.args as { text: string }).text, `${text.slice(0, 20)}…`);
  assert.equal((e.args as { kind: string }).kind, 'whereabouts');
  const s = await buildSummary(fake.ctx, HH, THU, { useLlm: false });
  assert.ok(!s.text.includes('どこに行った'));
  assert.equal(s.citations.length, 0);
});

test('oneSentence: LLM の返事は 1 文に整える', () => {
  assert.equal(oneSentence('**そうですね。** 今日は晴れです。'), 'そうですね。');
});

test('外部連絡の依頼（「ケアマネさんに伝えて」）: 自分では連絡せず check、本人には「ご家族に伝えておきますね」', async () => {
  const fake = await setup();
  const r = await say(fake, 'ケアマネさんに伝えて', '10:00');
  assert.equal(r.kind, 'notice');
  assert.equal(r.say, 'ご家族に伝えておきますね。');
  assert.deepEqual(r.notices.map(n => [n.level, n.origin, n.reason]), [['check', 'contact', 'ケアマネさんに伝えてほしいと頼まれました（こちらからは連絡していません）']]);
});

test('居場所の言い方は行き先ごと（仕事・買い物・病院・外出）', async () => {
  const fake = await setup();
  const cases: Array<[string, string]> = [
    ['仕事', '島村さんは、お仕事に行っています。18 時ごろ帰ります。'],
    ['買い物', '島村さんは、買い物に行っています。18 時ごろ帰ります。'],
    ['病院', '島村さんは、病院に行っています。18 時ごろ帰ります。'],
    ['外出', '島村さんは、出かけています。18 時ごろ帰ります。'],
    ['図書館', '島村さんは、図書館に行っています。18 時ごろ帰ります。'],
  ];
  for (const [place, want] of cases) {
    await fake.store.updateHousehold(HH, { whereabouts: { place, backAt: '18:00', updatedAt: at('08:30') } });
    assert.equal((await say(fake, 'どこ行ったの', '10:00')).say, want);
  }
});

test('L4 は家族の「確認した」（誤報を含む）でその場で下りる（clearL4ForNotice）', async () => {
  const { clearL4ForNotice } = await import('../src/state/l4.js');
  const fake = await setup();
  const r = await say(fake, '助けて', '10:00');
  const id = r.notices[0].id;
  assert.equal(await clearL4ForNotice(fake.ctx, HH, id, at('10:05')), false);   // まだ確認されていない
  await fake.familyNotify.ack(HH, id, 'mem_1', at('10:05'), { falseAlarm: true });
  assert.equal(await clearL4ForNotice(fake.ctx, HH, id, at('10:05')), true);
  assert.equal((await fake.store.getDay(HH, THU))!.l4, null);
  const e = (await fake.store.listLedger(HH, THU)).find(x => x.name === 'l4_cleared')!;
  assert.equal((e.args as { falseAlarm: boolean }).falseAlarm, true);
  assert.equal(await clearL4ForNotice(fake.ctx, HH, id, at('10:06')), false);   // 二度目は何もしない
});
