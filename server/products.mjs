import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

// Product archive domain logic (Issue #2). The service owns validation, versioning and
// optimistic locking; a repository owns persistence. PostgreSQL is the production
// repository (PgProductRepository). Tests use an in-memory repository with the same
// compare-and-swap contract and never touch the network.
export const DEFAULT_WORKSPACE_ID = 'local';
export const PRODUCT_STATUSES = ['draft', 'pending', 'confirmed'];
export const SOURCE_TYPES = ['manual', 'link', 'screenshot'];
export const PRICE_TYPES = ['sale', 'starting', 'list', 'coupon', 'member'];
export const MAX_PAGE_SIZE = 100;

const PRODUCT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRODUCT_TEXT_FIELDS = {
  name: ['商品名称', 200, true],
  originalTitle: ['原始标题', 500, false],
  brand: ['品牌', 100, false],
  category: ['品类', 100, false],
  description: ['商品描述', 5000, false],
  internalCode: ['商家编码', 100, false],
  sourcePlatform: ['来源平台', 50, false],
  sourceProductId: ['来源商品 ID', 200, false],
};

const PRODUCT_FIELDS = [...Object.keys(PRODUCT_TEXT_FIELDS), 'sourceType', 'sourceUrl', 'status'];
const SKU_FIELDS = ['internalSku', 'sourceSkuId', 'spec', 'parameters', 'price', 'selected'];
const PRICE_FIELDS = ['amount', 'min', 'max', 'currency', 'type', 'condition'];

function requireObject(value, label = '请求体') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_BODY', `${label}必须是 JSON 对象。`);
  }
}

function rejectUnknown(body, allowed, label) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new AppError('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function textField(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new AppError('INVALID_NAME', `${label}不能为空。`);
    return null;
  }
  if (typeof value !== 'string') throw new AppError('INVALID_FIELD', `${label}必须是文本。`);
  const text = value.trim();
  if (required && !text) throw new AppError('INVALID_NAME', `${label}不能为空。`);
  if (text.length > max) throw new AppError('INVALID_FIELD', `${label}不能超过 ${max} 个字符。`);
  return text || null;
}

function moneyField(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_PRICE', `${label}必须是数字。`);
  }
  if (value < 0 || value > 1_000_000_000_000) {
    throw new AppError('INVALID_PRICE', `${label}超出允许范围。`);
  }
  const scaled = value * 10_000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new AppError('INVALID_PRICE', `${label}最多保留 4 位小数。`);
  }
  return Math.round(scaled) / 10_000;
}

function currencyField(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError('INVALID_CURRENCY', '币种必须是文本。');
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError('INVALID_CURRENCY', '币种需为 3 位字母，例如 CNY。');
  }
  return currency;
}

function sourceUrlField(value) {
  const text = textField(value, '来源链接', 2000);
  if (!text) return null;
  let url;
  try { url = new URL(text); }
  catch { throw new AppError('INVALID_SOURCE_URL', '来源链接格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('INVALID_SOURCE_URL', '来源链接必须是 http/https 地址且不能包含账号。');
  }
  return url.toString();
}

function normalizeParameters(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AppError('INVALID_FIELD', '商品参数必须是数组。');
  if (value.length > 50) throw new AppError('INVALID_FIELD', '商品参数不能超过 50 项。');
  return value.map(row => {
    requireObject(row, '商品参数');
    rejectUnknown(row, ['name', 'value', 'unit'], '商品参数');
    const name = textField(row.name, '参数名', 100, { required: true });
    return {
      name,
      value: textField(row.value, '参数值', 200) || '',
      unit: textField(row.unit, '单位', 50),
    };
  });
}

function emptyPrice() {
  return {
    amount: null, min: null, max: null, currency: null, type: null, condition: null,
    capturedAt: null,
  };
}

function normalizePrice(value) {
  if (value === undefined || value === null) return emptyPrice();
  requireObject(value, '价格');
  rejectUnknown(value, PRICE_FIELDS, '价格');
  const amount = moneyField(value.amount, '价格金额');
  const min = moneyField(value.min, '价格下限');
  const max = moneyField(value.max, '价格上限');
  if (amount !== null && (min !== null || max !== null)) {
    throw new AppError('INVALID_PRICE', '价格金额与价格区间不能同时填写。');
  }
  if (min !== null && max !== null && min > max) {
    throw new AppError('INVALID_PRICE', '价格下限不能大于上限。');
  }
  const type = value.type === undefined || value.type === null ? null : value.type;
  if (type !== null && !PRICE_TYPES.includes(type)) {
    throw new AppError('INVALID_PRICE_TYPE', '价格类型不受支持。');
  }
  const currency = currencyField(value.currency);
  const condition = textField(value.condition, '价格条件', 200);
  const hasPrice = [amount, min, max, currency, type, condition].some(item => item !== null);
  return {
    amount,
    min,
    max,
    currency,
    type,
    condition,
    // Collection time is server-owned and never accepted from the client.
    capturedAt: hasPrice ? new Date() : null,
  };
}

function normalizeSku(raw) {
  requireObject(raw, 'SKU');
  rejectUnknown(raw, SKU_FIELDS, 'SKU');
  const selected = raw.selected === undefined ? true : raw.selected;
  if (typeof selected !== 'boolean') throw new AppError('INVALID_FIELD', 'SKU 选中标记必须是布尔值。');
  return {
    // Client supplied IDs are never trusted; the server issues every SKU ID.
    id: randomUUID(),
    internalSku: textField(raw.internalSku, 'SKU 编码', 100),
    sourceSkuId: textField(raw.sourceSkuId, '来源 SKU ID', 200),
    spec: textField(raw.spec, '规格组合', 500),
    selected,
    parameters: normalizeParameters(raw.parameters),
    price: normalizePrice(raw.price),
  };
}

function normalizeSkus(value) {
  if (!Array.isArray(value)) throw new AppError('INVALID_FIELD', 'SKU 必须是数组。');
  // One product maps to many SKUs in the data model, but the phase-1 API accepts one.
  if (value.length > 1) throw new AppError('SKU_LIMIT', '一期接口每个商品只能保存一个 SKU。');
  return value.map(normalizeSku);
}

function normalizeCreateStatus(value) {
  if (value === undefined || value === null) return 'draft';
  if (!['draft', 'pending'].includes(value)) {
    throw new AppError('INVALID_STATUS', '新建商品只能是草稿或待核实；确认资料请调用确认接口。');
  }
  return value;
}

function normalizeSourceType(value, fallback = 'manual') {
  if (value === undefined || value === null) return fallback;
  if (!SOURCE_TYPES.includes(value)) throw new AppError('INVALID_SOURCE', '来源类型只能是手动、链接或截图。');
  return value;
}

function createEmptySku() {
  return {
    id: randomUUID(),
    internalSku: null,
    sourceSkuId: null,
    spec: null,
    selected: true,
    parameters: [],
    price: emptyPrice(),
  };
}

export function normalizeCreate(body) {
  requireObject(body);
  rejectUnknown(body, [...PRODUCT_FIELDS, 'skus', 'reason'], '商品');
  const product = {};
  for (const [field, [label, max, required]] of Object.entries(PRODUCT_TEXT_FIELDS)) {
    const text = textField(body[field], label, max, { required });
    if (text !== null) product[field] = text;
  }
  product.sourceType = normalizeSourceType(body.sourceType);
  product.sourceUrl = sourceUrlField(body.sourceUrl);
  product.status = normalizeCreateStatus(body.status);
  return {
    product,
    // A name-only draft still gets one empty SKU so projects can reference a stable SKU ID later.
    skus: body.skus === undefined ? [createEmptySku()] : normalizeSkus(body.skus),
    reason: textField(body.reason, '修改原因', 500) || '创建商品',
  };
}

export function normalizePatch(body) {
  requireObject(body);
  rejectUnknown(body, [...PRODUCT_FIELDS, 'skus', 'reason', 'version'], '商品');
  const product = {};
  for (const [field, [label, max, required]] of Object.entries(PRODUCT_TEXT_FIELDS)) {
    if (!Object.hasOwn(body, field)) continue;
    product[field] = textField(body[field], label, max, { required });
  }
  if (Object.hasOwn(body, 'sourceType')) product.sourceType = normalizeSourceType(body.sourceType);
  if (Object.hasOwn(body, 'sourceUrl')) product.sourceUrl = sourceUrlField(body.sourceUrl);
  if (Object.hasOwn(body, 'status')) {
    if (!['draft', 'pending'].includes(body.status)) {
      throw new AppError('INVALID_STATUS', '编辑不能直接设为已确认；请调用确认接口。');
    }
    product.status = body.status;
  }
  const patch = { product, reason: textField(body.reason, '修改原因', 500) };
  if (Object.hasOwn(body, 'skus')) patch.skus = normalizeSkus(body.skus);
  return patch;
}

function listParam(value, allowed, label) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw new AppError('INVALID_FILTER', `${label}筛选值不正确。`);
  const values = value.split(',').map(item => item.trim()).filter(Boolean);
  for (const item of values) {
    if (!allowed.includes(item)) throw new AppError('INVALID_FILTER', `${label}筛选值不受支持。`);
  }
  return [...new Set(values)];
}

function intParam(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError('INVALID_PAGINATION', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return number;
}

export function normalizeListQuery(query = {}) {
  const raw = query.q ?? query.search ?? '';
  if (raw !== undefined && typeof raw !== 'string') throw new AppError('INVALID_SEARCH', '搜索词必须是文本。');
  const q = raw.trim();
  if (q.length > 100) throw new AppError('INVALID_SEARCH', '搜索词不能超过 100 个字符。');
  return {
    q,
    statuses: listParam(query.status, PRODUCT_STATUSES, '资料状态'),
    sources: listParam(query.source, SOURCE_TYPES, '来源'),
    limit: intParam(query.limit, 20, 1, MAX_PAGE_SIZE, '每页数量'),
    offset: intParam(query.offset, 0, 0, 1_000_000, '分页偏移'),
  };
}

function normalizePageQuery(query = {}) {
  return {
    limit: intParam(query.limit, 20, 1, MAX_PAGE_SIZE, '每页数量'),
    offset: intParam(query.offset, 0, 0, 1_000_000, '分页偏移'),
  };
}

export function assertProductId(value) {
  const id = String(value || '');
  if (!PRODUCT_ID.test(id)) throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。', 404);
  return id;
}

function parseVersionValue(value) {
  const number = typeof value === 'string' && /^v?\d+$/i.test(value.trim())
    ? Number(value.trim().replace(/^v/i, '')) : value;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new AppError('INVALID_VERSION', '商品版本号必须是正整数。');
  }
  return number;
}

function readExpectedVersion(body, ifMatch) {
  let header;
  if (ifMatch !== undefined) {
    const raw = String(ifMatch).trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1');
    header = parseVersionValue(raw);
  }
  let fromBody;
  if (body && Object.hasOwn(body, 'version')) fromBody = parseVersionValue(body.version);
  if (header !== undefined && fromBody !== undefined && header !== fromBody) {
    throw new AppError('INVALID_VERSION', 'If-Match 与请求体 version 不一致。');
  }
  return header ?? fromBody ?? null;
}

export function snapshotProduct(product) {
  const iso = value => (value ? new Date(value).toISOString() : null);
  const skus = (product.skus || []).map(sku => ({
    id: sku.id,
    internalSku: sku.internalSku ?? null,
    sourceSkuId: sku.sourceSkuId ?? null,
    spec: sku.spec ?? null,
    selected: sku.selected !== false,
    parameters: Array.isArray(sku.parameters) ? sku.parameters.map(row => ({ ...row })) : [],
    price: {
      amount: sku.price?.amount ?? null,
      min: sku.price?.min ?? null,
      max: sku.price?.max ?? null,
      currency: sku.price?.currency ?? null,
      type: sku.price?.type ?? null,
      condition: sku.price?.condition ?? null,
      capturedAt: iso(sku.price?.capturedAt),
    },
  }));
  return {
    productId: product.id,
    workspaceId: product.workspaceId,
    version: product.version,
    name: product.name,
    originalTitle: product.originalTitle ?? null,
    brand: product.brand ?? null,
    category: product.category ?? null,
    description: product.description ?? null,
    internalCode: product.internalCode ?? null,
    sourceType: product.sourceType ?? 'manual',
    sourcePlatform: product.sourcePlatform ?? null,
    sourceUrl: product.sourceUrl ?? null,
    sourceProductId: product.sourceProductId ?? null,
    status: product.status,
    confirmedAt: iso(product.confirmedAt),
    skus,
    createdAt: iso(product.createdAt),
    updatedAt: iso(product.updatedAt),
  };
}

function mergeSkus(current, next) {
  if (next.length === 0) return [];
  // Keep the existing SKU identity so project references survive an update.
  return [{ ...next[0], id: current[0]?.id || next[0].id }];
}

function settle(result) {
  if (result.status === 'missing') throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。', 404);
  if (result.status === 'conflict') {
    throw new AppError(
      'VERSION_CONFLICT',
      `商品已被其他修改更新到 v${result.currentVersion}，请刷新后重试。`,
      409,
    );
  }
  return result.product;
}

export class ProductService {
  constructor(repository, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.repository = repository;
    this.workspaceId = workspaceId;
  }

  async list(query = {}) {
    const filters = normalizeListQuery(query);
    const { products, total } = await this.repository.list(filters);
    return {
      products,
      total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset: filters.offset + products.length < total ? filters.offset + products.length : null,
    };
  }

  async get(id) {
    const product = await this.repository.get(assertProductId(id));
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。', 404);
    return product;
  }

  async create(body) {
    const { product, skus, reason } = normalizeCreate(body);
    return this.repository.create({
      product: {
        ...product,
        id: randomUUID(),
        workspaceId: this.workspaceId,
        status: product.status || 'draft',
        confirmedAt: null,
      },
      skus,
      reason,
    });
  }

  async update(id, body, { ifMatch } = {}) {
    const productId = assertProductId(id);
    const expectedVersion = readExpectedVersion(body, ifMatch);
    if (expectedVersion === null) {
      throw new AppError('VERSION_REQUIRED', '编辑商品需提供 If-Match 响应头或请求体中的 version。', 428);
    }
    const patch = normalizePatch(body);
    const result = await this.repository.mutate(productId, expectedVersion, current => {
      const product = { ...current, ...patch.product };
      if (patch.product.status && patch.product.status !== 'confirmed') product.confirmedAt = null;
      return {
        product,
        skus: patch.skus === undefined ? current.skus : mergeSkus(current.skus, patch.skus),
        skusChanged: patch.skus !== undefined,
        reason: patch.reason || '编辑商品资料',
      };
    });
    return settle(result);
  }

  async confirm(id, body = {}, { ifMatch } = {}) {
    const productId = assertProductId(id);
    requireObject(body);
    rejectUnknown(body, ['version', 'reason'], '确认请求');
    const expectedVersion = readExpectedVersion(body, ifMatch);
    const reason = textField(body.reason, '修改原因', 500) || '确认商品资料';
    const result = await this.repository.mutate(productId, expectedVersion, current => {
      if (current.status === 'confirmed') return { unchanged: true };
      return {
        product: { ...current, status: 'confirmed', confirmedAt: new Date() },
        skus: current.skus,
        skusChanged: false,
        reason,
      };
    });
    return settle(result);
  }

  async versions(id, query = {}) {
    const productId = assertProductId(id);
    const page = normalizePageQuery(query);
    const result = await this.repository.versions(productId, page);
    if (!result) throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。', 404);
    return {
      productId,
      version: result.version,
      versions: result.versions,
      total: result.total,
      limit: page.limit,
      offset: page.offset,
      nextOffset: page.offset + result.versions.length < result.total
        ? page.offset + result.versions.length : null,
    };
  }
}

function productFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    originalTitle: row.original_title,
    brand: row.brand,
    category: row.category,
    description: row.description,
    internalCode: row.internal_code,
    sourceType: row.source_type,
    sourcePlatform: row.source_platform,
    sourceUrl: row.source_url,
    sourceProductId: row.source_product_id,
    status: row.status,
    version: row.current_version,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function moneyFromRow(value) {
  return value === null || value === undefined ? null : Number(value);
}

function skuFromRow(row) {
  return {
    id: row.id,
    internalSku: row.internal_sku,
    sourceSkuId: row.source_sku_id,
    spec: row.spec,
    selected: row.is_selected,
    parameters: Array.isArray(row.parameters) ? row.parameters : [],
    price: {
      amount: moneyFromRow(row.price_amount),
      min: moneyFromRow(row.price_min),
      max: moneyFromRow(row.price_max),
      currency: row.currency,
      type: row.price_type,
      condition: row.price_condition,
      capturedAt: row.price_captured_at,
    },
  };
}

const INSERT_PRODUCT = `
  INSERT INTO sj_products (
    id, workspace_id, name, original_title, brand, category, description, internal_code,
    source_type, source_platform, source_url, source_product_id, status, current_version, confirmed_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  RETURNING *`;

const UPDATE_PRODUCT = `
  UPDATE sj_products SET
    name=$2, original_title=$3, brand=$4, category=$5, description=$6, internal_code=$7,
    source_type=$8, source_platform=$9, source_url=$10, source_product_id=$11, status=$12,
    confirmed_at=$13, current_version=$14, updated_at=now()
  WHERE id=$1 AND workspace_id=$15
  RETURNING *`;

const INSERT_SKU = `
  INSERT INTO sj_product_skus (
    id, product_id, workspace_id, internal_sku, source_sku_id, spec, is_selected,
    price_amount, price_min, price_max, currency, price_type, price_condition,
    price_captured_at, parameters
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`;

const INSERT_VERSION = `
  INSERT INTO sj_product_versions (
    id, product_id, workspace_id, version, snapshot, change_reason, created_by
  ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`;

export class PgProductRepository {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async insertSku(client, productId, sku) {
    const price = sku.price || emptyPrice();
    const hasPrice = PRICE_FIELDS.some(field => price[field] !== null && price[field] !== undefined);
    const capturedAt = price.capturedAt ? new Date(price.capturedAt) : (hasPrice ? new Date() : null);
    await client.query(INSERT_SKU, [
      sku.id, productId, this.workspaceId, sku.internalSku ?? null, sku.sourceSkuId ?? null,
      sku.spec ?? null, sku.selected !== false,
      price.amount ?? null, price.min ?? null, price.max ?? null,
      price.currency ?? null, price.type ?? null, price.condition ?? null,
      capturedAt, JSON.stringify(Array.isArray(sku.parameters) ? sku.parameters : []),
    ]);
  }

  async hydrate(client, row) {
    const skus = await client.query(
      'SELECT * FROM sj_product_skus WHERE product_id=$1 ORDER BY created_at, id',
      [row.id],
    );
    return { ...productFromRow(row), skus: skus.rows.map(skuFromRow) };
  }

  async create({ product, skus, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(INSERT_PRODUCT, [
        product.id, this.workspaceId, product.name, product.originalTitle ?? null,
        product.brand ?? null, product.category ?? null, product.description ?? null,
        product.internalCode ?? null, product.sourceType ?? 'manual',
        product.sourcePlatform ?? null, product.sourceUrl ?? null,
        product.sourceProductId ?? null, product.status ?? 'draft', 1, null,
      ])).rows[0];
      for (const sku of skus) await this.insertSku(client, product.id, sku);
      const hydrated = await this.hydrate(client, row);
      await client.query(INSERT_VERSION, [
        randomUUID(), product.id, this.workspaceId, 1,
        JSON.stringify(snapshotProduct(hydrated)), reason || '创建商品', 'local',
      ]);
      await client.query('COMMIT');
      return hydrated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id) {
    const client = await this.pool.connect();
    try {
      const row = (await client.query(
        'SELECT * FROM sj_products WHERE id=$1 AND workspace_id=$2',
        [id, this.workspaceId],
      )).rows[0];
      return row ? await this.hydrate(client, row) : null;
    } finally {
      client.release();
    }
  }

  async list(filters) {
    const where = ['p.workspace_id = $1'];
    const params = [this.workspaceId];
    if (filters.q) {
      // Escape LIKE wildcards so the search term is matched literally; SQL remains parameterized.
      params.push(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`);
      const token = `$${params.length}`;
      where.push(`(
        p.name ILIKE ${token} ESCAPE '\\'
        OR p.brand ILIKE ${token} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM sj_product_skus s
          WHERE s.product_id = p.id AND (
            s.internal_sku ILIKE ${token} ESCAPE '\\'
            OR s.source_sku_id ILIKE ${token} ESCAPE '\\'
            OR s.spec ILIKE ${token} ESCAPE '\\'
          )
        )
      )`);
    }
    if (filters.statuses.length) {
      params.push(filters.statuses);
      where.push(`p.status = ANY($${params.length}::text[])`);
    }
    if (filters.sources.length) {
      params.push(filters.sources);
      where.push(`p.source_type = ANY($${params.length}::text[])`);
    }
    const whereSql = where.join(' AND ');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const total = (await client.query(
        `SELECT count(*)::int AS total FROM sj_products p WHERE ${whereSql}`,
        params,
      )).rows[0].total;
      const rows = (await client.query(
        `SELECT p.* FROM sj_products p WHERE ${whereSql}
         ORDER BY p.updated_at DESC, p.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.limit, filters.offset],
      )).rows;
      let skuRows = [];
      if (rows.length) {
        skuRows = (await client.query(
          'SELECT * FROM sj_product_skus WHERE product_id = ANY($1::uuid[]) ORDER BY created_at, id',
          [rows.map(row => row.id)],
        )).rows;
      }
      const byProduct = new Map();
      for (const sku of skuRows) {
        if (!byProduct.has(sku.product_id)) byProduct.set(sku.product_id, []);
        byProduct.get(sku.product_id).push(skuFromRow(sku));
      }
      const products = rows.map(row => ({
        ...productFromRow(row),
        skus: byProduct.get(row.id) || [],
      }));
      await client.query('COMMIT');
      return { products, total };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async mutate(id, expectedVersion, mutate) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT * FROM sj_products WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [id, this.workspaceId],
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const current = await this.hydrate(client, row);
      if (expectedVersion !== null && expectedVersion !== current.version) {
        await client.query('ROLLBACK');
        return { status: 'conflict', currentVersion: current.version };
      }
      const next = await mutate(current);
      if (next.unchanged) {
        await client.query('COMMIT');
        return { status: 'ok', product: current };
      }
      const version = current.version + 1;
      const product = { ...next.product, version };
      const updated = (await client.query(UPDATE_PRODUCT, [
        id, product.name, product.originalTitle ?? null, product.brand ?? null,
        product.category ?? null, product.description ?? null, product.internalCode ?? null,
        product.sourceType ?? 'manual', product.sourcePlatform ?? null,
        product.sourceUrl ?? null, product.sourceProductId ?? null, product.status,
        product.confirmedAt ?? null, version, this.workspaceId,
      ])).rows[0];
      if (next.skusChanged !== false) {
        await client.query('DELETE FROM sj_product_skus WHERE product_id=$1', [id]);
        for (const sku of next.skus) await this.insertSku(client, id, sku);
      }
      const hydrated = await this.hydrate(client, updated);
      await client.query(INSERT_VERSION, [
        randomUUID(), id, this.workspaceId, version,
        JSON.stringify(snapshotProduct(hydrated)), next.reason || null, 'local',
      ]);
      await client.query('COMMIT');
      return { status: 'ok', product: hydrated };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async versions(id, { limit, offset }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const product = (await client.query(
        'SELECT current_version FROM sj_products WHERE id=$1 AND workspace_id=$2',
        [id, this.workspaceId],
      )).rows[0];
      if (!product) {
        await client.query('ROLLBACK');
        return null;
      }
      const total = (await client.query(
        'SELECT count(*)::int AS total FROM sj_product_versions WHERE product_id=$1 AND workspace_id=$2',
        [id, this.workspaceId],
      )).rows[0].total;
      const rows = (await client.query(
        `SELECT * FROM sj_product_versions WHERE product_id=$1 AND workspace_id=$2
         ORDER BY version DESC LIMIT $3 OFFSET $4`,
        [id, this.workspaceId, limit, offset],
      )).rows;
      await client.query('COMMIT');
      return {
        version: product.current_version,
        versions: rows.map(row => ({
          id: row.id,
          version: row.version,
          changeReason: row.change_reason,
          createdBy: row.created_by,
          createdAt: row.created_at,
          snapshot: row.snapshot,
        })),
        total,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
