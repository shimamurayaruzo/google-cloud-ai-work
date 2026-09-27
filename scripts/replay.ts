// 台本（eval/scenarios/*.json）を手元で流して、判定・再確認・通知と期待値の一致を表で見る。
// Store はメモリ、送信・予約・音声合成はフェイク（src/state/fakes.ts）なので、外へは何も出ない。
//
// 実行（リポジトリの直下で）:
//   AGENT_MODE=rules npx tsx scripts/replay.ts                         … 規則だけ（ネットワーク不要）
//   NODE_EXTRA_CA_CERTS="$LOCALAPPDATA/Google/Cloud SDK/ca-bundle.pem" \
//     GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_LOCATION=global \
//     AGENT_MODE=adk npx tsx scripts/replay.ts eval/scenarios/dayservice-day.json --summary
//   AGENT_MODE=keyword npx tsx scripts/replay.ts                      … state/fakes.ts の KeywordTurnRunner
//
// 引数: 台本のパス（複数可。省略時は eval/scenarios/*.json 全部）、--summary で最後に「今日の様子」も作る。
// 終了コード: 期待値と違うステップがあれば 1。

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TurnRunner } from '../src/services.js';
import { MemoryStore } from '../src/store/memory.js';
import { demoHousehold } from '../src/seed/household.js';
import { createFakeContext, KeywordTurnRunner } from '../src/state/fakes.js';
import { runScenario } from '../src/state/replay.js';
import type { Scenario } from '../src/types.js';

const args = process.argv.slice(2);
const withSummary = args.includes('--summary');
let files = args.filter(a => !a.startsWith('--'));
if (files.length === 0) {
  const dir = path.resolve('eval/scenarios');
  files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f));
}

async function makeRunner(): Promise<{ runner: TurnRunner; label: string }> {
  const mode = process.env.AGENT_MODE ?? 'rules';
  if (mode === 'keyword') return { runner: new KeywordTurnRunner(), label: 'keyword（fakes）' };
  try {
    const agent = await import('../src/agent/index.js');
    if (mode === 'rules') return { runner: new agent.RulesTurnRunner(), label: 'rules' };
    return { runner: agent.createTurnRunner(), label: mode };
  } catch (error) {
    console.warn(`agent/ を読み込めないので KeywordTurnRunner で流します: ${(error as Error).message}`);
    return { runner: new KeywordTurnRunner(), label: 'keyword（代替）' };
  }
}

function cell(s: string, width: number): string {
  // 全角は幅 2 として揃える
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = /[\u0000-ÿ]/.test(ch) ? 1 : 2;
    if (w + cw > width) { out += '…'; w += 1; break; }
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(Math.max(0, width - w));
}

const { runner, label } = await makeRunner();
let totalFail = 0;

for (const file of files) {
  const scenario = JSON.parse(await readFile(file, 'utf8')) as Scenario;
  const store = new MemoryStore();
  const household = demoHousehold();
  await store.putHousehold(household);
  const { ctx } = createFakeContext({ store, turnRunner: runner });
  const result = await runScenario(ctx, household.id, scenario, { withSummary, useLlm: withSummary && label === 'adk' });

  console.log(`\n== ${scenario.name ?? path.basename(file)}（${scenario.date}、${scenario.isDayservice ? 'デイの日' : 'デイ以外'}、runner=${label}）`);
  console.log(`${cell('時刻', 6)}${cell('項目', 12)}${cell('返事', 26)}${cell('判定', 10)}${cell('期待', 16)}${cell('結果', 6)}${cell('再確認', 7)}通知 / 一言`);
  for (const s of result.steps) {
    const expected = s.expected ? `${s.expected.status}${s.expected.notify ? `+${s.expected.notify}` : ''}` : '-';
    const mark = s.pass === undefined ? '-' : s.pass ? 'OK' : 'NG';
    const extra = [...s.notices, `「${s.say}」`].join(' / ');
    console.log(`${cell(s.at, 6)}${cell(s.task, 12)}${cell(s.reply ?? '（返事なし）', 26)}${cell(s.status, 10)}${cell(expected, 16)}${cell(mark, 6)}${cell(s.followUpAt ?? '', 7)}${extra}`);
  }
  console.log(`期待値との一致: ${result.passCount} OK / ${result.failCount} NG`);
  if (result.summary) {
    console.log('\n-- 今日の様子 --');
    result.summary.sentences.forEach((t, i) => {
      const c = result.summary!.citations.find(x => x.sentenceIndex === i);
      console.log(`${i + 1}. ${t}${c ? `  [${c.turnId}]` : ''}`);
    });
  }
  totalFail += result.failCount;
}

process.exit(totalFail > 0 ? 1 : 0);
