// ドメインの型。docs/02_設計書.md §1〜§7 と 1 対 1 で対応させる。
// この文書を変えるときは docs/02 を先に直す。

import type { Weekday } from './time.js';

// ---- ID ----
export type HouseholdId = string;   // hh_xxxx
export type MemberId = string;      // mem_xxxx
export type DateKey = string;       // YYYY-MM-DD（JST）
export type PromptId = string;      // pr_xxxx
export type TurnId = string;        // tn_xxxx
export type NoticeId = string;      // nt_xxxx
export type ApprovalId = string;    // ap_xxxx
export type LedgerId = string;      // lg_xxxx

// ---- 確認項目 ----
export const TASK_KEYS = [
  'greeting', 'diaper', 'teeth', 'face', 'dress', 'belongings', 'pickup',
  'lunch', 'water', 'return', 'dinner', 'medicine', 'bedtime',
] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

export const TASK_LABELS: Record<TaskKey, string> = {
  greeting: '起床の挨拶', diaper: 'おむつ交換', teeth: '歯磨き', face: '洗顔', dress: '着替え',
  belongings: '持ち物', pickup: 'お迎え', lunch: '昼食', water: '水分', return: '帰宅',
  dinner: '夕食', medicine: '服薬', bedtime: '就寝準備',
};

/** 本人の返事の分類（LLM または規則が決める） */
export type Classification = 'done' | 'not_yet' | 'no_answer' | 'unclear';

/** 確認項目 1 つの状態機械（docs/02 §5） */
export type TaskState = 'pending' | 'asked' | 'rechecking' | 'done' | 'escalated' | 'suspended';

export type ReplySource = 'ipad' | 'replay' | 'test';
export type Expression = 'smile' | 'listen' | 'think' | 'worry';
export type NoticeLevel = 'urgent' | 'check' | 'info';
export type Channel = 'line' | 'email' | 'slack';

// ---- 世帯 ----
export interface Member {
  id: MemberId;
  name: string;
  /** 通知の順番。1 が最初 */
  order: number;
  line?: { userId: string };
  email?: string;
  /** この人が「確認した」を押さないまま何分で次の人へ */
  waitMinutes: number;
}

export interface PlanItem {
  /** "HH:MM" JST */
  time: string;
  task: TaskKey;
  /** 声かけの文言（省略時は task の既定文） */
  text?: string;
  /** 再確認までの分。省略時は policy.recheckMinutes */
  recheckMinutes?: number;
  /** 再確認しても取れなかったら家族へ（false なら夕方の要約にだけ載せる） */
  escalate?: boolean;
}

export interface Household {
  id: HouseholdId;
  name: string;
  timezone: 'Asia/Tokyo';
  person: {
    callName: string;
    /** 呼び方の決まり。プロンプトにそのまま埋める */
    wording: Record<string, string>;
  };
  members: Member[];
  plan: {
    weekday: { default: PlanItem[]; dayservice: PlanItem[] };
    dayserviceDays: Weekday[];
    /** デイのお迎え時刻 "HH:MM"。再確認の逆算に使う */
    pickupTime?: string;
  };
  policy: {
    recheckOnce: boolean;
    recheckMinutes: number;
    quietHours?: { from: string; to: string };
  };
  killSwitch: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// ---- 日 ----
export interface TaskRecord {
  state: TaskState;
  /** 直近の分類 */
  status?: Classification;
  at?: Date;
  /** 要約に引用する短い抜粋（本人の言葉。推測は書かない） */
  evidence?: string;
  recheckCount: number;
  promptIds: PromptId[];
  lastTurnId?: TurnId;
  /** 家族へ段階を上げた時刻。同じ項目で escalate は一日 1 回だけにするための印（state/machine.ts） */
  escalatedAt?: Date;
}

export interface Citation { sentenceIndex: number; turnId: TurnId }

export interface DaySummary {
  text: string;
  sentences: string[];
  citations: Citation[];
  /** 直近 3 日との比較コメント（断定しない） */
  changeNote?: string;
  sentAt?: Date;
}

export interface DaySignals {
  unclearCount: number;
  noAnswerCount: number;
  /** 短時間に同じ質問を繰り返した回数（例: 「何の薬？」） */
  repeatedQuestions: number;
  urgentCount: number;
}

export interface Day {
  hh: HouseholdId;
  date: DateKey;
  isDayservice: boolean;
  /** その日の声かけ計画（雛形から確定したもの。家族が承認後は固定） */
  plan: PlanItem[];
  planApproved: { by: string; at: Date } | null;
  tasks: Partial<Record<TaskKey, TaskRecord>>;
  summary: DaySummary | null;
  signals: DaySignals;
  createdAt?: Date;
  updatedAt?: Date;
}

// ---- 声かけとターン ----
export interface Prompt {
  id: PromptId;
  hh: HouseholdId;
  date: DateKey;
  task: TaskKey;
  text: string;
  /** 話す予定時刻 */
  scheduledAt: Date;
  /** true なら再確認の声かけ */
  isRecheck: boolean;
  state: 'queued' | 'delivered' | 'answered' | 'expired';
  deliveredAt?: Date;
  expression: Expression;
  ttsUrl?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  blocked: boolean;
  reason?: string;
}

export interface Turn {
  id: TurnId;
  hh: HouseholdId;
  date: DateKey;
  promptId: PromptId;
  task: TaskKey;
  promptedAt: Date;
  promptText: string;
  replyText: string | null;
  replySource: ReplySource;
  repliedAt: Date;
  classified: { status: Classification; note: string; by: 'llm' | 'rules' };
  toolCalls: ToolCallRecord[];
  /** 本人へ返した一言 */
  say: string;
  expression: Expression;
  latencyMs: number;
  /** Firestore の TTL で消す時刻（repliedAt + 7 日）。replyText を長く残さないため */
  expiresAt?: Date;
}

// ---- 通知 ----
export interface NoticeStep {
  memberId: MemberId;
  channel: Channel;
  sentAt: Date;
  ackedAt: Date | null;
  /** 送信に失敗したとき */
  error?: string;
}

export interface Notice {
  id: NoticeId;
  hh: HouseholdId;
  date: DateKey;
  level: NoticeLevel;
  reason: string;
  evidence: string;
  turnId: TurnId | null;
  task?: TaskKey;
  steps: NoticeStep[];
  state: 'open' | 'waiting' | 'acked' | 'escalated' | 'closed' | 'deferred';
  createdAt: Date;
  /** 静かな時間帯で翌朝に回したとき */
  deferredUntil?: Date;
  ackedBy?: MemberId;
}

// ---- 承認 ----
export interface Approval {
  id: ApprovalId;
  hh: HouseholdId;
  kind: 'share_external' | 'settings_change';
  payload: Record<string, unknown>;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decision: 'approved' | 'rejected' | null;
  /** 一文だけ直して承認したとき */
  editedPayload?: Record<string, unknown>;
}

// ---- 台帳（追記のみ） ----
export type LedgerKind =
  | 'prompt' | 'tool_call' | 'tool_result' | 'blocked' | 'notice' | 'approval' | 'summary' | 'health' | 'plan' | 'system';

export interface LedgerEntry {
  id: LedgerId;
  hh: HouseholdId;
  date: DateKey;
  at: Date;
  actor: 'agent' | 'ops' | `member:${string}` | 'system';
  kind: LedgerKind;
  /** docs/02 §6 のイベント名 */
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  turnId?: TurnId | null;
  noticeId?: NoticeId | null;
}

// ---- 運用（自己復旧） ----
export type IncidentKind = 'tts_timeout' | 'llm_error' | 'device_silent' | 'notify_error' | 'tts_error';
export type IncidentAction = 'retry' | 'fallback' | 'notify';

export interface Incident {
  at: Date;
  kind: IncidentKind;
  action: IncidentAction;
  detail?: string;
  resolvedAt: Date | null;
}

export interface HealthDay {
  hh: HouseholdId;
  date: DateKey;
  lastHeartbeatAt: Date | null;
  heartbeatLostNotifiedAt?: Date | null;
  incidents: Incident[];
  lastCheckAt?: Date;
  /** 生存信号が途絶えたと運用エージェントが判定した時刻。復旧したら null（health_recovered の判定に使う） */
  heartbeatLostSince?: Date | null;
  /** 運用エージェントが切り替えた代替（docs/02 §7）。until を過ぎたら無効。state/ はこれを見て TTS・LLM を切り替える */
  degraded?: DegradedMode | null;
}

/** 代替モード。tts:'device' は端末の読み上げ、llm:'rules' は規則で分類（unclear にして再確認へ） */
export interface DegradedMode {
  tts?: 'device';
  llm?: 'rules';
  until: Date;
}

// ---- 端末の生存信号・生活音 ----
export interface Heartbeat { hh: HouseholdId; at: Date; batteryPct?: number; appVersion?: string }
export interface NoiseSample { hh: HouseholdId; at: Date; rms: number }

// ---- 再生モードの台本（docs/02 §9） ----
export interface ScenarioTurn {
  /** "HH:MM" */
  at: string;
  task: TaskKey;
  /** null は返事なし */
  reply: string | null;
  /** 杉浦さんの基準の期待値 */
  expect?: { status: Classification; notify?: NoticeLevel };
}
export interface Scenario {
  name?: string;
  date: DateKey;
  isDayservice: boolean;
  turns: ScenarioTurn[];
}

// ---- ID 生成 ----
export function newId(prefix: 'hh' | 'mem' | 'pr' | 'tn' | 'nt' | 'ap' | 'lg'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36);
  return `${prefix}_${t}${rand}`;
}
