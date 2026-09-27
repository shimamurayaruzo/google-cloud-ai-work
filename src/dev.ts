// 手元開発用の起動（tsx watch）。functions-framework を通さず Express で同じハンドラを動かす。
// 本番は index.ts（functions-framework）。
import express from 'express';
import { createApp } from './app.js';
import { createRouter } from './api/index.js';
import { config } from './config.js';
import { HttpError, json } from './api/router.js';
import { logError } from './log.js';

const ctx = await createApp();
const router = createRouter(ctx);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(async (req, res) => {
  try {
    const matched = await router.dispatch(req, res);
    if (!matched) json(res, 404, { ok: false, error: `no route: ${req.method} ${req.path}` });
  } catch (error) {
    if (error instanceof HttpError) { json(res, error.status, { ok: false, error: error.message }); return; }
    logError('request_failed', error, { path: req.path });
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
  }
});
app.listen(config.port, () => console.log(`dev server http://localhost:${config.port}`));
