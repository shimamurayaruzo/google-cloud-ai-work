// 手動確認用: agent-spike/run.ts の 5 シナリオを本番の AdkTurnRunner で流し、
// 道具の呼び出し・intents・本人への一言・所要時間を表示する。実際に Gemini（Vertex）を呼ぶ。
//
// 実行（Git Bash、リポジトリ直下。gcloud auth application-default login 済みであること）:
//   GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_PROJECT=eco-diode-508102-q7 GOOGLE_CLOUD_LOCATION=global \
//   NODE_EXTRA_CA_CERTS="$LOCALAPPDATA/Google/Cloud SDK/ca-bundle.pem" npx tsx scripts/try-turn.ts
// 規則だけで比べるときは末尾に --rules を付ける。

import { AdkTurnRunner, RulesTurnRunner } from '../src/agent/index.js';
import type { TurnInput, TurnRunner } from '../src/services.js';
import type { Day, Household, Prompt, TaskKey } from '../src/types.js';
import { jstDate } from '../src/time.js';

const DATE = '2026-09-29'; // 火曜（デイの日）

const household: Household = {
  id: 'hh_try', name: '試し', timezone: 'Asia/Tokyo',
  person: { callName: 'お母さん', wording: { diaper: 'おむつ', medicine: '脳の薬', medicinePlace: '黒い机の上' } },
  members: [{ id: 'mem_1', name: '長女', order: 1, waitMinutes: 10 }],
  plan: { weekday: { default: [], dayservice: [] }, dayserviceDays: ['Tue', 'Fri'], pickupTime: '09:00' },
  policy: { recheckOnce: true, recheckMinutes: 15, quietHours: { from: '21:30', to: '07:30' } },
  killSwitch: false,
};

function makeDay(isDayservice: boolean): Day {
  return {
    hh: household.id, date: DATE, isDayservice,
    plan: isDayservice
      ? [{ time: '08:35', task: 'dress' }, { time: '09:00', task: 'pickup' }, { time: '16:00', task: 'return' }, { time: '16:30', task: 'water' }, { time: '19:00', task: 'dinner' }, { time: '19:40', task: 'medicine' }]
      : [{ time: '08:40', task: 'dress' }, { time: '15:30', task: 'water' }, { time: '19:00', task: 'dinner' }],
    planApproved: null, tasks: {}, summary: null,
    signals: { unclearCount: 0, noAnswerCount: 0, repeatedQuestions: 0, urgentCount: 0 },
  };
}

interface Scenario { id: string; task: TaskKey; at: string; dayservice: boolean; opening: string; reply: string | null }
const scenarios: Scenario[] = [
  { id: 'A_mada', task: 'dress', at: '08:35', dayservice: true, opening: '今日はデイサービスの日です。9時にお迎えが来ます。お着替えは済みましたか？', reply: 'まだ' },
  { id: 'B_done', task: 'dress', at: '08:45', dayservice: true, opening: 'そろそろお着替えどうですか？', reply: '着替えたよ' },
  { id: 'C_pain', task: 'return', at: '16:00', dayservice: true, opening: 'おかえりなさい。今日はどうでしたか？', reply: '疲れた。ちょっと腰が痛いの' },
  { id: 'D_tv', task: 'water', at: '16:30', dayservice: false, opening: 'お茶を一杯どうですか？', reply: '（テレビの音）続いては全国の天気です。関東地方は午後から雨が…' },
  { id: 'E_call', task: 'dinner', at: '19:05', dayservice: true, opening: '夕ご飯は食べましたか？', reply: '食べたよ。ねえ、妹に電話してちょうだい' },
];

const useRules = process.argv.includes('--rules');
const runner: TurnRunner = useRules ? new RulesTurnRunner() : new AdkTurnRunner();

// 構造化ログ（JSON 1 行）は表示を読みにくくするので、この確認では黙らせる
const quiet = process.argv.includes('--verbose') ? null : console.log;
if (quiet) console.log = (...a: unknown[]) => { if (typeof a[0] === 'string' && a[0].startsWith('{"severity"')) return; quiet(...a); };

for (const s of scenarios) {
  const now = jstDate(DATE, s.at);
  const prompt: Prompt = {
    id: `pr_${s.id}`, hh: household.id, date: DATE, task: s.task, text: s.opening,
    scheduledAt: now, isRecheck: false, state: 'delivered', expression: 'listen',
  };
  const input: TurnInput = {
    household, day: makeDay(s.dayservice), prompt, replyText: s.reply, source: 'test', now,
    recheckAllowed: true, familyApprovedShare: false, recentTurns: [],
  };
  const o = await runner.run(input);
  console.log(`\n=== ${s.id}  (${o.latencyMs} ms)${o.degraded ? `  [代替: ${o.degraded.reason}]` : ''}`);
  console.log(`母:「${s.reply ?? '（返事なし）'}」`);
  for (const t of o.toolCalls) {
    console.log(`  ${t.blocked ? '[止めた] ' : ''}${t.name}(${JSON.stringify(t.args)})${t.reason ? ` 理由: ${t.reason}` : ''}`);
  }
  console.log(`  分類: ${o.classified.status}（${o.classified.by}）${o.classified.note}`);
  for (const i of o.intents) console.log(`  intent: ${JSON.stringify(i)}`);
  console.log(`AI:「${o.say}」 表情: ${o.expression}`);
}
