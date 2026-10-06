// 部品同士の境目（インターフェース）。実装は各フォルダ。
//   agent/   → TurnRunner
//   state/   → applyTurnOutcome, plan, summary（関数。ここには型だけ）
//   notify/  → Notifier（LINE/Slack/メールの送信）, FamilyNotify（通知の作成・段階上げ）
//   tasks/   → TaskScheduler（Cloud Tasks か inline）
//   tts.ts   → Tts
// AppContext は index.ts で 1 回組み立て、各ルートと内部処理に渡す。

import type { Store } from './store/types.js';
import type { Clock } from './time.js';
import type {
  Channel, Classification, DateKey, Day, Expression, Household, HouseholdId, Member,
  Notice, NoticeLevel, Prompt, ReplySource, TaskKey, ToolCallRecord, TurnId,
} from './types.js';

// ---------------------------------------------------------------------------
// 会話ターン（agent/）
// ---------------------------------------------------------------------------

export interface TurnInput {
  household: Household;
  day: Day;
  prompt: Prompt;
  /** null は返事なし（無反応）。文字起こしの結果はそのまま渡す */
  replyText: string | null;
  source: ReplySource;
  now: Date;
  /** この項目でまだ再確認を予約できるか（policy.recheckOnce と recheckCount から state/ が決める） */
  recheckAllowed: boolean;
  /** 家族の承認がある外部共有（approvals に approved がある）か */
  familyApprovedShare: boolean;
  /** 直前までの同じ日の会話（短い文脈。繰り返し質問の検知に使う。最大 5 件程度） */
  recentTurns: Array<{ task: TaskKey; replyText: string | null; status: Classification; at: Date }>;
}

/** エージェントが「やりたい」と決めた副作用。実際の実行は state/applyTurnOutcome が行う */
export type Intent =
  | { type: 'record'; task: TaskKey; status: Classification; note: string }
  | { type: 'recheck'; minutes: number; reason: string }
  | { type: 'notify'; level: NoticeLevel; reason: string; evidence: string }
  | { type: 'share_external'; recipient: 'doctor' | 'care_manager'; summary: string }
  | { type: 'blocked'; tool: string; args: Record<string, unknown>; reason: string };

export interface TurnOutcome {
  classified: { status: Classification; note: string; by: 'llm' | 'rules' };
  /** 本人へ返す一言（2 文まで） */
  say: string;
  expression: Expression;
  toolCalls: ToolCallRecord[];
  intents: Intent[];
  latencyMs: number;
  /** LLM が落ちて規則で代替したときなど */
  degraded?: { reason: string };
}

export interface TurnRunner {
  run(input: TurnInput): Promise<TurnOutcome>;
}

// ---------------------------------------------------------------------------
// 通知（notify/）
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  title: string;
  body: string;
  /** LINE の「確認した」ボタン用。postback に載せる */
  noticeId?: string;
  /** 家族画面で開く URL（あれば） */
  url?: string;
}

export interface SendResult { ok: boolean; error?: string }

/** 送信チャネルの薄い層。未設定のチャネルは ok:false, error:'not_configured' を返す */
export interface Notifier {
  send(member: Member, channel: Channel, msg: OutboundMessage): Promise<SendResult>;
  /** 運用エージェントの報告先（Slack Webhook）。未設定なら何もしない */
  sendOps(text: string): Promise<SendResult>;
  /** この家族に使える順番のチャネル（line → email） */
  channelsFor(member: Member): Channel[];
}

export interface NotifyRequest {
  hh: HouseholdId;
  date: DateKey;
  level: NoticeLevel;
  reason: string;
  evidence: string;
  turnId: TurnId | null;
  task?: TaskKey;
  now: Date;
}

/** 通知の作成・送信・段階上げ（docs/02 §4 notify_family, §5 段階上げ） */
export interface FamilyNotify {
  /** notices を作り、順番 1 の家族に送り、waitMinutes 後の /internal/escalate を予約する。
   *  check/info は静かな時間帯なら deferred にして翌朝へ。urgent は即時。 */
  notify(req: NotifyRequest): Promise<Notice>;
  /** 「確認した」 */
  ack(hh: HouseholdId, noticeId: string, memberId: string, now: Date): Promise<Notice | null>;
  /** Tasks から呼ばれる段階上げ。未確認なら次の順番へ。全員未確認ならメールで全員へ再送し escalated */
  escalate(hh: HouseholdId, noticeId: string, now: Date): Promise<Notice | null>;
  /** 静かな時間帯明けに deferred を送る（/internal/plan の朝に呼ぶ） */
  flushDeferred(hh: HouseholdId, now: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// 時刻の予約（tasks/）
// ---------------------------------------------------------------------------

export type InternalPath = '/internal/prompt' | '/internal/recheck' | '/internal/escalate' | '/internal/summary' | '/internal/health' | '/internal/plan';

export interface ScheduledTask { id: string; path: InternalPath; runAt: Date }

export interface TaskScheduler {
  /** runAt に自分の path を POST する。cloud なら Cloud Tasks、inline なら setTimeout で自分に HTTP */
  schedule(path: InternalPath, body: Record<string, unknown>, runAt: Date): Promise<ScheduledTask>;
}

// ---------------------------------------------------------------------------
// 音声合成（tts.ts）
// ---------------------------------------------------------------------------

export interface TtsResult {
  /** data:audio/mp3;base64,... か署名 URL。undefined なら端末側の読み上げに任せる */
  url?: string;
  /** cloud を試して落ちた → device に代替した、など */
  fallback?: 'device';
  incident?: 'tts_timeout' | 'tts_error';
}

export interface Tts {
  synthesize(text: string): Promise<TtsResult>;
}

// ---------------------------------------------------------------------------
// アプリ全体の文脈
// ---------------------------------------------------------------------------

export interface AppContext {
  store: Store;
  clock: Clock;
  turnRunner: TurnRunner;
  notifier: Notifier;
  familyNotify: FamilyNotify;
  tasks: TaskScheduler;
  tts: Tts;
}
