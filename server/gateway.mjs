import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { DeepSeekProvider } from './providers/deepseek.mjs';

// Capabilities with a real executor in this change. A model may carry more
// capabilities in the registry, but invoking an unimplemented one must fail
// explicitly instead of falling back to another paid model.
export const SUPPORTED_CAPABILITIES = new Set(['text.chat']);
export const ALIAS_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['system', 'user', 'assistant']);
const INVOKE_FIELDS = ['idempotencyKey', 'capability', 'modelId', 'alias', 'messages', 'temperature', 'maxTokens', 'thinking'];

export const defaultFactories = {
  deepseek: config => new DeepSeekProvider(config),
};

const JSON_COLUMNS = new Set(['response', 'usage', 'error']);

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.length || value.length > max) {
    fail('INVALID_INPUT', `${label}需为 1–${max} 个字符。`);
  }
  return value;
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    fail('INVALID_INPUT', 'messages 需为 1–100 条消息。');
  }
  const messages = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['role', 'content'].includes(key))) {
      fail('INVALID_INPUT', 'messages 只接受 role 与 content 字段。');
    }
    if (!ROLES.has(item.role)) fail('INVALID_INPUT', '消息角色仅支持 system、user、assistant。');
    if (typeof item.content !== 'string' || !item.content.length || item.content.length > 16_000) {
      fail('INVALID_INPUT', '单条消息内容需为 1–16000 个字符。');
    }
    total += item.content.length;
    if (total > 30_000) fail('INVALID_INPUT', '消息总长度不能超过 30000 个字符。');
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}

export function normalizeInvoke(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_INPUT', '调用参数必须是 JSON 对象。');
  if (Object.keys(body).some(key => !INVOKE_FIELDS.includes(key))) {
    fail('INVALID_FIELD', '调用包含不支持的字段。');
  }
  if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    fail('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 需为 1–200 个字母、数字、点、下划线、冒号或连字符。');
  }
  const capability = text(body.capability, 'capability', 80);
  if (body.modelId !== undefined && (typeof body.modelId !== 'string' || body.modelId.length > 200 || !body.modelId.length)) {
    fail('INVALID_MODEL', 'modelId 格式不正确。');
  }
  if (body.alias !== undefined && (typeof body.alias !== 'string' || !ALIAS_PATTERN.test(body.alias))) {
    fail('INVALID_ALIAS', '别名需为 2–40 位小写字母、数字或连字符，并以字母开头。');
  }
  if (body.modelId && body.alias) fail('INVALID_SELECTION', '请只指定 modelId 或 alias 其中一个。');
  const messages = normalizeMessages(body.messages);
  if (body.temperature !== undefined &&
      (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    fail('INVALID_INPUT', 'temperature 需为 0–2 之间的数字。');
  }
  if (body.maxTokens !== undefined &&
      (!Number.isInteger(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > 393_216)) {
    fail('INVALID_INPUT', 'maxTokens 需为 1–393216 之间的整数。');
  }
  if (body.thinking !== undefined && typeof body.thinking !== 'boolean') {
    fail('INVALID_INPUT', 'thinking 必须是布尔值。');
  }
  // Fixed property order keeps the hash stable for identical requests.
  const request = {
    capability,
    modelId: body.modelId || null,
    alias: body.alias || null,
    messages,
    temperature: body.temperature ?? null,
    maxTokens: body.maxTokens ?? null,
    thinking: body.thinking ?? null,
  };
  return { idempotencyKey: body.idempotencyKey, request };
}

function modelId(providerId, upstreamModel) {
  const id = `${providerId}:${upstreamModel}`;
  if (id.length > 200) throw new AppError('PROVIDER_CONFIG', '模型标识过长。', 500);
  return id;
}

function modelRow(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    upstreamModel: row.upstream_model,
    name: row.name,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    parameters: row.parameters || {},
    source: row.source,
    enabled: row.enabled,
    executable: row.executable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function callRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    capability: row.capability,
    modelId: row.model_id,
    alias: row.alias,
    requestHash: row.request_hash,
    request: row.request,
    status: row.status,
    response: row.response,
    usage: row.usage,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicCall(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    capability: row.capability,
    modelId: row.modelId,
    alias: row.alias,
    status: row.status,
    request: row.request,
    result: row.response?.content ?? null,
    finishReason: row.response?.finishReason ?? null,
    usage: row.usage,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresModelStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    // The migration file is the single source of schema truth; it is safe to
    // execute on every start because every statement is idempotent.
    const sql = await readFile(new URL('./migrations/0003-models.sql', import.meta.url), 'utf8');
    await this.pool.query(sql);
  }

  async upsertModel(model) {
    const result = await this.pool.query(`
      INSERT INTO sj_models
        (id,provider_id,upstream_model,name,capabilities,parameters,source,enabled,executable)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        provider_id=EXCLUDED.provider_id,
        upstream_model=EXCLUDED.upstream_model,
        name=EXCLUDED.name,
        capabilities=EXCLUDED.capabilities,
        parameters=EXCLUDED.parameters,
        executable=EXCLUDED.executable,
        updated_at=now()
      RETURNING *
    `, [
      model.id, model.providerId, model.upstreamModel, model.name,
      JSON.stringify(model.capabilities), JSON.stringify(model.parameters),
      model.source, model.enabled, model.executable,
    ]);
    return modelRow(result.rows[0]);
  }

  async listModels() {
    return (await this.pool.query('SELECT * FROM sj_models ORDER BY provider_id, id')).rows.map(modelRow);
  }

  async getModel(id) {
    if (typeof id !== 'string' || !id) return null;
    return modelRow((await this.pool.query('SELECT * FROM sj_models WHERE id=$1', [id])).rows[0]);
  }

  async listDefaults() {
    return (await this.pool.query('SELECT * FROM sj_model_defaults ORDER BY capability')).rows.map(row => ({
      capability: row.capability, modelId: row.model_id, updatedAt: row.updated_at,
    }));
  }

  async getDefault(capability) {
    const row = (await this.pool.query('SELECT * FROM sj_model_defaults WHERE capability=$1', [capability])).rows[0];
    return row ? { capability: row.capability, modelId: row.model_id, updatedAt: row.updated_at } : null;
  }

  async setDefault(capability, modelIdValue) {
    const row = (await this.pool.query(`
      INSERT INTO sj_model_defaults (capability,model_id) VALUES ($1,$2)
      ON CONFLICT (capability) DO UPDATE SET model_id=EXCLUDED.model_id,updated_at=now()
      RETURNING *
    `, [capability, modelIdValue])).rows[0];
    return { capability: row.capability, modelId: row.model_id, updatedAt: row.updated_at };
  }

  async listAliases() {
    return (await this.pool.query('SELECT * FROM sj_model_aliases ORDER BY alias')).rows.map(row => ({
      alias: row.alias, modelId: row.model_id, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async getAlias(alias) {
    const row = (await this.pool.query('SELECT * FROM sj_model_aliases WHERE alias=$1', [alias])).rows[0];
    return row ? { alias: row.alias, modelId: row.model_id, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  async setAlias(alias, modelIdValue) {
    const row = (await this.pool.query(`
      INSERT INTO sj_model_aliases (alias,model_id) VALUES ($1,$2)
      ON CONFLICT (alias) DO UPDATE SET model_id=EXCLUDED.model_id,updated_at=now()
      RETURNING *
    `, [alias, modelIdValue])).rows[0];
    return { alias: row.alias, modelId: row.model_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async beginCall(call) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize admission so two concurrent requests with one key cannot
      // both see "not found" and submit the same paid work twice.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sj:model-gateway-admission'))");
      const existing = (await client.query('SELECT * FROM sj_model_calls WHERE idempotency_key=$1', [call.idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== call.requestHash) {
          throw new AppError('REQUEST_CONFLICT', '同一幂等键不能用于不同参数。', 409);
        }
        await client.query('COMMIT');
        return { call: callRow(existing), created: false };
      }
      const inserted = await client.query(`
        INSERT INTO sj_model_calls
          (id,idempotency_key,capability,alias,request_hash,request,status)
        VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING *
      `, [call.id, call.idempotencyKey, call.capability, call.alias, call.requestHash, JSON.stringify(call.request)]).rows[0];
      await client.query('COMMIT');
      return { call: callRow(inserted), created: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateCall(id, patch) {
    const columns = {
      modelId: 'model_id', status: 'status', response: 'response', usage: 'usage', error: 'error',
    };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    if (!entries.length) return this.getCall(id);
    const sets = entries.map(([key], index) => `${columns[key]}=$${index + 2}`);
    const values = entries.map(([key, value]) => JSON_COLUMNS.has(key) ? JSON.stringify(value) : value);
    const row = (await this.pool.query(
      `UPDATE sj_model_calls SET ${sets.join(',')},updated_at=now() WHERE id=$1 RETURNING *`,
      [id, ...values],
    )).rows[0];
    return callRow(row);
  }

  async getCall(id) {
    if (!CALL_ID.test(String(id || ''))) return null;
    return callRow((await this.pool.query('SELECT * FROM sj_model_calls WHERE id=$1', [id])).rows[0]);
  }
}

export class ModelGateway {
  constructor(store, providers = [], factories = defaultFactories) {
    this.store = store;
    this.providers = new Map();
    this.factories = factories;
    for (const provider of providers) {
      if (!provider?.id || this.providers.has(provider.id)) {
        throw new AppError('PROVIDER_CONFIG', '模型渠道配置包含重复或缺失 ID。', 500);
      }
      const factory = this.factories[provider.adapter];
      if (!factory) throw new AppError('PROVIDER_CONFIG', '模型渠道配置包含未知适配器。', 500);
      this.providers.set(provider.id, {
        enabled: provider.enabled !== false,
        config: provider,
        adapter: factory(provider),
      });
    }
  }

  async init() {
    await this.store.init();
    for (const [providerId, entry] of this.providers) {
      for (const model of entry.config.models || []) {
        if (!model?.id || !Array.isArray(model.capabilities) || !model.capabilities.length) {
          throw new AppError('PROVIDER_CONFIG', `渠道 ${providerId} 的模型配置不完整。`, 500);
        }
        await this.store.upsertModel({
          id: modelId(providerId, model.id),
          providerId,
          upstreamModel: model.id,
          name: model.name || model.id,
          capabilities: model.capabilities,
          parameters: model.parameters || {},
          source: 'config',
          enabled: model.enabled !== false,
          executable: model.executable !== false,
        });
      }
    }
  }

  async assertExecutable(modelIdValue, capability) {
    const model = await this.store.getModel(modelIdValue);
    if (!model) fail('MODEL_NOT_FOUND', '模型不存在。', 404);
    if (!model.enabled) fail('MODEL_DISABLED', '该模型已停用，不能用于新调用。');
    if (!model.executable) fail('MODEL_NOT_EXECUTABLE', '该模型只登记了目录，执行器尚未接入。');
    if (capability && !model.capabilities.includes(capability)) {
      fail('UNSUPPORTED_CAPABILITY', `该模型不支持能力 ${capability}。`);
    }
    const provider = this.providers.get(model.providerId);
    if (!provider || !provider.enabled) fail('PROVIDER_UNAVAILABLE', '模型渠道未配置或已停用。', 503);
    return model;
  }

  async resolve(request) {
    const capability = request.capability;
    if (!SUPPORTED_CAPABILITIES.has(capability)) {
      fail('MODEL_NOT_CONFIGURED', `能力 ${capability} 尚未接入执行器或未配置默认模型。`);
    }
    let target;
    let selection;
    if (request.modelId) {
      target = request.modelId;
      selection = 'model';
    } else if (request.alias) {
      const alias = await this.store.getAlias(request.alias);
      if (!alias) fail('MODEL_NOT_CONFIGURED', `别名 ${request.alias} 未配置。`);
      target = alias.modelId;
      selection = 'alias';
    } else {
      const fallback = await this.store.getDefault(capability);
      if (!fallback) fail('MODEL_NOT_CONFIGURED', `能力 ${capability} 的默认模型未配置。`);
      target = fallback.modelId;
      selection = 'default';
    }
    const model = await this.assertExecutable(target, capability);
    return { model, selection };
  }

  async invoke(body) {
    const { idempotencyKey, request } = normalizeInvoke(body);
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const admission = await this.store.beginCall({
      id: randomUUID(), idempotencyKey, requestHash, request,
      capability: request.capability, alias: request.alias,
    });
    if (!admission.created) return { call: publicCall(admission.call) };

    try {
      const { model } = await this.resolve(request);
      await this.store.updateCall(admission.call.id, { modelId: model.id });
      const provider = this.providers.get(model.providerId);
      const result = await provider.adapter.chat({
        upstreamModel: model.upstreamModel,
        messages: request.messages,
        temperature: request.temperature ?? undefined,
        maxTokens: request.maxTokens ?? undefined,
        thinking: request.thinking ?? undefined,
      });
      const call = await this.store.updateCall(admission.call.id, {
        status: 'succeeded',
        response: {
          content: result.content,
          finishReason: result.finishReason,
          upstreamModel: result.upstreamModel,
        },
        usage: result.usage,
        error: null,
      });
      return { call: publicCall(call) };
    } catch (error) {
      const safe = error instanceof AppError
        ? { code: error.code, message: error.message }
        : { code: 'SERVICE_ERROR', message: '模型调用失败，未自动重试。' };
      // A lost response or malformed success may already have been billed, so
      // it stays unknown; a clear upstream rejection is failed.
      const status = ['UPSTREAM_UNCERTAIN', 'UPSTREAM_FORMAT'].includes(safe.code) ? 'unknown' : 'failed';
      const call = await this.store.updateCall(admission.call.id, { status, error: safe });
      return { call: publicCall(call) };
    }
  }

  async setDefault(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['capability', 'modelId'].includes(key))) {
      fail('INVALID_FIELD', '默认模型只接受 capability 与 modelId。');
    }
    const capability = text(body.capability, 'capability', 80);
    if (!SUPPORTED_CAPABILITIES.has(capability)) {
      fail('MODEL_NOT_CONFIGURED', `能力 ${capability} 尚未接入执行器。`);
    }
    const modelIdValue = text(body.modelId, 'modelId', 200);
    const model = await this.assertExecutable(modelIdValue, capability);
    const updated = await this.store.setDefault(capability, model.id);
    return { default: updated };
  }

  async setAlias(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['alias', 'modelId'].includes(key))) {
      fail('INVALID_FIELD', '别名只接受 alias 与 modelId。');
    }
    if (typeof body.alias !== 'string' || !ALIAS_PATTERN.test(body.alias)) {
      fail('INVALID_ALIAS', '别名需为 2–40 位小写字母、数字或连字符，并以字母开头。');
    }
    const modelIdValue = text(body.modelId, 'modelId', 200);
    const model = await this.assertExecutable(modelIdValue);
    const updated = await this.store.setAlias(body.alias, model.id);
    return { alias: updated };
  }

  async registry() {
    const [models, defaults, aliases] = await Promise.all([
      this.store.listModels(), this.store.listDefaults(), this.store.listAliases(),
    ]);
    return {
      models,
      defaults,
      aliases,
      capabilities: [...SUPPORTED_CAPABILITIES],
    };
  }

  async getCall(id) {
    const call = await this.store.getCall(id);
    return call ? publicCall(call) : null;
  }
}
