import { createHash } from 'node:crypto';
import { AppError, safeError } from './errors.mjs';
import { jobWorkspaceId } from './access.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The upload gate caps product originals at 10 MB; generated versions can be larger.
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

async function readSourceStream(stream) {
  if (Buffer.isBuffer(stream)) {
    if (!stream.length) throw new AppError('INVALID_SOURCE', '源图片为空。', 422);
    if (stream.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new AppError('SOURCE_TOO_LARGE', '源图片超过 20 MB 改图上限。', 413);
    }
    return stream;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_SOURCE_IMAGE_BYTES) {
      throw new AppError('SOURCE_TOO_LARGE', '源图片超过 20 MB 改图上限。', 413);
    }
    chunks.push(buffer);
  }
  if (!length) throw new AppError('INVALID_SOURCE', '源图片为空。', 422);
  return Buffer.concat(chunks);
}

export function normalize(body) {
  if (!body || typeof body !== 'object' || !UUID.test(body.requestId || '')) {
    throw new AppError('INVALID_REQUEST_ID', '请提供有效的随机 UUID 请求编号。');
  }
  const allowed = ['requestId', 'modelId', 'prompt', 'size', 'quality', 'operation', 'sourceJobId', 'sourceAssetId'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError('INVALID_FIELD', '请求包含不支持的字段。');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) {
    throw new AppError('INVALID_PROMPT', '提示词长度须为 1–16000 个字符。');
  }
  if (typeof body.modelId !== 'string' || body.modelId.length > 150 ||
      typeof body.size !== 'string' || typeof body.quality !== 'string') {
    throw new AppError('INVALID_MODEL', '请选择模型、尺寸和质量。');
  }
  const operation = body.operation || 'generate';
  if (!['generate', 'edit'].includes(operation)) throw new AppError('INVALID_OPERATION', '当前仅支持生图和改图。');
  const sourceJobId = body.sourceJobId === undefined || body.sourceJobId === null ? null : body.sourceJobId;
  const sourceAssetId = body.sourceAssetId === undefined || body.sourceAssetId === null ? null : body.sourceAssetId;
  if (sourceJobId !== null && !UUID.test(sourceJobId)) throw new AppError('INVALID_SOURCE', '源任务编号格式不正确。');
  if (sourceAssetId !== null && !UUID.test(sourceAssetId)) throw new AppError('INVALID_SOURCE', '商品原图编号格式不正确。');
  if (sourceJobId && sourceAssetId) throw new AppError('INVALID_SOURCE', '不能同时指定源任务和商品原图。');
  if (operation === 'edit' && !sourceJobId && !sourceAssetId) {
    throw new AppError('SOURCE_REQUIRED', '改图必须选择成功的源图片或已登记的商品原图。');
  }
  if (operation === 'generate' && sourceJobId) throw new AppError('INVALID_SOURCE', '文生图不能携带源任务。');
  const input = {
    modelId: body.modelId, prompt: body.prompt.trim(), size: body.size,
    quality: body.quality, operation, sourceJobId, sourceAssetId,
  };
  return {
    id: body.requestId, input,
    inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  };
}

export function publicJob(job) {
  return {
    id: job.id, status: job.status, modelId: job.input.modelId, prompt: job.input.prompt,
    size: job.input.size, quality: job.input.quality, operation: job.input.operation,
    sourceJobId: job.input.sourceJobId, sourceAssetId: job.input.sourceAssetId || null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    error: job.error, cost: null,
    imageUrl: job.status === 'succeeded' ? `/api/jobs/${job.id}/image` : null,
    imageBytes: job.status === 'succeeded' ? (job.output?.bytes ?? null) : null,
  };
}

export class GenerationService {
  constructor(store, assets, registry, { assetsIndex, imageInput } = {}) {
    this.store = store;
    this.assets = assets;
    this.registry = registry;
    // 可选：任务成功后把真实产出索引为素材（Issue #4）。缺失时保持旧行为。
    this.assetsIndex = assetsIndex;
    // 可选：商品原图只按服务端登记的 ID 读取，前端不能传入 URL 或对象键。
    this.imageInput = imageInput;
    this.busy = false;
  }

  async create(body, { workspaceId = null } = {}) {
    const job = normalize(body);
    const existing = await this.store.get(job.id);
    if (existing) {
      if (existing.inputHash !== job.inputHash) throw new AppError('REQUEST_CONFLICT', '同一请求编号不能用于不同参数。', 409);
      // 归属校验：另一个工作空间不能复用同一请求编号读取已有任务。
      if (workspaceId && jobWorkspaceId(existing) !== workspaceId) {
        throw new AppError('FORBIDDEN', '无权使用该请求编号。', 403);
      }
      return existing;
    }
    const providerId = String(job.input.modelId).split(':')[0];
    if (providerId && typeof this.registry.refreshProvider === 'function') {
      // Re-read the selected channel's model list before accepting a new paid job.
      await this.registry.refreshProvider(providerId).catch(() => {});
    }
    const model = await this.registry.resolve(job.input.modelId);
    const sizeSupported = model.flexibleSize === true || model.sizes.includes(job.input.size);
    if (!model.operations.includes(job.input.operation) || !sizeSupported ||
        !model.qualities.includes(job.input.quality)) {
      throw new AppError('UNSUPPORTED_CAPABILITY', '该模型不支持所选操作、尺寸或质量。', 422);
    }
    job.input.providerId = model.providerId;
    job.input.upstreamModel = model.upstreamModel;
    job.workspaceId = workspaceId || 'local';
    const provider = this.registry.providers.get(model.providerId);
    if (job.input.sourceAssetId) {
      // Only adapters that implement a real upload protocol may receive product originals.
      // The MCP adapter keeps using source_job_id and must not accept arbitrary images.
      if (!provider?.supportsImageInput) {
        throw new AppError('UNSUPPORTED_CAPABILITY', '该渠道不支持上传商品原图。', 422);
      }
      if (!model.operations.includes('edit')) {
        throw new AppError('UNSUPPORTED_CAPABILITY', '该模型不支持原图输入。', 422);
      }
      if (!this.imageInput) {
        throw new AppError('IMAGE_INPUT_UNAVAILABLE', '商品原图服务暂不可用。', 503);
      }
      const image = await this.imageInput.get(job.input.sourceAssetId, job.workspaceId);
      if (!image) throw new AppError('IMAGE_NOT_FOUND', '商品图片不存在。', 404);
      if (image.kind !== 'original') {
        throw new AppError('SCREENSHOT_NOT_INPUT', '来源截图只作为识别证据，不能作为生成输入。', 422);
      }
      if (workspaceId && image.workspaceId && image.workspaceId !== workspaceId) {
        throw new AppError('SOURCE_FORBIDDEN', '商品原图不属于当前工作空间。', 403);
      }
    }
    if (job.input.sourceJobId) {
      const source = await this.store.get(job.input.sourceJobId);
      // 源图必须属于同一工作空间，避免用猜到的 UUID 复用他人图片。
      if (source && workspaceId && jobWorkspaceId(source) !== workspaceId) {
        throw new AppError('SOURCE_FORBIDDEN', '源图不属于当前工作空间。', 403);
      }
      if (!source || source.status !== 'succeeded' || !source.upstreamId ||
          source.input.providerId !== model.providerId) {
        throw new AppError('INVALID_SOURCE', '源图必须是同一供应商已成功生成的图片。');
      }
      if (provider?.supportsImageInput && !source.output?.key) {
        throw new AppError('INVALID_SOURCE', '源图片尚未转存，不能用于改图。');
      }
      // MCP keeps editing by upstream job ID for 24 h. An adapter that re-uploads the
      // private MinIO copy does not depend on that window.
      if (!provider?.supportsImageInput &&
          Date.now() - new Date(source.createdAt).getTime() >= 23 * 3600_000) {
        throw new AppError('SOURCE_EXPIRED', '源图已接近或超过供应商编辑有效期；本地图片仍可下载。', 422);
      }
      job.input.sourceUpstreamId = source.upstreamId;
    }
    // 归属写入任务输入（JSONB），无需新增数据库列；请求哈希在写入前已计算，不含归属。
    job.input.workspaceId = job.workspaceId;
    return this.store.insert(job);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const job = await this.store.claim();
      if (job) await this.run(job);
    } finally { this.busy = false; }
  }

  async reconcile(id) {
    if (this.busy) throw new AppError('WORKER_BUSY', '正在处理其他任务，请稍后查询。', 409);
    this.busy = true;
    try {
      const job = await this.store.get(id);
      if (!job) throw new AppError('NOT_FOUND', '任务不存在。', 404);
      if (job.status !== 'unknown') throw new AppError('NOT_UNCERTAIN', '只有待核实任务需要恢复查询。', 409);
      // Upstream idempotency expires in 7 days. Never resubmit an old unacknowledged request.
      if (!job.upstreamId && Date.now() - new Date(job.createdAt).getTime() > 6 * 86400_000) {
        throw new AppError('DEDUPE_EXPIRED', '请求去重期即将到期，请到供应商使用日志核实，已禁止重新提交。', 409);
      }
      const updated = await this.store.update(id, { status: job.upstreamId ? 'running' : 'submitting', error: null });
      this.run(job).catch(() => {}).finally(() => { this.busy = false; });
      return updated;
    } catch (error) { this.busy = false; throw error; }
  }

  async indexAsset(job) {
    if (!this.assetsIndex || !job) return;
    try {
      // 索引到任务自己的工作空间；注入的单一实例默认是 'local'。
      const index = typeof this.assetsIndex.forWorkspace === 'function'
        ? this.assetsIndex.forWorkspace(jobWorkspaceId(job))
        : this.assetsIndex;
      await index.indexSucceededJob(job);
    } catch {
      // 索引失败不能反过来把已成功任务改成失败；可稍后运行回填脚本修复。
      console.error('素材索引失败：已保留成功任务，可稍后回填。');
    }
  }

  async loadSourceImage(job) {
    if (job.input.sourceAssetId) {
      if (!this.imageInput) throw new AppError('IMAGE_INPUT_UNAVAILABLE', '商品原图服务暂不可用。', 503);
      const { image, stream } = await this.imageInput.open(
        job.input.sourceAssetId, job.input.workspaceId,
      );
      if (image.kind !== 'original') {
        throw new AppError('SCREENSHOT_NOT_INPUT', '来源截图只作为识别证据，不能作为生成输入。', 422);
      }
      const data = await readSourceStream(stream);
      return {
        data,
        contentType: image.contentType,
        filename: `${image.id}.${image.extension || 'png'}`,
      };
    }
    if (job.input.sourceJobId) {
      const source = await this.store.get(job.input.sourceJobId);
      if (!source || source.status !== 'succeeded' || !source.output?.key) {
        throw new AppError('INVALID_SOURCE', '源图片尚未转存，不能用于改图。', 422);
      }
      const data = await readSourceStream(await this.assets.get(source.output));
      return {
        data,
        contentType: source.output.contentType || 'image/png',
        filename: source.output.filename || 'source.png',
      };
    }
    throw new AppError('SOURCE_REQUIRED', '改图需要服务端已登记的源图片。', 422);
  }

  async storeImage(job, data) {
    await this.store.update(job.id, { status: 'storing' });
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    const output = await this.assets.put(job.id, buffer);
    const succeeded = await this.store.update(job.id, { status: 'succeeded', output, error: null });
    await this.indexAsset(succeeded || { ...job, status: 'succeeded', output });
  }

  async run(job) {
    const provider = this.registry.providers.get(job.input.providerId);
    try {
      if (!provider) throw new AppError('PROVIDER_UNAVAILABLE', '原供应商已停用，无法查询原任务。', 503);
      if (!job.upstreamId) {
        if (provider.supportsImageInput && (job.input.operation === 'edit' || job.input.sourceAssetId)) {
          // Read the bytes on the server for every attempt; never trust a client URL.
          // The buffer lives only on this in-memory job and is not written to JSONB.
          job.input.sourceImage = await this.loadSourceImage(job);
        }
        const submitted = await provider.submit(job);
        if (!UUID.test(submitted.job_id || '')) throw new AppError('UPSTREAM_FORMAT', '供应商未返回有效任务编号，请核实使用日志。', 502);
        job.upstreamId = submitted.job_id;
        await this.store.update(job.id, { upstreamId: job.upstreamId, status: 'running', error: null });
        if (submitted.result?.data) {
          // Synchronous official endpoint: persist the returned image immediately instead
          // of relying on the adapter's in-memory cache, which a restart would lose.
          await this.storeImage(job, submitted.result.data);
          return;
        }
      }
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        const result = await provider.poll(job.upstreamId);
        if (['failed', 'cancelled', 'canceled', 'expired'].includes(result.status)) {
          await this.store.update(job.id, {
            status: 'failed',
            error: { code: 'UPSTREAM_FAILED', message: '供应商任务未成功，请核对 OMYAI 使用日志和费用；没有自动重试。' },
          });
          return;
        }
        if (result.status === 'unknown') throw new AppError('UPSTREAM_UNKNOWN', '供应商状态未知，请先核对使用日志，再查询原任务。', 502);
        if (['succeeded', 'completed', 'success'].includes(result.status)) {
          const imageUrl = result.download_url || result.image_url || result.url;
          if (typeof imageUrl !== 'string') throw new AppError('UPSTREAM_FORMAT', '图片链接缺失，请查询原任务。', 502);
          await this.storeImage(job, await provider.download(imageUrl));
          return;
        }
        if (!['queued', 'pending', 'running', 'processing', 'submitted'].includes(result.status)) {
          throw new AppError('UPSTREAM_FORMAT', '供应商返回了未知任务状态，请核实后查询。', 502);
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new AppError('POLL_TIMEOUT', '任务等待超过 15 分钟。可继续查询原任务，不会重新生成。', 504);
    } catch (error) {
      // 明确的 4xx 拒绝、渠道停用或本地校验失败说明上游没有受理任务，可以安全记为失败；
      // 超时、断连、重启或转存失败仍记为 unknown，等待人工核对原任务，绝不自动重发。
      const rejectedBeforeSubmit = !job.upstreamId && (
        (Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 400 && error.upstreamStatus < 500)
        || ['PROVIDER_UNAVAILABLE', 'MODEL_NOT_EXECUTABLE', 'UNSUPPORTED_CAPABILITY', 'SOURCE_REQUIRED', 'SOURCE_TOO_LARGE'].includes(error?.code)
      );
      await this.store.update(job.id, {
        upstreamId: job.upstreamId || null,
        status: rejectedBeforeSubmit ? 'failed' : 'unknown',
        error: safeError(error),
      });
    }
  }
}
