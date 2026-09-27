import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { AppError, safeError } from './errors.mjs';
import { publicJob, UUID } from './jobs.mjs';
import { dispatchRoute, parseCookies } from './routes/index.mjs';
import { SESSION_COOKIE } from './auth.mjs';
import {
  businessWorkspaceId, requireAdmin, requireJobAccess, requireOperator, requireViewer,
} from './access.mjs';
import { MAX_UPLOAD_BYTES } from './uploads.mjs';

const staticFiles = new Map([
  ['/', ['web/dist/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['web/dist/index.html', 'text/html; charset=utf-8']],
  // 旧原型保留为回退入口，React 构建产物不可用时仍可打开。
  ['/prototype/prototype.html', ['prototype/prototype.html', 'text/html; charset=utf-8']],
  ['/prototype/generation.js', ['prototype/generation.js', 'text/javascript; charset=utf-8']],
  ['/prototype/generation.css', ['prototype/generation.css', 'text/css; charset=utf-8']],
  ['/generation.js', ['prototype/generation.js', 'text/javascript; charset=utf-8']],
  ['/generation.css', ['prototype/generation.css', 'text/css; charset=utf-8']],
]);

// Vite 产物带内容哈希（name-<8 位哈希>.ext）；只放行严格匹配的文件名，不接受路径分隔符或点号。
const HASHED_ASSET = /^\/assets\/([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)-([A-Za-z0-9_-]{8})\.(js|css|webp|png|jpg|svg|woff2)$/;
const ASSET_TYPES = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', webp: 'image/webp',
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', woff2: 'font/woff2',
};
const COMPRESSIBLE = new Set(['js', 'css', 'svg']);
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
// 哈希文件内容不可变，压缩结果按「文件名+编码」缓存在内存里。
const compressedCache = new Map();
async function compressFor(key, content, encoding) {
  const cacheKey = `${key}|${encoding}`;
  if (key && compressedCache.has(cacheKey)) return compressedCache.get(cacheKey);
  const out = encoding === 'br'
    ? await brotliAsync(content, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: key ? 9 : 4 } })
    : await gzipAsync(content);
  if (key) compressedCache.set(cacheKey, out);
  return out;
}
const SLOW_API_MS = 500;

export function createServer({ store, assets, registry, service, channels, auth, gateway, pool, products, projects, assetsIndex, audit, uploads, intake, vision, linkParser, workflow, run, refine, review, export: exportService, creationStore, creationProducts, creationProjects, creationLifecycle, creationMedia, modelHub, port, root }) {
  const csrf = randomBytes(32).toString('hex');
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  return http.createServer(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const apiPath = String(req.url || '').startsWith('/api/');
    if (apiPath) {
      // 在响应头写出前注入耗时；慢请求只记录方法、去掉查询串和 ID 的路径、状态码与耗时。
      const writeHead = res.writeHead;
      res.writeHead = function patchedWriteHead(status, ...rest) {
        const duration = Number(process.hrtime.bigint() - startedAt) / 1e6;
        if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${duration.toFixed(1)}`);
        if (duration > SLOW_API_MS) {
          const safePath = String(req.url).split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
          console.warn(`slow-api ${req.method} ${safePath} ${status} ${Math.round(duration)}ms`);
        }
        return writeHead.call(this, status, ...rest);
      };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const actualPort = port || req.socket.localPort;
      const hosts = new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`]);
      // 反向代理部署时只放行显式配置的公网 Host；默认仍只允许本机。
      for (const entry of String(process.env.SJ_ALLOWED_HOSTS || '').split(',')) {
        const value = entry.trim().toLowerCase();
        if (value) hosts.add(value);
      }
      if (!hosts.has(String(req.headers.host || '').toLowerCase())) {
        throw new AppError('HOST_DENIED', '仅允许本机或已配置的访问地址。', 403);
      }
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      const proto = forwardedProto === 'https' || req.socket.encrypted ? 'https' : 'http';
      const origin = req.headers.origin;
      const allowedOrigins = new Set([`${proto}://${req.headers.host}`, process.env.SJ_PUBLIC_ORIGIN].filter(Boolean));
      if (origin && !allowedOrigins.has(origin)) throw new AppError('ORIGIN_DENIED', '不允许跨站请求。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('ORIGIN_DENIED', '不允许跨站请求。', 403);
      const url = new URL(req.url, `${proto}://${req.headers.host}`);
      const path = url.pathname;
      if (creationStore && (path.startsWith('/prototype/') || ['/generation.js', '/generation.css'].includes(path))) {
        throw new AppError('LEGACY_RETIRED', '旧原型入口已退役，请打开创作工作台。', 410);
      }
      let body;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        const token = String(req.headers['x-csrf-token'] || '');
        if (Buffer.byteLength(token) !== Buffer.byteLength(csrf) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) {
          throw new AppError('TOKEN_REQUIRED', '页面会话已失效，请刷新。', 403);
        }
      }
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        // Product images are uploaded as raw bytes because the JSON body limit is 100 KB.
        // Format is still decided by server-side magic-byte inspection, never this header.
        if (req.method === 'POST' && ['/api/product-images', '/api/creation/assets/upload'].includes(path)) {
          const uploadLimit = path === '/api/creation/assets/upload' ? 100 * 1024 * 1024 : MAX_UPLOAD_BYTES;
          const declaredType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (!['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', ...(path.startsWith('/api/creation/') ? ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'] : [])].includes(declaredType)) {
            throw new AppError('UNSUPPORTED_MEDIA_TYPE', '商品图片只接受原始二进制或 PNG/JPEG/WebP 内容类型。', 415);
          }
          const declaredLength = Number(req.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > uploadLimit) {
            throw new AppError('IMAGE_TOO_LARGE', `上传文件不能超过 ${uploadLimit / 1024 / 1024} MB。`, 413);
          }
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > uploadLimit) {
              throw new AppError('IMAGE_TOO_LARGE', `上传文件不能超过 ${uploadLimit / 1024 / 1024} MB。`, 413);
            }
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks);
        } else {
          if (req.headers['content-type'] !== 'application/json') throw new AppError('JSON_REQUIRED', '仅接受 JSON 请求。', 415);
          // Canvas saves include up to 200 nodes and their frozen inputs. Keep the
          // larger budget specific to graph PATCH, not login/chat/model requests.
          const graphPatch = (req.method === 'PATCH' && /^\/api\/creation\/projects\/[a-f0-9-]{36}$/i.test(path)) || (req.method === 'POST' && /^\/api\/creation\/projects\/[a-f0-9-]{36}\/ops$/i.test(path));
          const jsonLimit = graphPatch ? 8 * 1024 * 1024 : 100_000;
          const tooLarge = () => new AppError('TOO_LARGE', graphPatch ? '项目内容超过 8 MB，请减少节点内容后重试。' : '请求体过大。', 413);
          if (Number(req.headers['content-length']) > jsonLimit) { req.resume(); throw tooLarge(); }
          const chunks = [];
          let length = 0;
          // Do not destroy the request socket on early exit: the client needs
          // the 413 JSON response, including when the body is chunked.
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            length += chunk.length;
            if (length > jsonLimit) { req.resume(); throw tooLarge(); }
            chunks.push(chunk);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { throw new AppError('INVALID_JSON', 'JSON 格式错误。'); }
        }
      }
      const hashed = HASHED_ASSET.exec(path);
      const staticEntry = staticFiles.get(path)
        || (hashed ? [`web/dist${path}`, ASSET_TYPES[hashed[3]]] : null);
      if (req.method === 'GET' && staticEntry) {
        let [file, contentType] = staticEntry;
        let content;
        try {
          content = await readFile(new URL(file, root));
        } catch (error) {
          // 未构建 React 产物时回退到旧原型；其余缺失文件仍按 404/503 处理。
          if (creationStore || error.code !== 'ENOENT' || !['/', '/index.html'].includes(path)) throw error;
          [file, contentType] = ['prototype/prototype.html', 'text/html; charset=utf-8'];
          content = await readFile(new URL(file, root));
        }
        const headers = { 'Content-Type': contentType, Vary: 'Accept-Encoding' };
        const ext = hashed ? hashed[3] : (contentType.startsWith('text/html') ? 'html' : '');
        if (hashed) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        if ((hashed ? COMPRESSIBLE.has(ext) : ext === 'html') && content.length > 1024) {
          const accepted = String(req.headers['accept-encoding'] || '');
          const wants = (name) => accepted.split(',').some((part) => part.trim().split(';')[0].toLowerCase() === name);
          const encoding = wants('br') ? 'br' : wants('gzip') ? 'gzip' : null;
          if (encoding) {
            content = await compressFor(hashed ? path : '', content, encoding);
            headers['Content-Encoding'] = encoding;
          }
        }
        headers['Content-Length'] = content.length;
        res.writeHead(200, headers);
        res.end(content);
        return;
      }
      // 配置了账号体系后，除初始化与登录外，所有 /api/* 都要求有效会话。
      // 未配置 auth 时保留旧的本地页面令牌行为，供现有测试与兼容路径使用。
      let session = null;
      if (auth) {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies[SESSION_COOKIE]) session = await auth.authenticate(cookies[SESSION_COOKIE]);
        if (path.startsWith('/api/')) {
          const publicRequest = (req.method === 'GET' && path === '/api/session')
            || (req.method === 'POST' && (path === '/api/session' || path === '/api/setup/admin'));
          if (!publicRequest && !session) throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
          const allowedWhileChanging = (req.method === 'GET' && path === '/api/session')
            || (req.method === 'POST' && path === '/api/account/password')
            || (req.method === 'DELETE' && path === '/api/session');
          if (session?.user.mustChangePassword && !allowedWhileChanging) {
            throw new AppError('PASSWORD_CHANGE_REQUIRED', '首次登录请先修改密码。', 403);
          }
        }
      }
      if (!auth && req.method === 'GET' && path === '/api/session') {
        reply(res, 200, { csrfToken: csrf, mode: 'local-single-user', billing: '以供应商实际账单为准，无自动重试或模型回退。' });
        return;
      }
      // 统一请求上下文：身份只来自会话，路由与服务在此之上做角色和归属校验。
      // auth 未配置时 require* 放行，保留旧的本机单用户页面令牌行为。
      const ctx = {
        pool, store, assets, registry, service, channels, auth, gateway, products, projects, assetsIndex, audit, uploads, intake, vision, linkParser, workflow, run, refine, review, export: exportService, creationStore, creationProducts, creationProjects, creationLifecycle, creationMedia, modelHub, session, user: session?.user, csrf,
        cookies: parseCookies(req.headers.cookie), reply,
      };
      // v2 活动应用只接入创作 API；旧报价、充值和六步业务接口已退役。
      if (creationStore && path.startsWith('/api/')) {
        const activePath = /^\/api\/(?:creation(?:\/|$)|model-hub(?:\/|$)|session$|setup\/admin$|account\/password$|users(?:\/|$)|audit-logs(?:\/|$))/;
        if (!activePath.test(path)) {
          throw new AppError('LEGACY_RETIRED', '旧业务接口已退役，请使用创作工作台。', 410);
        }
      }
      if (req.method === 'GET' && path === '/api/models') {
        requireViewer(ctx);
        reply(res, 200, !registry.checkedAt || Date.now() - registry.checkedAt > 60_000
          ? await registry.refresh() : registry.publicCatalog());
        return;
      }
      if (req.method === 'POST' && path === '/api/models/refresh') {
        requireAdmin(ctx);
        reply(res, 200, await registry.refresh());
        return;
      }
      if (channels && req.method === 'POST' && path === '/api/channels') {
        requireAdmin(ctx);
        reply(res, 201, await channels.add(body));
        return;
      }
      const channelMatch = path.match(/^\/api\/channels\/([^/]+)(?:\/(enabled))?$/);
      if (channels && channelMatch) {
        if (req.method === 'DELETE' && !channelMatch[2]) {
          requireAdmin(ctx);
          reply(res, 200, { channel: await channels.remove(channelMatch[1]) });
          return;
        }
        if (req.method === 'POST' && channelMatch[2] === 'enabled') {
          requireAdmin(ctx);
          reply(res, 200, { channel: await channels.setEnabled(channelMatch[1], body?.enabled) });
          return;
        }
      }
      if (req.method === 'GET' && path === '/api/jobs') {
        requireViewer(ctx);
        // 列表只返回当前工作空间的任务；登录关闭时返回全部历史任务。
        reply(res, 200, { jobs: (await store.list(businessWorkspaceId(ctx))).map(publicJob) });
        return;
      }
      if (req.method === 'POST' && path === '/api/jobs') {
        requireOperator(ctx);
        reply(res, 202, publicJob(await service.create(body, { workspaceId: businessWorkspaceId(ctx) })));
        return;
      }
      const match = path.match(/^\/api\/jobs\/([^/]+)(?:\/(image|reconcile))?$/);
      if (match && UUID.test(match[1])) {
        // 对象归属先于任何读取或下载：猜到的 UUID 不能跨工作空间访问。
        const job = requireJobAccess(ctx, await store.get(match[1]));
        if (req.method === 'GET' && !match[2]) { reply(res, 200, publicJob(job)); return; }
        if (req.method === 'POST' && match[2] === 'reconcile') {
          requireOperator(ctx);
          reply(res, 202, publicJob(await service.reconcile(job.id))); return;
        }
        if (req.method === 'GET' && match[2] === 'image' && job.status === 'succeeded') {
          const stream = await assets.get(job.output);
          res.writeHead(200, {
            'Content-Type': job.output.contentType,
            'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${job.output.filename}"`,
          });
          await pipeline(stream, res);
          return;
        }
      }
      if (path.startsWith('/api/')) {
        if (await dispatchRoute({ method: req.method, path, ctx, req, res, url, body, reply })) return;
      }
      throw new AppError('NOT_FOUND', '页面或接口不存在。', 404);
    } catch (error) {
      if (process.env.SJ_DEBUG_ERRORS === '1' && !(error instanceof AppError)) console.error(error);
      if (!res.headersSent) reply(res, error instanceof AppError ? error.status : 503, { error: safeError(error) });
      else res.destroy();
    }
  });
}
