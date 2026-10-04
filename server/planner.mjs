import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

// AI 规划（Issue #11 / FLOW-12—FLOW-15）。
//
// 输入只有资料快照与用户补充要求；输出是交付项类型库内的草稿清单。
// 规划调用通过模型网关的 text.chat 执行，只记录用量与成本（cost_only），
// 不预占、不生成图片、不自动确认方案。文本模型不可用或输出不合规时，
// 回退到类型库的确定性默认清单；不自动切换其他付费模型。
export const TYPE_LIBRARY_VERSION = '1';

export const TYPE_LIBRARY = Object.freeze([
  Object.freeze({
    type: 'white',
    name: '白底主图 / 多角度',
    purpose: '正面白底、侧面、背面等主图合规用途',
    aspectRatio: '1:1',
    workflow: Object.freeze(['prompt', 'generate']),
  }),
  Object.freeze({
    type: 'scene',
    name: '场景图',
    purpose: '使用场景、氛围布景',
    aspectRatio: '3:4',
    workflow: Object.freeze(['prompt', 'generate']),
  }),
  Object.freeze({
    type: 'selling',
    name: '卖点 / 促销图',
    purpose: '无字底图 + 模板合成文案',
    aspectRatio: '1:1',
    workflow: Object.freeze(['prompt', 'generate', 'composite']),
  }),
  Object.freeze({
    type: 'detail',
    name: '细节 / 尺寸 / 包装清单',
    purpose: '细节特写、尺寸标注、包装内容物等信息图',
    aspectRatio: '3:4',
    workflow: Object.freeze(['prompt', 'generate', 'composite']),
  }),
  Object.freeze({
    type: 'extension',
    name: 'AI 扩展建议',
    purpose: '类型库外、AI 针对该商品提议的图',
    aspectRatio: '1:1',
    workflow: Object.freeze(['prompt', 'generate']),
  }),
]);

export const PROMPT_SLOT_KEYS = Object.freeze([
  'subject', 'scene', 'composition', 'lighting', 'style', 'material', 'mustKeep', 'forbidden', 'aspectRatio',
]);

export const PROMPT_SLOT_LABELS = Object.freeze({
  subject: '主体/数量',
  scene: '场景',
  composition: '构图/视角',
  lighting: '光线',
  style: '风格',
  material: '材质/颜色',
  mustKeep: '必须保持',
  forbidden: '禁止出现',
  aspectRatio: '画幅',
});

export const COPY_SLOTS = Object.freeze(['headline', 'subheadline', 'badge', 'cta']);
export const ASPECT_RATIOS = Object.freeze(['1:1', '3:4']);
export const MAX_DELIVERABLES = 10;
export const MAX_BRANCHES = 3;
export const MAX_EXTENSIONS = 5;
export const MAX_REQUIREMENT = 500;
const MAX_SNAPSHOT_JSON = 12_000;

const DELIVERABLE_TYPES = TYPE_LIBRARY
  .filter(item => item.type !== 'extension')
  .map(item => item.type);
const TYPE_BY_ID = new Map(TYPE_LIBRARY.map(item => [item.type, item]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_TYPES = ['sale', 'starting', 'list', 'coupon', 'member'];
const SOURCE_TYPES = ['manual', 'link', 'screenshot'];
const PRODUCT_STATUSES = ['draft', 'pending', 'confirmed'];

// 事实护栏只拦截“商品事实”类表述：功效、认证、材质与具体数字。
// 场景、光线、构图等创作指令不在此列，除非它们夹带了这些事实。
// 未在资料快照中出现的说法会被标记为“待核实”并从正式提示词/文案中移除。
const FEATURE_CLAIMS = Object.freeze([
  '防水', '防摔', '防尘', '防刮', '防滑', '防漏', '防锈', '防霉', '耐磨', '不掉色', '不掉漆', '不褪色', '不变形', '不粘',
  '认证', '食品级', '医用级', '母婴级', '食品接触', '接触食物', '可直接入口',
  '环保', '抗菌', '抑菌', '无毒', '无味', '保温', '保冷', '耐高温', '可机洗',
  '承重', '静音', '进口', '专利', '有机', '纯天然', '纯手工', '原装', '正品', '官方',
  '保修', '包换', '退货', '终身', '冠军', '顶级', '销量第一',
]);

const MATERIAL_CLAIMS = Object.freeze([
  '陶瓷', '不锈钢', '玻璃', '塑料', '硅胶', '木质', '实木', '竹制', '纯棉', '棉质', '亚麻', '麻质',
  '涤纶', '尼龙', '真皮', '皮革', '铝合金', '碳纤维', '钛',
]);

const QUANTIFIERS = '张个款套组条份件只支双对';

const SAFE_SLOT_DEFAULTS = Object.freeze({
  subject: snapshot => `商品「${snapshot.name}」`,
  scene: () => '简洁纯色背景，突出商品',
  composition: () => '正面视角，商品居中',
  lighting: () => '柔和均匀光线',
  style: () => '真实商品摄影风格',
  material: () => '颜色与表面以商品资料为准',
  mustKeep: () => '保持商品原有形状与颜色，不添加未确认的信息',
  forbidden: () => '未在商品资料中确认的材质、容量、认证、价格与卖点',
});

class ModelOutputError extends Error {}

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function outputFail(message) {
  throw new ModelOutputError(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function readText(value, label, { required = false, max = 200, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (typeof value !== 'string') fail('INVALID_FIELD', `${label}必须是文本。`);
  const text = value.trim();
  if (!text) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (text.length < min) fail('INVALID_FIELD', `${label}至少需要 ${min} 个字符。`);
  if (text.length > max) fail('INVALID_FIELD', `${label}不能超过 ${max} 个字符。`);
  return text;
}

function readInteger(value, label, { required = false, min = 0, max = 2_147_483_647 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_FIELD', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return value;
}

function readUrl(value) {
  const text = readText(value, '来源链接', { max: 2000 });
  if (!text) return null;
  let url;
  try { url = new URL(text); }
  catch { fail('INVALID_SNAPSHOT', '来源链接格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('INVALID_SNAPSHOT', '来源链接必须是 http/https 地址且不能包含账号。');
  }
  return url.toString();
}

function readTextList(value, label, { maxItems = 20, maxLength = 200 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('INVALID_FIELD', `${label}必须是数组。`);
  if (value.length > maxItems) fail('INVALID_FIELD', `${label}不能超过 ${maxItems} 项。`);
  const result = [];
  for (const item of value) {
    const text = readText(item, label, { required: true, max: maxLength });
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

function normalizeParameters(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('INVALID_FIELD', 'SKU 参数必须是数组。');
  if (value.length > 50) fail('INVALID_FIELD', 'SKU 参数不能超过 50 项。');
  return value.map(raw => {
    if (!isObject(raw)) fail('INVALID_SNAPSHOT', 'SKU 参数必须是对象。');
    rejectUnknown(raw, ['name', 'value', 'unit'], 'SKU 参数');
    return {
      name: readText(raw.name, '参数名', { required: true, max: 100 }),
      value: readText(raw.value, '参数值', { max: 200 }),
      unit: readText(raw.unit, '单位', { max: 50 }),
    };
  });
}

function readMoney(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) {
    fail('INVALID_SNAPSHOT', `${label}超出允许范围。`);
  }
  return value;
}

function normalizePrice(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) fail('INVALID_SNAPSHOT', '价格必须是对象。');
  rejectUnknown(value, ['amount', 'min', 'max', 'currency', 'type', 'condition', 'capturedAt'], '价格');
  const amount = readMoney(value.amount, '价格金额');
  const min = readMoney(value.min, '价格下限');
  const max = readMoney(value.max, '价格上限');
  if (amount !== null && (min !== null || max !== null)) {
    fail('INVALID_SNAPSHOT', '价格金额与价格区间不能同时填写。');
  }
  if (min !== null && max !== null && min > max) fail('INVALID_SNAPSHOT', '价格下限不能大于上限。');
  let currency = readText(value.currency, '币种', { max: 3 });
  if (currency !== null) {
    currency = currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_SNAPSHOT', '币种需为 3 位字母，例如 CNY。');
  }
  const type = readText(value.type, '价格类型', { max: 20 });
  if (type !== null && !PRICE_TYPES.includes(type)) fail('INVALID_SNAPSHOT', '价格类型不受支持。');
  return {
    amount,
    min,
    max,
    currency,
    type,
    condition: readText(value.condition, '价格条件', { max: 200 }),
    capturedAt: readText(value.capturedAt, '采集时间', { max: 40 }),
  };
}

function normalizeSku(raw) {
  if (!isObject(raw)) fail('INVALID_SNAPSHOT', 'SKU 必须是对象。');
  rejectUnknown(raw, ['id', 'internalSku', 'sourceSkuId', 'spec', 'selected', 'parameters', 'price'], 'SKU');
  let id = null;
  if (raw.id !== undefined && raw.id !== null) {
    id = String(raw.id);
    if (!UUID.test(id)) fail('INVALID_SNAPSHOT', 'SKU 编号格式不正确。');
  }
  const selected = raw.selected === undefined ? true : raw.selected;
  if (typeof selected !== 'boolean') fail('INVALID_FIELD', 'SKU 选中标记必须是布尔值。');
  return {
    id,
    internalSku: readText(raw.internalSku, 'SKU 编码', { max: 100 }),
    sourceSkuId: readText(raw.sourceSkuId, '来源 SKU ID', { max: 200 }),
    spec: readText(raw.spec, '规格组合', { max: 500 }),
    selected,
    parameters: normalizeParameters(raw.parameters),
    price: normalizePrice(raw.price),
  };
}

const SNAPSHOT_FIELDS = [
  'productId', 'workspaceId', 'version', 'name', 'originalTitle', 'brand', 'category', 'description',
  'internalCode', 'sourceType', 'sourcePlatform', 'sourceUrl', 'sourceProductId', 'status',
  'confirmedAt', 'createdAt', 'updatedAt', 'skus', 'sellingPoints', 'forbiddenPhrases',
];

// 只接受已核实资料的快照。项目冻结快照可以直接传入；未确认的草稿不能用于规划。
export function normalizeSnapshot(value) {
  if (!isObject(value)) fail('INVALID_SNAPSHOT', '商品资料快照必须是对象。');
  rejectUnknown(value, SNAPSHOT_FIELDS, '商品资料快照');
  const status = readText(value.status, '资料状态', { max: 20 });
  if (status === null || !PRODUCT_STATUSES.includes(status)) {
    fail('INVALID_SNAPSHOT', '商品资料快照缺少有效的资料状态。');
  }
  if (status !== 'confirmed') {
    fail('SNAPSHOT_NOT_CONFIRMED', 'AI 规划只能使用已确认的商品资料快照。', 409);
  }
  let productId = null;
  if (value.productId !== undefined && value.productId !== null) {
    productId = String(value.productId);
    if (!UUID.test(productId)) fail('INVALID_SNAPSHOT', '商品编号格式不正确。');
  }
  const sourceType = readText(value.sourceType, '来源类型', { max: 20 });
  if (sourceType !== null && !SOURCE_TYPES.includes(sourceType)) {
    fail('INVALID_SNAPSHOT', '来源类型只能是手动、链接或截图。');
  }
  const skus = value.skus === undefined || value.skus === null ? [] : value.skus;
  if (!Array.isArray(skus)) fail('INVALID_FIELD', 'SKU 必须是数组。');
  if (skus.length > 20) fail('INVALID_FIELD', '资料快照中的 SKU 不能超过 20 个。');
  const snapshot = {
    productId,
    workspaceId: readText(value.workspaceId, '工作空间', { max: 50 }),
    version: readInteger(value.version, '资料版本', { min: 1 }),
    name: readText(value.name, '商品名称', { required: true, max: 200 }),
    originalTitle: readText(value.originalTitle, '原始标题', { max: 500 }),
    brand: readText(value.brand, '品牌', { max: 100 }),
    category: readText(value.category, '品类', { max: 100 }),
    description: readText(value.description, '商品描述', { max: 5000 }),
    internalCode: readText(value.internalCode, '商家编码', { max: 100 }),
    sourceType,
    sourcePlatform: readText(value.sourcePlatform, '来源平台', { max: 50 }),
    sourceUrl: readUrl(value.sourceUrl),
    sourceProductId: readText(value.sourceProductId, '来源商品 ID', { max: 200 }),
    status,
    confirmedAt: readText(value.confirmedAt, '确认时间', { max: 40 }),
    createdAt: readText(value.createdAt, '创建时间', { max: 40 }),
    updatedAt: readText(value.updatedAt, '更新时间', { max: 40 }),
    skus: skus.map(normalizeSku),
    sellingPoints: readTextList(value.sellingPoints, '已确认卖点', { maxItems: 20, maxLength: 200 }),
    forbiddenPhrases: readTextList(value.forbiddenPhrases, '禁用表述', { maxItems: 20, maxLength: 100 }),
  };
  if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_JSON) {
    fail('SNAPSHOT_TOO_LARGE', '商品资料快照过大，请精简描述或 SKU 参数后重试。', 413);
  }
  return snapshot;
}

export function normalizePlanRequest(body) {
  if (!isObject(body)) fail('INVALID_BODY', '请求体必须是 JSON 对象。');
  rejectUnknown(body, ['productSnapshot', 'requirement'], '规划请求');
  if (body.productSnapshot === undefined) fail('INVALID_SNAPSHOT', '缺少商品资料快照。');
  const snapshot = normalizeSnapshot(body.productSnapshot);
  const requirement = readText(body.requirement, '补充要求', { max: MAX_REQUIREMENT }) || '';
  return { snapshot, requirement };
}

function normalizeForMatch(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// 事实语料只取资料快照中的商品事实；禁用表述不进入语料，避免“禁用词”反向支持编造。
export function buildFactCorpus(snapshot) {
  const parts = [];
  const add = value => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text) parts.push(text);
  };
  for (const field of ['name', 'originalTitle', 'brand', 'category', 'description']) add(snapshot[field]);
  for (const point of snapshot.sellingPoints) add(point);
  for (const sku of snapshot.skus) {
    for (const field of ['internalSku', 'sourceSkuId', 'spec']) add(sku[field]);
    for (const parameter of sku.parameters) {
      add(parameter.name);
      add(parameter.value);
      add(parameter.unit);
    }
    if (sku.price) {
      for (const field of ['amount', 'min', 'max', 'currency', 'type', 'condition']) add(sku.price[field]);
    }
  }
  const text = normalizeForMatch(parts.join('\n'));
  const numbers = new Set(text.match(/\d+(?:\.\d+)?/g) || []);
  return { text, numbers };
}

function certificationPattern() {
  return /(?<![a-z0-9])(?:ipx?\d{1,2}|ce|fcc|rohs|fda|3c|ccc)(?![a-z0-9])/gi;
}

export function findUnsupportedClaims(text, corpus, { materials = true } = {}) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return [];
  const found = new Set();
  const terms = materials ? [...FEATURE_CLAIMS, ...MATERIAL_CLAIMS] : FEATURE_CLAIMS;
  for (const term of terms) {
    const token = normalizeForMatch(term);
    if (normalized.includes(token) && !corpus.text.includes(token)) found.add(term);
  }
  const certificate = certificationPattern();
  for (const match of normalized.matchAll(certificate)) {
    if (!corpus.text.includes(match[0])) found.add(match[0].toUpperCase());
  }
  // 认证标记本身含数字（如 3C），先从数字扫描中剔除，避免重复标记。
  const withoutCerts = normalized.replace(certificationPattern(), ' ');
  for (const match of withoutCerts.matchAll(/\d+(?:\.\d+)?/g)) {
    const token = match[0];
    if (corpus.numbers.has(token)) continue;
    const next = withoutCerts.charAt(match.index + token.length);
    // “2 张 / 3 个角度”是规划数量，不是商品事实。
    if (next && QUANTIFIERS.includes(next)) continue;
    found.add(token);
  }
  return [...found];
}

function guardText(value, corpus, { materials = true } = {}) {
  const clauses = String(value || '')
    .split(/[。；;！!？?\n，,、]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const kept = [];
  const violations = [];
  for (const clause of clauses) {
    const claims = findUnsupportedClaims(clause, corpus, { materials });
    if (claims.length) violations.push(...claims);
    else kept.push(clause);
  }
  return { text: kept.join('，'), violations };
}

function factSupported(fact, corpus) {
  const token = normalizeForMatch(fact);
  return Boolean(token) && corpus.text.includes(token);
}

function pendingCollector() {
  const seen = new Set();
  const items = [];
  return {
    items,
    add(claim, source, field) {
      const clean = String(claim ?? '').trim();
      if (!clean) return;
      const key = `${source}:${clean}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ claim: clean, source, field });
    },
  };
}

function readPromptSlots(raw) {
  if (!isObject(raw)) outputFail('提示词必须是对象。');
  for (const key of Object.keys(raw)) {
    if (!PROMPT_SLOT_KEYS.includes(key)) outputFail(`提示词包含不支持的槽位：${key}`);
  }
  const prompt = {};
  for (const key of PROMPT_SLOT_KEYS) {
    if (typeof raw[key] !== 'string') outputFail(`提示词槽位 ${key} 必须是文本。`);
    if (raw[key].length > 300) outputFail(`提示词槽位 ${key} 过长。`);
    prompt[key] = raw[key].trim();
  }
  if (!prompt.aspectRatio || !ASPECT_RATIOS.includes(prompt.aspectRatio)) {
    outputFail('画幅只能是 1:1 或 3:4。');
  }
  return prompt;
}

function guardPrompt(raw, type, snapshot, corpus, pending) {
  const prompt = {};
  for (const key of PROMPT_SLOT_KEYS) {
    if (key === 'aspectRatio') {
      // 白底主图与扩展建议固定 1:1；其余类型允许 1:1 或 3:4。
      prompt.aspectRatio = ['white', 'extension'].includes(type) ? '1:1' : raw.aspectRatio;
      continue;
    }
    if (key === 'forbidden') {
      const parts = [raw.forbidden, ...snapshot.forbiddenPhrases].filter(Boolean);
      const unique = [...new Set(parts.map(item => item.trim()).filter(Boolean))];
      prompt.forbidden = (unique.join('；') || SAFE_SLOT_DEFAULTS.forbidden()).slice(0, 500);
      continue;
    }
    const guarded = guardText(raw[key], corpus, { materials: ['subject', 'material', 'mustKeep'].includes(key) });
    for (const claim of guarded.violations) pending.add(claim, 'model', `prompt.${key}`);
    prompt[key] = guarded.text || SAFE_SLOT_DEFAULTS[key](snapshot);
  }
  return prompt;
}

function composePromptText(prompt) {
  return PROMPT_SLOT_KEYS
    .map(key => `${PROMPT_SLOT_LABELS[key]}：${prompt[key]}`)
    .join('；');
}

function readFacts(raw, corpus, pending) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) outputFail('facts 必须是数组。');
  if (raw.length > 20) outputFail('facts 不能超过 20 项。');
  const facts = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim() || item.length > 200) outputFail('facts 中的事实必须是 1–200 个字符的文本。');
    const fact = item.trim();
    if (factSupported(fact, corpus)) {
      if (!facts.includes(fact)) facts.push(fact);
    } else {
      // 模型声称引用、但快照中没有的事实：丢弃并标记待核实，不进入正式提示词。
      pending.add(fact, 'model', 'facts');
    }
  }
  return facts;
}

function readCopy(raw, corpus, pending) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) outputFail('copy 必须是数组。');
  if (raw.length > 3) outputFail('每个交付项最多 3 条文案。');
  const copy = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!isObject(entry)) outputFail('文案必须是对象。');
    for (const key of Object.keys(entry)) {
      if (!['slot', 'text'].includes(key)) outputFail(`文案包含不支持的字段：${key}`);
    }
    if (!COPY_SLOTS.includes(entry.slot)) outputFail('文案槽位不受支持。');
    if (seen.has(entry.slot)) outputFail('同一交付项的文案槽位不能重复。');
    seen.add(entry.slot);
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 120) {
      outputFail('文案内容必须是 1–120 个字符的文本。');
    }
    const guarded = guardText(entry.text, corpus, { materials: true });
    for (const claim of guarded.violations) pending.add(claim, 'model', `copy.${entry.slot}`);
    if (guarded.text) copy.push({ slot: entry.slot, text: guarded.text });
  }
  return copy;
}

function guardedLabel(raw, fallback, corpus, pending, field, { materials = true } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) outputFail(`${field} 必须是 1–200 个字符的文本。`);
  const guarded = guardText(raw, corpus, { materials });
  for (const claim of guarded.violations) pending.add(claim, 'model', field);
  return guarded.text || fallback;
}

function normalizeDeliverable(raw, snapshot, corpus, pending) {
  if (!isObject(raw)) outputFail('交付项必须是对象。');
  for (const key of Object.keys(raw)) {
    if (!['type', 'title', 'purpose', 'quantity', 'prompt', 'copy', 'facts', 'reason'].includes(key)) {
      outputFail(`交付项包含不支持的字段：${key}`);
    }
  }
  if (!DELIVERABLE_TYPES.includes(raw.type)) outputFail('交付项类型不在类型库内。');
  const library = TYPE_BY_ID.get(raw.type);
  const title = guardedLabel(raw.title, library.name, corpus, pending, 'title');
  const purpose = guardedLabel(raw.purpose, library.purpose, corpus, pending, 'purpose');
  const quantity = raw.quantity === undefined ? 1 : raw.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BRANCHES) {
    outputFail(`交付项数量必须是 1–${MAX_BRANCHES} 的整数。`);
  }
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 300) {
    outputFail('规划理由必须是 1–300 个字符的文本。');
  }
  const prompt = guardPrompt(readPromptSlots(raw.prompt), raw.type, snapshot, corpus, pending);
  return {
    type: raw.type,
    typeName: library.name,
    title,
    purpose,
    quantity,
    prompt,
    promptText: composePromptText(prompt),
    copy: readCopy(raw.copy, corpus, pending),
    facts: readFacts(raw.facts, corpus, pending),
    reason: raw.reason.trim(),
  };
}

function normalizeExtension(raw, snapshot, corpus, pending) {
  if (!isObject(raw)) outputFail('扩展建议必须是对象。');
  for (const key of Object.keys(raw)) {
    if (!['title', 'purpose', 'prompt', 'facts', 'reason'].includes(key)) {
      outputFail(`扩展建议包含不支持的字段：${key}`);
    }
  }
  const title = guardedLabel(raw.title, 'AI 扩展建议', corpus, pending, 'extensions.title');
  const purpose = guardedLabel(raw.purpose, '按建议意图构图，仅使用资料中的事实', corpus, pending, 'extensions.purpose');
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 300) {
    outputFail('扩展建议理由必须是 1–300 个字符的文本。');
  }
  const prompt = guardPrompt(readPromptSlots(raw.prompt), 'extension', snapshot, corpus, pending);
  return {
    type: 'extension',
    typeName: TYPE_BY_ID.get('extension').name,
    title,
    purpose,
    prompt,
    promptText: composePromptText(prompt),
    facts: readFacts(raw.facts, corpus, pending),
    reason: raw.reason.trim(),
  };
}

// 严格校验模型输出：未知字段、类型库外类型、越界数量都会导致回退默认清单。
export function normalizeModelPlan(raw, snapshot, corpus, pending) {
  if (!isObject(raw)) outputFail('规划结果必须是 JSON 对象。');
  for (const key of Object.keys(raw)) {
    if (!['deliverables', 'extensions'].includes(key)) outputFail(`规划结果包含不支持的字段：${key}`);
  }
  if (!Array.isArray(raw.deliverables) || raw.deliverables.length < 1 || raw.deliverables.length > MAX_DELIVERABLES) {
    outputFail(`交付项必须是 1–${MAX_DELIVERABLES} 项的数组。`);
  }
  const deliverables = raw.deliverables.map(item => normalizeDeliverable(item, snapshot, corpus, pending));
  let extensions = [];
  if (raw.extensions !== undefined) {
    if (!Array.isArray(raw.extensions) || raw.extensions.length > MAX_EXTENSIONS) {
      outputFail(`扩展建议必须是不超过 ${MAX_EXTENSIONS} 项的数组。`);
    }
    extensions = raw.extensions.map(item => normalizeExtension(item, snapshot, corpus, pending));
  }
  return { deliverables, extensions };
}

function extractJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try { return JSON.parse(text); } catch { /* try a bounded object below */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

function defaultForbidden(snapshot) {
  return [...new Set([...snapshot.forbiddenPhrases, SAFE_SLOT_DEFAULTS.forbidden()])].join('；');
}

function defaultDeliverable(type, snapshot) {
  const library = TYPE_BY_ID.get(type);
  const copy = type === 'selling'
    ? [{ slot: 'headline', text: snapshot.name }, { slot: 'cta', text: '查看详情' }]
    : type === 'detail'
      ? [{ slot: 'headline', text: snapshot.name }]
      : [];
  const prompt = {
    subject: SAFE_SLOT_DEFAULTS.subject(snapshot),
    scene: type === 'white' ? '纯白无缝背景' : type === 'scene' ? '简洁室内环境，保持真实比例' : '简洁背景，留出文案排版空间',
    composition: type === 'detail' ? '细节特写，突出可见结构' : '正面视角，商品居中',
    lighting: SAFE_SLOT_DEFAULTS.lighting(),
    style: SAFE_SLOT_DEFAULTS.style(),
    material: SAFE_SLOT_DEFAULTS.material(),
    mustKeep: SAFE_SLOT_DEFAULTS.mustKeep(),
    forbidden: defaultForbidden(snapshot),
    aspectRatio: library.aspectRatio,
  };
  return {
    type,
    typeName: library.name,
    title: library.name,
    purpose: library.purpose,
    quantity: 1,
    prompt,
    promptText: composePromptText(prompt),
    copy,
    facts: [snapshot.name],
    reason: '文本模型不可用，按交付项类型库默认清单生成；未引用资料之外的事实。',
  };
}

export function defaultPlan(snapshot) {
  return {
    deliverables: DELIVERABLE_TYPES.map(type => defaultDeliverable(type, snapshot)),
    extensions: [],
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function planKey(snapshot, requirement) {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize({ snapshot, requirement })))
    .digest('hex');
  return `planner:${digest}`;
}

function planIdForKey(idempotencyKey, callId) {
  return createHash('sha256').update(`${idempotencyKey}:${callId || 'unavailable'}`).digest('hex').slice(0, 32);
}

function modelSnapshot(snapshot) {
  return {
    name: snapshot.name,
    originalTitle: snapshot.originalTitle,
    brand: snapshot.brand,
    category: snapshot.category,
    description: snapshot.description,
    sellingPoints: snapshot.sellingPoints,
    forbiddenPhrases: snapshot.forbiddenPhrases,
    skus: snapshot.skus.map(sku => ({
      spec: sku.spec,
      parameters: sku.parameters,
      price: sku.price,
    })),
  };
}

const SYSTEM_PROMPT = `你是电商商品套图的规划器。只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。
你只能使用用户给出的商品资料快照中的事实。快照没有的材质、容量、尺寸、认证、功效、价格、排名或卖点，一律不得写入提示词、标题或文案。
交付项类型只能从类型库选择：white（白底主图/多角度）、scene（场景图）、selling（卖点/促销图）、detail（细节/尺寸/包装清单）。类型库外的想法只能放进 extensions。
输出结构：
{"deliverables":[{"type":"white|scene|selling|detail","title":"标题","purpose":"用途说明","quantity":1,"prompt":{"subject":"主体/数量","scene":"场景","composition":"构图/视角","lighting":"光线","style":"风格","material":"材质/颜色","mustKeep":"必须保持","forbidden":"禁止出现","aspectRatio":"1:1|3:4"},"copy":[{"slot":"headline|subheadline|badge|cta","text":"文案"}],"facts":["资料快照中的原文"],"reason":"规划理由"}],"extensions":[{"title":"建议标题","purpose":"用途","prompt":{同上九个槽位},"facts":[],"reason":"理由"}]}
约束：deliverables 1–10 项；quantity 1–3；每个交付项最多 3 条文案，文案槽位不能重复；extensions 0–5 项；不要输出未列出的字段。`;

function userPrompt(snapshot, requirement, blockedClaims) {
  const lines = [
    '商品资料快照（唯一事实来源）：',
    JSON.stringify(modelSnapshot(snapshot)),
    '',
    `补充要求：${requirement || '无'}`,
  ];
  if (blockedClaims.length) {
    lines.push(
      `以下说法在资料快照中没有依据，禁止写入任何提示词或文案：${blockedClaims.join('、')}`,
    );
  }
  lines.push('请只输出符合结构的 JSON。');
  return lines.join('\n');
}

export class PlannerService {
  constructor(gateway) {
    this.gateway = gateway || null;
  }

  async waitForCall(call) {
    let current = call;
    const deadline = Date.now() + 10_000;
    while (current?.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      current = await this.gateway.getCall(current.id);
    }
    return current;
  }

  async invokeModel(snapshot, requirement, blockedClaims) {
    if (!this.gateway) return { call: null, failure: 'MODEL_UNAVAILABLE' };
    const idempotencyKey = planKey(snapshot, requirement);
    try {
      const { call } = await this.gateway.invoke({
        idempotencyKey,
        capability: 'text.chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(snapshot, requirement, blockedClaims) },
        ],
        temperature: 0.2,
        maxTokens: 4000,
        thinking: false,
      });
      return { call: await this.waitForCall(call), idempotencyKey };
    } catch (error) {
      return {
        call: null,
        idempotencyKey,
        failure: error instanceof AppError ? error.code : 'MODEL_UNAVAILABLE',
      };
    }
  }

  async plan(body) {
    const { snapshot, requirement } = normalizePlanRequest(body);
    const corpus = buildFactCorpus(snapshot);
    const pending = pendingCollector();

    // 补充要求中的事实性说法若不在快照中，先标为待核实，并明确告知模型不要使用。
    const requirementClaims = findUnsupportedClaims(requirement, corpus, { materials: true });
    for (const claim of requirementClaims) pending.add(claim, 'requirement', 'requirement');

    const invoked = await this.invokeModel(snapshot, requirement, requirementClaims);
    let call = invoked.call;
    const planningCall = {
      id: call?.id || null,
      status: call?.status || 'unavailable',
      modelId: call?.modelId || null,
      usage: call?.usage || null,
      errorCode: call?.error?.code || invoked.failure || null,
      costOnly: true,
    };

    if (call?.status === 'running') {
      // 同一输入的并发提交正在执行：不新建付费调用，让客户端稍后用相同输入查询。
      throw new AppError('PLANNING_IN_PROGRESS', '该规划仍在进行，请稍后用相同输入重试。', 409);
    }

    let fallback = false;
    let fallbackReason = null;
    let plan = null;

    if (call?.status === 'succeeded') {
      try {
        plan = normalizeModelPlan(extractJson(call.result), snapshot, corpus, pending);
      } catch (error) {
        if (!(error instanceof ModelOutputError)) throw error;
        fallback = true;
        fallbackReason = 'INVALID_MODEL_OUTPUT';
      }
    } else {
      fallback = true;
      fallbackReason = planningCall.errorCode || 'MODEL_UNAVAILABLE';
    }

    if (fallback) plan = defaultPlan(snapshot);

    return {
      planId: planIdForKey(invoked.idempotencyKey || planKey(snapshot, requirement), call?.id),
      product: { name: snapshot.name, version: snapshot.version },
      requirement,
      fallback,
      fallbackReason,
      plan,
      pendingVerification: pending.items,
      libraryVersion: TYPE_LIBRARY_VERSION,
      billing: {
        mode: 'cost_only',
        reserved: false,
        note: '规划调用只记录文本用量与成本，不预占、不生成图片、不自动确认方案。',
      },
      planningCall,
    };
  }
}

export function publicTypeLibrary() {
  return {
    version: TYPE_LIBRARY_VERSION,
    types: TYPE_LIBRARY.map(item => ({
      type: item.type,
      name: item.name,
      purpose: item.purpose,
      aspectRatio: item.aspectRatio,
      workflow: [...item.workflow],
      maxBranches: item.type === 'extension' ? 1 : MAX_BRANCHES,
    })),
    promptSlots: PROMPT_SLOT_KEYS.map(key => ({ key, label: PROMPT_SLOT_LABELS[key] })),
    copySlots: [...COPY_SLOTS],
    limits: { deliverables: MAX_DELIVERABLES, branches: MAX_BRANCHES, extensions: MAX_EXTENSIONS, requirement: MAX_REQUIREMENT },
  };
}
