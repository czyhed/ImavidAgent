import { AppError } from '../errors.mjs';
import { auditScope, auditService } from '../audit.mjs';

// 由 routes/index.mjs 自动发现。只提供读取与导出，没有修改或删除接口；
// 写入由业务模块调用 server/audit.mjs 的 recordAudit() 完成。

function service(ctx) {
  const audit = auditService(ctx);
  if (!audit) throw new AppError('DB_UNAVAILABLE', '审计日志存储暂不可用。', 503);
  return audit;
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function sendCsv(res, exported) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${exported.filename}"`,
  });
  // BOM 便于 Excel 正确识别 UTF-8。
  res.end(`﻿${exported.content}`);
}

// GET /api/audit-logs
// GET /api/audit-logs/export.csv
// GET /api/job-events?jobId=:id
// GET /api/jobs/:id/events
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/audit-logs$/,
      async handler({ ctx, url, res, reply }) {
        reply(res, 200, await service(ctx).list(queryObject(url), auditScope(ctx)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/audit-logs\/export\.csv$/,
      async handler({ ctx, url, res }) {
        const exported = await service(ctx).exportCsv(queryObject(url), auditScope(ctx));
        sendCsv(res, exported);
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/job-events$/,
      async handler({ ctx, url, res, reply }) {
        reply(res, 200, await service(ctx).timeline(queryObject(url)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/jobs\/([^/]+)\/events$/,
      async handler({ ctx, match, url, res, reply }) {
        const query = queryObject(url);
        query.jobId = match[1];
        reply(res, 200, await service(ctx).timeline(query));
        return true;
      },
    },
  ];
}
