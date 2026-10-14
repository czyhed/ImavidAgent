import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, DashboardService, PgDashboardRepository } from '../server/aggregate.mjs';
import { routes } from '../server/routes/dashboard.mjs';

// 工作台聚合测试：全部使用内存仓储与固定时间，不连接 PostgreSQL、不调用模型、不产生费用。
// 重点覆盖“已知为空返回 0”和“数据源不可用返回 null”的区别，防止把未知统计成 0。

const NOW = new Date('2026-10-21T08:00:00.000Z');

const project = (patch) => ({
  id: patch.id,
  name: patch.name || `项目 ${patch.id}`,
  skuSpec: patch.skuSpec || '白色 / 中号',
  status: patch.status || 'active',
  planStatus: patch.planStatus || 'confirmed',
  currentStep: patch.currentStep === undefined
    ? { step: 2, key: 'plan', label: '方案报价', status: 'in_progress' }
    : patch.currentStep,
  progress: patch.progress || { completed: 1, total: 6 },
  estimate: patch.estimate || { currency: 'CNY', totalCents: 2500, pendingPriceCount: 0, deliverableCount: 3 },
  updatedAt: patch.updatedAt || '2026-10-20T10:00:00.000Z',
  ...patch,
});

const SNAPSHOT = {
  workspaceId: 'local',
  projects: [
    project({
      id: 'p1', name: '秋季主图', planStatus: 'draft', status: 'draft',
      currentStep: { step: 1, key: 'product', label: '商品资料', status: 'in_progress' },
      progress: { completed: 0, total: 6 },
      estimate: { currency: 'CNY', totalCents: 1000, pendingPriceCount: 1, deliverableCount: 2 },
      updatedAt: '2026-10-20T12:00:00.000Z',
    }),
    project({
      id: 'p2', name: '详情页精修', status: 'active',
      currentStep: { step: 5, key: 'review', label: '质检审核', status: 'needs_review' },
      progress: { completed: 4, total: 6 },
      updatedAt: '2026-10-20T11:00:00.000Z',
    }),
    project({
      id: 'p3', name: '已完成项目', status: 'completed', currentStep: null,
      progress: { completed: 6, total: 6 }, updatedAt: '2026-10-19T10:00:00.000Z',
    }),
    project({
      id: 'p4', name: '春季草图', planStatus: 'draft', status: 'active',
      currentStep: { step: 2, key: 'plan', label: '方案报价', status: 'in_progress' },
      progress: { completed: 1, total: 6 }, updatedAt: '2026-10-18T10:00:00.000Z',
    }),
  ],
  tasks: {
    total: 7,
    byStatus: {
      queued: 1, submitting: 0, running: 1, storing: 0,
      succeeded: 3, failed: 1, unknown: 1, cancelled: 0,
    },
  },
  products: { total: 5, pending: 2 },
  outputs: { total: 4, available: 3, unavailable: 1 },
  billing: {
    currency: 'CNY',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-31T23:59:59.999Z',
    settledCents: 12345,
    costOnlyMicros: 9000,
    pendingPriceCount: 2,
  },
  activity: {
    audit: [
      {
        id: 'audit-1', actorEmail: 'ops@example.test', actorRole: 'operator',
        action: 'project.plan.confirmed', targetType: 'project', targetId: 'p2',
        result: 'success', createdAt: '2026-10-20T09:00:00.000Z',
      },
      {
        id: 'audit-2', actorEmail: 'admin@example.test', actorRole: 'admin',
        action: 'project.updated', targetType: 'project', targetId: 'p1',
        result: 'success', createdAt: '2026-10-20T08:00:00.000Z',
      },
    ],
    jobEvents: [
      { id: 'event-1', jobId: 'job-1', event: 'failed', createdAt: '2026-10-20T10:00:00.000Z' },
    ],
    projectEvents: [
      {
        id: 'project-event-1', projectId: 'p2', step: 5, stepKey: 'review',
        status: 'needs_review', createdAt: '2026-10-20T09:30:00.000Z',
      },
    ],
  },
};

const clone = () => structuredClone(SNAPSHOT);

class MemoryRepository {
  constructor(snapshot = clone(), { failing = [] } = {}) {
    this.snapshot = snapshot;
    this.failing = new Set(failing);
    this.activityArgs = null;
  }

  #read(name) {
    if (this.failing.has(name)) throw new Error(`${name} unavailable`);
    return this.snapshot[name];
  }

  async projects() { return this.#read('projects'); }
  async products() { return this.#read('products'); }
  async tasks() { return this.#read('tasks'); }
  async outputs() { return this.#read('outputs'); }
  async billing() { return this.#read('billing'); }
  async activity(workspaceId, options) {
    this.activityArgs = { workspaceId, ...options };
    return this.#read('activity');
  }
}

test('buildDashboard aggregates counts, todos, anomalies and amounts from known data', () => {
  const snapshot = clone();
  snapshot.products.pendingProductId = 'prod-1';
  const result = buildDashboard(snapshot, { role: 'operator', now: () => NOW });

  assert.deepEqual(result.scope, { mode: 'local', role: 'operator', amountsVisible: true });
  assert.equal(result.generatedAt, NOW.toISOString());
  assert.deepEqual(result.sources, {
    projects: 'ok', tasks: 'ok', products: 'ok',
    outputs: 'ok', billing: 'ok', activity: 'ok',
  });

  assert.equal(result.metrics.projects.total, 4);
  assert.deepEqual(result.metrics.projects.byStatus, {
    draft: 1, active: 2, review: 0, completed: 1, cancelled: 0,
  });
  assert.equal(result.metrics.projects.awaitingPlan, 2);
  assert.equal(result.metrics.projects.inReview, 1);
  assert.equal(result.metrics.projects.completed, 1);

  assert.equal(result.metrics.tasks.total, 7);
  assert.equal(result.metrics.tasks.active, 2);
  assert.equal(result.metrics.tasks.succeeded, 3);
  assert.equal(result.metrics.tasks.failed, 1);
  assert.equal(result.metrics.tasks.unknown, 1);
  assert.deepEqual(result.metrics.products, { total: 5, pending: 2, pendingProductId: 'prod-1' });
  assert.equal(result.todos.find(row => row.key === 'products.pending').targetProductId, 'prod-1');
  assert.equal(result.todos.find(row => row.key === 'projects.plan').targetProjectId, 'p1');
  assert.equal(result.todos.find(row => row.key === 'projects.review').targetProjectId, 'p2');
  assert.deepEqual(result.metrics.outputs, { total: 4, available: 3, unavailable: 1 });

  assert.deepEqual(result.amounts, {
    currency: 'CNY',
    period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' },
    settledCents: 12345,
    costOnlyMicros: 9000,
    pendingPriceCount: 2,
  });

  assert.deepEqual(result.todos.map(row => [row.key, row.count]), [
    ['products.pending', 2], ['projects.plan', 2], ['projects.review', 1],
  ]);
  assert.deepEqual(result.anomalies.map(row => [row.key, row.count]), [
    ['tasks.failed', 1], ['tasks.unknown', 1],
    ['billing.pending_price', 2], ['outputs.unavailable', 1],
  ]);
  assert.equal(result.recent.projects.length, 4);
  assert.deepEqual(result.recent.projects.map(row => row.id), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(result.recent.projects[0].estimate.totalCents, 1000);
});

test('known empty collections return zeros, while unavailable sources return null', () => {
  const empty = buildDashboard({
    workspaceId: 'local',
    projects: [],
    tasks: { total: 0, byStatus: {} },
    products: { total: 0, pending: 0 },
    outputs: { total: 0, available: 0, unavailable: 0 },
    billing: { settledCents: 0, costOnlyMicros: 0, pendingPriceCount: 0 },
    activity: { audit: [], jobEvents: [], projectEvents: [] },
  }, { role: 'admin', now: () => NOW });

  assert.equal(empty.metrics.projects.total, 0);
  assert.equal(empty.metrics.tasks.total, 0);
  assert.equal(empty.metrics.products.total, 0);
  assert.equal(empty.metrics.outputs.total, 0);
  assert.equal(empty.amounts.settledCents, 0);
  assert.deepEqual(empty.todos, []);
  assert.deepEqual(empty.anomalies, []);
  assert.deepEqual(empty.recent.projects, []);
  assert.deepEqual(empty.recent.activity, []);

  const unavailable = buildDashboard({
    workspaceId: 'local',
    projects: null,
    tasks: null,
    products: null,
    outputs: null,
    billing: null,
    activity: null,
  }, { role: 'admin', now: () => NOW });

  assert.equal(unavailable.metrics.projects, null);
  assert.equal(unavailable.metrics.tasks, null);
  assert.equal(unavailable.metrics.products, null);
  assert.equal(unavailable.metrics.outputs, null);
  assert.equal(unavailable.amounts, null);
  assert.equal(unavailable.recent.projects, null);
  assert.equal(unavailable.recent.activity, null);
  assert.deepEqual(Object.values(unavailable.sources), Array(6).fill('unavailable'));
  assert.equal(unavailable.todos.length, 3);
  assert.ok(unavailable.todos.every(row => row.count === null));
  assert.equal(unavailable.anomalies.length, 4);
  assert.ok(unavailable.anomalies.every(row => row.count === null));
});

test('viewer sees counts and todos but no amount details or project estimates', () => {
  const result = buildDashboard(clone(), { role: 'viewer', now: () => NOW });

  assert.equal(result.scope.amountsVisible, false);
  assert.equal(result.amounts, null);
  assert.equal(result.metrics.projects.total, 4);
  assert.equal(result.metrics.tasks.total, 7);
  assert.ok(result.todos.some(row => row.key === 'products.pending' && row.count === 2));
  assert.ok(result.recent.projects.every(row => row.estimate === null));
  assert.ok(result.recent.projects.every(row => !('settledCents' in row)));
  assert.ok(!JSON.stringify(result).includes('12345'));
});

test('recent activity is merged, sorted, limited and never includes prompt text', () => {
  const snapshot = clone();
  snapshot.activity = {
    audit: Array.from({ length: 9 }, (_, index) => ({
      id: `audit-${index}`,
      actorEmail: 'ops@example.test',
      actorRole: 'operator',
      action: 'project.updated',
      targetType: 'project',
      targetId: `p${index}`,
      result: 'success',
      prompt: 'SHOULD NOT LEAK',
      createdAt: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(),
    })),
    jobEvents: [{
      id: 'job-event-1', jobId: 'job-1', event: 'failed',
      createdAt: '2026-10-20T00:10:00.000Z',
    }],
    projectEvents: [{
      id: 'project-event-1', projectId: 'p2', step: 5, stepKey: 'review',
      status: 'needs_review', createdAt: '2026-10-20T00:09:00.000Z',
    }],
  };

  const result = buildDashboard(snapshot, { role: 'operator', now: () => NOW });
  assert.equal(result.recent.activity.length, 8);
  assert.deepEqual(result.recent.activity.map(row => row.id), [
    'job:job-event-1', 'project-event:project-event-1',
    'audit:audit-8', 'audit:audit-7', 'audit:audit-6',
    'audit:audit-5', 'audit:audit-4', 'audit:audit-3',
  ]);
  assert.equal(result.recent.activity[0].result, 'failure');
  assert.equal(result.recent.activity[1].result, 'failure');
  assert.equal(result.recent.activity[2].title, '更新项目');
  assert.ok(!JSON.stringify(result.recent.activity).includes('SHOULD NOT LEAK'));
  assert.ok(!JSON.stringify(result.recent.activity).includes('prompt'));
});

test('DashboardService isolates failed sources and passes actor scope to activity', async () => {
  const repository = new MemoryRepository(clone(), { failing: ['billing', 'outputs'] });
  const service = new DashboardService(repository, {
    workspaceId: 'workspace-a', role: 'operator', now: () => NOW,
  });
  const result = await service.get({ auditScope: { canReadAll: false, actorId: 'user-1' } });

  assert.equal(result.scope.mode, 'workspace');
  assert.equal(result.sources.billing, 'unavailable');
  assert.equal(result.sources.outputs, 'unavailable');
  assert.equal(result.sources.projects, 'ok');
  assert.equal(result.amounts, null);
  assert.equal(result.metrics.outputs, null);
  assert.equal(result.metrics.projects.total, 4);
  assert.deepEqual(repository.activityArgs, {
    workspaceId: 'workspace-a', limit: 8, actorId: 'user-1',
  });
});

test('PostgreSQL product summary returns one stable pending product target', async () => {
  let sqlSeen = '';
  const repository = new PgDashboardRepository({ query: async (sql, values) => {
    sqlSeen = sql;
    assert.deepEqual(values, ['workspace-1']);
    return { rows: [{ total: 4, pending: 2, pending_product_id: 'prod-2' }] };
  } });
  assert.deepEqual(await repository.products('workspace-1'), { total: 4, pending: 2, pendingProductId: 'prod-2' });
  assert.match(sqlSeen, /ORDER BY updated_at ASC,id ASC LIMIT 1/);
});

test('GET /api/dashboard route returns the service payload and enforces viewer login', async () => {
  const route = routes().find(item => item.method === 'GET' && item.pattern.test('/api/dashboard'));
  assert.ok(route);

  let received = null;
  const ctx = {
    auth: {},
    user: { id: 'viewer-1', role: 'viewer', active: true, workspaceId: 'workspace-a' },
    dashboard: { async get(args) { received = args; return { ok: true }; } },
  };
  let status = null;
  let body = null;
  const handled = await route.handler({
    ctx,
    res: {},
    reply(_res, nextStatus, payload) { status = nextStatus; body = payload; },
  });

  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(received.auditScope.actorId, 'viewer-1');
  assert.equal(received.auditScope.canReadAll, false);

  await assert.rejects(
    () => route.handler({ ctx: { auth: {}, dashboard: ctx.dashboard }, res: {}, reply() {} }),
    error => error.code === 'UNAUTHENTICATED' && error.status === 401,
  );
  await assert.rejects(
    () => route.handler({
      ctx: {
        auth: {},
        user: { id: 'viewer-1', role: 'viewer', active: true, workspaceId: 'workspace-a' },
      },
      res: {},
      reply() {},
    }),
    error => error.code === 'DB_UNAVAILABLE' && error.status === 503,
  );
});
