import { AppError } from '../errors.mjs';
import { PriceLookupService, PgPriceLookupRepository } from '../price-lookup.mjs';
import { requireAdmin, requireViewer } from '../access.mjs';
import { recordAudit } from '../audit.mjs';

// 由 routes/index.mjs 自动发现。服务实例按连接池缓存；测试可通过 ctx.priceLookup
// 注入带模拟适配器的服务，不发真实付费调用、不联网。
//
// POST /api/price-lookups                     管理员主动发起查价
// GET  /api/price-lookups                     查看查价记录（可按模型/状态筛选）
// GET  /api/price-lookups/:id                 查看一次查价与候选
// POST /api/price-candidates/:id/apply        管理员采用候选（记录操作者与依据）
const services = new WeakMap();

function service(ctx) {
  if (ctx.priceLookup) return ctx.priceLookup;
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '查价存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new PriceLookupService(new PgPriceLookupRepository(ctx.pool), {
      // 搜索/提取适配器尚未配置（Q-10）；未配置时查价会记录失败并提示手动定价。
      adapter: ctx.priceLookupAdapter || null,
    });
    services.set(ctx.pool, instance);
  }
  return instance;
}

function actorId(ctx) {
  return (ctx.session?.user || ctx.user)?.id || 'local';
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

export function routes() {
  return [
    {
      method: 'POST',
      pattern: /^\/api\/price-lookups$/,
      async handler({ ctx, req, body, res, reply }) {
        requireAdmin(ctx);
        const result = await service(ctx).lookup(body || {}, { actorId: actorId(ctx) });
        await recordAudit(ctx, req, {
          action: 'pricing.lookup.started',
          targetType: 'price_lookup',
          targetId: result.lookup.id,
          result: result.lookup.status === 'failed' ? 'failure' : 'success',
          detail: {
            capability: result.lookup.capability,
            modelId: result.lookup.modelId,
            tier: result.lookup.tier,
            status: result.lookup.status,
            candidateCount: result.lookup.candidateCount,
            rejectedCount: result.lookup.rejectedCount,
            error: result.lookup.error,
          },
        });
        reply(res, 201, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/price-lookups$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).list(queryObject(url)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/price-lookups\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).get(match[1]));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/price-candidates\/([^/]+)\/apply$/,
      async handler({ ctx, match, req, body, res, reply }) {
        requireAdmin(ctx);
        const result = await service(ctx).adopt(match[1], body || {}, { actorId: actorId(ctx) });
        await recordAudit(ctx, req, {
          action: 'pricing.candidate.adopted',
          targetType: 'price_candidate',
          targetId: result.candidate.id,
          detail: {
            capability: result.candidate.capability,
            modelId: result.candidate.modelId,
            tier: result.candidate.tier,
            candidateVersion: result.candidate.priceVersion,
            currency: result.candidate.currency,
            unit: result.candidate.unit,
            unitPrice: result.candidate.unitPrice,
            sourceUrl: result.candidate.sourceUrl,
            sourceTitle: result.candidate.sourceTitle,
            basis: result.candidate.adoption?.basis,
            priceId: result.price.id,
            priceVersion: result.price.version,
            confirmedExpired: result.candidate.adoption?.confirmedExpired ?? false,
          },
        });
        reply(res, 200, result);
        return true;
      },
    },
  ];
}
