import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { parseUnitPrice } from './billing.mjs';

// AI 查价候选与管理员采用（Issue #20）。设计依据见 docs/adr/0008 与
// docs/FUNCTIONAL_SPEC.md §8.4：
// - 查价需要独立的搜索/提取能力：由注入的适配器实现 `lookup(request)`，
//   返回未信任的候选数组；适配器未配置时记录一次失败的查价并提示手动定价，
//   绝不让正在被定价的模型自己去上网。
// - 查价结果只是候选：带来源链接、页面标题、抓取时间、价格版本与档位才可入库；
//   未采用的候选永远不进入 sj_model_prices，因此不参与估价。
// - 采用只由管理员显式执行，必须填写依据；采用会写入新的价格版本，
//   既有账本流水保留原价格快照，只影响之后的新任务。
// - 过期候选读取时标记并提示；默认拒绝采用，只有管理员显式确认复核后才可覆盖。
// - 外币候选不静默换汇：需要汇率、来源与日期的折算流程尚未实现，直接拒绝采用。

export const DEFAULT_WORKSPACE_ID = 'local';
export const LOOKUP_STATUSES = Object.freeze(['completed', 'empty', 'failed']);
export const CANDIDATE_STATUSES = Object.freeze(['pending', 'adopted', 'superseded', 'rejected']);
export const UNITS = Object.freeze([
  'image', 'call', 'second', 'minute', 'character', 'thousand_characters',
  'token', 'thousand_tokens', 'million_tokens',
]);
export const DEFAULT_TTL_DAYS = 7;
export const MAX_TTL_DAYS = 90;

const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const TIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const REGION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,49}$/;
const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LOOKUP_FIELDS = ['capability', 'modelId', 'tier', 'region', 'currency', 'expiresInDays'];
const ADOPT_FIELDS = ['basis', 'confirmExpired'];
const MAX_ADAPTER_CANDIDATES = 50;
const MAX_REJECTED_DETAILS = 20;

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

function patternField(value, label, pattern, message, { required = true } = {}) {
  const text = textField(value, label, 200, { required });
  if (text === null) return null;
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

function isPrivateHost(host) {
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')
    || name.endsWith('.internal') || name.endsWith('.local')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) {
    const [a, b] = name.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const address = name.replace(/^\[|\]$/g, '');
  return address === '::1' || address === '::'
    || address.startsWith('fc') || address.startsWith('fd')
    || address.startsWith('fe8') || address.startsWith('fe9')
    || address.startsWith('fea') || address.startsWith('feb');
}

// 来源必须是公开 HTTP(S) 页面；拒绝凭据、回环、内网与云元数据地址。
function sourceUrlField(value) {
  const text = textField(value, '来源链接', 2000, { required: true });
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('INVALID_SOURCE_URL', '来源链接格式不正确。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('INVALID_SOURCE_URL', '来源链接只支持 http 或 https。');
  }
  if (url.username || url.password) {
    fail('INVALID_SOURCE_URL', '来源链接不能包含账号或密码。');
  }
  if (isPrivateHost(url.hostname)) {
    fail('INVALID_SOURCE_URL', '来源链接不能指向本机或内网地址。');
  }
  return url.toString();
}

function dateField(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_DATE', `${label}格式不正确。`);
  return date;
}

function normalizeLookup(body) {
  requireObject(body);
  rejectUnknown(body, LOOKUP_FIELDS, '查价');
  const capability = patternField(body.capability, 'capability', CAPABILITY,
    'capability 格式不正确。');
  const modelId = patternField(body.modelId, 'modelId', MODEL_ID, 'modelId 格式不正确。');
  const tier = body.tier === undefined || body.tier === null || body.tier === ''
    ? 'default'
    : patternField(body.tier, 'tier', TIER, 'tier 格式不正确。');
  const region = patternField(body.region, 'region', REGION,
    'region 格式不正确。', { required: false });
  const currency = body.currency === undefined || body.currency === null || body.currency === ''
    ? 'CNY'
    : String(body.currency).trim().toUpperCase();
  if (!CURRENCY.test(currency)) fail('INVALID_CURRENCY', 'currency 必须是 3 位大写字母代码。');
  const expiresInDays = body.expiresInDays === undefined || body.expiresInDays === null
    ? DEFAULT_TTL_DAYS
    : integerField(body.expiresInDays, '有效期天数', { min: 1, max: MAX_TTL_DAYS });
  return { capability, modelId, tier, region, currency, expiresInDays };
}

function normalizeCandidate(raw, request, fetchedAt, expiresAt) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_CANDIDATE', '候选必须是 JSON 对象。');
  }
  const sourceUrl = sourceUrlField(raw.sourceUrl);
  const sourceTitle = textField(raw.sourceTitle, '页面标题', 300, { required: true });
  const tier = raw.tier === undefined || raw.tier === null || raw.tier === ''
    ? request.tier
    : patternField(raw.tier, 'tier', TIER, 'tier 格式不正确。');
  const region = raw.region === undefined || raw.region === null || raw.region === ''
    ? request.region
    : patternField(raw.region, 'region', REGION, 'region 格式不正确。');
  const currency = raw.currency === undefined || raw.currency === null || raw.currency === ''
    ? request.currency
    : String(raw.currency).trim().toUpperCase();
  if (!CURRENCY.test(currency)) fail('INVALID_CURRENCY', '候选币种必须是 3 位大写字母代码。');
  if (!UNITS.includes(raw.unit)) {
    fail('INVALID_UNIT', `候选 unit 只能是：${UNITS.join('、')}。`);
  }
  if (raw.unitPrice === undefined || raw.unitPrice === null) {
    fail('INVALID_PRICE', '候选必须提供 unitPrice。');
  }
  const unitPrice = parseUnitPrice(raw.unitPrice).text;
  const modelVersion = textField(raw.modelVersion, '模型版本', 200);
  const matchNote = textField(raw.matchNote, '匹配说明', 1000);
  let confidence = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)
      || raw.confidence < 0 || raw.confidence > 1) {
      fail('INVALID_CONFIDENCE', '置信度必须是 0–1 之间的数字。');
    }
    confidence = raw.confidence;
  }
  return {
    capability: request.capability,
    modelId: request.modelId,
    tier,
    region,
    currency,
    unit: raw.unit,
    unitPrice,
    sourceUrl,
    sourceTitle,
    modelVersion,
    matchNote,
    confidence,
    fetchedAt,
    expiresAt,
    status: 'pending',
    adoptedBy: null,
    adoptedAt: null,
    adoptionBasis: null,
    adoptedPriceId: null,
    adoptedPriceVersion: null,
    adoptedExpired: false,
    createdAt: fetchedAt,
  };
}

function adapterCandidates(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && Array.isArray(result.candidates)) {
    return result.candidates;
  }
  fail('PRICE_LOOKUP_FORMAT', '查价适配器返回格式不正确。', 502);
}

function candidateKey(candidate) {
  return [
    candidate.sourceUrl, candidate.unit, candidate.unitPrice,
    candidate.currency, candidate.tier,
  ].join('|');
}

function isExpired(candidate, now) {
  const expiresAt = dateField(candidate.expiresAt, '候选过期时间');
  return Boolean(expiresAt && expiresAt <= now);
}

function publicCandidate(row, now) {
  const expired = isExpired(row, now);
  return {
    id: row.id,
    lookupId: row.lookupId,
    workspaceId: row.workspaceId,
    capability: row.capability,
    modelId: row.modelId,
    tier: row.tier,
    priceVersion: row.version,
    region: row.region ?? null,
    currency: row.currency,
    unit: row.unit,
    unitPrice: row.unitPrice,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    modelVersion: row.modelVersion ?? null,
    matchNote: row.matchNote ?? null,
    confidence: row.confidence ?? null,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
    status: row.status,
    expired,
    adoptable: row.status === 'pending',
    adoption: row.status === 'adopted' ? {
      adoptedBy: row.adoptedBy,
      adoptedAt: row.adoptedAt,
      basis: row.adoptionBasis,
      priceId: row.adoptedPriceId,
      priceVersion: row.adoptedPriceVersion,
      confirmedExpired: Boolean(row.adoptedExpired),
    } : null,
    createdAt: row.createdAt,
  };
}

function publicLookup(row, candidates, now) {
  const expiredCount = candidates.filter(candidate => isExpired(candidate, now)).length;
  const warnings = [];
  if (row.status === 'failed') warnings.push(row.error || '查价失败，请手动定价。');
  if (row.status === 'empty') warnings.push('未找到带公开来源的候选价格，请手动定价。');
  if (expiredCount) warnings.push(`${expiredCount} 个候选已过期，采用前需复核。`);
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? null,
    capability: row.capability,
    modelId: row.modelId,
    tier: row.tier,
    region: row.region ?? null,
    status: row.status,
    candidateCount: row.candidateCount ?? candidates.length,
    rejectedCount: row.rejectedCount ?? 0,
    error: row.error ?? null,
    requestedBy: row.requestedBy ?? null,
    expiredCandidateCount: expiredCount,
    warnings,
    createdAt: row.createdAt,
  };
}

function pricePublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    capability: row.capability,
    modelId: row.modelId,
    tier: row.tier,
    unit: row.unit,
    currency: row.currency,
    unitPrice: row.unitPrice,
    billingMode: row.billingMode,
    version: row.version,
    active: row.active,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo ?? null,
    note: row.note ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export class PriceLookupService {
  constructor(repository, { workspaceId = DEFAULT_WORKSPACE_ID, adapter = null, now = () => new Date() } = {}) {
    this.repository = repository;
    this.workspaceId = workspaceId;
    this.adapter = adapter;
    this.now = now;
  }

  // ---- 查价 ----

  async lookup(body, { actorId = 'local' } = {}) {
    const request = normalizeLookup(body);
    const fetchedAt = this.now();
    const expiresAt = new Date(fetchedAt.getTime() + request.expiresInDays * 24 * 60 * 60 * 1000);

    let rawCandidates = [];
    let failure = null;
    if (!this.adapter || typeof this.adapter.lookup !== 'function') {
      failure = '查价来源尚未配置（Q-10），请使用手动定价。';
    } else {
      try {
        const result = await this.adapter.lookup({
          capability: request.capability,
          modelId: request.modelId,
          tier: request.tier,
          region: request.region,
          currency: request.currency,
        });
        rawCandidates = adapterCandidates(result);
      } catch (error) {
        failure = error instanceof AppError
          ? error.message
          : '查价适配器暂时不可用，请稍后重试或手动定价。';
      }
    }

    const candidates = [];
    const rejected = [];
    const seen = new Set();
    if (!failure) {
      for (const raw of rawCandidates.slice(0, MAX_ADAPTER_CANDIDATES)) {
        let candidate;
        try {
          candidate = normalizeCandidate(raw, request, fetchedAt, expiresAt);
        } catch (error) {
          if (rejected.length < MAX_REJECTED_DETAILS) {
            rejected.push({
              reason: error instanceof AppError ? error.message : '候选格式不正确。',
            });
          }
          continue;
        }
        const key = candidateKey(candidate);
        if (seen.has(key)) {
          if (rejected.length < MAX_REJECTED_DETAILS) {
            rejected.push({ reason: `重复候选：${candidate.sourceUrl}` });
          }
          continue;
        }
        seen.add(key);
        candidates.push(candidate);
      }
      if (rawCandidates.length > MAX_ADAPTER_CANDIDATES) {
        rejected.push({ reason: `适配器返回超过 ${MAX_ADAPTER_CANDIDATES} 条候选，其余已忽略。` });
      }
    }

    const status = failure ? 'failed' : candidates.length ? 'completed' : 'empty';
    const lookup = {
      id: randomUUID(),
      workspaceId: this.workspaceId,
      capability: request.capability,
      modelId: request.modelId,
      tier: request.tier,
      region: request.region,
      status,
      candidateCount: candidates.length,
      rejectedCount: rejected.length,
      detail: {
        request: {
          capability: request.capability,
          modelId: request.modelId,
          tier: request.tier,
          region: request.region,
          currency: request.currency,
          expiresInDays: request.expiresInDays,
        },
        rejected,
      },
      error: failure,
      requestedBy: actorId,
      createdAt: fetchedAt,
    };
    const rows = candidates.map(candidate => ({
      id: randomUUID(),
      lookupId: lookup.id,
      workspaceId: this.workspaceId,
      ...candidate,
    }));
    const stored = await this.repository.createLookup({
      workspaceId: this.workspaceId, lookup, candidates: rows,
    });
    return this.describe(stored.lookup, stored.candidates);
  }

  async list(query = {}) {
    const filters = this.#listFilters(query);
    const result = await this.repository.listLookups({ workspaceId: this.workspaceId, ...filters });
    const now = this.now();
    return {
      lookups: result.lookups.map(row => publicLookup(row, [], now)),
      total: result.total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset: filters.offset + result.lookups.length < result.total
        ? filters.offset + result.lookups.length : null,
    };
  }

  async get(idValue) {
    const id = this.#uuid(idValue, '查价编号');
    const found = await this.repository.getLookup({ workspaceId: this.workspaceId, id });
    if (!found) fail('PRICE_LOOKUP_NOT_FOUND', '查价记录不存在。', 404);
    return this.describe(found.lookup, found.candidates);
  }

  // ---- 采用 ----

  async adopt(candidateIdValue, body = {}, { actorId = 'local' } = {}) {
    const candidateId = this.#uuid(candidateIdValue, '候选编号');
    requireObject(body);
    rejectUnknown(body, ADOPT_FIELDS, '采用');
    const basis = textField(body.basis, '采用依据', 500, { required: true });
    if (body.confirmExpired !== undefined && typeof body.confirmExpired !== 'boolean') {
      fail('INVALID_FIELD', 'confirmExpired 必须是布尔值。');
    }
    const candidate = await this.repository.getCandidate({
      workspaceId: this.workspaceId, id: candidateId,
    });
    if (!candidate) fail('PRICE_CANDIDATE_NOT_FOUND', '价格候选不存在。', 404);
    if (candidate.status !== 'pending') {
      fail('CANDIDATE_ALREADY_DECIDED', '该候选已采用或已失效，不能重复采用。', 409);
    }
    // 无来源不能采用：入库前已校验，这里再校验一次，防止旧数据或直接写库绕过。
    if (!candidate.sourceUrl || !candidate.sourceTitle) {
      fail('PRICE_SOURCE_REQUIRED', '候选缺少来源链接或页面标题，不能采用。', 422);
    }
    if (!candidate.unitPrice && candidate.unitPrice !== '0') {
      fail('PRICE_SOURCE_REQUIRED', '候选缺少价格，不能采用。', 422);
    }
    const now = this.now();
    const expired = isExpired(candidate, now);
    if (expired && body.confirmExpired !== true) {
      fail('CANDIDATE_EXPIRED', '候选已过期，请重新查价；确认复核后才可采用旧候选。', 409);
    }
    if (candidate.currency !== 'CNY') {
      fail('CURRENCY_CONVERSION_REQUIRED',
        '外币候选需先按记录的汇率、来源与日期折算为 CNY，当前不能直接采用。', 422);
    }
    const result = await this.repository.adoptCandidate({
      workspaceId: this.workspaceId,
      candidateId,
      actorId,
      basis,
      priceId: randomUUID(),
      adoptedAt: now,
      confirmExpired: expired && body.confirmExpired === true,
    });
    return {
      candidate: publicCandidate(result.candidate, now),
      price: pricePublic(result.price),
    };
  }

  describe(lookup, candidates) {
    const now = this.now();
    return {
      lookup: publicLookup(lookup, candidates, now),
      candidates: candidates.map(candidate => publicCandidate(candidate, now)),
    };
  }

  #listFilters(query) {
    return {
      capability: query.capability
        ? patternField(query.capability, 'capability', CAPABILITY, 'capability 格式不正确。') : null,
      modelId: query.modelId
        ? patternField(query.modelId, 'modelId', MODEL_ID, 'modelId 格式不正确。') : null,
      status: query.status
        ? patternField(query.status, 'status', /^(completed|empty|failed)$/,
          `status 只能是：${LOOKUP_STATUSES.join('、')}。`) : null,
      limit: query.limit === undefined ? 20 : integerField(query.limit, '每页数量', { min: 1, max: 100 }),
      offset: query.offset === undefined ? 0 : integerField(query.offset, '分页偏移', { min: 0, max: 1_000_000 }),
    };
  }

  #uuid(value, label) {
    const text = String(value ?? '').trim();
    if (!UUID.test(text)) fail('INVALID_ID', `${label}格式不正确。`);
    return text;
  }
}

// ---- PostgreSQL 仓储 ----

function decimalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed || '0';
}

function lookupFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    capability: row.capability,
    modelId: row.model_id,
    tier: row.tier,
    region: row.region,
    status: row.status,
    candidateCount: row.candidate_count,
    rejectedCount: row.rejected_count,
    detail: row.detail || {},
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
  };
}

function candidateFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    lookupId: row.lookup_id,
    workspaceId: row.workspace_id,
    capability: row.capability,
    modelId: row.model_id,
    tier: row.tier,
    version: row.version,
    region: row.region,
    currency: row.currency,
    unit: row.unit,
    unitPrice: decimalText(row.unit_price),
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    modelVersion: row.model_version,
    matchNote: row.match_note,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    status: row.status,
    adoptedBy: row.adopted_by,
    adoptedAt: row.adopted_at,
    adoptionBasis: row.adoption_basis,
    adoptedPriceId: row.adopted_price_id,
    adoptedPriceVersion: row.adopted_price_version,
    adoptedExpired: row.adopted_expired,
    createdAt: row.created_at,
  };
}

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
    unitPrice: decimalText(row.unit_price),
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

export class PgPriceLookupRepository {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async createLookup({ workspaceId, lookup, candidates }) {
    const ws = workspaceId ?? this.workspaceId;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 候选可能带不同档位条件，版本号按每条候选自己的模型/能力/档位分配；
      // 工作空间级锁保证并发查价不会拿到相同版本号。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sj:price-lookup:${ws}`,
      ]);
      const lookupRow = (await client.query(`
        INSERT INTO sj_price_lookups (
          id, workspace_id, capability, model_id, tier, region, status,
          candidate_count, rejected_count, detail, error, requested_by, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *
      `, [
        lookup.id, ws, lookup.capability, lookup.modelId, lookup.tier, lookup.region,
        lookup.status, lookup.candidateCount, lookup.rejectedCount,
        JSON.stringify(lookup.detail || {}), lookup.error, lookup.requestedBy,
        lookup.createdAt,
      ])).rows[0];
      const rows = [];
      for (const candidate of candidates) {
        const version = (await client.query(`
          SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM sj_price_candidates
          WHERE workspace_id=$1 AND capability=$2 AND model_id=$3 AND tier=$4
        `, [ws, candidate.capability, candidate.modelId, candidate.tier])).rows[0].version;
        rows.push((await client.query(`
          INSERT INTO sj_price_candidates (
            id, lookup_id, workspace_id, capability, model_id, tier, version,
            region, currency, unit, unit_price, source_url, source_title, model_version,
            match_note, confidence, fetched_at, expires_at, status, created_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
          ) RETURNING *
        `, [
          candidate.id, lookup.id, ws, candidate.capability, candidate.modelId,
          candidate.tier, version, candidate.region, candidate.currency, candidate.unit,
          candidate.unitPrice, candidate.sourceUrl, candidate.sourceTitle,
          candidate.modelVersion, candidate.matchNote, candidate.confidence,
          candidate.fetchedAt, candidate.expiresAt, candidate.status, candidate.createdAt,
        ])).rows[0]);
      }
      await client.query('COMMIT');
      return { lookup: lookupFromRow(lookupRow), candidates: rows.map(candidateFromRow) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getLookup({ workspaceId, id }) {
    const ws = workspaceId ?? this.workspaceId;
    const lookupRow = (await this.pool.query(
      'SELECT * FROM sj_price_lookups WHERE workspace_id=$1 AND id=$2', [ws, id],
    )).rows[0];
    if (!lookupRow) return null;
    const rows = (await this.pool.query(
      `SELECT * FROM sj_price_candidates WHERE workspace_id=$1 AND lookup_id=$2
       ORDER BY version, created_at`,
      [ws, id],
    )).rows;
    return { lookup: lookupFromRow(lookupRow), candidates: rows.map(candidateFromRow) };
  }

  async getCandidate({ workspaceId, id }) {
    const ws = workspaceId ?? this.workspaceId;
    return candidateFromRow((await this.pool.query(
      'SELECT * FROM sj_price_candidates WHERE workspace_id=$1 AND id=$2', [ws, id],
    )).rows[0]);
  }

  async listLookups({ workspaceId, capability, modelId, status, limit, offset }) {
    const ws = workspaceId ?? this.workspaceId;
    const where = ['workspace_id=$1'];
    const params = [ws];
    if (capability) { params.push(capability); where.push(`capability=$${params.length}`); }
    if (modelId) { params.push(modelId); where.push(`model_id=$${params.length}`); }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    const whereSql = where.join(' AND ');
    const total = (await this.pool.query(
      `SELECT count(*)::int AS total FROM sj_price_lookups WHERE ${whereSql}`, params,
    )).rows[0].total;
    const rows = (await this.pool.query(
      `SELECT * FROM sj_price_lookups WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    )).rows;
    return { lookups: rows.map(lookupFromRow), total };
  }

  async adoptCandidate({
    workspaceId, candidateId, actorId, basis, priceId, adoptedAt, confirmExpired,
  }) {
    const ws = workspaceId ?? this.workspaceId;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = (await client.query(
        'SELECT * FROM sj_price_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [ws, candidateId],
      )).rows[0];
      if (!candidate) fail('PRICE_CANDIDATE_NOT_FOUND', '价格候选不存在。', 404);
      if (candidate.status !== 'pending') {
        fail('CANDIDATE_ALREADY_DECIDED', '该候选已采用或已失效，不能重复采用。', 409);
      }
      if (!candidate.source_url || !candidate.source_title) {
        fail('PRICE_SOURCE_REQUIRED', '候选缺少来源链接或页面标题，不能采用。', 422);
      }
      if (!confirmExpired && candidate.expires_at
        && new Date(candidate.expires_at) <= new Date(adoptedAt)) {
        fail('CANDIDATE_EXPIRED', '候选已过期，请重新查价；确认复核后才可采用旧候选。', 409);
      }
      if (candidate.currency !== 'CNY') {
        fail('CURRENCY_CONVERSION_REQUIRED',
          '外币候选需先按记录的汇率、来源与日期折算为 CNY，当前不能直接采用。', 422);
      }
      // 与账本改价使用同一把锁，保证价格版本号与停用旧价是原子的。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sj:billing:price:${ws}:${candidate.capability}:${candidate.model_id}:${candidate.tier}`,
      ]);
      const version = (await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version FROM sj_model_prices
        WHERE workspace_id=$1 AND capability=$2 AND model_id=$3 AND tier=$4
      `, [ws, candidate.capability, candidate.model_id, candidate.tier])).rows[0].version;
      await client.query(`
        UPDATE sj_model_prices SET active=false, updated_at=now()
        WHERE workspace_id=$1 AND capability=$2 AND model_id=$3 AND tier=$4 AND active=true
      `, [ws, candidate.capability, candidate.model_id, candidate.tier]);
      const note = `AI 查价采用：${candidate.source_title}`.slice(0, 500);
      const priceRow = (await client.query(`
        INSERT INTO sj_model_prices (
          id, workspace_id, capability, model_id, tier, unit, currency, unit_price,
          billing_mode, version, active, effective_from, note, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'chargeable',$9,true,$10,$11,$12)
        RETURNING *
      `, [
        priceId, ws, candidate.capability, candidate.model_id, candidate.tier,
        candidate.unit, candidate.currency, candidate.unit_price, version,
        adoptedAt, note, actorId,
      ])).rows[0];
      const updated = (await client.query(`
        UPDATE sj_price_candidates SET
          status='adopted', adopted_by=$3, adopted_at=$4, adoption_basis=$5,
          adopted_price_id=$6, adopted_price_version=$7, adopted_expired=$8
        WHERE workspace_id=$1 AND id=$2 AND status='pending'
        RETURNING *
      `, [
        ws, candidateId, actorId, adoptedAt, basis, priceId, version,
        Boolean(confirmExpired),
      ])).rows[0];
      if (!updated) {
        fail('CANDIDATE_ALREADY_DECIDED', '该候选已采用或已失效，不能重复采用。', 409);
      }
      await client.query('COMMIT');
      return { candidate: candidateFromRow(updated), price: priceFromRow(priceRow) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
