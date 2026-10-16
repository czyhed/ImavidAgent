// 系统页真实接口（Issue #29）：成员、账本、价格与审计日志。
// 只做请求与展示值的薄封装；调用方传入 useBackend() 的 apiCall，
// 令牌与会话只存在 HttpOnly Cookie / 内存中，绝不写入 localStorage、URL 或日志。

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ---- 成员 ----
export function listUsers(apiCall) {
  return apiCall('/api/users');
}

export function createUser(apiCall, body) {
  return apiCall('/api/users', body);
}

export function updateUser(apiCall, id, patch) {
  return apiCall(`/api/users/${encodeURIComponent(id)}`, patch);
}

// ---- 账本 ----
export function getBillingSummary(apiCall, { from, to } = {}) {
  return apiCall(`/api/billing${queryString({ from, to })}`);
}

export function getBillingLedger(apiCall, { limit = 20, offset = 0 } = {}) {
  return apiCall(`/api/billing/ledger${queryString({ limit, offset })}`);
}

export function getBillingPrices(apiCall, { limit = 50, offset = 0 } = {}) {
  return apiCall(`/api/billing/prices${queryString({ limit, offset })}`);
}

export function saveBillingPrice(apiCall, body) {
  return apiCall('/api/billing/prices', body);
}

export function postBillingAdjustment(apiCall, body) {
  return apiCall('/api/billing/adjustments', body);
}

export function quoteBilling(apiCall, body) {
  return apiCall('/api/billing/quote', body);
}

// ---- 审计日志 ----
export function listAuditLogs(apiCall, { limit = 20, offset = 0, action, result } = {}) {
  return apiCall(`/api/audit-logs${queryString({ limit, offset, action, result })}`);
}

// CSV 由普通链接下载：Cookie 会话鉴权，不拼接任何令牌。
export function auditExportUrl({ action, result } = {}) {
  return `/api/audit-logs/export.csv${queryString({ action, result })}`;
}

// ---- 展示值 ----

export const ROLE_LABELS = Object.freeze({ admin: '管理员', operator: '运营', viewer: '只读' });

export const LEDGER_TYPE_LABELS = Object.freeze({
  adjustment: '人工调账',
  reserve: '预占',
  release: '释放预占',
  settle: '结算',
  pending_price: '待核价',
  supplement: '补价',
  cost_only: '仅记成本',
});

export const UNIT_LABELS = Object.freeze({
  image: '张',
  call: '次',
  second: '秒',
  minute: '分钟',
  character: '字符',
  thousand_characters: '千字符',
  token: 'token',
  thousand_tokens: '千 token',
  million_tokens: '百万 token',
});

export const RESULT_LABELS = Object.freeze({ success: '成功', failure: '失败' });

export function roleLabel(role) {
  return ROLE_LABELS[role] || '未知角色';
}

export function ledgerTypeLabel(type) {
  return LEDGER_TYPE_LABELS[type] || type || '未知';
}

export function unitLabel(unit) {
  return UNIT_LABELS[unit] || unit || '—';
}

export function formatCents(value) {
  if (value === null || value === undefined) return '—';
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}

export function formatMicros(value) {
  if (value === null || value === undefined) return '—';
  const micros = Number(value);
  if (!Number.isSafeInteger(micros)) return '—';
  return `¥${(micros / 1_000_000).toFixed(6)}`;
}

// 流水金额按业务含义展示，不把预占或仅记成本误显示为余额变动。
export function ledgerAmount(entry) {
  if (!entry) return '—';
  const amount = entry.amountCents;
  switch (entry.entryType) {
    case 'adjustment':
      if (!Number.isSafeInteger(amount)) return '—';
      return `${amount > 0 ? '+' : '-'}${formatCents(Math.abs(amount))}`;
    case 'reserve':
      return `预占 ${formatCents(amount)}`;
    case 'release':
      return `释放 ${formatCents(amount)}`;
    case 'settle':
      return `结算 ${formatCents(amount)}`;
    case 'supplement':
      return `补价 ${formatCents(amount)}`;
    case 'pending_price':
      return '待核价（金额未定）';
    case 'cost_only':
      return `成本 ${formatMicros(entry.costMicros)}`;
    default:
      return formatCents(amount);
  }
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function formatPriceUnit(unitPrice, unit) {
  if (unitPrice === null || unitPrice === undefined) return '—';
  return `¥${unitPrice} / ${unitLabel(unit)}`;
}

export function auditObjectLabel(log) {
  if (!log?.targetType && !log?.targetId) return '—';
  return [log.targetType, log.targetId].filter(Boolean).join(' · ');
}
