// Firestore の Store（本番 `default`・開発 `develop`）。コレクションの形は docs/02 §2。
//
//   households/{hh}
//   households/{hh}/days/{date}
//   households/{hh}/days/{date}/prompts/{pr}
//   households/{hh}/days/{date}/turns/{tn}      ← ターンの本体
//   households/{hh}/turns/{tn}                  ← getTurn 用の目印（{ hh, id, date, expiresAt } だけ。本文は持たない）
//   households/{hh}/notices/{nt}
//   households/{hh}/approvals/{ap}
//   households/{hh}/ledger/{lg}
//   households/{hh}/health/{date}
//   households/{hh}/noise/{auto}
//
// 目印と本体はどちらもコレクション ID が `turns` なので、TTL（expiresAt）の設定 1 つで両方が 7 日で消える。
// 複合インデックスが要らないように、等号 1 つ＋同じ項目の範囲・並び替えまでにとどめ、それ以上はメモリで絞り込む
// （1 日の声かけ・台帳は数十件なので読み切って問題ない）。

import { Firestore, Timestamp, type CollectionReference, type DocumentData } from '@google-cloud/firestore';
import { config } from '../config.js';
import { dateKey } from '../time.js';
import type {
  Approval, ApprovalId, Day, DateKey, HealthDay, Heartbeat, Household, HouseholdId,
  LedgerEntry, NoiseSample, Notice, NoticeId, Prompt, PromptId, TaskKey, TaskRecord, Turn, TurnId,
} from '../types.js';
import { toDate, type Store } from './types.js';

/** 読み出した値の Timestamp を Date に揃える（入れ子も含めて） */
function revive(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof Timestamp) return toDate(v);
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = revive(x);
    return out;
  }
  return v;
}

function data<T>(snap: { exists: boolean; data(): DocumentData | undefined }): T | null {
  if (!snap.exists) return null;
  return revive(snap.data()) as T;
}

/** 書き込み用。Date はそのまま（Firestore が Timestamp に変える）、undefined は ignoreUndefinedProperties で落ちる */
function plain(v: object): DocumentData {
  return v as DocumentData;
}

function byTime<T>(get: (x: T) => Date | undefined) {
  return (a: T, b: T) => (get(a)?.getTime() ?? 0) - (get(b)?.getTime() ?? 0);
}

export interface FirestoreStoreOptions {
  projectId?: string;
  databaseId?: string;
  /** テストで差し替えるとき */
  firestore?: Firestore;
}

export class FirestoreStore implements Store {
  readonly db: Firestore;

  constructor(opts: FirestoreStoreOptions = {}) {
    this.db = opts.firestore ?? new Firestore({
      projectId: opts.projectId ?? config.projectId,
      databaseId: opts.databaseId ?? config.firestoreDatabase,
      ignoreUndefinedProperties: true,
    });
  }

  // ---- 参照 ----
  private hhRef(hh: HouseholdId) { return this.db.collection('households').doc(hh); }
  private dayRef(hh: HouseholdId, date: DateKey) { return this.hhRef(hh).collection('days').doc(date); }
  private promptsCol(hh: HouseholdId, date: DateKey) { return this.dayRef(hh, date).collection('prompts'); }
  private turnsCol(hh: HouseholdId, date: DateKey) { return this.dayRef(hh, date).collection('turns'); }
  private turnPointerCol(hh: HouseholdId) { return this.hhRef(hh).collection('turns'); }
  private col(hh: HouseholdId, name: 'notices' | 'approvals' | 'ledger' | 'health' | 'noise'): CollectionReference {
    return this.hhRef(hh).collection(name);
  }

  // ---- households/{hh} ----
  async getHousehold(hh: HouseholdId): Promise<Household | null> {
    const h = data<Household>(await this.hhRef(hh).get());
    return h ? { ...h, id: hh } : null;
  }
  async putHousehold(h: Household): Promise<void> {
    await this.hhRef(h.id).set(plain({ ...h, updatedAt: new Date() }));
  }
  async updateHousehold(hh: HouseholdId, patch: Partial<Household>): Promise<void> {
    // update はトップレベルの項目を丸ごと差し替える（MemoryStore の浅いマージと同じ意味）
    const { id: _id, ...rest } = patch;
    await this.hhRef(hh).update(plain({ ...rest, updatedAt: new Date() }));
  }
  async listHouseholds(): Promise<Household[]> {
    const snap = await this.db.collection('households').get();
    return snap.docs.map(d => ({ ...(revive(d.data()) as Household), id: d.id }));
  }

  // ---- days/{date} ----
  async getDay(hh: HouseholdId, date: DateKey): Promise<Day | null> {
    return data<Day>(await this.dayRef(hh, date).get());
  }
  async putDay(day: Day): Promise<void> {
    await this.dayRef(day.hh, day.date).set(plain({ ...day, updatedAt: new Date() }));
  }
  async setTask(hh: HouseholdId, date: DateKey, task: TaskKey, record: TaskRecord): Promise<void> {
    // 日が無ければ update が NOT_FOUND で throw する（先に putDay）
    await this.dayRef(hh, date).update({ [`tasks.${task}`]: plain(record), updatedAt: new Date() });
  }
  async updateDay(hh: HouseholdId, date: DateKey, patch: Partial<Pick<Day, 'planApproved' | 'summary' | 'signals' | 'plan' | 'isDayservice'>>): Promise<void> {
    await this.dayRef(hh, date).update(plain({ ...patch, updatedAt: new Date() }));
  }
  async listRecentDays(hh: HouseholdId, beforeDate: DateKey, count: number): Promise<Day[]> {
    const snap = await this.hhRef(hh).collection('days')
      .where('date', '<', beforeDate).orderBy('date', 'desc').limit(count).get();
    return snap.docs.map(d => revive(d.data()) as Day);
  }

  // ---- prompts ----
  async putPrompt(p: Prompt): Promise<void> {
    await this.promptsCol(p.hh, p.date).doc(p.id).set(plain(p));
  }
  async getPrompt(hh: HouseholdId, date: DateKey, id: PromptId): Promise<Prompt | null> {
    return data<Prompt>(await this.promptsCol(hh, date).doc(id).get());
  }
  async updatePrompt(hh: HouseholdId, date: DateKey, id: PromptId, patch: Partial<Prompt>): Promise<void> {
    const { id: _id, ...rest } = patch;
    await this.promptsCol(hh, date).doc(id).update(plain(rest));
  }
  async listDuePrompts(hh: HouseholdId, date: DateKey, now: Date): Promise<Prompt[]> {
    // state と scheduledAt の複合インデックスを避けるため、その日の分を読んでから絞る
    return (await this.listPrompts(hh, date))
      .filter(p => p.state === 'queued' && p.scheduledAt.getTime() <= now.getTime());
  }
  async listPrompts(hh: HouseholdId, date: DateKey): Promise<Prompt[]> {
    const snap = await this.promptsCol(hh, date).get();
    return snap.docs.map(d => revive(d.data()) as Prompt).sort(byTime(p => p.scheduledAt));
  }

  // ---- turns ----
  async putTurn(t: Turn): Promise<void> {
    const batch = this.db.batch();
    batch.set(this.turnsCol(t.hh, t.date).doc(t.id), plain(t));
    batch.set(this.turnPointerCol(t.hh).doc(t.id), plain({ hh: t.hh, id: t.id, date: t.date, expiresAt: t.expiresAt }));
    await batch.commit();
  }
  async getTurn(hh: HouseholdId, turnId: TurnId): Promise<Turn | null> {
    const pointer = data<{ date: DateKey }>(await this.turnPointerCol(hh).doc(turnId).get());
    if (!pointer?.date) return null;
    return data<Turn>(await this.turnsCol(hh, pointer.date).doc(turnId).get());
  }
  async listTurns(hh: HouseholdId, date: DateKey): Promise<Turn[]> {
    const snap = await this.turnsCol(hh, date).get();
    return snap.docs.map(d => revive(d.data()) as Turn).sort(byTime(t => t.repliedAt));
  }

  // ---- notices ----
  async putNotice(n: Notice): Promise<void> {
    await this.col(n.hh, 'notices').doc(n.id).set(plain(n));
  }
  async getNotice(hh: HouseholdId, id: NoticeId): Promise<Notice | null> {
    return data<Notice>(await this.col(hh, 'notices').doc(id).get());
  }
  async updateNotice(hh: HouseholdId, id: NoticeId, patch: Partial<Notice>): Promise<void> {
    const { id: _id, ...rest } = patch;
    await this.col(hh, 'notices').doc(id).update(plain(rest));
  }
  async listNotices(hh: HouseholdId, date: DateKey): Promise<Notice[]> {
    const snap = await this.col(hh, 'notices').where('date', '==', date).get();
    return snap.docs.map(d => revive(d.data()) as Notice).sort(byTime(n => n.createdAt));
  }
  async listOpenNotices(hh: HouseholdId): Promise<Notice[]> {
    const snap = await this.col(hh, 'notices').where('state', 'in', ['open', 'waiting', 'deferred']).get();
    return snap.docs.map(d => revive(d.data()) as Notice).sort(byTime(n => n.createdAt));
  }

  // ---- approvals ----
  async putApproval(a: Approval): Promise<void> {
    await this.col(a.hh, 'approvals').doc(a.id).set(plain(a));
  }
  async getApproval(hh: HouseholdId, id: ApprovalId): Promise<Approval | null> {
    return data<Approval>(await this.col(hh, 'approvals').doc(id).get());
  }
  async updateApproval(hh: HouseholdId, id: ApprovalId, patch: Partial<Approval>): Promise<void> {
    const { id: _id, ...rest } = patch;
    await this.col(hh, 'approvals').doc(id).update(plain(rest));
  }
  async listApprovals(hh: HouseholdId, onlyPending = false): Promise<Approval[]> {
    const base = this.col(hh, 'approvals');
    const snap = await (onlyPending ? base.where('decision', '==', null) : base).get();
    return snap.docs.map(d => revive(d.data()) as Approval).sort(byTime(a => a.requestedAt));
  }

  // ---- ledger（追記のみ。create は同じ ID があれば失敗する） ----
  async appendLedger(e: LedgerEntry): Promise<void> {
    await this.col(e.hh, 'ledger').doc(e.id).create(plain(e));
  }
  async listLedger(hh: HouseholdId, date: DateKey): Promise<LedgerEntry[]> {
    const snap = await this.col(hh, 'ledger').where('date', '==', date).get();
    return snap.docs.map(d => revive(d.data()) as LedgerEntry).sort(byTime(e => e.at));
  }

  // ---- health/{date} ----
  async getHealth(hh: HouseholdId, date: DateKey): Promise<HealthDay | null> {
    const h = data<HealthDay>(await this.col(hh, 'health').doc(date).get());
    if (!h) return null;
    return { ...h, hh, date, lastHeartbeatAt: h.lastHeartbeatAt ?? null, incidents: h.incidents ?? [] };
  }
  async putHealth(h: HealthDay): Promise<void> {
    await this.col(h.hh, 'health').doc(h.date).set(plain(h));
  }
  /**
   * 部分更新（無ければ作る）。mergeFields で渡した項目だけを丸ごと差し替えるので、
   * 同時に走る recordHeartbeat（lastHeartbeatAt だけ）を消さない。Store への追加を提案中
   */
  async updateHealth(hh: HouseholdId, date: DateKey, patch: Partial<Omit<HealthDay, 'hh' | 'date'>>): Promise<void> {
    const fields = Object.keys(patch).filter(k => (patch as Record<string, unknown>)[k] !== undefined);
    await this.col(hh, 'health').doc(date).set(plain({ ...patch, hh, date }), { mergeFields: [...fields, 'hh', 'date'] });
  }
  async recordHeartbeat(hb: Heartbeat): Promise<void> {
    const date = dateKey(hb.at);
    await this.col(hb.hh, 'health').doc(date).set(plain({
      hh: hb.hh, date, lastHeartbeatAt: hb.at,
      device: { batteryPct: hb.batteryPct, appVersion: hb.appVersion },
    }), { merge: true });
  }
  async recordNoise(sample: NoiseSample): Promise<void> {
    await this.col(sample.hh, 'noise').add(plain(sample));
  }
  async listRecentNoise(hh: HouseholdId, since: Date): Promise<NoiseSample[]> {
    const snap = await this.col(hh, 'noise').where('at', '>=', since).orderBy('at', 'asc').get();
    return snap.docs.map(d => revive(d.data()) as NoiseSample);
  }
}
