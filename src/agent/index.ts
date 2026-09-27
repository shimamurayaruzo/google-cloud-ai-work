// 会話ターン（agent/）の入口。AGENT_MODE で ADK（Gemini）と規則だけを切り替える。
// テストと再生モードでは RulesTurnRunner を直接使ってもよい。

import { config } from '../config.js';
import type { TurnRunner } from '../services.js';
import { AdkTurnRunner } from './adk.js';
import { RulesTurnRunner } from './rules.js';

export { AdkTurnRunner, decidePermission } from './adk.js';
export { RulesTurnRunner, postProcess, detectUrgent, analyzeReply, recheckMinutesFor, URGENT_KEYWORDS } from './rules.js';
export { buildInstruction, buildUserMessage } from './prompt.js';
export { createTools } from './tools.js';

export function createTurnRunner(): TurnRunner {
  return config.agentMode === 'rules' ? new RulesTurnRunner() : new AdkTurnRunner();
}
