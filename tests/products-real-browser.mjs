import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// 商品页真实接口验收（Issue #28）。所有 /api/** 都由 page.route 在内存中模拟：
// 不连接数据库、不写入 MinIO、不调用真实模型，也不产生付费任务。
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const CSRF = 'test-csrf';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
  'base64',
);
const NOW = '2026-10-21T08:00:00.000Z';
const STATUS_LABELS = { draft: '草稿', pending: '待核实', confirmed: '已确认' };

function serverProduct(index = 1, overrides = {}) {
  const number = String(index).padStart(2, '0');
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    name: `服务端商品 ${number}`,
    brand: '测试品牌',
    category: '收纳用品',
    description: '来自模拟服务端的真实商品资料。',
    sourceType: 'manual',
    sourcePlatform: null,
    sourceUrl: null,
    sourceProductId: null,
    status: 'confirmed',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    confirmedAt: NOW,
    skus: [{
      id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
      internalSku: `SKU-${number}`,
      spec: '白色 / 单个装',
      parameters: [{ name: '材质', value: 'PP', unit: null }],
      price: { amount: 69, min: null, max: null, currency: 'CNY', type: 'sale', condition: '单个装', capturedAt: NOW },
    }],
    ...overrides,
  };
}

function productFromBody(body, existing, id, version) {
  const sku = body.skus?.[0] || {};
  const price = sku.price || {};
  const previousSku = existing?.skus?.[0] || {};
  return {
    ...(existing || {}),
    id,
    name: body.name,
    brand: body.brand ?? null,
    category: body.category ?? null,
    description: body.description ?? null,
    sourceType: body.sourceType || existing?.sourceType || 'manual',
    sourceUrl: body.sourceUrl !== undefined ? body.sourceUrl : (existing?.sourceUrl ?? null),
    sourcePlatform: body.sourcePlatform !== undefined ? body.sourcePlatform : (existing?.sourcePlatform ?? null),
    sourceProductId: body.sourceProductId !== undefined ? body.sourceProductId : (existing?.sourceProductId ?? null),
    status: body.status || 'draft',
    version,
    createdAt: existing?.createdAt || NOW,
    updatedAt: NOW,
    confirmedAt: body.status === 'confirmed' ? NOW : null,
    skus: [{
      id: previousSku.id || `sku_${id}`,
      internalSku: sku.internalSku ?? null,
      spec: sku.spec ?? null,
      parameters: sku.parameters || [],
      price: {
        amount: price.amount ?? null,
        min: price.min ?? null,
        max: price.max ?? null,
        currency: price.currency ?? null,
        type: price.type ?? null,
        condition: price.condition ?? null,
        capturedAt: NOW,
      },
    }],
  };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('.secrets', { recursive: true });
try {
  async function open({ authOn = false, role = 'admin', authenticated = true, dataset, visionReady = true } = {}) {
    let products = (dataset || [serverProduct(1), serverProduct(2, { name: '待核实商品', status: 'pending' })]).map(product => structuredClone(product));
    const images = [];
    const requests = [];
    let uploadSeq = 0;
    let projectSeq = 0;
    const state = {
      authOn, role, authenticated, products, images, visionReady,
      get writes() { return requests.filter(entry => entry.method !== 'GET'); },
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const json = (route, body, status = 200) => route.fulfill({ status, json: body });
    const fail = (route, status, code, message) => json(route, { error: { code, message } }, status);
    const findProduct = id => products.find(product => product.id === id);

    await page.route('**/api/**', async route => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const path = url.pathname;
      let body = null;
      if (method !== 'GET' && method !== 'HEAD' && !path.endsWith('/file')) {
        try { body = request.postDataJSON(); } catch { body = null; }
      }
      const entry = { method, path, body, search: url.searchParams, buffer: method === 'POST' && path === '/api/product-images' ? request.postDataBuffer() : null };
      requests.push(entry);

      if (path === '/api/session' && method === 'GET') {
        if (!authOn) return json(route, { csrfToken: CSRF, mode: 'local-single-user', billing: '测试环境' });
        if (!state.authenticated) return json(route, {
          csrfToken: CSRF, mode: 'account', authenticated: false, user: null,
          mustChangePassword: false, setupRequired: false,
        });
        return json(route, {
          csrfToken: CSRF, mode: 'account', authenticated: true,
          user: { id: `user_${role}`, workspaceId: 'ws_test', email: `${role}@example.test`, displayName: role, role, active: true, mustChangePassword: false },
          mustChangePassword: false, setupRequired: false,
        });
      }
      if (path === '/api/session' && method === 'DELETE') return json(route, { ok: true });
      if (path === '/api/models' && method === 'GET') return json(route, { providers: [], models: [] });
      if (path === '/api/jobs' && method === 'GET') return json(route, { jobs: [] });

      if (path === '/api/products' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const statuses = (url.searchParams.get('status') || '').split(',').filter(Boolean);
        const sources = (url.searchParams.get('source') || '').split(',').filter(Boolean);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const filtered = products.filter(product => {
          const haystack = [product.name, product.brand, product.skus?.[0]?.internalSku].join(' ').toLowerCase();
          return (!q || haystack.includes(q))
            && (!statuses.length || statuses.includes(product.status))
            && (!sources.length || sources.includes(product.sourceType));
        });
        const pageRows = filtered.slice(offset, offset + limit);
        return json(route, {
          products: pageRows, total: filtered.length, limit, offset,
          nextOffset: offset + pageRows.length < filtered.length ? offset + pageRows.length : null,
        });
      }
      if (path === '/api/products' && method === 'POST') {
        if (!body?.name) return fail(route, 400, 'INVALID_PRODUCT', '商品名称为必填项。');
        const id = `33333333-3333-4333-8333-${String(products.length + 1).padStart(12, '0')}`;
        const product = productFromBody(body, null, id, 1);
        products.unshift(product);
        return json(route, { product }, 201);
      }

      const versionsMatch = path.match(/^\/api\/products\/([^/]+)\/versions$/);
      if (versionsMatch && method === 'GET') {
        const product = findProduct(decodeURIComponent(versionsMatch[1]));
        if (!product) return fail(route, 404, 'PRODUCT_NOT_FOUND', '商品不存在。');
        const list = Array.from({ length: product.version }, (_, index) => ({
          id: `ver_${product.id}_${index + 1}`, version: index + 1,
          changeReason: index === 0 ? '创建商品' : '资料更新', createdAt: NOW,
        })).reverse();
        return json(route, { productId: product.id, version: product.version, versions: list, total: list.length, limit: 8, offset: 0, nextOffset: null });
      }
      const confirmMatch = path.match(/^\/api\/products\/([^/]+)\/confirm$/);
      if (confirmMatch && method === 'POST') {
        const product = findProduct(decodeURIComponent(confirmMatch[1]));
        if (!product) return fail(route, 404, 'PRODUCT_NOT_FOUND', '商品不存在。');
        if (Number(body?.version) !== product.version) {
          return fail(route, 409, 'VERSION_CONFLICT', `商品已被其他修改更新到 v${product.version}，请刷新后重试。`);
        }
        product.status = 'confirmed';
        product.confirmedAt = NOW;
        product.version += 1;
        product.updatedAt = NOW;
        return json(route, { product });
      }
      const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch) {
        const product = findProduct(decodeURIComponent(productMatch[1]));
        if (!product) return fail(route, 404, 'PRODUCT_NOT_FOUND', '商品不存在。');
        if (method === 'GET') return json(route, { product });
        if (method === 'PATCH') {
          if (!body || body.version === undefined) return fail(route, 428, 'VERSION_REQUIRED', '编辑商品需提供 version。');
          if (Number(body.version) !== product.version) {
            return fail(route, 409, 'VERSION_CONFLICT', `商品已被其他修改更新到 v${product.version}，请刷新后重试。`);
          }
          const updated = productFromBody(body, product, product.id, product.version + 1);
          const index = products.findIndex(item => item.id === product.id);
          products[index] = updated;
          return json(route, { product: updated });
        }
      }

      if (path === '/api/product-images' && method === 'GET') {
        const productId = url.searchParams.get('productId');
        const kind = url.searchParams.get('kind');
        const rows = images.filter(image => (!productId || image.productId === productId) && (!kind || image.kind === kind));
        return json(route, { images: rows, total: rows.length, limit: 20, offset: 0, nextOffset: null });
      }
      if (path === '/api/product-images' && method === 'POST') {
        uploadSeq += 1;
        const image = {
          id: `img_${uploadSeq}`, productId: url.searchParams.get('productId') || null,
          kind: url.searchParams.get('kind') || 'screenshot', contentType: 'image/png', extension: 'png',
          bytes: entry.buffer?.length || PNG.length, width: 1, height: 1, sha256: `sha_${uploadSeq}`,
          createdAt: NOW, url: `/api/product-images/img_${uploadSeq}/file`,
        };
        images.push(image);
        return json(route, { image }, 201);
      }
      const fileMatch = path.match(/^\/api\/product-images\/([^/]+)\/file$/);
      if (fileMatch && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      }

      if (path === '/api/link-parse' && method === 'POST') {
        if (!body?.url) return fail(route, 400, 'URL_REQUIRED', '请提供商品链接。');
        if (body.url.includes('fail')) {
          return json(route, { status: 'failed', platform: '1688', source: { url: body.url }, draft: null, evidence: [], confidence: { name: 'none', price: 'none', parameters: 'none' }, warnings: [], reason: '页面需要登录，未能读取商品名称；未生成草稿。' });
        }
        const partial = body.url.includes('partial');
        return json(route, {
          status: partial ? 'partial' : 'parsed', platform: '1688', source: { url: body.url },
          draft: {
            verification: 'pending', sourceType: 'link', sourcePlatform: '1688', sourceUrl: body.url,
            sourceProductId: '6688990011', name: '竹木托盘', originalTitle: '竹木托盘 长方形',
            description: partial ? '' : '模拟解析的商品说明。',
            parameters: partial ? [] : [{ name: '材质', value: '竹', unit: null }],
            prices: partial ? [] : [{ amount: 49.9, min: null, max: null, currency: 'CNY', type: 'sale', condition: null }],
          },
          evidence: [], confidence: { name: 'high', price: partial ? 'none' : 'high', parameters: partial ? 'none' : 'high' },
          warnings: partial ? ['仅完成部分字段解析，价格与参数缺失。'] : [],
          reason: partial ? '仅完成部分字段解析，缺失项需人工补充。' : null,
        });
      }

      if (path === '/api/intake/screenshot/preflight' && method === 'POST') {
        return json(route, {
          capability: 'screenshot-intake', fingerprint: 'fp_test', imageCount: body?.imageIds?.length || 0,
          images: [], duplicate: false, existing: null,
          vision: state.visionReady
            ? { ready: true, adapter: 'test-vision', registered: true, reason: null }
            : { ready: false, adapter: null, registered: false, reason: '视觉模型供应商与模型尚未确认（Q-02），未发送截图。' },
          billing: { billed: false, note: '使用视觉渠道时按供应商实际账单计费。' },
          notices: [],
        });
      }
      if (path === '/api/intake/screenshot' && method === 'POST') {
        const imageIds = body?.imageIds || [];
        if (!Array.isArray(imageIds) || !imageIds.length) return fail(route, 400, 'IMAGE_REQUIRED', '请提供图片。');
        if (!state.visionReady) return fail(route, 503, 'VISION_NOT_CONFIGURED', '视觉模型供应商与模型尚未确认（Q-02）。');
        const id = `44444444-4444-4444-8444-${String(products.length + 1).padStart(12, '0')}`;
        const product = serverProduct(products.length + 1, {
          id, name: '燕麦色陶瓷杯', status: 'pending', sourceType: 'screenshot', confirmedAt: null,
        });
        products.unshift(product);
        for (const image of images) {
          if (imageIds.includes(image.id) && !image.productId) image.productId = id;
        }
        return json(route, {
          intakeId: 'intake_1', fingerprint: 'fp_test', status: 'completed', productCreated: true,
          product, duplicate: false, billed: false, attempts: 1, requestKey: null,
          review: { missing: ['价格'], fields: [{ field: 'name', value: '燕麦色陶瓷杯', confidence: 0.93, needsReview: false }], warnings: ['价格缺失，需人工补充。'], lowConfidence: [] },
          billing: { billed: false, note: '测试未调用真实模型。' },
        }, 201);
      }

      if (path === '/api/projects' && method === 'POST') {
        projectSeq += 1;
        const product = findProduct(body?.productId);
        if (!product) return fail(route, 404, 'PRODUCT_NOT_FOUND', '商品不存在。');
        if (product.skus?.[0]?.id !== body?.skuId) return fail(route, 400, 'SKU_MISMATCH', '商品与 SKU 不匹配。');
        return json(route, {
          project: { id: `prj_${projectSeq}`, name: body.name || product.name, status: 'draft', productId: product.id, skuId: body.skuId },
          plan: { version: 1, status: 'draft' },
        }, 201);
      }

      return fail(route, 404, 'TEST_UNMOCKED', `测试未模拟接口：${method} ${path}`);
    });

    await page.goto(base);
    return { page, context, state, requests, errors };
  }

  // 1. 主流程：分页 / 搜索 / 筛选 / 建档 / 冲突 / 版本 / 确认 / 用于创作。
  {
    const dataset = Array.from({ length: 12 }, (_, index) => serverProduct(index + 1, index === 11 ? { status: 'pending' } : {}));
    const { page, context, state, requests, errors } = await open({ dataset });
    const rows = page.locator('[data-product-id]');
    await page.locator('[data-nav="products"]').click();
    await expect(page.locator('#products-list')).toBeVisible();
    await expect(rows).toHaveCount(10);
    await expect(page.locator('#products-count')).toContainText('10 件 / 共 12 件');
    await expect(page.locator('#products-next')).toBeEnabled();

    await page.locator('#products-search').fill('不存在的商品');
    await expect(rows).toHaveCount(0);
    await page.locator('#products-clear-filter').click();
    await expect(rows).toHaveCount(10);

    await page.locator('[data-product-filter="pending"]').click();
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#product-use')).toBeDisabled();
    await page.locator('[data-product-filter="all"]').click();
    await expect(rows).toHaveCount(10);

    await page.locator('#products-next').click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#products-count')).toContainText('2 件 / 共 12 件');
    await page.locator('#products-prev').click();
    await expect(rows).toHaveCount(10);

    await rows.first().click();
    await expect(page.locator('#product-detail h2')).toHaveText('服务端商品 01');
    await expect(page.locator('#product-detail')).toContainText('/ v1');
    await expect(page.locator('.product-detail-art')).toContainText('尚未上传商品原图');
    await expect(page.locator('#products-notice')).toContainText('PostgreSQL');

    // 新建并上传原图：文件走真实上传接口，保存后回填服务端图片。
    await page.locator('#product-add').click();
    await page.locator('#product-form [name="name"]').fill('服务端新商品');
    await page.locator('#product-form [name="brand"]').fill('新品牌');
    await page.locator('#product-form [name="sku"]').fill('NEW-001');
    await page.locator('#product-form [name="price"]').fill('12.50');
    await page.locator('#product-form [name="currency"]').selectOption('CNY');
    await page.getByRole('textbox', { name: '参数名', exact: true }).fill('容量');
    await page.getByRole('textbox', { name: '参数值', exact: true }).fill('500');
    await page.getByRole('textbox', { name: '参数单位', exact: true }).fill('mL');
    await page.locator('#product-image').setInputFiles({ name: 'product.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('#product-editor-art img')).toBeVisible();
    await page.locator('#product-form [value="draft"]').click();
    await expect(page.locator('#product-editor')).toBeHidden();
    await expect(page.locator('#product-detail h2')).toHaveText('服务端新商品');
    await expect(page.locator('.product-detail-art img')).toBeVisible();
    await expect(page.locator('#product-use')).toBeDisabled();
    await expect(page.locator('#products-count')).toContainText('共 13 件');
    assert.equal(await page.evaluate(() => localStorage.getItem('sj:prototype:products:v1')), null, '不得再写入本地商品键');
    const created = state.products.find(product => product.name === '服务端新商品');
    assert.ok(created, '模拟服务端应保存新商品');
    assert.equal(requests.filter(entry => entry.method === 'POST' && entry.path === '/api/product-images').length, 1);
    assert.equal(requests.find(entry => entry.path === '/api/product-images' && entry.method === 'POST').search.get('kind'), 'original');

    // 乐观锁：外部先更新到 v2，保存返回 409，页面重新加载并保留输入。
    await page.locator('#product-edit').click();
    await page.locator('#product-form [name="name"]').fill('冲突后保留的草稿');
    created.version = 2;
    created.name = '他人更新后的名称';
    created.brand = '外部修改';
    await page.locator('#product-form [value="draft"]').click();
    await expect(page.locator('#product-form-error')).toContainText('乐观锁冲突');
    await expect(page.locator('#product-save-note')).toContainText('v2');
    await expect(page.locator('#product-form [name="name"]')).toHaveValue('冲突后保留的草稿');
    await page.locator('#product-form [value="draft"]').click();
    await expect(page.locator('#product-editor')).toBeHidden();
    await expect(page.locator('#product-detail h2')).toHaveText('冲突后保留的草稿');
    await expect(page.locator('#product-detail')).toContainText('/ v3');

    // 确认：未勾选提示；勾选后 PATCH 保存再单独确认，版本继续前进。
    await page.locator('#product-edit').click();
    await page.locator('#product-form [value="confirmed"]').click();
    await expect(page.locator('#product-form-error')).toContainText('勾选');
    await page.locator('#product-verified').check();
    await page.locator('#product-form [value="confirmed"]').click();
    await expect(page.locator('#product-editor')).toBeHidden();
    await expect(page.locator('#product-detail')).toContainText('/ v5');
    await expect(page.locator('#product-detail .product-state.confirmed')).toBeVisible();
    await expect(page.locator('#product-versions')).toContainText('共 5 个版本');
    await expect(page.locator('#product-use')).toBeEnabled();

    // 用于创作：调用真实项目草稿接口并携带商品与 SKU。
    await page.locator('#product-use').click();
    await expect(page.locator('#product-use-dialog')).toBeVisible();
    await page.locator('#product-use-create').click();
    await expect(page.locator('#product-use-dialog')).toBeHidden();
    await expect(page.locator('#toast')).toContainText('已创建服务端项目草稿');
    const projectCall = requests.find(entry => entry.method === 'POST' && entry.path === '/api/projects');
    assert.ok(projectCall, '应调用项目草稿接口');
    assert.equal(projectCall.body.productId, state.products.find(product => product.name === '冲突后保留的草稿').id);
    assert.equal(projectCall.body.skuId, state.products.find(product => product.name === '冲突后保留的草稿').skus[0].id);

    // 1688 部分成功：显示 warnings/缺失说明，确认后才建档；失败不建档。
    await page.locator('#product-import').click();
    await page.locator('#product-url').fill('https://detail.1688.com/offer/partial.html');
    await page.locator('#product-parse').click();
    await expect(page.locator('#product-link-draft')).toContainText('竹木托盘');
    await expect(page.locator('#product-link-warnings')).toContainText('仅完成部分字段解析');
    await page.locator('#product-link-create').click();
    await expect(page.locator('#product-importer')).toBeHidden();
    await expect(page.locator('#product-detail h2')).toHaveText('竹木托盘');
    await expect(page.locator('#products-count')).toContainText('共 14 件');
    const linkProduct = state.products.find(product => product.name === '竹木托盘');
    assert.equal(linkProduct.sourceType, 'link');
    assert.equal(linkProduct.status, 'pending');

    await page.locator('#product-import').click();
    await page.locator('#product-url').fill('https://detail.1688.com/offer/fail.html');
    await page.locator('#product-parse').click();
    await expect(page.locator('#product-import-error')).toContainText('未能读取商品名称');
    await expect(page.locator('#product-link-create')).toHaveCount(0);
    await expect(page.locator('#products-count')).toContainText('共 14 件');
    await page.locator('[data-close-import]').first().click();

    // 截图录入：先上传原始文件，再仅把服务端 imageIds 交给识别接口。
    await page.locator('#product-screenshot').click();
    await page.locator('#product-screenshot-file').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('#product-screenshot-submit').click();
    await expect(page.locator('#product-screenshot-dialog')).toBeHidden();
    await expect(page.locator('#product-detail h2')).toHaveText('燕麦色陶瓷杯');
    await expect(page.locator('#products-count')).toContainText('共 15 件');
    const screenshotUploads = requests.filter(entry => entry.method === 'POST' && entry.path === '/api/product-images');
    const screenshotUpload = screenshotUploads[screenshotUploads.length - 1];
    assert.equal(screenshotUpload.search.get('kind'), 'screenshot');
    assert.ok(screenshotUpload.buffer.length > 0, '截图应以原始二进制上传');
    const screenshotImageId = `img_${screenshotUploads.length}`;
    const preflightCall = requests.find(entry => entry.path === '/api/intake/screenshot/preflight');
    const intakeCall = requests.find(entry => entry.path === '/api/intake/screenshot' && entry.method === 'POST');
    assert.deepEqual(preflightCall.body.imageIds, [screenshotImageId]);
    assert.deepEqual(intakeCall.body.imageIds, [screenshotImageId]);
    assert.equal(JSON.stringify(intakeCall.body).includes('base64'), false, '识别接口不得收到文件内容');
    const screenshotProduct = state.products.find(product => product.name === '燕麦色陶瓷杯');
    assert.equal(screenshotProduct.sourceType, 'screenshot');
    await expect(page.locator('#product-detail')).toContainText('来源截图证据');

    // 视觉模型未配置：明确报告，不上传后伪造识别结果，也不建档。
    state.visionReady = false;
    await page.locator('#product-screenshot').click();
    await page.locator('#product-screenshot-file').setInputFiles({ name: 'shot2.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('#product-screenshot-submit').click();
    await expect(page.locator('#product-screenshot-error')).toContainText('视觉模型供应商与模型尚未确认');
    await expect(page.locator('#product-screenshot-dialog')).toBeVisible();
    await expect(page.locator('#products-count')).toContainText('共 15 件');
    await page.locator('[data-close-screenshot]').first().click();

    assert.equal(requests.some(entry => entry.method === 'POST' && entry.path === '/api/jobs'), false, '不得创建生成任务');
    assert.equal(requests.some(entry => entry.path === '/api/channels'), false, '不得修改渠道');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '.secrets/products-real-desktop.png', fullPage: true });

    // 移动端：列表与编辑弹窗都不横向溢出。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.gen-mobile-nav [data-screen="products"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '商品页移动端溢出');
    await page.locator('#product-add').click();
    assert.equal(await page.locator('#product-editor').evaluate(el => el.scrollWidth > el.clientWidth), false, '编辑弹窗移动端溢出');
    await page.locator('[data-close-editor]').first().click();
    await page.screenshot({ path: '.secrets/products-real-mobile.png', fullPage: true });
    await context.close();
  }

  // 2. 权限：viewer 禁用全部写入口，operator/admin 可用；前端不替代服务端鉴权。
  for (const role of ['viewer', 'operator', 'admin']) {
    const { page, context, requests, errors } = await open({ authOn: true, role, dataset: [serverProduct(1)] });
    await page.locator('[data-nav="products"]').click();
    await expect(page.locator('[data-product-id]')).toHaveCount(1);
    const writer = role !== 'viewer';
    await expect(page.locator('#product-add')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#product-screenshot')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#product-import')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#product-edit')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#product-use')).toBeEnabled({ enabled: writer });
    if (!writer) await expect(page.locator('#products-notice')).toContainText('只读角色');
    assert.equal(requests.some(entry => entry.method !== 'GET'), false, `${role} 不应产生写请求`);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. 未登录：只显示登录页，不请求商品接口。
  {
    const { page, context, requests, errors } = await open({ authOn: true, role: 'admin', authenticated: false });
    await expect(page.locator('[data-auth-screen="login"]')).toBeVisible();
    await expect(page.locator('.app')).toHaveCount(0);
    await page.waitForTimeout(500);
    assert.equal(requests.some(entry => entry.path === '/api/products'), false, '未登录不得读取商品');
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log('Products real API browser checks passed: server list/search/filter/pagination, create with upload, 409 conflict reload, versions, confirm, project draft, link parse partial/failure, screenshot imageIds only, permissions, unauthenticated and mobile. All APIs mocked; no database, storage or paid tasks.');
} finally {
  await browser.close();
}
