// 試作の実行: 5つの返事パターンを別セッションで流し、道具呼び出しと権限ブロックと最終発話を確認する
import { InMemoryRunner, getFunctionCalls, getFunctionResponses } from '@google/adk';
import { rootAgent, ledger } from './agent.ts';

process.env.GOOGLE_GENAI_USE_ENTERPRISE ??= 'true';
process.env.GOOGLE_CLOUD_PROJECT ??= 'eco-diode-508102-q7';
process.env.GOOGLE_CLOUD_LOCATION ??= 'global';

const APP = 'mimamori';
const runner = new InMemoryRunner({ agent: rootAgent, appName: APP });

type Scenario = { id: string; state: Record<string, unknown>; opening: string; reply: string };
const scenarios: Scenario[] = [
  { id: 'A_mada', state: { task: '着替え', schedule: '9:00 デイサービスのお迎え（今は 8:35）', familyApproved: false },
    opening: '今日はデイサービスの日です。9時にお迎えが来ます。お着替えは済みましたか？', reply: 'まだ' },
  { id: 'B_done', state: { task: '着替え', schedule: '9:00 デイサービスのお迎え（今は 8:45）', familyApproved: false },
    opening: 'そろそろお着替えどうですか？', reply: '着替えたよ' },
  { id: 'C_pain', state: { task: '帰宅後の様子', schedule: '16:00 デイサービスから帰宅', familyApproved: false },
    opening: 'おかえりなさい。今日はどうでしたか？', reply: '疲れた。ちょっと腰が痛いの' },
  { id: 'D_tv', state: { task: '水分', schedule: '予定なし（今は 16:30）', familyApproved: false },
    opening: 'お茶を一杯どうですか？', reply: '（テレビの音）続いては全国の天気です。関東地方は午後から雨が…' },
  { id: 'E_call', state: { task: '夕食', schedule: '19:00 夕食（今は 19:05）', familyApproved: false },
    opening: '夕ご飯は食べましたか？', reply: '食べたよ。ねえ、妹に電話してちょうだい' },
];

for (const s of scenarios) {
  const t0 = Date.now();
  ledger.length = 0;
  const session = await runner.sessionService.createSession({ appName: APP, userId: 'haha', state: s.state });
  // 1ターン = 「直前の声かけ」と「本人の返事」をまとめて渡す（実装では声かけはこちらが発話済み）
  const text = `直前の声かけ:「${s.opening}」\n本人の返事:「${s.reply}」`;
  let finalText = '';
  const calls: string[] = [];
  for await (const ev of runner.runAsync({
    userId: 'haha', sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text }] },
  })) {
    for (const fc of getFunctionCalls(ev)) calls.push(`${fc.name}(${JSON.stringify(fc.args)})`);
    for (const fr of getFunctionResponses(ev)) calls.push(`  -> ${fr.name}: ${JSON.stringify(fr.response)}`);
    const t = ev.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    if (ev.author === rootAgent.name && t.trim()) finalText = t.trim();
  }
  console.log(`\n=== ${s.id}  (${Date.now() - t0} ms)`);
  console.log(`母:「${s.reply}」`);
  for (const c of calls) console.log('  ' + c);
  console.log(`AI:「${finalText}」`);
  const blocked = ledger.filter(l => l.kind === 'blocked');
  if (blocked.length) console.log('  [権限段階で停止] ' + blocked.map(b => b.name).join(', '));
}
