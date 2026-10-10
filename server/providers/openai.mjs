import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetch, ProxyAgent } from 'undici';
import { AppError } from '../errors.mjs';

const IMAGE_NAME = /(gpt-image|dall-?e|image|imagen|flux|seedream|seededit|recraft|ideogram|banana|kolors|qwen-image|doubao.*(image|seedream)|grok.*image|stable-diffusion|sdxl|sd3|t2i|i2i|wanx)/i;
const VIDEO_NAME = /(sora|video|veo|kling|keling|jimeng|seedance|vidu|hailuo|minimax.*video|runway|pika|luma|wanx.*(t2v|i2v)|wan2|cogvideo|hunyuan.*(video|t2v)|t2v|i2v)/i;
const NON_MEDIA = /(embedding|embed|chat|completion|language|text-|audio|tts|whisper|speech|rerank|moderation|transcribe)/i;

// Product originals are limited to 10 MB by the upload gate; generated versions can be
// larger. Keep a hard ceiling before building a multipart request.
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

function text(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function mediaKind(id, meta = {}) {
  const declared = [
    meta.kind, meta.type, meta.modality, meta.category, meta.description,
    meta.metadata?.kind, meta.metadata?.type, meta.metadata?.modality,
    ...(Array.isArray(meta.capabilities) ? meta.capabilities : []),
    ...(Array.isArray(meta.tags) ? meta.tags : []),
    ...(Array.isArray(meta.supported_endpoints) ? meta.supported_endpoints : []),
  ].map(text).join(' ');
  if (/(video|t2v|i2v)/.test(declared)) return 'video';
  if (/(image|t2i|i2i)/.test(declared)) return 'image';
  if (NON_MEDIA.test(declared)) return 'other';
  const name = String(id || '');
  if (VIDEO_NAME.test(name)) return 'video';
  if (IMAGE_NAME.test(name)) return 'image';
  return 'other';
}

function valuesFrom(meta, keys) {
  for (const key of keys) {
    const value = meta?.[key] ?? meta?.parameters?.[key] ?? meta?.metadata?.[key];
    if (Array.isArray(value) && value.length && value.every(v => typeof v === 'string')) return value;
  }
  return [];
}

function capabilities(id) {
  const lower = String(id).toLowerCase();
  const isV3 = /dall-?e-?3/.test(lower);
  const sizes = isV3
    ? ['1024x1024', '1792x1024', '1024x1792']
    : ['1024x1024', '1536x1024', '1024x1536'];
  const qualities = isV3 ? ['standard', 'hd'] : ['low', 'medium', 'high'];
  return { sizes, qualities };
}

function isPrivateIp(address) {
  const ip = address.toLowerCase();
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7));
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

async function assertPublicImageUrl(value, baseUrl) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('ASSET_HOST_BLOCKED', '渠道返回的图片地址无效。', 502); }
  const base = baseUrl ? new URL(baseUrl) : null;
  const sameLocalHost = base && url.hostname === base.hostname &&
    base.protocol === 'http:' && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!sameLocalHost && (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))) {
    throw new AppError('ASSET_HOST_BLOCKED', '渠道返回的图片地址不是受信任的 HTTPS 地址。', 502);
  }
  if (sameLocalHost) return url;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || isPrivateIp(host)) {
    throw new AppError('ASSET_HOST_BLOCKED', '渠道返回的图片地址指向本机或内网，已阻止下载。', 502);
  }
  let addresses;
  try { addresses = await lookup(host, { all: true }); }
  catch { throw new AppError('ASSET_HOST_BLOCKED', '无法解析渠道图片域名。', 502); }
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
    throw new AppError('ASSET_HOST_BLOCKED', '渠道图片域名解析到本机或内网，已阻止下载。', 502);
  }
  return url;
}

export class OpenAiCompatibleProvider {
  constructor(config, env = process.env, transport = fetch) {
    this.config = config;
    this.id = config.id;
    // Static channels read the key from the named environment variable; database
    // channels pass the decrypted key directly. Never persist either on the config.
    this.key = config.apiKey || (config.apiKeyEnv ? env[config.apiKeyEnv] : '');
    this.transport = transport;
    this.dispatcher = env.MODEL_HTTPS_PROXY ? new ProxyAgent(env.MODEL_HTTPS_PROXY) : undefined;
    this.models = new Map();
    this.results = new Map();
    // Official /images/edits accepts a multipart file, so this adapter can hand the
    // server-side product original (or a generated version) to the model.
    this.supportsImageInput = true;
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await this.transport(`${this.config.baseUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(options.headers || {}),
        },
        dispatcher: this.dispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeout || 45_000),
      });
    } catch {
      throw new AppError('UPSTREAM_UNCERTAIN', '模型渠道连接中断，任务是否已受理尚不确定。请查询原任务，不要重新生成。', 502);
    }
    return response;
  }

  async catalog() {
    if (!this.key) throw new AppError('PROVIDER_UNCONFIGURED', '渠道 API Key 未配置。', 503);
    let response;
    try {
      response = await this.request('/models', { timeout: 20_000 });
    } catch (error) {
      throw new AppError('CHANNEL_CONNECTION', '无法连接模型渠道，请检查 Base URL 和网络。', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('CHANNEL_HTTP', `渠道返回 HTTP ${response.status}，请检查 Base URL 和 API Key。`, 502);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new AppError('CHANNEL_FORMAT', '渠道没有返回可识别的模型列表。', 502); }
    const list = Array.isArray(payload) ? payload
      : Array.isArray(payload.data) ? payload.data
        : Array.isArray(payload.models) ? payload.models
          : [];
    const seen = new Set();
    const models = [];
    for (const item of list) {
      const upstreamModel = typeof item === 'string' ? item : item?.id;
      if (!upstreamModel || seen.has(upstreamModel)) continue;
      seen.add(upstreamModel);
      const meta = typeof item === 'object' && item ? item : {};
      const kind = mediaKind(upstreamModel, meta);
      if (kind === 'other') continue;
      const generic = capabilities(upstreamModel);
      const declaredSizes = valuesFrom(meta, ['sizes', 'supported_sizes', 'size_options']);
      const qualities = valuesFrom(meta, ['qualities', 'quality_options']) || [];
      const sizes = declaredSizes.length ? declaredSizes : (kind === 'video' ? ['1280x720', '720x1280'] : generic.sizes);
      models.push({
        id: `${this.id}:${upstreamModel}`,
        providerId: this.id,
        providerName: this.config.name,
        upstreamModel,
        name: (typeof meta.name === 'string' && meta.name) || upstreamModel,
        kind,
        // This adapter implements both the official generation and edit endpoints.
        operations: kind === 'image' ? ['generate', 'edit'] : [],
        sizes,
        flexibleSize: kind === 'image' && declaredSizes.length === 0,
        qualities: qualities.length ? qualities : (kind === 'video' ? ['standard'] : generic.qualities),
        default: false,
        executable: kind === 'image',
        price: null,
        note: kind === 'video' ? '视频模型目录已同步；视频执行器尚未接入。' : null,
      });
    }
    const firstImage = models.find(model => model.kind === 'image');
    for (const model of models) {
      model.default = model.upstreamModel === this.config.defaultModel ||
        (!this.config.defaultModel && model === firstImage);
    }
    this.models = new Map(models.map(model => [model.upstreamModel, model]));
    return models;
  }

  async imageFromPayload(payload) {
    const item = payload?.data?.[0] || payload?.images?.[0] || payload;
    const encoded = item?.b64_json || item?.base64 || payload?.b64_json;
    const url = item?.url || payload?.url;
    if (typeof encoded === 'string' && encoded.length > 0) return Buffer.from(encoded, 'base64');
    if (typeof url === 'string') {
      const safeUrl = await assertPublicImageUrl(url, this.config.baseUrl);
      const image = await this.transport(safeUrl, {
        dispatcher: this.dispatcher, redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
      if (!image.ok) {
        await image.body?.cancel();
        throw new AppError('CHANNEL_IMAGE_DOWNLOAD', '图片已生成但下载失败，请核对渠道日志后查询原任务。', 502);
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of image.body) {
        length += chunk.byteLength;
        if (length > 30 * 1024 * 1024) throw new AppError('ASSET_TOO_LARGE', '图片超过 30 MB 存储上限。', 502);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new AppError('CHANNEL_FORMAT', '渠道没有返回图片 URL 或 base64 数据，无法确认结果。', 502);
  }

  async submit(job) {
    const model = this.models.get(job.input.upstreamModel);
    if (!model || model.kind !== 'image' || model.executable === false) {
      throw new AppError('MODEL_NOT_EXECUTABLE', '该模型仅同步到目录，当前不能执行生图。', 422);
    }
    // An edit (or a generation that carries a registered product original) uses the
    // official multipart endpoint. The image bytes must already come from server-side
    // storage; this adapter never accepts a client URL or object key.
    const source = job.input.sourceImage;
    const wantsEdit = job.input.operation === 'edit' || Boolean(source);
    if (wantsEdit) {
      if (!source || !Buffer.isBuffer(source.data) || !source.data.length) {
        throw new AppError('SOURCE_REQUIRED', '改图需要服务端已登记的源图片。', 422);
      }
      if (source.data.length > MAX_IMAGE_INPUT_BYTES) {
        throw new AppError('SOURCE_TOO_LARGE', '源图片超过 20 MB 改图上限。', 413);
      }
    }
    let response;
    try {
      if (wantsEdit) {
        if (this.config.editTransport === 'json-data-url') {
          // OMYAI's gateway rejects multipart with 400 "Model name not specified";
          // its verified /images/edits body is JSON with a base64 data URL.
          const dataUrl = `data:${source.contentType || 'image/png'};base64,${source.data.toString('base64')}`;
          response = await this.request('/images/edits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: job.input.upstreamModel,
              prompt: job.input.prompt,
              size: job.input.size,
              image: dataUrl,
            }),
            timeout: 180_000,
          });
        } else {
          // OpenAI standard: multipart/form-data. Do not set Content-Type so fetch
          // adds the boundary itself.
          const form = new FormData();
          form.append('model', job.input.upstreamModel);
          form.append('prompt', job.input.prompt);
          form.append('image', new Blob([source.data], {
            type: source.contentType || 'image/png',
          }), source.filename || 'source.png');
          form.append('size', job.input.size);
          form.append('quality', job.input.quality);
          form.append('n', '1');
          response = await this.request('/images/edits', {
            method: 'POST', body: form, timeout: 180_000,
          });
        }
      } else {
        response = await this.request('/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: job.input.upstreamModel,
            prompt: job.input.prompt,
            size: job.input.size,
            quality: job.input.quality,
            n: 1,
          }),
          timeout: 120_000,
        });
      }
    } catch {
      throw new AppError('UPSTREAM_UNCERTAIN', '渠道连接中断，是否已生成尚不确定。请查询原任务，不要重新生成。', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new AppError('CHANNEL_HTTP', `渠道返回 HTTP ${response.status}。请检查模型权限，未自动重试。`, 502);
      // A 4xx response is a definite rejection: no upstream task exists and the job can
      // fail instead of staying unknown. 5xx/timeouts remain uncertain.
      error.upstreamStatus = response.status;
      throw error;
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new AppError('CHANNEL_FORMAT', '渠道没有返回可识别的图片结果。', 502); }
    const data = await this.imageFromPayload(payload);
    if (!data.length) throw new AppError('CHANNEL_FORMAT', '渠道返回了空图片。', 502);
    const upstreamId = randomUUID();
    // The job service persists this buffer immediately. The in-memory copy stays only as
    // a compatibility fallback for explicit poll/download and must not be relied on
    // after a restart.
    this.results.set(upstreamId, data);
    while (this.results.size > 10) this.results.delete(this.results.keys().next().value);
    return { job_id: upstreamId, result: { data, bytes: data.length } };
  }

  async poll(id) {
    if (this.results.has(id)) return { status: 'succeeded', download_url: `sj-result://${id}` };
    return { status: 'unknown' };
  }

  async download(url) {
    if (typeof url === 'string' && url.startsWith('sj-result://')) {
      const id = url.slice('sj-result://'.length);
      const data = this.results.get(id);
      if (!data) throw new AppError('ASSET_EXPIRED', '临时图片结果已失效，请查询渠道使用日志。', 502);
      return data;
    }
    throw new AppError('ASSET_HOST_BLOCKED', '只允许下载本渠道刚返回的临时图片结果。', 502);
  }
}

export { mediaKind, assertPublicImageUrl };
