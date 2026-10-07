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
/**
 * 通知の由来（criteria v2 / report-design v2 2 節。文面の型を選ぶのに使う）
 *  l4_words … L4 の語（転んだ・動けない・息苦しい・助けて 等）  fire … 火事・煙・熱い
 *  pain … 痛みの言葉（L3）  pain_followup … 痛みの聞き直しの結果
 *  no_answer … 連続無反応（L3/L4）  not_done … 再確認しても取れない（L2/L3）
 *  contact … 本人からの外部連絡の依頼  departure … デイへ出発  repeat … 同じ質問の増加（変化評価）
 *  summary … 今日の様子  plan … 今日の声かけ計画  device … 端末の沈黙など運用  other … それ以外
 */
export type NoticeOrigin =
  | 'l4_words' | 'fire' | 'pain' | 'pain_followup' | 'no_answer' | 'not_done' | 'contact'
  | 'departure' | 'repeat' | 'summary' | 'plan' | 'device' | 'other';
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
    /** 1 確認あたりの再確認の上限（criteria 5 節: 初回＋再確認 2 回 = 計 3 回）。あれば recheckOnce より優先 */
    maxRechecks?: number;
    /** 通知を翌朝に回す時間帯（L3/L2）。就寝時間帯（sleepHours）とは別の概念 */
    quietHours?: { from: string; to: string };
    /** 就寝時間帯（criteria 3-3 ★8）。声かけをしない・無反応判定の対象外。既定 21:30〜07:30 */
    sleepHours?: { from: string; to: string };
  };
  /** 通知文に書く連絡先（report-design 2 節）。未設定なら該当の文を省く。住所・持病はここに置かない */
  contacts?: {
    homePhone?: string;
    nearby?: { name: string; phone: string };
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
  /** この一巡で「取れなかった」回数（not_yet / no_answer / unclear。今回を含む）。新しい一巡で 0 に戻る */
  failCount?: number;
  /** 続けて返事が無かった回数（no_answer の連続。返事があれば 0） */
  noAnswerStreak?: number;
  /** 連続無反応の最初の声かけの時刻（通知文の「HH:MM から」） */
  noAnswerSince?: Date;
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
  /** 昨日までとの比較（断定しない）。sections.comparison を 1 つにつないだもの */
  changeNote?: string;
  /**
   * report-design v2 1 節の型の構造（画面が使う）。キーは
   * heading / conclusion / replies（お返事の記録）/ concerns（気になったこと）/
   * continued（お知らせの続き）/ comparison（昨日までとの比較）/ about（この記録について）
   */
  sections?: Record<string, string[]>;
  sentAt?: Date;
}

export interface DaySignals {
  unclearCount: number;
  noAnswerCount: number;
  /** 短時間に同じ質問を繰り返した回数（例: 「何の薬？」） */
  repeatedQuestions: number;
  urgentCount: number;
  /** 家族が「誤報だった」を付けた通知の数（その通知の日付で数える。criteria 4 節） */
  falseAlarmCount?: number;
}

/** L4 モード（criteria 1 節 L4）。立っている間は通常の声かけを止め、3 分ごとに安心文だけを流す */
export interface DayL4 {
  noticeId: NoticeId;
  since: Date;
  task?: TaskKey;
  reason: string;
  /** l4_words / fire / no_answer */
  origin?: NoticeOrigin;
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
  /** L4 モード。家族の「確認した」で null に戻る */
  l4?: DayL4 | null;
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
  /** L4 モードの安心文（質問ではない。状態機械を動かさない） */
  isReassurance?: boolean;
  /** 痛みの聞き直し（criteria 3-2）。状態機械を動かさず、返事は規則で扱う */
  followup?: { noticeId?: NoticeId; reason: string };
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
  classified: {
    status: Classification; note: string; by: 'llm' | 'rules';
    /** 判定の確信度 0〜1（規則は 1.0、unclear は 0.5） */
    confidence?: number;
    /** confidence < 0.7。判定未確定（criteria 2 ★2） */
    uncertain?: boolean;
  };
  /** normal（既定）/ followup（痛みの聞き直しへの返事）/ l4（L4 モード中の返事。判定しない） */
  kind?: 'normal' | 'followup' | 'l4';
  /** kind=followup のとき、聞き直しの元になった通知 */
  followupNoticeId?: NoticeId;
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
  /** deferred にした理由。daily_cap は翌朝に送らず夕方の「お知らせの続き」にまとめる */
  deferredReason?: 'quiet_hours' | 'daily_cap';
  ackedBy?: MemberId;
  /** 家族が「誤報だった」を付けた（criteria 4 節） */
  falseAlarm?: boolean;
  /** 文面の型を選ぶ由来 */
  origin?: NoticeOrigin;
  /** 判定未確定（LLM の確信度 < 0.7）のまま即時に送った */
  uncertain?: boolean;
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
