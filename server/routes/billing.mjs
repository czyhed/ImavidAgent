import { AppError } from '../errors.mjs';
import { BillingService, DEFAULT_WORKSPACE_ID, PgBillingRepository } from '../billing.mjs';
import { businessWorkspaceId, requireAdmin, requireOperator, requireViewer } from '../access.mjs';

// 由 routes/index.mjs 自动发现。服务实例按「数据库连接池 + 工作空间」缓存：
// 登录启用时不同工作空间的价目表与流水必须相互隔离，不能共用一个默认 local 实例。
// 测试可直接通过 ctx.billing 注入内存仓储，不触碰 PostgreSQL 或任何真实模型。
const services = new WeakMap();

export function billingService(ctx) {
  if (ctx.billing) return ctx.billing;
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '账本存储暂不可用。', 503);
  // 关闭登录时 businessWorkspaceId 返回 null，沿用历史单工作空间 'local'。
  const workspaceId = businessWorkspaceId(ctx) || DEFAULT_WORKSPACE_ID;
  let byWorkspace = services.get(ctx.pool);
  if (!byWorkspace) {
    byWorkspace = new Map();
    services.set(ctx.pool, byWorkspace);
  }
  let instance = byWorkspace.get(workspaceId);
  if (!instance) {
    instance = new BillingService(new PgBillingRepository(ctx.pool, { workspaceId }), { workspaceId });
    byWorkspace.set(workspaceId, instance);
  }
  return instance;
}

const READ_ROLES = ['admin', 'operator', 'viewer'];
const OPERATE_ROLES = ['admin', 'operator'];
const ADMIN_ROLES = ['admin'];

// 统一鉴权（Issue #6）：未启用账号体系时 require* 放行，保留本机单用户模式；
// 启用后管理员可维护价格/补价/调账，运营可预占/结算/释放，查看者只读。
function guard(ctx, roles) {
  if (roles === ADMIN_ROLES) requireAdmin(ctx);
  else if (roles === OPERATE_ROLES) requireOperator(ctx);
  else requireViewer(ctx);
}

function actorId(ctx) {
  return (ctx.session?.user || ctx.user)?.id || 'local';
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

// GET /api/billing · GET /api/billing/summary     余额与汇总
// GET/POST /api/billing/prices                    价格维护
// POST /api/billing/quote                          估价
// POST /api/billing/reservations                   有价任务预占
// POST /api/billing/cost-only                      项目文本辅助仅记成本
// POST /api/billing/tasks/:taskId/settle|release   成功结算 / 明确失败释放
// POST /api/billing/tasks/:taskId/supplement       未定价任务管理员补价
// POST /api/billing/adjustments                    人工充值/退款/调账
// GET /api/billing/ledger                          追加式流水
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/billing$/,
      async handler({ ctx, url, res, reply }) {
        guard(ctx, READ_ROLES);
        reply(res, 200, await billingService(ctx).summary(queryObject(url)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/billing\/summary$/,
      async handler({ ctx, url, res, reply }) {
        guard(ctx, READ_ROLES);
        reply(res, 200, await billingService(ctx).summary(queryObject(url)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/billing\/prices$/,
      async handler({ ctx, url, res, reply }) {
        guard(ctx, READ_ROLES);
        reply(res, 200, await billingService(ctx).prices(queryObject(url)));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/prices$/,
      async handler({ ctx, body, res, reply }) {
        guard(ctx, ADMIN_ROLES);
        reply(res, 201, { price: await billingService(ctx).setPrice(body || {}, { actorId: actorId(ctx) }) });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/quote$/,
      async handler({ ctx, body, res, reply }) {
        guard(ctx, READ_ROLES);
        reply(res, 200, { quote: await billingService(ctx).quote(body || {}) });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/reservations$/,
      async handler({ ctx, body, res, reply }) {
        guard(ctx, OPERATE_ROLES);
        const result = await billingService(ctx).reserve(body || {}, { actorId: actorId(ctx) });
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/cost-only$/,
      async handler({ ctx, body, res, reply }) {
        guard(ctx, OPERATE_ROLES);
        const result = await billingService(ctx).costOnly(body || {}, { actorId: actorId(ctx) });
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/adjustments$/,
      async handler({ ctx, body, res, reply }) {
        guard(ctx, ADMIN_ROLES);
        const result = await billingService(ctx).adjust(body || {}, { actorId: actorId(ctx) });
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/billing\/ledger$/,
      async handler({ ctx, url, res, reply }) {
        guard(ctx, READ_ROLES);
        reply(res, 200, await billingService(ctx).ledger(queryObject(url)));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/tasks\/([^/]+)\/settle$/,
      async handler({ ctx, match, body, res, reply }) {
        guard(ctx, OPERATE_ROLES);
        const result = await billingService(ctx).settle(match[1], body || {}, { actorId: actorId(ctx) });
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/tasks\/([^/]+)\/release$/,
      async handler({ ctx, match, body, res, reply }) {
        guard(ctx, OPERATE_ROLES);
        const result = await billingService(ctx).release(match[1], body || {}, { actorId: actorId(ctx) });
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/billing\/tasks\/([^/]+)\/supplement$/,
      async handler({ ctx, match, body, res, reply }) {
        guard(ctx, ADMIN_ROLES);
        const result = await billingService(ctx).supplement(match[1], body || {}, { actorId: actorId(ctx) });
        reply(res, 200, result);
        return true;
      },
    },
  ];
}
