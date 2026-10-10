import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import {
  MAX_UPLOAD_BYTES,
  PRODUCT_IMAGE_BUCKET,
  PROVIDER_INPUT_CAPABILITIES,
  ProductImageApi,
  inspectImage,
  publicImage,
} from '../server/uploads.mjs';
import { createServer } from '../server/http.mjs';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PRODUCT_ID = '22222222-2222-4222-8222-222222222222';

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, checksum]);
}

function png(width = 64, height = 64, { colorType = 2, bitDepth = 8 } = {}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) raw[row * (rowBytes + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Header-only PNG for dimension-limit tests; the decoder rejects before inflating pixels.
function pngHeader(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg(width = 64, height = 64) {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0x12, 0x34, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function webp(width = 64, height = 64) {
  const payload = Buffer.alloc(6);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  const chunk = Buffer.alloc(8);
  chunk.write('VP8L', 0, 'ascii');
  chunk.writeUInt32LE(5, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk, payload]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

class MemoryRepository {
  constructor() {
    this.images = new Map();
    this.verifications = [];
    this.settings = null;
    this.failInsert = false;
  }

  async productExists(productId) {
    return productId === PRODUCT_ID;
  }

  async insert(image) {
    if (this.failInsert) throw new Error('insert failed');
    this.images.set(image.id, structuredClone(image));
    return structuredClone(image);
  }

  async get(id) {
    const row = this.images.get(id);
    return row ? structuredClone(row) : null;
  }

  async list({ productId, kind, limit, offset }) {
    let rows = [...this.images.values()];
    if (productId) rows = rows.filter(row => row.productId === productId);
    if (kind) rows = rows.filter(row => row.kind === kind);
    rows.sort((a, b) => (b.createdAt - a.createdAt) || a.id.localeCompare(b.id));
    return { images: rows.slice(offset, offset + limit).map(row => structuredClone(row)), total: rows.length };
  }

  async findVerification(providerId, protocol = null) {
    return this.verifications
      .filter(row => row.providerId === providerId && row.status === 'verified' &&
        (!protocol || row.protocol === protocol))
      .sort((a, b) => new Date(b.verifiedAt) - new Date(a.verifiedAt))[0] || null;
  }

  async getSettings() {
    return this.settings ? structuredClone(this.settings) : null;
  }

  async saveSettings(settings) {
    this.settings = { ...settings };
  }
}

class MemoryAssets {
  constructor() {
    this.objects = new Map();
  }

  async put(key, data, contentType) {
    this.objects.set(key, { data: Buffer.from(data), contentType });
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) throw new Error('missing object');
    return Readable.from([object.data]);
  }

  async exists(key) {
    return this.objects.has(key);
  }

  async remove(key) {
    this.objects.delete(key);
  }
}

function fixture() {
  const repository = new MemoryRepository();
  const assets = new MemoryAssets();
  const api = new ProductImageApi(repository, assets);
  return { repository, assets, api };
}

test('image intake accepts PNG/JPEG/WebP and validates dimensions from bytes, not headers', () => {
  const pngResult = inspectImage(png(64, 64));
  assert.equal(pngResult.contentType, 'image/png');
  assert.equal(pngResult.extension, 'png');
  assert.equal(pngResult.width, 64);
  assert.equal(pngResult.height, 64);

  const jpegResult = inspectImage(jpeg(80, 64));
  assert.equal(jpegResult.contentType, 'image/jpeg');
  assert.equal(jpegResult.extension, 'jpg');
  assert.equal(jpegResult.width, 80);
  assert.equal(jpegResult.height, 64);

  const webpResult = inspectImage(webp(72, 64));
  assert.equal(webpResult.contentType, 'image/webp');
  assert.equal(webpResult.extension, 'webp');
  assert.equal(webpResult.width, 72);
  assert.equal(webpResult.height, 64);
});

test('image intake rejects bad signatures, truncated files, corrupt decode data and unsupported formats', () => {
  assert.throws(() => inspectImage(Buffer.from('not an image')), { code: 'UNSUPPORTED_IMAGE_TYPE', status: 415 });
  assert.throws(() => inspectImage(Buffer.alloc(0)), { code: 'INVALID_IMAGE' });

  const truncated = png(64, 64).subarray(0, 40);
  assert.throws(() => inspectImage(truncated), { code: 'INVALID_IMAGE' });

  const badCrc = png(64, 64);
  badCrc[20] ^= 0x01;
  assert.throws(() => inspectImage(badCrc), { code: 'INVALID_IMAGE' });

  const badPixels = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', (() => {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(64, 0);
      header.writeUInt32BE(64, 4);
      header[8] = 8;
      header[9] = 2;
      return header;
    })()),
    pngChunk('IDAT', deflateSync(Buffer.from('too short'))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => inspectImage(badPixels), { code: 'INVALID_IMAGE' });

  assert.throws(() => inspectImage(jpeg().subarray(0, jpeg().length - 2)), { code: 'INVALID_IMAGE' });
  assert.throws(() => inspectImage(webp().subarray(0, 24)), { code: 'INVALID_IMAGE' });
});

test('image intake enforces size, pixel and dimension limits before expensive work', () => {
  assert.throws(() => inspectImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1)), {
    code: 'IMAGE_TOO_LARGE', status: 413,
  });
  assert.throws(() => inspectImage(pngHeader(9000, 64)), { code: 'IMAGE_DIMENSIONS' });
  assert.throws(() => inspectImage(pngHeader(4096, 4096)), { code: 'IMAGE_DIMENSIONS' });
  assert.throws(() => inspectImage(pngHeader(63, 64)), { code: 'IMAGE_DIMENSIONS' });
});

test('server derives separate private object keys for originals and screenshots', async () => {
  const { repository, assets, api } = fixture();
  const originalBytes = png(64, 64);
  const original = await api.upload({ productId: PRODUCT_ID, kind: 'original', data: originalBytes });
  assert.match(original.objectKey,
    new RegExp(`^products/${PRODUCT_ID}/originals/[0-9a-f-]{36}\\.png$`));
  assert.equal(original.contentType, 'image/png');
  assert.equal(original.width, 64);
  assert.equal(original.sha256.length, 64);
  assert.equal(assets.objects.get(original.objectKey).contentType, 'image/png');
  assert.deepEqual(assets.objects.get(original.objectKey).data, originalBytes);

  const screenshot = await api.upload({ productId: PRODUCT_ID, kind: 'screenshot', data: jpeg(120, 80) });
  assert.match(screenshot.objectKey,
    new RegExp(`^products/${PRODUCT_ID}/screenshots/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(screenshot.kind, 'screenshot');

  const listed = await api.list({ productId: PRODUCT_ID, kind: 'original' });
  assert.equal(listed.total, 1);
  assert.equal(listed.images[0].id, original.id);
  assert.equal(Object.hasOwn(listed.images[0], 'objectKey'), false);
  assert.equal(JSON.stringify(listed).includes('originals/'), false);

  const { image, stream } = await api.open(original.id);
  assert.equal(image.id, original.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), originalBytes);
  assert.equal(PRODUCT_IMAGE_BUCKET, 'shangjing-assets');
});

test('screenshots can be stored before a product exists, originals still require one', async () => {
  const { assets, api } = fixture();
  const bytes = png(64, 64);
  const image = await api.upload({ kind: 'screenshot', data: bytes });
  assert.equal(image.productId, null);
  assert.equal(image.kind, 'screenshot');
  assert.match(image.objectKey, /^screenshots\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(assets.objects.get(image.objectKey).data, bytes);

  const listed = await api.list({ kind: 'screenshot' });
  assert.equal(listed.total, 1);
  assert.equal(listed.images[0].productId, null);
  assert.equal(JSON.stringify(listed).includes('screenshots/'), false);

  await assert.rejects(
    api.upload({ kind: 'original', data: bytes }),
    { code: 'PRODUCT_REQUIRED' },
  );
  await assert.rejects(
    api.upload({ kind: 'screenshot', productId: OTHER_PRODUCT_ID, data: bytes }),
    { code: 'PRODUCT_NOT_FOUND', status: 404 },
  );
});

test('upload rejects client keys, unknown products, invalid kinds and failed metadata writes are compensated', async () => {
  const { repository, assets, api } = fixture();
  await assert.rejects(
    api.upload({ productId: PRODUCT_ID, kind: 'original', data: png(64, 64), objectKey: 'x' }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(
    api.upload({ productId: OTHER_PRODUCT_ID, kind: 'original', data: png(64, 64) }),
    { code: 'PRODUCT_NOT_FOUND', status: 404 },
  );
  await assert.rejects(
    api.upload({ productId: PRODUCT_ID, kind: 'reference', data: png(64, 64) }),
    { code: 'INVALID_IMAGE_KIND' },
  );
  await assert.rejects(
    api.upload({ productId: PRODUCT_ID, kind: 'original', data: 'not-buffer' }),
    { code: 'BINARY_REQUIRED', status: 415 },
  );

  repository.failInsert = true;
  await assert.rejects(
    api.upload({ productId: PRODUCT_ID, kind: 'original', data: png(64, 64) }),
    /insert failed/,
  );
  assert.equal(assets.objects.size, 0);
});

test('unverified providers cannot enable original-image input or pass preflight', async () => {
  const { repository, api } = fixture();
  const image = await api.upload({ productId: PRODUCT_ID, kind: 'original', data: png(64, 64) });

  const status = await api.status({ providerId: 'omyai' });
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  assert.equal(status.providers.omyai.arbitraryImageInput, false);
  assert.equal(status.providers.omyai.localUploadDocumented, false);
  assert.match(status.providers.omyai.reason, /本地图片上传暂未开放/);
  assert.equal(PROVIDER_INPUT_CAPABILITIES.omyai.verified, false);

  const enable = await api.setEnabled({
    enabled: true, providerId: 'omyai', protocol: 'mcp-source-job-id',
  }).catch(error => error);
  assert.equal(enable.code, 'PRODUCT_IMAGE_INPUT_UNVERIFIED');
  assert.equal(enable.status, 409);
  assert.equal(repository.settings, null);

  const preflight = await api.preflight({
    imageId: image.id, providerId: 'omyai', operation: 'edit',
  }).catch(error => error);
  assert.equal(preflight.code, 'PRODUCT_IMAGE_INPUT_UNVERIFIED');
  assert.equal(preflight.status, 409);
  assert.match(preflight.message, /source_job_id/);
});

test('a verified record allows the gate, and preflight never leaks storage keys or URLs', async () => {
  const { repository, api } = fixture();
  const image = await api.upload({ productId: PRODUCT_ID, kind: 'original', data: png(64, 64) });
  const screenshot = await api.upload({ productId: PRODUCT_ID, kind: 'screenshot', data: png(64, 64) });

  const verification = {
    id: randomUUID(),
    providerId: 'omyai',
    modelId: 'omyai:gpt-image-2.5-flare',
    protocol: 'test-upload-protocol',
    transport: 'test-transport',
    status: 'verified',
    verifiedAt: new Date(),
    evidence: { calls: 1, cost: 'test-only' },
  };
  repository.verifications.push(verification);

  const enabled = await api.setEnabled({
    enabled: true, providerId: 'omyai', modelId: verification.modelId,
    protocol: verification.protocol,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.verified, true);
  assert.equal(enabled.verification.id, verification.id);

  const preflight = await api.preflight({
    imageId: image.id, providerId: 'omyai', modelId: verification.modelId, operation: 'edit',
  });
  assert.equal(preflight.allowed, true);
  assert.equal(preflight.protocol, verification.protocol);
  assert.equal(preflight.handoff, 'server-side');
  assert.equal(Object.hasOwn(preflight, 'objectKey'), false);
  const serialized = JSON.stringify(preflight);
  assert.equal(serialized.includes('objectKey'), false);
  assert.equal(serialized.includes('products/'), false);
  assert.equal(serialized.includes('https://'), false);
  assert.equal(serialized.includes('MINIO'), false);

  await assert.rejects(
    api.preflight({ imageId: screenshot.id, providerId: 'omyai', operation: 'edit' }),
    { code: 'SCREENSHOT_NOT_INPUT', status: 422 },
  );
  await assert.rejects(
    api.preflight({ imageId: image.id, providerId: 'omyai', modelId: 'other:model' }),
    { code: 'INPUT_MODEL_MISMATCH', status: 409 },
  );

  await api.setEnabled({ enabled: false, providerId: 'omyai' });
  await assert.rejects(
    api.preflight({ imageId: image.id, providerId: 'omyai', operation: 'edit' }),
    { code: 'PRODUCT_IMAGE_INPUT_DISABLED', status: 409 },
  );
});

test('HTTP upload, file retrieval and the unverified gate work end to end', async t => {
  const { repository, api } = fixture();
  const server = createServer({
    uploads: api,
    port: 0,
    root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const bytes = png(64, 64);
  const uploadUrl = `${base}/api/product-images?productId=${PRODUCT_ID}&kind=original`;

  const denied = await fetch(uploadUrl, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes,
  });
  assert.equal(denied.status, 403);

  const wrongType = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: Buffer.from('{}'),
  });
  assert.equal(wrongType.status, 415);

  const clientKey = await fetch(`${uploadUrl}&objectKey=products/client.png`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': session.csrfToken },
    body: bytes,
  });
  assert.equal(clientKey.status, 400);
  assert.equal((await clientKey.json()).error.code, 'INVALID_FIELD');

  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': session.csrfToken },
    body: bytes,
  });
  assert.equal(uploaded.status, 201);
  const image = (await uploaded.json()).image;
  assert.equal(image.kind, 'original');
  assert.equal(image.width, 64);
  assert.equal(Object.hasOwn(image, 'objectKey'), false);
  assert.match(image.url, /^\/api\/product-images\/[0-9a-f-]{36}\/file$/);

  const file = await fetch(base + image.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);

  // The declared Content-Type is only an allow-list hint; the stored type comes from bytes.
  const mislabeled = await fetch(`${base}/api/product-images?productId=${PRODUCT_ID}&kind=screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': session.csrfToken },
    body: jpeg(80, 64),
  });
  assert.equal(mislabeled.status, 201);
  assert.equal((await mislabeled.json()).image.contentType, 'image/jpeg');

  const status = await (await fetch(base + '/api/product-images/input?providerId=omyai')).json();
  assert.equal(status.enabled, false);
  assert.equal(status.providers.omyai.arbitraryImageInput, false);

  const preflightHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
  const preflight = await fetch(base + '/api/product-images/preflight', {
    method: 'POST', headers: preflightHeaders,
    body: JSON.stringify({ imageId: image.id, providerId: 'omyai', operation: 'edit' }),
  });
  assert.equal(preflight.status, 409);
  assert.equal((await preflight.json()).error.code, 'PRODUCT_IMAGE_INPUT_UNVERIFIED');

  const enable = await fetch(base + '/api/product-images/input', {
    method: 'POST', headers: preflightHeaders,
    body: JSON.stringify({ enabled: true, providerId: 'omyai', protocol: 'mcp-source-job-id' }),
  });
  assert.equal(enable.status, 409);
  assert.equal((await enable.json()).error.code, 'PRODUCT_IMAGE_INPUT_UNVERIFIED');

  // Test-only evidence row stands in for a future real provider acceptance record.
  repository.verifications.push({
    id: randomUUID(),
    providerId: 'omyai',
    protocol: 'test-upload-protocol',
    status: 'verified',
    verifiedAt: new Date(),
    evidence: { calls: 1, cost: 'test-only' },
  });
  const enabled = await fetch(base + '/api/product-images/input', {
    method: 'POST', headers: preflightHeaders,
    body: JSON.stringify({ enabled: true, providerId: 'omyai', protocol: 'test-upload-protocol' }),
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).enabled, true);

  const allowed = await fetch(base + '/api/product-images/preflight', {
    method: 'POST', headers: preflightHeaders,
    body: JSON.stringify({ imageId: image.id, providerId: 'omyai', operation: 'edit' }),
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.allowed, true);
  assert.equal(JSON.stringify(body).includes('objectKey'), false);
  assert.equal(JSON.stringify(body).includes('products/'), false);
});
