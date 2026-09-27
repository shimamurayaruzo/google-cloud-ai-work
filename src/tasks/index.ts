// 時刻の予約（docs/02 §3.3 内部用）。
//   cloud  … Cloud Tasks に「runAt に自分の path を POST」を積む（本番）
//   inline … setTimeout で自分自身に HTTP（手元・テスト。プロセスが落ちると予約も消える）
// 台帳への書き込みはしない（呼び出し側が recheck_scheduled などを書く）。

import { config } from '../config.js';
import { logError, logEvent, logWarn } from '../log.js';
import type { InternalPath, ScheduledTask, TaskScheduler } from '../services.js';

/** inline モードの予約。listPending() でまだ動いていないものを見られる */
export interface InlineTaskScheduler extends TaskScheduler {
  listPending(): Array<ScheduledTask & { body: Record<string, unknown> }>;
  /** 予約を全部取り消す（テストの後片付け用） */
  clear(): void;
}

export interface InlineOptions {
  port?: number;
  internalToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** setTimeout の上限（約 24.8 日）を超えないように */
const MAX_DELAY_MS = 2_147_000_000;

export function createInlineScheduler(opts: InlineOptions = {}): InlineTaskScheduler {
  const port = opts.port ?? config.port;
  const token = opts.internalToken ?? config.internalToken;
  const now = opts.now ?? Date.now;
  let counter = 0;
  const pending = new Map<string, { task: ScheduledTask; body: Record<string, unknown>; timer: NodeJS.Timeout }>();

  if (!token) logWarn('tasks_inline_no_token', { note: 'INTERNAL_TOKEN が未設定。/internal/* の認証に失敗する可能性' });

  return {
    async schedule(path: InternalPath, body: Record<string, unknown>, runAt: Date): Promise<ScheduledTask> {
      counter += 1;
      const id = `inline_${counter}`;
      const task: ScheduledTask = { id, path, runAt };
      const delay = Math.min(MAX_DELAY_MS, Math.max(0, runAt.getTime() - now()));
      const doFetch = opts.fetchImpl ?? fetch;
      const timer = setTimeout(async () => {
        pending.delete(id);
        try {
          const res = await doFetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
            body: JSON.stringify(body),
          });
          if (!res.ok) logError('tasks_inline_error', new Error(`HTTP ${res.status}`), { id, path });
        } catch (e) {
          logError('tasks_inline_error', e, { id, path });
        }
      }, delay);
      timer.unref();
      pending.set(id, { task, body, timer });
      logEvent('task_scheduled', { mode: 'inline', id, path, runAt: runAt.toISOString() });
      return task;
    },
    listPending() {
      return [...pending.values()].map(p => ({ ...p.task, body: p.body }));
    },
    clear() {
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
  };
}

/** Cloud Tasks クライアントの必要な部分だけ（テストで差し替えられるように） */
export interface CloudTasksLike {
  queuePath(project: string, location: string, queue: string): string;
  createTask(request: Record<string, unknown>): Promise<[{ name?: string | null }, ...unknown[]]>;
}

export interface CloudOptions {
  client?: CloudTasksLike;
  projectId?: string;
  region?: string;
  queue?: string;
  serviceUrl?: string;
  serviceAccountEmail?: string;
  internalToken?: string;
}

export function createCloudScheduler(opts: CloudOptions = {}): TaskScheduler {
  let client: CloudTasksLike | undefined = opts.client;

  async function getClient(): Promise<CloudTasksLike> {
    if (!client) {
      // 起動を軽くするため、使うときに読み込む
      const mod = await import('@google-cloud/tasks');
      client = new mod.CloudTasksClient() as unknown as CloudTasksLike;
    }
    return client;
  }

  return {
    async schedule(path: InternalPath, body: Record<string, unknown>, runAt: Date): Promise<ScheduledTask> {
      const serviceUrl = (opts.serviceUrl ?? config.serviceUrl).replace(/\/$/, '');
      if (!serviceUrl) throw new Error('SERVICE_URL が未設定のため Cloud Tasks に予約できません');
      const sa = opts.serviceAccountEmail ?? config.tasksServiceAccount;
      const token = opts.internalToken ?? config.internalToken;
      if (!sa && !token) {
        throw new Error('TASKS_SERVICE_ACCOUNT も INTERNAL_TOKEN も未設定のため、/internal/* を認証付きで呼べません');
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const httpRequest: Record<string, unknown> = {
        httpMethod: 'POST',
        url: serviceUrl + path,
        headers,
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      };
      if (sa) {
        httpRequest.oidcToken = { serviceAccountEmail: sa, audience: serviceUrl };
      } else {
        headers['X-Internal-Token'] = token;
      }

      const c = await getClient();
      const parent = c.queuePath(
        opts.projectId ?? config.projectId, opts.region ?? config.region, opts.queue ?? config.tasksQueue,
      );
      const ms = runAt.getTime();
      const [task] = await c.createTask({
        parent,
        task: {
          httpRequest,
          scheduleTime: { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 },
        },
      });
      const id = task.name ?? '';
      logEvent('task_scheduled', { mode: 'cloud', id, path, runAt: runAt.toISOString(), auth: sa ? 'oidc' : 'token' });
      return { id, path, runAt };
    },
  };
}

export function createTaskScheduler(opts: { mode?: 'cloud' | 'inline' } = {}): TaskScheduler {
  const mode = opts.mode ?? config.tasksMode;
  return mode === 'inline' ? createInlineScheduler() : createCloudScheduler();
}
