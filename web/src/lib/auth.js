// 账号会话与角色可见性（Issue #24）。
// 角色只决定界面显示：服务端始终按会话和角色逐接口鉴权，前端隐藏不是安全边界。
export const ROLE_LABELS = Object.freeze({ admin: '管理员', operator: '运营', viewer: '只读' });
export const WRITE_ROLES = Object.freeze(['admin', 'operator']);

export function roleLabel(role) {
  return ROLE_LABELS[role] || '未登录';
}

// 只有配置了账号体系（SJ_AUTH=on）的 /api/session 才带 authenticated 布尔值；
// 关闭时保留旧的本机单用户响应，页面行为不变。
export function isAuthEnabled(session) {
  return Boolean(session) && typeof session.authenticated === 'boolean';
}

export function sessionUser(session) {
  return isAuthEnabled(session) && session.authenticated ? session.user || null : null;
}

export function sessionRole(session) {
  return sessionUser(session)?.role || null;
}

export function needsSetup(session) {
  return isAuthEnabled(session) && !session.authenticated && session.setupRequired === true;
}

export function mustChangePassword(session) {
  return isAuthEnabled(session) && session.authenticated === true && session.mustChangePassword === true;
}

// 登录关闭时没有角色，沿用现有的全部可写行为；开启后只读角色不能执行写操作。
export function canWrite(session) {
  if (!isAuthEnabled(session)) return true;
  return WRITE_ROLES.includes(sessionRole(session));
}

export function canAdmin(session) {
  if (!isAuthEnabled(session)) return true;
  return sessionRole(session) === 'admin';
}
