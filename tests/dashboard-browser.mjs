import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

// 工作台浏览器验收：全部 API 用 Playwright route 模拟，不连接 PostgreSQL，
// 不调用模型、不创建任务、不产生费用。验证真实数字、未统计与错误态。

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4190';
const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@example.test',
  role: 'admin',
  active: true,
  workspaceId: '00000000-0000-4000-8000-000000000002',
};

const payload = () => ({
  generatedAt: '2026-10-21T08:00:00.000Z',
  scope: { mode: 'workspace', role: 'admin', amountsVisible: true },
  sources: {
    projects: 'ok', tasks: 'ok', products: 'ok',
    outputs: 'ok', billing: 'ok', activity: 'ok',
  },
  metrics: {
    projects: {
      total: 4, byStatus: { draft: 1, active: 2, review: 0, completed: 1, cancelled: 0 },
      awaitingPlan: 2, inReview: 1, completed: 1,
    },
    tasks: {
      total: 7, active: 2, succeeded: 3, failed: 1, unknown: 1,
      byStatus: { queued: 1, running: 1, succeeded: 3, failed: 1, unknown: 1 },
    },
    products: { total: 5, pending: 2 },
    outputs: { total: 4, available: 3, unavailable: 1 },
  },
  amounts: {
    currency: 'CNY',
    period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' },
    settledCents: 12345,
    costOnlyMicros: 9000,
    pendingPriceCount: 2,
  },
  todos: [
    { key: 'products.pending', label: '待核实商品', detail: '补充规格、价格与来源证据，再确认商品档案。', count: 2, severity: 'info', targetScreen: 'products', targetProductId: 'prod-1' },
    { key: 'projects.plan', label: '待确认方案', detail: '当前方案仍是草稿，确认后才会冻结资料与价格。', count: 2, severity: 'info', targetScreen: 'project', targetProjectId: 'p1' },
  ],
  anomalies: [
    { key: 'tasks.failed', label: '失败任务', detail: '明确失败的任务需人工决定是否重试；不会自动重试或换模型。', count: 1, severity: 'warn', targetScreen: 'generation' },
  ],
  recent: {
    projects: [{
      id: 'p1', name: '秋季主图', skuSpec: '白色 / 中号', status: 'draft', planStatus: 'draft',
      progress: { completed: 0, total: 6 },
      currentStep: { step: 1, key: 'product', label: '商品资料', status: 'in_progress' },
      updatedAt: '2026-10-20T12:00:00.000Z',
      estimate: { currency: 'CNY', totalCents: 1000, pendingPriceCount: 1, deliverableCount: 2 },
    }],
    activity: [{
      id: 'audit:1', kind: 'audit', action: 'project.plan.confirmed', title: '确认方案',
      result: 'success', actorEmail: 'admin@example.test', actorRole: 'admin',
      target: { type: 'project', id: 'p1' }, at: '2026-10-20T10:00:00.000Z',
    }],
  },
});

async function openScenario(browser, { dashboard, role = 'admin', dashboardStatus = 200 }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    calls.push(`${method} ${path}`);
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/session' && method === 'GET') {
      return json({
        csrfToken: 'test-csrf', mode: 'account', authenticated: true,
        user: { ...USER, role }, mustChangePassword: false, setupRequired: false,
      });
    }
    if (path === '/api/models' && method === 'GET') return json({ providers: [], models: [] });
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });
    if (path === '/api/products' && method === 'GET') return json({
      products: [{
        id: 'prod-other', name: '其他商品', brand: '商境', category: '收纳', description: '可叠放收纳盒。',
        status: 'pending', version: 2, sourceType: 'manual',
        skus: [{ id: 'sku-1', internalSku: 'BOX-M', spec: '中号 / 白色', parameters: [], price: { amount: null, min: null, max: null, currency: 'CNY' } }],
      }], total: 1,
    });
    if (['/api/products/prod-1', '/api/products/prod-other'].includes(path) && method === 'GET') return json({ product: {
      id: path.endsWith('prod-1') ? 'prod-1' : 'prod-other', name: path.endsWith('prod-1') ? '白色收纳盒' : '其他商品', brand: '商境', category: '收纳', description: '可叠放收纳盒。',
      status: 'pending', version: 2, sourceType: 'manual',
      skus: [{ id: 'sku-1', internalSku: 'BOX-M', spec: '中号 / 白色', parameters: [], price: { amount: null, min: null, max: null, currency: 'CNY' } }],
    } });
    if (path === '/api/product-images' && method === 'GET') return json({ images: [], total: 0 });
    if (/^\/api\/products\/prod-(1|other)\/versions$/.test(path) && method === 'GET') return json({ versions: [], total: 0 });
    if (path === '/api/projects/p1' && method === 'GET') return json({
      project: { id: 'p1', name: '秋季主图', skuSpec: '白色 / 中号', status: 'draft', productId: null, currentPlanVersion: 1 },
      plan: { id: 'plan-1', version: 1, status: 'draft', revision: 1, requirement: '', deliverables: [], price: { totalCents: 0, pendingPriceCount: 0 } },
      plans: [], progress: { completed: 0, total: 6 },
      currentStep: { step: 2, key: 'plan', label: '方案报价', status: 'in_progress' }, steps: [],
    });
    if (path === '/api/dashboard' && method === 'GET') {
      if (dashboardStatus !== 200) {
        return json({ error: { code: 'DB_UNAVAILABLE', message: '工作台指标暂不可用。' } }, dashboardStatus);
      }
      return json(dashboard);
    }
    return json({ error: { code: 'TEST_UNMOCKED', message: '测试未模拟该接口。' } }, 404);
  });
  await page.goto(base);
  await expect(page.locator('.rail-btn:visible')).toHaveCount(5);
  return { context, page, errors, calls };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 1. 管理员：真实数字、金额、待办、最近项目与动态来自接口。
  {
    const { context, page, errors, calls } = await openScenario(browser, { dashboard: payload() });
    await expect(page.locator('[data-dashboard-ready="true"]')).toHaveCount(1);
    await expect(page.locator('[data-dashboard-metric="projects"] strong')).toHaveText('4');
    await expect(page.locator('[data-dashboard-metric="tasks"] strong')).toHaveText('7');
    await expect(page.locator('[data-dashboard-metric="outputs"] strong')).toHaveText('4');
    await expect(page.locator('[data-dashboard-metric="amounts"] strong')).toHaveText('¥123.45');
    await expect(page.locator('[data-dashboard-queue="products.pending"] em')).toHaveText('2');
    await expect(page.locator('[data-dashboard-projects]')).toContainText('秋季主图');
    await expect(page.locator('[data-dashboard-projects]')).toContainText('¥10.00');
    await expect(page.locator('[data-dashboard-activity]')).toContainText('确认方案');
    await expect(page.locator('.rv-home-grid .rv-feature h2')).toHaveText('秋季主图');
    const body = await page.locator('body').innerText();
    assert.equal(/演示项目|演示成功版本|演示累计生成费用/.test(body), false, '工作台不得显示旧演示数字');
    assert.ok(calls.includes('GET /api/dashboard'));
    await page.setViewportSize({ width: 390, height: 844 });
    const projectTableOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(projectTableOverflow <= 1, `最近项目表格移动端横向溢出 ${projectTableOverflow}px`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-dashboard-queue="projects.plan"]').click();
    await expect(page.locator('[data-view="project"][data-project-id="p1"]')).toHaveCount(1);
    await expect(page).toHaveURL(/screen=project&projectId=p1/);
    await page.reload();
    await expect(page.locator('[data-view="project"][data-project-id="p1"]')).toHaveCount(1);
    assert.ok(calls.filter(call => call === 'GET /api/projects/p1').length >= 2, 'object deep link survives reload');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. 查看者：数量与待办可见，金额明细显示未统计，且不出现金额值。
  {
    const viewerPayload = payload();
    viewerPayload.scope = { mode: 'workspace', role: 'viewer', amountsVisible: false };
    viewerPayload.amounts = null;
    viewerPayload.recent.projects[0].estimate = null;
    const { context, page, errors } = await openScenario(browser, { dashboard: viewerPayload, role: 'viewer' });
    await expect(page.locator('[data-dashboard-ready="true"]')).toHaveCount(1);
    await expect(page.locator('[data-dashboard-metric="projects"] strong')).toHaveText('4');
    await expect(page.locator('[data-dashboard-metric="amounts"] strong')).toHaveText('未统计');
    await expect(page.locator('[data-dashboard-metric="amounts"] small')).toContainText('金额明细仅管理员与运营可见');
    await expect(page.locator('[data-dashboard-projects]')).toContainText('未统计');
    const body = await page.locator('body').innerText();
    assert.equal(body.includes('¥123.45'), false, '查看者不得看到本月金额');
    assert.equal(body.includes('¥10.00'), false, '查看者不得看到项目预算');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. 接口失败：错误态 + 全部未统计，不回退到演示数字；手机宽度无横向溢出。
  {
    const { context, page, errors } = await openScenario(browser, { dashboard: null, dashboardStatus: 503 });
    await expect(page.locator('[data-dashboard-error]')).toBeVisible();
    await expect(page.locator('[data-dashboard-error]')).toContainText('工作台指标暂不可用');
    await expect(page.locator('[data-dashboard-ready="false"]')).toHaveCount(1);
    for (const key of ['projects', 'tasks', 'outputs', 'amounts']) {
      await expect(page.locator(`[data-dashboard-metric="${key}"] strong`)).toHaveText('未统计');
    }
    const body = await page.locator('body').innerText();
    assert.equal(/演示项目|演示成功版本|演示累计生成费用/.test(body), false, '失败时不得显示旧演示数字');
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `移动端横向溢出 ${overflow}px`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // 4. 商品待办直达目标商品；刷新后从 URL 恢复同一详情。
  {
    const { context, page, errors, calls } = await openScenario(browser, { dashboard: payload() });
    await page.locator('[data-dashboard-queue="products.pending"]').click();
    await expect(page).toHaveURL(/screen=products&productId=prod-1/);
    await expect(page.locator('#product-detail h2')).toHaveText('白色收纳盒');
    await page.reload();
    await expect(page.locator('#product-detail h2')).toHaveText('白色收纳盒');
    await page.locator('[data-product-id="prod-other"]').click();
    await expect(page.locator('#product-detail h2')).toHaveText('其他商品');
    await expect(page).toHaveURL(/screen=products&productId=prod-other/);
    await page.reload();
    await expect(page.locator('#product-detail h2')).toHaveText('其他商品');
    assert.ok(calls.includes('GET /api/products'));
    assert.ok(calls.filter(call => call === 'GET /api/product-images').length >= 2);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('dashboard-browser: 4 scenarios passed');
} finally {
  await browser.close();
}
