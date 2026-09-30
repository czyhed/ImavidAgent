import { AppError } from '../errors.mjs';
import { PgProductRepository, ProductService } from '../products.mjs';
import { businessWorkspaceId, requireOperator, requireViewer } from '../access.mjs';
import { recordAudit } from '../audit.mjs';

// One service per database pool; tests may inject `products` through createServer.
const services = new WeakMap();

function service(ctx) {
  if (ctx.products) return ctx.products;
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '商品存储暂不可用。', 503);
  const workspaceId = businessWorkspaceId(ctx) || 'local';
  let scoped = services.get(ctx.pool);
  if (!scoped) {
    scoped = new Map();
    services.set(ctx.pool, scoped);
  }
  let instance = scoped.get(workspaceId);
  if (!instance) {
    instance = new ProductService(
      new PgProductRepository(ctx.pool, { workspaceId }),
      { workspaceId },
    );
    scoped.set(workspaceId, instance);
  }
  return instance;
}

function setEtag(res, product) {
  res.setHeader('ETag', `"v${product.version}"`);
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

// GET/POST /api/products
// GET/PATCH /api/products/:id
// POST /api/products/:id/confirm
// GET /api/products/:id/versions
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/products$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).list(queryObject(url)));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/products$/,
      async handler({ ctx, body, res, reply }) {
        requireOperator(ctx);
        const product = await service(ctx).create(body);
        setEtag(res, product);
        reply(res, 201, { product });
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/products\/([^/]+)\/versions$/,
      async handler({ ctx, match, url, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).versions(match[1], queryObject(url)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/products\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const product = await service(ctx).get(match[1]);
        setEtag(res, product);
        reply(res, 200, { product });
        return true;
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/products\/([^/]+)$/,
      async handler({ ctx, match, req, body, res, reply }) {
        requireOperator(ctx);
        const product = await service(ctx).update(match[1], body, {
          ifMatch: req.headers['if-match'],
        });
        setEtag(res, product);
        reply(res, 200, { product });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/products\/([^/]+)\/confirm$/,
      async handler({ ctx, match, req, body, res, reply }) {
        requireOperator(ctx);
        const product = await service(ctx).confirm(match[1], body || {}, {
          ifMatch: req.headers['if-match'],
        });
        await recordAudit(ctx, req, {
          action: 'product.confirmed',
          targetType: 'product',
          targetId: product.id,
          detail: { version: product.version, status: product.status, name: product.name },
        });
        setEtag(res, product);
        reply(res, 200, { product });
        return true;
      },
    },
  ];
}
