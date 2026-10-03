import { AppError } from './errors.mjs';

// 审计日志与任务时间线（Issue #8）。
//
// 两张表都只追加：服务与仓储不提供修改、删除方法，迁移里还有触发器拒绝 UPDATE/DELETE。
// 日志详情在写入前递归脱敏：密码、令牌、密钥、连接串不会落库，提示词全文单独存一列，
// 只有管理员读取时才返回，CSV 导出永远不含全文。
//
// 未合并的模块（#7 计费、#12 项目、#17 审核）通过 recordAudit()/AuditService.record()
// 使用本模块；当前已接入登录、成员、商品资料确认与生成任务状态。

export const JOB_EVENTS = Object.freeze([
  'queued', 'submitting', 'running', 'storing', 'succeeded', 'failed', 'unknown',
  'cancelled', 'reconciled',
]);

export const AUDIT_RESULTS = Object.freeze(['success', 'failure']);
export const MAX_PAGE_SIZE = 100;
export const EXPORT_LIMIT = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.-]{2,119}$/;
const TARGET_TYPE = /^[a-z][a-z0-9_.-]{0,49}$/;
const ROLES = ['admin', 'operator', 'viewer'];

const REDACTED = '[已脱敏]';
const PROMPT_HIDDEN = '[提示词全文仅管理员可见]';
const MAX_DETAIL_DEPTH = 6;
const MAX_DETAIL_KEYS = 100;
const MAX_DETAIL_ARRAY = 50;
const MAX_DETAIL_STRING = 2000;
const MAX_PROMPT = 16000;

// 规范化为只含小写字母和数字后的敏感键名。只匹配明确的凭据字段，避免误伤
// idempotencyKey 等普通业务编号。
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'authorization', 'cookie',
  'setcookie', 'credential', 'credentials', 'dsn', 'ciphertext', 'encryptionkey',
  'connectionstring', 'databaseurl', 'privatekey', 'secretkey', 'accesskey', 'apikey',
  'sessiontoken', 'refreshtoken', 'accesstoken',
]);
const SENSITIVE_SUFFIXES = ['apikey', 'secretkey', 'privatekey', 'accesskey', 'sessiontoken', 'refreshtoken', 'accesstoken'];

function isSensitiveKey(key) {
  const normalized = String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

// 自由文本里的连接串、Bearer 令牌、已知密钥前缀与 URL 凭据参数也要脱敏。
export function redactText(value) {
  let text = String(value);
  text = text.replace(
    /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|clickhouse|https?|wss?):\/\/)([^@\s/]+)@/gi,
    `$1${REDACTED}@`,
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, `Bearer ${REDACTED}`);
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED);
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED);
  text = text.replace(
    /([?&](?:password|passwd|pwd|token|secret|api_?key|access_?key|secret_?key|authorization)=)[^&\s#]*/gi,
    `$1${REDACTED}`,
  );
  return text;
}

export function sanitizeDetail(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return redactText(value.slice(0, MAX_DETAIL_STRING));
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type !== 'object') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DETAIL_DEPTH) return '[深度超限]';
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_DETAIL_ARRAY)
        .map(item => sanitizeDetail(item, depth + 1, seen));
      if (value.length > MAX_DETAIL_ARRAY) items.push(`[已截断 ${value.length - MAX_DETAIL_ARRAY} 项]`);
      return items;
    }
    const output = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (count >= MAX_DETAIL_KEYS) {
        output.truncated = true;
        break;
      }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const safeKey = redactText(String(key)).slice(0, 100);
      if (isSensitiveKey(key)) output[safeKey] = REDACTED;
      else if (String(key).toLowerCase() === 'prompt') output[safeKey] = PROMPT_HIDDEN;
      else output[safeKey] = sanitizeDetail(item, depth + 1, seen);
      count += 1;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function normalizeDetail(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    throw new AppError('INVALID_DETAIL', '审计详情必须是 JSON 对象。');
  }
  return sanitizeDetail(value) || {};
}

function normalizeAction(value, { prefix = false } = {}) {
  const text = String(value ?? '').trim();
  if (!ACTION.test(text) || text.includes('..') || (!prefix && text.endsWith('.'))) {
    throw new AppError('INVALID_ACTION', '审计动作格式不正确。');
  }
  if (!text.includes('.')) throw new AppError('INVALID_ACTION', '审计动作必须包含模块前缀，例如 auth.login.succeeded。');
  return text;
}

function normalizeTargetType(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (!TARGET_TYPE.test(text)) throw new AppError('INVALID_TARGET', '审计对象类型格式不正确。');
  return text;
}

function normalizeTargetId(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > 200 || /[\u0000-\u001f]/.test(text)) {
    throw new AppError('INVALID_TARGET', '审计对象编号格式不正确。');
  }
  return text;
}

function normalizeResult(value) {
  if (value === undefined || value === null || value === '') return 'success';
  if (!AUDIT_RESULTS.includes(value)) throw new AppError('INVALID_RESULT', '审计结果只能是 success 或 failure。');
  return value;
}

function normalizePrompt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError('INVALID_PROMPT', '提示词必须是文本。');
  if (value.length > MAX_PROMPT) throw new AppError('INVALID_PROMPT', `提示词不能超过 ${MAX_PROMPT} 个字符。`);
  return value;
}

function optionalText(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > max) throw new AppError('INVALID_TEXT', `${label}格式不正确。`);
  return text;
}

function optionalUuid(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!UUID.test(text)) throw new AppError('INVALID_ID', `${label}格式不正确。`);
  return text;
}

function normalizeActor(actor) {
  if (!actor) return null;
  const id = optionalUuid(actor.id, '操作者编号');
  if (!id) throw new AppError('INVALID_ACTOR', '审计操作者缺少编号。');
  const role = actor.role === undefined || actor.role === null ? null : String(actor.role);
  if (role !== null && !ROLES.includes(role)) throw new AppError('INVALID_ACTOR', '审计操作者角色不正确。');
  return {
    id,
    workspaceId: optionalUuid(actor.workspaceId, '工作空间编号'),
    email: optionalText(actor.email, '操作者邮箱', 254),
    role,
  };
}

function normalizeDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError('INVALID_FILTER', `${label}不是有效时间。`);
  return date;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new AppError('INVALID_PAGINATION', `每页数量需为 1–${MAX_PAGE_SIZE}。`);
  }
  return limit;
}

function normalizeOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new AppError('INVALID_PAGINATION', '分页偏移量不正确。');
  }
  return offset;
}

export function normalizeListQuery(raw = {}) {
  const filters = {
    limit: normalizeLimit(raw.limit),
    offset: normalizeOffset(raw.offset),
    actorId: optionalUuid(raw.actorId, '操作者编号'),
    targetType: normalizeTargetType(raw.targetType),
    targetId: normalizeTargetId(raw.targetId),
    result: raw.result === undefined || raw.result === '' ? null : normalizeResult(raw.result),
    action: null,
    actionPrefix: null,
    from: normalizeDate(raw.from, '开始时间'),
    to: normalizeDate(raw.to, '结束时间'),
  };
  const action = String(raw.action ?? '').trim();
  if (action) {
    if (action.endsWith('*')) filters.actionPrefix = normalizeAction(action.slice(0, -1), { prefix: true });
    else filters.action = normalizeAction(action);
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AppError('INVALID_FILTER', '开始时间不能晚于结束时间。');
  }
  return filters;
}

export function normalizeJobQuery(raw = {}) {
  const jobId = optionalUuid(raw.jobId, '任务编号');
  if (!jobId) throw new AppError('INVALID_JOB_ID', '请提供任务编号。');
  const event = raw.event === undefined || raw.event === null || raw.event === '' ? null : String(raw.event);
  if (event !== null && !JOB_EVENTS.includes(event)) {
    throw new AppError('INVALID_JOB_EVENT', '任务事件类型不正确。');
  }
  return {
    jobId,
    event,
    limit: normalizeLimit(raw.limit),
    offset: normalizeOffset(raw.offset),
  };
}

// 角色范围：#6 尚未合并，这里只做最小检查——已有账号时管理员可看全部，
// 运营/查看者只看自己的事件；SJ_AUTH=off 的本机单用户模式可读全部，但永远不返回提示词全文。
export function auditScope(ctx) {
  const user = ctx?.user || null;
  if (user) {
    return {
      admin: user.role === 'admin',
      canReadAll: user.role === 'admin',
      actorId: user.id,
      workspaceId: user.workspaceId ?? null,
      local: false,
      actor: {
        id: user.id,
        workspaceId: user.workspaceId ?? null,
        email: user.email ?? null,
        role: user.role ?? null,
      },
    };
  }
  return {
    admin: false,
    canReadAll: true,
    actorId: null,
    workspaceId: null,
    local: true,
    actor: null,
  };
}

function applyScope(filters, scope) {
  if (!scope || scope.canReadAll) return;
  if (!scope.actorId) throw new AppError('FORBIDDEN', '无权查看审计日志。', 403);
  filters.actorId = scope.actorId;
}

export function publicAudit(row, { includePrompt = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? null,
    actorId: row.actorId ?? null,
    actorEmail: row.actorEmail ?? null,
    actorRole: row.actorRole ?? null,
    action: row.action,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    result: row.result,
    detail: row.detail || {},
    ip: row.ip ?? null,
    requestId: row.requestId ?? null,
    // 非管理员得到 null，但 hasPrompt 仍提示存在全文，避免误以为没有记录。
    prompt: includePrompt ? (row.prompt ?? null) : null,
    hasPrompt: Boolean(row.prompt),
    createdAt: row.createdAt,
  };
}

export function publicJobEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.jobId,
    event: row.event,
    actorId: row.actorId ?? null,
    upstreamId: row.upstreamId ?? null,
    detail: row.detail || {},
    createdAt: row.createdAt,
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  // 防 CSV 公式注入：以 = + - @ 制表符或回车开头的单元格加前缀单引号。
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export class AuditService {
  constructor(repository, { now = () => new Date(), exportLimit = EXPORT_LIMIT } = {}) {
    if (!repository) throw new AppError('AUDIT_UNAVAILABLE', '审计仓储未配置。', 500);
    this.repository = repository;
    this.now = now;
    this.exportLimit = exportLimit;
  }

  async record(entry = {}) {
    const actor = normalizeActor(entry.actor);
    const workspaceId = optionalUuid(entry.workspaceId, '工作空间编号')
      ?? actor?.workspaceId
      ?? null;
    const createdAt = entry.createdAt ? normalizeDate(entry.createdAt, '记录时间') : this.now();
    const row = {
      id: null,
      workspaceId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? null,
      action: normalizeAction(entry.action),
      targetType: normalizeTargetType(entry.targetType),
      targetId: normalizeTargetId(entry.targetId),
      result: normalizeResult(entry.result),
      detail: normalizeDetail(entry.detail),
      prompt: normalizePrompt(entry.prompt),
      ip: optionalText(entry.ip, 'IP', 100),
      requestId: optionalText(entry.requestId, '请求编号', 200),
      createdAt,
    };
    return publicAudit(await this.repository.insertAudit(row), { includePrompt: true });
  }

  async list(query = {}, scope = null) {
    const filters = normalizeListQuery(query);
    applyScope(filters, scope);
    const page = await this.repository.listAudit(filters);
    const nextOffset = filters.offset + page.rows.length < page.total
      ? filters.offset + page.rows.length
      : null;
    return {
      logs: page.rows.map(row => publicAudit(row, { includePrompt: scope?.admin === true })),
      total: page.total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset,
      canViewPrompt: scope?.admin === true,
    };
  }

  async exportCsv(query = {}, scope = null) {
    const filters = normalizeListQuery(query);
    applyScope(filters, scope);
    const page = await this.repository.listAudit({
      ...filters, limit: this.exportLimit, offset: 0,
    });
    const header = [
      'id', 'created_at', 'actor_id', 'actor_email', 'actor_role', 'action',
      'target_type', 'target_id', 'result', 'detail', 'ip', 'request_id',
    ];
    const lines = [header.join(',')];
    for (const row of page.rows) {
      // 再次脱敏，防止旧记录或外部导入绕过写入时校验。提示词全文永远不导出。
      const detail = JSON.stringify(sanitizeDetail(row.detail || {}) ?? {});
      lines.push([
        row.id, csvTimestamp(row.createdAt), row.actorId, row.actorEmail, row.actorRole,
        row.action, row.targetType, row.targetId, row.result, detail, row.ip, row.requestId,
      ].map(csvCell).join(','));
    }
    const truncated = page.total > page.rows.length;
    const filterSummary = {
      action: filters.action,
      actionPrefix: filters.actionPrefix,
      actorId: filters.actorId,
      targetType: filters.targetType,
      targetId: filters.targetId,
      result: filters.result,
      from: filters.from,
      to: filters.to,
      truncated,
    };
    // 导出动作本身留痕；只记录筛选条件与行数，不记录被导出的内容。
    await this.record({
      actor: scope?.actor || null,
      workspaceId: scope?.workspaceId || null,
      action: 'audit.exported',
      targetType: 'audit_log',
      result: 'success',
      detail: { format: 'csv', rowCount: page.rows.length, filters: filterSummary },
    });
    return {
      content: `${lines.join('\r\n')}\r\n`,
      filename: `audit-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`,
      rowCount: page.rows.length,
      truncated,
    };
  }

  async jobEvent(entry = {}) {
    const jobId = optionalUuid(entry.jobId, '任务编号');
    if (!jobId) throw new AppError('INVALID_JOB_ID', '任务事件缺少任务编号。');
    const event = String(entry.event ?? '').trim();
    if (!JOB_EVENTS.includes(event)) throw new AppError('INVALID_JOB_EVENT', '任务事件类型不正确。');
    const createdAt = entry.createdAt ? normalizeDate(entry.createdAt, '记录时间') : this.now();
    const row = {
      id: null,
      jobId,
      event,
      actorId: optionalUuid(entry.actorId, '操作者编号'),
      upstreamId: optionalText(entry.upstreamId, '上游任务编号', 200),
      detail: normalizeDetail(entry.detail),
      createdAt,
    };
    return publicJobEvent(await this.repository.insertJobEvent(row));
  }

  async timeline(query = {}) {
    const filters = normalizeJobQuery(query);
    const page = await this.repository.listJobEvents(filters);
    const nextOffset = filters.offset + page.rows.length < page.total
      ? filters.offset + page.rows.length
      : null;
    return {
      jobId: filters.jobId,
      events: page.rows.map(publicJobEvent),
      total: page.total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset,
    };
  }
}

function auditRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    result: row.result,
    detail: row.detail,
    prompt: row.prompt,
    ip: row.ip,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

function jobEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    event: row.event,
    actorId: row.actor_id,
    upstreamId: row.upstream_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export class PgAuditRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async insertAudit(row) {
    const result = await this.pool.query(
      `INSERT INTO sj_audit_logs
        (workspace_id,actor_id,actor_email,actor_role,action,target_type,target_id,
         result,detail,prompt,ip,request_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        row.workspaceId, row.actorId, row.actorEmail, row.actorRole, row.action,
        row.targetType, row.targetId, row.result, JSON.stringify(row.detail),
        row.prompt, row.ip, row.requestId, row.createdAt,
      ],
    );
    return auditRow(result.rows[0]);
  }

  async listAudit(filters) {
    const values = [];
    const where = [];
    const bind = value => {
      values.push(value);
      return `$${values.length}`;
    };
    if (filters.actorId) where.push(`actor_id = ${bind(filters.actorId)}`);
    if (filters.action) where.push(`action = ${bind(filters.action)}`);
    if (filters.actionPrefix) {
      where.push(`action LIKE ${bind(`${escapeLike(filters.actionPrefix)}%`)} ESCAPE '\\'`);
    }
    if (filters.targetType) where.push(`target_type = ${bind(filters.targetType)}`);
    if (filters.targetId) where.push(`target_id = ${bind(filters.targetId)}`);
    if (filters.result) where.push(`result = ${bind(filters.result)}`);
    if (filters.from) where.push(`created_at >= ${bind(filters.from)}`);
    if (filters.to) where.push(`created_at <= ${bind(filters.to)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // 传副本：pg 可能在连接就绪后才读取参数数组，不能让它看到后加的分页参数。
    const totalResult = await this.pool.query(
      `SELECT count(*)::int AS n FROM sj_audit_logs ${whereSql}`,
      [...values],
    );
    const rows = await this.pool.query(
      `SELECT * FROM sj_audit_logs ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${bind(filters.limit)} OFFSET ${bind(filters.offset)}`,
      values,
    );
    return { rows: rows.rows.map(auditRow), total: Number(totalResult.rows[0].n) };
  }

  async insertJobEvent(row) {
    const result = await this.pool.query(
      `INSERT INTO sj_job_events (job_id,event,actor_id,upstream_id,detail,created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [row.jobId, row.event, row.actorId, row.upstreamId, JSON.stringify(row.detail), row.createdAt],
    );
    return jobEventRow(result.rows[0]);
  }

  async listJobEvents(filters) {
    const values = [filters.jobId];
    const where = ['job_id = $1'];
    if (filters.event) {
      values.push(filters.event);
      where.push(`event = $${values.length}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const totalResult = await this.pool.query(
      `SELECT count(*)::int AS n FROM sj_job_events ${whereSql}`,
      values,
    );
    const rows = await this.pool.query(
      `SELECT * FROM sj_job_events ${whereSql}
       ORDER BY created_at ASC, id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, filters.offset],
    );
    return { rows: rows.rows.map(jobEventRow), total: Number(totalResult.rows[0].n) };
  }
}

// 一个连接池复用一个服务；测试可通过 ctx.audit 注入内存仓储。
const services = new WeakMap();

export function auditService(ctx) {
  if (ctx?.audit) return ctx.audit;
  if (!ctx?.pool) return null;
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new AuditService(new PgAuditRepository(ctx.pool));
    services.set(ctx.pool, instance);
  }
  return instance;
}

// 路由里的一行式写入：自动带入当前账号、IP 与请求编号。
export async function recordAudit(ctx, req, entry = {}) {
  const audit = auditService(ctx);
  if (!audit) return null;
  return audit.record({
    ...entry,
    actor: entry.actor || ctx?.user || null,
    ip: entry.ip ?? req?.socket?.remoteAddress ?? null,
    requestId: entry.requestId ?? req?.headers?.['x-request-id'] ?? null,
  });
}
