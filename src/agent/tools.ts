// 会話ターンの 5 つの道具（agent-spike と同じスキーマ）。
// 道具は副作用を持たない。「やりたいこと」を Intent として collector に積むだけで、
// 実際の記録・予約・通知は state/ 層（applyTurnOutcome）が行う（docs/02 §4）。
// collector はターンごとに新しく作るので、道具もターンごとに生成する。

import { FunctionTool, type BaseTool } from '@google/adk';
import { z } from 'zod';
import { TASK_KEYS, TASK_LABELS } from '../types.js';
import type { TaskKey } from '../types.js';
import type { Intent } from '../services.js';
import { excerpt } from './rules.js';

export const TOOL_NAMES = ['record_observation', 'schedule_recheck', 'notify_family', 'share_external', 'call_outside'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** 項目の指定（英語キーか日本語の名前）を TaskKey に直す。分からなければ既定の項目 */
export function toTaskKey(value: string, fallback: TaskKey): TaskKey {
  const v = value.trim();
  if ((TASK_KEYS as readonly string[]).includes(v)) return v as TaskKey;
  const byLabel = TASK_KEYS.find(k => TASK_LABELS[k] === v || v.includes(TASK_LABELS[k]));
  return byLabel ?? fallback;
}

/**
 * @param collector このターンの Intent を積む配列
 * @param currentTask このターンの確認項目（record_observation の task が読めないときの既定）
 */
export function createTools(collector: Intent[], currentTask: TaskKey = 'greeting'): BaseTool[] {
  const recordObservation = new FunctionTool({
    name: 'record_observation',
    description:
      '声かけの結果を記録する。必ず毎ターン1回呼ぶ。status は done(できた) / not_yet(まだ) / no_answer(返事なし) / unclear(本人の発話か分からない・判定できない)。',
    parameters: z.object({
      task: z.string().describe('確認していた項目のキー。例: dress, diaper, medicine'),
      status: z.enum(['done', 'not_yet', 'no_answer', 'unclear']),
      note: z.string().describe('根拠になった本人の言葉を短く。推測は書かない'),
    }),
    execute: ({ task, status, note }) => {
      const key = toTaskKey(task, currentTask);
      collector.push({ type: 'record', task: key, status, note: excerpt(note, 30) }); // 本人の言葉は短い抜粋だけ残す
      return { ok: true, recorded: true, task: key, status };
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
      collector.push({ type: 'recheck', minutes, reason: reason.slice(0, 80) });
      return { ok: true, scheduled: true, minutes };
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
      collector.push({ type: 'notify', level, reason: reason.slice(0, 120), evidence: excerpt(evidence, 40) });
      return { ok: true, notified: true, level };
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
      collector.push({ type: 'share_external', recipient, summary: summary.slice(0, 400) });
      return { ok: true, shared: true, recipient };
    },
  });

  // beforeToolCallback で常に止めるので execute は呼ばれない。万一呼ばれても何もしない
  const callOutside = new FunctionTool({
    name: 'call_outside',
    description: '本人に頼まれて外部（家族以外）に電話やメッセージを送る。',
    parameters: z.object({ who: z.string(), message: z.string() }),
    execute: ({ who }) => {
      collector.push({ type: 'blocked', tool: 'call_outside', args: { who }, reason: '本人の依頼による外部連絡は行わない' });
      return { ok: false, blocked: true };
    },
  });

  return [recordObservation, scheduleRecheck, notifyFamily, shareExternal, callOutside];
}
