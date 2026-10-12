import { AppError } from '../errors.mjs';
import {
  businessWorkspaceId, creationWorkspaceId, requireOperator, requireViewer,
} from '../access.mjs';
import { auditService } from '../audit.mjs';
import { BillingService, PgBillingRepository } from '../billing.mjs';
import { GenerationJobAdapter } from '../run.mjs';
import { PgRefineRepository, RefineService } from '../refine.mjs';

// 由 routes/index.mjs 自动发现。测试可通过 ctx.refine 注入内存精修服务。
// 读接口 requireViewer；导入版本、估价、确认、核实、选候选、返修都改变状态，
// 统一 requireOperator。
//
// 精修确认使用精修请求的 ETag `"r<revision>"`；候选切换与返修使用交付项级
// 状态 ETag `"r<revision>"`。写操作缺失 If-Match 返回 428，revision 过期返回 409。
const services = new WeakMap();

function actorId(ctx) {
  return (ctx.session?.user || ctx.user)?.id || 'local';
}

function jobsAdapter(ctx) {
  if (ctx.refineJobs) return ctx.refineJobs;
  if (!ctx.service || !ctx.store) return null;
  return new GenerationJobAdapter({
    generation: ctx.service,
    store: ctx.store,
    registry: ctx.registry || null,
  });
}

function service(ctx) {
  if (ctx.refine) return ctx.refine;
  if (!ctx.pool) throw new AppError('REFINE_UNAVAILABLE', '精修存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new RefineService(new PgRefineRepository(ctx.pool), {
      billing: new BillingService(new PgBillingRepository(ctx.pool)),
      jobs: jobsAdapter(ctx),
      audit: auditService(ctx),
    });
    services.set(ctx.pool, instance);
  }
  return instance;
}

function ifMatch(req) {
  return req.headers['if-match'];
}

function readContext(ctx, req, { creating = false } = {}) {
  return {
    workspaceId: creating ? creationWorkspaceId(ctx) : businessWorkspaceId(ctx),
    actorId: actorId(ctx),
    actor: ctx.user || null,
    ip: req.socket?.remoteAddress ?? null,
    requestId: req.headers['x-request-id'] ?? null,
  };
}

function setRequestEtag(res, request) {
  res.setHeader('ETag', `"r${request.revision}"`);
}

function setStateEtag(res, state) {
  res.setHeader('ETag', `"r${state.revision}"`);
}

export function routes() {
  return [
    // ---- 导入既有成功产物为源版本（不重复计费） ----
    {
      method: 'POST',
      pattern: /^\/api\/deliverables\/([^/]+)\/versions$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).importVersion(match[1], body || {}, readContext(ctx, req, { creating: true }));
        setStateEtag(res, result.state);
        reply(res, result.created === false ? 200 : 201, result);
        return true;
      },
    },

    // ---- 版本链与当前候选 ----
    {
      method: 'GET',
      pattern: /^\/api\/deliverables\/([^/]+)\/versions$/,
      async handler({ ctx, url, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).listVersions(match[1], {
          workspaceId: businessWorkspaceId(ctx),
          projectId: url.searchParams.get('projectId'),
          planVersion: url.searchParams.get('planVersion'),
        });
        setStateEtag(res, result.state);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 精修估价：只写待确认草稿，不预占、不生成 ----
    {
      method: 'POST',
      pattern: /^\/api\/deliverables\/([^/]+)\/refines\/estimate$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).estimate(match[1], body || {}, readContext(ctx, req, { creating: true }));
        setRequestEtag(res, result.request);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 精修记录 ----
    {
      method: 'GET',
      pattern: /^\/api\/deliverables\/([^/]+)\/refines$/,
      async handler({ ctx, url, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).listRefines(match[1], {
          workspaceId: businessWorkspaceId(ctx),
          projectId: url.searchParams.get('projectId'),
          planVersion: url.searchParams.get('planVersion'),
        });
        setStateEtag(res, result.state);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 单独确认：一次确认、一次预占（模板重排为 0）；同幂等键返回原请求 ----
    {
      method: 'POST',
      pattern: /^\/api\/deliverables\/([^/]+)\/refines$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).confirm(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setRequestEtag(res, result.request);
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },

    // ---- 精修请求详情 ----
    {
      method: 'GET',
      pattern: /^\/api\/refines\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).getRefine(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        });
        setRequestEtag(res, result.request);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 未知状态：只查询原任务，不重新提交、不换模型 ----
    {
      method: 'POST',
      pattern: /^\/api\/refines\/([^/]+)\/reconcile$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).reconcile(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setRequestEtag(res, result.request);
        reply(res, 202, result);
        return true;
      },
    },

    // ---- 显式选定交付候选；旧候选保留为 superseded ----
    {
      method: 'POST',
      pattern: /^\/api\/deliverables\/([^/]+)\/candidates$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).selectCandidate(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setStateEtag(res, result.state);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 返修：退回第 04 步，记录理由与目标版本，不删除历史版本 ----
    {
      method: 'POST',
      pattern: /^\/api\/deliverables\/([^/]+)\/rework$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).rework(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setStateEtag(res, result.state);
        reply(res, 200, result);
        return true;
      },
    },
  ];
}
