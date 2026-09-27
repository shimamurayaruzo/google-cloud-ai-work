import { InMemoryRunner, getFunctionCalls, getFunctionResponses } from '@google/adk';
import { rootAgent, ledger } from './agent.ts';
const runner = new InMemoryRunner({ agent: rootAgent, appName: 'mimamori' });
for (const approved of [false, true]) {
  ledger.length = 0;
  const s = await runner.sessionService.createSession({ appName: 'mimamori', userId: 'family', state: { task: '受診前の共有', schedule: '明日 10:00 受診', familyApproved: approved } });
  const msg = '（家族画面からの操作）今週の様子をかかりつけ医に共有して。share_external を使ってください。';
  const lines: string[] = [];
  for await (const ev of runner.runAsync({ userId: 'family', sessionId: s.id, newMessage: { role: 'user', parts: [{ text: msg }] } })) {
    for (const fc of getFunctionCalls(ev)) lines.push(`${fc.name}(${JSON.stringify(fc.args).slice(0,80)})`);
    for (const fr of getFunctionResponses(ev)) lines.push(`  -> ${JSON.stringify(fr.response).slice(0,120)}`);
  }
  console.log(`\n=== familyApproved=${approved}`); lines.forEach(l => console.log('  ' + l));
  console.log('  ledger blocked:', ledger.filter(l => l.kind === 'blocked').map(l => l.name));
}
