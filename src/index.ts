// Cloud Run の入口。functions-framework の 1 ハンドラ（helloHttp）でパスを振り分ける。
// 部品の組み立ては app.ts、ルートは api/index.ts。

import { http } from '@google-cloud/functions-framework';
import { createApp } from './app.js';
import { createRouter } from './api/index.js';
import { logError, logEvent } from './log.js';
import { HttpError, json } from './api/router.js';

const appPromise = createApp().then(ctx => ({ ctx, router: createRouter(ctx) }));

http('helloHttp', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { router } = await appPromise;
    const matched = await router.dispatch(req, res);
    if (!matched) {
      json(res, 404, { ok: false, error: `no route: ${req.method} ${req.path}` });
    }
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { ok: false, error: error.message });
      return;
    }
    logError('request_failed', error, { path: req.path, method: req.method });
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
  } finally {
    if (req.path !== '/api/device/heartbeat' && req.path !== '/ping') {
      logEvent('request', { path: req.path, method: req.method, status: res.statusCode, ms: Date.now() - startedAt });
    }
  }
});
