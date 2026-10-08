import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import { ProductService, snapshotProduct } from '../server/products.mjs';
import { ScreenshotIntakeService, fingerprintOf } from '../server/intake-screenshot.mjs';
import { VisionAdapterRegistry } from '../server/vision.mjs';
import { ProductImageApi } from '../server/uploads.mjs';
import { createServer } from '../server/http.mjs';

// End-to-end coverage for Issue #23: upload screenshots before a product exists,
// submit only their server-side IDs, create a product from the review and bind
// the batch to it. Everything is in memory; no PostgreSQL, MinIO or model call.

class MemoryProductRepository {
  constructor() {
    this.rows = new Map();
    this.history = new Map();
  }

  async create({ product, skus, reason }) {
    const now = new Date();
    const record = {
      ...product,
      version: 1,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
      skus: structuredClone(skus),
    };
    this.rows.set(record.id, record);
    this.history.set(record.id, [{
      id: randomUUID(),
      version: 1,
      changeReason: reason,
      createdBy: 'local',
      createdAt: now,
      snapshot: snapshotProduct(record),
    }]);
    return structuredClone(record);
  }

  async get(id) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }
}

class MemoryImageRepository {
  constructor() {
    this.rows = new Map();
  }

  async productExists(id) {
    return this.rows.has(id) || String(id).startsWith('product-');
  }

  async insert(image) {
    this.rows.set(image.id, structuredClone(image));
    return structuredClone(image);
  }

  async get(id) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async list({ productId, kind, limit, offset }) {
    let rows = [...this.rows.values()];
    if (productId) rows = rows.filter(row => row.productId === productId);
    if (kind) rows = rows.filter(row => row.kind === kind);
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { images: rows.slice(offset, offset + limit).map(row => structuredClone(row)), total: rows.length };
  }

  async findByIds(ids) {
    return ids.filter(id => this.rows.has(id)).map(id => structuredClone(this.rows.get(id)));
  }

  async bindToProduct(ids, productId) {
    let count = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row && row.kind === 'screenshot') {
        row.productId = productId;
        count += 1;
      }
    }
    return count;
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

class MemoryIntakeStore {
  constructor() {
    this.records = new Map();
    this.byFingerprint = new Map();
  }

  async claim({ id, fingerprint, images, requestKey }) {
    const existingId = this.byFingerprint.get(fingerprint);
    if (existingId) return { status: 'existing', record: structuredClone(this.records.get(existingId)) };
    const record = {
      id,
      workspaceId: 'local',
      fingerprint,
      requestKey: requestKey || null,
      status: 'processing',
      images: structuredClone(images),
      result: null,
      productId: null,
      error: null,
      billed: false,
      attempt: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.records.set(id, record);
    this.byFingerprint.set(fingerprint, id);
    return { status: 'new', record: structuredClone(record) };
  }

  async finish(id, { status, productId, result, billed }) {
    const record = this.records.get(id);
    Object.assign(record, {
      status, productId: productId || null, result, error: null, billed, updatedAt: new Date(),
    });
    return structuredClone(record);
  }

  async fail(id, { error, billed }) {
    const record = this.records.get(id);
    Object.assign(record, { status: 'failed', error, billed, updatedAt: new Date() });
    return structuredClone(record);
  }

  async get(id) {
    return this.records.has(id) ? structuredClone(this.records.get(id)) : null;
  }

  async check(fingerprint) {
    const id = this.byFingerprint.get(fingerprint);
    return id ? structuredClone(this.records.get(id)) : null;
  }
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, checksum]);
}

function png(width = 64, height = 64) {
  const channels = 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowBytes = Math.ceil(width * channels * 8 / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function fullObservationSet(images) {
  return {
    observations: [
      {
        fields: {
          name: {
            value: '便携折叠水杯', confidence: 0.94,
            evidence: [{ imageSha256: images[0].sha256, quote: '便携折叠水杯' }],
          },
          brand: {
            value: '杯具家', confidence: 0.9,
            evidence: [{ imageSha256: images[0].sha256, quote: '杯具家' }],
          },
        },
      },
      {
        sku: {
          price: {
            amount: 39.9, currency: 'CNY', type: 'sale', confidence: 0.93,
            evidence: [{ imageSha256: images[1].sha256, quote: '¥39.90' }],
          },
        },
      },
    ],
  };
}

function fixture() {
  const products = new MemoryProductRepository();
  const images = new MemoryImageRepository();
  const assets = new MemoryAssets();
  const calls = [];
  const vision = new VisionAdapterRegistry();
  vision.register('mock-vision', {
    async analyze({ images: batch }) {
      calls.push(batch);
      // One screenshot alone yields no product name, so the batch needs review.
      return batch.length >= 2
        ? fullObservationSet(batch)
        : {
          observations: [{
            fields: {
              brand: {
                value: '匿名品牌', confidence: 0.9,
                evidence: [{ imageSha256: batch[0].sha256, quote: '匿名品牌' }],
              },
            },
          }],
        };
    },
  });
  const intake = new ScreenshotIntakeService({
    products: new ProductService(products),
    store: new MemoryIntakeStore(),
    screenshots: images,
    vision,
  });
  return {
    products,
    images,
    assets,
    calls,
    api: new ProductImageApi(images, assets),
    intake,
  };
}

test('upload -> intake -> product creation -> screenshot binding works end to end', async t => {
  const { products, images, assets, calls, api, intake } = fixture();
  const server = createServer({
    uploads: api,
    intake,
    port: 0,
    root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  async function upload(bytes) {
    const response = await fetch(`${base}/api/product-images?kind=screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': session.csrfToken },
      body: bytes,
    });
    assert.equal(response.status, 201);
    return (await response.json()).image;
  }

  const first = await upload(png(64, 64));
  const second = await upload(png(96, 64));

  // Screenshots exist before any product does, and the client never sees keys.
  assert.equal(first.productId, null);
  assert.equal(second.productId, null);
  assert.equal(Object.hasOwn(first, 'objectKey'), false);
  assert.equal(images.rows.get(first.id).kind, 'screenshot');
  assert.match(images.rows.get(first.id).objectKey, /^screenshots\/[0-9a-f-]{36}\.png$/);
  assert.equal(assets.objects.size, 2);

  // A forged hash/key is rejected and does not create an intake record.
  const forged = await fetch(base + '/api/intake/screenshot', {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageIds: [first.id, second.id], sha256: 'a'.repeat(64), objectKey: 'evil/x.png' }),
  });
  assert.equal(forged.status, 422);
  assert.equal((await forged.json()).error.code, 'INVALID_FIELD');
  assert.equal(calls.length, 0);

  // Unregistered IDs are rejected before any model call.
  const unknown = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: [randomUUID()] }),
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'IMAGE_NOT_FOUND');
  assert.equal(calls.length, 0);

  const preflight = await fetch(base + '/api/intake/screenshot/preflight', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: [first.id, second.id] }),
  });
  assert.equal(preflight.status, 200);
  const plan = await preflight.json();
  assert.equal(plan.duplicate, false);
  assert.equal(plan.vision.ready, true);
  assert.deepEqual(plan.images.map(image => image.sha256), [first.sha256, second.sha256]);
  assert.equal(JSON.stringify(plan).includes('objectKey'), false);
  // The fingerprint comes from the stored hashes, not from anything the client sent.
  assert.equal(plan.fingerprint, fingerprintOf('local', [
    { sha256: first.sha256 }, { sha256: second.sha256 },
  ]));

  const createdResponse = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: [second.id, first.id], platform: '淘宝' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.duplicate, false);
  assert.equal(created.status, 'completed');
  assert.equal(created.product.name, '便携折叠水杯');
  assert.equal(created.product.sourceType, 'screenshot');
  assert.equal(products.rows.size, 1);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(image => image.sha256), [second.sha256, first.sha256]);
  assert.deepEqual(calls[0].map(image => image.contentType), ['image/png', 'image/png']);
  assert.equal(calls[0][0].sizeBytes, assets.objects.get(images.rows.get(second.id).objectKey).data.length);

  // Both screenshots now belong to the new product.
  assert.equal(images.rows.get(first.id).productId, created.product.id);
  assert.equal(images.rows.get(second.id).productId, created.product.id);
  const listed = await (await fetch(
    `${base}/api/product-images?productId=${created.product.id}&kind=screenshot`,
  )).json();
  assert.equal(listed.total, 2);

  // Same batch in another order is a duplicate: no new call, no new product.
  const duplicateResponse = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: [first.id, second.id] }),
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.intakeId, created.intakeId);
  assert.equal(duplicate.billing.visionInvoked, false);
  assert.equal(calls.length, 1);
  assert.equal(products.rows.size, 1);
});

test('a batch that only needs review keeps its screenshots unbound', async t => {
  const { products, images, api, intake } = fixture();
  const server = createServer({ uploads: api, intake, port: 0, root: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  const uploaded = await fetch(`${base}/api/product-images?kind=screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': session.csrfToken },
    body: png(64, 64),
  });
  const image = (await uploaded.json()).image;

  const response = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: [image.id] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'needs_review');
  assert.equal(result.product, null);
  assert.equal(result.productCreated, false);
  assert.equal(products.rows.size, 0);
  assert.equal(images.rows.get(image.id).productId, null);
});

test('migration 0011 keeps the original/screenshot binding and object-key rules', async () => {
  const sql = await readFile(new URL('../server/migrations/0011-screenshot-upload.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER COLUMN product_id DROP NOT NULL/);
  assert.match(sql, /CHECK \(product_id IS NOT NULL OR kind = 'screenshot'\)/);
  assert.match(sql, /sj_product_images_key_shape/);
  assert.match(sql, /screenshots\/\[0-9a-f-\]\{36\}/);
  assert.match(sql, /products\/\[0-9a-f-\]\{36\}\/originals/);
});
