import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { GenerationService } from '../server/jobs.mjs';
import { AppError } from '../server/errors.mjs';
import {
  MAX_IMAGE_INPUT_BYTES, OpenAiCompatibleProvider,
} from '../server/providers/openai.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nX0AAAAASUVORK5CYII=',
  'base64',
);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);
const officialConfig = () => ({
  id: 'omyai-openai',
  name: 'OMYAI（OpenAI 标准）',
  adapter: 'openai-compatible',
  baseUrl: 'https://omyai.vip/v1',
  apiKeyEnv: 'OMYAI_API_KEY',
  enabled: true,
  defaultModel: 'gpt-image-2.5-flare',
  editTransport: 'json-data-url',
});
const environment = { OMYAI_API_KEY: 'sk-test-only-official' };
const model = {
  id: 'p:gpt-image-2.5-flare', providerId: 'p', upstreamModel: 'gpt-image-2.5-flare',
  kind: 'image', operations: ['generate', 'edit'], sizes: ['1024x1024'],
  qualities: ['low'], flexibleSize: false,
};
const request = (patch = {}) => ({
  requestId: randomUUID(), modelId: model.id, prompt: 'A white storage box',
  size: '1024x1024', quality: 'low', operation: 'generate', ...patch,
});

function catalogResponse(ids = ['gpt-image-2.5-flare', 'sora-2', 'text-embedding-3-large']) {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id, object: 'model' })) }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function imageResponse(data = PNG) {
  return new Response(JSON.stringify({ data: [{ b64_json: data.toString('base64') }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

class MemoryStore {
  rows = new Map();
  async get(id) { return this.rows.get(id) || null; }
  async list() { return [...this.rows.values()]; }
  async insert(job) {
    if (this.rows.has(job.id)) return this.rows.get(job.id);
    const row = {
      ...job, status: job.status || 'queued',
      createdAt: job.createdAt || new Date(), updatedAt: new Date(),
    };
    this.rows.set(row.id, row);
    return row;
  }
  async update(id, patch) {
    Object.assign(this.rows.get(id), patch, { updatedAt: new Date() });
    return this.rows.get(id);
  }
  async claim() {
    const job = [...this.rows.values()].find(item => item.status === 'queued');
    if (!job) return null;
    job.status = 'submitting';
    // Postgres returns a fresh row object; cloning keeps transient source buffers out
    // of the stored JSONB input, matching the real store.
    return structuredClone(job);
  }
}

function serviceFixture({ supportsImageInput = true, imageInput, providerOverrides = {}, assetsOverrides = {} } = {}) {
  const store = new MemoryStore();
  const calls = { submissions: [], puts: [], polls: 0 };
  const provider = {
    supportsImageInput,
    async submit(job) {
      calls.submissions.push(job);
      return { job_id: randomUUID(), result: { data: PNG } };
    },
    async poll() {
      calls.polls += 1;
      return { status: 'unknown' };
    },
    async download() { throw new Error('download should not be needed for synchronous results'); },
    ...providerOverrides,
  };
  const registry = {
    providers: new Map([['p', provider]]),
    async refreshProvider() {},
    async resolve() { return model; },
  };
  const assets = {
    objects: new Map(),
    async put(id, data) {
      calls.puts.push({ id, data });
      this.objects.set(id, data);
      return { key: `generation/${id}/result.png`, contentType: 'image/png', filename: `${id}.png` };
    },
    async get(output) {
      const data = this.objects.get(output.key);
      if (!data) throw new Error('missing source object');
      return Readable.from([data]);
    },
    ...assetsOverrides,
  };
  const service = new GenerationService(store, assets, registry, { imageInput });
  return { store, provider, registry, assets, service, calls };
}

function originalImage(image = {}) {
  return {
    id: image.id || randomUUID(),
    kind: 'original',
    workspaceId: 'local',
    contentType: 'image/png',
    extension: 'png',
    ...image,
  };
}

function imageInputOf(image, bytes = PNG) {
  return {
    async get(id) { return id === image.id ? { ...image } : null; },
    async open(id) {
      if (id !== image.id) throw Object.assign(new Error('missing'), { code: 'IMAGE_NOT_FOUND' });
      return { image: { ...image }, stream: Readable.from([bytes]) };
    },
  };
}

test('static config keeps the official channel enabled and the MCP channel disabled', () => {
  const config = JSON.parse(readFileSync(new URL('../config/providers.json', import.meta.url), 'utf8'));
  const official = config.providers.find(item => item.id === 'omyai-openai');
  assert.deepEqual(official, {
    id: 'omyai-openai',
    name: 'OMYAI（OpenAI 标准）',
    adapter: 'openai-compatible',
    baseUrl: 'https://omyai.vip/v1',
    apiKeyEnv: 'OMYAI_API_KEY',
    enabled: true,
    assetHosts: ['omyai.vip'],
    defaultModel: 'gpt-image-2.5-flare',
    editTransport: 'json-data-url',
  });
  const legacy = config.providers.find(item => item.id === 'omyai');
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.adapter, 'omyai-mcp');
});

test('official channel discovers gpt-image models as executable generate/edit models', async () => {
  const provider = new OpenAiCompatibleProvider(officialConfig(), environment, async (url, options) => {
    assert.equal(url, 'https://omyai.vip/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer sk-test-only-official');
    return catalogResponse();
  });
  const models = await provider.catalog();
  assert.deepEqual(models.map(item => item.id), ['omyai-openai:gpt-image-2.5-flare', 'omyai-openai:sora-2']);
  const image = models[0];
  assert.equal(image.kind, 'image');
  assert.equal(image.executable, true);
  assert.deepEqual(image.operations, ['generate', 'edit']);
  assert.equal(image.default, true);
  assert.equal(models[1].kind, 'video');
  assert.equal(models[1].executable, false);
  assert.deepEqual(models[1].operations, []);
  assert.equal(JSON.stringify(models).includes('sk-test-only-official'), false);
});

test('generate uses the verified JSON body and returns b64_json as a persistable buffer', async () => {
  let sent;
  const provider = new OpenAiCompatibleProvider(officialConfig(), environment, async (url, options) => {
    if (url.endsWith('/models')) return catalogResponse(['gpt-image-2.5-flare']);
    assert.equal(url, 'https://omyai.vip/v1/images/generations');
    sent = JSON.parse(options.body);
    return imageResponse();
  });
  await provider.catalog();
  const submitted = await provider.submit({
    id: randomUUID(),
    input: { upstreamModel: 'gpt-image-2.5-flare', prompt: 'white box', size: '1024x1024', quality: 'low', operation: 'generate' },
  });
  assert.deepEqual(sent, {
    model: 'gpt-image-2.5-flare', prompt: 'white box', size: '1024x1024', quality: 'low', n: 1,
  });
  assert.deepEqual(submitted.result.data, PNG);
  assert.equal(submitted.result.bytes, PNG.length);
  assert.match(submitted.job_id, /^[0-9a-f-]{36}$/);
});

test('OMYAI edits send a JSON base64 data URL instead of multipart', async () => {
  let sent;
  let contentType;
  const provider = new OpenAiCompatibleProvider(officialConfig(), environment, async (url, options) => {
    if (url.endsWith('/models')) return catalogResponse(['gpt-image-2.5-flare']);
    assert.equal(url, 'https://omyai.vip/v1/images/edits');
    contentType = options.headers['Content-Type'] || options.headers['content-type'];
    sent = JSON.parse(options.body);
    return imageResponse(OTHER_PNG);
  });
  await provider.catalog();
  const submitted = await provider.submit({
    id: randomUUID(),
    input: {
      upstreamModel: 'gpt-image-2.5-flare', prompt: 'replace background', size: '1024x1024',
      quality: 'low', operation: 'edit',
      sourceImage: { data: PNG, contentType: 'image/png', filename: 'source.png' },
    },
  });
  assert.equal(contentType, 'application/json');
  assert.equal(sent.model, 'gpt-image-2.5-flare');
  assert.equal(sent.prompt, 'replace background');
  assert.equal(sent.size, '1024x1024');
  assert.match(sent.image, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(sent.image.split(',')[1], 'base64'), PNG);
  assert.equal(JSON.stringify(sent).includes('sk-test-only-official'), false);
  assert.deepEqual(submitted.result.data, OTHER_PNG);
});

test('other OpenAI-compatible channels fall back to standard multipart edits', async () => {
  let received;
  const provider = new OpenAiCompatibleProvider({
    id: 'ch_example', name: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-only-1234',
  }, {}, async (url, options) => {
    if (url.endsWith('/models')) return catalogResponse(['gpt-image-1']);
    assert.equal(url, 'https://api.example.com/v1/images/edits');
    assert.equal(options.headers['Content-Type'], undefined);
    received = options.body;
    return imageResponse();
  });
  await provider.catalog();
  const submitted = await provider.submit({
    id: randomUUID(),
    input: {
      upstreamModel: 'gpt-image-1', prompt: 'replace background', size: '1024x1024',
      quality: 'low', operation: 'edit',
      sourceImage: { data: PNG, contentType: 'image/png', filename: 'source.png' },
    },
  });
  assert.ok(received instanceof FormData);
  assert.equal(received.get('model'), 'gpt-image-1');
  assert.equal(received.get('prompt'), 'replace background');
  assert.equal(received.get('size'), '1024x1024');
  assert.equal(received.get('quality'), 'low');
  assert.equal(received.get('n'), '1');
  const file = received.get('image');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.deepEqual(submitted.result.data, PNG);
});

test('edits reject missing and oversized source images before any network call', async () => {
  let requests = 0;
  const provider = new OpenAiCompatibleProvider(officialConfig(), environment, async url => {
    requests += 1;
    return url.endsWith('/models') ? catalogResponse(['gpt-image-2.5-flare']) : imageResponse();
  });
  await provider.catalog();
  const base = {
    upstreamModel: 'gpt-image-2.5-flare', prompt: 'edit', size: '1024x1024',
    quality: 'low', operation: 'edit',
  };
  await assert.rejects(provider.submit({ id: randomUUID(), input: base }), { code: 'SOURCE_REQUIRED' });
  await assert.rejects(provider.submit({
    id: randomUUID(),
    input: { ...base, sourceImage: { data: Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1), contentType: 'image/png' } },
  }), { code: 'SOURCE_TOO_LARGE', status: 413 });
  assert.equal(requests, 1);
});

test('sourceAssetId is rejected for MCP channels, screenshots and unknown images', async () => {
  const image = originalImage();
  const unsupported = serviceFixture({ supportsImageInput: false, imageInput: imageInputOf(image) });
  await assert.rejects(
    unsupported.service.create(request({ sourceAssetId: image.id })),
    { code: 'UNSUPPORTED_CAPABILITY' },
  );
  assert.equal(unsupported.calls.submissions.length, 0);

  const screenshot = originalImage({ kind: 'screenshot' });
  const screenshotFixture = serviceFixture({ imageInput: imageInputOf(screenshot) });
  await assert.rejects(
    screenshotFixture.service.create(request({ sourceAssetId: screenshot.id })),
    { code: 'SCREENSHOT_NOT_INPUT' },
  );

  const missingFixture = serviceFixture({
    imageInput: { async get() { return null; }, async open() { throw new Error('unused'); } },
  });
  await assert.rejects(
    missingFixture.service.create(request({ sourceAssetId: randomUUID() })),
    { code: 'IMAGE_NOT_FOUND', status: 404 },
  );
  assert.equal(missingFixture.calls.submissions.length, 0);
});

test('product originals are read server-side and results persist immediately without polling', async () => {
  const image = originalImage();
  const f = serviceFixture({ imageInput: imageInputOf(image) });
  const job = await f.service.create(request({ operation: 'edit', sourceAssetId: image.id }));
  assert.equal(job.input.sourceAssetId, image.id);
  assert.equal(JSON.stringify(job).includes(PNG.toString('base64')), false);

  await f.service.tick();
  const stored = f.store.rows.get(job.id);
  assert.equal(stored.status, 'succeeded');
  assert.equal(f.calls.submissions.length, 1);
  assert.deepEqual(f.calls.submissions[0].input.sourceImage.data, PNG);
  assert.equal(f.calls.submissions[0].input.sourceImage.contentType, 'image/png');
  assert.deepEqual(f.calls.puts[0].data, PNG);
  assert.equal(f.calls.polls, 0);
  // The transient buffer must never be written into the job JSONB input.
  assert.equal(JSON.stringify(stored.input).includes('sourceImage'), false);
});

test('generated versions are re-uploaded from private MinIO and do not expire after 23 hours', async () => {
  const f = serviceFixture({ imageInput: { async get() { return null; }, async open() { throw new Error('unused'); } } });
  const sourceId = randomUUID();
  const source = await f.store.insert({
    id: sourceId, inputHash: 'source', input: { providerId: 'p', modelId: model.id },
    status: 'succeeded', upstreamId: randomUUID(),
    output: { key: 'source-key', contentType: 'image/png', filename: 'source.png' },
    createdAt: new Date(Date.now() - 48 * 3600_000),
  });
  f.assets.objects.set('source-key', OTHER_PNG);
  const edit = await f.service.create(request({ operation: 'edit', sourceJobId: source.id }));
  await f.service.tick();
  assert.equal(f.store.rows.get(edit.id).status, 'succeeded');
  assert.equal(f.calls.submissions.length, 1);
  assert.deepEqual(f.calls.submissions[0].input.sourceImage.data, OTHER_PNG);
  assert.equal(f.calls.submissions[0].input.sourceImage.contentType, 'image/png');
  assert.equal(f.calls.polls, 0);
});

test('storage failure stays unknown with the upstream id and never submits again', async () => {
  let puts = 0;
  const f = serviceFixture({
    providerOverrides: {
      async poll() { f.calls.polls += 1; return { status: 'succeeded', download_url: 'sj-result://original' }; },
      async download() { return PNG; },
    },
    assetsOverrides: {
      async put(id, data) {
        if (++puts === 1) throw new Error('storage unavailable');
        return { key: `generation/${id}/result.png`, contentType: 'image/png', filename: `${id}.png` };
      },
    },
  });
  const job = await f.service.create(request());
  await f.service.tick();
  const failed = f.store.rows.get(job.id);
  assert.equal(failed.status, 'unknown');
  assert.ok(failed.upstreamId);
  assert.equal(failed.input.modelId, model.id);
  assert.equal(f.calls.submissions.length, 1);

  await f.service.tick();
  assert.equal(f.calls.submissions.length, 1);
  await f.service.run(failed);
  assert.equal(f.calls.submissions.length, 1);
  assert.equal(f.store.rows.get(job.id).status, 'succeeded');
});

test('a definite upstream 4xx rejection is failed, not unknown, and is not retried', async () => {
  let attempts = 0;
  const f = serviceFixture({
    providerOverrides: {
      async submit() {
        attempts += 1;
        const error = new AppError('CHANNEL_HTTP', '渠道返回 HTTP 429。', 502);
        error.upstreamStatus = 429;
        throw error;
      },
    },
  });
  const job = await f.service.create(request());
  await f.service.tick();
  const row = f.store.rows.get(job.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error.code, 'CHANNEL_HTTP');
  assert.equal(row.upstreamId, null);
  assert.equal(attempts, 1);
  await f.service.tick();
  assert.equal(attempts, 1);
});

test('same request id is idempotent and a different payload conflicts without a second submission', async () => {
  const f = serviceFixture();
  const body = request();
  const first = await f.service.create(body);
  const second = await f.service.create(body);
  assert.equal(first.id, second.id);
  await assert.rejects(f.service.create({ ...body, prompt: 'different' }), { code: 'REQUEST_CONFLICT' });
  await f.service.tick();
  assert.equal(f.calls.submissions.length, 1);
});
