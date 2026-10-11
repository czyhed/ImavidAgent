import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.mjs';
import { businessWorkspaceId, requireAdmin, requireOperator, requireViewer } from '../access.mjs';
import {
  MinioProductImageStore,
  PgProductImageRepository,
  ProductImageApi,
  assertImageId,
  normalizeUploadQuery,
  publicImage,
} from '../uploads.mjs';

// One service per database pool; tests may inject `uploads` through createServer.
const services = new WeakMap();

function service(ctx) {
  // 登录启用时按会话工作空间隔离图片；关闭时沿用历史 'local'。
  const workspaceId = businessWorkspaceId(ctx) || 'local';
  // 生产注入的是单一实例（默认 'local'）；必须按当前会话派生作用域，
  // 否则登录后上传会把商品判成“不存在”。测试替身没有 pool 时 forWorkspace 返回自身。
  if (ctx.uploads) return ctx.uploads.forWorkspace(workspaceId);
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '商品图片存储暂不可用。', 503);
  let scoped = services.get(ctx.pool);
  if (!scoped) {
    scoped = new Map();
    services.set(ctx.pool, scoped);
  }
  let instance = scoped.get(workspaceId);
  if (!instance) {
    instance = new ProductImageApi(
      new PgProductImageRepository(ctx.pool, { workspaceId }),
      new MinioProductImageStore(),
      { workspaceId },
    );
    scoped.set(workspaceId, instance);
  }
  return instance;
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

// Product image intake and the model-input gate (Issue #9).
//
// POST /api/product-images?productId=<uuid>&kind=original|screenshot
//   Raw image bytes (application/octet-stream or image/png|jpeg|webp). The server sniffs
//   the format, validates decode structure, dimensions and size, and derives the private
//   object key. Client keys, buckets and URLs are never accepted.
// GET  /api/product-images?productId=&kind=
// GET  /api/product-images/:id
// GET  /api/product-images/:id/file
// GET  /api/product-images/input
// POST /api/product-images/input
// POST /api/product-images/preflight
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/product-images$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).list(queryObject(url)));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/product-images$/,
      async handler({ ctx, url, body, res, reply }) {
        requireOperator(ctx);
        if (!Buffer.isBuffer(body)) {
          throw new AppError('BINARY_REQUIRED', '商品图片需以原始二进制上传。', 415);
        }
        const query = normalizeUploadQuery(queryObject(url));
        const image = await service(ctx).upload({
          productId: query.productId,
          kind: query.kind,
          data: body,
        });
        reply(res, 201, { image: publicImage(image) });
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/product-images\/input$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).status(queryObject(url)));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/product-images\/input$/,
      async handler({ ctx, body, res, reply }) {
        requireAdmin(ctx);
        reply(res, 200, await service(ctx).setEnabled(body || {}));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/product-images\/preflight$/,
      async handler({ ctx, body, res, reply }) {
        requireOperator(ctx);
        reply(res, 200, await service(ctx).preflight(body || {}));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/product-images\/([^/]+)\/file$/,
      async handler({ ctx, match, res }) {
        requireViewer(ctx);
        const { image, stream } = await service(ctx).open(assertImageId(match[1]));
        res.writeHead(200, {
          'Content-Type': image.contentType,
          'Content-Disposition': `inline; filename="${image.id}.${image.extension}"`,
        });
        await pipeline(stream, res);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/product-images\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, { image: publicImage(await service(ctx).get(assertImageId(match[1]))) });
        return true;
      },
    },
  ];
}
