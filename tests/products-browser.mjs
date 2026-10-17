import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// React 商品页接口烟测（Issue #28）：确认列表来自服务端、不再使用本地商品种子。
// 所有 /api/** 都由 page.route 模拟；不写数据库、不上传文件、不产生付费任务。
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const PRODUCT = {
  id: '11111111-1111-4111-8111-111111111111', name: '服务端收纳盒', brand: '测试品牌', category: '收纳用品',
  description: '来自模拟服务端的商品。', sourceType: 'manual', sourcePlatform: null, sourceUrl: null,
  sourceProductId: null, status: 'confirmed', version: 2, createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z', confirmedAt: '2026-10-21T08:00:00.000Z',
  skus: [{
    id: '22222222-2222-4222-8222-222222222222', internalSku: 'TEST-001', spec: '白色',
    parameters: [{ name: '材质', value: 'PP', unit: null }],
    price: { amount: 69, min: null, max: null, currency: 'CNY', type: 'sale', condition: null, capturedAt: null },
  }],
};
await mkdir('.secrets', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET' && method !== 'HEAD') writes.push(`${method} ${path}`);
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/session') return json({ csrfToken: 'test-csrf', mode: 'local-single-user', billing: '测试环境' });
    if (path === '/api/models') return json({ providers: [], models: [] });
    if (path === '/api/jobs') return json({ jobs: [] });
    if (path === '/api/products') {
      const q = (new URL(request.url()).searchParams.get('q') || '').toLowerCase();
      const rows = q && !`${PRODUCT.name} ${PRODUCT.brand} ${PRODUCT.skus[0].internalSku}`.toLowerCase().includes(q) ? [] : [PRODUCT];
      return json({ products: rows, total: rows.length, limit: 10, offset: 0, nextOffset: null });
    }
    if (path === `/api/products/${PRODUCT.id}/versions`) {
      return json({ productId: PRODUCT.id, version: 2, versions: [{ id: 'ver_2', version: 2, changeReason: '确认资料', createdAt: PRODUCT.updatedAt }], total: 1, limit: 8, offset: 0, nextOffset: null });
    }
    if (path === `/api/products/${PRODUCT.id}`) return json({ product: PRODUCT });
    if (path === '/api/product-images') return json({ images: [], total: 0, limit: 20, offset: 0, nextOffset: null });
    return json({ error: { code: 'TEST_UNMOCKED', message: '测试未模拟该接口。' } }, 404);
  });

  await page.goto(base);
  await page.locator('[data-nav="products"]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(1);
  await expect(page.locator('#product-detail h2')).toHaveText('服务端收纳盒');
  await expect(page.locator('#product-detail')).toContainText('/ v2');
  await expect(page.locator('#product-use')).toBeEnabled();
  assert.equal(await page.evaluate(() => localStorage.getItem('sj:prototype:products:v1')), null, '不应再写本地商品键');

  await page.locator('#products-search').fill('没有这个商品');
  await expect(page.locator('[data-product-id]')).toHaveCount(0);
  await page.locator('#products-clear-filter').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.gen-mobile-nav [data-screen="products"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  await page.screenshot({ path: '.secrets/products-server-smoke.png', fullPage: true });
  console.log('Products browser smoke passed: server list/detail, no local product key, search/clear, mobile; no API writes.');
} finally {
  await browser.close();
}
