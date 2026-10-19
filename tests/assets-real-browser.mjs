import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// React 素材页真实索引验收（Issue #4 / 素材页接入）。
// 前端由测试内静态服务器从 web/dist 提供；全部 /api/** 由 page.route 模拟，
// 不连接 PostgreSQL / Redis / MinIO，不读取对象存储，也不产生任何付费任务。
// 覆盖：列表与汇总、搜索防抖、来源筛选、游标加载更多、详情与版本链、
// 410 缺文件提示、错误重试、viewer 只读、模板页仍可用、390px 无横向溢出。

const DIST = new URL('../web/dist/', import.meta.url);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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

const ID = {
  a1: '11111111-1111-4111-8111-111111111111',
  a2: '22222222-2222-4222-8222-222222222222',
  a3: '33333333-3333-4333-8333-333333333333',
  a4: '44444444-4444-4444-8444-444444444444',
  a5: '55555555-5555-4555-8555-555555555555',
};
const CSRF = 'assets-test-csrf';
const NOW = '2026-10-21T10:00:00.000Z';

function asset(id, {
  sourceType = 'generation', title = '', prompt = '', available = true,
  version = 1, bytes = 1024, createdAt = NOW, sourceJobId = null,
} = {}) {
  return {
    id, sourceType, sourceId: `job-${id}`, version, sourceVersion: version,
    mediaType: 'image', title, prompt, modelId: 'test:image', providerId: 'test',
    operation: sourceType === 'edit' ? 'edit' : 'generate', size: '1024x1024', quality: 'low',
    sourceJobId, contentType: 'image/png', filename: `${id}.png`, bytes,
    available, missingReason: available ? null : '对象存储中找不到文件',
    rootId: id, parentId: null, createdAt, indexedAt: createdAt, updatedAt: createdAt,
    imageUrl: `/api/assets/${id}/image`, downloadUrl: `/api/assets/${id}/download`,
  };
}

const ALL = [
  asset(ID.a1, { title: '白色收纳盒 · 白底主图', prompt: '白色收纳盒，纯白无缝背景，正面居中' }),
  asset(ID.a2, { sourceType: 'edit', title: '白色收纳盒 · 木桌场景', prompt: '白色收纳盒，木质桌面场景，柔和侧光', version: 2, sourceJobId: ID.a1 }),
  asset(ID.a3, { title: '缺文件素材', prompt: '对象被误删的素材', available: false }),
  asset(ID.a4, { title: '厨房收纳盒', prompt: '厨房收纳盒，开放层架' }),
  asset(ID.a5, { sourceType: 'project', title: '项目产出 · 客厅', prompt: '客厅收纳，项目交付产出' }),
];
const SUMMARY = {
  outputs: { total: 5, available: 4, unavailable: 1, bytes: 4096 },
  templates: { total: 3, available: 3, unavailable: 0, bytes: 300 },
};

function filtered(url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase();
  const source = url.searchParams.get('source');
  return ALL.filter(item => {
    if (source && item.sourceType !== source) return false;
    if (!q) return true;
    return `${item.title || ''} ${item.prompt || ''}`.toLowerCase().includes(q);
  });
}

function createState({ role = null, failList = false } = {}) {
  return { role, failList, calls: [], writes: [], errors: [] };
}

function mockApi(page, state) {
  page.on('pageerror', error => state.errors.push(error.message));
  return page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, json: body, headers });
    if (!['GET', 'HEAD'].includes(method)) state.writes.push(`${method} ${path}`);
    if (path.startsWith('/api/assets')) state.calls.push(`${method} ${path}${url.search}`);

    if (path === '/api/session' && method === 'GET') {
      if (state.role) {
        return json({
          csrfToken: CSRF, mode: 'account', authenticated: true,
          user: { id: 'u1', email: `${state.role}@example.test`, role: state.role, active: true, workspaceId: 'local' },
          mustChangePassword: false, setupRequired: false,
        });
      }
      return json({ csrfToken: CSRF, mode: 'local-single-user' });
    }
    if (path === '/api/models' && method === 'GET') return json({ providers: [], models: [] });
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });
    if (path === '/api/dashboard' && method === 'GET') {
      return json({ error: { code: 'NOT_UNDER_TEST', message: '工作台不在素材验收范围。' } }, 503);
    }

    if (path === '/api/assets' && method === 'GET') {
      if (state.failList) {
        return json({ error: { code: 'DB_UNAVAILABLE', message: '素材索引暂不可用，请稍后重试。' } }, 503);
      }
      const rows = filtered(url);
      const cursor = url.searchParams.get('cursor');
      let pageRows = rows;
      let hasMore = false;
      let nextCursor = null;
      if (cursor === 'page-2') {
        pageRows = rows.slice(3);
      } else if (cursor) {
        return json({ error: { code: 'INVALID_CURSOR', message: '分页游标无效，请从第一页重新读取。' } }, 400);
      } else if (rows.length > 3) {
        pageRows = rows.slice(0, 3);
        hasMore = true;
        nextCursor = 'page-2';
      }
      return json({
        assets: pageRows,
        limit: 24,
        hasMore,
        nextCursor,
        summary: SUMMARY,
        filters: { q: url.searchParams.get('q') || '', source: url.searchParams.get('source') || '' },
      });
    }

    const imageMatch = path.match(/^\/api\/assets\/([^/]+)\/image$/);
    if (imageMatch && method === 'GET') {
      // 模拟对象存储里文件缺失：图片请求返回 410，界面必须保留记录并提示。
      if (imageMatch[1] === ID.a2 || imageMatch[1] === ID.a3) {
        return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ASSET_UNAVAILABLE', message: '素材文件缺失，记录仍保留。' } }) });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    const downloadMatch = path.match(/^\/api\/assets\/([^/]+)\/download$/);
    if (downloadMatch && method === 'GET') {
      if (downloadMatch[1] === ID.a3) {
        return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ASSET_UNAVAILABLE', message: '素材文件缺失，记录仍保留。' } }) });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }

    const detailMatch = path.match(/^\/api\/assets\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      if (detailMatch[1] === ID.a3) {
        return json({ error: { code: 'ASSET_UNAVAILABLE', message: '素材文件缺失，记录仍保留。' } }, 410);
      }
      const item = ALL.find(row => row.id === detailMatch[1]);
      if (!item) return json({ error: { code: 'ASSET_NOT_FOUND', message: '素材不存在。' } }, 404);
      const chain = item.id === ID.a1 ? [ALL[0], ALL[1]] : [item];
      return json({ asset: item, rootId: chain[0].id, chain, versions: chain.length });
    }

    return json({ error: { code: 'TEST_UNMOCKED', message: `测试未模拟 ${method} ${path}` } }, 404);
  });
}

async function openPage(browser, base, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const state = createState(options);
  await mockApi(page, state);
  await page.goto(base);
  await expect(page.locator('#root .app')).toHaveCount(1);
  return { context, page, state };
}

const { server, base } = await startStatic();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 1. 列表、汇总、搜索、筛选、加载更多与详情 / 版本链。
  {
    const { context, page, state } = await openPage(browser, base);
    await page.locator('.rail-btn[data-nav="assets"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(3);
    await expect(page.locator('[data-asset-summary]')).toContainText('真实产出');
    await expect(page.locator('[data-asset-summary]')).toContainText('缺文件 1');
    await expect(page.locator('[data-asset-summary]')).toContainText('模板 3');
    await expect(page.locator('[data-view="review"]')).not.toContainText('最多返回最近 50 个任务');

    // 卡片使用真实同源图片地址，懒加载；文件缺失的卡片保留记录。
    const firstImage = page.locator(`[data-asset-id="${ID.a1}"] img`);
    await expect(firstImage).toHaveAttribute('src', `/api/assets/${ID.a1}/image`);
    await expect(firstImage).toHaveAttribute('loading', 'lazy');
    await expect(page.locator(`[data-asset-id="${ID.a2}"] [data-asset-missing]`)).toContainText('文件缺失，记录仍保留');
    await expect(page.locator(`[data-asset-id="${ID.a3}"] [data-asset-missing]`)).toContainText('文件缺失，记录仍保留');

    // 搜索防抖后只保留匹配记录，请求带 q 参数。
    await page.locator('#rv-asset-search').fill('场景');
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(1);
    await expect(page.locator(`[data-asset-id="${ID.a2}"]`)).toHaveCount(1);
    assert.ok(state.calls.some(call => call.includes('q=%E5%9C%BA%E6%99%AF')), '搜索请求必须带 q 参数');

    // 清空搜索后按服务端支持的来源筛选「改图」。
    await page.locator('#rv-asset-search').fill('');
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(3);
    await page.locator('[data-rv="asset-filter"][data-id="edit"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(1);
    await expect(page.locator(`[data-asset-id="${ID.a2}"]`)).toHaveCount(1);
    assert.ok(state.calls.some(call => call.includes('source=edit')), '筛选请求必须带 source=edit');

    // 回到全部，加载更多通过返回游标追加第二页，不重复。
    await page.locator('[data-rv="asset-filter"][data-id="all"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(3);
    await page.locator('[data-rv="asset-more"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(5);
    assert.ok(state.calls.some(call => call.includes('cursor=page-2')), '加载更多必须带返回的游标');
    await expect(page.locator('[data-rv="asset-more"]')).toHaveCount(0);
    await expect(page.locator('[data-asset-end]')).toContainText('已加载全部匹配素材');

    // 详情：元数据、提示词、版本链与真实下载地址。
    await page.locator(`[data-rv="asset-detail"][data-id="${ID.a1}"]`).click();
    const dialog = page.locator('#rv-dialog');
    await expect(dialog).toContainText('白色收纳盒 · 白底主图');
    await expect(dialog).toContainText('版本链');
    await expect(page.locator('[data-asset-chain] [data-asset-version]')).toHaveCount(2);
    await expect(page.locator(`[data-rv="asset-download"]`)).toHaveAttribute('href', `/api/assets/${ID.a1}/download`);
    await expect(dialog).toContainText('素材自动带入尚未接入');
    await expect(page.locator('[data-rv="use-asset"]')).toHaveCount(1);
    await page.locator('[data-rv="close"]').click();

    // 410 缺文件：明确提示且记录仍在列表中。
    await page.locator(`[data-rv="asset-detail"][data-id="${ID.a3}"]`).click();
    await expect(page.locator('[data-asset-detail-error]')).toContainText('文件缺失，记录仍保留');
    await expect(page.locator('[data-asset-detail-missing]')).toContainText('文件缺失，记录仍保留');
    await expect(page.locator('[data-asset-download-missing]')).toContainText('记录仍保留');
    await page.locator('[data-rv="close"]').click();
    await expect(page.locator(`[data-asset-id="${ID.a3}"]`)).toHaveCount(1);

    // 模板页仍可用，且不存在旧的 50 条横幅。
    await page.locator('[data-rv="asset-tab"][data-id="templates"]').click();
    await expect(page.locator('.tpl-card')).toHaveCount(10);
    await page.locator('#tpl-search').fill('分镜');
    await expect(page.locator('.tpl-card')).toHaveCount(1);
    await page.locator('#tpl-search').fill('');

    assert.deepEqual(state.writes, [], `素材浏览不应产生写请求：${state.writes.join(', ')}`);
    assert.deepEqual(state.errors, []);
    await context.close();
  }

  // 2. 错误态可重试：503 后点击重试恢复真实列表。
  {
    const { context, page, state } = await openPage(browser, base, { failList: true });
    await page.locator('.rail-btn[data-nav="assets"]').click();
    await expect(page.locator('[data-asset-error]')).toContainText('素材索引暂不可用');
    await expect(page.locator('[data-rv="asset-retry"]')).toBeVisible();
    state.failList = false;
    await page.locator('[data-rv="asset-retry"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(3);
    await expect(page.locator('[data-asset-error]')).toHaveCount(0);
    assert.deepEqual(state.errors, []);
    await context.close();
  }

  // 3. viewer 只读：可以浏览与下载，不能引用到新项目。
  {
    const { context, page, state } = await openPage(browser, base, { role: 'viewer' });
    await page.locator('.rail-btn[data-nav="assets"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(3);
    await page.locator(`[data-rv="asset-detail"][data-id="${ID.a1}"]`).click();
    await expect(page.locator('[data-rv="use-asset"]')).toHaveCount(0);
    await expect(page.locator('[data-asset-readonly]')).toContainText('当前角色只读');
    await expect(page.locator('[data-rv="asset-download"]')).toHaveAttribute('href', `/api/assets/${ID.a1}/download`);
    await page.locator('[data-rv="close"]').click();
    await page.locator('[data-rv="asset-tab"][data-id="templates"]').click();
    await expect(page.locator('.tpl-card')).toHaveCount(10);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.errors, []);
    await context.close();
  }

  // 4. 390px：列表与详情弹窗都不产生横向溢出。
  {
    const { context, page, state } = await openPage(browser, base, { viewport: { width: 390, height: 844 } });
    await page.locator('.gen-mobile-nav [data-screen="assets"]').click();
    await expect(page.locator('[data-asset-grid] article[data-asset-id]')).toHaveCount(3);
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `素材列表横向溢出 ${overflow}px`);
    await page.locator(`[data-rv="asset-detail"][data-id="${ID.a1}"]`).click();
    await expect(page.locator('#rv-dialog')).toBeVisible();
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `素材详情横向溢出 ${overflow}px`);
    assert.deepEqual(state.errors, []);
    await context.close();
  }

  console.log('assets-real-browser: list + summary, search, source filter, cursor load more, detail + version chain, 410 missing file, retry error state, viewer readonly, templates, 390px passed; all /api/** mocked, no writes or paid tasks.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
