import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { ADAPTER_ID_PATTERN, VISION_CAPABILITY, VisionAdapterRegistry } from './vision.mjs';

// Screenshot intake (Issue #10, uploads wired in Issue #23). Flow:
//   resolve server-stored screenshots by imageId -> fingerprint the stored sha256 set ->
//   dedupe per workspace -> call a registered vision adapter -> validate fields/evidence/
//   confidence -> merge several screenshots into one review -> create a pending product
//   only when the name is determined -> bind the batch to that product.
// The client never supplies sha256 or objectKey: both are read from sj_product_images
// rows stored by the upload service. The adapter itself is undecided (Q-02); tests
// register a mock adapter and no real model call is made by this module. Screenshots
// are evidence only and are never cropped into a generated main image.
export const DEFAULT_WORKSPACE_ID = 'local';
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const NAME_CONFIDENCE = 0.7;
export const REVIEW_CONFIDENCE = 0.8;
export const CONFLICT_MARGIN = 0.2;
export const INTAKE_STATUSES = ['processing', 'completed', 'needs_review', 'failed'];

export const SCREENSHOT_BILLING_NOTE =
  '截图识别按所选视觉供应商与模型的实际账单计费（计量单位以 Q-02 确认结果为准）；同一组截图指纹重复提交不会再次调用模型。';
export const VISION_NOT_READY_NOTE = '视觉模型尚未配置，提交不会调用模型，也不会产生费用。';
export const DUPLICATE_BILLING_NOTE = '该组截图已识别过，本次未调用模型、未新增商品；历史是否计费以供应商账单为准。';

export const SCREENSHOT_NOTICES = [
  '截图会发送给当前视觉模型渠道处理；上传前请裁剪账号、订单等无关信息。',
  '来源截图仅作资料证据，不会裁切成生成主图；生成主图需另行上传清晰原图。',
  '字段按截图证据与置信度保存；金额、尺寸、型号等低置信度值需人工核实。',
  '截图中没有的字段保持为空，不按常识补齐。',
];

const INTAKE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRICE_TYPES = ['sale', 'starting', 'list', 'coupon', 'member'];
const TEXT_FIELDS = {
  name: 200,
  originalTitle: 500,
  brand: 100,
  category: 100,
  description: 5000,
};

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max).trim() : '';
}

function keyOf(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function evidenceKey(item) {
  return `${item.imageSha256}|${item.quote || ''}|${item.region ? JSON.stringify(item.region) : ''}`;
}

function dedupeEvidence(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function confidenceOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function normalizeRegion(value) {
  if (!isObject(value)) return null;
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  const numbers = [x, y, width, height];
  if (numbers.some(number => typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1)) {
    return null;
  }
  return { x, y, width, height };
}

function normalizeEvidence(value, imageIndex) {
  if (!Array.isArray(value) || !value.length) return null;
  const evidence = [];
  for (const raw of value.slice(0, 8)) {
    if (!isObject(raw)) continue;
    const sha = typeof raw.imageSha256 === 'string' ? raw.imageSha256.toLowerCase() : '';
    // A field may only cite a screenshot submitted in this batch.
    if (!imageIndex.has(sha)) continue;
    const quote = clip(raw.quote, 500) || null;
    evidence.push({
      imageSha256: sha,
      quote,
      region: normalizeRegion(raw.region),
    });
  }
  return evidence.length ? dedupeEvidence(evidence) : null;
}

function normalizeTextCandidate(raw, limit, imageIndex) {
  if (!isObject(raw)) return null;
  const value = clip(raw.value, limit);
  const confidence = confidenceOf(raw.confidence);
  if (!value || confidence === null) return null;
  const evidence = normalizeEvidence(raw.evidence, imageIndex);
  // Fields without a screenshot citation are discarded: no silent facts.
  if (!evidence) return null;
  return { value, confidence, evidence };
}

function normalizeNumber(value, { min = 0, max = 1_000_000_000_000, decimals = 4 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null;
  const scaled = value * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
  return Math.round(scaled) / 10 ** decimals;
}

function normalizePrice(raw, imageIndex) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) return null;
  const confidence = confidenceOf(raw.confidence);
  const evidence = normalizeEvidence(raw.evidence, imageIndex);
  if (confidence === null || !evidence) return null;
  const amount = normalizeNumber(raw.amount);
  const min = normalizeNumber(raw.min);
  const max = normalizeNumber(raw.max);
  if (amount !== null && (min !== null || max !== null)) return null;
  if (min !== null && max !== null && min > max) return null;
  const currency = typeof raw.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency.trim())
    ? raw.currency.trim().toUpperCase() : null;
  const type = PRICE_TYPES.includes(raw.type) ? raw.type : null;
  const condition = clip(raw.condition, 200) || null;
  if ([amount, min, max, currency, type, condition].every(item => item === null)) return null;
  return { amount, min, max, currency, type, condition, confidence, evidence };
}

function normalizeParameters(raw, imageIndex) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [];
  const parameters = [];
  for (const item of raw.slice(0, 50)) {
    if (!isObject(item)) continue;
    const name = clip(item.name, 100);
    const confidence = confidenceOf(item.confidence);
    const evidence = normalizeEvidence(item.evidence, imageIndex);
    if (!name || confidence === null || !evidence) continue;
    parameters.push({
      name,
      value: clip(item.value, 200),
      unit: clip(item.unit, 50) || null,
      confidence,
      evidence,
    });
  }
  return parameters;
}

function normalizeSku(raw, imageIndex) {
  if (!isObject(raw)) return null;
  const spec = normalizeTextCandidate(raw.spec, 500, imageIndex);
  const price = normalizePrice(raw.price, imageIndex);
  const parameters = normalizeParameters(raw.parameters, imageIndex);
  if (!spec && !price && !parameters.length) return null;
  const confidences = [spec?.confidence, price?.confidence, ...parameters.map(item => item.confidence)]
    .filter(value => typeof value === 'number');
  return {
    spec,
    price,
    parameters,
    confidence: confidences.length ? Math.max(...confidences) : 0,
  };
}

function normalizeObservation(raw, imageIndex) {
  if (!isObject(raw)) return null;
  const fields = {};
  for (const [key, limit] of Object.entries(TEXT_FIELDS)) {
    const candidate = normalizeTextCandidate(raw.fields?.[key], limit, imageIndex);
    if (candidate) fields[key] = candidate;
  }
  const sku = normalizeSku(raw.sku, imageIndex);
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter(item => typeof item === 'string').slice(0, 10).map(item => clip(item, 200)).filter(Boolean)
    : [];
  if (!Object.keys(fields).length && !sku && !warnings.length) return null;
  return { fields, sku, warnings };
}

// Adapter output is untrusted. Invalid JSON shapes are rejected; individual
// fields without usable evidence are dropped and counted instead of trusted.
export function normalizeVisionOutput(raw, images) {
  if (!isObject(raw) || !Array.isArray(raw.observations)) {
    fail('VISION_RESULT_INVALID', '视觉模型返回的结构化结果无法校验，未建档；本次调用可能已计费。', 502);
  }
  const imageIndex = new Map(images.map(image => [image.sha256, image]));
  const observations = [];
  let dropped = 0;
  for (const item of raw.observations.slice(0, 50)) {
    const observation = normalizeObservation(item, imageIndex);
    if (observation) observations.push(observation);
    else dropped += 1;
  }
  if (raw.observations.length > 50) dropped += raw.observations.length - 50;
  return { observations, dropped };
}

function mergeCandidates(candidates, field) {
  if (!candidates.length) return null;
  const groups = new Map();
  for (const candidate of candidates) {
    const key = keyOf(candidate.value);
    const group = groups.get(key) || {
      value: candidate.value,
      confidence: 0,
      evidence: [],
    };
    group.confidence = Math.max(group.confidence, candidate.confidence);
    group.evidence = dedupeEvidence([...group.evidence, ...candidate.evidence]);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0];
  const conflicted = sorted.length > 1 && top.confidence - sorted[1].confidence < CONFLICT_MARGIN;
  const evidence = dedupeEvidence(sorted.flatMap(group => group.evidence));
  return {
    field,
    value: top.value,
    confidence: top.confidence,
    conflicted,
    needsReview: conflicted || top.confidence < REVIEW_CONFIDENCE,
    evidence,
    alternatives: sorted.slice(1).map(group => ({ value: group.value, confidence: group.confidence })),
  };
}

function fieldEntry(candidate) {
  if (!candidate) return null;
  return {
    field: candidate.field,
    value: candidate.value,
    confidence: candidate.confidence,
    needsReview: candidate.needsReview,
    conflicted: candidate.conflicted,
    evidence: candidate.evidence,
    alternatives: candidate.alternatives,
  };
}

function priceLabel(price) {
  if (price.amount !== null) return `${price.currency ? `${price.currency} ` : ''}${price.amount}`;
  if (price.min !== null || price.max !== null) {
    return `${price.currency ? `${price.currency} ` : ''}${price.min ?? ''}–${price.max ?? ''}`;
  }
  return [price.currency, price.type, price.condition].filter(Boolean).join(' / ');
}

function mergeSku(observations) {
  const skus = observations.map(item => item.sku).filter(Boolean);
  const result = {
    spec: null,
    price: null,
    parameters: [],
    entries: [],
    conflicts: [],
    multipleSpecs: false,
    needsReview: false,
  };
  if (!skus.length) return result;

  const specCandidates = skus.map(item => item.spec).filter(Boolean);
  const spec = mergeCandidates(specCandidates, 'sku.spec');
  const chosenSpecKey = spec ? keyOf(spec.value) : null;
  const distinctSpecs = new Map();
  for (const item of specCandidates) {
    const key = keyOf(item.value);
    const current = distinctSpecs.get(key);
    if (!current || item.confidence > current.confidence) {
      distinctSpecs.set(key, { value: item.value, confidence: item.confidence });
    }
  }
  result.multipleSpecs = distinctSpecs.size > 1;

  // Phase one stores one SKU: merge only screenshots that agree with the
  // highest-confidence spec (or carry no spec).
  const relevant = spec
    ? skus.filter(item => !item.spec || keyOf(item.spec.value) === chosenSpecKey)
    : skus;

  const prices = relevant.map(item => item.price).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  const price = prices[0] || null;
  const priceSignatures = new Set(prices.map(item => JSON.stringify([
    item.amount, item.min, item.max, item.currency, item.type, item.condition,
  ])));
  const priceConflict = priceSignatures.size > 1;
  result.price = price;
  result.spec = spec;

  if (spec) {
    const conflicted = spec.conflicted || result.multipleSpecs;
    result.entries.push({
      field: 'sku.spec',
      value: spec.value,
      confidence: spec.confidence,
      needsReview: conflicted || spec.confidence < REVIEW_CONFIDENCE,
      conflicted,
      evidence: spec.evidence,
      alternatives: spec.alternatives,
    });
    if (result.multipleSpecs) {
      result.conflicts.push({
        field: 'sku.spec',
        values: [...distinctSpecs.values()],
        chosen: spec.value,
      });
    }
  }

  if (price) {
    const needsReview = priceConflict || price.confidence < REVIEW_CONFIDENCE;
    const addPrice = (field, value) => {
      if (value === null || value === undefined) return;
      result.entries.push({
        field,
        value,
        confidence: price.confidence,
        needsReview,
        conflicted: priceConflict,
        evidence: price.evidence,
        alternatives: [],
      });
    };
    addPrice('sku.price.amount', price.amount);
    addPrice('sku.price.min', price.min);
    addPrice('sku.price.max', price.max);
    addPrice('sku.price.currency', price.currency);
    addPrice('sku.price.type', price.type);
    addPrice('sku.price.condition', price.condition);
    if (priceConflict) {
      result.conflicts.push({
        field: 'sku.price',
        values: prices.map(item => ({ value: priceLabel(item), confidence: item.confidence })),
        chosen: priceLabel(price),
      });
    }
  }

  const groups = new Map();
  for (const item of relevant) {
    for (const parameter of item.parameters) {
      const key = keyOf(parameter.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(parameter);
    }
  }
  for (const list of groups.values()) {
    const byValue = new Map();
    for (const parameter of list) {
      const key = `${keyOf(parameter.value)}|${keyOf(parameter.unit || '')}`;
      const group = byValue.get(key) || {
        name: parameter.name,
        value: parameter.value,
        unit: parameter.unit,
        confidence: 0,
        evidence: [],
      };
      group.confidence = Math.max(group.confidence, parameter.confidence);
      group.evidence = dedupeEvidence([...group.evidence, ...parameter.evidence]);
      byValue.set(key, group);
    }
    const sorted = [...byValue.values()].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0];
    const conflicted = sorted.length > 1;
    const evidence = dedupeEvidence(sorted.flatMap(group => group.evidence));
    const label = top.unit ? `${top.value} ${top.unit}` : top.value;
    result.parameters.push({ name: top.name, value: top.value, unit: top.unit });
    result.entries.push({
      field: `sku.parameters.${top.name}`,
      value: label,
      confidence: top.confidence,
      needsReview: conflicted || top.confidence < REVIEW_CONFIDENCE,
      conflicted,
      evidence,
      alternatives: sorted.slice(1).map(group => ({
        value: group.unit ? `${group.value} ${group.unit}` : group.value,
        confidence: group.confidence,
      })),
    });
    if (conflicted) {
      result.conflicts.push({
        field: `sku.parameters.${top.name}`,
        values: sorted.map(group => ({
          value: group.unit ? `${group.value} ${group.unit}` : group.value,
          confidence: group.confidence,
        })),
        chosen: label,
      });
    }
  }

  result.needsReview = result.multipleSpecs || priceConflict ||
    result.entries.some(entry => entry.needsReview);
  return result;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function buildProductInput({ fields, sku, platform, imageCount }) {
  const name = fields.name;
  const product = {
    name: name.value,
    originalTitle: fields.originalTitle?.value || name.value,
    sourceType: 'screenshot',
    status: 'pending',
    reason: `截图识别建档（${imageCount} 张截图）`,
  };
  for (const key of ['brand', 'category', 'description']) {
    if (fields[key]) product[key] = fields[key].value;
  }
  if (platform) product.sourcePlatform = platform;
  const skuInput = {};
  if (sku.spec) skuInput.spec = sku.spec.value;
  if (sku.price && [sku.price.amount, sku.price.min, sku.price.max].some(item => item !== null)) {
    skuInput.price = {
      amount: sku.price.amount,
      min: sku.price.min,
      max: sku.price.max,
      currency: sku.price.currency,
      type: sku.price.type,
      condition: sku.price.condition,
    };
  }
  if (sku.parameters.length) {
    skuInput.parameters = sku.parameters.map(item => ({
      name: item.name,
      value: item.value,
      unit: item.unit || null,
    }));
  }
  product.skus = [skuInput];
  return product;
}

export function buildReview({ observations, platform, imageCount, dropped = 0 }) {
  const fields = {};
  for (const [key, limit] of Object.entries(TEXT_FIELDS)) {
    const candidates = observations.map(item => item.fields[key]).filter(Boolean);
    const merged = mergeCandidates(candidates, key);
    if (merged) fields[key] = merged;
  }
  const sku = mergeSku(observations);
  const entries = [];
  for (const key of Object.keys(TEXT_FIELDS)) {
    const entry = fieldEntry(fields[key]);
    if (entry) entries.push(entry);
  }
  entries.push(...sku.entries);

  const conflicts = [];
  for (const key of Object.keys(TEXT_FIELDS)) {
    const candidate = fields[key];
    if (candidate?.conflicted) {
      conflicts.push({
        field: key,
        values: [{ value: candidate.value, confidence: candidate.confidence }, ...candidate.alternatives],
        chosen: candidate.value,
      });
    }
  }
  conflicts.push(...sku.conflicts);

  const missing = [];
  if (!fields.name) missing.push('name');
  if (!fields.brand) missing.push('brand');
  if (!fields.category) missing.push('category');
  if (!sku.spec) missing.push('sku.spec');
  if (!sku.price || [sku.price.amount, sku.price.min, sku.price.max].every(item => item === null)) {
    missing.push('sku.price');
  } else if (!sku.price.currency) {
    missing.push('sku.price.currency');
  }
  if (!sku.parameters.length) missing.push('sku.parameters');

  const lowConfidence = [...new Set(entries
    .filter(entry => entry.confidence < REVIEW_CONFIDENCE)
    .map(entry => entry.field))];

  const name = fields.name;
  const nameDetermined = Boolean(name && name.confidence >= NAME_CONFIDENCE && !name.conflicted);
  let reason;
  if (!name) {
    reason = '未从截图中识别到商品名称，未建档空壳。请上传包含商品标题的截图，或改用手动录入。';
  } else if (name.conflicted) {
    reason = '多张截图的商品名称互相冲突且置信度接近，无法确定唯一商品，未建档。请确认为同一商品后重试。';
  } else if (name.confidence < NAME_CONFIDENCE) {
    reason = `商品名称识别置信度仅 ${percent(name.confidence)}，低于建档门槛，未建档空壳。请补拍清晰的标题截图或手动录入。`;
  } else {
    reason = '已按截图识别结果建立待核实草稿，请核对低置信度、冲突与缺失字段。';
  }

  const warnings = observations.flatMap(item => item.warnings).slice(0, 20);
  if (dropped) warnings.push(`${dropped} 条识别观察缺少可校验的字段证据，已丢弃。`);

  const review = {
    nameDetermined,
    needsReview: !nameDetermined || conflicts.length > 0 || lowConfidence.length > 0 || sku.needsReview,
    decision: { created: nameDetermined, reason },
    fields: entries,
    conflicts,
    missing,
    lowConfidence,
    warnings: [...new Set(warnings)],
    notices: [...SCREENSHOT_NOTICES],
    mainImage: null,
    mainImageNote: '来源截图不用于生成主图，未从截图裁切任何图片。',
  };
  return {
    review,
    productInput: nameDetermined
      ? buildProductInput({ fields, sku, platform, imageCount })
      : null,
  };
}

// The request carries only IDs of screenshots already stored by the upload
// service. sha256, objectKey, content type and size are read from the database,
// so a forged hash cannot influence dedupe and a forged key cannot influence
// storage (Issue #23).
export function normalizeImageIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMAGES) {
    fail('INVALID_IMAGES', `请提供 1–${MAX_IMAGES} 张已上传截图的 imageId。`);
  }
  const ids = value.map((raw, index) => {
    if (typeof raw !== 'string' || !INTAKE_ID.test(raw)) {
      fail('INVALID_IMAGES', `第 ${index + 1} 张截图的 imageId 不正确。`);
    }
    return raw;
  });
  if (new Set(ids).size !== ids.length) {
    fail('DUPLICATE_IMAGE', '同一批截图里包含重复文件，请只保留一张。');
  }
  return ids;
}

export function fingerprintOf(workspaceId, images) {
  const list = images.map(image => image.sha256).sort().join('\n');
  return createHash('sha256').update(`${workspaceId}\n${list}`).digest('hex');
}

function rejectUnknown(body, allowed, label) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function normalizeCommon(body, label) {
  if (!isObject(body)) fail('INVALID_BODY', `${label}必须是 JSON 对象。`);
  // Never accept client-side hashes or keys, and never accept the old `images`
  // metadata array. Rejecting them is explicit; nothing from them is used.
  for (const key of ['images', 'sha256', 'objectKey']) {
    if (Object.hasOwn(body, key)) {
      fail('INVALID_FIELD', `客户端不得提供 ${key}；截图识别只接收服务端已登记的 imageIds。`);
    }
  }
  for (const key of ['mainImage', 'crop', 'role']) {
    if (Object.hasOwn(body, key)) {
      fail('SCREENSHOT_NOT_MAIN_IMAGE', '来源截图只能作为资料证据，不能指定为生成主图或裁切为生成输入。');
    }
  }
  rejectUnknown(
    body,
    label === '截图识别预检'
      ? ['imageIds', 'adapter']
      : ['imageIds', 'adapter', 'platform', 'retry', 'requestKey'],
    label,
  );
  const imageIds = normalizeImageIds(body.imageIds);
  const adapter = body.adapter === undefined || body.adapter === null ? null : body.adapter;
  if (adapter !== null && (typeof adapter !== 'string' || !ADAPTER_ID_PATTERN.test(adapter))) {
    fail('INVALID_ADAPTER', '视觉适配器标识需为 2–40 位小写字母、数字或连字符，并以字母开头。');
  }
  return { imageIds, adapter };
}

export function normalizeSubmit(body) {
  const { imageIds, adapter } = normalizeCommon(body, '截图识别请求');
  let platform = null;
  if (body.platform !== undefined && body.platform !== null) {
    if (typeof body.platform !== 'string' || clip(body.platform, 50).length === 0) {
      fail('INVALID_FIELD', '来源平台必须是非空文本。');
    }
    platform = clip(body.platform, 50);
  }
  const retry = body.retry === undefined ? false : body.retry;
  if (typeof retry !== 'boolean') fail('INVALID_FIELD', 'retry 必须是布尔值。');
  let requestKey = null;
  if (body.requestKey !== undefined && body.requestKey !== null) {
    if (typeof body.requestKey !== 'string' || !REQUEST_KEY.test(body.requestKey)) {
      fail('INVALID_REQUEST_KEY', 'requestKey 需为 1–200 个字母、数字、点、下划线、冒号或连字符。');
    }
    requestKey = body.requestKey;
  }
  return { imageIds, adapter, platform, retry, requestKey };
}

export function normalizePreflight(body) {
  return normalizeCommon(body, '截图识别预检');
}

export function assertIntakeId(value) {
  const id = String(value || '');
  if (!INTAKE_ID.test(id)) fail('INTAKE_NOT_FOUND', '截图识别记录不存在。', 404);
  return id;
}

// Object keys are server-owned and never echoed to clients.
function publicImages(images) {
  return images.map(image => ({
    id: image.id,
    sha256: image.sha256,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes,
  }));
}

export class ScreenshotIntakeService {
  constructor({
    products, store, vision, screenshots, workspaceId = DEFAULT_WORKSPACE_ID, adapterId = null,
  }) {
    if (!products || typeof products.create !== 'function') {
      throw new AppError('INTAKE_CONFIG', '截图识别需要商品服务。', 500);
    }
    if (!store) throw new AppError('INTAKE_CONFIG', '截图识别需要去重存储。', 500);
    if (!screenshots || typeof screenshots.findByIds !== 'function') {
      throw new AppError('INTAKE_CONFIG', '截图识别需要已上传截图存储。', 500);
    }
    this.products = products;
    this.store = store;
    this.screenshots = screenshots;
    this.vision = vision || new VisionAdapterRegistry();
    this.workspaceId = workspaceId;
    this.adapterId = adapterId;
  }

  // Loads screenshot metadata from the server-side upload records. The request
  // only names image IDs; hashes, object keys, content types and sizes below are
  // authoritative server values.
  async loadImages(imageIds) {
    const rows = await this.screenshots.findByIds(imageIds);
    const byId = new Map((rows || []).map(row => [row.id, row]));
    const images = [];
    for (const [index, id] of imageIds.entries()) {
      const row = byId.get(id);
      if (!row) {
        fail('IMAGE_NOT_FOUND', `第 ${index + 1} 张截图未上传或不属于当前工作空间，请先上传截图。`, 404);
      }
      if (row.kind !== 'screenshot') {
        fail('SCREENSHOT_REQUIRED', '只有来源截图可以用于截图识别，商品原图不能作为识别证据。');
      }
      if (!SHA256.test(String(row.sha256 || '')) || !IMAGE_CONTENT_TYPES.includes(row.contentType) ||
          !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_IMAGE_BYTES) {
        fail('SCREENSHOT_INVALID', `第 ${index + 1} 张截图的存储记录无效，请重新上传。`);
      }
      images.push({
        id: row.id,
        sha256: row.sha256,
        objectKey: row.objectKey,
        contentType: row.contentType,
        sizeBytes: row.bytes,
      });
    }
    const seen = new Set();
    for (const image of images) {
      if (seen.has(image.sha256)) fail('DUPLICATE_IMAGE', '同一批截图里包含重复文件，请只保留一张。');
      seen.add(image.sha256);
    }
    return images;
  }

  async productFor(record) {
    if (!record.productId) return null;
    try {
      return await this.products.get(record.productId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRODUCT_NOT_FOUND') return null;
      throw error;
    }
  }

  async preflight(body) {
    const input = normalizePreflight(body);
    const images = await this.loadImages(input.imageIds);
    const fingerprint = fingerprintOf(this.workspaceId, images);
    const existing = await this.store.check(fingerprint);
    const requested = input.adapter || this.adapterId;
    const unknown = Boolean(requested && !this.vision.has(requested));
    const adapter = unknown ? null : this.vision.resolve(requested);
    const ready = Boolean(adapter);
    return {
      capability: VISION_CAPABILITY,
      fingerprint,
      imageCount: images.length,
      images: publicImages(images),
      vision: {
        ready,
        adapter,
        registered: this.vision.list(),
        reason: ready
          ? null
          : unknown
            ? `视觉适配器 ${requested} 未注册，截图识别暂不可用。`
            : this.vision.list().length > 1
              ? '已注册多个视觉适配器，请明确指定本次使用的适配器。'
              : '视觉模型供应商与模型尚未确认（Q-02），截图识别暂不可用。',
      },
      duplicate: Boolean(existing),
      existing: existing ? {
        intakeId: existing.id,
        status: existing.status,
        productId: existing.productId,
        billed: existing.billed,
        retryable: existing.status === 'failed',
      } : null,
      billing: ready
        ? { chargeable: true, unit: 'batch', note: SCREENSHOT_BILLING_NOTE }
        : { chargeable: false, unit: null, note: VISION_NOT_READY_NOTE },
      notices: [...SCREENSHOT_NOTICES],
    };
  }

  publicRecord(record, product) {
    return {
      intakeId: record.id,
      fingerprint: record.fingerprint,
      status: record.status,
      productCreated: record.status === 'completed',
      product,
      review: record.result?.review ?? null,
      model: record.result?.model ?? null,
      images: publicImages(record.images || []),
      billed: record.billed,
      attempts: record.attempt,
      error: record.error,
      requestKey: record.requestKey ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async existingResponse(record) {
    if (record.status === 'processing') {
      throw new AppError('INTAKE_IN_PROGRESS', '同一组截图正在识别中，请稍后查询结果，不会重复调用模型。', 409);
    }
    if (record.status === 'failed') {
      throw new AppError(
        'INTAKE_FAILED',
        '该组截图上次识别失败，未自动重试；是否已计费以供应商账单为准。如需再次识别，请显式传 retry: true。',
        409,
      );
    }
    const product = await this.productFor(record);
    return {
      ...this.publicRecord(record, product),
      duplicate: true,
      billing: {
        visionInvoked: false,
        duplicate: true,
        previouslyBilled: record.billed,
        note: DUPLICATE_BILLING_NOTE,
      },
    };
  }

  async submit(body) {
    const input = normalizeSubmit(body);
    const images = await this.loadImages(input.imageIds);
    // The fingerprint is derived only from server-stored sha256 values, so a
    // client cannot force a dedupe hit or miss by sending its own hash.
    const fingerprint = fingerprintOf(this.workspaceId, images);
    const requested = input.adapter || this.adapterId;
    if (requested && !this.vision.has(requested)) {
      throw new AppError('VISION_ADAPTER_UNKNOWN', `视觉适配器 ${requested} 未注册。截图未发送，也未产生费用。`, 409);
    }
    const adapterId = this.vision.resolve(requested);
    if (!adapterId) {
      if (this.vision.list().length > 1) {
        throw new AppError('VISION_ADAPTER_REQUIRED', '已注册多个视觉适配器，请明确指定本次使用的适配器。', 409);
      }
      // Nothing is claimed and no model is called when the capability is
      // unconfigured; preflight has already told the user no cost is incurred.
      throw new AppError(
        'VISION_NOT_CONFIGURED',
        '视觉模型供应商与模型尚未确认（Q-02），截图识别暂不可用。截图未发送给任何供应商，也未产生费用。',
        503,
      );
    }

    const id = randomUUID();
    const claim = await this.store.claim({
      id,
      workspaceId: this.workspaceId,
      fingerprint,
      images,
      requestKey: input.requestKey,
      retry: input.retry,
    });
    if (claim.status === 'existing') return this.existingResponse(claim.record);
    // A retry keeps the original batch id so evidence and dedupe stay on one row.
    const intakeId = claim.record.id;

    let product = null;
    let record;
    try {
      const analyzed = await this.vision.analyze({
        adapter: adapterId,
        images,
        workspaceId: this.workspaceId,
      });
      const output = normalizeVisionOutput(analyzed.result, images);
      const { review, productInput } = buildReview({
        observations: output.observations,
        platform: input.platform,
        imageCount: images.length,
        dropped: output.dropped,
      });
      if (productInput) {
        try {
          product = await this.products.create(productInput);
        } catch (error) {
          // The vision call already happened, so the batch is terminal and
          // must not be re-run automatically just to retry validation.
          throw new AppError(
            'INTAKE_INVALID_RESULT',
            '识别结果无法通过商品校验，未建档；本次视觉调用可能已计费，请改用手动录入或显式重试。',
            422,
          );
        }
        // A successful intake binds the screenshots that were uploaded before
        // the product existed. Review batches stay unbound for manual entry.
        await this.screenshots.bindToProduct(input.imageIds, product.id);
      }
      record = await this.store.finish(intakeId, {
        status: product ? 'completed' : 'needs_review',
        productId: product?.id ?? null,
        result: {
          review,
          model: { adapterId, capability: VISION_CAPABILITY },
          dropped: output.dropped,
        },
        billed: true,
      });
    } catch (error) {
      const safe = error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: 'VISION_FAILED', message: '视觉识别失败。' };
      await this.store.fail(intakeId, { error: safe, billed: true }).catch(() => {});
      if (error instanceof AppError && ['VISION_RESULT_INVALID', 'INTAKE_INVALID_RESULT'].includes(error.code)) {
        throw error;
      }
      throw new AppError(
        'VISION_FAILED',
        '视觉识别失败，未自动重试；是否已计费以供应商账单为准。',
        502,
      );
    }

    return {
      ...this.publicRecord(record, product),
      duplicate: false,
      billing: {
        visionInvoked: true,
        duplicate: false,
        previouslyBilled: false,
        note: product
          ? SCREENSHOT_BILLING_NOTE
          : `${SCREENSHOT_BILLING_NOTE} 名称未能确定时不建档，但本次识别调用仍按供应商账单计费。`,
      },
    };
  }

  async get(id) {
    const record = await this.store.get(assertIntakeId(id));
    if (!record) throw new AppError('INTAKE_NOT_FOUND', '截图识别记录不存在。', 404);
    const product = await this.productFor(record);
    return this.publicRecord(record, product);
  }
}

function recordFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fingerprint: row.fingerprint,
    requestKey: row.request_key,
    status: row.status,
    images: Array.isArray(row.images) ? row.images : [],
    result: row.result,
    productId: row.product_id,
    error: row.error,
    billed: row.billed,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// PostgreSQL store for dedupe and intake evidence. The unique index on
// (workspace_id, fingerprint) is the billing/idempotency boundary; a
// transaction-scoped advisory lock serializes concurrent claims for one batch.
export class PgScreenshotIntakeStore {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async claim({ id, fingerprint, images, requestKey, retry }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sj:screenshot-intake:${this.workspaceId}:${fingerprint}`,
      ]);
      const existing = (await client.query(
        'SELECT * FROM sj_screenshot_intakes WHERE workspace_id=$1 AND fingerprint=$2 FOR UPDATE',
        [this.workspaceId, fingerprint],
      )).rows[0];
      if (!existing) {
        const row = (await client.query(`
          INSERT INTO sj_screenshot_intakes
            (id,workspace_id,fingerprint,request_key,status,images,billed,attempt)
          VALUES ($1,$2,$3,$4,'processing',$5::jsonb,false,1)
          RETURNING *
        `, [id, this.workspaceId, fingerprint, requestKey, JSON.stringify(images)])).rows[0];
        await client.query('COMMIT');
        return { status: 'new', record: recordFromRow(row) };
      }
      if (retry && existing.status === 'failed') {
        const row = (await client.query(`
          UPDATE sj_screenshot_intakes SET
            status='processing', result=NULL, product_id=NULL, error=NULL,
            billed=false, attempt=attempt+1, updated_at=now()
          WHERE id=$1 RETURNING *
        `, [existing.id])).rows[0];
        await client.query('COMMIT');
        return { status: 'new', record: recordFromRow(row) };
      }
      await client.query('COMMIT');
      return { status: 'existing', record: recordFromRow(existing) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(id, { status, productId, result, billed }) {
    const row = (await this.pool.query(`
      UPDATE sj_screenshot_intakes SET
        status=$3, product_id=$4, result=$5::jsonb, error=NULL, billed=$6, updated_at=now()
      WHERE id=$1 AND workspace_id=$2
      RETURNING *
    `, [id, this.workspaceId, status, productId, JSON.stringify(result), billed])).rows[0];
    if (!row) throw new AppError('INTAKE_NOT_FOUND', '截图识别记录不存在。', 404);
    return recordFromRow(row);
  }

  async fail(id, { error, billed }) {
    const row = (await this.pool.query(`
      UPDATE sj_screenshot_intakes SET
        status='failed', error=$3::jsonb, billed=$4, updated_at=now()
      WHERE id=$1 AND workspace_id=$2
      RETURNING *
    `, [id, this.workspaceId, JSON.stringify(error), billed])).rows[0];
    if (!row) throw new AppError('INTAKE_NOT_FOUND', '截图识别记录不存在。', 404);
    return recordFromRow(row);
  }

  async get(id) {
    const row = (await this.pool.query(
      'SELECT * FROM sj_screenshot_intakes WHERE id=$1 AND workspace_id=$2',
      [id, this.workspaceId],
    )).rows[0];
    return row ? recordFromRow(row) : null;
  }

  async check(fingerprint) {
    const row = (await this.pool.query(
      'SELECT * FROM sj_screenshot_intakes WHERE workspace_id=$1 AND fingerprint=$2',
      [this.workspaceId, fingerprint],
    )).rows[0];
    return row ? recordFromRow(row) : null;
  }
}

// Reads the metadata of screenshots stored by the upload service (sj_product_images)
// and binds a successfully created product to its batch. The database row is the
// only source of sha256 / object_key / content_type / bytes (Issue #23).
export class PgScreenshotImageStore {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async findByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const rows = (await this.pool.query(`
      SELECT id, product_id, kind, object_key, content_type, extension,
             bytes, width, height, sha256, created_at
      FROM sj_product_images
      WHERE workspace_id=$1 AND id = ANY($2::uuid[])
    `, [this.workspaceId, ids])).rows;
    return rows.map(row => ({
      id: row.id,
      productId: row.product_id,
      kind: row.kind,
      objectKey: row.object_key,
      contentType: row.content_type,
      extension: row.extension,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
      createdAt: row.created_at,
    }));
  }

  async bindToProduct(ids, productId) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const result = await this.pool.query(`
      UPDATE sj_product_images SET product_id=$1
      WHERE workspace_id=$2 AND id = ANY($3::uuid[]) AND kind='screenshot'
    `, [productId, this.workspaceId, ids]);
    return result.rowCount;
  }
}
