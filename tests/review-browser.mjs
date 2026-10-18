import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// React 五菜单兼容烟测（Issue #27）。
// 项目全链路已由 tests/project-real-browser.mjs 覆盖；这里只保留服务端空项目列表、
// 本地商品 / 素材模板 / 系统页与手机导航。页面由测试内静态服务器提供，全部 API 模拟，
// 不连接数据库，也不提交付费任务。

const DIST = new URL('../web/dist/', import.meta.url);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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

const { server, base } = await startStatic();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/session') return json({ csrfToken: 'review-test', mode: 'off' });
    if (path === '/api/models') return json({ providers: [], models: [] });
    if (path === '/api/jobs') return json({ jobs: [] });
    if (path === '/api/projects' && request.method() === 'GET') {
      return json({ projects: [], total: 0, limit: 100, offset: 0, nextOffset: null });
    }
    if (path === '/api/products' && request.method() === 'GET') {
      return json({ products: [], total: 0, limit: 100, offset: 0, nextOffset: null });
    }
    if (path === '/api/users') return json({ users: [] });
    if (path === '/api/billing' && request.method() === 'GET') {
      return json({ availableCents: 0, balanceCents: 0, heldCents: 0, settledCents: 0, pendingPriceCount: 0, from: null });
    }
    if (path === '/api/billing/ledger') return json({ entries: [], total: 0, limit: 20, offset: 0, nextOffset: null });
    if (path === '/api/billing/prices') return json({ prices: [], total: 0, limit: 50, offset: 0, nextOffset: null });
    if (path === '/api/audit-logs') return json({ logs: [], total: 0, limit: 20, offset: 0, nextOffset: null });
    if (path === '/api/dashboard') {
      return json({ error: { code: 'NOT_UNDER_TEST', message: '工作台不在本烟测范围。' } }, 503);
    }
    return json({ error: { code: 'TEST_UNMOCKED', message: `${request.method()} ${path}` } }, 404);
  });

  await page.goto(base);
  await expect(page.locator('#root .app')).toHaveCount(1);
  await expect(page.locator('.rail-btn')).toHaveCount(5);

  // 项目列表来自服务端；空列表显示真实空态，不出现演示项目。
  await page.locator('.rail-btn[data-nav="projects"]').click();
  await expect(page.locator('[data-projects-empty]')).toBeVisible();
  await expect(page.locator('[data-projects-state]')).toHaveAttribute('data-projects-state', 'empty');
  await expect(page.locator('[data-rv="project-row"]')).toHaveCount(0);

  // 商品页读取服务端空列表：显示真实空态；详细商品流程由商品通道覆盖。
  await page.locator('.rail-btn[data-nav="products"]').click();
  await expect(page.locator('#products-notice')).toBeVisible();
  await expect(page.locator('#products-list')).toContainText('这里还没有商品');
  await expect(page.locator('[data-product-id]')).toHaveCount(0);

  // 素材模板：占位符与预览仍可用；不自动提交真实项目。
  await page.locator('.rail-btn[data-nav="assets"]').click();
  await page.locator('[data-rv="asset-tab"][data-id="templates"]').click();
  await page.locator('[data-rv="template"]').nth(1).click();
  await page.locator('[data-var="商品"]').fill('白色收纳盒');
  await page.locator('[data-var="场景"]').fill('木质衣柜');
  await expect(page.locator('#rv-template-preview')).toHaveValue(/木质衣柜/);
  await page.locator('[data-rv="close"]').click();

  // 系统页读取真实接口：关闭账号体系时只显示本机单用户说明，不写本地演示状态。
  await page.locator('.rail-btn[data-nav="system"]').click();
  await expect(page.locator('[data-rv="system-users"]')).toContainText('本机单用户模式');
  await expect(page.locator('[data-rv="add-user"]:visible')).toHaveCount(0);
  await page.locator('[data-rv="system-tab"][data-id="billing"]').click();
  await expect(page.locator('[data-rv="system-billing"]')).toBeVisible();
  await expect(page.locator('[data-rv="billing-metrics"]')).toBeVisible();
  await page.locator('[data-rv="system-tab"][data-id="models"]').click();
  await page.locator('[data-rv="lookup-price"]').click();
  await expect(page.locator('#rv-dialog')).toContainText('未联网查价');
  await page.locator('[data-rv="close-lookup"]').click();
  await page.locator('[data-rv="real-system"]').click();
  await expect(page.locator('#add-channel')).toBeVisible();
  await page.locator('[data-rv="back-models"]').click();

  // 手机导航：五个目的地可切换，无横向溢出；项目空态仍真实。
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['dashboard', 'projects', 'products', 'assets', 'system']) {
    await page.locator(`.gen-mobile-nav [data-screen="${name}"]`).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${name} 横向溢出 ${overflow}px`);
  }
  await page.locator('.gen-mobile-nav [data-screen="projects"]').click();
  await expect(page.locator('[data-projects-empty]')).toBeVisible();

  assert.deepEqual(errors, []);
  console.log('review-browser: five menus, real empty projects, local products/templates, real system interfaces and mobile passed; project flow is in project-real-browser.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
