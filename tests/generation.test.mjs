import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { GenerationService, normalize, publicJob } from '../server/jobs.mjs';
import { ProviderRegistry } from '../server/providers/registry.mjs';
import { OmyaiProvider, parseRpc } from '../server/providers/omyai.mjs';
import { imageType } from '../server/store.mjs';
import { createServer } from '../server/http.mjs';

const model = {
  id: 'test:image', providerId: 'test', upstreamModel: 'image', kind: 'image',
  operations: ['generate', 'edit'], sizes: ['1024x1024'], qualities: ['low'],
};
const request = (patch = {}) => ({
  requestId: randomUUID(), modelId: model.id, prompt: 'A white storage box',
  size: '1024x1024', quality: 'low', operation: 'generate', ...patch,
});

class MemoryStore {
  rows = new Map();
  async get(id) { return this.rows.get(id) || null; }
  async list() { return [...this.rows.values()]; }
  async insert(job) {
    if (this.rows.has(job.id)) return this.rows.get(job.id);
    const row = { ...job, status: 'queued', createdAt: new Date(), updatedAt: new Date() };
    this.rows.set(row.id, row);
    return row;
  }
  async update(id, patch) {
    Object.assign(this.rows.get(id), patch, { updatedAt: new Date() });
    return this.rows.get(id);
  }
  async claim() {
    const job = [...this.rows.values()].find(j => j.status === 'queued');
    if (job) job.status = 'submitting';
    return job;
  }
}

function fixture(providerOverrides = {}, assetsOverrides = {}) {
  const store = new MemoryStore();
  let submissions = 0;
  const upstreamId = randomUUID();
  const provider = {
    async submit() { submissions++; return { job_id: upstreamId }; },
    async poll() { return { status: 'succeeded', download_url: 'https://assets.test/image.png' }; },
    async download() { return Buffer.from([137,80,78,71,13,10,26,10]); },
    ...providerOverrides,
  };
  const registry = {
    providers: new Map([['test', provider]]),
    async resolve(id) { assert.equal(id, model.id); return model; },
  };
  const assets = { async put() { return { key: 'private/image.png', contentType: 'image/png' }; }, ...assetsOverrides };
  return { store, provider, registry, assets, service: new GenerationService(store, assets, registry), submissions: () => submissions };
}

test('same request returns original job; changed payload conflicts, no duplicate upstream charge', async () => {
  const f = fixture();
  const body = request();
  const first = await f.service.create(body);
  const second = await f.service.create(body);
  assert.equal(first.id, second.id);
  await assert.rejects(f.service.create({ ...body, prompt: 'different' }), { code: 'REQUEST_CONFLICT' });
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.submissions(), 1);
  assert.equal((await f.store.get(first.id)).status, 'succeeded');
});

test('new jobs refresh the selected channel model list before resolving the model', async () => {
  const f = fixture();
  let refreshed = '';
  f.registry.refreshProvider = async id => { refreshed = id; };
  await f.service.create(request());
  assert.equal(refreshed, 'test');
});

test('unsupported capabilities are rejected before any submission', async () => {
  const f = fixture();
  await assert.rejects(f.service.create(request({ size: '4096x4096' })), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(f.service.create(request({ operation: 'video' })), { code: 'INVALID_OPERATION' });
  await assert.rejects(f.service.create(request({ extra: 'field' })), { code: 'INVALID_FIELD' });
  assert.equal(f.submissions(), 0);
});

test('submission interruption remains unknown and is not auto-retried', async () => {
  let count = 0;
  const f = fixture({ async submit() { count++; throw new Error('private upstream credential must not leak'); } });
  const job = await f.service.create(request());
  await f.service.tick();
  await f.service.tick();
  assert.equal(count, 1);
  assert.equal(job.status, 'unknown');
  assert.equal(JSON.stringify(publicJob(job)).includes('private upstream'), false);
});

test('storage failure retains upstream ID and does not call generate again on recovery', async () => {
  let saves = 0;
  const f = fixture({}, { async put() { if (++saves === 1) throw Error('storage unavailable'); return { key: 'saved' }; } });
  const job = await f.service.create(request());
  await f.service.tick();
  assert.equal(job.status, 'unknown');
  assert.ok(job.upstreamId);
  await f.service.run(job);
  assert.equal(job.status, 'succeeded');
  assert.equal(f.submissions(), 1);
});

test('editing only accepts successful same-provider unexpired source images', async () => {
  const f = fixture();
  const source = await f.service.create(request());
  await assert.rejects(f.service.create(request({ operation: 'edit', sourceJobId: source.id })), { code: 'INVALID_SOURCE' });
  await f.service.tick();
  const edit = await f.service.create(request({ operation: 'edit', sourceJobId: source.id }));
  assert.equal(edit.input.sourceUpstreamId, source.upstreamId);
  source.createdAt = new Date(Date.now() - 24 * 3600_000);
  await assert.rejects(f.service.create(request({ operation: 'edit', sourceJobId: source.id })), { code: 'SOURCE_EXPIRED' });
});

test('expired idempotency window forbids resubmitting ambiguous job', async () => {
  const f = fixture();
  const job = await f.service.create(request());
  await f.store.update(job.id, { status: 'unknown' });
  job.createdAt = new Date(Date.now() - 7 * 86400_000);
  await assert.rejects(f.service.reconcile(job.id), { code: 'DEDUPE_EXPIRED' });
  assert.equal(f.submissions(), 0);
});

test('failed upstream generation is terminal; polling is not a new submission', async () => {
  const f = fixture({ async poll() { return { status: 'failed', error: 'sensitive upstream details' }; } });
  const job = await f.service.create(request());
  await f.service.tick();
  await f.service.tick();
  assert.equal(job.status, 'failed');
  assert.equal(f.submissions(), 1);
  assert.equal(JSON.stringify(publicJob(job)).includes('sensitive'), false);
});

test('adapter forwards original source image ID and exact idempotency key for edits', async () => {
  let sent;
  const adapter = new OmyaiProvider({ id: 'p', endpoint: 'https://example.test/mcp', apiKeyEnv: 'TEST_KEY' }, { TEST_KEY: 'test-only' }, async (_, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ job_id: randomUUID() }) }] } }));
  });
  const input = { prompt: 'change background, keep product', upstreamModel: 'm', quality: 'low', size: '1024x1024', operation: 'edit', sourceUpstreamId: randomUUID() };
  const id = randomUUID();
  await adapter.submit({ id, input });
  assert.equal(sent.params.name, 'edit_image');
  assert.equal(sent.params.arguments.source_job_id, input.sourceUpstreamId);
  assert.equal(sent.params.arguments.request_id, id);
});

test('download blocks unknown hosts, credentials in URLs and non-HTTPS before network access', async () => {
  let requests = 0;
  const adapter = new OmyaiProvider({ assetHosts: ['omyai.vip'] }, {}, async () => { requests++; });
  for (const url of ['http://omyai.vip/image', 'https://127.0.0.1/image', 'https://secret@omyai.vip/image', 'https://omyai.vip:9000/image']) {
    await assert.rejects(adapter.download(url), { code: 'ASSET_HOST_BLOCKED' });
  }
  assert.equal(requests, 0);
});

test('registry isolates provider failure and uses unique provider:model IDs', async () => {
  const registry = new ProviderRegistry({ providers: [
    { id: 'a', enabled: true, adapter: 'fake' }, { id: 'b', enabled: true, adapter: 'fake' },
  ] }, { fake: config => ({
    config, async catalog() { if (config.id === 'b') throw Error('down'); return [{ ...model, id: 'a:image' }]; },
  }) });
  const catalog = await registry.refresh();
  assert.deepEqual(catalog.models.map(m => m.id), ['a:image']);
  assert.equal(catalog.providers[1].connected, false);
});

test('JSON / SSE responses and image signature validation', () => {
  assert.equal(parseRpc('data: {"jsonrpc":"2.0","result":{"ok":true}}\n\n').result.ok, true);
  assert.equal(parseRpc('{"result":{"ok":true}}').result.ok, true);
  assert.throws(() => imageType(Buffer.from('<html>not an image</html>')), { code: 'INVALID_IMAGE' });
  assert.equal(normalize(request()).input.prompt, 'A white storage box');
});

test('HTTP blocks secrets, traversal, cross-origin requests and unauthenticated mutation', async t => {
  const f = fixture();
  const server = createServer({ ...f, port: 0, root: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {};
  for (const path of ['/.env.models.local','/.secrets/server.json','/server/index.mjs','/prototype/../.env.middleware.local']) {
    assert.equal((await fetch(base + path, { headers })).status, 404);
  }
  assert.equal((await fetch(base + '/api/session', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/session', { headers: { Host: 'evil.test' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers, body: '{}' })).status, 403);
  const session = await (await fetch(base + '/api/session', { headers })).json();
  const createHeaders = { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
  const body = request();
  const first = await fetch(base + '/api/jobs', { method: 'POST', headers: createHeaders, body: JSON.stringify(body) });
  assert.equal(first.status, 202);
  const retry = await (await fetch(base + '/api/jobs', { method: 'POST', headers: createHeaders, body: JSON.stringify(body) })).json();
  assert.equal(retry.id, body.requestId);
});
