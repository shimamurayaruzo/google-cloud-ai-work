// メモリ上の Store。テストと再生モードで使う。
// 呼び出し側が返り値を書き換えても中身が変わらないよう、出し入れのたびに深いコピーを取る。

import { dateKey } from '../time.js';
import type {
  Approval, ApprovalId, Day, DateKey, HealthDay, Heartbeat, Household, HouseholdId,
  LedgerEntry, NoiseSample, Notice, NoticeId, Prompt, PromptId, TaskKey, TaskRecord, Turn, TurnId,
} from '../types.js';
import type { Store } from './types.js';

function clone<T>(v: T): T {
  return structuredClone(v);
}

function key(hh: HouseholdId, date: DateKey): string {
  return `${hh}/${date}`;
}

/** 入れ子の Map を取り出す（無ければ作る） */
function bucket<K, V>(m: Map<string, Map<K, V>>, k: string): Map<K, V> {
  let b = m.get(k);
  if (!b) { b = new Map(); m.set(k, b); }
  return b;
}

export class MemoryStore implements Store {
  private households = new Map<HouseholdId, Household>();
  private days = new Map<string, Day>();
  private prompts = new Map<string, Map<PromptId, Prompt>>();
  private turns = new Map<string, Map<TurnId, Turn>>();
  private notices = new Map<string, Map<NoticeId, Notice>>();
  private approvals = new Map<string, Map<ApprovalId, Approval>>();
  private ledger = new Map<HouseholdId, LedgerEntry[]>();
  private health = new Map<string, HealthDay>();
  private noise = new Map<HouseholdId, NoiseSample[]>();

  // ---- households ----
  async getHousehold(hh: HouseholdId): Promise<Household | null> {
    const h = this.households.get(hh);
    return h ? clone(h) : null;
  }
  async putHousehold(h: Household): Promise<void> {
    this.households.set(h.id, clone(h));
  }
  async updateHousehold(hh: HouseholdId, patch: Partial<Household>): Promise<void> {
    const h = this.households.get(hh);
    if (!h) throw new Error(`household not found: ${hh}`);
    this.households.set(hh, { ...h, ...clone(patch), id: h.id });
  }
  async listHouseholds(): Promise<Household[]> {
    return [...this.households.values()].map(clone);
  }

  // ---- days ----
  async getDay(hh: HouseholdId, date: DateKey): Promise<Day | null> {
    const d = this.days.get(key(hh, date));
    return d ? clone(d) : null;
  }
  async putDay(day: Day): Promise<void> {
    this.days.set(key(day.hh, day.date), clone(day));
  }
  async setTask(hh: HouseholdId, date: DateKey, task: TaskKey, record: TaskRecord): Promise<void> {
    const d = this.days.get(key(hh, date));
    if (!d) throw new Error(`day not found: ${hh}/${date}`);
    d.tasks[task] = clone(record);
  }
  async updateDay(hh: HouseholdId, date: DateKey, patch: Partial<Pick<Day, 'planApproved' | 'summary' | 'signals' | 'plan' | 'isDayservice' | 'l4'>>): Promise<void> {
    const d = this.days.get(key(hh, date));
    if (!d) throw new Error(`day not found: ${hh}/${date}`);
    this.days.set(key(hh, date), { ...d, ...clone(patch) });
  }
  async listRecentDays(hh: HouseholdId, beforeDate: DateKey, count: number): Promise<Day[]> {
    return [...this.days.values()]
      .filter(d => d.hh === hh && d.date < beforeDate)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, count)
      .map(clone);
  }

  // ---- prompts ----
  async putPrompt(p: Prompt): Promise<void> {
    bucket(this.prompts, key(p.hh, p.date)).set(p.id, clone(p));
  }
  async getPrompt(hh: HouseholdId, date: DateKey, id: PromptId): Promise<Prompt | null> {
    const p = this.prompts.get(key(hh, date))?.get(id);
    return p ? clone(p) : null;
  }
  async updatePrompt(hh: HouseholdId, date: DateKey, id: PromptId, patch: Partial<Prompt>): Promise<void> {
    const b = this.prompts.get(key(hh, date));
    const p = b?.get(id);
    if (!b || !p) throw new Error(`prompt not found: ${hh}/${date}/${id}`);
    b.set(id, { ...p, ...clone(patch), id: p.id });
  }
  async listDuePrompts(hh: HouseholdId, date: DateKey, now: Date): Promise<Prompt[]> {
    return (await this.listPrompts(hh, date))
      .filter(p => p.state === 'queued' && p.scheduledAt.getTime() <= now.getTime());
  }
  async listPrompts(hh: HouseholdId, date: DateKey): Promise<Prompt[]> {
    const b = this.prompts.get(key(hh, date));
    if (!b) return [];
    return [...b.values()].sort((a, c) => a.scheduledAt.getTime() - c.scheduledAt.getTime()).map(clone);
  }

  // ---- turns ----
  async putTurn(t: Turn): Promise<void> {
    bucket(this.turns, t.hh).set(t.id, clone(t));
  }
  async getTurn(hh: HouseholdId, turnId: TurnId): Promise<Turn | null> {
    const t = this.turns.get(hh)?.get(turnId);
    return t ? clone(t) : null;
  }
  async listTurns(hh: HouseholdId, date: DateKey): Promise<Turn[]> {
    const b = this.turns.get(hh);
    if (!b) return [];
    return [...b.values()]
      .filter(t => t.date === date)
      .sort((a, c) => a.repliedAt.getTime() - c.repliedAt.getTime())
      .map(clone);
  }

  // ---- notices ----
  async putNotice(n: Notice): Promise<void> {
    bucket(this.notices, n.hh).set(n.id, clone(n));
  }
  async getNotice(hh: HouseholdId, id: NoticeId): Promise<Notice | null> {
    const n = this.notices.get(hh)?.get(id);
    return n ? clone(n) : null;
  }
  async updateNotice(hh: HouseholdId, id: NoticeId, patch: Partial<Notice>): Promise<void> {
    const b = this.notices.get(hh);
    const n = b?.get(id);
    if (!b || !n) throw new Error(`notice not found: ${hh}/${id}`);
    b.set(id, { ...n, ...clone(patch), id: n.id });
  }
  async listNotices(hh: HouseholdId, date: DateKey): Promise<Notice[]> {
    return this.sortedNotices(hh).filter(n => n.date === date);
  }
  async listOpenNotices(hh: HouseholdId): Promise<Notice[]> {
    return this.sortedNotices(hh).filter(n => n.state === 'open' || n.state === 'waiting' || n.state === 'deferred');
  }
  private sortedNotices(hh: HouseholdId): Notice[] {
    const b = this.notices.get(hh);
    if (!b) return [];
    return [...b.values()].sort((a, c) => a.createdAt.getTime() - c.createdAt.getTime()).map(clone);
  }

  // ---- approvals ----
  async putApproval(a: Approval): Promise<void> {
    bucket(this.approvals, a.hh).set(a.id, clone(a));
  }
  async getApproval(hh: HouseholdId, id: ApprovalId): Promise<Approval | null> {
    const a = this.approvals.get(hh)?.get(id);
    return a ? clone(a) : null;
  }
  async updateApproval(hh: HouseholdId, id: ApprovalId, patch: Partial<Approval>): Promise<void> {
    const b = this.approvals.get(hh);
    const a = b?.get(id);
    if (!b || !a) throw new Error(`approval not found: ${hh}/${id}`);
    b.set(id, { ...a, ...clone(patch), id: a.id });
  }
  async listApprovals(hh: HouseholdId, onlyPending = false): Promise<Approval[]> {
    const b = this.approvals.get(hh);
    if (!b) return [];
    return [...b.values()]
      .filter(a => !onlyPending || a.decision == null)
      .sort((a, c) => a.requestedAt.getTime() - c.requestedAt.getTime())
      .map(clone);
  }

  // ---- ledger（追記のみ） ----
  async appendLedger(e: LedgerEntry): Promise<void> {
    let list = this.ledger.get(e.hh);
    if (!list) { list = []; this.ledger.set(e.hh, list); }
    list.push(clone(e));
  }
  async listLedger(hh: HouseholdId, date: DateKey): Promise<LedgerEntry[]> {
    return (this.ledger.get(hh) ?? [])
      .map((e, i) => ({ e, i }))
      .filter(x => x.e.date === date)
      // 時刻順。同じ時刻は追記した順
      .sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i)
      .map(x => clone(x.e));
  }

  // ---- health ----
  async getHealth(hh: HouseholdId, date: DateKey): Promise<HealthDay | null> {
    const h = this.health.get(key(hh, date));
    return h ? clone(h) : null;
  }
  async putHealth(h: HealthDay): Promise<void> {
    this.health.set(key(h.hh, h.date), clone(h));
  }
  /** 部分更新（無ければ作る）。トップレベルの項目を丸ごと差し替える。Store への追加を提案中 */
  async updateHealth(hh: HouseholdId, date: DateKey, patch: Partial<Omit<HealthDay, 'hh' | 'date'>>): Promise<void> {
    const k = key(hh, date);
    const h: HealthDay = this.health.get(k) ?? { hh, date, lastHeartbeatAt: null, incidents: [] };
    this.health.set(k, { ...h, ...clone(patch), hh, date });
  }
  async recordHeartbeat(hb: Heartbeat): Promise<void> {
    const date = dateKey(hb.at);
    const k = key(hb.hh, date);
    const h: HealthDay = this.health.get(k) ?? { hh: hb.hh, date, lastHeartbeatAt: null, incidents: [] };
    h.lastHeartbeatAt = new Date(hb.at.getTime());
    this.health.set(k, h);
  }
  async recordNoise(sample: NoiseSample): Promise<void> {
    let list = this.noise.get(sample.hh);
    if (!list) { list = []; this.noise.set(sample.hh, list); }
    list.push(clone(sample));
  }
  async listRecentNoise(hh: HouseholdId, since: Date): Promise<NoiseSample[]> {
    return (this.noise.get(hh) ?? [])
      .filter(s => s.at.getTime() >= since.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map(clone);
  }
}
