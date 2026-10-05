import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.mjs';
import { businessWorkspaceId } from '../access.mjs';
import { AssetIndexService, PgAssetRepository } from '../assets-index.mjs';

// 素材路由（Issue #4）。自动发现约定：导出 routes()，每项 { method, pattern, handler }。
// handler 从 ctx 读取 pool / assetsIndex / assets / session，返回 true 表示已处理。
// 所有接口在启用账号体系（ctx.auth）后都要求有效会话；下载接口额外显式校验一次。
const services = new WeakMap();

function service(ctx) {
  // 登录启用时按会话工作空间隔离素材；关闭时沿用历史 'local'。
  const workspaceId = businessWorkspaceId(ctx) || 'local';
  if (ctx.assetsIndex) {
    // 生产注入单一实例；测试替身没有 forWorkspace 时保持原样。
    return typeof ctx.assetsIndex.forWorkspace === 'function'
      ? ctx.assetsIndex.forWorkspace(workspaceId)
      : ctx.assetsIndex;
  }
  if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '素材存储暂不可用。', 503);
  let scoped = services.get(ctx.pool);
  if (!scoped) {
    scoped = new Map();
    services.set(ctx.pool, scoped);
  }
  let instance = scoped.get(workspaceId);
  if (!instance) {
    instance = new AssetIndexService(
      new PgAssetRepository(ctx.pool, { workspaceId }),
      { workspaceId },
    );
    scoped.set(workspaceId, instance);
  }
  return instance;
}

function requireSession(ctx) {
  if (ctx.auth && !ctx.session) throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function safeContentType(value) {
  const type = String(value || '');
  return /^(image|video)\/[a-z0-9.+-]+$/i.test(type) ? type : 'application/octet-stream';
}

function safeFilename(asset) {
  const raw = String(asset.filename || `asset-${asset.id}`).replace(/[^\w.-]+/g, '_');
  return raw.slice(0, 120) || `asset-${asset.id}`;
}

async function sendFile(ctx, id, res, { download }) {
  requireSession(ctx);
  const index = service(ctx);
  const asset = await index.load(id);
  if (asset.fileAvailable === false) {
    throw new AppError('ASSET_UNAVAILABLE', '素材文件缺失，记录仍保留。', 410);
  }
  if (!ctx.assets || typeof ctx.assets.get !== 'function') {
    throw new AppError('STORAGE_UNAVAILABLE', '对象存储暂不可用。', 503);
  }
  let stream;
  try {
    stream = await ctx.assets.get({ key: asset.objectKey, contentType: asset.contentType });
  } catch {
    await index.markUnavailable(asset.id, '对象存储中找不到文件').catch(() => {});
    throw new AppError('ASSET_UNAVAILABLE', '素材文件缺失，记录仍保留。', 410);
  }
  const headers = {
    'Content-Type': safeContentType(asset.contentType),
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safeFilename(asset)}"`,
    'Cache-Control': 'private, no-store',
  };
  if (Number.isFinite(Number(asset.bytes)) && Number(asset.bytes) >= 0) {
    headers['Content-Length'] = String(Number(asset.bytes));
  }
  res.writeHead(200, headers);
  try {
    await pipeline(stream, res);
  } catch {
    // 流可能已经开始，无法再改状态码；保留记录并标为不可用。
    await index.markUnavailable(asset.id, '读取对象存储文件失败').catch(() => {});
    res.destroy();
  }
  return true;
}

// GET /api/assets            列表（稳定游标、搜索、筛选、统计）
// GET /api/assets/:id        详情与版本链
// GET /api/assets/:id/versions  版本链
// GET /api/assets/:id/image  原图（inline）
// GET /api/assets/:id/download 原图下载（attachment）
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/assets$/,
      async handler({ ctx, url, res, reply }) {
        requireSession(ctx);
        reply(res, 200, await service(ctx).list(queryObject(url)));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/assets\/([^/]+)\/versions$/,
      async handler({ ctx, match, res, reply }) {
        requireSession(ctx);
        reply(res, 200, await service(ctx).versions(match[1]));
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/assets\/([^/]+)\/(image|download)$/,
      async handler({ ctx, match, res }) {
        return sendFile(ctx, match[1], res, { download: match[2] === 'download' });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/assets\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireSession(ctx);
        reply(res, 200, await service(ctx).detail(match[1]));
        return true;
      },
    },
  ];
}
