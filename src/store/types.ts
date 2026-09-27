// 永続化の境目。実装は firestore.ts（本番・dev）と memory.ts（テスト・再生）。
// docs/02 §2 のコレクション構造に対応する。すべてのメソッドは失敗時に throw する。

import type {
  Approval, ApprovalId, Day, DateKey, HealthDay, Heartbeat, Household, HouseholdId,
  LedgerEntry, NoiseSample, Notice, NoticeId, Prompt, PromptId, TaskKey, TaskRecord, Turn, TurnId,
} from '../types.js';

export interface Store {
  // ---- households/{hh} ----
  getHousehold(hh: HouseholdId): Promise<Household | null>;
  putHousehold(h: Household): Promise<void>;
  /** 部分更新（settings, killSwitch など） */
  updateHousehold(hh: HouseholdId, patch: Partial<Household>): Promise<void>;
  listHouseholds(): Promise<Household[]>;

  // ---- households/{hh}/days/{date} ----
  getDay(hh: HouseholdId, date: DateKey): Promise<Day | null>;
  putDay(day: Day): Promise<void>;
  /** tasks[task] を差し替える。日がなければ作らない（先に putDay） */
  setTask(hh: HouseholdId, date: DateKey, task: TaskKey, record: TaskRecord): Promise<void>;
  updateDay(hh: HouseholdId, date: DateKey, patch: Partial<Pick<Day, 'planApproved' | 'summary' | 'signals' | 'plan' | 'isDayservice'>>): Promise<void>;
  /** 直近 N 日（date を含まない、過去向き）。変化評価に使う */
  listRecentDays(hh: HouseholdId, beforeDate: DateKey, count: number): Promise<Day[]>;

  // ---- households/{hh}/days/{date}/prompts/{pr} ----
  putPrompt(p: Prompt): Promise<void>;
  getPrompt(hh: HouseholdId, date: DateKey, id: PromptId): Promise<Prompt | null>;
  updatePrompt(hh: HouseholdId, date: DateKey, id: PromptId, patch: Partial<Prompt>): Promise<void>;
  /** state=queued で scheduledAt <= now のものを時刻順に */
  listDuePrompts(hh: HouseholdId, date: DateKey, now: Date): Promise<Prompt[]>;
  listPrompts(hh: HouseholdId, date: DateKey): Promise<Prompt[]>;

  // ---- households/{hh}/days/{date}/turns/{tn} ----
  putTurn(t: Turn): Promise<void>;
  getTurn(hh: HouseholdId, turnId: TurnId): Promise<Turn | null>;
  listTurns(hh: HouseholdId, date: DateKey): Promise<Turn[]>;

  // ---- households/{hh}/notices/{nt} ----
  putNotice(n: Notice): Promise<void>;
  getNotice(hh: HouseholdId, id: NoticeId): Promise<Notice | null>;
  updateNotice(hh: HouseholdId, id: NoticeId, patch: Partial<Notice>): Promise<void>;
  listNotices(hh: HouseholdId, date: DateKey): Promise<Notice[]>;
  /** state が open/waiting/deferred のもの */
  listOpenNotices(hh: HouseholdId): Promise<Notice[]>;

  // ---- households/{hh}/approvals/{ap} ----
  putApproval(a: Approval): Promise<void>;
  getApproval(hh: HouseholdId, id: ApprovalId): Promise<Approval | null>;
  updateApproval(hh: HouseholdId, id: ApprovalId, patch: Partial<Approval>): Promise<void>;
  listApprovals(hh: HouseholdId, onlyPending?: boolean): Promise<Approval[]>;

  // ---- households/{hh}/ledger/{lg}（追記のみ） ----
  appendLedger(e: LedgerEntry): Promise<void>;
  listLedger(hh: HouseholdId, date: DateKey): Promise<LedgerEntry[]>;

  // ---- households/{hh}/health/{date} ----
  getHealth(hh: HouseholdId, date: DateKey): Promise<HealthDay | null>;
  /** 丸ごと上書き。生存信号と競合しうるので、部分更新は updateHealth を使う */
  putHealth(h: HealthDay): Promise<void>;
  /** 渡した項目だけ差し替える（無ければ作る） */
  updateHealth(hh: HouseholdId, date: DateKey, patch: Partial<Omit<HealthDay, 'hh' | 'date'>>): Promise<void>;
  recordHeartbeat(hb: Heartbeat): Promise<void>;
  recordNoise(sample: NoiseSample): Promise<void>;
  /** 直近 N 分の生活音サンプル */
  listRecentNoise(hh: HouseholdId, since: Date): Promise<NoiseSample[]>;
}

/** Firestore の Timestamp や undefined を Date / 省略に揃えるための共通ヘルパ */
export function toDate(v: unknown): Date | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === 'function') return t.toDate();
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  return undefined;
}
