// functions-framework の 1 ハンドラの中でパスを振り分ける小さなルーター。
// Express の req/res をそのまま使う（functions-framework が JSON / urlencoded を解析済み）。

import type { Request, Response } from 'express';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Params = Record<string, string>;
export type Handler = (req: Request, res: Response, params: Params) => Promise<void> | void;

interface Route { method: Method; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  add(method: Method, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path
      .split('/')
      .map(seg => {
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }
  get(path: string, h: Handler) { return this.add('GET', path, h); }
  post(path: string, h: Handler) { return this.add('POST', path, h); }
  put(path: string, h: Handler) { return this.add('PUT', path, h); }
  delete(path: string, h: Handler) { return this.add('DELETE', path, h); }

  /** マッチしたら true。ハンドラの例外は呼び出し側で処理する */
  async dispatch(req: Request, res: Response): Promise<boolean> {
    const method = req.method.toUpperCase() as Method;
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      await r.handler(req, res, params);
      return true;
    }
    return false;
  }
}

// ---- 共通の応答ヘルパ ----
export function json(res: Response, status: number, body: unknown): void {
  res.status(status).set('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body));
}
export function ok(res: Response, body: unknown = { ok: true }): void { json(res, 200, body); }
export function badRequest(res: Response, message: string): void { json(res, 400, { ok: false, error: message }); }
export function unauthorized(res: Response, message = 'unauthorized'): void { json(res, 401, { ok: false, error: message }); }
export function forbidden(res: Response, message = 'forbidden'): void { json(res, 403, { ok: false, error: message }); }
export function notFound(res: Response, message = 'not found'): void { json(res, 404, { ok: false, error: message }); }

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
