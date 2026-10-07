// notify / ops / tasks のテスト用の最小フェイク（ネットワーク・Firestore を使わない）。
// 他担当の MemoryStore に依存しないよう、使うメソッドだけを実装して Store として渡す。

import type { Store } from '../src/store/types.js';
import type {
  InternalPath, Notifier, OutboundMessage, ScheduledTask, SendResult, TaskScheduler,
} from '../src/services.js';
import type {
  Channel, Day, HealthDay, Household, LedgerEntry, Member, Notice,
} from '../src/types.js';

export class FakeStore {
  households = new Map<string, Household>();
  notices = new Map<string, Notice>();
  ledger: LedgerEntry[] = [];
  health = new Map<string, HealthDay>();
  days = new Map<string, Day>();

  async getDay(hh: string, date: string) { return structuredClone(this.days.get(`${hh}/${date}`) ?? null); }
  async updateDay(hh: string, date: string, patch: Partial<Day>) {
    const cur = this.days.get(`${hh}/${date}`);
    if (!cur) throw new Error(`day not found: ${hh}/${date}`);
    this.days.set(`${hh}/${date}`, { ...cur, ...structuredClone(patch) });
  }

  async getHousehold(hh: string) { return structuredClone(this.households.get(hh) ?? null); }
  async putNotice(n: Notice) { this.notices.set(n.id, structuredClone(n)); }
  async getNotice(_hh: string, id: string) { return structuredClone(this.notices.get(id) ?? null); }
  async updateNotice(_hh: string, id: string, patch: Partial<Notice>) {
    const cur = this.notices.get(id);
    if (!cur) throw new Error(`notice not found: ${id}`);
    this.notices.set(id, { ...cur, ...structuredClone(patch) });
  }
  async listNotices(hh: string, date: string) {
    return [...this.notices.values()].filter(n => n.hh === hh && n.date === date).map(n => structuredClone(n));
  }
  async listOpenNotices(hh: string) {
    return [...this.notices.values()]
      .filter(n => n.hh === hh && ['open', 'waiting', 'deferred'].includes(n.state))
      .map(n => structuredClone(n));
  }
  async appendLedger(e: LedgerEntry) { this.ledger.push(structuredClone(e)); }
  async getHealth(hh: string, date: string) { return structuredClone(this.health.get(`${hh}/${date}`) ?? null); }
  async putHealth(h: HealthDay) { this.health.set(`${h.hh}/${h.date}`, structuredClone(h)); }

  asStore(): Store { return this as unknown as Store; }
  ledgerNames(): string[] { return this.ledger.map(e => e.name); }
}

export interface SentMessage { memberId: string; channel: Channel; msg: OutboundMessage }

export class FakeNotifier implements Notifier {
  sent: SentMessage[] = [];
  ops: string[] = [];
  /** memberId → そのメンバーへの送信を失敗させる */
  failFor = new Set<string>();

  async send(member: Member, channel: Channel, msg: OutboundMessage): Promise<SendResult> {
    if (this.failFor.has(member.id)) return { ok: false, error: 'http_500' };
    this.sent.push({ memberId: member.id, channel, msg });
    return { ok: true };
  }
  async sendOps(text: string): Promise<SendResult> {
    this.ops.push(text);
    return { ok: true };
  }
  channelsFor(member: Member): Channel[] {
    return member.line?.userId ? ['line', 'email'] : ['email'];
  }
}

export class FakeTasks implements TaskScheduler {
  scheduled: Array<ScheduledTask & { body: Record<string, unknown> }> = [];
  async schedule(path: InternalPath, body: Record<string, unknown>, runAt: Date): Promise<ScheduledTask> {
    const t = { id: `fake_${this.scheduled.length + 1}`, path, runAt };
    this.scheduled.push({ ...t, body });
    return t;
  }
}

export function member(id: string, order: number, opts: Partial<Member> = {}): Member {
  return { id, name: id, order, waitMinutes: 10, line: { userId: `U_${id}_0123456789` }, email: `${id}@example.com`, ...opts };
}

export function household(members: Member[], hh = 'hh_test'): Household {
  return {
    id: hh,
    name: 'テスト家',
    timezone: 'Asia/Tokyo',
    person: { callName: 'お母さん', wording: {} },
    members,
    plan: { weekday: { default: [], dayservice: [] }, dayserviceDays: [] },
    policy: { recheckOnce: true, recheckMinutes: 15, quietHours: { from: '21:30', to: '07:30' } },
    killSwitch: false,
  };
}

/** JST の時刻 */
export function jst(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+09:00`);
}
