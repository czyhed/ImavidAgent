import { fetch, ProxyAgent } from 'undici';
import { AppError } from '../errors.mjs';

// Public endpoint and model ids were checked against the official docs on
// 2026-10-21: https://api-docs.deepseek.com/ (POST /chat/completions) and
// https://api-docs.deepseek.com/quick_start/pricing (deepseek-flash,
// deepseek-v4-pro). Keep both baseUrl and model ids in config/providers.json;
// do not infer them from the model name.
const CHAT_PATH = '/chat/completions';

function endpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new AppError('PROVIDER_CONFIG', 'DeepSeek Base URL 格式不正确。', 500); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('PROVIDER_CONFIG', 'DeepSeek Base URL 必须是不含凭据的 http(s) 地址。', 500);
  }
  return `${url.toString().replace(/\/+$/, '')}${CHAT_PATH}`;
}

export class DeepSeekProvider {
  constructor(config, env = process.env, transport = fetch) {
    this.config = config;
    this.id = config.id;
    // The key is read from the environment at startup and never serialized.
    this.key = env[config.apiKeyEnv];
    this.url = endpoint(config.baseUrl);
    this.transport = transport;
    this.dispatcher = env.MODEL_HTTPS_PROXY ? new ProxyAgent(env.MODEL_HTTPS_PROXY) : undefined;
  }

  async chat({ upstreamModel, messages, temperature, maxTokens, thinking }) {
    if (!this.key) throw new AppError('PROVIDER_UNCONFIGURED', 'DeepSeek 服务端密钥未配置。', 503);
    const body = { model: upstreamModel, messages, stream: false };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (thinking !== undefined) body.thinking = { type: thinking ? 'enabled' : 'disabled' };

    let response;
    try {
      response = await this.transport(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs || 90_000),
      });
    } catch {
      // The request may already have reached the provider; callers must not
      // assume it failed and resend under a new idempotency key.
      throw new AppError('UPSTREAM_UNCERTAIN', 'DeepSeek 连接中断，是否已执行尚不确定。请按原幂等键查询，不要自动重试。', 502);
    }
    if (!response.ok) {
      // Never include an upstream body: it can echo request data and is not
      // needed to explain the failure to the internal caller.
      await response.body?.cancel();
      throw new AppError(
        'UPSTREAM_HTTP',
        `DeepSeek 返回 HTTP ${response.status}。请检查模型名、密钥或账户状态；没有自动重试。`,
        502,
      );
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new AppError('UPSTREAM_FORMAT', 'DeepSeek 返回了无法识别的响应。请查询原调用记录。', 502); }
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      throw new AppError('UPSTREAM_FORMAT', 'DeepSeek 未返回文本结果。请查询原调用记录。', 502);
    }
    const usage = payload.usage;
    return {
      content,
      finishReason: choice.finish_reason || null,
      upstreamModel: typeof payload.model === 'string' ? payload.model : upstreamModel,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? null,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      } : null,
    };
  }
}
