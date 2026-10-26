import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { validateWorkflowGraph, assertLockedGraphPreserved } from '../server/workflow.mjs';

// 项目核心真实接入验收（Issue #27）。
// 前端由测试内静态服务器从 web/dist 提供，监听随机本地端口；
// 所有 /api/** 均通过 page.route 模拟，不连接 PostgreSQL / Redis / MinIO，
// 不创建真实任务，不调用模型，不产生任何费用。

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
  product: '11111111-1111-4111-8111-111111111111',
  sku: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  plan: '44444444-4444-4444-8444-444444444444',
  d1: '55555555-5555-4555-8555-555555555555',
  d2: '66666666-6666-4666-8666-666666666666',
  i1: '77777777-7777-4777-8777-777777777777',
  i2: '88888888-8888-4888-8888-888888888888',
  r1: '99999999-9999-4999-8999-999999999999',
  r2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const USER = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'admin@example.test',
  role: 'admin',
  active: true,
  workspaceId: 'local',
};
const CSRF = 'project-test-csrf';
const NOW = '2026-10-21T09:00:00.000Z';

const product = {
  id: ID.product, workspaceId: 'local', version: 2, name: '白色收纳盒', originalTitle: '白色收纳盒',
  brand: '商境', category: '收纳', description: '可叠放收纳盒，带提手。', internalCode: 'BOX-1',
  sourceType: 'manual', sourcePlatform: null, sourceUrl: null, sourceProductId: null,
  status: 'confirmed', confirmedAt: '2026-10-20T08:00:00.000Z', createdAt: NOW, updatedAt: NOW,
  sellingPoints: ['可叠放'], forbiddenPhrases: ['食品级'],
  skus: [{
    id: ID.sku, internalSku: 'BOX-M', sourceSkuId: null, spec: '中号 / 白色', selected: true,
    parameters: [{ name: '尺寸', value: '30 × 20 × 15', unit: 'cm' }],
    price: { amount: 39.9, min: null, max: null, currency: 'CNY', type: 'sale', condition: null, capturedAt: NOW },
  }],
};

function snapshot() {
  return {
    productId: product.id, workspaceId: product.workspaceId, version: product.version, name: product.name,
    originalTitle: product.originalTitle, brand: product.brand, category: product.category,
    description: product.description, internalCode: product.internalCode, sourceType: product.sourceType,
    sourcePlatform: null, sourceUrl: null, sourceProductId: null, status: product.status,
    confirmedAt: product.confirmedAt, createdAt: product.createdAt, updatedAt: product.updatedAt,
    skus: product.skus, sellingPoints: product.sellingPoints, forbiddenPhrases: product.forbiddenPhrases,
  };
}

function newPlan(status = 'draft') {
  return {
    id: ID.plan, version: 1, status, revision: 1, requirement: '',
    deliverables: [], productVersion: status === 'confirmed' ? product.version : null,
    productSnapshot: status === 'confirmed' ? snapshot() : null,
    skuSnapshot: status === 'confirmed' ? product.skus[0] : null,
    price: { currency: 'CNY', totalCents: 0, pricedCount: 0, pendingPriceCount: 0, hasPendingPrice: false, deliverableCount: 0 },
    changeReason: null, confirmedAt: status === 'confirmed' ? NOW : null, confirmedBy: null, createdAt: NOW, updatedAt: NOW,
  };
}

function summary(plan) {
  return {
    id: plan.id, version: plan.version, status: plan.status, revision: plan.revision,
    requirement: plan.requirement, deliverableCount: plan.deliverables.length, price: plan.price,
    productVersion: plan.productVersion, confirmedAt: plan.confirmedAt, confirmedBy: plan.confirmedBy,
    createdAt: plan.createdAt, updatedAt: plan.updatedAt,
  };
}

function nodes(instanceId, deliverable) {
  const label = deliverable.title;
  return [
    {
      id: 'materials', type: 'input', name: '商品资料', params: {},
      ports: [{ id: 'snapshot', direction: 'out', type: 'data', required: true }],
    },
    {
      id: 'prompt', type: 'prompt', name: '文本提示词', params: { prompt: `${label} · ${deliverable.prompt?.subject || ''}`, aspectRatio: '1:1' },
      ports: [
        { id: 'source', direction: 'in', type: 'data', required: true },
        { id: 'prompt', direction: 'out', type: 'text', required: true },
        { id: 'copy', direction: 'out', type: 'text', required: false },
      ],
    },
    {
      id: 'generate', type: 'generate', name: '生图', params: { modelId: 'test:image', size: '1024x1024', aspectRatio: '1:1', tier: 'default' },
      ports: [
        { id: 'prompt', direction: 'in', type: 'text', required: true },
        { id: 'image', direction: 'out', type: 'image', required: true },
      ],
    },
    {
      id: 'ready', type: 'output', name: '交付候选', params: {},
      ports: [{ id: 'result', direction: 'in', type: 'image', required: true }],
    },
  ];
}

function instanceFor(deliverable, index) {
  const nodeList = nodes(index === 0 ? ID.i1 : ID.i2, deliverable);
  return {
    id: index === 0 ? ID.i1 : ID.i2, workspaceId: 'local', projectId: ID.project, planVersion: 1,
    deliverableId: deliverable.id, taskType: deliverable.type, templateId: ID.plan, templateKey: 'system-white',
    templateVersion: 1, nodes: nodeList, edges: [
      { id: 'e1', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
      { id: 'e2', source: 'prompt', sourcePort: 'prompt', target: 'generate', targetPort: 'prompt' },
      { id: 'e3', source: 'generate', sourcePort: 'image', target: 'ready', targetPort: 'result' },
    ],
    ports: {}, lockedNodes: ['materials', 'ready'], revision: 1, createdBy: null, createdAt: NOW, updatedAt: NOW,
  };
}

function estimateNodes() {
  const free = (nodeId, type, name) => ({
    nodeId, type, name, dependsOn: [], reused: false, status: 'pending', quote: { capability: null },
    amountCents: 0, reservedCents: 0, actualCostCents: null, blocking: false,
  });
  return [
    free('materials', 'input', '商品资料'),
    free('prompt', 'prompt', '文本提示词'),
    {
      nodeId: 'generate', type: 'generate', name: '生图', dependsOn: ['prompt'], reused: false,
      status: 'pending',
      quote: { capability: 'image.generate', modelId: 'test:image', tier: 'default', amountCents: 120, currency: 'CNY' },
      amountCents: 120, reservedCents: 0, actualCostCents: null, blocking: false,
    },
    free('ready', 'output', '交付候选'),
  ];
}

function makeRun(instance, deliverable, status, revision, nodeStatus) {
  const list = estimateNodes().map(node => ({
    ...node,
    status: node.nodeId === 'generate' ? nodeStatus
      : status === 'running' || status === 'succeeded' ? 'succeeded' : node.status,
    reservedCents: node.nodeId === 'generate' && status !== 'awaiting_confirmation' ? 120 : node.reservedCents,
    actualCostCents: node.nodeId === 'generate' && status === 'succeeded' ? 120 : null,
  }));
  return {
    id: instance.id === ID.i1 ? ID.r1 : ID.r2, workspaceId: 'local', projectId: ID.project, planVersion: 1,
    deliverableId: deliverable.id, workflowInstanceId: instance.id, instanceRevision: 1,
    status, estimate: {
      currency: 'CNY', totalCents: 120, pendingPriceCount: 0, blockingCount: 0,
      nodeCount: 4, hasPendingPrice: false, quotedAt: NOW, nodes: list,
    },
    nodes: list, totals: {
      currency: 'CNY', estimatedCents: 120,
      reservedCents: status === 'awaiting_confirmation' ? 0 : 120,
      settledCents: status === 'succeeded' ? 120 : 0, releasedCents: 0,
    },
    idempotencyKey: status === 'awaiting_confirmation' ? null : 'mock-key',
    supersedesRunId: null, cancelReason: null, confirmedAt: status === 'awaiting_confirmation' ? null : NOW,
    confirmedBy: null, startedAt: status === 'awaiting_confirmation' ? null : NOW,
    finishedAt: status === 'succeeded' ? NOW : null, revision, createdAt: NOW, updatedAt: NOW,
  };
}

function createMock() {
  const state = {
    plan: newPlan(), project: null, instances: new Map(), runs: new Map(), polls: new Map(),
    deliveryVersions: new Map(), templates: [], workflowConflict: false,
    stepCurrent: 1, stepEvents: [], violations: [], calls: [], idempotencyKeys: new Set(),
    delayProjectReads: false, delayedProjectReads: 0, failProjectReads: false,
  };

  function stepState() {
    const completed = new Set(state.stepEvents.filter(event => event.status === 'completed').map(event => event.step));
    const latestRun = deliverableId => [...state.runs.values()]
      .filter(run => run.deliverableId === deliverableId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
    const productionComplete = state.plan.status === 'confirmed'
      && state.plan.deliverables.length > 0
      && state.plan.deliverables.every(deliverable => latestRun(deliverable.id)?.status === 'succeeded');
    if (productionComplete) completed.add(3);
    const current = state.plan.status !== 'confirmed' ? state.stepCurrent : productionComplete ? 4 : 3;
    const steps = [1, 2, 3, 4, 5, 6].map(step => ({
      step, key: 'step' + step, name: ['商品资料', '方案报价', '制作任务', '精修', '质检审核', '打包导出'][step - 1],
      status: completed.has(step) ? 'completed' : step === current ? 'in_progress' : 'pending',
    }));
    const completedCount = steps.filter(item => item.status === 'completed').length;
    return {
      steps,
      progress: { completed: completedCount, total: 6, label: `${completedCount}/6` },
      currentStep: steps.find(item => item.status === 'in_progress') || null,
    };
  }

  function projectSummary() {
    const p = stepState();
    return {
      id: ID.project, name: state.project?.name || '秋日收纳', status: state.plan.status === 'confirmed' ? 'active' : 'draft',
      productId: product.id, skuId: product.skus[0].id, skuSpec: product.skus[0].spec, ownerId: null, version: 1,
      currentPlanVersion: 1, planStatus: state.plan.status, progress: p.progress, currentStep: p.currentStep,
      estimate: state.plan.price, cancelledAt: null, createdAt: NOW, updatedAt: NOW,
    };
  }

  function detail() {
    const p = stepState();
    return {
      project: projectSummary(), plan: state.plan, plans: [summary(state.plan)],
      steps: p.steps, progress: p.progress, currentStep: p.currentStep,
    };
  }

  return {
    state,
    detail,
    summary,
    product,
    projectSummary,
    stepState,
    plannerPayload() {
      const base = {
        subject: '白色收纳盒', scene: '纯白无缝背景', composition: '正面居中', lighting: '柔和均匀光线',
        style: '真实商品摄影', material: '颜色以已确认资料为准', mustKeep: '保持商品形状与颜色',
        forbidden: '未确认的材质、容量与价格', aspectRatio: '1:1',
      };
      return {
        planId: ID.plan, product: snapshot(), requirement: state.plan.requirement, fallback: false, fallbackReason: null,
        plan: {
          deliverables: [
            { type: 'white', title: '白底主图', purpose: '电商首图', quantity: 1, prompt: base, copy: [] },
            { type: 'scene', title: '生活场景图', purpose: '展示使用场景', quantity: 1, prompt: { ...base, scene: '家居桌面' }, copy: [] },
          ],
          extensions: [{ title: '包装清单图', purpose: '展示已确认配件', prompt: base }],
        },
        pendingVerification: [], libraryVersion: 1, billing: { capability: 'text.plan', amountCents: 0 }, planningCall: {},
      };
    },
  };
}

async function openApp(browser, base, mock, { role = 'admin', viewport = { width: 1440, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let routeFailed = false;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    mock.state.calls.push(`${method} ${path}${url.search}`);
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, json: body, headers });

    // 所有写请求都必须带本地会话 CSRF；方案/运行写接口还必须带 If-Match。
    if (!['GET', 'HEAD'].includes(method) && request.headers()['x-csrf-token'] !== CSRF) {
      mock.state.violations.push(`${method} ${path} missing CSRF`);
      return json({ error: { code: 'CSRF_INVALID', message: '缺少 CSRF。' } }, 403);
    }

    if (path === '/api/session' && method === 'GET') {
      return json({
        csrfToken: CSRF, mode: 'account', authenticated: true,
        user: { ...USER, role }, mustChangePassword: false, setupRequired: false,
      });
    }
    if (path === '/api/models' && method === 'GET') {
      return json({
        providers: [],
        models: [{ id: 'test:image', name: '测试图像模型', kind: 'image', executable: true }],
      });
    }
    if (path === '/api/jobs' && method === 'GET') return json({ jobs: [] });
    if (path === '/api/dashboard' && method === 'GET') {
      return json({ error: { code: 'NOT_UNDER_TEST', message: '工作台不在本项目验收范围。' } }, 503);
    }
    if (path === '/api/products' && method === 'GET') {
      return json({ products: [product], total: 1, limit: 100, offset: 0, nextOffset: null });
    }
    if (path === `/api/products/${product.id}` && method === 'GET') return json(product);

    if (path === '/api/projects' && method === 'GET') {
      if (routeFailed) return json({ error: { code: 'DB_UNAVAILABLE', message: '项目列表暂时不可用。' } }, 503);
      const projects = mock.state.project ? [mock.projectSummary()] : [];
      return json({ projects, total: projects.length, limit: 100, offset: 0, nextOffset: null });
    }
    if (path === '/api/projects' && method === 'POST') {
      const body = request.postDataJSON();
      if (!body?.name || body.productId !== product.id || body.skuId !== product.skus[0].id) {
        mock.state.violations.push('invalid create payload');
        return json({ error: { code: 'INVALID_FIELD', message: '缺少真实商品或 SKU。' } }, 422);
      }
      mock.state.project = { name: body.name };
      mock.state.plan = newPlan();
      mock.state.plan.requirement = body.requirement || '';
      return json(mock.detail(), 201, { ETag: '"v1"' });
    }
    if (path === `/api/projects/${ID.project}` && method === 'GET') {
      if (routeFailed || mock.state.failProjectReads) return json({ error: { code: 'DB_UNAVAILABLE', message: '项目详情暂时不可用。' } }, 503);
      if (!mock.state.project) return json({ error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在。' } }, 404);
      if (mock.state.delayProjectReads) {
        mock.state.delayedProjectReads += 1;
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      return json(mock.detail());
    }
    const versionsMatch = path.match(/^\/api\/deliverables\/([^/]+)\/versions$/);
    if (versionsMatch && method === 'GET') {
      return json({
        versions: mock.state.deliveryVersions.get(versionsMatch[1]) || [],
        state: { revision: 1, candidateVersionId: null },
      }, 200, { ETag: '"r1"' });
    }
    const reviewsMatch = path.match(/^\/api\/deliverables\/([^/]+)\/reviews$/);
    if (reviewsMatch && method === 'GET') return json({ reviews: [], state: {} }, 200, { ETag: '"r1"' });
    const refinesMatch = path.match(/^\/api\/deliverables\/([^/]+)\/refines$/);
    if (refinesMatch && method === 'GET') return json({ requests: [], state: {} }, 200, { ETag: '"r1"' });
    if (path === '/api/planner/plan' && method === 'POST') {
      const body = request.postDataJSON();
      if (body?.productSnapshot?.status !== 'confirmed') {
        mock.state.violations.push('planner received a non-confirmed snapshot');
        return json({ error: { code: 'SNAPSHOT_NOT_CONFIRMED', message: '需要已确认快照。' } }, 409);
      }
      return json(mock.plannerPayload());
    }

    const planMatch = path.match(/^\/api\/projects\/([^/]+)\/plans\/(\d+)(?:\/(confirm|deliverables))?$/);
    if (planMatch) {
      const [, projectId, , action] = planMatch;
      if (projectId !== ID.project) return json({ error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在。' } }, 404);
      if (!action && method === 'PATCH') {
        const ifMatch = request.headers()['if-match'];
        if (!ifMatch) { mock.state.violations.push('plan PATCH missing If-Match'); return json({ error: { code: 'REVISION_REQUIRED', message: '缺少 If-Match。' } }, 428); }
        if (ifMatch !== `"r${mock.state.plan.revision}"`) return json({ error: { code: 'VERSION_CONFLICT', message: '方案已更新。' } }, 409);
        const body = request.postDataJSON();
        mock.state.plan.deliverables = (body.deliverables || []).map((item, index) => ({
          ...item,
          id: index === 0 ? ID.d1 : ID.d2,
          status: 'planned',
          price: { currency: 'CNY', amountCents: 120, quotedAt: NOW },
        }));
        mock.state.plan.requirement = body.requirement || '';
        mock.state.plan.price = {
          currency: 'CNY', totalCents: mock.state.plan.deliverables.length * 120,
          pricedCount: mock.state.plan.deliverables.length, pendingPriceCount: 0,
          hasPendingPrice: false, deliverableCount: mock.state.plan.deliverables.length,
        };
        mock.state.plan.revision += 1;
        mock.state.plan.updatedAt = NOW;
        return json({ projectId: ID.project, plan: mock.state.plan }, 200, { ETag: `"r${mock.state.plan.revision}"` });
      }
      if (action === 'confirm' && method === 'POST') {
        const ifMatch = request.headers()['if-match'];
        if (!ifMatch) { mock.state.violations.push('plan confirm missing If-Match'); return json({ error: { code: 'REVISION_REQUIRED', message: '缺少 If-Match。' } }, 428); }
        if (ifMatch !== `"r${mock.state.plan.revision}"`) return json({ error: { code: 'VERSION_CONFLICT', message: '方案已更新。' } }, 409);
        if (!mock.state.plan.deliverables.length) return json({ error: { code: 'PLAN_EMPTY', message: '方案没有交付项。' } }, 422);
        mock.state.plan.status = 'confirmed';
        mock.state.plan.revision += 1;
        mock.state.plan.productVersion = product.version;
        mock.state.plan.productSnapshot = snapshot();
        mock.state.plan.skuSnapshot = product.skus[0];
        mock.state.plan.confirmedAt = NOW;
        mock.state.stepEvents = [{ step: 1, status: 'completed' }, { step: 2, status: 'completed' }];
        mock.state.stepCurrent = 3;
        return json(mock.detail(), 200, { ETag: `"r${mock.state.plan.revision}"` });
      }
    }

    const workflowMatch = path.match(/^\/api\/projects\/([^/]+)\/plans\/(\d+)\/deliverables\/([^/]+)\/workflow$/);
    if (workflowMatch) {
      const deliverableId = workflowMatch[3];
      const deliverable = mock.state.plan.deliverables.find(item => item.id === deliverableId);
      if (!deliverable) return json({ error: { code: 'DELIVERABLE_NOT_FOUND', message: '交付项不存在。' } }, 404);
      const index = mock.state.plan.deliverables.findIndex(item => item.id === deliverableId);
      const existing = mock.state.instances.get(deliverableId);
      if (method === 'GET') {
        if (!existing) return json({ error: { code: 'INSTANCE_NOT_FOUND', message: '该交付项尚未创建工作流实例。' } }, 404);
        return json({ instance: existing, deliverable, planStatus: 'confirmed', runnable: true }, 200, { ETag: `"r${existing.revision}"` });
      }
      if (method === 'POST') {
        if (existing) return json({ error: { code: 'INSTANCE_EXISTS', message: '该交付项已有工作流实例。' } }, 409);
        const created = instanceFor(deliverable, index);
        const body = request.postDataJSON();
        if (body.templateKey) {
          const template = mock.state.templates.find(item => item.templateKey === body.templateKey && item.version === body.templateVersion);
          assert.ok(template, 'creation must use an explicitly selected template version');
          Object.assign(created, { nodes: structuredClone(template.nodes), edges: structuredClone(template.edges), templateKey: template.templateKey, templateVersion: template.version });
        }
        mock.state.instances.set(deliverableId, created);
        return json({ instance: created, deliverable, planStatus: 'confirmed', runnable: true }, 201, { ETag: '"r1"' });
      }
    }

    if (path === '/api/workflow-templates' && method === 'GET') {
      return json({ templates: mock.state.templates.filter(item => item.taskType === url.searchParams.get('taskType')) });
    }
    const instanceMatch = path.match(/^\/api\/workflow-instances\/([^/]+)(?:\/(save-as-template))?$/);
    if (instanceMatch) {
      const instance = [...mock.state.instances.values()].find(item => item.id === instanceMatch[1]);
      if (!instance) return json({ error: { code: 'INSTANCE_NOT_FOUND', message: 'Workflow instance not found.' } }, 404);
      if (method === 'GET') return json({ instance });
      if (request.headers()['if-match'] !== '"r' + instance.revision + '"' || mock.state.workflowConflict) {
        return json({ error: { code: 'REVISION_CONFLICT', message: 'Workflow changed; reload the latest revision.' } }, 409);
      }
      const body = request.postDataJSON();
      if (instanceMatch[2] === 'save-as-template') {
        const template = { ...structuredClone(instance), templateKey: body.templateKey || 'custom-test', name: body.name, version: 1, status: 'active' };
        mock.state.templates.push(template);
        return json({ template }, 201);
      }
      try {
        const graph = validateWorkflowGraph(body.nodes, body.edges, { lockedNodes: instance.lockedNodes });
        assertLockedGraphPreserved(instance, graph);
        const updated = { ...instance, ...graph, revision: instance.revision + 1 };
        mock.state.instances.set(instance.deliverableId, updated);
        return json({ instance: updated }, 200, { ETag: '"r' + updated.revision + '"' });
      } catch (error) {
        return json({ error: { code: error.code, message: error.message } }, error.status || 422);
      }
    }

    if (path === '/api/workflow-runs/estimate' && method === 'POST') {
      const body = request.postDataJSON();
      const instance = [...mock.state.instances.values()].find(item => item.id === body.workflowInstanceId);
      if (!instance) return json({ error: { code: 'INSTANCE_NOT_FOUND', message: '工作流实例不存在。' } }, 404);
      const deliverable = mock.state.plan.deliverables.find(item => item.id === instance.deliverableId);
      const run = makeRun(instance, deliverable, 'awaiting_confirmation', 1, 'pending');
      mock.state.runs.set(run.id, run);
      const estimate = { ...run.estimate };
      return json({ run, estimate, nodes: estimate.nodes }, 200, { ETag: '"r1"' });
    }

    if (path === '/api/workflow-runs' && method === 'GET') {
      const instanceId = url.searchParams.get('workflowInstanceId');
      if (!instanceId) return json({ error: { code: 'INVALID_FIELD', message: '请提供 workflowInstanceId。' } }, 422);
      const run = [...mock.state.runs.values()].find(item => item.workflowInstanceId === instanceId) || null;
      return json({ run }, 200, run ? { ETag: `"r${run.revision}"` } : {});
    }
    if (path === '/api/workflow-runs' && method === 'POST') {
      const ifMatch = request.headers()['if-match'];
      if (!ifMatch) { mock.state.violations.push('run confirm missing If-Match'); return json({ error: { code: 'REVISION_REQUIRED', message: '缺少 If-Match。' } }, 428); }
      const body = request.postDataJSON();
      if (!body?.idempotencyKey || mock.state.idempotencyKeys.has(body.idempotencyKey)) {
        mock.state.violations.push('run confirm re-used or missed idempotency key');
        return json({ error: { code: 'IDEMPOTENCY_REUSED', message: '幂等键重复。' } }, 409);
      }
      mock.state.idempotencyKeys.add(body.idempotencyKey);
      const run = mock.state.runs.get(body.runId);
      if (!run) return json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在。' } }, 404);
      if (ifMatch !== `"r${run.revision}"`) return json({ error: { code: 'REVISION_CONFLICT', message: '运行已更新。' } }, 409);
      const instance = [...mock.state.instances.values()].find(item => item.id === run.workflowInstanceId);
      const deliverable = mock.state.plan.deliverables.find(item => item.id === run.deliverableId);
      const running = makeRun(instance, deliverable, 'running', 2, 'queued');
      mock.state.runs.set(running.id, running);
      mock.state.polls.set(running.id, 0);
      return json({ run: running, created: true }, 201, { ETag: '"r2"' });
    }

    const runMatch = path.match(/^\/api\/workflow-runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      const current = mock.state.runs.get(runMatch[1]);
      if (!current) return json({ error: { code: 'RUN_NOT_FOUND', message: '运行不存在。' } }, 404);
      if (current.status === 'running') {
        const count = mock.state.polls.get(current.id) || 0;
        mock.state.polls.set(current.id, count + 1);
        if (count >= 1) {
          const instance = [...mock.state.instances.values()].find(item => item.id === current.workflowInstanceId);
          const deliverable = mock.state.plan.deliverables.find(item => item.id === current.deliverableId);
          const succeeded = makeRun(instance, deliverable, 'succeeded', 3, 'succeeded');
          mock.state.runs.set(succeeded.id, succeeded);
          mock.state.deliveryVersions.set(deliverable.id, [{
            id: `version-${deliverable.id}`, deliverableId: deliverable.id, projectId: ID.project,
            planVersion: 1, version: 1, status: 'draft', sourceVersionId: null,
            jobId: `job-${deliverable.id}`, requiresQc: false,
            cost: { currency: 'CNY', amountCents: 120 }, createdAt: NOW,
          }]);
          return json({ run: succeeded }, 200, { ETag: '"r3"' });
        }
      }
      return json({ run: current }, 200, { ETag: `"r${current.revision}"` });
    }

    // 明确失败人工重试 / 未知恢复不应在本次正常流程中被自动调用。
    if (/^\/api\/workflow-runs\/[^/]+\/(retry|reconcile)$/.test(path)) {
      mock.state.violations.push(`unexpected ${method} ${path}`);
      return json({ error: { code: 'NOT_UNDER_TEST', message: '本用例不调用人工重试。' } }, 500);
    }

    return json({ error: { code: 'TEST_UNMOCKED', message: `测试未模拟 ${method} ${path}` } }, 404);
  });

  await page.goto(base);
  await expect(page.locator('#root .app')).toHaveCount(1);
  await expect(page.locator('.rail-btn')).toHaveCount(5);
  return { context, page, errors, mock };
}

const { server, base } = await startStatic();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 1. 创建 -> AI 规划 -> 保存 -> 确认 -> 估价 -> 运行 -> 节点成功 -> 画布。
  {
    const mock = createMock();
    const { context, page, errors } = await openApp(browser, base, mock);
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-projects-empty]')).toHaveCount(1);
    await expect(page.locator('[data-projects-table]')).toHaveCount(0);

    await page.locator('[data-rv="new-project"]:visible').click();
    await expect(page.locator('#rv-project-form')).toBeVisible();
    await page.locator('#rv-project-form [name="name"]').fill('秋季收纳 · 真实项目');
    await expect(page.locator('#rv-project-form [name="product"]')).toHaveValue(product.id);
    await expect(page.locator('#rv-project-form [name="sku"]')).toHaveValue(product.skus[0].id);
    await page.locator('#rv-project-form button[type="submit"]').click();
    await expect(page.locator('[data-view="project"]')).toHaveCount(1);
    await expect(page.locator('#rv-precheck')).toBeChecked();
    await expect(page.locator('.rv-facts').first()).toContainText('中号 / 白色');

    await page.locator('[data-rv="precheck"]').click();
    await page.locator('[data-rv="suggest-plan"]:visible').first().click();
    await expect(page.locator('[data-plan-row]')).toHaveCount(2);
    await expect(page.locator('[data-plan-prompt]').first()).toContainText('白色收纳盒');
    await expect(page.locator('[data-plan-notice]')).toContainText('规划服务');
    assert.ok(mock.state.calls.includes('POST /api/planner/plan'));
    assert.ok(mock.state.calls.some(call => call.startsWith('PATCH /api/projects/' + ID.project + '/plans/1')));

    await page.locator('[data-rv="freeze-plan"]:visible').click();
    assert.equal(mock.state.plan.status, 'confirmed');
    // 确认后自动进入 03；回到 02 可以看到冻结快照。
    await expect(page.locator('[data-rv="workflow-list"]')).toHaveCount(1);
    await page.locator('[data-rv="step"][data-id="2"]').first().click();
    await expect(page.locator('[data-rv="frozen-plan"]')).toHaveCount(1);
    await expect(page.locator('[data-rv="frozen-plan"]')).toContainText('已冻结');
    await expect(page.locator('[data-rv="frozen-plan"]')).toContainText('冻结商品资料 v2');
    await page.locator('[data-rv="step"][data-id="3"]').first().click();
    await expect(page.locator('[data-placeholder-step]')).toHaveCount(0);
    await page.locator('[data-rv="run-batch"]:visible').click();
    await expect(page.locator('[data-batch-estimate]')).toHaveCount(1);
    await expect(page.locator('[data-batch-estimate]')).toContainText('¥1.20');
    await expect(page.locator('[data-batch-estimate]')).toContainText('0 项待核价');
    await expect(page.locator('[data-batch-estimate] [data-run-nodes]').first()).toContainText('生图');
    await expect(page.locator('[data-batch-estimate] [data-run-nodes]').first()).toContainText('待执行');
    assert.equal(mock.state.instances.size, 2);

    mock.state.delayProjectReads = true;
    await page.locator('[data-rv="confirm-run"]:visible').click();
    await expect.poll(() => mock.state.runs.size).toBe(2);
    await expect.poll(() => [...mock.state.runs.values()].map(run => run.status)).toEqual(['succeeded', 'succeeded']);
    await expect.poll(() => mock.state.delayedProjectReads).toBe(2);
    await page.locator('.rv-steps [data-rv="step"][data-id="2"]').click();
    await expect(page.locator('[data-rv="frozen-plan"]')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('.rv-steps [data-rv="step"][data-id="2"]')).toHaveAttribute('aria-current', 'step');
    mock.state.delayProjectReads = false;
    await expect(page.locator('[data-rv="complete-production"]')).toHaveCount(0);
    assert.ok(mock.state.idempotencyKeys.size === 2, '每个运行必须使用独立幂等键');
    assert.deepEqual(mock.state.violations, []);

    await page.locator('.rv-steps [data-rv="step"][data-id="4"]').click();
    await expect(page.locator('[data-rv="delivery-refine"]')).toHaveCount(1);
    await expect(page.locator('[data-rv="delivery-refine"]')).toContainText('精修与交付候选');
    await expect(page.locator('.rv-steps [data-rv="step"][data-id="3"]')).toContainText('已完成');
    await expect(page.locator('.rv-steps [data-rv="step"][data-id="4"]')).toContainText('当前待办');
    await expect(page.locator('[data-delivery-versions] tbody tr')).toHaveCount(1);
    await page.locator('[data-rv="delivery-deliverable"]').nth(1).click();
    await expect(page.locator('[data-delivery-versions] tbody tr')).toHaveCount(1);
    await page.locator('[data-rv="delivery-deliverable"]').first().click();
    await expect(page.locator('[data-delivery-versions] tbody tr').first()).toHaveAttribute('data-version-status', 'draft');
    await expect(page.locator('[data-rv="select-candidate"]')).toBeEnabled();
    await expect(page.locator('[data-rv="delivery-refine"]')).toContainText('当前候选：未选定');
    await expect(page.locator('[data-rv="delivery-refine"]')).toContainText('当前候选：未选定');
    assert.ok(mock.state.calls.some(call => call === `GET /api/deliverables/${mock.state.plan.deliverables[0].id}/versions?projectId=${ID.project}&planVersion=1`), '成功运行后重新读取交付版本');
    assert.equal(mock.state.calls.some(call => call === 'POST /api/projects/' + ID.project + '/steps/3/events'), false);

    // 画布是同一份真实实例与运行，不是另存演示数据。
    await page.locator('[data-rv="project-view"][data-id="canvas"]').click();
    await expect(page.locator('.rv-flow-group')).toHaveCount(2);
    await expect(page.locator('.rv-canvas-flow[data-flow-real="true"]')).toHaveCount(2);
    await expect(page.locator('.rv-node[data-node-type="input"]').first()).toContainText('商品资料');
    await expect(page.locator('.rv-node[data-node-type="output"]').first()).toContainText('交付候选');
    await expect(page.locator('.rv-node[data-node-type="generate"]').first().locator('[data-node-cost]')).toHaveText('¥1.20');
    await expect(page.locator('.rv-node[data-node-type="generate"]').first().locator('.rv-node-status')).toHaveText('成功');
    await expect(page.locator('.rv-node[data-node-type="input"]').first().locator('[data-node-cost]')).toHaveText('只记成本');
    await expect(page.locator('[data-rv="node-delete"]')).toHaveCount(0);
    await expect(page.locator('[data-node-model]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. 项目运行成功但进度读取失败：显示过期提醒并允许只读恢复。
  {
    const mock = createMock();
    mock.state.project = { name: '进度恢复项目' };
    mock.state.plan.status = 'confirmed';
    mock.state.plan.deliverables = [{
      id: ID.d1, type: 'white', title: '白底主图', quantity: 1,
      prompt: { subject: '白色收纳盒', aspectRatio: '1:1' }, parameters: {}, price: { amountCents: 120 },
    }];
    mock.state.stepEvents = [{ step: 1, status: 'completed' }, { step: 2, status: 'completed' }];
    const { context, page, errors } = await openApp(browser, base, mock);
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await page.locator('[data-rv="open-project"]').first().click();
    await expect(page.locator('[data-rv="workflow-list"]')).toBeVisible();
    await page.locator('[data-rv="run-batch"]:visible').click();
    await expect(page.locator('[data-batch-estimate]')).toBeVisible();
    mock.state.failProjectReads = true;
    await page.locator('[data-rv="confirm-run"]:visible').click();
    await expect(page.locator('[data-project-lifecycle-error]')).toContainText('进度暂未同步');
    await expect(page.locator('[data-view="project"]')).not.toContainText('项目进度已由服务端同步');
    const writes = mock.state.calls.filter(call => !call.startsWith('GET ')).length;
    mock.state.failProjectReads = false;
    await page.locator('[data-rv="retry-lifecycle"]').click();
    await expect(page.locator('[data-project-lifecycle-error]')).toHaveCount(0);
    await expect(page.locator('.rv-steps [data-rv="step"][data-id="3"]')).toContainText('已完成');
    await expect(page.locator('[data-delivery-versions] tbody tr')).toHaveCount(1);
    assert.equal(mock.state.calls.filter(call => !call.startsWith('GET ')).length, writes);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. 懒加载页面失败保留导航，并提供不提交业务操作的重载恢复。
  {
    const mock = createMock();
    const { context, page, errors } = await openApp(browser, base, mock);
    await page.route('**/assets/Projects.js', route => route.abort('failed'));
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-workspace-error]')).toContainText('工作区暂时无法打开');
    await expect(page.locator('.rail-btn')).toHaveCount(5);
    await page.locator('.rail-btn[data-nav="products"]').click();
    await expect(page.locator('#products-notice')).toBeVisible();
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-workspace-error]')).toBeVisible();
    await page.unroute('**/assets/Projects.js');
    await page.locator('[data-rv="reload-workspace"]').click();
    await expect(page.locator('.rail-btn')).toHaveCount(5);
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-projects-empty]')).toBeVisible();
    assert.equal(mock.state.calls.some(call => call.startsWith('POST ')), false);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 4. 接口错误：项目列表与项目详情显示真实错误态，不回退演示项目。
  {
    const mock = createMock();
    mock.state.project = { name: '错误态项目' };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/session') {
        return route.fulfill({ json: { csrfToken: CSRF, mode: 'account', authenticated: true, user: USER, mustChangePassword: false, setupRequired: false } });
      }
      if (path === '/api/models') return route.fulfill({ json: { providers: [], models: [] } });
      if (path === '/api/jobs') return route.fulfill({ json: { jobs: [] } });
      if (path === '/api/projects') return route.fulfill({ status: 503, json: { error: { code: 'DB_UNAVAILABLE', message: '项目列表暂时不可用。' } } });
      if (path === `/api/projects/${ID.project}`) return route.fulfill({ status: 503, json: { error: { code: 'DB_UNAVAILABLE', message: '项目详情暂时不可用。' } } });
      return route.fulfill({ status: 404, json: { error: { code: 'TEST_UNMOCKED', message: path } } });
    });
    await page.goto(base);
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-projects-error]')).toContainText('项目列表暂时不可用');
    await expect(page.locator('[data-projects-state]')).toHaveAttribute('data-projects-state', 'error');
    const body = await page.locator('body').innerText();
    assert.equal(/白色收纳盒 · 秋日上新|演示项目|演示费用/.test(body), false, '错误态不得出现演示项目');
    // 详情错误：用一个成功列表行进入项目，详情接口返回 503。
    await page.unroute('**/api/**');
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/session') return route.fulfill({ json: { csrfToken: CSRF, mode: 'account', authenticated: true, user: USER, mustChangePassword: false, setupRequired: false } });
      if (path === '/api/models') return route.fulfill({ json: { providers: [], models: [] } });
      if (path === '/api/jobs') return route.fulfill({ json: { jobs: [] } });
      if (path === '/api/products') return route.fulfill({ json: { products: [product], total: 1, limit: 100, offset: 0, nextOffset: null } });
      if (path === '/api/projects') return route.fulfill({ json: { projects: [{
        id: ID.project, name: '错误态项目', status: 'draft', productId: product.id, skuId: product.skus[0].id,
        skuSpec: product.skus[0].spec, currentPlanVersion: 1, planStatus: 'draft',
        progress: { completed: 0, total: 6, label: '0/6' },
        currentStep: { step: 1, key: 'product', name: '商品资料', status: 'in_progress' },
        estimate: { currency: 'CNY', totalCents: 0, pendingPriceCount: 0, deliverableCount: 0 },
      }], total: 1, limit: 100, offset: 0, nextOffset: null } });
      if (path === `/api/projects/${ID.project}`) return route.fulfill({ status: 503, json: { error: { code: 'DB_UNAVAILABLE', message: '项目详情暂时不可用。' } } });
      return route.fulfill({ status: 404, json: { error: { code: 'TEST_UNMOCKED', message: path } } });
    });
    await page.locator('[data-rv="retry-projects"]').click();
    await page.locator('[data-rv="open-project"]').first().click();
    await expect(page.locator('[data-project-error]')).toContainText('项目详情暂时不可用');
    await expect(page.locator('[data-project-loading]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 5. 只读角色：隐藏新建、规划、保存、确认、开跑与画布写操作。
  {
    const mock = createMock();
    mock.state.project = { name: '只读项目' };
    const { context, page, errors } = await openApp(browser, base, mock, { role: 'viewer' });
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await expect(page.locator('[data-rv="new-project"]')).toHaveCount(0);
    await expect(page.locator('[data-projects-table]')).toContainText('只读项目');
    await page.locator('[data-rv="open-project"]').first().click();
    await expect(page.locator('[data-view="project"]')).toContainText('当前角色只读');
    await expect(page.locator('[data-rv="precheck"]')).toHaveCount(0);
    await page.locator('.rv-steps [data-rv="step"][data-id="2"]').click();
    await expect(page.locator('[data-rv="suggest-plan"]')).toHaveCount(0);
    await expect(page.locator('[data-rv="save-plan"]')).toHaveCount(0);
    await expect(page.locator('[data-rv="freeze-plan"]')).toHaveCount(0);
    await expect(page.locator('#rv-requirement')).toBeDisabled();
    await expect(page.locator('[data-plan-prompt]')).toHaveCount(0);
    await page.locator('[data-rv="project-view"][data-id="canvas"]').click();
    await expect(page.locator('.rv-flow-group')).toHaveCount(0);
    await expect(page.locator('[data-rv="prepare-workflow"]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 6. 手机画布只读：真实节点可查看，但没有模型/删除/追加等编辑控件。
  {
    const mock = createMock();
    mock.state.project = { name: '手机项目' };
    mock.state.plan.deliverables = [
      { id: ID.d1, type: 'white', title: '白底主图', quantity: 1, prompt: { subject: '白色收纳盒', aspectRatio: '1:1' }, parameters: {}, price: { amountCents: 120 } },
      { id: ID.d2, type: 'scene', title: '生活场景图', quantity: 1, prompt: { subject: '白色收纳盒', aspectRatio: '1:1' }, parameters: {}, price: { amountCents: 120 } },
    ];
    mock.state.plan.status = 'confirmed';
    mock.state.plan.productVersion = product.version;
    mock.state.plan.productSnapshot = snapshot();
    mock.state.stepEvents = [{ step: 1, status: 'completed' }, { step: 2, status: 'completed' }];
    mock.state.stepCurrent = 3;
    [ID.d1, ID.d2].forEach((id, index) => mock.state.instances.set(id, instanceFor(mock.state.plan.deliverables[index], index)));
    const { context, page, errors } = await openApp(browser, base, mock, { viewport: { width: 390, height: 844 } });
    await page.locator('.gen-mobile-nav [data-screen="projects"]').click();
    await page.locator('[data-rv="open-project"]').first().click();
    await page.locator('[data-rv="project-view"][data-id="canvas"]').click();
    await expect(page.locator('.rv-canvas-mobile')).toBeVisible();
    await expect(page.locator('.rv-canvas-mobile')).toContainText('手机端画布只读');
    await expect(page.locator('.rv-canvas-flow[data-flow-real="true"]')).toHaveCount(2);
    await expect(page.locator('[data-rv="node-delete"]')).toHaveCount(0);
    await expect(page.locator('[data-node-model]')).toHaveCount(0);
    await expect(page.locator('[data-add-node]')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `手机端不应横向溢出：${overflow}px`);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 7. Persisted workflow editor, conflict recovery, template save and reuse.
  {
    const mock = createMock();
    mock.state.project = { name: 'Workflow editor project' };
    mock.state.plan = { ...newPlan('confirmed'), deliverables: [
      { id: ID.d1, type: 'white', title: 'White hero', quantity: 1, prompt: { subject: 'Storage box', aspectRatio: '1:1' }, parameters: { modelId: 'test:image' } },
      { id: ID.d2, type: 'white', title: 'Extra angle', quantity: 1, prompt: { subject: 'Storage box', aspectRatio: '1:1' }, parameters: { modelId: 'test:image' } },
    ] };
    mock.state.instances.set(ID.d1, instanceFor(mock.state.plan.deliverables[0], 0));
    const { context, page, errors } = await openApp(browser, base, mock);
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await page.locator('[data-rv="open-project"]').first().click();
    await page.locator('[data-rv="project-view"][data-id="canvas"]').click();
    const group = page.locator('.rv-flow-group[data-item-id="' + ID.d1 + '"]');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.rv-canvas-mobile')).toBeVisible();
    await expect(group.locator('[data-rv="edit-workflow"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.rv-canvas-mobile')).toBeHidden();
    await expect(group.locator('[data-rv="edit-workflow"]')).toBeVisible();
    await group.locator('[data-rv="edit-workflow"]').click();
    await group.locator('[data-workflow-param="prompt:prompt"]').fill('Keep the white handle and use soft side lighting');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.rv-canvas-mobile')).toBeVisible();
    await expect(group.locator('[data-workflow-editor-readonly]')).toContainText('未保存的草稿仍保留');
    await expect(group.locator('[data-rv="finish-workflow-edit"]')).toContainText('结束编辑并丢弃草稿');
    await page.locator('.gen-mobile-nav [data-screen="assets"]').click();
    await expect(page.locator('[data-view="project"]')).toHaveCount(1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(group.locator('[data-workflow-param="prompt:prompt"]')).toHaveValue('Keep the white handle and use soft side lighting');
    await group.locator('[data-workflow-param="generate:size"]').fill('1536x1536');
    await group.locator('[data-rv="add-edit"]').click();
    await expect(group.locator('[data-workflow-node]')).toHaveCount(5);
    await group.locator('[data-workflow-node^="edit-"] [data-rv="remove-workflow-node"]').click();
    await expect(group.locator('[data-workflow-node]')).toHaveCount(4);
    mock.state.workflowConflict = true;
    await group.locator('[data-rv="save-workflow"]').click();
    await expect(group.locator('[data-workflow-editor-error]')).toContainText('重新读取');
    await expect(group.locator('[data-workflow-param="prompt:prompt"]')).toHaveValue('Keep the white handle and use soft side lighting');
    assert.equal(mock.state.instances.get(ID.d1).revision, 1);
    mock.state.workflowConflict = false;
    await group.locator('[data-rv="save-workflow"]').click();
    await expect(group.locator('[data-workflow-editor-notice]')).toContainText('已保存工作流');
    assert.equal(mock.state.instances.get(ID.d1).nodes.find(node => node.id === 'generate').params.size, '1536x1536');
    await group.locator('[data-workflow-template-name]').fill('Soft light storage template');
    await group.locator('[data-rv="save-workflow-template"]').click();
    await expect(group.locator('[data-workflow-editor-notice]')).toContainText('已保存模板');
    const second = page.locator('.rv-flow-group[data-item-id="' + ID.d2 + '"]');
    await second.locator('[data-workflow-template-select]').selectOption('custom-test:1');
    await second.locator('[data-rv="prepare-workflow"]').click();
    await expect(second.locator('.rv-canvas-flow')).toHaveCount(1);
    assert.equal(mock.state.instances.get(ID.d2).templateKey, 'custom-test');
    await group.locator('[data-rv="finish-workflow-edit"]').click();
    await page.locator('.rail-btn[data-nav="projects"]').click();
    await page.locator('[data-rv="open-project"]').first().click();
    await page.locator('[data-rv="project-view"][data-id="canvas"]').click();
    await group.locator('[data-rv="edit-workflow"]').click();
    await expect(group.locator('[data-workflow-param="prompt:prompt"]')).toHaveValue('Keep the white handle and use soft side lighting');
    assert.equal(mock.state.calls.some(call => call === 'POST /api/workflow-runs'), false);
    assert.deepEqual(mock.state.violations, []);
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log('project-real-browser: 7 scenarios passed (workflow editing and templates, core flow and race, lifecycle recovery, chunk recovery, error, viewer, mobile)');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
