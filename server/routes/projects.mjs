import { AppError } from '../errors.mjs';
import { PgProjectRepository, ProjectService } from '../projects.mjs';
import { PgProductRepository, ProductService } from '../products.mjs';
import { BillingService, PgBillingRepository } from '../billing.mjs';
import { businessWorkspaceId, requireOperator, requireViewer } from '../access.mjs';
import { recordAudit } from '../audit.mjs';

// 由 routes/index.mjs 自动发现。一个连接池复用一个服务；测试可通过 ctx.projects 注入内存服务。
const services = new WeakMap();

function service(ctx) {
  if (ctx.projects) return ctx.projects;
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '项目存储暂不可用。', 503);
  // 项目和商品快照都以会话工作空间为准；登录关闭时沿用历史 'local'。
  const workspaceId = businessWorkspaceId(ctx) || 'local';
  let scoped = services.get(ctx.pool);
  if (!scoped) {
    scoped = new Map();
    services.set(ctx.pool, scoped);
  }
  let instance = scoped.get(workspaceId);
  if (!instance) {
    instance = new ProjectService(
      new PgProjectRepository(ctx.pool, { workspaceId }),
      {
        workspaceId,
        products: ctx.products || new ProductService(
          new PgProductRepository(ctx.pool, { workspaceId }), { workspaceId },
        ),
        billing: new BillingService(new PgBillingRepository(ctx.pool)),
      },
    );
    scoped.set(workspaceId, instance);
  }
  return instance;
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function ifMatch(req) {
  return req.headers['if-match'];
}

function setProjectEtag(res, detail) {
  res.setHeader('ETag', `"v${detail.project.version}"`);
}

function setPlanEtag(res, plan) {
  res.setHeader('ETag', `"r${plan.revision}"`);
}

// GET/POST /api/projects
// GET/PATCH /api/projects/:id
// GET /api/projects/:id/plans
// GET/PATCH /api/projects/:id/plans/:version
// POST /api/projects/:id/plans/:version/confirm
// POST /api/projects/:id/plans/:version/deliverables
// POST /api/projects/:id/steps/:step/events
// POST /api/projects/:id/deliverables/:deliverableId/executed
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/projects$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).list(queryObject(url)));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects$/,
      async handler({ ctx, req, body, res, reply }) {
        const user = requireOperator(ctx);
        const detail = await service(ctx).create(body, {
          actorId: user?.id || null,
          ownerId: user?.id || null,
        });
        await recordAudit(ctx, req, {
          action: 'project.created',
          targetType: 'project',
          targetId: detail.project.id,
          detail: {
            name: detail.project.name,
            productId: detail.project.productId,
            skuId: detail.project.skuId,
            planVersion: detail.plan?.version ?? null,
            deliverableCount: detail.plan?.deliverables?.length ?? 0,
          },
        });
        setProjectEtag(res, detail);
        reply(res, 201, detail);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/plans$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).plans(match[1]));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/plans\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).plan(match[1], match[2]);
        setPlanEtag(res, result.plan);
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/projects\/([^/]+)\/plans\/([^/]+)$/,
      async handler({ ctx, match, req, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).updatePlan(match[1], match[2], body, {
          ifMatch: ifMatch(req),
        });
        await recordAudit(ctx, req, {
          action: 'project.plan.updated',
          targetType: 'project',
          targetId: match[1],
          detail: {
            planVersion: result.plan.version,
            revision: result.plan.revision,
            deliverableCount: result.plan.deliverables.length,
          },
        });
        setPlanEtag(res, result.plan);
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/confirm$/,
      async handler({ ctx, match, req, body, res, reply }) {
        const user = requireOperator(ctx);
        const detail = await service(ctx).confirmPlan(match[1], match[2], body || {}, {
          ifMatch: ifMatch(req),
          actorId: user?.id || null,
        });
        await recordAudit(ctx, req, {
          action: 'project.plan.confirmed',
          targetType: 'project',
          targetId: detail.project.id,
          detail: {
            planVersion: detail.plan.version,
            productVersion: detail.plan.productVersion,
            deliverableCount: detail.plan.deliverables.length,
            totalCents: detail.plan.price.totalCents,
            pendingPriceCount: detail.plan.price.pendingPriceCount,
          },
        });
        setProjectEtag(res, detail);
        reply(res, 200, detail);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/deliverables$/,
      async handler({ ctx, match, req, body, res, reply }) {
        requireOperator(ctx);
        const added = Array.isArray(body?.deliverables) ? body.deliverables.length : 0;
        const detail = await service(ctx).addDeliverables(match[1], match[2], body || {}, {
          ifMatch: ifMatch(req),
        });
        await recordAudit(ctx, req, {
          action: 'project.plan.deliverables.added',
          targetType: 'project',
          targetId: detail.project.id,
          detail: {
            baseVersion: Number(match[2].replace(/^v/i, '')),
            planVersion: detail.plan.version,
            added,
            deliverableCount: detail.plan.deliverables.length,
          },
        });
        setPlanEtag(res, detail.plan);
        reply(res, 201, detail);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/events$/,
      async handler({ ctx, match, req, body, res, reply }) {
        const user = requireOperator(ctx);
        const detail = await service(ctx).recordStepEvent(match[1], match[2], body || {}, {
          actorId: user?.id || null,
        });
        await recordAudit(ctx, req, {
          action: 'project.step.updated',
          targetType: 'project',
          targetId: detail.project.id,
          detail: {
            step: Number(match[2].replace(/^0+/, '') || match[2]),
            status: body?.status ?? null,
            progress: detail.progress.label,
            currentStep: detail.currentStep?.step ?? null,
          },
        });
        setProjectEtag(res, detail);
        reply(res, 200, detail);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/deliverables\/([^/]+)\/executed$/,
      async handler({ ctx, match, req, body, res, reply }) {
        const user = requireOperator(ctx);
        const result = await service(ctx).markDeliverableExecuted(
          match[1], match[2], body || {}, { actorId: user?.id || null },
        );
        await recordAudit(ctx, req, {
          action: 'project.deliverable.executed',
          targetType: 'project',
          targetId: match[1],
          detail: {
            deliverableId: match[2],
            planVersion: result.planVersion,
            created: result.created,
            jobId: result.deliverable?.jobId ?? null,
            versionId: result.deliverable?.versionId ?? null,
          },
        });
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const detail = await service(ctx).get(match[1]);
        setProjectEtag(res, detail);
        reply(res, 200, detail);
        return true;
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/projects\/([^/]+)$/,
      async handler({ ctx, match, req, body, res, reply }) {
        requireOperator(ctx);
        const detail = await service(ctx).update(match[1], body, {
          ifMatch: ifMatch(req),
        });
        await recordAudit(ctx, req, {
          action: detail.project.status === 'cancelled' ? 'project.cancelled' : 'project.updated',
          targetType: 'project',
          targetId: detail.project.id,
          detail: { name: detail.project.name, status: detail.project.status },
        });
        setProjectEtag(res, detail);
        reply(res, 200, detail);
        return true;
      },
    },
  ];
}
