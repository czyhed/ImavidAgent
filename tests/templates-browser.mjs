import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// React 素材模板验收（Issue #21 / #25）。
// 前端由测试内静态服务器从 web/dist 提供；所有 /api/** 通过 page.route 模拟。
// 覆盖：10 个模板、分类/搜索、必填校验、兼容提示、复制、带入真实方案草稿、
// If-Match 防覆盖、已确认/无方案项目的明确提示、无付费写请求与手机布局。
// 不连接数据库，不生成图片，不产生费用。

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

const ID = {
  draft: '11111111-1111-4111-8111-111111111111',
  confirmed: '22222222-2222-4222-8222-222222222222',
  noplan: '33333333-3333-4333-8333-333333333333',
  plan: '44444444-4444-4444-8444-444444444444',
  deliverable: '55555555-5555-4555-8555-555555555555',
};
const CSRF = 'templates-test-csrf';
const NOW = '2026-10-21T10:00:00.000Z';

function project(id, name, planStatus) {
  return {
    id, name, status: planStatus === 'confirmed' ? 'active' : 'draft', productId: null, skuId: null,
    skuSpec: '中号 / 白色', ownerId: null, version: 1,
    currentPlanVersion: planStatus ? 1 : null, planStatus,
    progress: { completed: 2, total: 6, label: '2/6' },
    currentStep: { step: planStatus === 'confirmed' ? 3 : 2, key: 'step', name: '方案报价', status: 'in_progress' },
    estimate: { currency: 'CNY', totalCents: 120, pendingPriceCount: 0, deliverableCount: 1 },
    cancelledAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

function draftPlan(status = 'draft', revision = 4) {
  return {
    id: ID.plan, version: 1, status, revision, requirement: '',
    deliverables: [{
      id: ID.deliverable, type: 'white', title: '白底主图', purpose: '电商首图', quantity: 1,
      prompt: {
        subject: '白色收纳盒', scene: '纯白无缝背景', composition: '正面居中', lighting: '柔和均匀光线',
        style: '真实商品摄影', material: '颜色与表面以商品资料为准', mustKeep: '保持商品原有形状与颜色',
        forbidden: '未确认的材质、容量、认证、价格与卖点', aspectRatio: '1:1',
      },
      copy: [], parameters: { capability: 'image.generate' }, status: 'planned',
      price: { currency: 'CNY', amountCents: 120 },
    }],
    price: { currency: 'CNY', totalCents: 120, pricedCount: 1, pendingPriceCount: 0, hasPendingPrice: false, deliverableCount: 1 },
    productVersion: status === 'confirmed' ? 1 : null,
    productSnapshot: status === 'confirmed' ? { name: '白色收纳盒', status: 'confirmed' } : null,
    skuSnapshot: null, changeReason: null, confirmedAt: status === 'confirmed' ? NOW : null,
    confirmedBy: null, createdAt: NOW, updatedAt: NOW,
  };
}

function detail(projectRow, plan) {
  const steps = [1, 2, 3, 4, 5, 6].map(step => ({
    step, key: `step${step}`, name: ['商品资料', '方案报价', '制作任务', '精修', '质检审核', '打包导出'][step - 1],
    status: step < 2 ? 'completed' : step === 2 ? 'in_progress' : 'pending',
  }));
  return { project: projectRow, plan, plans: plan ? [{ id: plan.id, version: 1, status: plan.status, revision: plan.revision, deliverableCount: 1 }] : [], steps, progress: { completed: 1, total: 6, label: '1/6' }, currentStep: steps[0] };
}

const { server, base } = await startStatic();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  const writes = [];
  const violations = [];
  const state = {
    plans: { [ID.draft]: draftPlan('draft'), [ID.confirmed]: draftPlan('confirmed'), [ID.noplan]: null },
    patch: null,
  };
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, json: body, headers });
    if (!['GET', 'HEAD'].includes(method)) {
      writes.push(`${method} ${path}`);
      if (request.headers()['x-csrf-token'] !== CSRF) {
        violations.push(`${method} ${path} missing CSRF`);
        return json({ error: { code: 'CSRF_INVALID', message: '缺少 CSRF。' } }, 403);
      }
    }

    if (path === '/api/session' && method === 'GET') {
      return json({ csrfToken: CSRF, mode: 'local-single-user' });
    }
    if (path === '/api/models' && method === 'GET') return json({ providers: [], models: [] });
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });
    if (path === '/api/dashboard' && method === 'GET') return json({ error: { code: 'NOT_UNDER_TEST', message: '工作台不在本验收范围。' } }, 503);
    if (path === '/api/projects' && method === 'GET') {
      const projects = [
        project(ID.draft, '模板带入 · 草稿', 'draft'),
        project(ID.confirmed, '模板带入 · 已确认', 'confirmed'),
        project(ID.noplan, '模板带入 · 无方案', null),
      ];
      return json({ projects, total: projects.length, limit: 100, offset: 0, nextOffset: null });
    }
    for (const [id, planStatus] of [[ID.draft, 'draft'], [ID.confirmed, 'confirmed'], [ID.noplan, null]]) {
      if (path === `/api/projects/${id}` && method === 'GET') {
        return json(detail(project(id, '模板项目', planStatus), state.plans[id]));
      }
    }

    const planMatch = path.match(/^\/api\/projects\/([^/]+)\/plans\/(\d+)$/);
    if (planMatch && method === 'PATCH') {
      const projectId = planMatch[1];
      const plan = state.plans[projectId];
      if (!plan) return json({ error: { code: 'PLAN_NOT_FOUND', message: '方案不存在。' } }, 404);
      if (plan.status === 'confirmed') return json({ error: { code: 'PLAN_CONFIRMED', message: '已确认方案不能直接修改。' } }, 409);
      const ifMatch = request.headers()['if-match'];
      if (!ifMatch) { violations.push('plan PATCH missing If-Match'); return json({ error: { code: 'REVISION_REQUIRED', message: '缺少 If-Match。' } }, 428); }
      if (ifMatch !== `"r${plan.revision}"`) return json({ error: { code: 'REVISION_CONFLICT', message: '方案已被其他人更新。' } }, 409);
      const body = request.postDataJSON();
      state.patch = { ifMatch, body };
      plan.deliverables = (body.deliverables || []).map((item, index) => ({
        ...item, id: index === 0 ? ID.deliverable : item.id, status: 'planned', price: { currency: 'CNY', amountCents: 120 },
      }));
      plan.requirement = body.requirement || '';
      plan.revision += 1;
      plan.changeReason = body.changeReason || null;
      return json({ projectId, plan }, 200, { ETag: `"r${plan.revision}"` });
    }
    if (path === '/api/planner/plan') return json({ error: { code: 'NOT_UNDER_TEST', message: '模板测试不调用规划。' } }, 500);
    return json({ error: { code: 'TEST_UNMOCKED', message: `测试未模拟 ${method} ${path}` } }, 404);
  });

  const nav = name => page.locator(`[data-nav="${name}"]:visible, [data-screen="${name}"]:visible`).first().click();
  const openTemplates = async () => {
    await nav('assets');
    await page.locator('[data-rv="asset-tab"][data-id="templates"]').click();
    await expect(page.locator('.tpl-card')).toHaveCount(10);
  };

  await page.goto(base);
  await expect(page.locator('#root .app')).toHaveCount(1);

  // 浏览、分类筛选与搜索。
  await openTemplates();
  await expect(page.locator('.tpl-art')).toHaveCount(10);
  await expect(page.locator('.tpl-art').first()).toContainText('自制示意图');
  await page.locator('[data-tpl-search]').fill('分镜');
  await expect(page.locator('.tpl-card')).toHaveCount(1);
  await expect(page.locator('.tpl-card')).toHaveAttribute('data-tpl-id', 'tpl-video-storyboard');
  await page.locator('[data-tpl-search]').fill('');
  await page.locator('[data-tpl-category="场景"]').click();
  await expect(page.locator('.tpl-card')).toHaveCount(2);
  await page.locator('[data-tpl-category="全部"]').click();
  await expect(page.locator('.tpl-card')).toHaveCount(10);

  // 打开场景模板：占位符、兼容提示、空值提交被明确拒绝。
  await page.locator('[data-tpl-id="tpl-scene-home"] [data-rv="template"]').click();
  const dialog = page.locator('#rv-dialog');
  await expect(dialog).toContainText('自然光家居场景');
  await expect(page.locator('#rv-template-form [data-tpl-placeholder]')).toHaveCount(3);
  await expect(page.locator('#rv-template-form [data-tpl-placeholder][data-required="true"]')).toHaveCount(2);
  await expect(page.locator('[data-tpl-compat]')).toContainText('3:4');
  await expect(page.locator('[data-tpl-compat]')).toContainText('1024 × 1365');
  await page.locator('#rv-template-form button').click();
  await expect(page.locator('#rv-message')).toContainText('请填写必填占位符');
  await expect(page.locator('#rv-message')).toContainText('商品');

  // 填写必填占位符后预览、复制。
  await page.locator('[data-tpl-placeholder="商品"]').fill('白色收纳盒');
  await page.locator('[data-tpl-placeholder="场景"]').fill('木质衣柜旁的地板');
  await expect(page.locator('[data-tpl-preview]')).toHaveValue(/白色收纳盒/);
  await expect(page.locator('[data-tpl-preview]')).toHaveValue(/木质衣柜旁的地板/);
  await expect(page.locator('[data-tpl-preview]')).toHaveValue(/柔和侧窗光/);
  const preview = await page.locator('[data-tpl-preview]').inputValue();
  assert.equal(preview.includes('{{'), false);
  await page.locator('[data-tpl-copy]').click();
  await expect(page.locator('#toast')).toContainText('提示词已复制');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), preview);

  // 默认目标为真实方案草稿；写入只 PATCH 方案草稿，来源 id/version 明确。
  await expect(page.locator('[data-tpl-project]')).toHaveValue(ID.draft);
  await expect(page.locator('[data-tpl-item]')).toHaveValue(ID.deliverable);
  await expect(page.locator('[data-tpl-target-hint]')).toContainText('If-Match');
  await expect(page.locator('[data-tpl-source]')).toContainText('tpl-scene-home');
  await page.locator('[data-tpl-bring]').click();
  await expect(page.locator('#rv-message')).toContainText('未确认');
  await expect(page.locator('#rv-message')).toContainText('tpl-scene-home');
  await expect(page.locator('#rv-message')).toContainText('v1');
  assert.equal(writes.length, 1);
  assert.equal(writes[0], `PATCH /api/projects/${ID.draft}/plans/1`);
  assert.equal(state.patch?.ifMatch, '"r4"');
  assert.match(state.patch?.body.changeReason || '', /tpl-scene-home v1/);
  assert.match(state.patch?.body.deliverables?.[0]?.prompt?.subject || '', /白色收纳盒/);
  assert.match(state.patch?.body.deliverables?.[0]?.prompt?.subject || '', /木质衣柜旁/);
  assert.equal(state.plans[ID.draft].status, 'draft', '模板带入不得确认方案');
  assert.equal(state.plans[ID.draft].revision, 5);

  // 已确认方案：明确提示不可写入，按钮与交付项禁用，不发送 PATCH。
  await page.locator('[data-rv="close"]').click();
  await page.locator('[data-tpl-id="tpl-white-hero"] [data-rv="template"]').click();
  await page.locator('[data-tpl-placeholder="商品"]').fill('白色收纳盒');
  await page.locator('[data-tpl-project]').selectOption(ID.confirmed);
  await expect(page.locator('[data-tpl-target-hint]')).toContainText('方案 v1 已确认');
  await expect(page.locator('[data-tpl-target-hint]')).toContainText('不会自动确认、生成或计费');
  await expect(page.locator('[data-tpl-bring]')).toBeDisabled();
  await expect(page.locator('[data-tpl-item]')).toBeDisabled();

  // 无方案项目：明确提示，不自动创建方案或交付项。
  await page.locator('[data-tpl-project]').selectOption(ID.noplan);
  await expect(page.locator('[data-tpl-target-hint]')).toContainText('还没有方案');
  await expect(page.locator('[data-tpl-bring]')).toBeDisabled();
  assert.equal(writes.length, 1, '仅允许一次方案草稿 PATCH');
  await page.locator('[data-rv="close"]').click();

  // 移动端：模板列表与填写对话框都不产生横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await openTemplates();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'template list overflow');
  await page.locator('[data-tpl-id="tpl-scene-home"] [data-rv="template"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'template dialog overflow');

  assert.deepEqual(violations, []);
  assert.deepEqual(errors, []);
  console.log('templates-browser: 10 templates, browse/search, validation, copy, real plan PATCH with If-Match and source note, confirmed/noplan guards, mobile layout passed.');
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
