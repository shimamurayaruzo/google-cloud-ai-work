// ADK（@google/adk）で会話ターンを 1 回だけ回す TurnRunner。
// - 道具と LlmAgent はターンごとに作る（collector と TurnInput を閉じ込めるため）
// - 権限の判定は beforeToolCallback の一か所（docs/02 §4）
// - LLM が遅い・落ちたときは RulesTurnRunner に切り替え、degraded を付ける
// - 最後に postProcess で決定論の保証をかける

import { InMemoryRunner, LlmAgent, LogLevel, getFunctionCalls, setLogLevel } from '@google/adk';
import type { BaseLlm, BaseTool, Context } from '@google/adk';
import { config } from '../config.js';
import { logError, logEvent } from '../log.js';
import type { Intent, TurnInput, TurnOutcome, TurnRunner } from '../services.js';
import type { ToolCallRecord } from '../types.js';
import { buildInstruction, buildUserMessage } from './prompt.js';
import { analyzeReply, buildRulesOutcome, expressionFor, killSwitchOutcome, postProcess } from './rules.js';
import { createTools } from './tools.js';

const APP_NAME = 'mimamori';
const AGENT_NAME = 'mimamori_turn';
const USER_ID = 'person';
/** 1 ターンで LLM を呼ぶ上限（道具の往復込み）。暴走を防ぐ */
const MAX_LLM_CALLS = 6;

let adkLogLevelSet = false;

/** Vertex 用の環境変数が未設定なら config から補う（@google/genai が process.env を読む） */
function ensureVertexEnv(): void {
  // ADK は既定で INFO（リクエストごとの「Sending out request」）を JSON でない形で出す。Cloud Logging を汚さないよう WARN 以上に絞る
  if (!adkLogLevelSet) { setLogLevel(LogLevel.WARN); adkLogLevelSet = true; }
  process.env.GOOGLE_GENAI_USE_ENTERPRISE ??= 'true';
  process.env.GOOGLE_CLOUD_PROJECT ??= config.projectId;
  process.env.GOOGLE_CLOUD_LOCATION ??= config.location;
}

export interface PermissionDecision { blocked: boolean; reason?: string }

/** 権限段階の判定（一か所）。自動 / 承認後 / しない */
export function decidePermission(toolName: string, input: TurnInput): PermissionDecision {
  if (toolName === 'call_outside') {
    return { blocked: true, reason: '本人の依頼による外部連絡は行わない。家族に「頼まれました」と notify_family(level=check) で伝える。' };
  }
  if (toolName === 'share_external' && input.familyApprovedShare !== true) {
    return { blocked: true, reason: '家族の承認がない。承認画面で家族が確認してから共有する。' };
  }
  if (toolName === 'schedule_recheck' && input.recheckAllowed === false) {
    return { blocked: true, reason: 'この項目の再確認は上限に達している（または 1 回のみの項目）。家族へ知らせるかは状態機械が決める。' };
  }
  return { blocked: false };
}

class LlmTimeoutError extends Error {
  constructor(ms: number) { super(`LLM が ${ms} ms 以内に応答しなかった`); this.name = 'LlmTimeoutError'; }
}

export class AdkTurnRunner implements TurnRunner {
  /** model は通常 config.geminiModel。テストでは偽の BaseLlm を渡してネットワークなしで配線を確かめる */
  constructor(private readonly opts: { model?: string | BaseLlm; timeoutMs?: number } = {}) {
    ensureVertexEnv();
  }

  async run(input: TurnInput): Promise<TurnOutcome> {
    const startedAt = Date.now();
    if (input.household.killSwitch) return killSwitchOutcome(startedAt);

    const timeoutMs = this.opts.timeoutMs ?? config.llmTimeoutMs;
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new LlmTimeoutError(timeoutMs)); }, timeoutMs);
    });

    try {
      const out = await Promise.race([this.runLlm(input, abort.signal, startedAt), timeout]);
      return out;
    } catch (error) {
      abort.abort();
      const isTimeout = error instanceof LlmTimeoutError;
      const logData = { hh: input.household.id, promptId: input.prompt.id, task: input.prompt.task, ms: Date.now() - startedAt };
      if (isTimeout) logEvent('llm_timeout', logData);
      else logError('llm_error', error, logData);
      const fallback = postProcess(buildRulesOutcome(input, startedAt), input);
      fallback.degraded = { reason: isTimeout ? 'llm_timeout' : 'llm_error' };
      fallback.latencyMs = Date.now() - startedAt;
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runLlm(input: TurnInput, signal: AbortSignal, startedAt: number): Promise<TurnOutcome> {
    const collector: Intent[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const byCallId = new Map<string, ToolCallRecord>();
    const tools = createTools(collector, input.prompt.task);

    const agent = new LlmAgent({
      name: AGENT_NAME,
      model: this.opts.model ?? config.geminiModel,
      description: '認知症の本人の返事を記録し、次の行動を決める見守りエージェント（1 ターン分）',
      // 関数で渡す: 文字列だと ADK が {名前} をセッション状態で置き換えてしまう
      instruction: () => buildInstruction(input),
      tools,
      beforeToolCallback: ({ tool, args, context }: { tool: BaseTool; args: Record<string, unknown>; context: Context }) => {
        const decision = decidePermission(tool.name, input);
        const rec: ToolCallRecord = { name: tool.name, args: { ...args }, result: undefined, blocked: decision.blocked };
        if (decision.reason) rec.reason = decision.reason;
        toolCalls.push(rec);
        if (context.functionCallId) byCallId.set(context.functionCallId, rec);
        logEvent(decision.blocked ? 'tool_blocked' : 'tool_call', { hh: input.household.id, promptId: input.prompt.id, tool: tool.name });
        if (!decision.blocked) return undefined; // 通常どおり実行
        const result = { blocked: true, reason: decision.reason ?? '' };
        rec.result = result;
        collector.push({ type: 'blocked', tool: tool.name, args: { ...args }, reason: decision.reason ?? '' });
        return result; // 道具は実行されず、この値が結果としてモデルに渡る
      },
      afterToolCallback: ({ tool, context, response }: { tool: BaseTool; args: Record<string, unknown>; context: Context; response: Record<string, unknown> }) => {
        const rec = (context.functionCallId && byCallId.get(context.functionCallId))
          || [...toolCalls].reverse().find(r => r.name === tool.name && r.result === undefined);
        if (rec && rec.result === undefined) rec.result = response;
        return undefined;
      },
    });

    const runner = new InMemoryRunner({ agent, appName: APP_NAME });
    const session = await runner.sessionService.createSession({ appName: APP_NAME, userId: USER_ID });

    let finalText = '';
    let calls = 0;
    for await (const ev of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: buildUserMessage(input) }] },
      runConfig: { maxLlmCalls: MAX_LLM_CALLS },
      abortSignal: signal,
    })) {
      if (signal.aborted) break;
      if (ev.errorCode) throw new Error(`LLM エラー: ${ev.errorCode} ${ev.errorMessage ?? ''}`.trim());
      calls += getFunctionCalls(ev).length;
      const text = ev.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '';
      if (ev.author === AGENT_NAME && text.trim() && !ev.partial) finalText = text.trim();
    }
    if (signal.aborted) throw new LlmTimeoutError(Date.now() - startedAt);

    const record = collector.find(i => i.type === 'record');
    const status = record?.type === 'record' ? record.status : analyzeReply(input.prompt.task, input.replyText, input.household).status;
    const note = record?.type === 'record' ? record.note : '記録なし（規則で補完）';
    const confidence = record?.type === 'record' ? record.confidence : undefined;
    const hasUrgent = collector.some(i => i.type === 'notify' && i.level === 'urgent');

    const outcome: TurnOutcome = {
      // 確信度は postProcess が record から読み、0.7 未満を uncertain にする
      classified: { status, note, by: 'llm', ...(typeof confidence === 'number' ? { confidence } : {}) },
      // 空なら postProcess が規則の固定文で埋める
      say: finalText,
      expression: expressionFor(status, hasUrgent),
      toolCalls,
      intents: collector,
      latencyMs: 0,
    };
    const out = postProcess(outcome, input);
    out.latencyMs = Date.now() - startedAt;
    logEvent('turn_classified', {
      hh: input.household.id, promptId: input.prompt.id, task: input.prompt.task,
      status: out.classified.status, by: out.classified.by, confidence: out.classified.confidence ?? null, functionCalls: calls,
      intents: out.intents.map(i => i.type), latencyMs: out.latencyMs,
    });
    return out;
  }
}
