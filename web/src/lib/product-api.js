// 商品模块的真实服务端 API 客户端（Issue #28）。
// 所有商品、图片、截图识别、1688 解析与“用于创作”的请求都集中在这里；
// 组件只处理表单状态与展示，不再读写 sj:prototype:products:v1。
// 服务端接口见 server/routes/products.mjs、uploads.mjs、intake.mjs、link-parse.mjs。

export class ProductApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ProductApiError';
    this.status = status;
    this.code = code;
  }
}

export const PRODUCT_STATUS_LABELS = Object.freeze({ draft: '草稿', pending: '待核实', confirmed: '已确认' });
export const SOURCE_LABELS = Object.freeze({ manual: '手动录入', link: '链接解析', screenshot: '截图识别' });
export const PRICE_TYPE_OPTIONS = Object.freeze(['售价', '价格区间', '起价', '券后价', '会员价', '划线价', '待核实']);
const PRICE_TYPE_TO_API = Object.freeze({
  售价: 'sale', 价格区间: 'sale', 起价: 'starting', 券后价: 'coupon', 会员价: 'member', 划线价: 'list', 待核实: null,
});
const PRICE_TYPE_TO_UI = Object.freeze({
  sale: '售价', starting: '起价', coupon: '券后价', member: '会员价', list: '划线价',
});
const SOURCE_LABELS_FALLBACK = '手动录入';

// 价格有金额但类型未知时显示“待核实”，不默认当成售价。
function priceTypeLabel(price, range) {
  if (range) return '价格区间';
  if (PRICE_TYPE_TO_UI[price.type]) return PRICE_TYPE_TO_UI[price.type];
  return price.amount === null || price.amount === undefined ? '售价' : '待核实';
}

export const EMPTY_FORM = Object.freeze({
  name: '', brand: '', category: '', sku: '', spec: '', price: '', priceMax: '',
  currency: '', priceType: '售价', condition: '', description: '',
});

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function friendlyMessage(status, message) {
  if (status === 401) return '未登录或会话已过期，请重新登录后再试。';
  if (status === 403) return message || '当前角色无权执行此操作。';
  return message || `服务请求失败（HTTP ${status}）。`;
}

async function request(backend, path, { method = 'GET', body, raw, contentType } = {}) {
  const headers = {};
  const csrf = backend?.csrf || '';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = contentType || raw?.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let response;
  try {
    response = await fetch(path, {
      method, headers, body: payload, credentials: 'same-origin', cache: 'no-store',
    });
  } catch {
    throw new ProductApiError('无法连接服务端，请检查本地服务是否已启动。', { status: 0 });
  }
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch { result = null; }
  if (!response.ok) {
    throw new ProductApiError(
      friendlyMessage(response.status, result?.error?.message),
      { status: response.status, code: result?.error?.code || '' },
    );
  }
  return result;
}

export function listProducts(backend, { q = '', statuses, source, limit = 10, offset = 0 } = {}) {
  return request(backend, `/api/products${queryString({ q, status: statuses, source, limit, offset })}`);
}

export function getProduct(backend, id) {
  return request(backend, `/api/products/${encodeURIComponent(id)}`);
}

export function createProduct(backend, body) {
  return request(backend, '/api/products', { method: 'POST', body });
}

export function updateProduct(backend, id, body) {
  return request(backend, `/api/products/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

export function confirmProduct(backend, id, { version, reason = '核对并确认商品资料' } = {}) {
  return request(backend, `/api/products/${encodeURIComponent(id)}/confirm`, {
    method: 'POST', body: { version, reason },
  });
}

export function listProductVersions(backend, id, { limit = 8, offset = 0 } = {}) {
  return request(backend, `/api/products/${encodeURIComponent(id)}/versions${queryString({ limit, offset })}`);
}

// 原图必须绑定已存在的商品；来源截图可在建档前上传。
export function uploadProductImage(backend, { productId, kind, file }) {
  const path = `/api/product-images${queryString({ productId, kind })}`;
  return request(backend, path, { method: 'POST', raw: file, contentType: file?.type });
}

export function listProductImages(backend, { productId, kind, limit = 20, offset = 0 } = {}) {
  return request(backend, `/api/product-images${queryString({ productId, kind, limit, offset })}`);
}

export function parseProductLink(backend, url) {
  return request(backend, '/api/link-parse', { method: 'POST', body: { url } });
}

export function preflightScreenshot(backend, { imageIds, adapter } = {}) {
  return request(backend, '/api/intake/screenshot/preflight', {
    method: 'POST', body: { imageIds, ...(adapter ? { adapter } : {}) },
  });
}

export function submitScreenshot(backend, { imageIds, platform, requestKey } = {}) {
  return request(backend, '/api/intake/screenshot', {
    method: 'POST',
    body: { imageIds, ...(platform ? { platform } : {}), ...(requestKey ? { requestKey } : {}) },
  });
}

// “用于创作”只创建真实项目草稿，不确认方案、不生成、不计费。
export function createProjectDraft(backend, { name, productId, skuId }) {
  return request(backend, '/api/projects', { method: 'POST', body: { name, productId, skuId } });
}

export function formFromProduct(product) {
  const sku = product?.skus?.[0] || {};
  const price = sku.price || {};
  const range = price.min !== null && price.min !== undefined || price.max !== null && price.max !== undefined;
  return {
    name: product?.name || '',
    brand: product?.brand || '',
    category: product?.category || '',
    sku: sku.internalSku || '',
    spec: sku.spec || '',
    price: range
      ? (price.min === null || price.min === undefined ? '' : String(price.min))
      : (price.amount === null || price.amount === undefined ? '' : String(price.amount)),
    priceMax: range && price.max !== null && price.max !== undefined ? String(price.max) : '',
    currency: price.currency || '',
    priceType: priceTypeLabel(price, range),
    condition: price.condition || '',
    description: product?.description || '',
  };
}

export function formFromLinkDraft(result) {
  const draft = result?.draft;
  if (!draft) return null;
  const price = Array.isArray(draft.prices) ? draft.prices[0] || {} : {};
  const range = price.min !== null && price.min !== undefined || price.max !== null && price.max !== undefined;
  return {
    name: draft.name || '',
    brand: '',
    category: '',
    sku: '',
    spec: '',
    price: range
      ? (price.min === null || price.min === undefined ? '' : String(price.min))
      : (price.amount === null || price.amount === undefined ? '' : String(price.amount)),
    priceMax: range && price.max !== null && price.max !== undefined ? String(price.max) : '',
    currency: price.currency || '',
    priceType: priceTypeLabel(price, range),
    condition: price.condition || '',
    description: draft.description || '',
    params: Array.isArray(draft.parameters)
      ? draft.parameters.map(row => [row.name || '', row.value || '', row.unit || ''])
      : [],
  };
}

function numberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// 只提交服务端允许的字段；清空的文本要显式发送 null/空值，避免 PATCH 保留旧值。
export function formToProductBody(form, { status = 'draft', source = {}, reason } = {}) {
  const text = value => String(value ?? '').trim();
  const params = (form.params || [])
    .map(row => ({ name: text(row[0]), value: text(row[1]), unit: text(row[2]) || null }))
    .filter(row => row.name);
  const hasPrice = [form.price, form.priceMax, form.currency, form.condition].some(value => text(value));
  const amount = numberOrNull(form.price);
  const max = numberOrNull(form.priceMax);
  const priceType = form.priceType || '售价';
  const price = {
    amount: max !== null ? null : amount,
    min: max !== null ? amount : null,
    max,
    currency: text(form.currency) ? text(form.currency).toUpperCase() : null,
    // “待核实”显式提交 null，避免把未知价格类型默认当成售价。
    type: hasPrice
      ? (Object.prototype.hasOwnProperty.call(PRICE_TYPE_TO_API, priceType) ? PRICE_TYPE_TO_API[priceType] : 'sale')
      : null,
    condition: text(form.condition) || null,
  };
  const body = {
    name: text(form.name),
    brand: text(form.brand) || null,
    category: text(form.category) || null,
    description: text(form.description) || null,
    internalCode: text(form.sku) || null,
    sourceType: source.sourceType || 'manual',
    status,
    skus: [{
      selected: true,
      internalSku: text(form.sku) || null,
      spec: text(form.spec) || null,
      parameters: params,
      price,
    }],
  };
  if (source.sourceUrl) body.sourceUrl = source.sourceUrl;
  if (source.sourcePlatform) body.sourcePlatform = source.sourcePlatform;
  if (source.sourceProductId) body.sourceProductId = source.sourceProductId;
  if (reason) body.reason = reason;
  return body;
}

// 服务端商品 → 页面展示对象。原始响应保存在 raw 中，提交时取服务端版本号。
export function productToUi(product) {
  const sku = product?.skus?.[0] || {};
  const price = sku.price || {};
  const range = price.min !== null && price.min !== undefined || price.max !== null && price.max !== undefined;
  return {
    id: product.id,
    name: product.name || '',
    brand: product.brand || '',
    category: product.category || '',
    description: product.description || '',
    sku: sku.internalSku || '',
    spec: sku.spec || '',
    skuId: sku.id || null,
    params: Array.isArray(sku.parameters)
      ? sku.parameters.map(row => [row.name || '', row.value || '', row.unit || ''])
      : [],
    price: range
      ? (price.min === null || price.min === undefined ? '' : String(price.min))
      : (price.amount === null || price.amount === undefined ? '' : String(price.amount)),
    priceMax: range && price.max !== null && price.max !== undefined ? String(price.max) : '',
    currency: price.currency || '',
    priceType: priceTypeLabel(price, range),
    condition: price.condition || '',
    status: product.status || 'draft',
    version: product.version || 1,
    sourceType: product.sourceType || 'manual',
    sourceUrl: product.sourceUrl || '',
    sourcePlatform: product.sourcePlatform || '',
    sourceProductId: product.sourceProductId || '',
    source: SOURCE_LABELS[product.sourceType] || SOURCE_LABELS_FALLBACK,
    updatedAt: product.updatedAt || product.createdAt || null,
    confirmedAt: product.confirmedAt || null,
    raw: product,
  };
}

export function priceText(product) {
  if (!product || (product.price === '' && !product.priceMax)) return '未录入';
  const symbol = { CNY: '¥', USD: '$', EUR: '€' }[product.currency] || '';
  return `${symbol}${product.price}${product.priceMax ? `–${product.priceMax}` : ''}${!product.currency ? '（币种待核实）' : ''}`;
}

export function productGaps(product) {
  if (!product) return [];
  return [
    !product.sku && 'SKU',
    product.price === '' && '价格',
    product.price !== '' && !product.currency && '币种',
    !product.params.length && '商品参数',
  ].filter(Boolean);
}

export function formatDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
