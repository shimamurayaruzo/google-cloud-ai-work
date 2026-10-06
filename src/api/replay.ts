// 再生モード（POST /api/family/replay）。台本を本番とは別の AppContext で流す。
//  - Store は MemoryStore（本番の Firestore には書かない）。世帯だけ本番から写す
//  - 会話ターンは RulesTurnRunner（LLM を呼ばない）。?agent=adk のときだけ createTurnRunner()
//  - 通知・送信（LINE／メール／Slack）・時刻の予約（Cloud Tasks）・音声合成は state/fakes.ts のフェイク。
//    通知は MemoryStore に notices と台帳として残るだけで、外へは何も出ない

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AppContext } from '../services.js';
import { MemoryStore } from '../store/index.js';
import { RulesTurnRunner, createTurnRunner } from '../agent/index.js';
import { createFakeContext, type FakeContext } from '../state/fakes.js';
import type { ReplayResult } from '../state/replay.js';
import { systemClock } from '../time.js';
import { TASK_KEYS, type HouseholdId, type Scenario } from '../types.js';
import { HttpError } from './router.js';

export const SCENARIO_DIR = fileURLToPath(new URL('../../eval/scenarios/', import.meta.url));

// ---- 台本の形（docs/02 §9） ----
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM で書いてください');
const ScenarioSchema = z.object({
  name: z.string().max(80).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD で書いてください'),
  isDayservice: z.boolean(),
  turns: z.array(z.object({
    at: HHMM,
    task: z.enum(TASK_KEYS),
    reply: z.string().max(500).nullable(),
    expect: z.object({
      status: z.enum(['done', 'not_yet', 'no_answer', 'unclear']),
      notify: z.enum(['urgent', 'check', 'info']).optional(),
    }).optional(),
  })).min(1).max(100),
});

export function parseScenario(raw: unknown): Scenario {
  const r = ScenarioSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.slice(0, 5).map(i => `${i.path.join('.') || '(台本)'}: ${i.message}`).join(' / ');
    throw new HttpError(400, `台本の形が正しくありません: ${msg}`);
  }
  return r.data as Scenario;
}

/** eval/scenarios/*.json の名前一覧（拡張子なし） */
export async function listScenarioNames(): Promise<string[]> {
  try {
    const files = await readdir(SCENARIO_DIR);
    return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

export async function loadScenarioByName(name: string): Promise<Scenario> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new HttpError(400, '台本の名前は英数字・-・_ だけです');
  let text: string;
  try {
    text = await readFile(`${SCENARIO_DIR}${name}.json`, 'utf8');
  } catch {
    throw new HttpError(404, `台本 ${name} が見つかりません`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(500, `台本 ${name} の JSON が読めません`);
  }
  const s = parseScenario(data);
  return { ...s, name: s.name ?? name };
}

/** body から台本を取り出す: Scenario そのもの ／ { scenario } ／ { name } */
export async function scenarioFromBody(body: Record<string, unknown>): Promise<Scenario> {
  if (body.scenario && typeof body.scenario === 'object') return parseScenario(body.scenario);
  if (Array.isArray(body.turns)) return parseScenario(body);
  if (typeof body.name === 'string') return loadScenarioByName(body.name);
  throw new HttpError(400, '台本（turns を含む JSON）か { name: "台本名" } を送ってください');
}

/** 本番の世帯を写した、再生専用の AppContext（state/fakes.ts の createFakeContext を使う） */
export async function buildReplayContext(base: AppContext, hh: HouseholdId, agent: 'rules' | 'adk'): Promise<FakeContext> {
  const household = await base.store.getHousehold(hh);
  const store = new MemoryStore();
  // 再生は評価のためのもの。本番の停止スイッチは写さない（本番には何も出ないので安全）。
  // 世帯が無ければ runScenario がデモ世帯を入れる
  if (household) await store.putHousehold({ ...structuredClone(household), killSwitch: false });
  const turnRunner = agent === 'adk' ? createTurnRunner() : new RulesTurnRunner();
  return createFakeContext({ store, turnRunner, clock: systemClock });
}

export async function runReplay(
  base: AppContext,
  hh: HouseholdId,
  scenario: Scenario,
  opts: { agent: 'rules' | 'adk'; withSummary: boolean },
): Promise<ReplayResult> {
  const { ctx } = await buildReplayContext(base, hh, opts.agent);
  // 再生は滅多に呼ばれないので、使うときに読み込む（起動を軽くし、ルーター全体を state/replay に依存させない）
  const { runScenario } = await import('../state/replay.js');
  return runScenario(ctx, hh, scenario, { withSummary: opts.withSummary });
}
