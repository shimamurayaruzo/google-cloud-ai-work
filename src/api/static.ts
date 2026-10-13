// web/ の静的配信と /ping（死活確認。/healthz は Cloud Run の前段が予約していてコンテナに届かないので使わない）。
//   GET /        → web/index.html
//   GET /device  → web/device.html（無ければ web/dev/device.html）
//   GET /family  → web/family.html（無ければ web/dev/family.html）
//   GET /dev/... → web/dev/...
//   GET /assets/... と web/ 直下のファイル（拡張子付き）も配る（本画面の JS・CSS・画像用）
// パスに .. や \ や先頭の . があれば拒否する。

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { HttpError, ok, type Router } from './router.js';

export const WEB_ROOT = path.resolve(fileURLToPath(new URL('../../web/', import.meta.url)));

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
};

/** web/ からの相対パスを安全な絶対パスにする。だめなら null */
export function resolveWebPath(rel: string, root: string = WEB_ROOT): string | null {
  if (!rel || rel.includes('\0') || rel.includes('\\')) return null;
  const segs = rel.split('/');
  if (segs.some(s => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const abs = path.resolve(root, ...segs);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  if (!CONTENT_TYPES[path.extname(abs).toLowerCase()]) return null;
  return abs;
}

async function exists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

/** 候補を順に探して最初にあったものを返す */
export async function sendWebFile(res: Response, candidates: string[]): Promise<void> {
  for (const rel of candidates) {
    const abs = resolveWebPath(rel);
    if (!abs || !(await exists(abs))) continue;
    const buf = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.status(200)
      .set('Content-Type', CONTENT_TYPES[ext])
      .set('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=300')
      .set('X-Content-Type-Options', 'nosniff')
      .send(buf);
    return;
  }
  throw new HttpError(404, 'ページが見つかりません');
}

export function registerStaticRoutes(router: Router): void {
  router.get('/ping', (_req: Request, res: Response) => { ok(res, { ok: true }); });

  router.get('/', (_req, res) => sendWebFile(res, ['index.html']));
  router.get('/device', (_req, res) => sendWebFile(res, ['device.html', 'dev/device.html']));
  router.get('/family', (_req, res) => sendWebFile(res, ['family.html', 'dev/family.html']));
  router.get('/dev', (_req, res) => sendWebFile(res, ['dev/index.html', 'index.html']));
  router.get('/dev/:file', (_req, res, p) => sendWebFile(res, [`dev/${p.file}`]));
  router.get('/dev/:dir/:file', (_req, res, p) => sendWebFile(res, [`dev/${p.dir}/${p.file}`]));
  router.get('/assets/:file', (_req, res, p) => sendWebFile(res, [`assets/${p.file}`]));
  router.get('/assets/:dir/:file', (_req, res, p) => sendWebFile(res, [`assets/${p.dir}/${p.file}`]));
  // web/ 直下のファイル（device.js など）。拡張子が無いものは resolveWebPath で弾かれて 404
  router.get('/:file', (_req, res, p) => sendWebFile(res, [p.file]));
}
