import { AppError } from './errors.mjs';

// 角色与逐接口鉴权（Issue #6）。
// 单一事实来源：身份只从 ctx.user / ctx.session 读取，路由不得自行解析 Cookie 或请求体。
// 登录未启用（SJ_AUTH=off）时保留本机单用户兼容路径，所有 require* 直接放行；
// 一旦配置了 auth，未登录一律 401，已登录但角色不足或对象不属于当前工作空间一律 403。
// 前端隐藏只是表现，不是安全边界；下载接口与普通读接口使用同一套校验。

export const ROLES = Object.freeze(['admin', 'operator', 'viewer']);
export const ROLE_RANK = Object.freeze({ viewer: 1, operator: 2, admin: 3 });

// 权限分组：读（三角色）/ 写（管理员与运营）/ 管理（仅管理员）。
export const READ_ROLES = Object.freeze(['admin', 'operator', 'viewer']);
export const WRITE_ROLES = Object.freeze(['admin', 'operator']);
export const ADMIN_ROLES = Object.freeze(['admin']);

export function authEnabled(ctx) {
  return Boolean(ctx?.auth);
}

export function currentUser(ctx) {
  return ctx?.user || ctx?.session?.user || null;
}

export function hasRole(user, allowed) {
  if (!user || user.active === false) return false;
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  return roles.includes(user.role);
}

export function requireUser(ctx) {
  if (!authEnabled(ctx)) return null;
  const user = currentUser(ctx);
  if (!user || user.active === false) {
    throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
  }
  return user;
}

export function requireRole(ctx, allowed) {
  if (!authEnabled(ctx)) return null;
  const user = requireUser(ctx);
  if (!hasRole(user, allowed)) {
    throw new AppError('FORBIDDEN', '当前角色无权执行此操作。', 403);
  }
  return user;
}

export const requireViewer = ctx => requireRole(ctx, READ_ROLES);
export const requireOperator = ctx => requireRole(ctx, WRITE_ROLES);
export const requireAdmin = ctx => requireRole(ctx, ADMIN_ROLES);

// 业务工作空间：登录启用时取会话用户的工作空间，关闭时返回 null 表示不限定
// （保留旧的单工作空间数据与本地页面令牌行为）。
export function businessWorkspaceId(ctx) {
  if (!authEnabled(ctx)) return null;
  return requireUser(ctx).workspaceId;
}

// 新对象落库时的归属：登录关闭时沿用历史单工作空间 'local'。
export function creationWorkspaceId(ctx) {
  return businessWorkspaceId(ctx) || 'local';
}

export function jobWorkspaceId(job) {
  if (!job) return null;
  return job.workspaceId ?? job.input?.workspaceId ?? null;
}

export function resourceWorkspaceId(resource) {
  if (!resource) return null;
  return resource.workspaceId ?? resource.input?.workspaceId ?? null;
}

// 对象归属校验：即使猜到 UUID，只要对象不属于当前工作空间就拒绝。
// 任务、图片下载等接口共用此函数。
export function requireJobAccess(ctx, job) {
  if (!job) throw new AppError('NOT_FOUND', '任务不存在。', 404);
  if (!authEnabled(ctx)) return job;
  const user = requireUser(ctx);
  if (jobWorkspaceId(job) !== user.workspaceId) {
    throw new AppError('FORBIDDEN', '无权访问该任务。', 403);
  }
  return job;
}

export function requireWorkspaceAccess(ctx, resource, message = '无权访问该资源。') {
  if (!resource) throw new AppError('NOT_FOUND', '资源不存在。', 404);
  if (!authEnabled(ctx)) return resource;
  const user = requireUser(ctx);
  if (resourceWorkspaceId(resource) !== user.workspaceId) {
    throw new AppError('FORBIDDEN', message, 403);
  }
  return resource;
}
