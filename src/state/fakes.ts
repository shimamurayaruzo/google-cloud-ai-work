// テストと再生モード（scripts/replay.ts）で使うフェイク。外へは何も送らず、呼ばれた内容をメモリに記録するだけ。
// 本番の部品（notify/ tasks/ tts.ts agent/）には依存しない。

import type {
  AppContext, FamilyNotify, Intent, Notifier, NotifyRequest, OutboundMessage, ScheduledTask, SendResult,
  TaskScheduler, Tts, TtsResult, TurnInput, TurnOutcome, TurnRunner, InternalPath,
} from '../services.js';
import type { Store } from '../store/types.js';
import { MemoryStore } from '../store/memory.js';
import { systemClock, type Clock } from '../time.js';
import { newId, type Channel, type Classification, type Expression, type Member, type Notice } from '../types.js';
import { appendLedger } from './ledger.js';

/** 家族への通知: notices を store に作り、台帳 notice_sent を書く（本物と同じ）。送信はしない */
export class FakeFamilyNotify implements FamilyNotify {
  readonly calls: NotifyRequest[] = [];
  constructor(private store: Store) {}

  async notify(req: NotifyRequest): Promise<Notice> {
    this.calls.push(req);
    const notice: Notice = {
      id: newId('nt'), hh: req.hh, date: req.date, level: req.level, reason: req.reason, evidence: req.evidence,
      turnId: req.turnId, task: req.task, steps: [], state: 'open', createdAt: req.now,
    };
    await this.store.putNotice(notice);
    await appendLedger({ store: this.store }, {
      hh: req.hh, date: req.date, at: req.now, kind: 'notice', name: 'notice_sent', noticeId: notice.id,
      turnId: req.turnId, args: { level: req.level, reason: req.reason },
    });
    return notice;
  }
  async ack(hh: string, noticeId: string, memberId: string, now: Date): Promise<Notice | null> {
    const n = await this.store.getNotice(hh, noticeId);
    if (!n) return null;
    await this.store.updateNotice(hh, noticeId, { state: 'acked', ackedBy: memberId });
    void now;
    return { ...n, state: 'acked', ackedBy: memberId };
  }
  async escalate(hh: string, noticeId: string, _now: Date): Promise<Notice | null> {
    const n = await this.store.getNotice(hh, noticeId);
    if (!n) return null;
    await this.store.updateNotice(hh, noticeId, { state: 'escalated' });
    return { ...n, state: 'escalated' };
  }
  async flushDeferred(_hh: string, _now: Date): Promise<number> {
    return 0;
  }
}

/** 時刻の予約: 予約内容を並べて持つだけ（実行はしない） */
export class FakeTaskScheduler implements TaskScheduler {
  readonly scheduled: Array<{ path: InternalPath; body: Record<string, unknown>; runAt: Date }> = [];
  async schedule(path: InternalPath, body: Record<string, unknown>, runAt: Date): Promise<ScheduledTask> {
    this.scheduled.push({ path, body, runAt });
    return { id: `task_${this.scheduled.length}`, path, runAt };
  }
}

/** 音声合成: 端末の読み上げに任せる（url なし） */
export class FakeTts implements Tts {
  readonly texts: string[] = [];
  constructor(private result: TtsResult = {}) {}
  async synthesize(text: string): Promise<TtsResult> {
    this.texts.push(text);
    return this.result;
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: Array<{ memberId: string; channel: Channel; msg: OutboundMessage }> = [];
  readonly ops: string[] = [];
  async send(member: Member, channel: Channel, msg: OutboundMessage): Promise<SendResult> {
    this.sent.push({ memberId: member.id, channel, msg });
    return { ok: true };
  }
  async sendOps(text: string): Promise<SendResult> {
    this.ops.push(text);
    return { ok: true };
  }
  channelsFor(member: Member): Channel[] {
    return [member.line ? 'line' : null, member.email ? 'email' : null].filter((c): c is Channel => c != null);
  }
}

/**
 * キーワードだけで分類する小さな TurnRunner（LLM を使わない再生・テスト用）。
 * 本番の規則（agent/ の rules）とは別物。台本が期待どおりに流れるかの確認に使う。
 */
export class KeywordTurnRunner implements TurnRunner {
  readonly calls: TurnInput[] = [];

  async run(input: TurnInput): Promise<TurnOutcome> {
    this.calls.push(input);
    const text = input.replyText?.trim() ?? '';
    const task = input.prompt.task;
    const intents: Intent[] = [];

    if (input.household.killSwitch) {
      return {
        classified: { status: 'unclear', note: '停止中', by: 'rules' },
        say: '少し休みますね。', expression: 'smile', toolCalls: [], latencyMs: 0,
        intents: [{ type: 'blocked', tool: 'record_observation', args: { task }, reason: 'kill_switch' }],
      };
    }

    let status: Classification;
    if (input.replyText == null || text === '') status = 'no_answer';
    else if (/^[（(]/.test(text) || /テレビ|ニュース/.test(text)) status = 'unclear';
    else if (/まだ|あとで|後で|これから|してない|していない/.test(text)) status = 'not_yet';
    else if (/[？?]$/.test(text)) status = 'not_yet';
    else status = 'done';

    const w = input.household.person.wording;
    let say: string;
    let expression: Expression = 'smile';
    if (/何の薬|なんの薬/.test(text)) say = `${w.medicine ?? 'お薬'}ですよ。${w.medicinePlace ?? ''}にありますよ。`;
    else if (/どこ/.test(text) && task === 'medicine') say = `${w.medicinePlace ?? ''}にありますよ。`;
    else if (status === 'done') say = 'よかったです。';
    else if (status === 'not_yet') { say = 'わかりました。また少ししたら声をかけますね。'; expression = 'listen'; }
    else if (status === 'unclear') { say = 'ごめんなさい、もう一度聞かせてくださいね。'; expression = 'think'; }
    else { say = 'また声をかけますね。'; expression = 'listen'; }

    intents.push({ type: 'record', task, status, note: `keyword:${status}` });
    if (status !== 'done' && input.recheckAllowed) {
      intents.push({ type: 'recheck', minutes: input.household.policy.recheckMinutes, reason: status });
    }
    if (/痛い|転んだ|助けて|苦しい/.test(text)) {
      intents.push({ type: 'notify', level: 'urgent', reason: '痛みなどの訴え', evidence: `「${text.slice(0, 30)}」` });
      expression = 'worry';
    }
    if (task === 'pickup' && status === 'done') {
      intents.push({ type: 'notify', level: 'info', reason: '準備完了、出発', evidence: `「${text.slice(0, 30)}」` });
    }
    if (/電話して|電話をかけて/.test(text)) {
      intents.push({ type: 'blocked', tool: 'call_outside', args: {}, reason: 'never_allowed' });
      intents.push({ type: 'notify', level: 'check', reason: '電話を頼まれました', evidence: `「${text.slice(0, 30)}」` });
    }

    return {
      classified: { status, note: `keyword:${status}`, by: 'rules' },
      say, expression, toolCalls: [], intents, latencyMs: 0,
    };
  }
}

export interface FakeContext {
  ctx: AppContext;
  store: Store;
  familyNotify: FakeFamilyNotify;
  tasks: FakeTaskScheduler;
  tts: FakeTts;
  notifier: FakeNotifier;
}

/** フェイクで AppContext を組む。store と turnRunner は差し替えられる */
export function createFakeContext(opts: { store?: Store; turnRunner?: TurnRunner; clock?: Clock } = {}): FakeContext {
  const store = opts.store ?? new MemoryStore();
  const familyNotify = new FakeFamilyNotify(store);
  const tasks = new FakeTaskScheduler();
  const tts = new FakeTts();
  const notifier = new FakeNotifier();
  const ctx: AppContext = {
    store,
    clock: opts.clock ?? systemClock,
    turnRunner: opts.turnRunner ?? new KeywordTurnRunner(),
    notifier,
    familyNotify,
    tasks,
    tts,
  };
  return { ctx, store, familyNotify, tasks, tts, notifier };
}
