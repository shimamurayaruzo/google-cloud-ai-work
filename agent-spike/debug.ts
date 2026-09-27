import { InMemoryRunner } from '@google/adk';
import { rootAgent } from './agent.ts';
const runner = new InMemoryRunner({ agent: rootAgent, appName: 'mimamori' });
const s = await runner.sessionService.createSession({ appName: 'mimamori', userId: 'haha', state: { task: '着替え', schedule: '9:00 お迎え', familyApproved: false } });
try {
  for await (const ev of runner.runAsync({ userId: 'haha', sessionId: s.id, newMessage: { role: 'user', parts: [{ text: '直前の声かけ:「お着替えは済みましたか？」\n本人の返事:「まだ」' }] } })) {
    console.log('EVENT', JSON.stringify({ author: ev.author, err: (ev as any).errorCode, msg: (ev as any).errorMessage, parts: ev.content?.parts }, null, 0).slice(0, 600));
  }
  console.log('done');
} catch (e) { console.log('THROWN', (e as Error).message?.slice(0, 800)); }
