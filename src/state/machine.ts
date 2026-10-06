// 確認項目 1 つの状態機械（docs/02 §5）。副作用のない純粋関数だけを置く。
//
//   pending ──声かけ──▶ asked ──done──▶ done
//                        └─not_yet / no_answer / unclear ──▶ rechecking（再確認できるとき）
//                                                              ├─done ──▶ done
//                                                              └─取れない ──▶ escalated（家族へ check。一日 1 回だけ）
//   どこからでも killSwitch ──▶ suspended
//
// 計画で「家族へ上げない」（PlanItem.escalate=false）項目は、取れなくても escalated にせず asked のまま残す
// （status に最後の分類が入るので、夕方の要約に「未確認」として載る）。

import type { Classification, Household, PromptId, TaskRecord, TurnId } from '../types.js';

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
      /** この項目でまだ再確認を予約できるか（canRecheck と計画の「1回のみ」から決める） */
      recheckAllowed: boolean;
      /** 取れないときに家族へ上げてよいか（PlanItem.escalate。省略時 true） */
      escalateAllowed?: boolean;
    }
  | { type: 'suspend'; at?: Date };

export function emptyRecord(): TaskRecord {
  return { state: 'pending', recheckCount: 0, promptIds: [] };
}

export function transition(record: TaskRecord | undefined, event: MachineEvent): { next: TaskRecord; escalate: boolean } {
  const base: TaskRecord = record
    ? { ...record, promptIds: [...record.promptIds] }
    : emptyRecord();

  switch (event.type) {
    case 'suspend':
      return { next: { ...base, state: 'suspended' }, escalate: false };

    case 'asked': {
      const promptIds = base.promptIds.includes(event.promptId) ? base.promptIds : [...base.promptIds, event.promptId];
      // 再確認の声かけを話している間は rechecking のまま
      if (base.state === 'rechecking' && event.isRecheck) {
        return { next: { ...base, promptIds }, escalate: false };
      }
      // 済んだ・家族へ上げた項目に新しい声かけ（例: 水分の 2 回目）→ 新しい一巡。escalatedAt は残す
      if ((base.state === 'done' || base.state === 'escalated') && !event.isRecheck) {
        return { next: { ...base, state: 'asked', recheckCount: 0, promptIds }, escalate: false };
      }
      return { next: { ...base, state: 'asked', promptIds }, escalate: false };
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
        return { next: { ...next, state: 'done' }, escalate: false };
      }
      // 既に家族へ上げた項目は、同じ一巡の中で重ねて上げない
      if (base.state === 'escalated') {
        return { next: { ...next, state: 'escalated' }, escalate: false };
      }
      if (event.recheckAllowed) {
        return { next: { ...next, state: 'rechecking', recheckCount: base.recheckCount + 1 }, escalate: false };
      }
      if (event.escalateAllowed === false) {
        return { next: { ...next, state: 'asked' }, escalate: false };
      }
      // 同じ項目で escalate は一日 1 回だけ
      const first = !base.escalatedAt;
      return {
        next: { ...next, state: 'escalated', escalatedAt: base.escalatedAt ?? event.at },
        escalate: first,
      };
    }
  }
}

/** まだ再確認を予約できるか。policy.recheckOnce なら 1 回まで、そうでなければ 2 回まで */
export function canRecheck(household: Household, record: TaskRecord | undefined): boolean {
  const n = record?.recheckCount ?? 0;
  return household.policy.recheckOnce ? n < 1 : n < 2;
}
