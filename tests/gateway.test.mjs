import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError } from '../server/errors.mjs';
import { DeepSeekProvider } from '../server/providers/deepseek.mjs';
import { ModelGateway } from '../server/gateway.mjs';
import { createServer } from '../server/http.mjs';

const KEY = 'sk-test-only-gateway-secret';
const TEXT_MODEL = 'deepseek:deepseek-flash';
const PROVIDERS = [{
  id: 'deepseek',
  name: 'DeepSeek',
  adapter: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  enabled: true,
  models: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      capabilities: ['text.chat'],
      parameters: { contextWindow: 1000000 },
    },
    {
      id: 'catalog-only',
      name: 'Catalog only',
      capabilities: ['text.chat'],
      executable: false,
    },
    {
      id: 'disabled-model',
      name: 'Disabled',
      capabilities: ['text.chat'],
      enabled: false,
    },
  ],
}];

class MemoryStore {
  models = new Map();
  defaults = new Map();
  aliases = new Map();
  calls = new Map();
  byKey = new Map();

  async init() {}

  async upsertModel(model) {
    const existing = this.models.get(model.id);
    // Mirror the SQL: catalog sync updates definitions, never admin enablement.
    const row = {
      ...model,
      enabled: existing ? existing.enabled : model.enabled,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    };
    this.models.set(model.id, row);
    return row;
  }

  async listModels() { return [...this.models.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async getModel(id) { return this.models.get(id) || null; }
  async listDefaults() { return [...this.defaults.values()]; }
  async getDefault(capability) { return this.defaults.get(capability) || null; }

  async setDefault(capability, modelId) {
    const row = { capability, modelId, updatedAt: new Date() };
    this.defaults.set(capability, row);
    return row;
  }

  async listAliases() { return [...this.aliases.values()]; }
  async getAlias(alias) { return this.aliases.get(alias) || null; }

  async setAlias(alias, modelId) {
    const row = { alias, modelId, createdAt: new Date(), updatedAt: new Date() };
    this.aliases.set(alias, row);
    return row;
  }

  async beginCall(call) {
    const existing = this.byKey.get(call.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== call.requestHash) {
        throw new AppError('REQUEST_CONFLICT', '同一幂等键不能用于不同参数。', 409);
      }
      return { call: { ...existing }, created: false };
    }
    const row = {
      ...call,
      modelId: null,
      status: 'running',
      response: null,
      usage: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.calls.set(row.id, row);
    this.byKey.set(row.idempotencyKey, row);
    return { call: { ...row }, created: true };
  }

  async updateCall(id, patch) {
    const row = this.calls.get(id);
    Object.assign(row, patch, { updatedAt: new Date() });
    return { ...row };
  }

  async getCall(id) { return this.calls.get(id) || null; }
}

function fixture({ chat } = {}) {
  const store = new MemoryStore();
  let calls = 0;
  const adapter = {
    async chat(args) {
      calls++;
      if (chat) return chat(args);
      return {
        content: 'OK',
        finishReason: 'stop',
        upstreamModel: args.upstreamModel,
        usage: { promptTokens: 7, completionTokens: 1, totalTokens: 8 },
      };
    },
  };
  const gateway = new ModelGateway(store, PROVIDERS, { deepseek: () => adapter });
  return { store, gateway, calls: () => calls };
}

function invokeBody(patch = {}) {
  return {
    idempotencyKey: randomUUID(),
    capability: 'text.chat',
    messages: [{ role: 'user', content: '回复 OK' }],
    thinking: false,
    maxTokens: 16,
    ...patch,
  };
}

test('unconfigured model fails explicitly without contacting an upstream', async () => {
  const f = fixture();
  await f.gateway.init();
  const { call } = await f.gateway.invoke(invokeBody());
  assert.equal(call.status, 'failed');
  assert.equal(call.error.code, 'MODEL_NOT_CONFIGURED');
  assert.match(call.error.message, /默认模型未配置/);
  assert.equal(f.calls(), 0);
});

test('default model resolution, usage recording and idempotent replay', async () => {
  const f = fixture();
  await f.gateway.init();
  const configured = await f.gateway.setDefault({ capability: 'text.chat', modelId: TEXT_MODEL });
  assert.equal(configured.default.modelId, TEXT_MODEL);

  const body = invokeBody();
  const first = (await f.gateway.invoke(body)).call;
  assert.equal(first.status, 'succeeded');
  assert.equal(first.modelId, TEXT_MODEL);
  assert.equal(first.result, 'OK');
  assert.deepEqual(first.usage, { promptTokens: 7, completionTokens: 1, totalTokens: 8 });
  assert.equal(f.calls(), 1);

  const replay = (await f.gateway.invoke(body)).call;
  assert.equal(replay.id, first.id);
  assert.equal(replay.result, 'OK');
  assert.equal(f.calls(), 1);

  await assert.rejects(
    f.gateway.invoke({ ...body, messages: [{ role: 'user', content: '不同请求' }] }),
    { code: 'REQUEST_CONFLICT', status: 409 },
  );
  assert.equal(f.calls(), 1);
});

test('explicit model wins over alias/default and aliases resolve to the recorded model', async () => {
  const f = fixture();
  await f.gateway.init();
  await f.gateway.setDefault({ capability: 'text.chat', modelId: TEXT_MODEL });
  await f.gateway.setAlias({ alias: 'fast-text', modelId: TEXT_MODEL });

  const byDefault = (await f.gateway.invoke(invokeBody())).call;
  assert.equal(byDefault.modelId, TEXT_MODEL);
  const byAlias = (await f.gateway.invoke(invokeBody({ alias: 'fast-text' }))).call;
  assert.equal(byAlias.modelId, TEXT_MODEL);
  assert.equal(byAlias.alias, 'fast-text');
  const byModel = (await f.gateway.invoke(invokeBody({ modelId: TEXT_MODEL }))).call;
  assert.equal(byModel.modelId, TEXT_MODEL);
  assert.equal(f.calls(), 3);

  await assert.rejects(
    f.gateway.invoke(invokeBody({ modelId: TEXT_MODEL, alias: 'fast-text' })),
    { code: 'INVALID_SELECTION' },
  );
});

test('disabled and catalog-only models are rejected before any upstream call', async () => {
  const f = fixture();
  await f.gateway.init();
  await assert.rejects(
    f.gateway.setDefault({ capability: 'text.chat', modelId: 'deepseek:disabled-model' }),
    { code: 'MODEL_DISABLED' },
  );
  await assert.rejects(
    f.gateway.setDefault({ capability: 'text.chat', modelId: 'deepseek:catalog-only' }),
    { code: 'MODEL_NOT_EXECUTABLE' },
  );
  const disabled = (await f.gateway.invoke(invokeBody({ modelId: 'deepseek:disabled-model' }))).call;
  assert.equal(disabled.error.code, 'MODEL_DISABLED');
  const catalog = (await f.gateway.invoke(invokeBody({ modelId: 'deepseek:catalog-only' }))).call;
  assert.equal(catalog.error.code, 'MODEL_NOT_EXECUTABLE');
  assert.equal(f.calls(), 0);
});

test('gateway records only safe errors; registry and call JSON never contain the key', async () => {
  const f = fixture({ chat() { throw Error(`private upstream said ${KEY}`); } });
  await f.gateway.init();
  await f.gateway.setDefault({ capability: 'text.chat', modelId: TEXT_MODEL });
  const call = (await f.gateway.invoke(invokeBody())).call;
  assert.equal(call.status, 'failed');
  assert.equal(call.error.code, 'SERVICE_ERROR');
  assert.equal(JSON.stringify(call).includes(KEY), false);
  assert.equal(JSON.stringify(await f.gateway.registry()).includes(KEY), false);
  assert.equal(JSON.stringify(await f.gateway.getCall(call.id)).includes(KEY), false);
});

test('DeepSeek adapter uses the documented chat endpoint and records usage', async () => {
  let seen;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      model: 'deepseek-flash',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 2,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new DeepSeekProvider({
      id: 'deepseek',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    }, { DEEPSEEK_API_KEY: KEY });
    const result = await provider.chat({
      upstreamModel: 'deepseek-flash',
      messages: [{ role: 'user', content: '回复 OK' }],
      thinking: false,
      maxTokens: 16,
    });
    assert.equal(seen.url, '/chat/completions');
    assert.equal(seen.authorization, `Bearer ${KEY}`);
    assert.equal(seen.body.model, 'deepseek-flash');
    assert.equal(seen.body.stream, false);
    assert.deepEqual(seen.body.thinking, { type: 'disabled' });
    assert.equal(result.content, 'OK');
    assert.equal(result.upstreamModel, 'deepseek-flash');
    assert.deepEqual(result.usage, {
      promptTokens: 11, completionTokens: 2, totalTokens: 13,
      cachedTokens: 3, reasoningTokens: 0,
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('DeepSeek adapter does not echo an upstream error body or the key', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `invalid key ${KEY}` } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new DeepSeekProvider({
      id: 'deepseek',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    }, { DEEPSEEK_API_KEY: KEY });
    await assert.rejects(provider.chat({
      upstreamModel: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }],
    }), error => {
      assert.equal(error.code, 'UPSTREAM_HTTP');
      assert.equal(error.message.includes(KEY), false);
      assert.equal(error.message.includes('invalid key'), false);
      return true;
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('model routes require the page token and expose registry, defaults, calls without keys', async t => {
  const f = fixture();
  await f.gateway.init();
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    gateway: f.gateway, port: 0, root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  const registryResponse = await fetch(base + '/api/models/registry');
  assert.equal(registryResponse.status, 200);
  const registry = await registryResponse.json();
  assert.ok(registry.models.some(model => model.id === TEXT_MODEL));
  assert.deepEqual(registry.capabilities, ['text.chat']);
  assert.equal(JSON.stringify(registry).includes(KEY), false);

  const noToken = await fetch(base + '/api/model-gateway/invoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invokeBody()),
  });
  assert.equal(noToken.status, 403);

  const body = invokeBody();
  const notConfigured = await fetch(base + '/api/model-gateway/invoke', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  assert.equal(notConfigured.status, 422);
  const notConfiguredBody = await notConfigured.json();
  assert.equal(notConfiguredBody.error.code, 'MODEL_NOT_CONFIGURED');

  const defaultResponse = await fetch(base + '/api/model-defaults', {
    method: 'POST', headers, body: JSON.stringify({ capability: 'text.chat', modelId: TEXT_MODEL }),
  });
  assert.equal(defaultResponse.status, 200);

  // The same key still replays the original "not configured" failure rather
  // than silently executing after configuration changed.
  const replayFailure = await fetch(base + '/api/model-gateway/invoke', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  assert.equal(replayFailure.status, 422);

  const successBody = invokeBody();
  const invokeResponse = await fetch(base + '/api/model-gateway/invoke', {
    method: 'POST', headers, body: JSON.stringify(successBody),
  });
  assert.equal(invokeResponse.status, 200);
  const invoked = await invokeResponse.json();
  assert.equal(invoked.call.status, 'succeeded');
  assert.equal(invoked.call.result, 'OK');
  assert.equal(JSON.stringify(invoked).includes(KEY), false);

  const callResponse = await fetch(base + `/api/model-calls/${invoked.call.id}`);
  assert.equal(callResponse.status, 200);
  const stored = await callResponse.json();
  assert.equal(stored.call.usage.totalTokens, 8);

  const conflict = await fetch(base + '/api/model-gateway/invoke', {
    method: 'POST', headers, body: JSON.stringify({ ...body, messages: [{ role: 'user', content: 'changed' }] }),
  });
  assert.equal(conflict.status, 409);

  const badId = await fetch(base + '/api/model-calls/not-a-uuid');
  assert.equal(badId.status, 422);
  const missing = await fetch(base + `/api/model-calls/${randomUUID()}`);
  assert.equal(missing.status, 404);
});
