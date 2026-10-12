import { AppError } from '../errors.mjs';
import { businessWorkspaceId, requireOperator, requireViewer } from '../access.mjs';
import { auditService } from '../audit.mjs';
import { ExportService, MinioExportStore, PgExportRepository } from '../export.mjs';

// 由 routes/index.mjs 自动发现。测试可通过 ctx.export 注入内存导出服务。
// 读接口（列表 / 详情 / 下载）要求查看者；创建导出要求运营及以上。
//
// 创建导出使用请求体幂等键：同一键重复提交返回原导出记录（created=false），
// 不重新生成 ZIP、不重复上传；同一键不同项目或方案版本返回 409。
// 导出不创建生成任务、不扣生成费，因此没有预占或账本调用。
const services = new WeakMap();

function actorId(ctx) {
  return (ctx.session?.user || ctx.user)?.id || 'local';
}

function service(ctx) {
  if (ctx.export) return ctx.export;
  if (!ctx.pool) throw new AppError('EXPORT_UNAVAILABLE', '导出存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new ExportService(new PgExportRepository(ctx.pool), {
      objectStoreFactory: () => new MinioExportStore(),
      audit: auditService(ctx),
    });
    services.set(ctx.pool, instance);
  }
  return instance;
}

function readContext(ctx, req) {
  return {
    workspaceId: businessWorkspaceId(ctx),
    actorId: actorId(ctx),
    actor: ctx.user || null,
    ip: req.socket?.remoteAddress ?? null,
    requestId: req.headers['x-request-id'] ?? null,
  };
}

// 只使用服务端生成并清洗过的文件名；ASCII 回退 + RFC 5987 同时兼容常见解压器。
function contentDisposition(name) {
  const fallback = String(name || 'export.zip')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'export.zip';
  const encoded = encodeURIComponent(String(name || 'export.zip')).replace(/'/g, '%27');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function routes() {
  return [
    // ---- 列出项目导出记录 ----
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/exports$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).listExports(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        }));
        return true;
      },
    },

    // ---- 创建导出：只聚合审核通过的版本；幂等键重复返回原记录 ----
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/exports$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).createExport(match[1], body || {}, readContext(ctx, req));
        if (result.created) res.setHeader('Location', `/api/exports/${result.export.id}`);
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },

    // ---- 导出详情（不含对象键、桶名或内部地址） ----
    {
      method: 'GET',
      pattern: /^\/api\/exports\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, await service(ctx).getExport(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        }));
        return true;
      },
    },

    // ---- 下载 ZIP ----
    {
      method: 'GET',
      pattern: /^\/api\/exports\/([^/]+)\/download$/,
      async handler({ ctx, req, match, res }) {
        requireViewer(ctx);
        const result = await service(ctx).downloadExport(match[1], readContext(ctx, req));
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': contentDisposition(result.export.fileName),
          'Content-Length': String(result.content.length),
          'Cache-Control': 'private, no-store',
        });
        res.end(result.content);
        return true;
      },
    },
  ];
}
