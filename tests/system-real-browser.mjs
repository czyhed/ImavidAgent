import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 系统页真实接口验收（Issue #29）：成员、账本、审计与价格全部用 Playwright 模拟，
// 不连接 PostgreSQL / Redis / MinIO，不调用模型，不产生费用或真实账号。
// 页面由本测试自带的静态服务器从 web/dist 提供，无需先启动 npm run dev。

const dist = new URL('../web/dist/', import.meta.url);
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const entry = FILES[pathname]
    || (/^\/assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(pathname)
      ? [pathname.slice(1), pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'] : null);
  if (!entry) { res.writeHead(404); res.end('not found'); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(entry[0], dist)));
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(503); res.end('build missing');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const ADMIN = {
  id: 'u-admin', workspaceId: 'ws-main', email: 'admin@example.test',
  displayName: '管理员', role: 'admin', active: true, mustChangePassword: false,
};
const MEMBER = {
  id: 'u-member', workspaceId: 'ws-main', email: 'member@example.test',
  displayName: '运营小张', role: 'operator', active: true, mustChangePassword: true,
};

const SUMMARY = {
  workspaceId: 'ws-main', currency: 'CNY',
  from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z',
  balanceCents: 12345, heldCents: 1000, availableCents: 11345,
  settledCents: 2345, costOnlyMicros: 9000, pendingPriceCount: 2,
  byModel: [], byCapability: [], byProject: [], byProvider: [],
};

const ledgerEntry = index => ({
  id: `led-${index}`,
  workspaceId: 'ws-main',
  taskId: `job-${index}`,
  entryType: index === 0 ? 'settle' : 'adjustment',
  amountCents: index === 0 ? 1250 : 100 + index,
  costMicros: null,
  currency: 'CNY',
  capability: index === 0 ? 'image.generate' : null,
  modelId: index === 0 ? 'omyai-openai:gpt-image-2.5-flare' : null,
  projectId: null,
  actorId: 'u-admin',
  reason: index === 0 ? '生成任务结算' : `调账 ${index}`,
  reference: index === 0 ? null : `ref-${index}`,
  createdAt: new Date(Date.UTC(2026, 9, 21, 8, 0 - index)).toISOString(),
});

const auditLog = index => ({
  id: `log-${index}`,
  workspaceId: 'ws-main',
  actorId: 'u-admin',
  actorEmail: 'admin@example.test',
  actorRole: 'admin',
  action: index % 2 === 0 ? 'auth.login.succeeded' : 'user.updated',
  targetType: 'user',
  targetId: 'u-admin',
  result: index % 4 === 0 ? 'failure' : 'success',
  detail: {},
  prompt: null,
  hasPrompt: false,
  createdAt: new Date(Date.UTC(2026, 9, 21, 7, 0 - index)).toISOString(),
});

const PRICE = {
  id: 'price-1', workspaceId: 'ws-main', capability: 'image.generate',
  modelId: 'omyai-openai:gpt-image-2.5-flare', tier: 'default', unit: 'image',
  currency: 'CNY', unitPrice: '0.25', billingMode: 'chargeable', version: 1,
  active: true, effectiveFrom: '2026-10-20T00:00:00.000Z', effectiveTo: null,
  note: null, createdBy: 'u-admin', createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

async function openSystem(browser, { role = 'admin', logs = Array.from({ length: 25 }, (_, i) => auditLog(i)) } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  const posts = [];
  const state = {
    users: [ADMIN, MEMBER].map(user => ({ ...user })),
    prices: [{ ...PRICE }],
    ledger: Array.from({ length: 25 }, (_, i) => ledgerEntry(i)),
    logs: logs.map(log => ({ ...log })),
    summary: { ...SUMMARY },
  };
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    calls.push({ method, path, search: url.search, params: Object.fromEntries(url.searchParams) });
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const fail = (code, message, status = 400) => json({ error: { code, message } }, status);
    const user = role === 'admin' ? { ...ADMIN } : { ...ADMIN, id: `u-${role}`, email: `${role}@example.test`, role };

    if (path === '/api/session' && method === 'GET') {
      return json({
        csrfToken: 'test-csrf', mode: 'account', authenticated: true, user,
        mustChangePassword: false, setupRequired: false,
      });
    }
    if (path === '/api/models' && method === 'GET') return json({ providers: [], models: [] });
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });

    if (path === '/api/users' && method === 'GET') {
      if (role !== 'admin') return fail('FORBIDDEN', '当前角色无权执行此操作。', 403);
      return json({ users: state.users });
    }
    if (path === '/api/users' && method === 'POST') {
      if (role !== 'admin') return fail('FORBIDDEN', '当前角色无权执行此操作。', 403);
      const body = request.postDataJSON();
      posts.push({ method, path, body });
      const created = {
        id: `u-created-${state.users.length}`, workspaceId: 'ws-main',
        email: body.email, displayName: body.displayName || body.email.split('@')[0],
        role: body.role || 'operator', active: true, mustChangePassword: true,
      };
      state.users.push(created);
      return json({ user: created }, 201);
    }
    const userPath = path.match(/^\/api\/users\/([^/]+)$/);
    if (userPath && method === 'POST') {
      if (role !== 'admin') return fail('FORBIDDEN', '当前角色无权执行此操作。', 403);
      const body = request.postDataJSON();
      posts.push({ method, path, body });
      const target = state.users.find(item => item.id === userPath[1]);
      if (!target) return fail('NOT_FOUND', '成员不存在。', 404);
      if (body.displayName !== undefined) target.displayName = body.displayName;
      if (body.role !== undefined) target.role = body.role;
      if (body.enabled !== undefined) target.active = body.enabled;
      if (body.password !== undefined) target.mustChangePassword = true;
      return json({ user: target });
    }

    if (path === '/api/billing' && method === 'GET') return json(state.summary);
    if (path === '/api/billing/ledger' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      const entries = state.ledger.slice(offset, offset + limit);
      return json({
        entries, total: state.ledger.length, limit, offset,
        nextOffset: offset + entries.length < state.ledger.length ? offset + entries.length : null,
      });
    }
    if (path === '/api/billing/prices' && method === 'GET') {
      return json({ prices: state.prices, total: state.prices.length, limit: 50, offset: 0, nextOffset: null });
    }
    if (path === '/api/billing/prices' && method === 'POST') {
      if (role !== 'admin') return fail('FORBIDDEN', '当前角色无权执行此操作。', 403);
      const body = request.postDataJSON();
      posts.push({ method, path, body });
      state.prices.forEach(price => {
        if (price.capability === body.capability && price.modelId === body.modelId && price.tier === body.tier) price.active = false;
      });
      const created = {
        ...PRICE, ...body, id: `price-${state.prices.length + 1}`, active: true,
        effectiveFrom: '2026-10-21T00:00:00.000Z',
      };
      state.prices.unshift(created);
      return json({ price: created }, 201);
    }
    if (path === '/api/billing/adjustments' && method === 'POST') {
      if (role !== 'admin') return fail('FORBIDDEN', '当前角色无权执行此操作。', 403);
      const body = request.postDataJSON();
      posts.push({ method, path, body });
      state.summary = { ...state.summary, balanceCents: state.summary.balanceCents + body.amountCents };
      return json({ status: 'adjusted', created: true, balance: { balanceCents: state.summary.balanceCents } }, 201);
    }

    if (path === '/api/audit-logs' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      const action = url.searchParams.get('action') || '';
      const result = url.searchParams.get('result') || '';
      let filtered = state.logs;
      if (action) {
        filtered = filtered.filter(log => action.endsWith('*')
          ? log.action.startsWith(action.slice(0, -1)) : log.action === action);
      }
      if (result) filtered = filtered.filter(log => log.result === result);
      const logsPage = filtered.slice(offset, offset + limit);
      return json({
        logs: logsPage, total: filtered.length, limit, offset,
        nextOffset: offset + logsPage.length < filtered.length ? offset + logsPage.length : null,
        canViewPrompt: role === 'admin',
      });
    }

    return fail('TEST_UNMOCKED', `测试未模拟该接口：${method} ${path}`, 404);
  });

  await page.goto(base);
  await expect(page.locator('.rail-btn[data-nav="system"]')).toBeVisible();
  await page.locator('.rail-btn[data-nav="system"]').click();
  return { context, page, errors, calls, posts, state, role };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 1. 管理员：真实成员、账本、审计与价格；写操作使用真实接口字段。
  {
    const { context, page, errors, calls, posts } = await openSystem(browser, { role: 'admin' });
    await expect(page.locator('[data-rv="users-table"]')).toBeVisible();
    await expect(page.locator('[data-rv="users-table"]')).toContainText('admin@example.test');
    await expect(page.locator('[data-rv="users-table"]')).toContainText('运营小张');
    await expect(page.locator('[data-rv="signed-in"]')).toContainText('admin@example.test');
    const demo = await page.locator('body').innerText();
    assert.equal(/test_operator|林晓|本地交互演示用户/.test(demo), false, '不得显示旧演示用户');

    // 新增成员：POST /api/users {email,displayName,role,password}
    await page.locator('[data-rv="add-user"]').click();
    await page.locator('#rv-user-form [name="email"]').fill('new@example.test');
    await page.locator('#rv-user-form [name="displayName"]').fill('新同事');
    await page.locator('#rv-user-form [name="role"]').selectOption('operator');
    await page.locator('#rv-user-form [name="password"]').fill('InitialPass123');
    await page.locator('#rv-user-form button[type="submit"]').click();
    await expect.poll(() => posts.filter(item => item.path === '/api/users').length).toBe(1);
    assert.deepEqual(posts[0].body, {
      email: 'new@example.test', displayName: '新同事', role: 'operator', password: 'InitialPass123',
    });
    await expect(page.locator('[data-rv="users-table"]')).toContainText('new@example.test');
    assert.equal((await page.locator('body').innerText()).includes('InitialPass123'), false, '密码不得出现在页面');

    // 编辑成员：只提交 displayName / role。
    const memberRow = page.locator('tr').filter({ hasText: 'member@example.test' });
    await memberRow.locator('[data-rv="edit-user"]').click();
    await page.locator('#rv-user-form [name="displayName"]').fill('运营组长');
    await page.locator('#rv-user-form [name="role"]').selectOption('admin');
    await page.locator('#rv-user-form button[type="submit"]').click();
    await expect.poll(() => posts.filter(item => item.path === '/api/users/u-member').length).toBe(1);
    assert.deepEqual(posts.find(item => item.path === '/api/users/u-member').body, { displayName: '运营组长', role: 'admin' });

    // 停用成员：POST /api/users/:id {enabled:false}
    await page.locator('tr').filter({ hasText: 'member@example.test' }).locator('[data-rv="toggle-user"]').click();
    await expect.poll(() => posts.some(item => item.path === '/api/users/u-member' && item.body.enabled === false)).toBe(true);

    // 重置密码：POST /api/users/:id {password}
    await page.locator('tr').filter({ hasText: 'member@example.test' }).locator('[data-rv="reset-password"]').click();
    await page.locator('#rv-user-form [name="password"]').fill('TempPass12345');
    await page.locator('#rv-user-form button[type="submit"]').click();
    await expect.poll(() => posts.some(item => item.path === '/api/users/u-member' && item.body.password === 'TempPass12345')).toBe(true);
    assert.equal((await page.locator('body').innerText()).includes('TempPass12345'), false, '临时密码不得出现在页面');

    // 账单：汇总数字来自接口，流水来自真实分页接口。
    await page.locator('[data-rv="system-tab"][data-id="billing"]').click();
    await expect(page.locator('[data-rv="ledger-table"]')).toBeVisible();
    await expect(page.locator('[data-rv="billing-metrics"]')).toContainText('¥113.45');
    await expect(page.locator('[data-rv="billing-metrics"]')).toContainText('¥123.45');
    await expect(page.locator('[data-rv="billing-metrics"]')).toContainText('¥10.00');
    await expect(page.locator('[data-rv="billing-metrics"]')).toContainText('¥23.45');
    await expect(page.locator('[data-rv="ledger-table"]')).toContainText('生成任务结算');
    await expect(page.locator('[data-rv="ledger-table"]')).toContainText('结算 ¥12.50');
    const billingText = await page.locator('[data-rv="system-billing"]').innerText();
    assert.equal(/演示|验收 · 五张套图/.test(billingText), false, '账单不得显示演示数据');

    await page.locator('[data-rv="ledger-next"]').click();
    await expect.poll(() => calls.some(call => call.path === '/api/billing/ledger' && call.params.offset === '20')).toBe(true);
    await expect(page.locator('[data-rv="ledger-table"]')).toContainText('调账 21');

    // 管理员调账：amountCents 为整数分，reason 与 reference 必填。
    await page.locator('[data-rv="adjust-balance"]').click();
    await page.locator('#rv-balance-form [name="amount"]').fill('12.34');
    await page.locator('#rv-balance-form [name="reason"]').fill('测试充值');
    await page.locator('#rv-balance-form [name="reference"]').fill('order-001');
    await page.locator('#rv-balance-form button[type="submit"]').click();
    await expect.poll(() => posts.filter(item => item.path === '/api/billing/adjustments').length).toBe(1);
    assert.deepEqual(posts.find(item => item.path === '/api/billing/adjustments').body, {
      amountCents: 1234, reason: '测试充值', reference: 'order-001',
    });

    // 日志：真实列表、动作筛选与 CSV 链接。
    await page.locator('[data-rv="system-tab"][data-id="logs"]').click();
    await expect(page.locator('[data-rv="audit-table"]')).toBeVisible();
    await expect(page.locator('[data-rv="audit-table"]')).toContainText('auth.login.succeeded');
    await expect(page.locator('[data-rv="audit-total"]')).toContainText('共 25 条记录');
    await expect(page.locator('[data-rv="audit-export"]')).toHaveAttribute('href', '/api/audit-logs/export.csv');

    await page.locator('[data-rv="audit-filter"] input').first().fill('auth.login.succeeded');
    await page.locator('[data-rv="audit-filter"] select').selectOption('success');
    await page.locator('[data-rv="audit-apply"]').click();
    await expect.poll(() => calls.some(call => call.path === '/api/audit-logs'
      && call.params.action === 'auth.login.succeeded' && call.params.result === 'success')).toBe(true);
    await expect(page.locator('[data-rv="audit-export"]')).toHaveAttribute(
      'href', '/api/audit-logs/export.csv?action=auth.login.succeeded&result=success',
    );
    await expect(page.locator('[data-rv="audit-table"]')).not.toContainText('user.updated');

    await page.locator('[data-rv="audit-clear"]').click();
    await expect(page.locator('[data-rv="audit-export"]')).toHaveAttribute('href', '/api/audit-logs/export.csv');
    await page.locator('[data-rv="audit-next"]').click();
    await expect.poll(() => calls.some(call => call.path === '/api/audit-logs' && call.params.offset === '20')).toBe(true);

    // 模型中心：真实价格列表、手动录入 POST 与演示查价只读。
    await page.locator('[data-rv="system-tab"][data-id="models"]').click();
    await page.locator('[data-rv="manual-price"]').click();
    await page.locator('#rv-price-form [name="capability"]').selectOption('image.generate');
    await page.locator('#rv-price-form [name="modelId"]').fill('test:new-model');
    await page.locator('#rv-price-form [name="tier"]').fill('standard');
    await page.locator('#rv-price-form [name="unit"]').selectOption('image');
    await page.locator('#rv-price-form [name="unitPrice"]').fill('0.35');
    await page.locator('#rv-price-form button[type="submit"]').click();
    await expect.poll(() => posts.filter(item => item.path === '/api/billing/prices').length).toBe(1);
    assert.deepEqual(posts.find(item => item.path === '/api/billing/prices').body, {
      capability: 'image.generate', modelId: 'test:new-model', tier: 'standard', unit: 'image', unitPrice: '0.35',
    });
    await expect(page.locator('[data-rv="price-table"]')).toContainText('test:new-model');
    await expect(page.locator('[data-rv="price-table"]')).toContainText('¥0.35 / 张');
    await expect(page.locator('[data-rv="real-system"]')).toBeVisible();

    await page.locator('[data-rv="lookup-price"]').click();
    await expect(page.locator('#rv-dialog')).toContainText('未联网查价');
    await expect(page.locator('#rv-dialog')).toContainText('不会写入价格表或账本');
    assert.equal(await page.locator('#rv-price-form').count(), 0, '演示查价不得提供保存表单');
    await page.locator('[data-rv="close-lookup"]').click();

    // 系统页所有写操作均不能落回本地演示状态。
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert.equal(keys.includes('sj:prototype:review:v1'), false, '系统页不得写入本地演示账本');
    assert.equal(keys.some(key => /billing|ledger|audit|system/i.test(key)), false, '系统页不得写入自定义本地键');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. 只读角色：隐藏全部写入口，不请求成员列表，账单与日志仍可读。
  {
    const { context, page, errors, calls, posts } = await openSystem(browser, {
      role: 'viewer', logs: [],
    });
    await expect(page.locator('[data-rv="system-users"]')).toBeVisible();
    await expect(page.locator('[data-rv="add-user"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-rv="system-users"]')).toContainText('成员管理仅对管理员开放');
    await page.waitForTimeout(300);
    assert.equal(calls.some(call => call.path === '/api/users'), false, '非管理员不得请求成员列表');

    await page.locator('[data-rv="system-tab"][data-id="billing"]').click();
    await expect(page.locator('[data-rv="ledger-table"]')).toBeVisible();
    await expect(page.locator('[data-rv="adjust-balance"]:visible')).toHaveCount(0);

    await page.locator('[data-rv="system-tab"][data-id="logs"]').click();
    await expect(page.locator('[data-rv="system-logs"]')).toContainText('还没有审计记录');
    await expect(page.locator('[data-rv="audit-export"]')).toBeVisible();

    await page.locator('[data-rv="system-tab"][data-id="models"]').click();
    await expect(page.locator('[data-rv="price-table"]')).toContainText('omyai-openai:gpt-image-2.5-flare');
    await expect(page.locator('[data-rv="manual-price"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-rv="real-system"]')).toBeVisible();
    await expect(page.locator('[data-rv="lookup-price"]')).toBeVisible();

    assert.equal(posts.length, 0, '只读角色不得产生写请求');
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `只读角色移动端横向溢出 ${overflow}px`);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. 运营：可见账单与日志、真实渠道，不能管理成员、调账或录入价格。
  {
    const { context, page, errors, calls, posts } = await openSystem(browser, { role: 'operator' });
    await expect(page.locator('[data-rv="add-user"]:visible')).toHaveCount(0);
    await page.waitForTimeout(300);
    assert.equal(calls.some(call => call.path === '/api/users'), false, '运营不得请求成员列表');

    await page.locator('[data-rv="system-tab"][data-id="billing"]').click();
    await expect(page.locator('[data-rv="adjust-balance"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-rv="ledger-table"]')).toBeVisible();
    await expect(page.locator('[data-rv="system-billing"]')).toContainText('充值 / 调账仅管理员可执行');

    await page.locator('[data-rv="system-tab"][data-id="models"]').click();
    await expect(page.locator('[data-rv="manual-price"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-rv="real-system"]')).toBeVisible();
    assert.equal(posts.length, 0, '运营不得产生系统页写请求');
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log('system-real-browser: 3 scenarios passed (admin writes with real schemas, viewer/operator read-only, empty states, CSV href, no local demo keys). All API calls mocked; no real accounts or paid tasks.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
