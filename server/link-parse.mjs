import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from './errors.mjs';

// 商品链接解析适配器（Issue #22）。
// 边界：一期只对 1688 做尽力解析；淘宝/天猫只做“识别并引导截图”，绝不发起抓取
// （ADR 0007）；其他平台一律拒绝。适配器是否“支持 1688”以真实样本探测结果为准，
// 探测未通过时文档不得声明支持。
//
// 安全：只允许 http/https、标准端口、无 URL 凭据；初始地址和每一次重定向都重新校验；
// DNS 解析结果必须是公网地址，并把校验过的地址钉给本次连接（防 DNS rebinding）；
// 限制总耗时、响应体积与重定向次数；不发送 Cookie 或任何项目密钥。
//
// 本模块只产出“待核实草稿”，不写商品库、不覆盖已确认商品；是否建档由调用方决定。

export const PLATFORM_1688 = '1688';
export const PLATFORM_TAOBAO_TMALL = 'taobao-tmall';
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const MAX_URL_LENGTH = 2048;
export const MAX_NAME_LENGTH = 200;
export const MAX_TITLE_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 5000;

const SUPPORTED_CONTENT = /^(?:text\/html|application\/xhtml\+xml)\b/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PORTS = new Set(['', '80', '443']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];
const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata', 'metadata.google.internal', 'instance-data',
  'kubernetes.default.svc',
]);
const TAOBAO_TMALL_DOMAINS = ['taobao.com', 'tmall.com', 'tmall.hk', 'tb.cn', 'taobao.hk'];

// ---------------------------------------------------------------------------
// 地址与目标校验
// ---------------------------------------------------------------------------

function stripBrackets(hostname) {
  const text = String(hostname || '');
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

function ipv4Parts(address) {
  return address.split('.').map(Number);
}

// 返回 true 表示该 IP 不允许作为抓取目标：内网、回环、链路本地、云元数据、
// 保留/文档/组播地址，以及可能映射到这些地址的 IPv6 形式。
export function isBlockedAddress(address) {
  const text = stripBrackets(String(address || '').trim()).toLowerCase();
  if (!text) return true;
  if (text.includes('%')) return true;

  if (net.isIPv4(text)) {
    const [a, b, c] = ipv4Parts(text);
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return true;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10（含阿里云 100.100.100.200）
    if (a === 127) return true; // 回环
    if (a === 169 && b === 254) return true; // 链路本地与云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24、TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 中继
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 198 && b >= 18 && b <= 19) return true; // 198.18/15
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // 组播与保留
    return false;
  }

  if (net.isIPv6(text)) {
    if (text === '::' || text === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return isBlockedAddress(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16);
      const low = parseInt(hexMapped[2], 16);
      return isBlockedAddress(
        [high >> 8, high & 255, low >> 8, low & 255].join('.'),
      );
    }
    if (/^f[cd][0-9a-f]{2}:/.test(text)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(text)) return true; // fe80::/10 链路本地
    if (/^ff[0-9a-f]{2}:/.test(text)) return true; // 组播
    if (/^2001:0?db8:/.test(text)) return true; // 文档地址
    if (/^2002:/.test(text)) return true; // 6to4，可内嵌私网
    if (/^64:ff9b:/.test(text)) return true; // NAT64 可能映射到内网
    if (text.startsWith('::')) return true; // 已废弃的 IPv4-compatible 形式
    return false;
  }

  // 十进制、十六进制等非标准 IP 写法一律拒绝，避免解析器按整数解释。
  if (/^\d+$/.test(text) || /^0x[0-9a-f]+$/i.test(text) || /^[0-9.]+$/.test(text)) return true;
  return true;
}

// 保留旧名称，语义相同。
export const isPrivateAddress = isBlockedAddress;

function isBlockedHostname(host) {
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  // 单标签主机名通常解析到内网；公网商品站点不会使用。
  if (!host.includes('.') && !net.isIP(host)) return true;
  return false;
}

export function assertSafeHttpUrl(value) {
  if (typeof value !== 'string') {
    throw new AppError('INVALID_URL', '链接必须是文本。', 400);
  }
  const text = value.trim();
  if (!text) throw new AppError('INVALID_URL', '请提供商品链接。', 400);
  if (text.length > MAX_URL_LENGTH) {
    throw new AppError('INVALID_URL', `链接不能超过 ${MAX_URL_LENGTH} 个字符。`, 400);
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new AppError('INVALID_URL', '链接格式不正确。', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('INVALID_URL', '仅支持 http/https 链接。', 400);
  }
  if (url.username || url.password) {
    throw new AppError('UNSAFE_URL', '链接不能包含账号或密码。', 400);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new AppError('UNSAFE_URL', '链接只能使用标准端口。', 400);
  }
  if (!url.hostname) throw new AppError('INVALID_URL', '链接缺少主机名。', 400);
  const host = stripBrackets(url.hostname).toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new AppError('UNSAFE_URL', '该地址不允许访问。', 400);
  } else if (isBlockedHostname(host)) {
    throw new AppError('UNSAFE_URL', '该地址不允许访问。', 400);
  }
  return url;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostnameOf(url) {
  return stripBrackets(url.hostname).toLowerCase();
}

// 平台识别只读 URL，不发起任何请求；淘宝/天猫命中后由调用方引导截图识别。
export function classifyPlatform(url) {
  const host = hostnameOf(url);
  if (hostMatches(host, PLATFORM_1688 + '.com')) return PLATFORM_1688;
  if (TAOBAO_TMALL_DOMAINS.some(domain => hostMatches(host, domain))) return PLATFORM_TAOBAO_TMALL;
  return null;
}

export function assertSupportedPlatform(url) {
  const platform = classifyPlatform(url);
  if (platform === PLATFORM_TAOBAO_TMALL) {
    throw new AppError(
      'PLATFORM_NOT_SUPPORTED',
      '淘宝/天猫不做页面抓取，请使用截图识别或手动录入。',
      400,
    );
  }
  if (platform !== PLATFORM_1688) {
    throw new AppError(
      'PLATFORM_NOT_SUPPORTED',
      '一期仅对 1688 链接做尽力解析，其他平台请使用截图识别或手动录入。',
      400,
    );
  }
  return url;
}

// 把 DNS 校验放进连接实际使用的 lookup：返回的地址就是即将连接的地址，
// 避免“先校验、后重新解析”的 DNS rebinding 窗口。
export function createSafeLookup(dnsLookup = dns.lookup) {
  return function safeLookup(hostname, options, callback) {
    const family = typeof options === 'number' ? options : (options?.family || 0);
    const wantAll = typeof options === 'object' && options?.all === true;
    dnsLookup(hostname, { all: true, family, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const list = (Array.isArray(addresses) ? addresses : [])
        .filter(item => item && item.address && !isBlockedAddress(item.address));
      if (!list.length) {
        callback(new AppError('UNSAFE_HOST', '该地址不允许访问。', 400));
        return;
      }
      if (wantAll) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

// ---------------------------------------------------------------------------
// 受限抓取
// ---------------------------------------------------------------------------

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? null : headers[key];
  return Array.isArray(value) ? value[0] : (value ?? null);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), 'utf8');
}

function normalizeCharset(value) {
  const label = String(value || '').trim().toLowerCase();
  if (!label) return null;
  if (['gbk', 'gb2312', 'gb-2312', 'x-gbk'].includes(label)) return 'gb18030';
  return label;
}

export function decodeBody(buffer, contentType = '') {
  const body = toBuffer(buffer);
  let charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(String(contentType || ''))?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
  }
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label || 'utf-8').decode(body);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(body);
    } catch {
      return body.toString('utf8');
    }
  }
}

function withTimeout(task, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch { /* 取消失败不影响超时结果 */ }
      reject(new AppError('FETCH_TIMEOUT', '目标页面响应超时。', 504));
    }, timeoutMs);
    Promise.resolve()
      .then(task)
      .then(
        value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

// 默认传输：不跟随重定向（由 fetchPage 逐跳校验），流式限流，超时销毁连接。
function nodeTransport(url, { signal, timeoutMs, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const request = lib.request(url, {
      method: 'GET',
      lookup,
      signal,
      headers: {
        'User-Agent': 'ShangjingLinkParse/1.0 (+local product intake; best effort)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache',
      },
    }, response => {
      const status = response.statusCode || 0;
      const headers = response.headers || {};
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume();
        reject(new AppError('RESPONSE_TOO_LARGE', '目标页面过大，已停止读取。', 502));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy();
          reject(new AppError('RESPONSE_TOO_LARGE', '目标页面过大，已停止读取。', 502));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      response.on('aborted', () => reject(new AppError('FETCH_FAILED', '目标页面读取中断。', 502)));
      response.on('error', error => reject(error));
    });
    request.on('error', error => {
      if (error?.name === 'AbortError') {
        reject(new AppError('FETCH_TIMEOUT', '目标页面响应超时。', 504));
        return;
      }
      reject(error);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new AppError('FETCH_TIMEOUT', '目标页面响应超时。', 504));
    });
    request.end();
  });
}

// fetchPage 只负责“安全地取回一个 HTML 页面”。validateHop 用于把每一跳限制在
// 允许的平台内（parseLink 传入 assertSupportedPlatform）。
export async function fetchPage(input, options = {}) {
  const {
    transport = nodeTransport,
    dnsLookup = dns.lookup,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = MAX_REDIRECTS,
    validateHop = () => {},
    now = () => new Date(),
  } = options;

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const hops = Number.isInteger(maxRedirects) && maxRedirects >= 0 ? maxRedirects : MAX_REDIRECTS;
  const lookup = createSafeLookup(dnsLookup);

  let url = assertSafeHttpUrl(input instanceof URL ? input.href : input);
  validateHop(url);
  const visited = new Set();
  const redirects = [];

  for (let hop = 0; hop <= hops; hop += 1) {
    if (visited.has(url.href)) {
      throw new AppError('REDIRECT_LOOP', '链接发生重定向循环，已停止。', 502);
    }
    visited.add(url.href);

    const controller = new AbortController();
    let response;
    try {
      response = await withTimeout(
        () => transport(url, {
          signal: controller.signal, timeoutMs: timeout, maxBytes: limit, lookup,
        }),
        timeout,
        () => controller.abort(),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('FETCH_FAILED', '无法访问目标页面。', 502);
    }

    const status = Number(response?.status) || 0;
    const headers = response?.headers || {};

    if (REDIRECT_STATUSES.has(status)) {
      if (hop === hops) {
        throw new AppError('REDIRECT_LIMIT', '重定向次数过多，已停止。', 502);
      }
      const location = headerValue(headers, 'location');
      if (!location) {
        throw new AppError('REDIRECT_INVALID', '重定向缺少目标地址，已停止。', 502);
      }
      let next;
      try {
        next = new URL(String(location), url);
      } catch {
        throw new AppError('REDIRECT_INVALID', '重定向地址不正确，已停止。', 502);
      }
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new AppError('UNSAFE_REDIRECT', '不允许从 https 降级到 http。', 502);
      }
      const safe = assertSafeHttpUrl(next.href);
      validateHop(safe);
      redirects.push({ status, from: url.href, to: safe.href });
      url = safe;
      continue;
    }

    const body = toBuffer(response?.body);
    if (body.length > limit) {
      throw new AppError('RESPONSE_TOO_LARGE', '目标页面过大，已停止读取。', 502);
    }
    const contentType = String(headerValue(headers, 'content-type') || '');
    if (contentType && !SUPPORTED_CONTENT.test(contentType)) {
      throw new AppError('UNSUPPORTED_CONTENT', '目标地址不是商品详情页（非 HTML）。', 502);
    }
    return {
      finalUrl: url.href,
      status,
      headers,
      contentType: contentType || null,
      html: decodeBody(body, contentType),
      bytes: body.length,
      redirects,
      fetchedAt: now().toISOString(),
    };
  }

  throw new AppError('REDIRECT_LIMIT', '重定向次数过多，已停止。', 502);
}

// ---------------------------------------------------------------------------
// HTML / JSON-LD 提取助手
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
};

export function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (full, code) => {
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x';
      const point = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isInteger(point) && point > 0 && point <= 0x10ffff) {
        try { return String.fromCodePoint(point); } catch { return full; }
      }
      return full;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? full;
  });
}

export function stripTags(value) {
  const text = String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return stripTags(value).replace(/\s+/g, ' ').trim();
}

function clampText(value, max) {
  const text = normalizeText(value);
  return text.length > max ? text.slice(0, max) : text;
}

const TITLE_SUFFIXES = [
  /\s*[-_|—–]\s*阿里巴巴(?:\s*1688(?:\.com)?)?\s*$/i,
  /\s*[-_|—–]\s*1688(?:\.com)?\s*$/i,
];

function cleanProductTitle(value) {
  let title = normalizeText(value);
  for (const pattern of TITLE_SUFFIXES) title = title.replace(pattern, '').trim();
  return title;
}

const GENERIC_NAME_PATTERNS = [
  /^(?:阿里巴巴)?(?:1688)?(?:\.com)?$/i,
  /^阿里巴巴\s*1688(?:\.com)?/i,
  /^(?:登录|注册|安全验证|验证码|访问受限|页面不存在|出错了|错误|404(?!\d))/,
  /^(?:商品详情|商品详情页|采购批发|批发市场|阿里巴巴首页)$/,
];

function isGenericName(value) {
  const text = String(value || '').trim();
  if (text.length < 2) return true;
  return GENERIC_NAME_PATTERNS.some(pattern => pattern.test(text));
}

function parseAttributes(tag) {
  const attrs = {};
  const body = String(tag).replace(/^<\s*meta\b/i, '').replace(/\/?>\s*$/, '');
  for (const match of body.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function metaTags(html) {
  const tags = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = String(attrs.property || attrs.name || attrs['http-equiv'] || '').toLowerCase();
    if (!key || tags.has(key)) continue;
    if (attrs.content) tags.set(key, decodeEntities(attrs.content).trim());
  }
  return tags;
}

function pageTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? cleanProductTitle(match[1]) : null;
}

function collectProductNodes(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectProductNodes(item, out, depth + 1);
    return;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => /product/i.test(String(type || ''))) && !out.includes(node)) {
    out.push(node);
  }
  if (node['@graph']) collectProductNodes(node['@graph'], out, depth + 1);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectProductNodes(value, out, depth + 1);
  }
}

export function extractJsonLdProducts(html) {
  const products = [];
  for (const block of String(html || '').matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = block[1]
      .trim()
      .replace(/^<!--/, '')
      .replace(/-->$/, '')
      .replace(/;\s*$/, '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    collectProductNodes(parsed, products);
  }
  return products;
}

function roundMoney(value) {
  return Math.round(value * 10_000) / 10_000;
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,，\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function moneyValue(value) {
  const number = numberValue(value);
  if (number === null || number < 0 || number > 1_000_000_000_000) return null;
  return roundMoney(number);
}

function priceValue(value) {
  if (typeof value === 'string') {
    const range = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(?:-|–|—|~|至)\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(value);
    if (range) {
      const min = moneyValue(range[1]);
      const max = moneyValue(range[2]);
      if (min !== null && max !== null && min <= max) return { amount: null, min, max };
    }
  }
  const amount = moneyValue(value);
  return amount === null ? null : { amount, min: null, max: null };
}

function jsonLdParameters(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const rows = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : null;
    const raw = entry.value ?? entry.unitText ?? null;
    if (!name || raw === null || typeof raw === 'object') continue;
    const text = String(raw).trim();
    if (!text || text.length > 200 || name.length > 100) continue;
    const split = typeof entry.unitText === 'string' && entry.unitText.trim()
      ? { value: text, unit: entry.unitText.trim() }
      : splitUnit(text);
    rows.push({ name, ...split, source: 'json-ld', confidence: 'high' });
  }
  return rows;
}

function jsonLdPrices(offers) {
  const list = Array.isArray(offers) ? offers : (offers ? [offers] : []);
  const rows = [];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const currency = typeof offer.priceCurrency === 'string'
      ? offer.priceCurrency.trim().toUpperCase() : null;
    const low = moneyValue(offer.lowPrice);
    const high = moneyValue(offer.highPrice);
    const direct = priceValue(offer.price);
    if (low !== null || high !== null) {
      const min = low !== null ? low : null;
      const max = high !== null ? high : null;
      if (min === null || max === null || min <= max) {
        rows.push({
          amount: null, min, max,
          currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
          type: 'sale', condition: null, source: 'json-ld', confidence: 'high',
        });
      }
    } else if (direct) {
      rows.push({
        ...direct,
        currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
        type: 'sale', condition: null, source: 'json-ld', confidence: 'high',
      });
    }
    const spec = offer.priceSpecification;
    if (spec && typeof spec === 'object') {
      const specPrice = priceValue(spec.price);
      if (specPrice) {
        const specCurrency = typeof spec.priceCurrency === 'string'
          ? spec.priceCurrency.trim().toUpperCase() : currency;
        rows.push({
          ...specPrice,
          currency: specCurrency && /^[A-Z]{3}$/.test(specCurrency) ? specCurrency : null,
          type: 'sale', condition: null, source: 'json-ld', confidence: 'high',
        });
      }
    }
  }
  return rows;
}

function fromJsonLd(html) {
  const products = extractJsonLdProducts(html);
  const product = products.find(item => typeof item.name === 'string' && item.name.trim());
  if (!product) return { name: null, description: null, parameters: [], prices: [] };
  return {
    name: product.name.trim(),
    description: typeof product.description === 'string' ? product.description.trim() : null,
    parameters: jsonLdParameters(product.additionalProperty),
    prices: jsonLdPrices(product.offers),
  };
}

const PARAMETER_NAME_BLOCKLIST = new Set([
  '商品', '价格', '数量', '起批', '起订量', '评价', '物流', '服务', '搜索',
  '首页', '登录', '注册', '购物车', '商品详情', '联系方式', '店铺', '更多',
  '参数名', '参数值', '商品参数', '产品参数',
]);
const UNIT_PATTERN = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(kg|g|mg|cm|mm|m|ml|l|寸|英寸|厘米|毫米|米|千克|克|毫升|升|件|个|只|套|包|箱)\s*$/i;

function splitUnit(value) {
  const text = String(value || '').trim();
  const match = UNIT_PATTERN.exec(text);
  return match ? { value: match[1], unit: match[2] } : { value: text, unit: null };
}

function isParameterName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 20) return false;
  if (/^[\d\s.]+$/.test(name)) return false;
  if (/[<>{}]/.test(name)) return false;
  return !PARAMETER_NAME_BLOCKLIST.has(name);
}

function isParameterValue(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 200) return false;
  return !/^(?:查看|更多|详情|暂无|--|-)$/.test(text);
}

function structuredParameters(html) {
  const rows = [];
  const seen = new Set();
  const add = (rawName, rawValue, source) => {
    const name = stripTags(rawName).replace(/[：:]$/, '').trim();
    const value = stripTags(rawValue).trim();
    if (!isParameterName(name) || !isParameterValue(value)) return;
    const key = `${name}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ name, ...splitUnit(value), source, confidence: 'medium' });
  };
  for (const match of html.matchAll(
    /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
  )) add(match[1], match[2], 'html-dl');
  for (const match of html.matchAll(
    /<tr\b[^>]*>\s*<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>\s*<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi,
  )) add(match[1], match[2], 'html-table');
  return rows;
}

function metaPrices(meta) {
  const amount = moneyValue(meta.get('product:price:amount') ?? meta.get('og:price:amount'));
  if (amount === null) return [];
  const currency = String(meta.get('product:price:currency') ?? meta.get('og:price:currency') ?? '')
    .trim().toUpperCase();
  return [{
    amount, min: null, max: null,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
    type: 'sale', condition: null, source: 'meta', confidence: 'medium',
  }];
}

function textPrices(html) {
  const text = stripTags(html);
  const rows = [];
  const seen = new Set();
  for (const match of text.matchAll(
    /[¥￥]\s*([0-9]{1,9}(?:\.[0-9]{1,4})?)(?:\s*(?:-|–|—|~|至|到)\s*[¥￥]?\s*([0-9]{1,9}(?:\.[0-9]{1,4})?))?/g,
  )) {
    const first = moneyValue(match[1]);
    const second = match[2] === undefined ? null : moneyValue(match[2]);
    if (first === null) continue;
    if (second !== null && second < first) continue;
    const key = second === null ? `${first}` : `${first}-${second}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      amount: second === null ? first : null,
      min: second === null ? null : first,
      max: second,
      currency: 'CNY',
      type: null,
      condition: null,
      source: 'page-text',
      confidence: 'low',
    });
    if (rows.length >= 10) break;
  }
  return rows;
}

function jsonStringField(html, keys) {
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i').exec(html);
    if (!match) continue;
    try {
      const value = JSON.parse(`"${match[1]}"`);
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {
      // 非法转义时忽略该候选，不猜测内容。
    }
  }
  return null;
}

function jsonNumberField(html, keys) {
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"?([0-9]+(?:\\.[0-9]{1,4})?)"?`, 'i').exec(html);
    if (match) {
      const value = moneyValue(match[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

function dedupePrices(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    // 按金额去重；rows 已按证据强弱排序，保留置信度更高的候选。
    const key = [row.amount, row.min, row.max, row.currency].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 10) break;
  }
  return out;
}

function dedupeParameters(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.name}\u0000${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 50) break;
  }
  return out;
}

function bestConfidence(rows) {
  if (rows.some(row => row.confidence === 'high')) return 'high';
  if (rows.some(row => row.confidence === 'medium')) return 'medium';
  if (rows.length) return 'low';
  return 'none';
}

const CONFIDENCE_RANK = { none: 0, low: 1, medium: 2, high: 3 };

export function extractOfferId(value) {
  try {
    const url = new URL(String(value));
    const match = /\/(?:offer|offerId)\/(\d{3,})/i.exec(url.pathname)
      || /[?&](?:offerId|offerid)=(\d{3,})/i.exec(url.search);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// 纯函数：不联网，输入 HTML，输出字段候选与证据。
export function parse1688Html(html, pageUrl = '') {
  const source = String(html || '');
  const meta = metaTags(source);
  const json = fromJsonLd(source);
  const embeddedName = jsonStringField(source, ['subject', 'offerTitle', 'productTitle']);
  const title = pageTitle(source);
  const embeddedPrice = jsonNumberField(source, ['salePrice', 'offerPrice', 'price']);

  const candidates = [];
  if (json.name) candidates.push({ value: clampText(json.name, MAX_NAME_LENGTH), source: 'json-ld', confidence: 'high' });
  const ogTitle = meta.get('og:title');
  if (ogTitle) candidates.push({ value: clampText(cleanProductTitle(ogTitle), MAX_NAME_LENGTH), source: 'og:title', confidence: 'medium' });
  if (embeddedName) candidates.push({ value: clampText(embeddedName, MAX_NAME_LENGTH), source: 'embedded-json', confidence: 'medium' });
  if (title) candidates.push({ value: clampText(title, MAX_NAME_LENGTH), source: 'title', confidence: 'medium' });

  const name = candidates.find(item => item.value && !isGenericName(item.value)) || null;

  const description = clampText(
    json.description
      || meta.get('og:description')
      || meta.get('description')
      || jsonStringField(source, ['description', 'offerDescription'])
      || '',
    MAX_DESCRIPTION_LENGTH,
  ) || null;
  const descriptionSource = json.description ? 'json-ld'
    : (meta.get('og:description') || meta.get('description')) ? 'meta'
      : description ? 'embedded-json' : null;

  const parameters = dedupeParameters([
    ...json.parameters,
    ...structuredParameters(source),
  ]);

  const prices = dedupePrices([
    ...json.prices,
    ...metaPrices(meta),
    ...textPrices(source),
    ...(embeddedPrice !== null && json.prices.length === 0
      ? [{
        amount: embeddedPrice, min: null, max: null, currency: null,
        type: null, condition: null, source: 'embedded-json', confidence: 'low',
      }]
      : []),
  ]);

  return {
    pageUrl,
    title: clampText(title || '', MAX_TITLE_LENGTH) || null,
    name,
    description,
    descriptionSource,
    parameters,
    prices,
  };
}

// 适配器注册表骨架：以后新增平台时在同一形状下追加，不让抓取逻辑散落到路由。
export const SITE_ADAPTERS = Object.freeze({
  [PLATFORM_1688]: Object.freeze({
    platform: PLATFORM_1688,
    matches: url => classifyPlatform(url) === PLATFORM_1688,
    parse: (html, url) => parse1688Html(html, url),
  }),
});

function sourceInfo(initial, fetched) {
  return {
    platform: PLATFORM_1688,
    inputUrl: initial.href,
    finalUrl: fetched.finalUrl,
    productId: extractOfferId(fetched.finalUrl) || extractOfferId(initial.href),
    fetchedAt: fetched.fetchedAt,
    httpStatus: fetched.status,
    contentType: fetched.contentType,
    redirects: fetched.redirects,
  };
}

function confidenceSummary(parsed) {
  const name = parsed.name?.confidence || 'none';
  const price = bestConfidence(parsed.prices);
  const parameters = bestConfidence(parsed.parameters);
  let overall = 'low';
  if (name === 'high' && price === 'high'
    && CONFIDENCE_RANK[parameters] >= CONFIDENCE_RANK.medium) {
    overall = 'high';
  } else if (CONFIDENCE_RANK[name] >= CONFIDENCE_RANK.medium
    && (price !== 'none' || parameters !== 'none')) {
    overall = 'medium';
  }
  return { overall, name, price, parameters };
}

function evidenceList(rows) {
  return rows.map((row, index) => ({ index, source: row.source, confidence: row.confidence }));
}

// 解析入口：校验 → 受限抓取（逐跳）→ 1688 字段提取 → 待核实草稿。
export async function parseLink(input, options = {}) {
  const initial = assertSafeHttpUrl(input);
  assertSupportedPlatform(initial);
  const fetched = await fetchPage(initial, {
    ...options,
    validateHop: assertSupportedPlatform,
  });
  const adapter = SITE_ADAPTERS[PLATFORM_1688];
  const parsed = adapter.parse(fetched.html, fetched.finalUrl);
  const source = sourceInfo(initial, fetched);

  if (!parsed.name) {
    return {
      status: 'failed',
      platform: PLATFORM_1688,
      source,
      draft: null,
      evidence: { name: null, description: null, parameters: [], prices: [] },
      confidence: { overall: 'none', name: 'none', price: 'none', parameters: 'none' },
      warnings: ['未能识别商品名称，未生成草稿。页面可能需要登录、验证码，或不是商品详情页。'],
      reason: '未能识别商品名称，未生成草稿。',
    };
  }

  const confidence = confidenceSummary(parsed);
  const hasUsablePrice = parsed.prices.some(row => row.confidence !== 'low');
  const hasUsableParameters = parsed.parameters.some(row => row.confidence !== 'low');
  const status = CONFIDENCE_RANK[confidence.name] >= CONFIDENCE_RANK.medium
    && (hasUsablePrice || hasUsableParameters) ? 'parsed' : 'partial';

  const warnings = [];
  if (!parsed.prices.length) {
    warnings.push('未识别到价格，价格保持为空，请人工补充。');
  } else if (!hasUsablePrice) {
    warnings.push('价格仅来自页面文本，价格类型与适用条件需人工核实。');
  }
  if (!parsed.parameters.length) {
    warnings.push('未识别到参数，请人工补充。');
  }
  if (parsed.name.source !== 'json-ld') {
    warnings.push('商品名称来自页面标题或嵌入式数据，请核对。');
  }
  if (status === 'partial') {
    warnings.push('仅完成部分字段解析，请核对后再建档。');
  }

  return {
    status,
    platform: PLATFORM_1688,
    source,
    draft: {
      // 待核实：解析结果只作为草稿建议，不能直接覆盖已确认商品。
      verification: 'pending',
      sourceType: 'link',
      sourcePlatform: PLATFORM_1688,
      sourceUrl: fetched.finalUrl,
      sourceProductId: source.productId,
      name: parsed.name.value,
      originalTitle: parsed.title,
      description: parsed.description,
      parameters: parsed.parameters.map(row => ({
        name: row.name, value: row.value, unit: row.unit ?? null,
      })),
      prices: parsed.prices.map(row => ({
        amount: row.amount, min: row.min, max: row.max,
        currency: row.currency, type: row.type, condition: row.condition,
      })),
    },
    evidence: {
      name: { source: parsed.name.source, confidence: parsed.name.confidence },
      description: parsed.descriptionSource
        ? { source: parsed.descriptionSource, confidence: parsed.descriptionSource === 'json-ld' ? 'high' : 'medium' }
        : null,
      parameters: evidenceList(parsed.parameters),
      prices: evidenceList(parsed.prices),
    },
    confidence,
    warnings,
    reason: null,
  };
}
