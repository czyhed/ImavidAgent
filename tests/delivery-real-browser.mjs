import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// 交付界面真实接入验收（Issue #25）：04 精修 / 05 审核 / 06 导出。
// 前端由测试内静态服务器从 web/dist 提供；所有 /api/** 通过 page.route 模拟。
// 不连接 PostgreSQL / Redis / MinIO，不调用模型，不创建真实任务，不产生费用。
// 覆盖：正常链路、ETag 冲突、只读角色、手机无横向溢出。

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
  project: '11111111-1111-4111-8111-111111111111',
  plan: '22222222-2222-4222-8222-222222222222',
  d1: '33333333-3333-4333-8333-333333333333',
  d2: '44444444-4444-4444-8444-444444444444',
  job: '55555555-5555-4555-8555-555555555555',
  v1: '66666666-6666-4666-8666-666666666666',
  v2: '77777777-7777-4777-8777-777777777777',
  v3: '88888888-8888-4888-8888-888888888888',
  refine: '99999999-9999-4999-8999-999999999999',
  review: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  export: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const USER = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  email: 'admin@example.test', role: 'admin', active: true, workspaceId: 'local',
};
const CSRF = 'delivery-test-csrf';
const NOW = '2026-10-21T10:00:00.000Z';
const PATHS = {
  template_reorder: '模板重排', base_optimize: '底图二次优化', full_polish: '整图润色',
};
const CHECK_KEYS = ['fidelity', 'text', 'size', 'layout'];

function deliverable(id, type, title) {
  return {
    id, type, title, purpose: `${title}用途`, quantity: 1,
    prompt: { subject: '白色收纳盒', scene: '纯白背景', aspectRatio: '1:1' },
    copy: [], parameters: { capability: 'image.generate', modelId: 'test:image' },
    status: 'planned', price: { currency: 'CNY', amountCents: 120 },
  };
}

function plan() {
  return {
    id: ID.plan, version: 1, status: 'confirmed', revision: 3, requirement: '突出可叠放',
    deliverables: [deliverable(ID.d1, 'white', '白底主图'), deliverable(ID.d2, 'scene', '生活场景图')],
    price: { currency: 'CNY', totalCents: 240, pricedCount: 2, pendingPriceCount: 0, hasPendingPrice: false, deliverableCount: 2 },
    productVersion: 1, productSnapshot: { name: '白色收纳盒', version: 1, status: 'confirmed' }, skuSnapshot: null,
    changeReason: null, confirmedAt: NOW, confirmedBy: null, createdAt: NOW, updatedAt: NOW,
  };
}

function projectSummary() {
  return {
    id: ID.project, name: '秋日收纳 · 交付验收', status: 'active', productId: null, skuId: null, skuSpec: '中号 / 白色',
    ownerId: null, version: 1, currentPlanVersion: 1, planStatus: 'confirmed',
    progress: { completed: 3, total: 6, label: '3/6' },
    currentStep: { step: 4, key: 'step4', name: '精修', status: 'in_progress' },
    estimate: plan().price, cancelledAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

function detail() {
  const steps = [1, 2, 3, 4, 5, 6].map(step => ({
    step, key: `step${step}`, name: ['商品资料', '方案报价', '制作任务', '精修', '质检审核', '打包导出'][step - 1],
    status: step < 4 ? 'completed' : step === 4 ? 'in_progress' : 'pending',
  }));
  return {
    project: projectSummary(), plan: plan(),
    plans: [{ id: ID.plan, version: 1, status: 'confirmed', revision: 3, deliverableCount: 2, price: plan().price }],
    steps, progress: { completed: 3, total: 6, label: '3/6' }, currentStep: { step: 4, key: 'step4', name: '精修', status: 'in_progress' },
  };
}

function version(id, number, status, extra = {}) {
  return {
    id, workspaceId: 'local', projectId: ID.project, planVersion: 1, deliverableId: ID.d1,
    version: number, sourceVersionId: null, assetId: null, jobId: ID.job, status,
    isCandidate: status === 'candidate', refinePath: null, refinePathLabel: null, requiresQc: false,
    content: { modelId: 'test:image' }, cost: { amountCents: 120 }, createdBy: null,
    createdAt: NOW, updatedAt: NOW, ...extra,
  };
}

function state(candidateVersionId = null) {
  return { projectId: ID.project, planVersion: 1, deliverableId: ID.d1, candidateVersionId, rework: null, revision: 1 };
}

function review(status = 'in_review', checks = {}, revision = 1) {
  const merged = {};
  for (const key of CHECK_KEYS) merged[key] = { key, label: key, result: checks[key] || 'pending' };
  return {
    id: ID.review, workspaceId: 'local', projectId: ID.project, planVersion: 1, deliverableId: ID.d1,
    versionId: ID.v1, versionNumber: 1, status, statusLabel: status, checks: merged,
    allPassed: CHECK_KEYS.every(key => merged[key].result === 'passed'),
    unresolved: CHECK_KEYS.filter(key => merged[key].result !== 'passed'),
    notes: {}, reviewedBy: null, reviewedAt: status === 'approved' ? NOW : null, revocation: null,
    revision, createdBy: null, createdAt: NOW, updatedAt: NOW,
  };
}

function exportRecord(itemCount = 1, missingCount = 1) {
  return {
    id: ID.export, projectId: ID.project, planVersion: 1, status: 'completed', statusLabel: '已完成',
    fileName: 'BOX-秋日收纳-v1.zip', contentType: 'application/zip', bytes: 2048, zipSha256: 'sha',
    manifestSha256: 'manifest', itemCount, missingCount,
    items: itemCount ? [{
      deliverableId: ID.d1, title: '白底主图', type: 'white', versionId: ID.v1, version: 1,
      reviewId: ID.review, reviewedAt: NOW, file: '01-白底主图.png', originalFileName: '白底主图.png',
      contentType: 'image/png', bytes: 1024, sha256: 'abc',
    }] : [],
    missing: missingCount ? [{
      deliverableId: ID.d2, title: '生活场景图', type: 'scene',
      reason: 'NO_APPROVED_VERSION', message: '没有审核通过的交付版本',
    }] : [],
    manifest: { complete: missingCount === 0 }, billing: { currency: 'CNY', amountCents: 0, billingMode: 'none', charged: false },
    errorCode: null, createdBy: null, createdAt: NOW, completedAt: NOW, updatedAt: NOW,
    downloadUrl: `/api/exports/${ID.export}/download`,
  };
}

function createMock({ role = 'admin', initialCandidate = false, failCandidate = false } = {}) {
  const mockState = {
    role, failCandidate, calls: [], violations: [], exports: [], idempotency: new Set(),
    versions: { [ID.d1]: [version(ID.v1, 1, initialCandidate ? 'candidate' : 'draft')], [ID.d2]: [] },
    states: { [ID.d1]: state(initialCandidate ? ID.v1 : null), [ID.d2]: state() },
    reviews: { [ID.d1]: [], [ID.d2]: [] },
    refines: { [ID.d1]: [], [ID.d2]: [] },
    requests: new Map(),
  };
  mockState.states[ID.d2].deliverableId = ID.d2;
  return mockState;
}

async function openApp(browser, base, mock, { viewport = { width: 1440, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    mock.calls.push(`${method} ${path}${url.search}`);
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, json: body, headers });
    const fail = (code, message, status = 422) => json({ error: { code, message } }, status);

    if (!['GET', 'HEAD'].includes(method) && request.headers()['x-csrf-token'] !== CSRF) {
      mock.violations.push(`${method} ${path} missing CSRF`);
      return fail('CSRF_INVALID', '缺少 CSRF。', 403);
    }

    if (path === '/api/session' && method === 'GET') {
      return json({
        csrfToken: CSRF, mode: 'account', authenticated: true,
        user: { ...USER, role: mock.role }, mustChangePassword: false, setupRequired: false,
      });
    }
    if (path === '/api/models' && method === 'GET') {
      return json({ providers: [], models: [{ id: 'test:image', name: '测试图像模型', kind: 'image', executable: true }] });
    }
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });
    if (path === '/api/dashboard' && method === 'GET') return fail('NOT_UNDER_TEST', '工作台不在本验收范围。', 503);
    if (path === '/api/projects' && method === 'GET') {
      return json({ projects: [projectSummary()], total: 1, limit: 100, offset: 0, nextOffset: null });
    }
    if (path === `/api/projects/${ID.project}` && method === 'GET') return json(detail());

    const workflowMatch = path.match(/^\/api\/projects\/([^/]+)\/plans\/(\d+)\/deliverables\/([^/]+)\/workflow$/);
    if (workflowMatch) return fail('INSTANCE_NOT_FOUND', '该交付项尚未创建工作流实例。', 404);

    const versionMatch = path.match(/^\/api\/deliverables\/([^/]+)\/versions$/);
    if (versionMatch) {
      const deliverableId = versionMatch[1];
      if (method === 'GET') {
        return json(
          { versions: mock.versions[deliverableId] || [], state: mock.states[deliverableId] },
          200,
          { ETag: `"r${mock.states[deliverableId]?.revision || 1}"` },
        );
      }
      if (method === 'POST') {
        const body = request.postDataJSON();
        if (!body?.jobId) return fail('INVALID_ID', '生成任务编号不能为空。');
        const next = version(
          ID.v2, (mock.versions[deliverableId]?.length || 0) + 1, 'draft',
          { deliverableId, jobId: body.jobId, cost: { amountCents: 0 } },
        );
        mock.versions[deliverableId].push(next);
        mock.states[deliverableId].revision += 1;
        return json({ version: next, state: mock.states[deliverableId] }, 201, { ETag: `"r${mock.states[deliverableId].revision}"` });
      }
    }

    const refineListMatch = path.match(/^\/api\/deliverables\/([^/]+)\/refines$/);
    if (refineListMatch && method === 'GET') {
      return json({ requests: mock.refines[refineListMatch[1]] || [], state: mock.states[refineListMatch[1]] });
    }
    if (refineListMatch && method === 'POST') {
      const deliverableId = refineListMatch[1];
      const ifMatch = request.headers()['if-match'];
      const body = request.postDataJSON();
      const pending = mock.requests.get(body?.refineId);
      if (!pending) return fail('REFINE_NOT_FOUND', '精修请求不存在。', 404);
      if (!body?.idempotencyKey || mock.idempotency.has(body.idempotencyKey)) {
        mock.violations.push('refine confirm reused or missed idempotency');
        return fail('IDEMPOTENCY_REUSED', '幂等键重复。', 409);
      }
      mock.idempotency.add(body.idempotencyKey);
      if (!ifMatch) { mock.violations.push('refine confirm missing If-Match'); return fail('REVISION_REQUIRED', '缺少 If-Match。', 428); }
      if (ifMatch !== `"r${pending.revision}"` || body.revision !== pending.revision) {
        return fail('REVISION_CONFLICT', '精修请求已更新，请重新估价。', 409);
      }
      pending.status = 'succeeded';
      pending.revision += 1;
      pending.targetVersionId = ID.v3;
      let createdVersion = null;
      if (body && pending.path === 'template_reorder') {
        createdVersion = version(ID.v3, (mock.versions[deliverableId]?.length || 0) + 1, 'draft', {
          deliverableId, refinePath: 'template_reorder', refinePathLabel: '模板重排', requiresQc: false, cost: { amountCents: 0 },
        });
        mock.versions[deliverableId].push(createdVersion);
      }
      mock.states[deliverableId].revision += 1;
      return json({ request: pending, version: createdVersion, state: mock.states[deliverableId], created: true });
    }

    const estimateMatch = path.match(/^\/api\/deliverables\/([^/]+)\/refines\/estimate$/);
    if (estimateMatch && method === 'POST') {
      const deliverableId = estimateMatch[1];
      const body = request.postDataJSON();
      if (!body?.sourceVersionId || !body?.planVersion) return fail('INVALID_BODY', '缺少源版本或方案版本。');
      const req = {
        id: ID.refine, workspaceId: 'local', projectId: ID.project, planVersion: 1,
        deliverableId, path: body.path, pathLabel: PATHS[body.path] || body.path,
        sourceVersionId: body.sourceVersionId, targetVersionId: null, params: body.params || {},
        status: 'awaiting_confirmation',
        quote: { amountCents: 0, regeneratesImage: false, requiresQc: false },
        estimate: { currency: 'CNY', amountCents: 0, hasPendingPrice: false, regeneratesImage: false, requiresQc: false },
        totals: { currency: 'CNY', estimatedCents: 0, reservedCents: 0, actualCostCents: null },
        jobId: null, errorCode: null, confirmedBy: null, confirmedAt: null, revision: 1, createdAt: NOW, updatedAt: NOW,
      };
      mock.requests.set(ID.refine, req);
      mock.refines[deliverableId].push(req);
      return json({ request: req, quote: req.quote }, 200, { ETag: '"r1"' });
    }

    const refineMatch = path.match(/^\/api\/refines\/([^/]+)$/);
    if (refineMatch && method === 'GET') {
      const req = mock.requests.get(refineMatch[1]);
      return req ? json({ request: req }) : fail('REFINE_NOT_FOUND', '精修请求不存在。', 404);
    }

    const candidateMatch = path.match(/^\/api\/deliverables\/([^/]+)\/candidates$/);
    if (candidateMatch && method === 'POST') {
      const deliverableId = candidateMatch[1];
      if (mock.failCandidate) return fail('REVISION_CONFLICT', '交付项状态已更新，请刷新后重试。', 409);
      const ifMatch = request.headers()['if-match'];
      const current = mock.states[deliverableId];
      if (!ifMatch) { mock.violations.push('candidate missing If-Match'); return fail('REVISION_REQUIRED', '缺少 If-Match。', 428); }
      if (ifMatch !== `"r${current.revision}"`) return fail('REVISION_CONFLICT', '交付项状态已更新，请刷新后重试。', 409);
      const body = request.postDataJSON();
      if (!mock.versions[deliverableId].some(item => item.id === body?.versionId)) return fail('VERSION_NOT_FOUND', '交付版本不存在。', 404);
      current.candidateVersionId = body.versionId;
      current.rework = null;
      mock.versions[deliverableId] = mock.versions[deliverableId].map(item => (
        item.id === body.versionId ? { ...item, status: 'candidate', isCandidate: true }
          : item.status === 'candidate' ? { ...item, status: 'superseded', isCandidate: false } : item
      ));
      current.revision += 1;
      return json({ state: current }, 200, { ETag: `"r${current.revision}"` });
    }

    const reworkMatch = path.match(/^\/api\/deliverables\/([^/]+)\/rework$/);
    if (reworkMatch && method === 'POST') {
      const deliverableId = reworkMatch[1];
      const current = mock.states[deliverableId];
      const ifMatch = request.headers()['if-match'];
      const body = request.postDataJSON();
      if (!ifMatch) { mock.violations.push('rework missing If-Match'); return fail('REVISION_REQUIRED', '缺少 If-Match。', 428); }
      if (ifMatch !== `"r${current.revision}"`) return fail('REVISION_CONFLICT', '交付项状态已更新。', 409);
      if (!body?.reason?.trim()) return fail('REASON_REQUIRED', '返修必须填写原因。');
      current.candidateVersionId = null;
      current.rework = { versionId: body.versionId, reason: body.reason, at: NOW, by: USER.id };
      current.revision += 1;
      mock.versions[deliverableId] = mock.versions[deliverableId].map(item => (
        item.status === 'candidate' ? { ...item, status: 'draft', isCandidate: false } : item
      ));
      return json({ state: current }, 200, { ETag: `"r${current.revision}"` });
    }

    const reviewListMatch = path.match(/^\/api\/deliverables\/([^/]+)\/reviews$/);
    if (reviewListMatch && method === 'GET') {
      return json({ reviews: mock.reviews[reviewListMatch[1]] || [], state: mock.states[reviewListMatch[1]] });
    }
    if (reviewListMatch && method === 'POST') {
      const deliverableId = reviewListMatch[1];
      const current = mock.states[deliverableId];
      if (!current.candidateVersionId) return fail('NOT_CANDIDATE', '只有当前候选版本可以发起审核。', 409);
      const created = review('in_review', {}, 1);
      created.deliverableId = deliverableId;
      created.versionId = current.candidateVersionId;
      mock.reviews[deliverableId].unshift(created);
      current.revision += 1;
      return json({ review: created }, 201, { ETag: '"r1"' });
    }

    const reviewMatch = path.match(/^\/api\/reviews\/([^/]+)$/);
    if (reviewMatch && method === 'PATCH') {
      const found = Object.values(mock.reviews).flat().find(item => item.id === reviewMatch[1]);
      if (!found) return fail('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
      const ifMatch = request.headers()['if-match'];
      if (!ifMatch) { mock.violations.push('review update missing If-Match'); return fail('REVISION_REQUIRED', '缺少 If-Match。', 428); }
      if (ifMatch !== `"r${found.revision}"`) return fail('REVISION_CONFLICT', '审核记录已更新。', 409);
      const body = request.postDataJSON();
      for (const [key, value] of Object.entries(body?.checks || {})) {
        if (found.checks[key]) found.checks[key] = { ...found.checks[key], result: value };
      }
      found.allPassed = CHECK_KEYS.every(key => found.checks[key].result === 'passed');
      found.unresolved = CHECK_KEYS.filter(key => found.checks[key].result !== 'passed');
      found.revision += 1;
      return json({ review: found }, 200, { ETag: `"r${found.revision}"` });
    }

    const approveMatch = path.match(/^\/api\/reviews\/([^/]+)\/approve$/);
    if (approveMatch && method === 'POST') {
      const found = Object.values(mock.reviews).flat().find(item => item.id === approveMatch[1]);
      if (!found) return fail('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
      const ifMatch = request.headers()['if-match'];
      if (!ifMatch) { mock.violations.push('review approve missing If-Match'); return fail('REVISION_REQUIRED', '缺少 If-Match。', 428); }
      if (ifMatch !== `"r${found.revision}"`) return fail('REVISION_CONFLICT', '审核记录已更新。', 409);
      if (!found.allPassed) return fail('CHECKS_INCOMPLETE', '四项检查全部通过后才能审核通过。', 409);
      found.status = 'approved';
      found.statusLabel = '已通过';
      found.revisedAt = NOW;
      found.revision += 1;
      mock.versions[found.deliverableId] = mock.versions[found.deliverableId].map(item => (
        item.id === found.versionId ? { ...item, status: 'approved', isCandidate: false } : item
      ));
      return json({ review: found, state: mock.states[found.deliverableId] }, 200, { ETag: `"r${found.revision}"` });
    }

    const revokeMatch = path.match(/^\/api\/reviews\/([^/]+)\/revoke$/);
    if (revokeMatch && method === 'POST') {
      const found = Object.values(mock.reviews).flat().find(item => item.id === revokeMatch[1]);
      if (!found) return fail('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
      const body = request.postDataJSON();
      if (!body?.reason?.trim()) return fail('REASON_REQUIRED', '撤销必须填写理由。');
      found.status = 'revoked';
      found.revocation = { reason: body.reason, by: USER.id, at: NOW };
      found.revision += 1;
      mock.states[found.deliverableId].candidateVersionId = null;
      return json({ review: found, state: mock.states[found.deliverableId] }, 200, { ETag: `"r${found.revision}"` });
    }

    if (path === `/api/projects/${ID.project}/exports` && method === 'GET') {
      return json({ project: { id: ID.project, name: '秋日收纳' }, exports: mock.exports, total: mock.exports.length });
    }
    if (path === `/api/projects/${ID.project}/exports` && method === 'POST') {
      const body = request.postDataJSON();
      if (!body?.idempotencyKey || mock.idempotency.has(body.idempotencyKey)) {
        mock.violations.push('export reused or missed idempotency');
        return fail('IDEMPOTENCY_REUSED', '幂等键重复。', 409);
      }
      mock.idempotency.add(body.idempotencyKey);
      const approved = Object.values(mock.reviews).flat().filter(item => item.status === 'approved');
      if (!approved.length) return fail('NO_APPROVED_VERSION', '没有审核通过的版本。', 422);
      const record = exportRecord(approved.length, 2 - approved.length);
      mock.exports.unshift(record);
      return json({ export: record, created: true }, 201, { ETag: '"r1"' });
    }
    if (path === `/api/exports/${ID.export}/download` && method === 'GET') {
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="delivery-test.zip"',
        },
        body: Buffer.from('PK\u0005\u0006mock-zip'),
      });
    }

    return fail('TEST_UNMOCKED', `测试未模拟 ${method} ${path}`, 404);
  });

  await page.goto(base);
  await expect(page.locator('#root .app')).toHaveCount(1);
  return { context, page, errors };
}

async function openProject(page) {
  await page.locator('.rail-btn[data-nav="projects"]').click();
  await page.locator('[data-rv="open-project"]').first().click();
  await expect(page.locator('[data-view="project"]')).toHaveCount(1);
}

const { server, base } = await startStatic();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 1. 正常链路：导入版本 -> 选候选 -> 模板精修 -> 返修 -> 审核通过 -> 部分交付确认 -> 导出下载。
  {
    const mock = createMock();
    const { context, page, errors } = await openApp(browser, base, mock);
    await openProject(page);
    await expect(page.locator('[data-rv="delivery-refine"]')).toBeVisible();
    await expect(page.locator('[data-version-id]')).toHaveCount(1);
    await expect(page.locator('[data-versions-empty]')).toHaveCount(0);

    await page.locator('[data-rv="import-job-id"]').fill(ID.job);
    await page.locator('[data-rv="import-version"]').click();
    await expect(page.locator('[data-version-id]')).toHaveCount(2);
    await expect(page.locator('[data-delivery-notice]')).toContainText('已导入交付版本');
    assert.ok(mock.calls.some(call => call === `POST /api/deliverables/${ID.d1}/versions`));

    await page.locator(`[data-rv="delivery-version"][data-id="${ID.v1}"]`).click();
    await page.locator('[data-rv="select-candidate"]').click();
    await expect(page.locator('[data-delivery-notice]')).toContainText('交付候选');
    await expect(page.locator(`[data-version-id="${ID.v1}"]`)).toContainText('当前候选');
    assert.ok(mock.calls.some(call => call === `POST /api/deliverables/${ID.d1}/candidates`));

    await page.locator('[data-rv="estimate-refine"]').click();
    await expect(page.locator('[data-refine-quote]')).toContainText('模板重排');
    await expect(page.locator('[data-refine-quote]')).toContainText('¥0.00');
    await page.locator('[data-rv="refine-consent"]').check();
    await page.locator('[data-rv="confirm-refine"]').click();
    await expect(page.locator('[data-delivery-notice]')).toContainText('模板重排已完成');
    await expect(page.locator('[data-version-id]')).toHaveCount(3);
    assert.ok(mock.calls.some(call => call === `POST /api/deliverables/${ID.d1}/refines`));

    await page.locator('[data-rv="rework-reason"]').fill('需要调整构图');
    await page.locator('[data-rv="rework"]').click();
    await expect(page.locator('[data-delivery-notice]')).toContainText('退回第 04 步返修');
    await expect(page.locator('[data-rv="select-candidate"]')).toBeEnabled();

    await page.locator('[data-rv="select-candidate"]').click();
    await expect(page.locator('[data-delivery-notice]')).toContainText('交付候选');

    await page.locator('[data-rv="step"][data-id="5"]').first().click();
    await expect(page.locator('[data-rv="delivery-review"]')).toBeVisible();
    await page.locator('[data-rv="start-review"]').click();
    await expect(page.locator('[data-review-checks]')).toBeVisible();
    for (const key of CHECK_KEYS) {
      await page.locator(`[data-rv="review-check"][data-check="${key}"]`).selectOption('passed');
    }
    await expect(page.locator('[data-rv="approve-review"]')).toBeEnabled();
    await page.locator('[data-rv="approve-review"]').click();
    await expect(page.locator('[data-delivery-notice]')).toContainText('已通过审核并冻结');
    assert.ok(mock.calls.includes(`POST /api/reviews/${ID.review}/approve`));

    await expect(page.locator('[data-rv="revoke-review"]')).toBeDisabled();
    await page.locator('[data-rv="revoke-reason"]').fill('审核后又发现文字问题');
    await expect(page.locator('[data-rv="revoke-review"]')).toBeEnabled();

    await page.locator('[data-rv="step"][data-id="6"]').first().click();
    await expect(page.locator('[data-rv="delivery-export"]')).toBeVisible();
    await expect(page.locator('[data-export-readiness]')).toContainText('未通过');
    await expect(page.locator('[data-rv="create-export"]')).toBeDisabled();
    await page.locator('[data-rv="export-partial"]').check();
    await expect(page.locator('[data-rv="create-export"]')).toBeEnabled();
    await page.locator('[data-rv="create-export"]').click();
    await expect(page.locator('[data-exports-list]')).toContainText('缺项 1');
    await expect(page.locator('[data-export-id]')).toHaveCount(1);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-rv="export-download"]').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'BOX-秋日收纳-v1.zip', '导出下载必须使用服务端导出文件名');
    assert.ok(download.url().includes(`/api/exports/${ID.export}/download`), `下载地址应指向真实导出接口：${download.url()}`);

    assert.deepEqual(mock.violations, []);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. ETag 冲突：选候选返回 409 时显示错误，不伪造候选或重置版本。
  {
    const mock = createMock({ failCandidate: true });
    const { context, page, errors } = await openApp(browser, base, mock);
    await openProject(page);
    await page.locator('[data-rv="select-candidate"]').click();
    await expect(page.locator('[data-delivery-error]')).toContainText('请刷新后重试');
    assert.equal(mock.states[ID.d1].candidateVersionId, null);
    assert.ok(mock.calls.some(call => call.startsWith(`POST /api/deliverables/${ID.d1}/candidates`)));
    assert.deepEqual(mock.violations, []);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. 只读角色：可查看版本 / 审核 / 导出，但所有写操作都不渲染。
  {
    const mock = createMock({ role: 'viewer', initialCandidate: true });
    const { context, page, errors } = await openApp(browser, base, mock);
    await openProject(page);
    await expect(page.locator('[data-rv="delivery-refine"]')).toContainText('只读角色 · 不可精修');
    await expect(page.locator('[data-rv="import-version"]')).toHaveCount(0);
    await expect(page.locator('[data-rv="select-candidate"]')).toHaveCount(0);
    await expect(page.locator('[data-rv="estimate-refine"]')).toHaveCount(0);
    await page.locator('[data-rv="step"][data-id="5"]').first().click();
    await expect(page.locator('[data-rv="start-review"]')).toHaveCount(0);
    await page.locator('[data-rv="step"][data-id="6"]').first().click();
    await expect(page.locator('[data-rv="create-export"]')).toHaveCount(0);
    await expect(page.locator('[data-rv="delivery-export"]')).toContainText('只读角色');
    assert.deepEqual(mock.violations, []);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 4. 手机：04/05/06 均无横向溢出，可读取真实服务端状态。
  {
    const mock = createMock({ initialCandidate: true });
    const { context, page, errors } = await openApp(browser, base, mock, { viewport: { width: 390, height: 844 } });
    await page.locator('.gen-mobile-nav [data-screen="projects"]').click();
    await page.locator('[data-rv="open-project"]').first().click();
    await expect(page.locator('[data-rv="delivery-refine"]')).toBeVisible();
    for (const step of [4, 5, 6]) {
      await page.locator(`[data-rv="step"][data-id="${step}"]`).first().click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) {
        const offenders = await page.evaluate(() => [...document.querySelectorAll('*')]
          .map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 80), right: Math.round(el.getBoundingClientRect().right), width: Math.round(el.getBoundingClientRect().width) }))
          .filter(item => item.right > innerWidth + 1).slice(0, 20));
        console.log('overflow offenders', step, offenders);
      }
      assert.ok(overflow <= 1, `第 0${step} 步手机端横向溢出 ${overflow}px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log('delivery-real-browser: 4 scenarios passed (04/05/06 happy path, ETag conflict, viewer, mobile overflow)');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
