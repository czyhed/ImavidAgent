import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ProductService, snapshotProduct } from '../server/products.mjs';
import { ScreenshotIntakeService, fingerprintOf } from '../server/intake-screenshot.mjs';
import { VisionAdapterRegistry } from '../server/vision.mjs';
import { createServer } from '../server/http.mjs';

// Tests use an in-memory product repository and a mock vision adapter. No
// PostgreSQL, MinIO, supplier endpoint or paid model call is reached.

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

  async versions(id) {
    const product = this.rows.get(id);
    if (!product) return null;
    const versions = [...this.history.get(id)].sort((a, b) => b.version - a.version);
    return { version: product.version, versions: structuredClone(versions), total: versions.length };
  }
}

class MemoryScreenshotStore {
  constructor() {
    this.records = new Map();
    this.byFingerprint = new Map();
  }

  async claim({ id, fingerprint, images, requestKey, retry }) {
    const existingId = this.byFingerprint.get(fingerprint);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (retry && existing.status === 'failed') {
        existing.status = 'processing';
        existing.result = null;
        existing.productId = null;
        existing.error = null;
        existing.billed = false;
        existing.attempt += 1;
        existing.updatedAt = new Date();
        return { status: 'new', record: structuredClone(existing) };
      }
      return { status: 'existing', record: structuredClone(existing) };
    }
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

class MemoryScreenshotLibrary {
  constructor() {
    this.rows = new Map();
  }

  add(record) {
    this.rows.set(record.id, record);
    return record;
  }

  async findByIds(ids) {
    return ids.filter(id => this.rows.has(id)).map(id => structuredClone(this.rows.get(id)));
  }

  async bindToProduct(ids, productId) {
    let count = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) {
        row.productId = productId;
        count += 1;
      }
    }
    return count;
  }
}

// Simulates a row already written by the upload service. Only its id is sent to
// intake; the hash and object key stay server-side (Issue #23).
function storedScreenshot(seed, index = 0, overrides = {}) {
  const id = randomUUID();
  return {
    id,
    productId: null,
    kind: 'screenshot',
    objectKey: `screenshots/${id}.png`,
    contentType: 'image/png',
    extension: 'png',
    bytes: 2048 + index,
    width: 800,
    height: 1200,
    sha256: createHash('sha256').update(seed).digest('hex'),
    createdAt: new Date(),
    ...overrides,
  };
}

function ids(records) {
  return records.map(record => record.id);
}

function evidenceFor(image, quote) {
  return [{ imageSha256: image.sha256, quote }];
}

function makeService(handler) {
  const calls = [];
  const vision = new VisionAdapterRegistry();
  if (handler) {
    vision.register('mock-vision', {
      async analyze(request) {
        calls.push(request);
        return handler(request);
      },
    });
  }
  const repository = new MemoryProductRepository();
  const store = new MemoryScreenshotStore();
  const screenshots = new MemoryScreenshotLibrary();
  const service = new ScreenshotIntakeService({
    products: new ProductService(repository),
    store,
    screenshots,
    vision,
  });
  return { service, repository, store, screenshots, calls, vision };
}

function fullObservationSet(images) {
  const [a, b, c] = images;
  return {
    observations: [
      {
        fields: {
          name: { value: '便携折叠水杯', confidence: 0.94, evidence: evidenceFor(a, '便携折叠水杯') },
          brand: { value: '杯具家', confidence: 0.9, evidence: evidenceFor(a, '杯具家') },
        },
      },
      {
        sku: {
          price: {
            amount: 39.9, currency: 'CNY', type: 'sale',
            confidence: 0.93, evidence: evidenceFor(b, '¥39.90'),
          },
        },
      },
      {
        sku: {
          spec: { value: '500ml / 白色', confidence: 0.91, evidence: evidenceFor(c, '500ml 白色') },
          parameters: [{
            name: '容量', value: '500', unit: 'ml',
            confidence: 0.92, evidence: evidenceFor(c, '容量：500ml'),
          }],
        },
      },
    ],
  };
}

test('without a confirmed vision supplier nothing is called or saved', async () => {
  const { service, repository, screenshots, calls } = makeService(null);
  const image = screenshots.add(storedScreenshot('a'));
  const preflight = await service.preflight({ imageIds: ids([image]) });
  assert.equal(preflight.vision.ready, false);
  assert.equal(preflight.vision.registered.length, 0);
  assert.equal(preflight.billing.chargeable, false);
  assert.match(preflight.billing.note, /不会调用模型/);

  await assert.rejects(
    service.submit({ imageIds: ids([image]) }),
    { code: 'VISION_NOT_CONFIGURED', status: 503 },
  );
  assert.equal(calls.length, 0);
  assert.equal(repository.rows.size, 0);
});

test('several screenshots merge into one pending product with field evidence and confidence', async () => {
  const { service, repository, screenshots, calls } = makeService(({ images }) => fullObservationSet(images));
  const a = screenshots.add(storedScreenshot('a', 0));
  const b = screenshots.add(storedScreenshot('b', 1));
  const c = screenshots.add(storedScreenshot('c', 2));

  const preflight = await service.preflight({ imageIds: ids([a, b, c]) });
  assert.equal(preflight.vision.ready, true);
  assert.equal(preflight.duplicate, false);
  assert.equal(preflight.billing.chargeable, true);
  assert.match(preflight.billing.note, /重复提交不会再次调用模型/);
  assert.equal(preflight.images[0].sha256, a.sha256);
  assert.equal(Object.hasOwn(preflight.images[0], 'objectKey'), false);
  assert.equal(JSON.stringify(preflight).includes('objectKey'), false);

  const result = await service.submit({ imageIds: ids([a, b, c]), platform: '淘宝' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images.map(item => item.sha256), [a.sha256, b.sha256, c.sha256]);
  assert.match(calls[0].images[0].objectKey, /^screenshots\/[0-9a-f-]{36}\.png$/);

  assert.equal(result.status, 'completed');
  assert.equal(result.productCreated, true);
  assert.equal(result.product.name, '便携折叠水杯');
  assert.equal(result.product.brand, '杯具家');
  assert.equal(result.product.sourceType, 'screenshot');
  assert.equal(result.product.sourcePlatform, '淘宝');
  assert.equal(result.product.status, 'pending');
  assert.equal(result.product.skus.length, 1);
  assert.equal(result.product.skus[0].spec, '500ml / 白色');
  assert.equal(result.product.skus[0].price.amount, 39.9);
  assert.equal(result.product.skus[0].price.currency, 'CNY');
  assert.equal(result.product.skus[0].price.type, 'sale');
  assert.deepEqual(result.product.skus[0].parameters, [{ name: '容量', value: '500', unit: 'ml' }]);
  assert.equal(result.product.version, 1);
  assert.equal(repository.rows.size, 1);

  assert.equal(result.review.nameDetermined, true);
  const nameField = result.review.fields.find(field => field.field === 'name');
  assert.equal(nameField.confidence, 0.94);
  assert.equal(nameField.evidence[0].imageSha256, a.sha256);
  assert.equal(Object.hasOwn(nameField.evidence[0], 'objectKey'), false);
  const priceField = result.review.fields.find(field => field.field === 'sku.price.amount');
  assert.equal(priceField.value, 39.9);
  assert.equal(priceField.evidence[0].imageSha256, b.sha256);
  const specField = result.review.fields.find(field => field.field === 'sku.spec');
  assert.equal(specField.evidence[0].imageSha256, c.sha256);
  assert.equal(result.review.mainImage, null);
  assert.ok(result.review.notices.some(note => note.includes('不会裁切成生成主图')));
  // Screenshot evidence is not copied into the product record as an image.
  assert.equal(JSON.stringify(result.product).includes(a.sha256), false);
  assert.equal(JSON.stringify(result.product).includes('screenshots/'), false);

  // The successful batch now belongs to the new product.
  assert.equal(screenshots.rows.get(a.id).productId, result.product.id);
  assert.equal(screenshots.rows.get(b.id).productId, result.product.id);
  assert.equal(screenshots.rows.get(c.id).productId, result.product.id);

  const product = await new ProductService(repository).get(result.product.id);
  assert.equal(product.name, '便携折叠水杯');
});

test('re-submitting the same screenshots in any order does not call the model or create again', async () => {
  const { service, repository, screenshots, calls } = makeService(({ images }) => fullObservationSet(images));
  const a = screenshots.add(storedScreenshot('a', 0));
  const b = screenshots.add(storedScreenshot('b', 1));
  const c = screenshots.add(storedScreenshot('c', 2));

  const first = await service.submit({ imageIds: ids([a, b, c]) });
  const second = await service.submit({ imageIds: ids([c, a, b]) });
  assert.equal(calls.length, 1);
  assert.equal(repository.rows.size, 1);
  assert.equal(second.duplicate, true);
  assert.equal(second.intakeId, first.intakeId);
  assert.equal(second.product.id, first.product.id);
  assert.equal(second.billing.visionInvoked, false);
  assert.equal(second.billing.duplicate, true);
  assert.match(second.billing.note, /本次未调用模型/);

  const preflight = await service.preflight({ imageIds: ids([b, c, a]) });
  assert.equal(preflight.duplicate, true);
  assert.equal(preflight.existing.status, 'completed');
  assert.equal(preflight.existing.productId, first.product.id);
});

test('low-confidence numeric fields are stored but flagged for review, never silently adopted', async () => {
  const { service, screenshots } = makeService(({ images }) => ({
    observations: [
      {
        fields: {
          name: { value: '不锈钢保温杯', confidence: 0.95, evidence: evidenceFor(images[0], '不锈钢保温杯') },
        },
      },
      {
        sku: {
          price: {
            amount: 59.9, currency: null,
            confidence: 0.51, evidence: evidenceFor(images[1], '59.9'),
          },
        },
      },
    ],
  }));
  const n = screenshots.add(storedScreenshot('n'));
  const p = screenshots.add(storedScreenshot('p', 1));
  const result = await service.submit({ imageIds: ids([n, p]) });
  assert.equal(result.product.name, '不锈钢保温杯');
  assert.equal(result.product.status, 'pending');
  assert.equal(result.product.skus[0].price.amount, 59.9);
  assert.equal(result.product.skus[0].price.currency, null);
  assert.equal(result.review.nameDetermined, true);
  assert.equal(result.review.needsReview, true);
  assert.ok(result.review.lowConfidence.includes('sku.price.amount'));
  assert.ok(result.review.missing.includes('sku.price.currency'));
  const priceField = result.review.fields.find(field => field.field === 'sku.price.amount');
  assert.equal(priceField.needsReview, true);
  assert.equal(priceField.confidence, 0.51);
});

test('an uncertain or conflicting name returns a review result without creating an empty shell', async () => {
  const uncertain = makeService(({ images }) => ({
    observations: [{
      fields: {
        brand: { value: '某品牌', confidence: 0.7, evidence: evidenceFor(images[0], '某品牌') },
        name: { value: '可能是杯子', confidence: 0.45, evidence: evidenceFor(images[0], '可能是杯子') },
      },
    }],
  }));
  const image = uncertain.screenshots.add(storedScreenshot('u'));
  const result = await uncertain.service.submit({ imageIds: ids([image]) });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.product, null);
  assert.equal(result.review.nameDetermined, false);
  assert.match(result.review.decision.reason, /未建档空壳/);
  assert.equal(uncertain.repository.rows.size, 0);
  assert.equal(uncertain.store.records.size, 1);
  // An unconfirmed batch keeps its screenshots unbound for manual entry.
  assert.equal(uncertain.screenshots.rows.get(image.id).productId, null);

  // The uncertain result is cached: asking again is not a new paid call.
  const again = await uncertain.service.submit({ imageIds: ids([image]) });
  assert.equal(again.duplicate, true);
  assert.equal(again.status, 'needs_review');
  assert.equal(again.product, null);
  assert.equal(uncertain.calls.length, 1);

  const conflict = makeService(({ images }) => ({
    observations: [
      { fields: { name: { value: '商品甲', confidence: 0.86, evidence: evidenceFor(images[0], '商品甲') } } },
      { fields: { name: { value: '商品乙', confidence: 0.84, evidence: evidenceFor(images[1], '商品乙') } } },
    ],
  }));
  const conflicted = await conflict.service.submit({
    imageIds: ids([
      conflict.screenshots.add(storedScreenshot('x')),
      conflict.screenshots.add(storedScreenshot('y', 1)),
    ]),
  });
  assert.equal(conflicted.product, null);
  assert.equal(conflicted.status, 'needs_review');
  assert.ok(conflicted.review.conflicts.some(item => item.field === 'name'));
  assert.match(conflicted.review.decision.reason, /无法确定唯一商品/);
  assert.equal(conflict.repository.rows.size, 0);
});

test('a field without screenshot evidence is discarded, not invented', async () => {
  const { service, repository, screenshots } = makeService(({ images }) => ({
    observations: [{
      fields: {
        name: { value: '无证据商品', confidence: 0.99 },
        brand: { value: '有证据品牌', confidence: 0.9, evidence: evidenceFor(images[0], '有证据品牌') },
      },
    }],
  }));
  const image = screenshots.add(storedScreenshot('e'));
  const result = await service.submit({ imageIds: ids([image]) });
  assert.equal(result.product, null);
  assert.match(result.review.decision.reason, /未从截图中识别到商品名称/);
  assert.equal(repository.rows.size, 0);
});

test('image IDs, stored metadata and adapter selection are validated before any model call', async () => {
  const { service, screenshots, calls, store } = makeService(({ images }) => fullObservationSet(images));
  const a = screenshots.add(storedScreenshot('a', 0));
  const b = screenshots.add(storedScreenshot('b', 1));
  const c = screenshots.add(storedScreenshot('c', 2));

  await assert.rejects(
    service.submit({ imageIds: [a.id, a.id] }),
    { code: 'DUPLICATE_IMAGE' },
  );
  await assert.rejects(
    service.submit({ imageIds: Array.from({ length: 9 }, () => randomUUID()) }),
    { code: 'INVALID_IMAGES' },
  );
  await assert.rejects(
    service.submit({ imageIds: [a.id], adapter: 'missing-adapter' }),
    { code: 'VISION_ADAPTER_UNKNOWN', status: 409 },
  );
  assert.equal(calls.length, 0);
  assert.equal(store.records.size, 0);

  // A screenshot ID that was never stored (or belongs to another workspace) is rejected.
  const unknownId = randomUUID();
  await assert.rejects(
    service.preflight({ imageIds: [unknownId] }),
    { code: 'IMAGE_NOT_FOUND', status: 404 },
  );
  await assert.rejects(
    service.submit({ imageIds: [a.id, unknownId] }),
    { code: 'IMAGE_NOT_FOUND', status: 404 },
  );
  assert.equal(calls.length, 0);
  assert.equal(store.records.size, 0);

  // A product original is not recognition evidence.
  const original = screenshots.add(storedScreenshot('o', 0, {
    kind: 'original',
    productId: randomUUID(),
    objectKey: `products/${randomUUID()}/originals/${randomUUID()}.png`,
  }));
  await assert.rejects(
    service.submit({ imageIds: [original.id] }),
    { code: 'SCREENSHOT_REQUIRED' },
  );
  assert.equal(calls.length, 0);

  // The same file uploaded twice (different IDs, same server-side sha256) is rejected.
  const duplicateFile = screenshots.add(storedScreenshot('a', 1));
  await assert.rejects(
    service.submit({ imageIds: [a.id, duplicateFile.id] }),
    { code: 'DUPLICATE_IMAGE' },
  );
  assert.equal(calls.length, 0);

  // Valid batch still proceeds normally.
  const accepted = await service.preflight({ imageIds: ids([a, b, c]) });
  assert.equal(accepted.duplicate, false);
  assert.deepEqual(accepted.images.map(image => image.sha256), [a.sha256, b.sha256, c.sha256]);
});

test('client-supplied sha256, objectKey and the old images metadata are rejected and never used', async () => {
  const { service, screenshots, calls, store } = makeService(({ images }) => fullObservationSet(images));
  const a = screenshots.add(storedScreenshot('a', 0));
  const b = screenshots.add(storedScreenshot('b', 1));
  const c = screenshots.add(storedScreenshot('c', 2));
  const forgedSha = 'f'.repeat(64);

  await assert.rejects(
    service.submit({ imageIds: ids([a, b, c]), sha256: forgedSha, objectKey: 'evil/key.png' }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(
    service.preflight({ imageIds: ids([a, b, c]), objectKey: 'evil/key.png' }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(
    service.submit({
      images: [{ sha256: forgedSha, objectKey: 'evil/key.png', contentType: 'image/png', sizeBytes: 10 }],
    }),
    { code: 'INVALID_FIELD' },
  );
  assert.equal(calls.length, 0);
  assert.equal(store.records.size, 0);

  // The fingerprint is the server-stored hash set, independent of any forged value.
  const preflight = await service.preflight({ imageIds: ids([a, b, c]) });
  const expected = fingerprintOf('local', [a, b, c]);
  assert.equal(preflight.fingerprint, expected);
  assert.notEqual(preflight.fingerprint, 'f'.repeat(64));

  const created = await service.submit({ imageIds: ids([a, b, c]) });
  assert.equal(created.duplicate, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images.map(image => image.sha256), [a.sha256, b.sha256, c.sha256]);
  // A second request with a forged hash still hits the server-derived fingerprint.
  const duplicate = await service.submit({
    imageIds: ids([c, a, b]), sha256: forgedSha,
  }).catch(error => error);
  assert.equal(duplicate.code, 'INVALID_FIELD');
  assert.equal(calls.length, 1);
});

test('screenshots cannot be declared as a generated main image or crop input', async () => {
  const { service, screenshots, calls } = makeService(({ images }) => fullObservationSet(images));
  const image = screenshots.add(storedScreenshot('m', 0));
  await assert.rejects(
    service.submit({ imageIds: ids([image]), mainImage: true }),
    { code: 'SCREENSHOT_NOT_MAIN_IMAGE' },
  );
  await assert.rejects(
    service.submit({ imageIds: ids([image]), crop: { x: 0, y: 0 } }),
    { code: 'SCREENSHOT_NOT_MAIN_IMAGE' },
  );
  assert.equal(calls.length, 0);
});

test('an invalid adapter result fails once, is not retried automatically, and can be retried explicitly', async () => {
  let broken = true;
  const { service, store, screenshots, calls } = makeService(
    ({ images }) => (broken ? null : fullObservationSet(images)),
  );
  const a = screenshots.add(storedScreenshot('a'));
  const b = screenshots.add(storedScreenshot('b', 1));
  const c = screenshots.add(storedScreenshot('c', 2));
  const imageIds = ids([a, b, c]);

  await assert.rejects(service.submit({ imageIds }), { code: 'VISION_RESULT_INVALID', status: 502 });
  assert.equal(calls.length, 1);
  const failed = [...store.records.values()][0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.billed, true);

  // A duplicate submission of the failed batch must not call the supplier again.
  await assert.rejects(service.submit({ imageIds }), { code: 'INTAKE_FAILED', status: 409 });
  assert.equal(calls.length, 1);

  // Explicit retry is the only path that may incur another call.
  broken = false;
  const retried = await service.submit({ imageIds, retry: true });
  assert.equal(calls.length, 2);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.product.name, '便携折叠水杯');
  assert.equal([...store.records.values()][0].attempt, 2);
  assert.equal(screenshots.rows.get(a.id).productId, retried.product.id);
});

test('HTTP routes expose preflight, intake, duplicate and review evidence', async t => {
  let noNameSha = null;
  const { service, screenshots } = makeService(({ images }) => {
    if (images.some(image => image.sha256 === noNameSha)) {
      return {
        observations: [{
          fields: {
            brand: { value: '匿名品牌', confidence: 0.9, evidence: evidenceFor(images[0], '匿名品牌') },
          },
        }],
      };
    }
    return fullObservationSet(images);
  });
  const server = createServer({ intake: service, port: 0, root: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  const a = screenshots.add(storedScreenshot('a', 0));
  const b = screenshots.add(storedScreenshot('b', 1));
  const c = screenshots.add(storedScreenshot('c', 2));
  const noName = screenshots.add(storedScreenshot('no-name'));
  noNameSha = noName.sha256;

  const denied = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageIds: [a.id] }),
  });
  assert.equal(denied.status, 403);

  const forged = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers,
    body: JSON.stringify({ imageIds: [a.id], sha256: 'f'.repeat(64), objectKey: 'evil/key.png' }),
  });
  assert.equal(forged.status, 422);
  assert.equal((await forged.json()).error.code, 'INVALID_FIELD');

  const preflight = await fetch(base + '/api/intake/screenshot/preflight', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: ids([a, b, c]) }),
  });
  assert.equal(preflight.status, 200);
  const plan = await preflight.json();
  assert.equal(plan.duplicate, false);
  assert.equal(plan.vision.ready, true);
  assert.equal(plan.billing.chargeable, true);
  assert.equal(JSON.stringify(plan).includes('objectKey'), false);

  const createdResponse = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: ids([a, b, c]), platform: '天猫' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.product.status, 'pending');
  assert.ok(created.review.fields.some(field => field.field === 'name' && field.evidence.length > 0));
  assert.equal(screenshots.rows.get(a.id).productId, created.product.id);

  const duplicateResponse = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: ids([c, b, a]) }),
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.intakeId, created.intakeId);

  const read = await (await fetch(base + '/api/intake/screenshot/' + created.intakeId)).json();
  assert.equal(read.review.nameDetermined, true);
  assert.equal(read.product.id, created.product.id);

  const noNameResponse = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers,
    body: JSON.stringify({ imageIds: [noName.id] }),
  });
  assert.equal(noNameResponse.status, 200);
  const reviewOnly = await noNameResponse.json();
  assert.equal(reviewOnly.product, null);
  assert.equal(reviewOnly.status, 'needs_review');
  assert.equal(screenshots.rows.get(noName.id).productId, null);

  const unknown = await fetch(base + '/api/intake/screenshot', {
    method: 'POST', headers, body: JSON.stringify({ imageIds: [randomUUID()] }),
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'IMAGE_NOT_FOUND');
});
