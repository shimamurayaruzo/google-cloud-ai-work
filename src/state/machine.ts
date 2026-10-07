// 確認項目 1 つの状態機械（docs/02 §5、docs/criteria.md v2 3-1・3-3・5 節）。副作用のない純粋関数だけを置く。
//
//   pending ──声かけ──▶ asked ──done──▶ done
//                        └─not_yet / no_answer / unclear ──▶ rechecking（再確認できるとき）
//                                                              ├─done ──▶ done
//                                                              └─取れない（最後の声かけ）──▶ escalated
//   どこからでも killSwitch ──▶ suspended
//
// 段階表（n = その一巡で「取れなかった」回数、今回を含む。初回＋再確認 2 回 = 計 3 回が既定）:
//   not_yet / unclear : n=1 → rechecking（通知なし）／ n=2 → rechecking ＋ L2 info「○○がまだのようです」
//                       n=3（最後）→ escalated ＋ L3 check「○○を確認してください」
//   no_answer（連続）  : 1 回目 → rechecking ／ 2 回目 → rechecking ＋ L3 check「HH:MM から 2 回の声かけに返事がありません…」
//                       3 回目 → escalated ＋ L4 urgent（turn.ts が L4 モードを立てる）
//   PlanItem.escalate === false … 取れなくても通知しない（記録と夕方の要約だけ）。最後は asked のまま
//   PlanItem.recheckMinutes === 0 … 「1 回のみ」。再確認せず n=1 で asked のまま終わる
//   最後の声かけ（再確認の上限に達した）が n<3 のとき（recheckOnce の世帯など）は L3 check で終える
// 同じ項目の escalated の通知は一日 1 回だけ（escalatedAt）。

import { hm } from '../time.js';
import { TASK_LABELS } from '../types.js';
import type {
  Classification, Household, NoticeLevel, NoticeOrigin, PromptId, TaskKey, TaskRecord, TurnId,
} from '../types.js';
import { maxRechecksOf } from './plan.js';

export type MachineEvent =
  | {
      type: 'asked';
      promptId: PromptId;
      at: Date;
      /** 再確認の声かけか（省略時 false） */
      isRecheck?: boolean;
    }
  | {
      type: 'classified';
      status: Classification;
      at: Date;
      evidence?: string;
      turnId: TurnId;
      /** この項目でまだ再確認を予約できるか（canRecheck から決める） */
      recheckAllowed: boolean;
      /** 取れないときに家族へ知らせてよいか（PlanItem.escalate。省略時 true） */
      escalateAllowed?: boolean;
      /** 計画の「1 回のみ」（PlanItem.recheckMinutes === 0）。再確認も通知もせず asked のまま */
      oneShot?: boolean;
      /** 声かけを話した時刻（連続無反応の「HH:MM から」に使う。省略時 at） */
      promptedAt?: Date;
      /** 項目（通知文の「○○」に使う。省略時は文言なし） */
      task?: TaskKey;
    }
  | { type: 'suspend'; at?: Date };

/** 段階表が決めた家族への通知 */
export interface StageNotice {
  level: NoticeLevel;
  reason: string;
  origin: NoticeOrigin;
  /** 段階の名前（台帳・テスト用） */
  stage: 'not_yet_info' | 'not_done_check' | 'no_answer_check' | 'no_answer_urgent';
}

export interface TransitionResult {
  next: TaskRecord;
  notify?: StageNotice;
  /** 最後の声かけで取れなかった（escalated に入った、または通知しない項目で終わった） */
  final?: boolean;
}

export function emptyRecord(): TaskRecord {
  return { state: 'pending', recheckCount: 0, failCount: 0, promptIds: [] };
}

function labelOf(task: TaskKey | undefined): string {
  return task ? TASK_LABELS[task] : 'この確認';
}

function intermediateNotice(status: Classification, n: number, streak: number, task: TaskKey | undefined, since: Date | undefined): StageNotice | undefined {
  if (status === 'no_answer' && streak === 2) return noAnswerCheck(since);
  if (n === 2) return { level: 'info', reason: `${labelOf(task)}がまだのようです`, origin: 'not_done', stage: 'not_yet_info' };
  return undefined;
}

function finalNotice(status: Classification, streak: number, task: TaskKey | undefined, since: Date | undefined): StageNotice {
  if (status === 'no_answer' && streak >= 3) {
    return {
      level: 'urgent', origin: 'no_answer', stage: 'no_answer_urgent',
      reason: `${since ? `${hm(since)} から ` : ''}${streak} 回の声かけに、お返事がありません`,
    };
  }
  if (status === 'no_answer' && streak === 2) return noAnswerCheck(since);
  return { level: 'check', reason: `${labelOf(task)}を確認してください`, origin: 'not_done', stage: 'not_done_check' };
}

function noAnswerCheck(since: Date | undefined): StageNotice {
  return {
    level: 'check', origin: 'no_answer', stage: 'no_answer_check',
    reason: `${since ? `${hm(since)} から ` : ''}2 回の声かけに返事がありません。家の電話にかけてみてください。話せたら『確認した』を押してください`,
  };
}

/** 一巡の数え（failCount・連続無反応）を消した記録 */
function resetRound(r: TaskRecord): TaskRecord {
  const { noAnswerSince: _s, ...rest } = r;
  return { ...rest, failCount: 0, noAnswerStreak: 0 };
}

export function transition(record: TaskRecord | undefined, event: MachineEvent): TransitionResult {
  const base: TaskRecord = record
    ? { ...record, promptIds: [...record.promptIds] }
    : emptyRecord();

  switch (event.type) {
    case 'suspend':
      return { next: { ...base, state: 'suspended' } };

    case 'asked': {
      const promptIds = base.promptIds.includes(event.promptId) ? base.promptIds : [...base.promptIds, event.promptId];
      // 再確認の声かけを話している間は rechecking のまま
      if (base.state === 'rechecking' && event.isRecheck) {
        return { next: { ...base, promptIds } };
      }
      // 済んだ・家族へ上げた項目に新しい声かけ（例: 水分の 2 回目）→ 新しい一巡。escalatedAt は残す
      if ((base.state === 'done' || base.state === 'escalated') && !event.isRecheck) {
        return { next: { ...resetRound(base), state: 'asked', recheckCount: 0, promptIds } };
      }
      // 「1 回のみ」の項目に次の声かけ（asked のまま終わった一巡）も新しい一巡
      if (base.state === 'asked' && !event.isRecheck && (base.failCount ?? 0) > 0) {
        return { next: { ...resetRound(base), state: 'asked', recheckCount: 0, promptIds } };
      }
      return { next: { ...base, state: 'asked', promptIds } };
    }

    case 'classified': {
      const next: TaskRecord = {
        ...base,
        status: event.status,
        at: event.at,
        evidence: event.evidence ?? base.evidence,
        lastTurnId: event.turnId,
      };
      if (event.status === 'done') {
        const { noAnswerSince: _s, ...rest } = next;
        return { next: { ...rest, state: 'done', noAnswerStreak: 0 } };
      }
      // 既に家族へ上げた項目は、同じ一巡の中で重ねて上げない
      if (base.state === 'escalated') {
        return { next: { ...next, state: 'escalated' } };
      }

      const n = (base.failCount ?? 0) + 1;
      const streak = event.status === 'no_answer' ? (base.noAnswerStreak ?? 0) + 1 : 0;
      const counted: TaskRecord = { ...next, failCount: n, noAnswerStreak: streak };
      if (event.status === 'no_answer') {
        counted.noAnswerSince = streak === 1 ? (event.promptedAt ?? event.at) : (base.noAnswerSince ?? event.promptedAt ?? event.at);
      } else {
        delete counted.noAnswerSince;
      }
      const since = counted.noAnswerSince;

      if (event.oneShot) return { next: { ...counted, state: 'asked' }, final: true };
      const escalateAllowed = event.escalateAllowed !== false;
      // 3 回続けて返事が無ければ、残りの再確認があっても最後とする（criteria 3-3 ★7）
      const forceFinal = event.status === 'no_answer' && streak >= 3;

      if (event.recheckAllowed && !forceFinal) {
        const notify = escalateAllowed ? intermediateNotice(event.status, n, streak, event.task, since) : undefined;
        return {
          next: { ...counted, state: 'rechecking', recheckCount: base.recheckCount + 1 },
          ...(notify ? { notify } : {}),
        };
      }
      if (!escalateAllowed) {
        return { next: { ...counted, state: 'asked' }, final: true };
      }
      // 同じ項目で escalated の通知は一日 1 回だけ
      const first = !base.escalatedAt;
      const notify = first ? finalNotice(event.status, streak, event.task, since) : undefined;
      return {
        next: { ...counted, state: 'escalated', escalatedAt: base.escalatedAt ?? event.at },
        ...(notify ? { notify } : {}),
        final: true,
      };
    }
  }
}

/** まだ再確認を予約できるか。policy.maxRechecks（既定 2）→ 無ければ recheckOnce なら 1 回、そうでなければ 2 回 */
export function canRecheck(household: Household, record: TaskRecord | undefined): boolean {
  const n = record?.recheckCount ?? 0;
  return n < maxRechecksOf(household);
}
