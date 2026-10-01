import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  normalizeBaseUrl, encryptSecret, decryptSecret,
} from '../server/channels.mjs';
import { OpenAiCompatibleProvider, mediaKind } from '../server/providers/openai.mjs';
import { ProviderRegistry } from '../server/providers/registry.mjs';
import { ChannelManager } from '../server/channel-service.mjs';
import { GenerationService } from '../server/jobs.mjs';
import { createServer } from '../server/http.mjs';

test('base URLs are normalized and unsafe schemes are rejected', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/api'), 'https://api.example.com/api/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => normalizeBaseUrl('http://api.example.com'), { code: 'INVALID_BASE_URL' });
  assert.throws(() => normalizeBaseUrl('https://user:pass@api.example.com'), { code: 'INVALID_BASE_URL' });
  assert.throws(() => normalizeBaseUrl('https://api.example.com?key=1'), { code: 'INVALID_BASE_URL' });
});

test('channel secrets encrypt and decrypt with authenticated encryption', () => {
  const key = randomBytes(32);
  const encrypted = encryptSecret(key, 'sk-test-only-1234');
  assert.equal(decryptSecret(key, encrypted), 'sk-test-only-1234');
  assert.throws(() => decryptSecret(randomBytes(32), encrypted), { code: 'CHANNEL_KEY_UNREADABLE' });
  assert.equal(JSON.stringify(encrypted).includes('sk-test-only'), false);
});

test('model discovery classifies image/video and skips unrelated models', async () => {
  const calls = [];
  const provider = new OpenAiCompatibleProvider({
    id: 'p', name: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-only-1234',
  }, {}, async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ data: [
      { id: 'gpt-image-1', object: 'model' },
      { id: 'sora-2', object: 'model' },
      { id: 'flux-pro', object: 'model' },
      { id: 'text-embedding-3-large', object: 'model' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const models = await provider.catalog();
  assert.equal(calls[0].url, 'https://api.example.com/v1/models');
  assert.equal(calls[0].authorization, 'Bearer sk-test-only-1234');
  assert.deepEqual(models.map(model => model.id), ['p:gpt-image-1', 'p:sora-2', 'p:flux-pro']);
  assert.equal(models[0].kind, 'image');
  assert.equal(models[0].executable, true);
  assert.equal(models[0].flexibleSize, true);
  assert.equal(models[1].kind, 'video');
  assert.equal(models[1].executable, false);
  assert.deepEqual(models[1].operations, []);
  assert.equal(mediaKind('veo-3'), 'video');
  assert.equal(mediaKind('nano-banana'), 'image');
  assert.equal(mediaKind('gpt-4o'), 'other');
});

test('OpenAI-compatible image generation stores a temporary result and never places the key in job input', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nX0AAAAASUVORK5CYII=', 'base64');
  let sent;
  const provider = new OpenAiCompatibleProvider({
    id: 'p', name: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-only-1234',
  }, {}, async (url, options) => {
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await provider.catalog();
  const job = {
    id: '00000000-0000-4000-8000-000000000001',
    input: { upstreamModel: 'gpt-image-1', prompt: 'white box', size: '1024x1024', quality: 'low', operation: 'generate' },
  };
  const submitted = await provider.submit(job);
  assert.equal(sent.model, 'gpt-image-1');
  assert.equal(sent.prompt, 'white box');
  assert.equal(JSON.stringify(job).includes('sk-test-only'), false);
  const result = await provider.poll(submitted.job_id);
  assert.equal(result.status, 'succeeded');
  const data = await provider.download(result.download_url);
  assert.deepEqual(data, png);
  assert.equal((await provider.poll('missing')).status, 'unknown');
});

test('a discovered OpenAI-compatible image model runs through the normal job pipeline', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nX0AAAAASUVORK5CYII=', 'base64');
  const provider = new OpenAiCompatibleProvider({
    id: 'p', name: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-only-1234',
  }, {}, async url => {
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const [model] = await provider.catalog();
  const rows = new Map();
  const store = {
    async get(id) { return rows.get(id) || null; },
    async list() { return [...rows.values()]; },
    async insert(job) { const row = { ...job, status: 'queued', createdAt: new Date() }; rows.set(job.id, row); return row; },
    async update(id, patch) { Object.assign(rows.get(id), patch); return rows.get(id); },
    async claim() { const job = [...rows.values()].find(j => j.status === 'queued'); if (job) job.status = 'submitting'; return job; },
  };
  let saved = null;
  const assets = { async put(id, data) { saved = data; return { key: `generation/${id}/result.png`, contentType: 'image/png' }; } };
  const registry = {
    providers: new Map([['p', provider]]),
    async refreshProvider() {},
    async resolve() { return model; },
  };
  const service = new GenerationService(store, assets, registry);
  const requestId = '00000000-0000-4000-8000-000000000002';
  const job = await service.create({
    requestId, modelId: model.id, prompt: 'white box', size: '3840x2160', quality: 'low', operation: 'generate',
  });
  await service.tick();
  assert.equal(rows.get(requestId).status, 'succeeded');
  assert.deepEqual(saved, png);
  assert.equal(JSON.stringify(job).includes('sk-test-only'), false);
});

test('channel manager tests the key first, stores only a hint and never returns the key', async () => {
  class MemoryStore {
    rows = new Map();
    public(row) {
      const { apiKey, ...rest } = row;
      return { ...rest, source: 'database', deletable: true };
    }
    async insert({ id, name, baseUrl, apiKey }) {
      const row = { id, name, baseUrl, apiKey, keyHint: '••••' + apiKey.slice(-4), enabled: true };
      this.rows.set(id, row);
      return this.public(row);
    }
    async getSecret(id) {
      const row = this.rows.get(id);
      return row ? { ...this.public(row), apiKey: row.apiKey } : null;
    }
    async get(id) { const row = this.rows.get(id); return row ? this.public(row) : null; }
    async remove(id) { const row = this.rows.get(id); this.rows.delete(id); return row ? this.public(row) : null; }
    async setEnabled(id, enabled) { const row = this.rows.get(id); row.enabled = enabled; return this.public(row); }
  }
  const store = new MemoryStore();
  const added = [];
  const removed = [];
  const registry = {
    addProvider(config) { added.push(config); },
    removeProvider(id) { removed.push(id); },
    async refreshProvider() { return {}; },
  };
  const fakeModel = {
    id: 'ch_test:gpt-image-1', providerId: 'ch_test', upstreamModel: 'gpt-image-1',
    kind: 'image', executable: true, operations: ['generate'], sizes: ['1024x1024'], qualities: ['low'],
  };
  const manager = new ChannelManager(store, registry, () => ({ async catalog() { return [fakeModel]; } }));
  const result = await manager.add({ name: 'Example', baseUrl: 'https://api.example.com', apiKey: 'sk-test-only-1234' });
  assert.match(result.channel.id, /^ch_[0-9a-f]{16}$/);
  assert.equal(result.channel.keyHint, '••••1234');
  assert.equal(Object.hasOwn(result.channel, 'apiKey'), false);
  assert.equal(added[0].apiKey, 'sk-test-only-1234');
  assert.equal(store.rows.size, 1);
  const disabled = await manager.setEnabled(result.channel.id, false);
  assert.equal(disabled.enabled, false);
  assert.equal(added[added.length - 1].enabled, false);
  await manager.remove(result.channel.id);
  assert.equal(store.rows.size, 0);
  assert.deepEqual(removed, [result.channel.id, result.channel.id]);
});

test('disabled channels remain visible without publishing models', async () => {
  let catalogCalls = 0;
  const registry = new ProviderRegistry({ providers: [] }, {
    fake: config => ({
      config,
      async catalog() { catalogCalls++; return [{ id: `${config.id}:image`, providerId: config.id, kind: 'image', operations: ['generate'], sizes: ['1024x1024'], qualities: ['low'], executable: true }]; },
    }),
  });
  registry.addProvider({ id: 'off', name: 'Off', adapter: 'fake', enabled: false });
  const catalog = await registry.refresh();
  assert.equal(catalogCalls, 0);
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.providers[0].enabled, false);
  assert.equal(catalog.providers[0].connected, false);
});

test('a failed connection test does not persist a channel', async () => {
  const store = {
    rows: 0,
    async insert() { this.rows++; return {}; },
  };
  const registry = { addProvider() {}, removeProvider() {}, async refreshProvider() {} };
  const manager = new ChannelManager(store, registry, () => ({
    async catalog() { throw new Error('upstream unavailable'); },
  }));
  await assert.rejects(
    manager.add({ name: 'Bad', baseUrl: 'https://api.example.com', apiKey: 'sk-test-only-1234' }),
    { code: 'CHANNEL_TEST_FAILED' },
  );
  assert.equal(store.rows, 0);
});

test('channel endpoints require the page token, including DELETE', async t => {
  const channels = {
    async add(body) { return { channel: { id: 'ch_0123456789abcdef', name: body.name }, models: [] }; },
    async remove(id) { return { id }; },
    async setEnabled(id, enabled) { return { id, enabled }; },
  };
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels, port: 0, root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const body = JSON.stringify({ name: 'Example', baseUrl: 'https://api.example.com', apiKey: 'sk-test-only-1234' });
  assert.equal((await fetch(base + '/api/channels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  })).status, 403);
  assert.equal((await fetch(base + '/api/channels/ch_0123456789abcdef', { method: 'DELETE' })).status, 403);
  const created = await fetch(base + '/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body,
  });
  assert.equal(created.status, 201);
  const removed = await fetch(base + '/api/channels/ch_0123456789abcdef', {
    method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken },
  });
  assert.equal(removed.status, 200);
});
