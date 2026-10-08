import { AppError } from '../errors.mjs';
import { PgProductRepository, ProductService } from '../products.mjs';
import {
  PgScreenshotImageStore,
  PgScreenshotIntakeStore,
  ScreenshotIntakeService,
} from '../intake-screenshot.mjs';
import { VisionAdapterRegistry } from '../vision.mjs';

// One intake service per database pool. Tests and future hosts may inject a
// ready service through createServer({ intake }), which is how a mock vision
// adapter is supplied without any real model call.
const services = new WeakMap();
const defaultVision = new VisionAdapterRegistry();

function service(ctx) {
  if (ctx.intake) return ctx.intake;
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '截图识别存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new ScreenshotIntakeService({
      products: ctx.products || new ProductService(new PgProductRepository(ctx.pool)),
      store: new PgScreenshotIntakeStore(ctx.pool),
      screenshots: new PgScreenshotImageStore(ctx.pool),
      vision: ctx.vision || defaultVision,
    });
    services.set(ctx.pool, instance);
  }
  return instance;
}

// POST /api/intake/screenshot/preflight  费用口径、指纹去重与能力状态
// POST /api/intake/screenshot            识别、合并并建档（名称可确定时）
// GET  /api/intake/screenshot/:id        查询批次、字段证据与建档结果
export function routes() {
  return [
    {
      method: 'POST',
      pattern: /^\/api\/intake\/screenshot\/preflight$/,
      async handler({ ctx, body, res, reply }) {
        reply(res, 200, await service(ctx).preflight(body || {}));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/intake\/screenshot$/,
      async handler({ ctx, body, res, reply }) {
        const result = await service(ctx).submit(body || {});
        reply(res, result.duplicate || !result.product ? 200 : 201, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/intake\/screenshot\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        reply(res, 200, await service(ctx).get(match[1]));
        return true;
      },
    },
  ];
}
