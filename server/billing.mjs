import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

// 内部额度账本（Issue #7）。设计约束见 docs/adr/0008：
// - 平台结算金额一律用整数分（amount_cents），供应商成本单独用微元（cost_micros）。
// - 单价可以小于一分，因此这里用 BigInt 按 12 位小数精确计算，再按四舍五入入分，
//   不使用任何浮点乘法。
// - 流水只追加：预占 reserve、结算 settle、释放 release 是三种明确状态；
//   未定价任务写 pending_price（金额 NULL，不是 0），管理员补价写 supplement；
//   项目文本辅助写 cost_only，只记成本，不预占、不扣内部额度。
// - 幂等由「工作空间 + 幂等键」唯一约束与「每任务每状态最多一条」部分唯一索引兜底；
//   业务层先返回已存在的流水，不重复入账。

export const CURRENCY = 'CNY';
export const PRICE_SCALE = 12;
export const MAX_AMOUNT_CENTS = 1_000_000_000_000; // 1e12 分 = 100 亿元
export const MAX_COST_MICROS = 9_000_000_000_000_000;
export const MAX_QUANTITY = 1_000_000_000;
export const DEFAULT_WORKSPACE_ID = 'local';

export const UNITS = Object.freeze([
  'image', 'call', 'second', 'minute', 'character', 'thousand_characters',
  'token', 'thousand_tokens', 'million_tokens',
]);
export const BILLING_MODES = Object.freeze(['chargeable', 'cost_only']);
export const ENTRY_TYPES = Object.freeze([
  'adjustment', 'reserve', 'release', 'settle', 'pending_price', 'supplement', 'cost_only',
]);

const DECIMAL = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const TIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const PRICE_FIELDS = ['capability', 'modelId', 'tier', 'unit', 'unitPrice', 'currency', 'billingMode', 'effectiveFrom', 'note'];
const USAGE_FIELDS = ['capability', 'modelId', 'tier', 'quantity', 'billingMode', 'costMicros'];
const QUOTE_FIELDS = USAGE_FIELDS;
const RESERVE_FIELDS = [...USAGE_FIELDS, 'taskId', 'projectId', 'idempotencyKey', 'reason'];
const COST_ONLY_FIELDS = ['taskId', 'capability', 'modelId', 'tier', 'quantity', 'costMicros', 'projectId', 'idempotencyKey', 'reason', 'reference'];
const SETTLE_FIELDS = ['idempotencyKey', 'reason'];
const RELEASE_FIELDS = ['idempotencyKey', 'reason'];
const SUPPLEMENT_FIELDS = ['amountCents', 'idempotencyKey', 'reason', 'reference'];
const ADJUSTMENT_FIELDS = ['amountCents', 'idempotencyKey', 'reason', 'reference', 'projectId'];

const TEN = 10n;
const PRICE_DENOMINATOR = TEN ** BigInt(PRICE_SCALE);

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function requireObject(value, label = '请求体') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_BODY', `${label}必须是 JSON 对象。`);
  }
}

function rejectUnknown(body, allowed, label = '请求') {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function textField(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (typeof value !== 'string') fail('INVALID_FIELD', `${label}必须是文本。`);
  const text = value.trim();
  if (required && !text) fail('INVALID_FIELD', `${label}不能为空。`);
  if (text.length > max) fail('INVALID_FIELD', `${label}不能超过 ${max} 个字符。`);
  return text || null;
}

function patternField(value, label, pattern, message) {
  const text = textField(value, label, 200, { required: true });
  if (!pattern.test(text)) fail('INVALID_FIELD', message);
  return text;
}

function integerField(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail('INVALID_FIELD', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return number;
}

function amountCentsField(value, label, { signed = false } = {}) {
  const number = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(number)) fail('INVALID_AMOUNT', `${label}必须是整数分。`);
  if (!signed && number < 0) fail('INVALID_AMOUNT', `${label}不能为负数。`);
  if (Math.abs(number) > MAX_AMOUNT_CENTS) fail('INVALID_AMOUNT', `${label}超出允许范围。`);
  if (signed && number === 0) fail('INVALID_AMOUNT', `${label}不能为 0。`);
  return number;
}

function dateField(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_DATE', `${label}必须是 ISO 时间文本。`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_DATE', `${label}格式不正确。`);
  return date;
}

function decimalToScaled(text) {
  const [whole, fraction = ''] = text.split('.');
  const padded = `${fraction}${'0'.repeat(PRICE_SCALE)}`.slice(0, PRICE_SCALE);
  return BigInt(whole) * PRICE_DENOMINATOR + BigInt(padded || '0');
}

function normalizeDecimalText(text) {
  const [whole, fraction = ''] = String(text).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function parseUnitPrice(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !DECIMAL.test(raw.trim())) {
    fail('INVALID_PRICE', 'unitPrice 必须是 0–999999999.999999999999 的十进制文本，最多 12 位小数。');
  }
  const text = normalizeDecimalText(raw.trim());
  return { text, scaled: decimalToScaled(text) };
}

function roundHalfUp(numerator, denominator) {
  // 金额均为非负，四舍五入即 (n + d/2) / d。
  return (numerator + denominator / 2n) / denominator;
}

export function amountCentsFor(unitPrice, quantity) {
  const scaled = parseUnitPrice(unitPrice).scaled;
  const cents = roundHalfUp(scaled * BigInt(quantity) * 100n, PRICE_DENOMINATOR);
  if (cents > BigInt(MAX_AMOUNT_CENTS)) fail('AMOUNT_TOO_LARGE', '计算金额超出允许范围。');
  return Number(cents);
}

export function costMicrosFor(unitPrice, quantity) {
  const scaled = parseUnitPrice(unitPrice).scaled;
  const micros = roundHalfUp(scaled * BigInt(quantity) * 1_000_000n, PRICE_DENOMINATOR);
  if (micros > BigInt(MAX_COST_MICROS)) fail('AMOUNT_TOO_LARGE', '计算成本超出允许范围。');
  return Number(micros);
}

function toSafeNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new AppError('LEDGER_OVERFLOW', '账本金额超出可安全计算范围，请人工核对。', 500);
  }
  return number;
}

function normalizeBillingMode(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!BILLING_MODES.includes(value)) fail('INVALID_BILLING_MODE', 'billingMode 只能是 chargeable 或 cost_only。');
  return value;
}

function normalizeUsage(body) {
  const capability = patternField(body.capability, 'capability', CAPABILITY, 'capability 格式不正确。');
  const modelId = patternField(body.modelId, 'modelId', MODEL_ID, 'modelId 格式不正确。');
  const tier = body.tier === undefined || body.tier === null || body.tier === ''
    ? 'default'
    : patternField(body.tier, 'tier', TIER, 'tier 格式不正确。');
  const quantity = body.quantity === undefined || body.quantity === null
    ? 1
    : integerField(body.quantity, 'quantity', { min: 1, max: MAX_QUANTITY });
  const billingMode = normalizeBillingMode(body.billingMode);
  let costMicros = null;
  if (body.costMicros !== undefined && body.costMicros !== null) {
    costMicros = integerField(body.costMicros, 'costMicros', { min: 0, max: MAX_COST_MICROS });
  }
  return { capability, modelId, tier, quantity, billingMode, costMicros };
}

function normalizeTaskId(value) {
  const taskId = textField(value, 'taskId', 160, { required: true });
  if (!TASK_ID.test(taskId)) fail('INVALID_TASK_ID', 'taskId 只能包含字母、数字、点、下划线、冒号或连字符。');
  return taskId;
}

function normalizeIdempotencyKey(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value.trim())) {
    fail('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 需为 1–200 个字母、数字、点、下划线、冒号或连字符。');
  }
  return value.trim();
}

function derivedKey(taskId, operation) {
  return `task:${taskId}:${operation}`;
}

function normalizePriceQuery(query = {}) {
  return {
    capability: query.capability ? patternField(query.capability, 'capability', CAPABILITY, 'capability 格式不正确。') : null,
    modelId: query.modelId ? patternField(query.modelId, 'modelId', MODEL_ID, 'modelId 格式不正确。') : null,
    tier: query.tier ? patternField(query.tier, 'tier', TIER, 'tier 格式不正确。') : null,
    activeOnly: query.includeHistory !== '1' && query.includeHistory !== 'true',
    limit: query.limit === undefined ? 50 : integerField(query.limit, '每页数量', { min: 1, max: 100 }),
    offset: query.offset === undefined ? 0 : integerField(query.offset, '分页偏移', { min: 0, max: 1_000_000 }),
  };
}

function normalizeLedgerQuery(query = {}) {
  let types = null;
  if (query.entryType) {
    types = String(query.entryType).split(',').map(item => item.trim()).filter(Boolean);
    for (const type of types) {
      if (!ENTRY_TYPES.includes(type)) fail('INVALID_FILTER', `不支持的流水类型：${type}。`);
    }
    types = [...new Set(types)];
  }
  const from = dateField(query.from, '起始时间');
  const to = dateField(query.to, '结束时间');
  if (from && to && from >= to) fail('INVALID_DATE', '起始时间必须早于结束时间。');
  return {
    taskId: query.taskId ? normalizeTaskId(query.taskId) : null,
    types,
    from,
    to,
    limit: query.limit === undefined ? 20 : integerField(query.limit, '每页数量', { min: 1, max: 100 }),
    offset: query.offset === undefined ? 0 : integerField(query.offset, '分页偏移', { min: 0, max: 1_000_000 }),
  };
}

function monthBounds(at = new Date(), query = {}) {
  const from = dateField(query.from, '起始时间') ?? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = dateField(query.to, '结束时间') ?? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  if (from >= to) fail('INVALID_DATE', '起始时间必须早于结束时间。');
  return { from, to };
}

function priceSnapshot(quote, request) {
  return {
    capability: request.capability,
    modelId: request.modelId,
    tier: quote.tier ?? request.tier,
    quantity: request.quantity,
    unit: quote.unit ?? null,
    unitPrice: quote.unitPrice ?? null,
    priceId: quote.priceId ?? null,
    priceVersion: quote.priceVersion ?? null,
    billingMode: quote.billingMode,
  };
}

export class BillingService {
  constructor(repository, { workspaceId = DEFAULT_WORKSPACE_ID, now = () => new Date() } = {}) {
    this.repository = repository;
    this.workspaceId = workspaceId;
    this.now = now;
  }

  // ---- 价格维护 ----

  async setPrice(body, { actorId = 'local' } = {}) {
    requireObject(body);
    rejectUnknown(body, PRICE_FIELDS, '价格');
    const capability = patternField(body.capability, 'capability', CAPABILITY, 'capability 格式不正确。');
    const modelId = patternField(body.modelId, 'modelId', MODEL_ID, 'modelId 格式不正确。');
    const tier = body.tier === undefined || body.tier === null || body.tier === ''
      ? 'default'
      : patternField(body.tier, 'tier', TIER, 'tier 格式不正确。');
    if (!UNITS.includes(body.unit)) fail('INVALID_UNIT', `unit 只能是：${UNITS.join('、')}。`);
    const unitPrice = parseUnitPrice(body.unitPrice).text;
    const currency = body.currency === undefined || body.currency === null || body.currency === ''
      ? CURRENCY
      : String(body.currency).trim().toUpperCase();
    if (currency !== CURRENCY) {
      fail('INVALID_CURRENCY', '一期内部额度只支持 CNY；外币价格请先折算并记录汇率。');
    }
    const billingMode = normalizeBillingMode(body.billingMode, 'chargeable');
    const effectiveFrom = dateField(body.effectiveFrom, '生效时间') ?? this.now();
    // 新价一写入就会停用旧价；未做定时生效，因此不允许预约到未来，避免中间空档。
    if (effectiveFrom > this.now()) {
      fail('INVALID_EFFECTIVE_TIME', '暂不支持预约未来生效；请在生效时再改价。');
    }
    const note = textField(body.note, '价格说明', 500);
    return this.repository.setPrice({
      workspaceId: this.workspaceId,
      price: {
        id: randomUUID(),
        capability,
        modelId,
        tier,
        unit: body.unit,
        unitPrice,
        currency,
        billingMode,
        effectiveFrom,
        note,
        createdBy: actorId,
      },
      actorId,
    });
  }

  async prices(query = {}) {
    const filters = normalizePriceQuery(query);
    const result = await this.repository.listPrices({ workspaceId: this.workspaceId, ...filters });
    return {
      prices: result.prices,
      total: result.total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset: filters.offset + result.prices.length < result.total
        ? filters.offset + result.prices.length : null,
    };
  }

  // ---- 估价 ----

  async quote(body) {
    requireObject(body);
    rejectUnknown(body, QUOTE_FIELDS, '估价');
    const request = normalizeUsage(body);
    const price = await this.repository.getActivePrice({
      workspaceId: this.workspaceId,
      capability: request.capability,
      modelId: request.modelId,
      tier: request.tier,
      at: this.now(),
    });
    return buildQuote(request, price);
  }

  // ---- 预占 / 结算 / 释放 ----

  async reserve(body, { actorId = 'local' } = {}) {
    requireObject(body);
    rejectUnknown(body, RESERVE_FIELDS, '预占');
    const usage = normalizeUsage(body);
    const request = {
      ...usage,
      taskId: normalizeTaskId(body.taskId),
      projectId: textField(body.projectId, '项目编号', 200),
      reason: textField(body.reason, '原因', 500),
    };
    request.idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey, derivedKey(request.taskId, 'reserve'));
    const price = await this.repository.getActivePrice({
      workspaceId: this.workspaceId,
      capability: request.capability,
      modelId: request.modelId,
      tier: request.tier,
      at: this.now(),
    });
    const quote = buildQuote({ ...request, billingMode: request.billingMode }, price);
    if (quote.billingMode === 'cost_only') {
      return this.#appendCostOnly(request, quote, actorId);
    }
    const snapshot = priceSnapshot(quote, request);
    if (!quote.priced) {
      const entry = {
        id: randomUUID(),
        taskId: request.taskId,
        entryType: 'pending_price',
        amountCents: null,
        costMicros: request.costMicros,
        currency: CURRENCY,
        ...snapshot,
        projectId: request.projectId,
        actorId,
        reason: request.reason,
        reference: null,
        idempotencyKey: request.idempotencyKey,
      };
      const result = await this.repository.pendingPrice({ workspaceId: this.workspaceId, entry });
      return { ...result, quote };
    }
    if (quote.amountCents < 1) {
      fail('AMOUNT_TOO_SMALL', '按当前单价与数量计算不足 1 分，未预占；请调整单价或数量。');
    }
    const entry = {
      id: randomUUID(),
      taskId: request.taskId,
      entryType: 'reserve',
      amountCents: quote.amountCents,
      costMicros: request.costMicros,
      currency: CURRENCY,
      ...snapshot,
      projectId: request.projectId,
      actorId,
      reason: request.reason,
      reference: null,
      idempotencyKey: request.idempotencyKey,
    };
    const result = await this.repository.reserve({ workspaceId: this.workspaceId, entry });
    return { ...result, quote };
  }

  async settle(taskIdValue, body = {}, { actorId = 'local' } = {}) {
    const taskId = normalizeTaskId(taskIdValue);
    requireObject(body);
    rejectUnknown(body, SETTLE_FIELDS, '结算');
    const entry = {
      id: randomUUID(),
      taskId,
      entryType: 'settle',
      amountCents: null,
      costMicros: null,
      currency: CURRENCY,
      projectId: null,
      actorId,
      reason: textField(body.reason, '原因', 500) || '生成任务成功结算',
      reference: null,
      idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey, derivedKey(taskId, 'settle')),
    };
    return this.repository.settle({ workspaceId: this.workspaceId, taskId, entry });
  }

  async release(taskIdValue, body = {}, { actorId = 'local' } = {}) {
    const taskId = normalizeTaskId(taskIdValue);
    requireObject(body);
    rejectUnknown(body, RELEASE_FIELDS, '释放');
    const entry = {
      id: randomUUID(),
      taskId,
      entryType: 'release',
      amountCents: null,
      costMicros: null,
      currency: CURRENCY,
      projectId: null,
      actorId,
      reason: textField(body.reason, '原因', 500) || '生成任务明确失败释放预占',
      reference: null,
      idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey, derivedKey(taskId, 'release')),
    };
    return this.repository.release({ workspaceId: this.workspaceId, taskId, entry });
  }

  // 未定价任务的事后补价：必须由管理员显式给出金额与理由，不套用最新价格。
  async supplement(taskIdValue, body = {}, { actorId = 'local' } = {}) {
    const taskId = normalizeTaskId(taskIdValue);
    requireObject(body);
    rejectUnknown(body, SUPPLEMENT_FIELDS, '补价');
    if (body.amountCents === undefined || body.amountCents === null) {
      fail('INVALID_AMOUNT', '补价必须填写 amountCents。');
    }
    const entry = {
      id: randomUUID(),
      taskId,
      entryType: 'supplement',
      amountCents: amountCentsField(body.amountCents, '补价金额'),
      costMicros: null,
      currency: CURRENCY,
      projectId: null,
      actorId,
      reason: textField(body.reason, '补价理由', 500, { required: true }),
      reference: textField(body.reference, '业务引用', 200),
      idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey, derivedKey(taskId, 'supplement')),
    };
    if (entry.amountCents < 1) fail('INVALID_AMOUNT', '补价金额必须大于 0 分。');
    return this.repository.supplement({ workspaceId: this.workspaceId, taskId, entry });
  }

  // ---- 仅记成本 ----

  async costOnly(body, { actorId = 'local' } = {}) {
    requireObject(body);
    rejectUnknown(body, COST_ONLY_FIELDS, '仅记成本');
    const usage = normalizeUsage({ ...body, billingMode: 'cost_only' });
    const request = {
      ...usage,
      taskId: normalizeTaskId(body.taskId),
      projectId: textField(body.projectId, '项目编号', 200),
      reason: textField(body.reason, '原因', 500),
      reference: textField(body.reference, '业务引用', 200),
    };
    request.idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey, derivedKey(request.taskId, 'cost_only'));
    // 只有显式标记为 cost_only 的价格才可作为成本参考；常规平台结算价不能拿来当成本。
    const price = await this.repository.getActivePrice({
      workspaceId: this.workspaceId,
      capability: request.capability,
      modelId: request.modelId,
      tier: request.tier,
      at: this.now(),
    });
    const quote = buildCostQuote(request, price);
    return this.#appendCostOnly(request, quote, actorId);
  }

  async #appendCostOnly(request, quote, actorId) {
    const entry = {
      id: randomUUID(),
      taskId: request.taskId,
      entryType: 'cost_only',
      amountCents: null,
      costMicros: quote.costMicros,
      currency: CURRENCY,
      ...priceSnapshot(quote, request),
      projectId: request.projectId,
      actorId,
      reason: request.reason,
      reference: request.reference ?? null,
      idempotencyKey: request.idempotencyKey,
    };
    const result = await this.repository.costOnly({ workspaceId: this.workspaceId, entry });
    return { ...result, quote };
  }

  // ---- 人工调账 ----

  async adjust(body, { actorId = 'local' } = {}) {
    requireObject(body);
    rejectUnknown(body, ADJUSTMENT_FIELDS, '调账');
    if (body.amountCents === undefined || body.amountCents === null) {
      fail('INVALID_AMOUNT', '调账必须填写 amountCents（正数入账，负数扣减）。');
    }
    const entry = {
      id: randomUUID(),
      taskId: 'manual',
      entryType: 'adjustment',
      amountCents: amountCentsField(body.amountCents, '调账金额', { signed: true }),
      costMicros: null,
      currency: CURRENCY,
      billingMode: 'chargeable',
      projectId: textField(body.projectId, '项目编号', 200),
      actorId,
      reason: textField(body.reason, '调账理由', 500, { required: true }),
      reference: textField(body.reference, '业务引用', 200, { required: true }),
      idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey, `adjust:${randomUUID()}`),
    };
    return this.repository.adjust({ workspaceId: this.workspaceId, entry });
  }

  // ---- 查询 ----

  async balance() {
    const money = await this.repository.balance(this.workspaceId);
    return {
      workspaceId: this.workspaceId,
      currency: CURRENCY,
      balanceCents: money.balanceCents,
      heldCents: money.heldCents,
      availableCents: money.balanceCents - money.heldCents,
    };
  }

  async summary(query = {}) {
    const { from, to } = monthBounds(this.now(), query);
    const result = await this.repository.summary({ workspaceId: this.workspaceId, from, to });
    return {
      workspaceId: this.workspaceId,
      currency: CURRENCY,
      from: from.toISOString(),
      to: to.toISOString(),
      ...result,
      availableCents: result.balanceCents - result.heldCents,
    };
  }

  async ledger(query = {}) {
    const filters = normalizeLedgerQuery(query);
    const result = await this.repository.ledger({ workspaceId: this.workspaceId, ...filters });
    return {
      entries: result.entries,
      total: result.total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset: filters.offset + result.entries.length < result.total
        ? filters.offset + result.entries.length : null,
    };
  }
}

function buildCostQuote(request, price) {
  const usePrice = Boolean(price && price.billingMode === 'cost_only');
  const costMicros = request.costMicros ?? (usePrice ? costMicrosFor(price.unitPrice, request.quantity) : null);
  return {
    priced: costMicros !== null,
    status: 'cost_only',
    billingMode: 'cost_only',
    capability: request.capability,
    modelId: request.modelId,
    tier: usePrice ? price.tier : request.tier,
    quantity: request.quantity,
    currency: CURRENCY,
    amountCents: null,
    costMicros,
    unit: usePrice ? price.unit : null,
    unitPrice: usePrice ? price.unitPrice : null,
    priceId: usePrice ? price.id : null,
    priceVersion: usePrice ? price.version : null,
  };
}

function buildQuote(request, price) {
  const costOnly = request.billingMode === 'cost_only' || price?.billingMode === 'cost_only';
  if (costOnly) return buildCostQuote(request, price);
  const base = {
    priced: Boolean(price),
    status: 'pending_price',
    billingMode: 'chargeable',
    capability: request.capability,
    modelId: request.modelId,
    tier: request.tier,
    quantity: request.quantity,
    currency: CURRENCY,
    amountCents: null,
    costMicros: request.costMicros,
    unit: null,
    unitPrice: null,
    priceId: null,
    priceVersion: null,
  };
  if (!price) return base;
  const amountCents = amountCentsFor(price.unitPrice, request.quantity);
  return {
    ...base,
    priced: true,
    status: amountCents > 0 ? 'priced' : 'below_minimum',
    tier: price.tier,
    amountCents,
    unit: price.unit,
    unitPrice: price.unitPrice,
    priceId: price.id,
    priceVersion: price.version,
  };
}

function stateOf(entries) {
  const state = {
    entries,
    reserve: null, pending: null, settle: null, release: null, supplement: null, costOnly: null,
  };
  const map = {
    reserve: 'reserve', pending_price: 'pending', settle: 'settle',
    release: 'release', supplement: 'supplement', cost_only: 'costOnly',
  };
  for (const entry of entries) {
    const key = map[entry.entryType];
    if (key && !state[key]) state[key] = entry;
  }
  return state;
}

function resultStatus(entryType) {
  switch (entryType) {
    case 'reserve': return 'reserved';
    case 'pending_price': return 'pending_price';
    case 'settle': return 'settled';
    case 'release': return 'released';
    case 'supplement': return 'supplemented';
    case 'cost_only': return 'cost_only';
    default: return entryType;
  }
}

function moneyResult(status, created, entry, money) {
  return {
    status,
    created,
    entry,
    balanceCents: money.balanceCents,
    heldCents: money.heldCents,
    availableCents: money.balanceCents - money.heldCents,
  };
}

function dedupeResult(status, entry, money) {
  return moneyResult(status, false, entry, money);
}

function assertSameRequest(existing, entry) {
  if (existing.taskId !== entry.taskId || existing.entryType !== entry.entryType) {
    fail('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同任务或不同流水类型。', 409);
  }
}

// ---- PostgreSQL 仓储 ----

function priceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    capability: row.capability,
    modelId: row.model_id,
    tier: row.tier,
    unit: row.unit,
    currency: row.currency,
    unitPrice: normalizeDecimalText(row.unit_price),
    billingMode: row.billing_mode,
    version: row.version,
    active: row.active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ledgerEntryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    entryType: row.entry_type,
    amountCents: toSafeNumber(row.amount_cents),
    costMicros: toSafeNumber(row.cost_micros),
    currency: row.currency,
    billingMode: row.billing_mode,
    capability: row.capability,
    modelId: row.model_id,
    tier: row.tier,
    quantity: row.quantity,
    unit: row.unit,
    unitPrice: row.unit_price === null || row.unit_price === undefined
      ? null : normalizeDecimalText(row.unit_price),
    priceId: row.price_id,
    priceVersion: row.price_version,
    projectId: row.project_id,
    actorId: row.actor_id,
    reason: row.reason,
    reference: row.reference,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

const INSERT_ENTRY = `
  INSERT INTO sj_billing_ledger (
    id, workspace_id, task_id, entry_type, amount_cents, cost_micros, currency, billing_mode,
    capability, model_id, tier, quantity, unit, unit_price, price_id, price_version,
    project_id, actor_id, reason, reference, idempotency_key
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
  ) RETURNING *`;

function entryParams(workspaceId, entry) {
  return [
    entry.id, workspaceId, entry.taskId, entry.entryType, entry.amountCents ?? null,
    entry.costMicros ?? null, entry.currency || CURRENCY, entry.billingMode || 'chargeable',
    entry.capability ?? null, entry.modelId ?? null, entry.tier ?? null,
    entry.quantity ?? null, entry.unit ?? null, entry.unitPrice ?? null,
    entry.priceId ?? null, entry.priceVersion ?? null,
    entry.projectId ?? null, entry.actorId ?? null, entry.reason ?? null,
    entry.reference ?? null, entry.idempotencyKey,
  ];
}

function snapshotFrom(source) {
  return {
    capability: source.capability,
    modelId: source.modelId,
    tier: source.tier,
    quantity: source.quantity,
    unit: source.unit,
    unitPrice: source.unitPrice,
    priceId: source.priceId,
    priceVersion: source.priceVersion,
    billingMode: source.billingMode,
    projectId: source.projectId,
  };
}

export class PgBillingRepository {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async getActivePrice({ workspaceId, capability, modelId, tier = 'default', at = new Date() }) {
    const row = (await this.pool.query(`
      SELECT * FROM sj_model_prices
      WHERE workspace_id=$1 AND capability=$2 AND model_id=$3 AND active=true
        AND tier IN ($4, 'default')
        AND effective_from <= $5 AND (effective_to IS NULL OR effective_to > $5)
      ORDER BY (tier = $4) DESC, effective_from DESC
      LIMIT 1
    `, [workspaceId ?? this.workspaceId, capability, modelId, tier, at])).rows[0];
    return priceFromRow(row);
  }

  async listPrices({ workspaceId, capability, modelId, tier, activeOnly, limit, offset }) {
    const where = ['workspace_id=$1'];
    const params = [workspaceId ?? this.workspaceId];
    if (capability) { params.push(capability); where.push(`capability=$${params.length}`); }
    if (modelId) { params.push(modelId); where.push(`model_id=$${params.length}`); }
    if (tier) { params.push(tier); where.push(`tier=$${params.length}`); }
    if (activeOnly) where.push('active=true');
    const whereSql = where.join(' AND ');
    const total = (await this.pool.query(
      `SELECT count(*)::int AS total FROM sj_model_prices WHERE ${whereSql}`, params,
    )).rows[0].total;
    const rows = (await this.pool.query(
      `SELECT * FROM sj_model_prices WHERE ${whereSql}
       ORDER BY capability, model_id, tier, version DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    )).rows;
    return { prices: rows.map(priceFromRow), total };
  }

  async setPrice({ workspaceId, price }) {
    const client = await this.pool.connect();
    const ws = workspaceId ?? this.workspaceId;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sj:billing:price:${ws}:${price.capability}:${price.modelId}:${price.tier}`,
      ]);
      const version = (await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version FROM sj_model_prices
        WHERE workspace_id=$1 AND capability=$2 AND model_id=$3 AND tier=$4
      `, [ws, price.capability, price.modelId, price.tier])).rows[0].version;
      await client.query(`
        UPDATE sj_model_prices SET active=false, updated_at=now()
        WHERE workspace_id=$1 AND capability=$2 AND model_id=$3 AND tier=$4 AND active=true
      `, [ws, price.capability, price.modelId, price.tier]);
      const row = (await client.query(`
        INSERT INTO sj_model_prices (
          id, workspace_id, capability, model_id, tier, unit, currency, unit_price,
          billing_mode, version, active, effective_from, note, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13)
        RETURNING *
      `, [
        price.id, ws, price.capability, price.modelId, price.tier, price.unit,
        price.currency, price.unitPrice, price.billingMode, version,
        price.effectiveFrom, price.note, price.createdBy,
      ])).rows[0];
      await client.query('COMMIT');
      return priceFromRow(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #findByKey(client, workspaceId, key) {
    return ledgerEntryFromRow((await client.query(
      'SELECT * FROM sj_billing_ledger WHERE workspace_id=$1 AND idempotency_key=$2',
      [workspaceId, key],
    )).rows[0]);
  }

  async #taskEntries(client, workspaceId, taskId) {
    return (await client.query(
      'SELECT * FROM sj_billing_ledger WHERE workspace_id=$1 AND task_id=$2 ORDER BY created_at, id',
      [workspaceId, taskId],
    )).rows.map(ledgerEntryFromRow);
  }

  async #money(client, workspaceId) {
    const row = (await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN entry_type='adjustment' THEN amount_cents ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN entry_type IN ('settle','supplement') THEN amount_cents ELSE 0 END), 0)
          AS balance_cents,
        COALESCE(SUM(CASE WHEN entry_type='reserve' THEN amount_cents ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN entry_type IN ('release','settle') THEN amount_cents ELSE 0 END), 0)
          AS held_cents
      FROM sj_billing_ledger WHERE workspace_id=$1
    `, [workspaceId])).rows[0];
    return { balanceCents: toSafeNumber(row.balance_cents), heldCents: toSafeNumber(row.held_cents) };
  }

  // 所有写账本的操作按工作空间串行，保证余额检查与追加在同一快照内完成；
  // 唯一约束仍是最后一道幂等兜底。
  async #withLedgerLock(workspaceId, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sj:billing:${workspaceId}`]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #insert(client, workspaceId, entry) {
    return ledgerEntryFromRow((await client.query(INSERT_ENTRY, entryParams(workspaceId, entry))).rows[0]);
  }

  async reserve({ workspaceId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult(resultStatus(duplicate.entryType), duplicate, await this.#money(client, ws));
        }
        const state = stateOf(await this.#taskEntries(client, ws, entry.taskId));
        if (state.reserve) return dedupeResult('reserved', state.reserve, await this.#money(client, ws));
        if (state.pending) return dedupeResult('pending_price', state.pending, await this.#money(client, ws));
        if (state.settle || state.release || state.supplement || state.costOnly) {
          fail('TASK_FINALIZED', '该任务已有终态流水，不能再预占。', 409);
        }
        const money = await this.#money(client, ws);
        if (money.balanceCents - money.heldCents < entry.amountCents) {
          fail('INSUFFICIENT_BALANCE', '可用额度不足，未提交任务；请先充值或调整预算。', 402);
        }
        const inserted = await this.#insert(client, ws, entry);
        return moneyResult('reserved', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('reserved', existing, money));
    }
  }

  async pendingPrice({ workspaceId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult('pending_price', duplicate, await this.#money(client, ws));
        }
        const state = stateOf(await this.#taskEntries(client, ws, entry.taskId));
        if (state.pending) return dedupeResult('pending_price', state.pending, await this.#money(client, ws));
        if (state.reserve) return dedupeResult('reserved', state.reserve, await this.#money(client, ws));
        if (state.settle || state.release || state.supplement || state.costOnly) {
          fail('TASK_FINALIZED', '该任务已有终态流水，不能再标记待核价。', 409);
        }
        const inserted = await this.#insert(client, ws, entry);
        return moneyResult('pending_price', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('pending_price', existing, money));
    }
  }

  async settle({ workspaceId, taskId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult('settled', duplicate, await this.#money(client, ws));
        }
        const state = stateOf(await this.#taskEntries(client, ws, taskId));
        if (state.settle) return dedupeResult('settled', state.settle, await this.#money(client, ws));
        if (state.release) fail('TASK_RELEASED', '任务已释放预占，不能再结算。', 409);
        if (state.supplement) fail('TASK_SUPPLEMENTED', '任务已补价结算，不能重复结算。', 409);
        if (state.costOnly) fail('TASK_COST_ONLY', '该任务按仅记成本处理，不进入内部扣款。', 409);
        if (state.pending && !state.reserve) {
          return moneyResult('pending_price', false, null, await this.#money(client, ws));
        }
        if (!state.reserve) fail('BILLING_TASK_NOT_FOUND', '账本中不存在该任务。', 404);
        const inserted = await this.#insert(client, ws, {
          ...entry,
          ...snapshotFrom(state.reserve),
          amountCents: state.reserve.amountCents,
          costMicros: state.reserve.costMicros,
        });
        return moneyResult('settled', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('settled', existing, money), taskId);
    }
  }

  async release({ workspaceId, taskId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult('released', duplicate, await this.#money(client, ws));
        }
        const state = stateOf(await this.#taskEntries(client, ws, taskId));
        if (state.release) return dedupeResult('released', state.release, await this.#money(client, ws));
        if (state.settle) fail('TASK_SETTLED', '任务已结算，不能释放预占。', 409);
        if (state.supplement) fail('TASK_SUPPLEMENTED', '任务已补价结算，不能释放预占。', 409);
        if (state.costOnly) fail('TASK_COST_ONLY', '该任务按仅记成本处理，没有预占可释放。', 409);
        const source = state.reserve || state.pending;
        if (!source) fail('BILLING_TASK_NOT_FOUND', '账本中不存在该任务。', 404);
        const inserted = await this.#insert(client, ws, {
          ...entry,
          ...snapshotFrom(source),
          amountCents: source.amountCents,
        });
        return moneyResult('released', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('released', existing, money), taskId);
    }
  }

  async supplement({ workspaceId, taskId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult('supplemented', duplicate, await this.#money(client, ws));
        }
        const state = stateOf(await this.#taskEntries(client, ws, taskId));
        if (state.supplement) return dedupeResult('supplemented', state.supplement, await this.#money(client, ws));
        if (state.release) fail('TASK_RELEASED', '任务已释放，不能再补价。', 409);
        if (state.settle || state.reserve) fail('TASK_PRICED', '任务已有价格并按预占结算，不能再补价。', 409);
        if (!state.pending) fail('NOT_PENDING_PRICE', '该任务不是待核价状态。', 409);
        const money = await this.#money(client, ws);
        if (money.balanceCents - money.heldCents < entry.amountCents) {
          fail('INSUFFICIENT_BALANCE', '可用额度不足，补价需先充值；可先预览差额再确认。', 402);
        }
        const inserted = await this.#insert(client, ws, {
          ...entry,
          ...snapshotFrom(state.pending),
          costMicros: null,
        });
        return moneyResult('supplemented', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('supplemented', existing, money), taskId);
    }
  }

  async costOnly({ workspaceId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult('cost_only', duplicate, await this.#money(client, ws));
        }
        const inserted = await this.#insert(client, ws, entry);
        return moneyResult('cost_only', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('cost_only', existing, money));
    }
  }

  async adjust({ workspaceId, entry }) {
    const ws = workspaceId ?? this.workspaceId;
    try {
      return await this.#withLedgerLock(ws, async client => {
        const duplicate = await this.#findByKey(client, ws, entry.idempotencyKey);
        if (duplicate) {
          assertSameRequest(duplicate, entry);
          return dedupeResult('adjusted', duplicate, await this.#money(client, ws));
        }
        const money = await this.#money(client, ws);
        if (money.balanceCents + entry.amountCents < money.heldCents) {
          fail('INSUFFICIENT_BALANCE', '扣减后余额不足以覆盖当前预占，调整被拒绝。', 402);
        }
        const inserted = await this.#insert(client, ws, entry);
        return moneyResult('adjusted', true, inserted, await this.#money(client, ws));
      });
    } catch (error) {
      return this.#uniqueFallback(error, ws, entry, async (money, existing) => dedupeResult('adjusted', existing, money));
    }
  }

  // 唯一约束兜底：锁内预检查已覆盖正常路径；若仍发生 23505，
  // 只返回已存在的同键流水，绝不重复入账。
  async #uniqueFallback(error, workspaceId, entry, build, taskId = entry.taskId) {
    if (error?.code !== '23505') throw error;
    const existing = ledgerEntryFromRow((await this.pool.query(
      'SELECT * FROM sj_billing_ledger WHERE workspace_id=$1 AND idempotency_key=$2',
      [workspaceId, entry.idempotencyKey],
    )).rows[0]);
    if (existing) {
      assertSameRequest(existing, entry);
      return build(await this.balance(workspaceId), existing);
    }
    const entries = (await this.pool.query(
      'SELECT * FROM sj_billing_ledger WHERE workspace_id=$1 AND task_id=$2 ORDER BY created_at, id',
      [workspaceId, taskId],
    )).rows.map(ledgerEntryFromRow);
    const state = stateOf(entries);
    const operationKey = {
      reserve: 'reserve', pending_price: 'pending', settle: 'settle',
      release: 'release', supplement: 'supplement', cost_only: 'costOnly',
    }[entry.entryType];
    const found = (operationKey && state[operationKey])
      || state.reserve || state.pending || state.settle || state.release
      || state.supplement || state.costOnly;
    if (found) {
      return build(await this.balance(workspaceId), found);
    }
    throw new AppError('BILLING_CONFLICT', '账本写入冲突，请核对任务状态后重试。', 409);
  }

  async balance(workspaceId) {
    return this.#money(this.pool, workspaceId ?? this.workspaceId);
  }

  async summary({ workspaceId, from, to }) {
    const ws = workspaceId ?? this.workspaceId;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const money = await this.#money(client, ws);
      const window = (await client.query(`
        SELECT
          COALESCE(SUM(CASE WHEN entry_type IN ('settle','supplement') THEN amount_cents ELSE 0 END), 0) AS settled_cents,
          COALESCE(SUM(CASE WHEN entry_type='cost_only' THEN cost_micros ELSE 0 END), 0) AS cost_micros
        FROM sj_billing_ledger
        WHERE workspace_id=$1 AND created_at >= $2 AND created_at < $3
      `, [ws, from, to])).rows[0];
      const pending = (await client.query(`
        SELECT count(DISTINCT p.task_id)::int AS pending
        FROM sj_billing_ledger p
        WHERE p.workspace_id=$1 AND p.entry_type='pending_price'
          AND NOT EXISTS (
            SELECT 1 FROM sj_billing_ledger t
            WHERE t.workspace_id=p.workspace_id AND t.task_id=p.task_id
              AND t.entry_type IN ('supplement','release')
          )
      `, [ws])).rows[0].pending;
      const grouped = async (column, label) => {
        const rows = (await client.query(`
          SELECT ${column} AS key, COALESCE(SUM(amount_cents), 0) AS amount_cents, count(*)::int AS entries
          FROM sj_billing_ledger
          WHERE workspace_id=$1 AND entry_type IN ('settle','supplement')
            AND created_at >= $2 AND created_at < $3
          GROUP BY ${column}
          ORDER BY amount_cents DESC
          LIMIT 50
        `, [ws, from, to])).rows;
        return rows.map(row => ({
          [label]: row.key,
          amountCents: toSafeNumber(row.amount_cents),
          entries: row.entries,
        }));
      };
      const byModel = await grouped('model_id', 'modelId');
      const byCapability = await grouped('capability', 'capability');
      const byProject = await grouped('project_id', 'projectId');
      const providers = new Map();
      for (const row of byModel) {
        const provider = String(row.modelId || '').split(':')[0] || 'unknown';
        const current = providers.get(provider) || { provider, amountCents: 0, entries: 0 };
        current.amountCents += row.amountCents;
        current.entries += row.entries;
        providers.set(provider, current);
      }
      await client.query('COMMIT');
      return {
        balanceCents: money.balanceCents,
        heldCents: money.heldCents,
        settledCents: toSafeNumber(window.settled_cents),
        costOnlyMicros: toSafeNumber(window.cost_micros),
        pendingPriceCount: pending,
        byModel,
        byCapability,
        byProject,
        byProvider: [...providers.values()],
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ledger({ workspaceId, taskId, types, from, to, limit, offset }) {
    const ws = workspaceId ?? this.workspaceId;
    const where = ['workspace_id=$1'];
    const params = [ws];
    if (taskId) { params.push(taskId); where.push(`task_id=$${params.length}`); }
    if (types && types.length) { params.push(types); where.push(`entry_type = ANY($${params.length}::text[])`); }
    if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); where.push(`created_at < $${params.length}`); }
    const whereSql = where.join(' AND ');
    const total = (await this.pool.query(
      `SELECT count(*)::int AS total FROM sj_billing_ledger WHERE ${whereSql}`, params,
    )).rows[0].total;
    const rows = (await this.pool.query(
      `SELECT * FROM sj_billing_ledger WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    )).rows;
    return { entries: rows.map(ledgerEntryFromRow), total };
  }
}
