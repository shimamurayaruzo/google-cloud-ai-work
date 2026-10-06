// ルートの登録。index.ts（本番）と dev.ts（手元）が createRouter(ctx) を呼ぶ。
// ハンドラは HttpError を throw してよい（呼び出し側が JSON にする）。
// state/ の NotFoundError はここで 404 に変える。
// 入出力の例は src/api/README.md。

import type { AppContext } from '../services.js';
import { NotFoundError } from '../state/turn.js';
import { familyLoginHandlers } from './auth.js';
import { registerDeviceRoutes } from './device.js';
import { registerFamilyRoutes } from './family.js';
import { registerInternalRoutes } from './internal.js';
import { registerLineWebhook } from './line-webhook.js';
import { HttpError, Router, type Handler, type Method } from './router.js';
import { registerStaticRoutes } from './static.js';

/** NotFoundError を 404 の HttpError に変えるルーター */
class AppRouter extends Router {
  override add(method: Method, path: string, handler: Handler): this {
    return super.add(method, path, async (req, res, params) => {
      try {
        await handler(req, res, params);
      } catch (error) {
        if (error instanceof NotFoundError) throw new HttpError(404, (error as Error).message || '見つかりません');
        throw error;
      }
    });
  }
}

export function createRouter(ctx: AppContext): Router {
  const router = new AppRouter();

  // 家族の合言葉ログイン（画面）
  router.get('/login', familyLoginHandlers.page);
  router.post('/login', familyLoginHandlers.form);
  router.get('/logout', familyLoginHandlers.logout);
  router.post('/logout', familyLoginHandlers.logout);

  registerDeviceRoutes(router, ctx);
  registerFamilyRoutes(router, ctx);
  registerInternalRoutes(router, ctx);
  registerLineWebhook(router, ctx);

  // 静的ファイルは最後（/:file が他のパスを食わないように）
  registerStaticRoutes(router);
  return router;
}
