import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

// React 账号入口验收（Issue #24）：登录、首次本机初始化、强制改密、退出与角色可见性。
// 所有 /api/** 都由 page.route 模拟，不创建真实账号、不写数据库、不产生付费任务。
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const CATALOG = {
  providers: [{ id: 'p_test', name: '测试渠道', baseUrl: 'https://example.test/v1', connected: true, enabled: true, modelCount: 1, source: 'database', keyHint: '••••1234', deletable: true }],
  models: [{
    id: 'p_test:test-image', name: '测试图像模型', providerId: 'p_test', providerName: '测试渠道',
    kind: 'image', executable: true, sizes: ['1024x1024'], qualities: ['high'],
    operations: ['generate', 'edit'], default: true,
  }],
};

const makeUser = (role, email = `${role}@example.test`) => ({
  id: `user_${role}`, workspaceId: 'ws_test', email, displayName: role,
  role, active: true, mustChangePassword: false,
});

// 商品页的角色检查需要至少一条服务端商品（只读请求，不写数据库）。
const PRODUCT = {
  id: '11111111-1111-4111-8111-111111111111', name: '角色测试商品', brand: '测试', category: '收纳用品',
  description: '', sourceType: 'manual', sourcePlatform: null, sourceUrl: null, sourceProductId: null,
  status: 'confirmed', version: 1, createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z', confirmedAt: '2026-10-21T08:00:00.000Z',
  skus: [{
    id: '22222222-2222-4222-8222-222222222222', internalSku: 'ROLE-001', spec: '',
    parameters: [], price: { amount: 10, min: null, max: null, currency: 'CNY', type: 'sale', condition: null, capturedAt: null },
  }],
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 每个场景独立 context，避免本地演示状态互相影响。
  async function open(stateOverrides = {}) {
    const state = {
      authOn: true, authenticated: false, setupRequired: false, mustChangePassword: false,
      user: null, role: 'admin', loginFails: false, setupFails: false, passwordFails: false,
      ...stateOverrides,
    };
    const calls = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      calls.push(`${method} ${path}`);
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      if (path === '/api/session' && method === 'GET') {
        if (!state.authOn) return json({ csrfToken: 'test-csrf', mode: 'local-single-user', billing: '测试' });
        return json({
          csrfToken: 'test-csrf', mode: 'account', authenticated: state.authenticated,
          user: state.user, mustChangePassword: state.mustChangePassword, setupRequired: state.setupRequired,
        });
      }
      if (path === '/api/session' && method === 'POST') {
        if (state.loginFails) return json({ error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误。' } }, 401);
        const input = request.postDataJSON() || {};
        state.authenticated = true;
        state.mustChangePassword = false;
        state.user = makeUser(state.role, input.email || `${state.role}@example.test`);
        return json({ csrfToken: 'test-csrf', authenticated: true, user: state.user, mustChangePassword: false });
      }
      if (path === '/api/session' && method === 'DELETE') {
        state.authenticated = false;
        state.user = null;
        state.mustChangePassword = false;
        return json({ ok: true });
      }
      if (path === '/api/setup/admin' && method === 'POST') {
        if (state.setupFails) return json({ error: { code: 'SETUP_LOCAL_ONLY', message: '管理员初始化仅允许在本机进行。' } }, 403);
        state.setupRequired = false;
        state.user = makeUser('admin', (request.postDataJSON() || {}).email);
        return json({ workspace: { id: 'ws_test', name: '商境' }, user: state.user, csrfToken: 'test-csrf' }, 201);
      }
      if (path === '/api/account/password' && method === 'POST') {
        if (state.passwordFails) return json({ error: { code: 'INVALID_PASSWORD', message: '当前密码不正确。' } }, 400);
        state.mustChangePassword = false;
        return json({ ok: true });
      }
      if (path === '/api/models' && method === 'GET') return json(CATALOG);
      if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });
      if (path === '/api/products' && method === 'GET') {
        return json({ products: [PRODUCT], total: 1, limit: 10, offset: 0, nextOffset: null });
      }
      if (path === `/api/products/${PRODUCT.id}/versions` && method === 'GET') {
        return json({ productId: PRODUCT.id, version: 1, versions: [{ id: 'ver_1', version: 1, changeReason: '创建商品', createdAt: PRODUCT.createdAt }], total: 1, limit: 8, offset: 0, nextOffset: null });
      }
      if (path === `/api/products/${PRODUCT.id}` && method === 'GET') return json({ product: PRODUCT });
      if (path === '/api/product-images' && method === 'GET') {
        return json({ images: [], total: 0, limit: 20, offset: 0, nextOffset: null });
      }
      if (path === '/api/users' && method === 'GET') return json({ users: [] });

      return json({ error: { code: 'TEST_UNMOCKED', message: '测试未模拟该接口。' } }, 404);
    });
    await page.goto(base);
    return { page, context, state, calls, errors };
  }

  const fiveMenus = page => expect(page.locator('.rail-btn:visible')).toHaveCount(5);

  // 1. 关闭登录：保持现有五菜单，不出现登录页，也不显示账号/退出。
  {
    const { page, context, calls, errors } = await open({ authOn: false });
    await expect(page.locator('.app')).toHaveCount(1);
    await fiveMenus(page);
    await expect(page.locator('[data-auth-screen]')).toHaveCount(0);
    await expect(page.locator('#auth-logout')).toHaveCount(0);
    await expect.poll(() => calls.includes('GET /api/jobs')).toBe(true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. 未登录：只显示登录页，不渲染五菜单，也不请求受保护接口；失败文案来自后端。
  {
    const { page, context, state, calls, errors } = await open({ authenticated: false });
    await expect(page.locator('[data-auth-screen="login"]')).toBeVisible();
    await expect(page.locator('#auth-login-form')).toBeVisible();
    await expect(page.locator('.app')).toHaveCount(0);
    await expect(page.locator('.rail-btn')).toHaveCount(0);
    await page.waitForTimeout(700);
    assert.equal(calls.some(call => call === 'GET /api/models' || call === 'GET /api/jobs'), false, '未登录不得请求业务接口');

    state.loginFails = true;
    await page.locator('#auth-login-form [name="email"]').fill('admin@example.test');
    await page.locator('#auth-login-form [name="password"]').fill('WrongPassword123');
    await page.locator('#auth-login-form button[type="submit"]').click();
    await expect(page.locator('#auth-error')).toContainText('账号或密码错误');
    await expect(page.locator('[data-auth-screen="login"]')).toBeVisible();

    state.loginFails = false;
    await page.locator('#auth-login-form [name="email"]').fill('admin@example.test');
    await page.locator('#auth-login-form [name="password"]').fill('CorrectHorse123');
    await page.locator('#auth-login-form button[type="submit"]').click();
    await expect(page.locator('.app')).toHaveCount(1);
    await fiveMenus(page);
    await expect(page.locator('[data-auth-user="admin@example.test"]')).toBeVisible();
    await expect(page.locator('[data-auth-role="admin"]')).toContainText('管理员');

    await page.locator('#auth-logout').click();
    await expect(page.locator('[data-auth-screen="login"]')).toBeVisible();
    await expect(page.locator('.app')).toHaveCount(0);
    assert.equal(calls.includes('DELETE /api/session'), true);

    // 手机宽度下登录页不横向溢出。
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '登录页移动端溢出');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. 首次初始化：无管理员时默认展示本机初始化表单，失败显示后端文案，成功后进入工作台。
  {
    const { page, context, state, calls, errors } = await open({ authenticated: false, setupRequired: true });
    await expect(page.locator('[data-auth-screen="setup"]')).toBeVisible();
    await expect(page.locator('#auth-setup-form')).toBeVisible();
    await expect(page.locator('#auth-setup-form [name="email"]')).toBeVisible();
    await expect(page.locator('#auth-setup-form [name="password"]')).toHaveAttribute('type', 'password');
    await expect(page.locator('#auth-setup-form [name="password"]')).toHaveAttribute('autocomplete', 'new-password');
    await expect(page.locator('#auth-setup-form [name="workspaceName"]')).toBeVisible();
    await expect(page.locator('[data-auth-screen="setup"]')).toContainText('本机');
    await expect(page.locator('.app')).toHaveCount(0);

    state.setupFails = true;
    await page.locator('#auth-setup-form [name="email"]').fill('owner@example.test');
    await page.locator('#auth-setup-form [name="password"]').fill('SetupPass12345');
    await page.locator('#auth-setup-form [name="workspaceName"]').fill('商境测试空间');
    await page.locator('#auth-setup-form button[type="submit"]').click();
    await expect(page.locator('#auth-error')).toContainText('仅允许在本机进行');

    state.setupFails = false;
    await page.locator('#auth-setup-form button[type="submit"]').click();
    await expect(page.locator('.app')).toHaveCount(1);
    await fiveMenus(page);
    await expect(page.locator('[data-auth-user="owner@example.test"]')).toBeVisible();
    assert.equal(calls.includes('POST /api/setup/admin'), true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 4. 强制改密：只显示改密表单，不请求业务接口；改密后重新连接进入工作台。
  {
    const { page, context, state, calls, errors } = await open({
      authenticated: true, mustChangePassword: true, user: makeUser('operator', 'member@example.test'),
    });
    await expect(page.locator('[data-auth-screen="password-change"]')).toBeVisible();
    await expect(page.locator('#auth-password-form')).toBeVisible();
    await expect(page.locator('.app')).toHaveCount(0);
    await page.waitForTimeout(700);
    assert.equal(calls.some(call => call === 'GET /api/models' || call === 'GET /api/jobs'), false, '强制改密不得请求业务接口');

    await page.locator('#auth-password-form [name="currentPassword"]').fill('TempPass12345');
    await page.locator('#auth-password-form [name="newPassword"]').fill('MemberPass12345');
    await page.locator('#auth-password-form [name="confirmPassword"]').fill('MemberPass99999');
    await page.locator('#auth-password-form button[type="submit"]').click();
    await expect(page.locator('#auth-error')).toContainText('不一致');

    await page.locator('#auth-password-form [name="confirmPassword"]').fill('MemberPass12345');
    await page.locator('#auth-password-form button[type="submit"]').click();
    await expect(page.locator('.app')).toHaveCount(1);
    await fiveMenus(page);
    assert.equal(calls.includes('POST /api/account/password'), true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 5. 角色可见性：viewer 禁用写入口，operator 隐藏管理员入口，admin 全部可见。
  async function roleChecks(role) {
    const { page, context, calls, errors } = await open({ authenticated: true, user: makeUser(role), role });
    const admin = role === 'admin';
    const writer = role === 'admin' || role === 'operator';
    await fiveMenus(page);

    await page.locator('.rail-btn[data-nav="products"]').click();
    await expect(page.locator('#products-list')).toBeVisible();
    await expect(page.locator('#product-add')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#product-edit')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#product-import')).toBeEnabled({ enabled: writer });

    await page.locator('.rail-btn[data-nav="system"]').click();
    await expect(page.locator('[data-rv="add-user"]:visible')).toHaveCount(admin ? 1 : 0);
    await expect(page.locator('[data-rv="system-users"]')).toContainText(admin ? '还没有其他成员' : '成员管理仅对管理员开放');
    assert.equal(calls.includes('GET /api/users'), admin, '成员列表只允许管理员请求');
    await page.locator('[data-rv="system-tab"][data-id="models"]').click();
    await page.locator('[data-rv="real-system"]').click();
    await expect(page.locator('#add-channel:visible')).toHaveCount(admin ? 1 : 0);
    await expect(page.locator('#sys-refresh:visible')).toHaveCount(admin ? 1 : 0);

    // 项目列表来自服务端；没有项目时只显示真实空态和新建入口（viewer 无入口）。
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-projects-state]')).toBeVisible();
    await expect(page.locator('[data-rv="new-project"], [data-rv="new-project-empty"]')).toHaveCount(writer ? 1 : 0);

    // 真实单图面板用深链直接打开；viewer 仍可查看但不能勾选确认或提交。
    await page.goto(base + (base.includes('?') ? '&' : '?') + 'screen=generation');
    await expect(page.locator('#gen-consent')).toBeEnabled({ enabled: writer });
    await expect(page.locator('#gen-submit')).toBeDisabled();
    if (writer) {
      await page.locator('#gen-consent').check();
      await expect(page.locator('#gen-submit')).toBeEnabled();
    }
    await expect(page.locator('#gen-submit')).toHaveAttribute('data-role', 'operator-only');
    await expect(page.locator('[data-auth-role]')).toContainText({ admin: '管理员', operator: '运营', viewer: '只读' }[role]);

    // 角色页面不会提交任务或渠道写请求；手机宽度不横向溢出。
    assert.equal(calls.some(call => call === 'POST /api/jobs' || call.startsWith('POST /api/channels')), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${role} 移动端溢出`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  await roleChecks('viewer');
  await roleChecks('operator');
  await roleChecks('admin');

  console.log('Auth browser checks passed: login, local-only setup, forced password change, logout, role visibility and mobile layout. All API calls mocked; no accounts or paid tasks created.');
} finally {
  await browser.close();
}
