import { AppError } from '../errors.mjs';
import { PgRefineRepository, RefineService } from '../refine.mjs';
import {
  businessWorkspaceId, creationWorkspaceId, requireOperator, requireViewer,
} from '../access.mjs';
import { auditService } from '../audit.mjs';
import { BillingService, PgBillingRepository } from '../billing.mjs';
import {
  PgWorkflowModelLookup, PgWorkflowProjectLookup, PgWorkflowRepository, WorkflowService,
} from '../workflow.mjs';
import {
  GenerationJobAdapter, PgRunRepository, RunService,
} from '../run.mjs';

// 由 routes/index.mjs 自动发现。测试可通过 ctx.run 注入内存运行服务。
// 读接口 requireViewer；估价、确认、重试、取消、改节点都改变运行状态，统一 requireOperator。
// 运行写操作使用 ETag `"r<revision>"` 与 If-Match：缺失 428，过期 409。
const services = new WeakMap();

function actorId(ctx) {
  return (ctx.session?.user || ctx.user)?.id || 'local';
}

function jobsAdapter(ctx) {
  if (ctx.runJobs) return ctx.runJobs;
  if (!ctx.service || !ctx.store) return null;
  return new GenerationJobAdapter({
    generation: ctx.service,
    store: ctx.store,
    registry: ctx.registry || null,
  });
}

function workflowService(ctx) {
  if (ctx.workflow) return ctx.workflow;
  return new WorkflowService(new PgWorkflowRepository(ctx.pool), {
    projects: new PgWorkflowProjectLookup(ctx.pool),
    models: new PgWorkflowModelLookup(ctx.pool),
    audit: auditService(ctx),
  });
}

function service(ctx) {
  if (ctx.run) return ctx.run;
  if (!ctx.pool) throw new AppError('RUN_UNAVAILABLE', '工作流运行存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new RunService(new PgRunRepository(ctx.pool), {
      workflows: workflowService(ctx),
      billing: ctx.billing || new BillingService(new PgBillingRepository(ctx.pool)),
      jobs: jobsAdapter(ctx),
      deliverables: ctx.refine || new RefineService(new PgRefineRepository(ctx.pool), { audit: auditService(ctx) }),
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

function setRunEtag(res, run) {
  res.setHeader('ETag', `"r${run.revision}"`);
}

export function routes() {
  return [
    // ---- 最近一次运行（按工作流实例恢复页面状态） ----
    {
      method: 'GET',
      pattern: /^\/api\/workflow-runs$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        const workflowInstanceId = url.searchParams.get('workflowInstanceId');
        if (!workflowInstanceId) {
          throw new AppError('INVALID_FIELD', '请提供 workflowInstanceId。', 422);
        }
        const result = await service(ctx).latest(workflowInstanceId, {
          workspaceId: businessWorkspaceId(ctx),
        });
        if (result.run) setRunEtag(res, result.run);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 逐节点估价 ----
    {
      method: 'POST',
      pattern: /^\/api\/workflow-runs\/estimate$/,
      async handler({ ctx, req, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).estimate(body || {}, readContext(ctx, req, { creating: true }));
        setRunEtag(res, result.run);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 确认开跑（一次确认、一次预占；同幂等键重复提交返回原运行） ----
    {
      method: 'POST',
      pattern: /^\/api\/workflow-runs$/,
      async handler({ ctx, req, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).confirm(body || {}, {
          ...readContext(ctx, req, { creating: true }),
          ifMatch: ifMatch(req),
        });
        setRunEtag(res, result.run);
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },

    // ---- 运行详情 ----
    {
      method: 'GET',
      pattern: /^\/api\/workflow-runs\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).get(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        });
        setRunEtag(res, result.run);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 人工重试：必须显式请求、使用新幂等键 ----
    {
      method: 'POST',
      pattern: /^\/api\/workflow-runs\/([^/]+)\/retry$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).retry(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setRunEtag(res, result.run);
        reply(res, 202, result);
        return true;
      },
    },

    // ---- 未知状态：只查询原任务 ----
    {
      method: 'POST',
      pattern: /^\/api\/workflow-runs\/([^/]+)\/reconcile$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).reconcile(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setRunEtag(res, result.run);
        reply(res, 202, result);
        return true;
      },
    },

    // ---- 取消：释放未执行预占 ----
    {
      method: 'POST',
      pattern: /^\/api\/workflow-runs\/([^/]+)\/cancel$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).cancel(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setRunEtag(res, result.run);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 开跑后修改未执行节点：旧批次作废，生成待重新估价/确认的新批次 ----
    {
      method: 'PATCH',
      pattern: /^\/api\/workflow-runs\/([^/]+)\/nodes\/([^/]+)$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).reconfigure(match[1], match[2], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setRunEtag(res, result.run);
        reply(res, 202, result);
        return true;
      },
    },
  ];
}
