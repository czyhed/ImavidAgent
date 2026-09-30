import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ProductService,
  snapshotProduct,
} from '../server/products.mjs';
import { createServer } from '../server/http.mjs';

// In-memory repository with the same compare-and-swap contract as PgProductRepository.
// Tests never reach PostgreSQL or any network service.
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

  async list(filters) {
    const q = filters.q.toLowerCase();
    const matches = product => {
      if (filters.statuses.length && !filters.statuses.includes(product.status)) return false;
      if (filters.sources.length && !filters.sources.includes(product.sourceType)) return false;
      if (!q) return true;
      const fields = [product.name, product.brand, product.internalCode];
      for (const sku of product.skus) fields.push(sku.internalSku, sku.sourceSkuId, sku.spec);
      return fields.some(value => String(value || '').toLowerCase().includes(q));
    };
    const products = [...this.rows.values()]
      .filter(matches)
      .sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    return {
      total: products.length,
      products: products.slice(filters.offset, filters.offset + filters.limit).map(item => structuredClone(item)),
    };
  }

  async mutate(id, expectedVersion, mutate) {
    const current = this.rows.get(id);
    if (!current) return { status: 'missing' };
    if (expectedVersion !== null && expectedVersion !== current.version) {
      return { status: 'conflict', currentVersion: current.version };
    }
    const next = await mutate(structuredClone(current));
    if (next.unchanged) return { status: 'ok', product: structuredClone(current) };
    const record = {
      ...next.product,
      version: current.version + 1,
      updatedAt: new Date(),
      skus: structuredClone(next.skus),
    };
    this.rows.set(id, record);
    this.history.get(id).push({
      id: randomUUID(),
      version: record.version,
      changeReason: next.reason,
      createdBy: 'local',
      createdAt: new Date(),
      snapshot: snapshotProduct(record),
    });
    return { status: 'ok', product: structuredClone(record) };
  }

  async versions(id, { limit, offset }) {
    const product = this.rows.get(id);
    if (!product) return null;
    const list = [...this.history.get(id)].sort((a, b) => b.version - a.version);
    return {
      version: product.version,
      versions: list.slice(offset, offset + limit).map(item => structuredClone(item)),
      total: list.length,
    };
  }
}

const service = () => new ProductService(new MemoryProductRepository());

test('only a product name is required; missing price stays NULL, not zero', async () => {
  const products = service();
  const product = await products.create({ name: '  折叠收纳箱  ' });
  assert.equal(product.name, '折叠收纳箱');
  assert.equal(product.status, 'draft');
  assert.equal(product.version, 1);
  assert.equal(product.skus.length, 1);
  assert.equal(product.skus[0].price.amount, null);
  assert.equal(product.skus[0].price.min, null);
  assert.equal(product.skus[0].price.max, null);
  assert.equal(product.skus[0].price.currency, null);
  const versions = await products.versions(product.id);
  assert.equal(versions.total, 1);
  assert.equal(versions.versions[0].snapshot.name, '折叠收纳箱');
  assert.equal(versions.versions[0].snapshot.skus[0].price.amount, null);
});

test('price keeps currency, type and the owning SKU; empty prices never become zero', async () => {
  const products = service();
  const priced = await products.create({
    name: '带价格的商品',
    skus: [{
      spec: '白色 / 大号',
      price: { amount: 99.5, currency: 'cny', type: 'sale', condition: '含运费' },
    }],
  });
  assert.equal(priced.skus[0].spec, '白色 / 大号');
  assert.equal(priced.skus[0].price.amount, 99.5);
  assert.equal(priced.skus[0].price.currency, 'CNY');
  assert.equal(priced.skus[0].price.type, 'sale');
  assert.equal(priced.skus[0].price.condition, '含运费');
  assert.ok(priced.skus[0].price.capturedAt);

  const empty = await products.create({ name: '无价格商品', skus: [{}] });
  assert.equal(empty.skus[0].price.amount, null);
  assert.equal(empty.skus[0].price.capturedAt, null);

  const range = await products.create({
    name: '价格区间商品',
    skus: [{ price: { min: 10, max: 20, currency: 'CNY' } }],
  });
  assert.equal(range.skus[0].price.min, 10);
  assert.equal(range.skus[0].price.max, 20);
});

test('phase one accepts one SKU and trusts no client IDs or timestamps', async () => {
  const products = service();
  await assert.rejects(
    products.create({ name: '多规格', skus: [{ spec: 'A' }, { spec: 'B' }] }),
    { code: 'SKU_LIMIT' },
  );
  await assert.rejects(products.create({ name: '伪造 ID', id: randomUUID() }), { code: 'INVALID_FIELD' });
  await assert.rejects(
    products.create({ name: '伪造 SKU', skus: [{ id: randomUUID() }] }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(
    products.create({ name: '伪造时间', skus: [{ price: { amount: 1, capturedAt: '2020-01-01' } }] }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(products.create({ name: '   ' }), { code: 'INVALID_NAME' });
  await assert.rejects(products.create({ name: '负价格', skus: [{ price: { amount: -1 } }] }), { code: 'INVALID_PRICE' });
  await assert.rejects(
    products.create({ name: '坏币种', skus: [{ price: { amount: 1, currency: '人民币' } }] }),
    { code: 'INVALID_CURRENCY' },
  );
  await assert.rejects(products.create({ name: '已确认', status: 'confirmed' }), { code: 'INVALID_STATUS' });
});

test('editing requires a version and a stale version returns a conflict without writing', async () => {
  const products = service();
  const created = await products.create({ name: '原始名称' });
  await assert.rejects(
    products.update(created.id, { name: '未带版本' }),
    { code: 'VERSION_REQUIRED', status: 428 },
  );
  const updated = await products.update(created.id, { name: '新名称', version: 1 });
  assert.equal(updated.version, 2);
  assert.equal(updated.name, '新名称');
  await assert.rejects(
    products.update(created.id, { name: '旧版本覆盖', version: 1 }),
    { code: 'VERSION_CONFLICT', status: 409 },
  );
  const current = await products.get(created.id);
  assert.equal(current.version, 2);
  assert.equal(current.name, '新名称');
  assert.equal((await products.versions(created.id)).total, 2);
});

test('each successful edit appends an immutable snapshot in order', async () => {
  const products = service();
  const created = await products.create({ name: '版本商品' });
  const v2 = await products.update(created.id, { name: '版本商品 v2', version: 1 });
  const v3 = await products.update(created.id, {
    version: 2,
    skus: [{ price: { amount: 12.34, currency: 'CNY' } }],
  });
  assert.equal(v2.version, 2);
  assert.equal(v3.version, 3);
  const history = await products.versions(created.id);
  assert.equal(history.total, 3);
  assert.deepEqual(history.versions.map(item => item.version), [3, 2, 1]);
  assert.equal(history.versions[2].snapshot.name, '版本商品');
  assert.equal(history.versions[1].snapshot.name, '版本商品 v2');
  assert.equal(history.versions[0].snapshot.skus[0].price.amount, 12.34);
  // The old snapshot is unaffected by later edits.
  assert.equal(history.versions[1].snapshot.skus[0].price.amount, null);
});

test('confirming sets the confirmed status once and is idempotent', async () => {
  const products = service();
  const created = await products.create({ name: '待确认商品' });
  const confirmed = await products.confirm(created.id);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.version, 2);
  assert.ok(confirmed.confirmedAt);
  const again = await products.confirm(created.id);
  assert.equal(again.version, 2);
  assert.equal((await products.versions(created.id)).total, 2);
  await assert.rejects(
    products.confirm(created.id, { version: 1 }),
    { code: 'VERSION_CONFLICT' },
  );
});

test('list searches name, brand and SKU, filters status/source and paginates with total', async () => {
  const products = service();
  const a = await products.create({ name: '折叠收纳箱', brand: '收纳家', sourceType: 'manual' });
  const b = await products.create({
    name: '便携水杯', sourceType: 'link', status: 'pending', skus: [{ internalSku: 'CUP-001', spec: '500ml' }],
  });
  const c = await products.create({ name: '桌面台灯', brand: '亮屋', sourceType: 'manual' });
  await products.confirm(a.id);

  const byName = await products.list({ q: '收纳' });
  assert.deepEqual(byName.products.map(item => item.id), [a.id]);
  const bySku = await products.list({ q: 'cup-001' });
  assert.deepEqual(bySku.products.map(item => item.id), [b.id]);
  const byBrand = await products.list({ q: '亮屋' });
  assert.deepEqual(byBrand.products.map(item => item.id), [c.id]);
  const confirmed = await products.list({ status: 'confirmed' });
  assert.deepEqual(confirmed.products.map(item => item.id), [a.id]);
  const links = await products.list({ source: 'link' });
  assert.deepEqual(links.products.map(item => item.id), [b.id]);

  const page = await products.list({ limit: 2, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.products.length, 2);
  assert.equal(page.nextOffset, 2);
  const last = await products.list({ limit: 2, offset: 2 });
  assert.equal(last.products.length, 1);
  assert.equal(last.nextOffset, null);
  await assert.rejects(products.list({ status: 'unknown' }), { code: 'INVALID_FILTER' });
  await assert.rejects(products.list({ limit: 101 }), { code: 'INVALID_PAGINATION' });
});

test('HTTP endpoints enforce CSRF, optimistic locking and cross-request consistency', async t => {
  const productService = service();
  const server = createServer({
    products: productService,
    port: 0,
    root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const createHeaders = { ...jsonHeaders, 'X-CSRF-Token': session.csrfToken };

  const denied = await fetch(base + '/api/products', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: '无令牌' }),
  });
  assert.equal(denied.status, 403);

  const createdResponse = await fetch(base + '/api/products', {
    method: 'POST', headers: createHeaders, body: JSON.stringify({ name: '仅名称商品' }),
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get('etag'), '"v1"');
  const created = (await createdResponse.json()).product;
  assert.equal(created.status, 'draft');
  assert.equal(created.skus[0].price.amount, null);

  const read = await (await fetch(base + '/api/products/' + created.id)).json();
  assert.equal(read.product.name, '仅名称商品');
  assert.equal(read.product.version, 1);
  assert.equal(read.product.skus[0].price.amount, null);

  const noVersion = await fetch(base + '/api/products/' + created.id, {
    method: 'PATCH', headers: createHeaders, body: JSON.stringify({ name: '缺版本' }),
  });
  assert.equal(noVersion.status, 428);

  const firstEdit = await fetch(base + '/api/products/' + created.id, {
    method: 'PATCH',
    headers: { ...createHeaders, 'If-Match': '"v1"' },
    body: JSON.stringify({ name: '第一次修改' }),
  });
  assert.equal(firstEdit.status, 200);
  const v2 = (await firstEdit.json()).product;
  assert.equal(v2.version, 2);

  const staleEdit = await fetch(base + '/api/products/' + created.id, {
    method: 'PATCH', headers: createHeaders, body: JSON.stringify({ name: '旧版本', version: 1 }),
  });
  assert.equal(staleEdit.status, 409);
  assert.equal((await staleEdit.json()).error.code, 'VERSION_CONFLICT');

  const secondEdit = await fetch(base + '/api/products/' + created.id, {
    method: 'PATCH', headers: createHeaders, body: JSON.stringify({ version: 2, brand: '收纳家' }),
  });
  assert.equal(secondEdit.status, 200);
  assert.equal((await secondEdit.json()).product.version, 3);

  const versions = await (await fetch(base + '/api/products/' + created.id + '/versions')).json();
  assert.equal(versions.total, 3);
  assert.deepEqual(versions.versions.map(item => item.version), [3, 2, 1]);

  const confirmed = await fetch(base + '/api/products/' + created.id + '/confirm', {
    method: 'POST', headers: createHeaders, body: JSON.stringify({ version: 3 }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).product.status, 'confirmed');

  const list = await (await fetch(base + '/api/products?q=修改&source=manual')).json();
  assert.equal(list.total, 1);
  assert.equal(list.products[0].id, created.id);
});
