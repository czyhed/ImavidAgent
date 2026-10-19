// 素材真实 API 客户端（Issue #4 服务端全量索引；素材页接入）。
//
// 列表、详情与版本链都只走同源 GET 接口；浏览接口不需要 CSRF，也不接收任何
// 写操作。图片与下载地址由后端固定路径提供，浏览器不接触 MinIO 密钥、对象键
// 或供应商地址；文件接口依赖同源会话 Cookie，因此统一使用 credentials:'same-origin'。
// 本模块不自动重试、不伪造统计，失败原样交给界面展示。

export class AssetsApiError extends Error {
  constructor(message, { code = null, status = 0 } = {}) {
    super(message);
    this.name = 'AssetsApiError';
    this.code = code;
    this.status = status;
  }
}

function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      const list = value.filter(Boolean);
      if (list.length) params.set(key, list.join(','));
      return;
    }
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function request(path) {
  let response;
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new AssetsApiError('网络请求失败，请检查本机服务是否可用。', { code: 'NETWORK_ERROR' });
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* 允许空响应或非 JSON 错误页 */ }
  if (!response.ok) {
    throw new AssetsApiError(
      payload?.error?.message || `素材接口请求失败（HTTP ${response.status}）。`,
      { code: payload?.error?.code || null, status: response.status },
    );
  }
  return payload;
}

export function assetImageUrl(id) {
  return `/api/assets/${encodeURIComponent(id)}/image`;
}

export function assetDownloadUrl(id) {
  return `/api/assets/${encodeURIComponent(id)}/download`;
}

// 查询参数与 server/assets-index.mjs 的 normalizeAssetQuery 保持一致：
// q（或 search）、source（generation/edit/project/template）、type（image/video）、
// from/to、limit、cursor。服务端不支持 operation 筛选，页面也不假装支持。
export function listAssets({ cursor, query, source, type, from, to, limit } = {}) {
  return request(`/api/assets${queryString({ q: query, cursor, source, type, from, to, limit })}`);
}

export function getAsset(id) {
  return request(`/api/assets/${encodeURIComponent(id)}`);
}

export function getAssetVersions(id) {
  return request(`/api/assets/${encodeURIComponent(id)}/versions`);
}
