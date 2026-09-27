// 見守りエージェント — ADK (TypeScript) 1日試作
// 目的: 「1回の声かけターン」を ADK のエージェント + 型付き道具で書き、
//       権限段階を beforeToolCallback 一か所で強制できるか、トレースが行動台帳に使えるかを確かめる。
import { FunctionTool, LlmAgent } from '@google/adk';
import { z } from 'zod';

// ---- 行動台帳（試作ではメモリ上。実装では Firestore + Cloud Logging）----
export type LedgerEntry = {
  at: string;
  kind: 'tool_call' | 'tool_result' | 'blocked' | 'agent_text';
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
};
export const ledger: LedgerEntry[] = [];
const now = () => new Date().toISOString();

// ---- 道具（型付き）----
const recordObservation = new FunctionTool({
  name: 'record_observation',
  description:
    '声かけの結果を記録する。必ず毎ターン1回呼ぶ。status は done(できた) / not_yet(まだ) / no_answer(返事なし) / unclear(本人の発話か分からない・判定できない)。',
  parameters: z.object({
    task: z.string().describe('確認していた項目。例: 着替え, おむつ交換, 服薬'),
    status: z.enum(['done', 'not_yet', 'no_answer', 'unclear']),
    note: z.string().describe('根拠になった本人の言葉を短く。推測は書かない'),
  }),
  execute: ({ task, status, note }) => {
    const r = { recorded: true, task, status, note };
    ledger.push({ at: now(), kind: 'tool_result', name: 'record_observation', result: r });
    return r;
  },
});

const scheduleRecheck = new FunctionTool({
  name: 'schedule_recheck',
  description:
    '少し置いてもう一度声をかける予約を入れる。「まだ」や返事なしのときに使う。同じ項目の再確認は1回まで。',
  parameters: z.object({
    minutes: z.number().int().min(5).max(60),
    reason: z.string(),
  }),
  execute: ({ minutes, reason }) => {
    const r = { scheduled: true, minutes, reason };
    ledger.push({ at: now(), kind: 'tool_result', name: 'schedule_recheck', result: r });
    return r;
  },
});

const notifyFamily = new FunctionTool({
  name: 'notify_family',
  description:
    '家族に知らせる。level は urgent(「痛い」「転んだ」「助けて」などの発話。即時) / check(緊急ではないが確認してほしい) / info(準備完了などの短い報告)。根拠の発話を evidence に必ず入れる。',
  parameters: z.object({
    level: z.enum(['urgent', 'check', 'info']),
    reason: z.string(),
    evidence: z.string(),
  }),
  execute: ({ level, reason, evidence }) => {
    const r = { notified: true, channel: level === 'urgent' ? 'LINE(即時)' : 'LINE', level, reason, evidence };
    ledger.push({ at: now(), kind: 'tool_result', name: 'notify_family', result: r });
    return r;
  },
});

const shareExternal = new FunctionTool({
  name: 'share_external',
  description: '医師やケアマネジャーに様子を共有する。家族の承認がある場合だけ実行される。',
  parameters: z.object({
    recipient: z.enum(['doctor', 'care_manager']),
    summary: z.string(),
  }),
  execute: ({ recipient, summary }) => {
    const r = { shared: true, recipient, summary };
    ledger.push({ at: now(), kind: 'tool_result', name: 'share_external', result: r });
    return r;
  },
});

const callOutside = new FunctionTool({
  name: 'call_outside',
  description: '本人に頼まれて外部（家族以外）に電話やメッセージを送る。',
  parameters: z.object({ who: z.string(), message: z.string() }),
  execute: ({ who, message }) => {
    const r = { called: true, who, message };
    ledger.push({ at: now(), kind: 'tool_result', name: 'call_outside', result: r });
    return r;
  },
});

// ---- 権限段階を一か所で強制する ----
// 自動: record_observation / schedule_recheck / notify_family
// 承認後: share_external（session.state.familyApproved が true のときだけ）
// しない: call_outside（常に止める。家族へ「頼まれた」と伝えるだけ）
export const rootAgent = new LlmAgent({
  name: 'mimamori_turn',
  model: 'gemini-2.5-flash',
  description: '認知症の母に声をかけ、返事を記録し、次の行動を決める見守りエージェント（1ターン分）',
  instruction: `あなたは自宅で暮らす認知症のお母さんの話し相手で、家族に代わって日中の声かけをします。

前提（セッション状態から）:
- 今の確認項目: {task}
- 今日の予定: {schedule}
- 呼び方の決まり: 紙パンツは「おむつ」と呼ぶ。薬は「脳の薬」。薬の場所は「黒い机の上」。

話し方:
- 短く、やさしく、責めない。1回の返答は2文まで。敬語は柔らかく（〜しましょうか、〜できましたか）。
- 本人を試す質問や採点はしない。

毎ターンの手順:
1. 本人の返事を読み、必ず record_observation を1回呼ぶ。
   - 「まだ」「あとで」→ status=not_yet。続けて schedule_recheck を呼ぶ（デイサービスの予定があれば、お迎えに間に合う時間で）。
   - 「できた」「替えた」「飲んだ」→ status=done。
   - 返事がない → status=no_answer。schedule_recheck を呼ぶ。
   - テレビや来客の声など、本人の発話か分からないもの → status=unclear。判定せず、何も決めつけない。
2. 「痛い」「転んだ」「苦しい」「助けて」が含まれていたら notify_family(level=urgent) を呼ぶ。医療の判断はしない。
3. 本人が「電話して」「連絡して」と外部への連絡を頼んだら、自分では連絡せず、notify_family(level=check) で家族に「こう頼まれました」と伝える。call_outside は使わない。
4. 医師やケアマネへの共有（share_external）は、家族の承認がない限り呼ばない。
5. 最後に本人へ一言返す。`,
  tools: [recordObservation, scheduleRecheck, notifyFamily, shareExternal, callOutside],
  beforeToolCallback: ({ tool, args, context }) => {
    ledger.push({ at: now(), kind: 'tool_call', name: tool.name, args });
    const st = (context as unknown as { state?: { toRecord?: () => Record<string, unknown> } }).state;
    const state = st?.toRecord?.() ?? {};

    if (tool.name === 'call_outside') {
      const r = { blocked: true, reason: '本人の依頼による外部連絡は行わない。家族に「頼まれた」と伝える。' };
      ledger.push({ at: now(), kind: 'blocked', name: tool.name, args, result: r });
      return r; // 道具は実行されず、この値が結果として渡る
    }
    if (tool.name === 'share_external' && state['familyApproved'] !== true) {
      const r = { blocked: true, reason: '家族の承認がない。承認画面で確認してから共有する。' };
      ledger.push({ at: now(), kind: 'blocked', name: tool.name, args, result: r });
      return r;
    }
    return undefined; // 通常どおり実行
  },
});
