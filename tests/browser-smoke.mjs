import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';

// React 真实生图与渠道入口烟测。
// 页面由测试内静态服务器从 web/dist 提供；全部 /api/** 由 Playwright 模拟，
// 不连接数据库 / MinIO，也不向供应商提交任何付费任务。

const DIST = new URL('../web/dist/', import.meta.url);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nX0AAAAASUVORK5CYII=',
  'base64',
);
const MODEL = {
  id: 'omyai-openai:gpt-image-2.5-flare', providerId: 'omyai-openai', providerName: 'OMYAI（OpenAI 标准）',
  upstreamModel: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', kind: 'image',
  operations: ['generate', 'edit'], sizes: ['1024x1024'], qualities: ['low'], default: true, executable: true,
};
const PRODUCT = { id: '22222222-2222-4222-8222-222222222222', name: '白色陶瓷杯' };
const ORIGINAL = {
  id: '33333333-3333-4333-8333-333333333333', kind: 'original', productId: PRODUCT.id,
  width: 256, height: 256, bytes: 139546, contentType: 'image/png', extension: 'png',
  url: '/api/product-images/33333333-3333-4333-8333-333333333333/file',
};
const JOB = {
  id: '11111111-1111-4111-8111-111111111111', status: 'succeeded', modelId: MODEL.id,
  prompt: '验收图片', size: '1024x1024', quality: 'low', operation: 'generate',
  sourceJobId: null, sourceAssetId: null,
  createdAt: '2026-10-21T08:00:00.000Z', updatedAt: '2026-10-21T08:00:00.000Z',
  error: null, cost: null, imageUrl: '/api/jobs/11111111-1111-4111-8111-111111111111/image', imageBytes: PNG.length,
};

async function startStatic() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (relative!=='index.html'
        && !/^assets\/[A-Za-z0-9_.-]+\.(js|css|webp)$/.test(relative)) {
        res.writeHead(404); res.end('not found'); return;
      }
      const data = await readFile(new URL(relative, DIST));
      res.writeHead(200, { 'Content-Type': MIME[relative.slice(relative.lastIndexOf('.'))] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(500); res.end('dist missing; run npm run build');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// 会话、模型与任务读取的公共模拟；个别场景可覆盖 jobs 的读写。
async function mockBase(page, { jobs = [JOB], submitted = [] } = {}) {
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/session' && method === 'GET') {
      return json({ csrfToken: 'smoke-csrf', mode: 'local-single-user', billing: '以供应商实际账单为准。' });
    }
    if (path === '/api/models' || path === '/api/models/refresh') return json({ providers: [], models: [MODEL] });
    if (path === '/api/jobs' && method === 'GET') return json({ jobs });
    if (path === '/api/jobs' && method === 'POST') {
      // 只记录请求体；不连接任何供应商。
      const body = request.postDataJSON();
      submitted.push(body);
      return json({ ...JOB, id: body.requestId, status: 'queued', imageUrl: null, ...body }, 202);
    }
    if (path === '/api/products' && method === 'GET') return json({ products: [PRODUCT], total: 1 });
    if (path === '/api/product-images' && method === 'GET') return json({ images: [ORIGINAL], total: 1 });
    if (path === '/api/product-images/preflight' && method === 'POST') {
      const body = request.postDataJSON();
      return json({ allowed: true, image: ORIGINAL, providerId: body.providerId, modelId: body.modelId, operation: 'edit', protocol: 'openai-images-edits-v1', transport: 'json-data-url' });
    }
    if (path === ORIGINAL.url) {
      return route.fulfill({ status: 200, body: PNG, headers: { 'content-type': 'image/png' } });
    }
    if (path === `/api/jobs/${JOB.id}/image`) {
      return route.fulfill({ status: 200, body: PNG, headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="result.png"' } });
    }
    return json({ error: { code: 'TEST_UNMOCKED', message: `${method} ${path}` } }, 404);
  });
}

const { server, base } = await startStatic();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('.secrets', { recursive: true });
// 真实单图面板没有独立导航项；?screen=generation 深链直接打开，避免依赖演示项目。
const studioUrl = `${base}/?screen=generation`;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const submitted = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockBase(page, { submitted });
  await page.goto(studioUrl);
  await expect.poll(() => page.locator('#gen-model option').count()).toBeGreaterThan(0);
  await expect(page.locator('#gen-model')).toBeEnabled();
  await expect(page.locator('#gen-consent')).not.toBeChecked();
  await expect(page.locator('#gen-submit')).toBeDisabled();

  const image = page.locator('#gen-list img').first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  const href = await page.locator('#gen-result-grid a').first().getAttribute('href');
  assert.ok(href.startsWith(JOB.imageUrl), href);
  const download = await page.evaluate(async url => {
    const response = await fetch(url);
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
    };
  }, href);
  assert.equal(download.status, 200);
  assert.match(download.type, /^image\//);
  assert.match(download.disposition, /^attachment/);
  const edit = page.locator('[data-result-edit]:enabled').first();
  if (await edit.count()) {
    await edit.click();
    await expect(page.locator('#gen-source')).toBeVisible();
    await page.locator('#gen-new').click();
  }

  // 商品原图：页面只显示服务端登记的编号/地址，提交体只带 sourceAssetId。
  await page.locator('#gen-ref-original').click();
  await page.locator('[data-product-original]').first().click();
  await page.locator('[data-original-image]').first().click();
  await expect(page.locator('#gen-source img')).toHaveAttribute('src', ORIGINAL.url);
  await page.locator('#gen-prompt').fill('把背景换成米白色棚拍背景，保留商品主体。');
  await page.locator('#gen-consent').check();
  await expect(page.locator('#gen-submit')).toBeEnabled();
  await page.locator('#gen-submit').click();
  await expect.poll(() => submitted.length).toBe(1);
  assert.equal(submitted[0].operation, 'edit');
  assert.equal(submitted[0].sourceAssetId, ORIGINAL.id);
  assert.equal(submitted[0].sourceJobId, undefined);
  await page.locator('#gen-new').click();
  await page.screenshot({ path: '.secrets/image-studio-desktop.png', fullPage: true });

  await page.locator('[data-nav="system"]').click();
  await page.locator('[data-rv="system-tab"][data-id="models"]').click();
  await page.locator('[data-rv="real-system"]').click();
  await expect.poll(() => page.locator('#real-model-table .gen-card').count()).toBeGreaterThan(0);

  await page.goto(studioUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '.secrets/image-studio-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();

  // Simulate a lost response: reload must reuse the original ID and immutable parameters.
  const context = await browser.newContext();
  const requests = [];
  let knownJobs = [];
  await context.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/session' && method === 'GET') {
      return json({ csrfToken: 'smoke-csrf', mode: 'local-single-user', billing: '以供应商实际账单为准。' });
    }
    if (path === '/api/models') return json({ providers: [], models: [MODEL] });
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: knownJobs });
    if (path === '/api/jobs' && method === 'POST') {
      const body = request.postDataJSON();
      requests.push(body);
      // 第一次模拟响应丢失：客户端必须用同一请求编号和参数恢复。
      if (requests.length === 1) return route.abort('failed');
      const job = { id: body.requestId, ...body, status: 'queued', createdAt: new Date().toISOString() };
      knownJobs = [job];
      return json(job, 202);
    }
    return json({ error: { code: 'TEST_UNMOCKED', message: `${method} ${path}` } }, 404);
  });
  const simulated = await context.newPage();
  await simulated.goto(studioUrl);
  await expect(simulated.locator('#gen-model')).toBeEnabled();
  await simulated.locator('#gen-prompt').fill('Mocked request only; no upstream generation');
  await simulated.locator('#gen-consent').check();
  await simulated.locator('#gen-submit').click();
  await expect(simulated.locator('#gen-submit')).toBeEnabled();
  assert.equal(requests.length, 1);
  await simulated.reload();
  await expect(simulated.locator('#gen-prompt')).toBeDisabled();
  await expect(simulated.locator('#gen-submit')).toBeEnabled();
  await simulated.locator('#gen-submit').click();
  await expect.poll(() => requests.length).toBe(2);
  assert.deepEqual(requests[0], requests[1]);
  await expect(simulated.locator('#gen-list [data-open-job]')).toHaveCount(1);
  await context.close();
  console.log('Browser checks passed: models, persisted image/download, edit selection, mobile navigation/layout, interrupted-submit recovery. All APIs mocked; no paid submissions.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
