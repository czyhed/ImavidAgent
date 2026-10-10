import { randomUUID } from 'node:crypto';
import { fetch, ProxyAgent } from 'undici';
import { AppError } from '../errors.mjs';

export function parseRpc(text) {
  // Streamable HTTP can return JSON or a sequence of SSE data frames.
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const value = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim()).join('\n');
    if (value && value !== '[DONE]') {
      const parsed = JSON.parse(value);
      if (parsed.result || parsed.error) return parsed;
    }
  }
  throw new AppError('UPSTREAM_FORMAT', '供应商返回了无法识别的响应。', 502);
}

export function toolData(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content || []) {
    if (item.type === 'text') {
      try { return JSON.parse(item.text); } catch { /* No raw upstream text in logs or UI. */ }
    }
  }
  throw new AppError('UPSTREAM_FORMAT', '供应商未返回结构化任务结果。', 502);
}

export class OmyaiProvider {
  constructor(config, env = process.env, transport = fetch) {
    this.config = config;
    this.id = config.id;
    this.key = env[config.apiKeyEnv];
    this.transport = transport;
    this.dispatcher = env.MODEL_HTTPS_PROXY ? new ProxyAgent(env.MODEL_HTTPS_PROXY) : undefined;
  }

  async rpc(method, params) {
    let response;
    try {
      response = await this.transport(this.config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(45_000),
        redirect: 'error',
      });
    } catch {
      throw new AppError('UPSTREAM_UNCERTAIN', '供应商连接中断，任务是否已受理尚不确定。请查询原任务，不要重新生成。', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('UPSTREAM_HTTP', `供应商返回 HTTP ${response.status}。请检查权限或服务状态。`, 502);
    }
    const rpc = parseRpc(await response.text());
    if (rpc.error) throw new AppError('UPSTREAM_RPC', '供应商请求未完成，请核对接口配置。', 502);
    return rpc.result;
  }

  async call(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const data = toolData(result);
    if (result.isError || data.error) {
      const code = data.code || data.error?.code || '';
      if (code === 'REQUEST_ID_CONFLICT') {
        // Do not silently associate a conflicting request with different parameters.
        throw new AppError('REQUEST_ID_CONFLICT', '供应商报告请求编号冲突。已停止提交，请核对供应商原任务。', 409);
      }
      throw new AppError('UPSTREAM_REJECTED', '供应商拒绝了本次请求。请查看 OMYAI 使用日志，未自动重试。', 502);
    }
    return data;
  }

  async catalog() {
    if (!this.key) throw new AppError('PROVIDER_UNCONFIGURED', 'OMYAI 服务端密钥未配置。', 503);
    const [available, schema] = await Promise.all([
      this.call('list_image_models', {}),
      this.rpc('tools/list', {}),
    ]);
    const properties = schema.tools?.find(tool => tool.name === 'generate_image')?.inputSchema?.properties;
    if (!properties?.size?.enum || !properties?.quality?.enum) {
      throw new AppError('CAPABILITY_UNAVAILABLE', '供应商未提供可验证的生成参数。', 502);
    }
    return (available.models || []).filter(id => properties.model?.enum?.includes(id)).map(id => ({
      id: `${this.id}:${id}`,
      providerId: this.id,
      providerName: this.config.name,
      upstreamModel: id,
      name: id,
      kind: 'image',
      operations: available.capabilities?.edit_generated_images ? ['generate', 'edit'] : ['generate'],
      sizes: properties.size.enum,
      qualities: properties.quality.enum,
      default: id === this.config.defaultModel,
      price: null,
    }));
  }

  submit(job) {
    const args = {
      prompt: job.input.prompt,
      request_id: job.id,
      model: job.input.upstreamModel,
      size: job.input.size,
      quality: job.input.quality,
    };
    if (job.input.sourceUpstreamId) args.source_job_id = job.input.sourceUpstreamId;
    return this.call(job.input.operation === 'edit' ? 'edit_image' : 'generate_image', args);
  }

  poll(id) {
    return this.call('get_image_result', { job_id: id, wait_seconds: 10, include_image: false });
  }

  async download(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password ||
        (target.port && target.port !== '443') || !this.config.assetHosts.includes(target.hostname)) {
      throw new AppError('ASSET_HOST_BLOCKED', '供应商图片域名尚未获准下载，请在服务端核对配置后重新查询原任务。', 502);
    }
    // Signed assets receive no API Key. Never follow a redirect to an unchecked host.
    const response = await this.transport(target, {
      dispatcher: this.dispatcher, redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('ASSET_DOWNLOAD', '图片下载失败，请查询原任务以重试转存。', 502);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > 30 * 1024 * 1024) {
        throw new AppError('ASSET_TOO_LARGE', '图片超过当前 30 MB 存储上限。', 502);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
