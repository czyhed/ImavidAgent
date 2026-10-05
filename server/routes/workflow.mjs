import { AppError } from '../errors.mjs';
import { businessWorkspaceId, creationWorkspaceId, requireOperator, requireViewer } from '../access.mjs';
import { auditService } from '../audit.mjs';
import {
  PgWorkflowModelLookup, PgWorkflowProjectLookup, PgWorkflowRepository, WorkflowService,
} from '../workflow.mjs';

// 由 routes/index.mjs 自动发现。一个连接池复用一个服务；测试可通过 ctx.workflow 注入内存服务。
// 读接口 requireViewer，写接口 requireOperator；实例修改与另存模板使用 ETag/If-Match 乐观锁。
const services = new WeakMap();

function service(ctx) {
  if (ctx.workflow) return ctx.workflow;
  if (!ctx.pool) throw new AppError('WORKFLOW_UNAVAILABLE', '工作流存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new WorkflowService(new PgWorkflowRepository(ctx.pool), {
      projects: new PgWorkflowProjectLookup(ctx.pool),
      models: new PgWorkflowModelLookup(ctx.pool),
      audit: auditService(ctx),
    });
    services.set(ctx.pool, instance);
  }
  return instance;
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function ifMatch(req) {
  return req.headers['if-match'];
}

function readContext(ctx, req, { creating = false } = {}) {
  return {
    workspaceId: creating ? creationWorkspaceId(ctx) : businessWorkspaceId(ctx),
    actor: ctx.user || null,
    ip: req.socket?.remoteAddress ?? null,
    requestId: req.headers['x-request-id'] ?? null,
  };
}

function setInstanceEtag(res, instance) {
  res.setHeader('ETag', `"r${instance.revision}"`);
}

export function routes() {
  return [
    // ---- 任务类型库 ----
    {
      method: 'GET',
      pattern: /^\/api\/task-types$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        const enabledOnly = ['1', 'true'].includes(url.searchParams.get('enabledOnly'));
        reply(res, 200, await service(ctx).listTaskTypes({ enabledOnly }));
        return true;
      },
    },

    // ---- 模板库 ----
    {
      method: 'GET',
      pattern: /^\/api\/workflow-templates$/,
      async handler({ ctx, url, res, reply }) {
        requireViewer(ctx);
        const query = queryObject(url);
        reply(res, 200, await service(ctx).listTemplates({
          taskType: query.taskType || null,
          status: query.status || null,
          workspaceId: businessWorkspaceId(ctx),
        }));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/workflow-templates$/,
      async handler({ ctx, req, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).createTemplate(body || {}, readContext(ctx, req, { creating: true }));
        reply(res, 201, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/workflow-templates\/([^/]+)\/versions$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).listTemplateVersions(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        }));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/workflow-templates\/([^/]+)\/versions\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).getTemplate(match[1], match[2], {
          workspaceId: businessWorkspaceId(ctx),
        }));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/workflow-templates\/([^/]+)\/versions$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).appendTemplateVersion(match[1], body || {}, readContext(ctx, req));
        reply(res, 201, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/workflow-templates\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).getTemplate(match[1], null, {
          workspaceId: businessWorkspaceId(ctx),
        }));
        return true;
      },
    },

    // ---- 交付项实例 ----
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/deliverables\/([^/]+)\/workflow$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).getDeliverableInstance(
          match[1], match[2], match[3], { workspaceId: businessWorkspaceId(ctx) },
        );
        setInstanceEtag(res, result.instance);
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/deliverables\/([^/]+)\/workflow$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).createInstance(
          match[1], match[2], match[3], body || {}, readContext(ctx, req, { creating: true }),
        );
        setInstanceEtag(res, result.instance);
        reply(res, 201, result);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/workflow-instances\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).getInstance(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        });
        setInstanceEtag(res, result.instance);
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/workflow-instances\/([^/]+)$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).updateInstance(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setInstanceEtag(res, result.instance);
        reply(res, 200, result);
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/workflow-instances\/([^/]+)\/save-as-template$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).saveInstanceAsTemplate(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        reply(res, 201, result);
        return true;
      },
    },
  ];
}
