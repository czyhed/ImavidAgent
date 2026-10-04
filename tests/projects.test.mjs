import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import { AuditService } from '../server/audit.mjs';
import { BillingService } from '../server/billing.mjs';
import { ProductService, snapshotProduct } from '../server/products.mjs';
import {
  PgProjectRepository, ProjectService, computeProjectStepState, computeSteps, deriveProjectStatus,
} from '../server/projects.mjs';

// 测试只使用内存仓储与本地确定性价格，不连接 PostgreSQL、不调用模型、不产生费用。

class MemoryProjectRepository {
  projects = new Map();
  plans = new Map();
  events = new Map();
  sequence = 0;

  #appendEvents(projectId, events) {
    const rows = this.events.get(projectId);
    for (const event of events) rows.push({ ...structuredClone(event), sequence: ++this.sequence });
  }

  async createProject({ project, plan }) {
    this.projects.set(project.id, structuredClone(project));
    this.plans.set(project.id, new Map([[plan.version, structuredClone(plan)]]));
    this.events.set(project.id, []);
    return { project: structuredClone(project), plan: structuredClone(plan) };
  }

  async getProject(id) {
    const row = this.projects.get(id);
    return row ? structuredClone(row) : null;
  }

  async list(filters) {
    const q = filters.q.toLowerCase();
    const all = [...this.projects.values()]
      .filter(project => {
        if (filters.statuses.length && !filters.statuses.includes(project.status)) return false;
        if (filters.from && project.updatedAt < filters.from) return false;
        if (filters.to && project.updatedAt > filters.to) return false;
        if (!q) return true;
        return [project.name, project.skuSpec, project.productId, project.skuId]
          .some(value => String(value || '').toLowerCase().includes(q));
      })
      .sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    const rows = all.slice(filters.offset, filters.offset + filters.limit).map(project => ({
      project: structuredClone(project),
      plan: structuredClone(this.plans.get(project.id)?.get(project.currentPlanVersion) || null),
    }));
    return { rows, total: all.length };
  }

  async getPlan(projectId, version) {
    const plan = this.plans.get(projectId)?.get(version);
    return plan ? structuredClone(plan) : null;
  }

  async listPlans(projectId) {
    return [...(this.plans.get(projectId)?.values() || [])]
      .sort((a, b) => b.version - a.version)
      .map(plan => structuredClone(plan));
  }

  async listEvents(projectId) {
    return [...(this.events.get(projectId) || [])]
      .sort((a, b) => a.sequence - b.sequence)
      .map(event => structuredClone(event));
  }

  async updateProject(id, expectedVersion, mutate) {
    const current = this.projects.get(id);
    if (!current) return { status: 'missing' };
    if (current.version !== expectedVersion) return { status: 'conflict', currentVersion: current.version };
    const next = await mutate(structuredClone(current));
    const record = {
      ...current,
      name: next.name ?? current.name,
      status: next.status ?? current.status,
      cancelledAt: next.status === 'cancelled' ? (next.cancelledAt || new Date()) : (next.cancelledAt ?? null),
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.projects.set(id, record);
    return { status: 'ok', project: structuredClone(record) };
  }

  async updatePlan(projectId, version, expectedRevision, patch) {
    const plan = this.plans.get(projectId)?.get(version);
    if (!plan) return { status: 'plan_missing' };
    if (plan.status === 'confirmed' && !patch.allowConfirmed) return { status: 'confirmed' };
    if (plan.revision !== expectedRevision) return { status: 'conflict', currentRevision: plan.revision };
    const next = {
      ...plan,
      deliverables: structuredClone(patch.deliverables ?? plan.deliverables),
      requirement: patch.requirement === undefined ? plan.requirement : patch.requirement,
      price: structuredClone(patch.price ?? plan.price),
      changeReason: patch.changeReason ?? plan.changeReason,
      revision: plan.revision + 1,
      updatedAt: patch.updatedAt || new Date(),
    };
    this.plans.get(projectId).set(version, next);
    const project = this.projects.get(projectId);
    if (project) project.updatedAt = new Date();
    return { status: 'ok', plan: structuredClone(next) };
  }

  async createPlanVersion({ projectId, expectedCurrentVersion, expectedProjectVersion, plan, projectPatch }) {
    const project = this.projects.get(projectId);
    if (!project) return { status: 'missing' };
    if (project.currentPlanVersion !== expectedCurrentVersion
      || (expectedProjectVersion !== undefined && project.version !== expectedProjectVersion)) {
      return { status: 'conflict', currentVersion: project.version };
    }
    this.plans.get(projectId).set(plan.version, structuredClone(plan));
    project.currentPlanVersion = plan.version;
    project.status = projectPatch?.status ?? project.status;
    project.version += 1;
    project.updatedAt = projectPatch?.updatedAt || new Date();
    return { status: 'ok', project: structuredClone(project), plan: structuredClone(plan) };
  }

  async confirmPlan({ projectId, version, expectedRevision, planPatch, events, projectPatch }) {
    const project = this.projects.get(projectId);
    if (!project) return { status: 'missing' };
    const plan = this.plans.get(projectId)?.get(version);
    if (!plan) return { status: 'plan_missing' };
    if (plan.status === 'confirmed') return { status: 'confirmed' };
    if (plan.revision !== expectedRevision) return { status: 'conflict', currentRevision: plan.revision };
    const next = {
      ...plan,
      ...structuredClone(planPatch),
      revision: plan.revision + 1,
    };
    this.plans.get(projectId).set(version, next);
    this.#appendEvents(projectId, events);
    project.status = projectPatch?.status || 'active';
    project.currentPlanVersion = version;
    project.version += 1;
    project.updatedAt = projectPatch?.updatedAt || new Date();
    return { status: 'ok', project: structuredClone(project), plan: structuredClone(next) };
  }

  async appendEvents({ projectId, events, projectPatch }) {
    const project = this.projects.get(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    this.#appendEvents(projectId, events);
    project.status = projectPatch?.status || project.status;
    project.version += 1;
    project.updatedAt = projectPatch?.updatedAt || new Date();
    return structuredClone(project);
  }
}

// 与 PgProductRepository 相同的比较并交换契约，供 ProductService 使用。
class MemoryProductRepository {
  rows = new Map();
  history = new Map();

  async create({ product, skus, reason }) {
    const now = new Date();
    const record = {
      ...product, version: 1, confirmedAt: null, createdAt: now, updatedAt: now,
      skus: structuredClone(skus),
    };
    this.rows.set(record.id, record);
    this.history.set(record.id, [{
      id: randomUUID(), version: 1, changeReason: reason, createdBy: 'local',
      createdAt: now, snapshot: snapshotProduct(record),
    }]);
    return structuredClone(record);
  }

  async get(id) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async list() {
    return { products: [...this.rows.values()].map(row => structuredClone(row)), total: this.rows.size };
  }

  async mutate(id, expectedVersion, mutate) {
    const current = this.rows.get(id);
    if (!current) return { status: 'missing' };
    if (expectedVersion !== null && expectedVersion !== current.version) {
      return { status: 'conflict', currentVersion: current.version };
    }
    const next = await mutate(structuredClone(current));
    if (next.unchanged) return { status: 'ok', product: structuredClone(current) };
    const record = {
      ...next.product, version: current.version + 1, updatedAt: new Date(),
      skus: structuredClone(next.skus),
    };
    this.rows.set(id, record);
    this.history.get(id).push({
      id: randomUUID(), version: record.version, changeReason: next.reason,
      createdBy: 'local', createdAt: new Date(), snapshot: snapshotProduct(record),
    });
    return { status: 'ok', product: structuredClone(record) };
  }

  async versions(id, { limit, offset }) {
    const product = this.rows.get(id);
    if (!product) return null;
    const list = [...this.history.get(id)].sort((a, b) => b.version - a.version);
    return {
      version: product.version,
      versions: list.slice(offset, offset + limit).map(item => structuredClone(item)),
      total: list.length,
    };
  }
}

class MemoryBillingRepository {
  constructor(prices = []) { this.prices = prices; }

  async getActivePrice({ capability, modelId, tier = 'default' }) {
    return this.prices.find(price => price.capability === capability
      && price.modelId === modelId && price.active !== false
      && (price.tier === tier || price.tier === 'default')) || null;
  }
}

function priceRow(modelId, unitPrice = '0.5') {
  return {
    id: randomUUID(), workspaceId: 'local', capability: 'image.generate', modelId,
    tier: 'default', unit: 'image', currency: 'CNY', unitPrice,
    billingMode: 'chargeable', version: 1, active: true,
    effectiveFrom: new Date(0), effectiveTo: null,
  };
}

function fixture() {
  const repository = new MemoryProjectRepository();
  const products = new ProductService(new MemoryProductRepository());
  const billing = new BillingService(new MemoryBillingRepository([
    priceRow('test:image', '0.5'),
    priceRow('test:expensive', '2.25'),
  ]));
  const projects = new ProjectService(repository, { products, billing });
  return { repository, products, billing, projects };
}

async function confirmedProduct(products, name = '折叠收纳箱') {
  const product = await products.create({
    name,
    skus: [{ spec: '白色 / 大号', price: { amount: 99, currency: 'CNY', type: 'sale' } }],
  });
  return products.confirm(product.id, { version: product.version });
}

function deliverable(patch = {}) {
  return {
    type: 'white',
    title: '白底主图',
    quantity: 1,
    prompt: {
      subject: '商品主体', scene: '纯白背景', composition: '正面居中', lighting: '柔和光线',
      style: '真实摄影', material: '以资料为准', mustKeep: '保持形状与颜色',
      forbidden: '未确认的材质与卖点', aspectRatio: '1:1',
    },
    copy: [{ slot: 'headline', text: '折叠收纳箱' }],
    parameters: { modelId: 'test:image', capability: 'image.generate', size: '1024x1024' },
    ...patch,
  };
}

async function createDraftProject(projects, products) {
  const product = await confirmedProduct(products);
  const detail = await projects.create({
    productId: product.id,
    skuId: product.skus[0].id,
    deliverables: [deliverable()],
  });
  return { product, detail };
}

test('项目 = 商品 × SKU × 一次交付：草稿方案报价来自 quote，未定价保留 NULL', async () => {
  const { projects, products } = fixture();
  const product = await confirmedProduct(products);
  const detail = await projects.create({
    productId: product.id,
    skuId: product.skus[0].id,
    name: '秋季主图交付',
    requirement: '突出收纳容量',
    deliverables: [
      deliverable({ quantity: 2 }),
      deliverable({
        type: 'scene', title: '户外场景', prompt: { aspectRatio: '3:4' },
        parameters: { modelId: 'unknown:model' },
      }),
      deliverable({ type: 'detail', title: '包装清单', parameters: {} }),
    ],
  });

  assert.equal(detail.project.name, '秋季主图交付');
  assert.equal(detail.project.status, 'draft');
  assert.equal(detail.project.currentPlanVersion, 1);
  assert.equal(detail.project.progress.label, '0/6');
  assert.equal(detail.plan.version, 1);
  assert.equal(detail.plan.status, 'draft');
  assert.equal(detail.plan.revision, 1);
  assert.equal(detail.plan.requirement, '突出收纳容量');
  assert.equal(detail.plan.deliverables.length, 3);

  // 数量 2 × 单价 0.5 = 50 分；价格原样来自 BillingService.quote。
  const priced = detail.plan.deliverables[0];
  assert.equal(priced.price.amountCents, 100);
  assert.equal(priced.price.unitPrice, '0.5');
  assert.equal(priced.price.unit, 'image');
  assert.equal(priced.price.priced, true);
  assert.equal(priced.prompt.aspectRatio, '1:1');
  assert.equal(priced.promptText.includes('主体/数量'), true);

  // 未配置价格与没有模型都必须保持 NULL，并计入待核价。
  assert.equal(detail.plan.deliverables[1].price.amountCents, null);
  assert.equal(detail.plan.deliverables[1].price.status, 'pending_price');
  assert.equal(detail.plan.deliverables[2].price.amountCents, null);
  assert.equal(detail.plan.price.totalCents, 100);
  assert.equal(detail.plan.price.pendingPriceCount, 2);
  assert.equal(detail.plan.price.hasPendingPrice, true);
});

test('确认方案冻结资料版本与价格，之后商品改版不影响旧项目', async () => {
  const { projects, products } = fixture();
  const { product, detail } = await createDraftProject(projects, products);
  const confirmed = await products.confirm(product.id, { version: product.version });
  assert.equal(confirmed.status, 'confirmed');

  const plan = await projects.get(detail.project.id);
  const confirmedPlan = await projects.confirmPlan(
    detail.project.id, 1, { reason: '客户确认' }, { ifMatch: `"r${plan.plan.revision}"` },
  );

  assert.equal(confirmedPlan.plan.status, 'confirmed');
  assert.equal(confirmedPlan.plan.productVersion, confirmed.version);
  assert.equal(confirmedPlan.plan.productSnapshot.name, '折叠收纳箱');
  assert.equal(confirmedPlan.plan.skuSnapshot.id, confirmed.skus[0].id);
  assert.equal(confirmedPlan.plan.deliverables[0].price.amountCents, 50);
  assert.equal(confirmedPlan.plan.price.totalCents, 50);
  assert.equal(confirmedPlan.project.status, 'active');
  assert.equal(confirmedPlan.project.progress.label, '2/6');
  assert.deepEqual(confirmedPlan.steps.slice(0, 2).map(item => item.status), ['completed', 'completed']);
  assert.equal(confirmedPlan.steps[2].status, 'pending');

  // 商品改版后，旧项目仍读取确认时的快照与价格。
  const revised = await products.update(product.id, {
    name: '折叠收纳箱 2026 新款',
    version: confirmed.version,
    skus: [{ spec: '白色 / 特大号', price: { amount: 129, currency: 'CNY', type: 'sale' } }],
  });
  assert.equal(revised.version, confirmed.version + 1);
  assert.equal(revised.name, '折叠收纳箱 2026 新款');

  const reread = await projects.get(detail.project.id);
  assert.equal(reread.plan.productVersion, confirmed.version);
  assert.equal(reread.plan.productSnapshot.name, '折叠收纳箱');
  assert.equal(reread.plan.deliverables[0].price.amountCents, 50);
  assert.equal((await projects.plan(detail.project.id, 1)).plan.productSnapshot.name, '折叠收纳箱');
});

test('确认前商品资料未确认时拒绝确认方案', async () => {
  const { projects, products } = fixture();
  const product = await products.create({ name: '未确认商品', skus: [{}] });
  const detail = await projects.create({
    productId: product.id,
    skuId: product.skus[0].id,
    deliverables: [deliverable()],
  });
  await assert.rejects(
    projects.confirmPlan(detail.project.id, 1, {}, { ifMatch: '"r1"' }),
    { code: 'PRODUCT_NOT_CONFIRMED', status: 409 },
  );
});

test('已确认方案不可修改；追加交付项生成 v2 且已执行项原样保留', async () => {
  const { projects, products } = fixture();
  const product = await confirmedProduct(products);
  const detail = await projects.create({
    productId: product.id,
    skuId: product.skus[0].id,
    deliverables: [
      deliverable({ title: '白底主图' }),
      deliverable({ type: 'scene', title: '场景图', prompt: { aspectRatio: '3:4' } }),
    ],
  });
  const v1 = await projects.confirmPlan(detail.project.id, 1, {}, { ifMatch: `"r${detail.plan.revision}"` });

  await assert.rejects(
    projects.updatePlan(detail.project.id, 1, {
      deliverables: [deliverable({ title: '试图改已确认方案' })],
      revision: v1.plan.revision,
    }),
    { code: 'PLAN_CONFIRMED', status: 409 },
  );

  const first = v1.plan.deliverables[0];
  const executed = await projects.markDeliverableExecuted(detail.project.id, first.id, { jobId: 'job-001' });
  assert.equal(executed.created, true);
  assert.equal(executed.deliverable.status, 'executed');
  assert.equal(executed.deliverable.jobId, 'job-001');

  const current = await projects.get(detail.project.id);
  const v2 = await projects.addDeliverables(detail.project.id, 1, {
    deliverables: [deliverable({ type: 'detail', title: '包装清单', parameters: { modelId: 'test:image' } })],
  }, { ifMatch: `"r${current.plan.revision}"` });

  assert.equal(v2.plan.version, 2);
  assert.equal(v2.plan.status, 'draft');
  assert.equal(v2.plan.deliverables.length, 3);
  assert.equal(v2.project.currentPlanVersion, 2);

  // 已执行项在 v2 中原样复制：编号、执行状态、价格与执行记录都不变。
  const copied = v2.plan.deliverables[0];
  assert.equal(copied.id, first.id);
  assert.equal(copied.status, 'executed');
  assert.equal(copied.executedAt, executed.deliverable.executedAt);
  assert.equal(copied.price.amountCents, first.price.amountCents);
  assert.equal(copied.title, first.title);
  // 新交付项得到新编号并单独估价。
  assert.notEqual(v2.plan.deliverables[2].id, first.id);
  assert.equal(v2.plan.deliverables[2].price.amountCents, 50);

  // v1 仍是已确认的 2 项清单。
  const v1Again = await projects.plan(detail.project.id, 1);
  assert.equal(v1Again.plan.status, 'confirmed');
  assert.equal(v1Again.plan.version, 1);
  assert.equal(v1Again.plan.deliverables.length, 2);

  // 确认 v2 时冻结的是最新商品版本，已执行项仍然不被覆盖。
  const revised = await products.update(product.id, {
    name: '折叠收纳箱 2027', version: product.version,
  });
  const beforeV2Confirm = await projects.get(detail.project.id);
  const v2Confirmed = await projects.confirmPlan(detail.project.id, 2, {}, {
    ifMatch: `"r${beforeV2Confirm.plan.revision}"`,
  });
  assert.equal(v2Confirmed.plan.status, 'confirmed');
  assert.equal(v2Confirmed.plan.productVersion, revised.version);
  assert.equal(v2Confirmed.plan.productSnapshot.name, '折叠收纳箱 2027');
  assert.equal(v2Confirmed.plan.deliverables[0].id, first.id);
  assert.equal(v2Confirmed.plan.deliverables[0].status, 'executed');
  assert.equal(v2Confirmed.plan.deliverables[0].executedAt, executed.deliverable.executedAt);
});

test('编辑与追加使用乐观锁；缺修订号 428，过期修订号 409', async () => {
  const { projects, products } = fixture();
  const { product, detail } = await createDraftProject(projects, products);
  await products.confirm(product.id, { version: product.version });

  await assert.rejects(
    projects.updatePlan(detail.project.id, 1, { deliverables: [deliverable()] }),
    { code: 'REVISION_REQUIRED', status: 428 },
  );
  await assert.rejects(
    projects.updatePlan(detail.project.id, 1, { deliverables: [deliverable()], revision: 99 }),
    { code: 'VERSION_CONFLICT', status: 409 },
  );
  await assert.rejects(
    projects.update(detail.project.id, { name: '新名称' }, {}),
    { code: 'VERSION_REQUIRED', status: 428 },
  );
  await assert.rejects(
    projects.update(detail.project.id, { name: '新名称', version: 99 }),
    { code: 'VERSION_CONFLICT', status: 409 },
  );

  const edited = await projects.updatePlan(detail.project.id, 1, {
    deliverables: [deliverable({ title: '修改后的标题' })],
  }, { ifMatch: '"r1"' });
  assert.equal(edited.plan.revision, 2);
  assert.equal(edited.plan.deliverables[0].title, '修改后的标题');

  // 读取方案后原样回传（含 id、status、price 等服务端字段）仍可保存，服务端忽略只读字段。
  const roundTrip = await projects.updatePlan(detail.project.id, 1, {
    deliverables: edited.plan.deliverables,
  }, { ifMatch: '"r2"' });
  assert.equal(roundTrip.plan.revision, 3);
  assert.equal(roundTrip.plan.deliverables[0].id, edited.plan.deliverables[0].id);
  assert.equal(roundTrip.plan.deliverables[0].price.amountCents, 50);

  const confirmed = await projects.confirmPlan(detail.project.id, 1, {}, { ifMatch: '"r3"' });
  await assert.rejects(
    projects.confirmPlan(detail.project.id, 1, {}, { ifMatch: '"r1"' }),
    { code: 'PLAN_CONFIRMED', status: 409 },
  );
  const current = await projects.get(detail.project.id);
  assert.equal(current.plan.revision, confirmed.plan.revision);
  await assert.rejects(
    projects.addDeliverables(detail.project.id, 1, {
      deliverables: [deliverable({ type: 'scene' })],
    }, { ifMatch: '"r1"' }),
    { code: 'VERSION_CONFLICT', status: 409 },
  );
});

test('步骤状态由事件推进，列表进度按六步已完成数 4/6', async () => {
  const { projects, products } = fixture();
  const { product, detail } = await createDraftProject(projects, products);
  await products.confirm(product.id, { version: product.version });
  const confirmed = await projects.confirmPlan(detail.project.id, 1, {}, { ifMatch: '"r1"' });
  assert.equal(confirmed.progress.label, '2/6');

  const three = await projects.recordStepEvent(detail.project.id, 3, { status: 'in_progress' });
  assert.equal(three.progress.label, '2/6');
  assert.equal(three.currentStep.step, 3);
  assert.equal(three.project.status, 'active');

  const four = await projects.recordStepEvent(detail.project.id, 3, { status: 'completed' });
  assert.equal(four.progress.label, '3/6');
  assert.equal(four.currentStep.step, 4);
  const five = await projects.recordStepEvent(detail.project.id, 4, { status: 'completed' });
  assert.equal(five.progress.label, '4/6');
  assert.equal(five.progress.completed, 4);
  assert.equal(five.currentStep.step, 5);
  assert.equal(five.project.status, 'review');
  // 前面的步骤未完成时，不能直接完成后面的步骤。
  await assert.rejects(
    projects.recordStepEvent(detail.project.id, 6, { status: 'completed' }),
    { code: 'STEP_OUT_OF_ORDER', status: 409 },
  );

  await projects.recordStepEvent(detail.project.id, 5, { status: 'completed' });
  const exported = await projects.recordStepEvent(detail.project.id, 6, { status: 'completed' });
  assert.equal(exported.progress.label, '6/6');
  assert.equal(exported.currentStep, null);
  assert.equal(exported.project.status, 'completed');

  // 项目列表读取的是同一事件推导结果。
  const list = await projects.list();
  const row = list.projects.find(item => item.id === detail.project.id);
  assert.equal(row.progress.label, '6/6');
  assert.equal(row.status, 'completed');
});

test('列表支持名称、状态与时间筛选及分页', async () => {
  const { projects, products } = fixture();
  const names = ['春季主图', '夏季场景', '秋季详情'];
  for (const name of names) {
    const product = await confirmedProduct(products, name);
    await projects.create({
      productId: product.id,
      skuId: product.skus[0].id,
      name,
      deliverables: [deliverable()],
    });
  }
  const all = await projects.list();
  assert.equal(all.total, 3);
  assert.equal(all.limit, 20);
  assert.equal(all.offset, 0);
  assert.equal(all.nextOffset, null);

  const firstPage = await projects.list({ limit: 2 });
  assert.equal(firstPage.projects.length, 2);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.nextOffset, 2);
  const secondPage = await projects.list({ limit: 2, offset: 2 });
  assert.equal(secondPage.projects.length, 1);
  assert.equal(secondPage.nextOffset, null);

  const searched = await projects.list({ q: '场景' });
  assert.equal(searched.total, 1);
  assert.equal(searched.projects[0].name, '夏季场景');

  const none = await projects.list({ status: 'completed' });
  assert.equal(none.total, 0);
  const drafts = await projects.list({ status: 'draft' });
  assert.equal(drafts.total, 3);

  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  assert.equal((await projects.list({ from: future })).total, 0);
  assert.equal((await projects.list({ to: past })).total, 0);
  assert.equal((await projects.list({ from: past, to: future })).total, 3);

  await assert.rejects(projects.list({ status: 'unknown' }), { code: 'INVALID_FILTER' });
  await assert.rejects(projects.list({ limit: 101 }), { code: 'INVALID_FIELD' });
  await assert.rejects(projects.list({ from: future, to: past }), { code: 'INVALID_DATE' });
});

test('取消项目后保留方案并拒绝继续推进', async () => {
  const { projects, products } = fixture();
  const { detail } = await createDraftProject(projects, products);
  const cancelled = await projects.update(
    detail.project.id, { status: 'cancelled', reason: '客户取消' }, { ifMatch: '"v1"' },
  );
  assert.equal(cancelled.project.status, 'cancelled');
  assert.ok(cancelled.project.cancelledAt);
  assert.equal(cancelled.plan.deliverables.length, 1);
  assert.equal(cancelled.project.progress.label, '0/6');
});

test('computeSteps 只按最新事件推进，skipped 跳过当前步骤但不算完成', () => {
  const now = new Date();
  const event = (step, status) => ({
    id: randomUUID(), step, status, note: null, createdAt: now,
  });
  const state = computeSteps([
    event(1, 'completed'), event(2, 'completed'), event(3, 'skipped'),
  ]);
  assert.equal(state.label, '2/6');
  assert.equal(state.currentStep.step, 4);
});

test('项目六步从当前方案、运行、候选、审核与导出证据推算', () => {
  const project = { id: 'p1', status: 'active' };
  const plan = {
    status: 'confirmed',
    deliverables: [{ id: 'd1', status: 'planned' }, { id: 'd2', status: 'planned' }],
  };
  const events = [{ step: 1, status: 'completed' }, { step: 2, status: 'completed' }];
  const evidence = {
    runs: [
      { deliverableId: 'd1', status: 'succeeded' },
      { deliverableId: 'd2', status: 'running' },
    ],
    candidateDeliverableIds: [],
    approvedDeliverableIds: [],
    exports: [],
  };

  let state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.steps[2].status, 'in_progress');
  assert.equal(state.currentStep.step, 3);

  evidence.runs[1].status = 'partial_failed';
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.steps[2].status, 'needs_review');
  assert.equal(state.currentStep.step, 3);

  evidence.runs[1].status = 'succeeded';
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.steps[2].status, 'completed');
  assert.equal(state.currentStep.step, 4);

  evidence.candidateDeliverableIds = ['d1'];
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.steps[3].status, 'in_progress');
  assert.equal(state.currentStep.step, 4);

  evidence.candidateDeliverableIds = ['d1', 'd2'];
  evidence.approvedDeliverableIds = ['d1'];
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.steps[4].status, 'in_progress');
  assert.equal(state.currentStep.step, 5);

  evidence.approvedDeliverableIds = ['d1', 'd2'];
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.steps[5].status, 'in_progress');
  assert.equal(state.currentStep.step, 6);

  evidence.exports = [{ status: 'completed', missingCount: 0, matchesCurrentCandidates: true }];
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.progress.label, '6/6');
  assert.equal(state.currentStep, null);
  assert.equal(deriveProjectStatus(project, state, true), 'completed');

  evidence.candidateDeliverableIds = ['d1'];
  evidence.approvedDeliverableIds = ['d1'];
  evidence.exports = [];
  state = computeProjectStepState({ project, plan, events, evidence });
  assert.equal(state.currentStep.step, 4);
});

test('未确认的新方案版本会退回方案步骤并清空后续旧进度', () => {
  const state = computeProjectStepState({
    project: { status: 'active' },
    plan: { status: 'draft', deliverables: [{ id: 'd1' }] },
    events: [1, 2, 3, 4, 5, 6].map(step => ({ step, status: 'completed' })),
    evidence: { runs: [], candidateDeliverableIds: [], approvedDeliverableIds: [], exports: [] },
  });
  assert.equal(state.steps[0].status, 'completed');
  assert.equal(state.steps[1].status, 'in_progress');
  assert.equal(state.steps[2].status, 'pending');
  assert.equal(state.progress.label, '1/6');
  assert.equal(state.currentStep.step, 2);
});

test('PostgreSQL lifecycle adapter groups current plan evidence by project scope', async () => {
  let captured;
  const repository = new PgProjectRepository({
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [
        { kind: 'run', project_id: 'p1', plan_version: 2, deliverable_id: 'd1', value: 'succeeded', missing_count: null },
        { kind: 'candidate', project_id: 'p1', plan_version: 2, deliverable_id: 'd1', value: 'v1', missing_count: null },
        { kind: 'approved', project_id: 'p1', plan_version: 2, deliverable_id: 'd1', value: 'v1', missing_count: null },
        { kind: 'export', project_id: 'p1', plan_version: 2, deliverable_id: null, value: 'completed', missing_count: 0, matches_current_candidates: true },
      ] };
    },
  });
  const result = await repository.getLifecycleEvidence([{
    projectId: 'p1', planVersion: 2, deliverableIds: ['d1'],
  }]);
  const evidence = result.get('p1:2');
  assert.deepEqual(evidence.runs, [{ deliverableId: 'd1', status: 'succeeded' }]);
  assert.deepEqual(evidence.candidateDeliverableIds, ['d1']);
  assert.deepEqual(evidence.approvedDeliverableIds, ['d1']);
  assert.deepEqual(evidence.exports, [{ status: 'completed', missingCount: 0, matchesCurrentCandidates: true }]);
  assert.equal(captured.params[1], 'local');
  assert.match(captured.sql, /sj_workflow_runs/);
  assert.match(captured.sql, /sj_deliverable_reviews/);
  assert.match(captured.sql, /sj_project_exports/);
  assert.equal(JSON.parse(captured.params[0])[0].deliverable_ids[0], 'd1');
});

// ---- HTTP 接口 ----

class MemoryAuditRepository {
  rows = [];
  async insertAudit(row) {
    const record = { ...row, id: randomUUID(), createdAt: row.createdAt || new Date() };
    this.rows.push(record);
    return structuredClone(record);
  }
  async listAudit() { return { rows: structuredClone(this.rows), total: this.rows.length }; }
}

test('HTTP：创建、确认、冲突与审计，CSRF 仍然生效', async t => {
  const { projects, products } = fixture();
  const product = await confirmedProduct(products);
  const auditRepository = new MemoryAuditRepository();
  const server = createServer({
    projects,
    audit: new AuditService(auditRepository),
    port: 0,
    root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  const denied = await fetch(base + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(denied.status, 403);

  const createdResponse = await fetch(base + '/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      productId: product.id,
      skuId: product.skus[0].id,
      name: '接口项目',
      deliverables: [deliverable()],
    }),
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get('etag'), '"v1"');
  const created = await createdResponse.json();
  assert.equal(created.project.name, '接口项目');
  assert.equal(created.plan.price.totalCents, 50);
  assert.equal(auditRepository.rows.some(row => row.action === 'project.created'), true);

  const noRevision = await fetch(
    `${base}/api/projects/${created.project.id}/plans/1/confirm`,
    { method: 'POST', headers, body: JSON.stringify({}) },
  );
  assert.equal(noRevision.status, 428);

  const confirmedResponse = await fetch(
    `${base}/api/projects/${created.project.id}/plans/1/confirm`,
    { method: 'POST', headers: { ...headers, 'If-Match': '"r1"' }, body: JSON.stringify({}) },
  );
  assert.equal(confirmedResponse.status, 200);
  const confirmed = await confirmedResponse.json();
  assert.equal(confirmed.plan.status, 'confirmed');
  assert.equal(confirmed.project.progress.label, '2/6');
  assert.equal(auditRepository.rows.some(row => row.action === 'project.plan.confirmed'), true);

  const editConfirmed = await fetch(
    `${base}/api/projects/${created.project.id}/plans/1`,
    {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': `"r${confirmed.plan.revision}"` },
      body: JSON.stringify({ deliverables: [deliverable()] }),
    },
  );
  assert.equal(editConfirmed.status, 409);
  assert.equal((await editConfirmed.json()).error.code, 'PLAN_CONFIRMED');

  const listResponse = await fetch(`${base}/api/projects?q=接口&status=draft`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.total, 0); // 已确认后状态为 active，不再匹配 draft
  const activeList = await (await fetch(`${base}/api/projects?status=active`)).json();
  assert.equal(activeList.total, 1);

  const planResponse = await fetch(`${base}/api/projects/${created.project.id}/plans/1`);
  assert.equal(planResponse.status, 200);
  assert.equal(planResponse.headers.get('etag'), `"r${confirmed.plan.revision}"`);
});


test('手工执行标记、未知运行、部分导出和旧候选快照不能伪造完成', () => {
  const input = {
    project: { status: 'active' },
    plan: { status: 'confirmed', deliverables: [{ id: 'd1', status: 'executed' }] },
    events: [{ step: 1, status: 'completed' }, { step: 2, status: 'completed' }],
    evidence: { runs: [], producedDeliverableIds: [], candidateDeliverableIds: [], approvedDeliverableIds: [], exports: [] },
  };
  assert.equal(computeProjectStepState(input).currentStep.step, 3);
  input.evidence.producedDeliverableIds = ['d1'];
  input.evidence.runs = [{ deliverableId: 'd1', status: 'unknown' }];
  assert.equal(computeProjectStepState(input).steps[2].status, 'needs_review');
  input.evidence.runs = [];
  input.evidence.candidateDeliverableIds = ['d1'];
  input.evidence.approvedDeliverableIds = ['d1'];
  input.evidence.exports = [{ status: 'completed', missingCount: 1, matchesCurrentCandidates: true }];
  assert.equal(computeProjectStepState(input).currentStep.step, 6);
  input.evidence.exports = [{ status: 'completed', missingCount: 0, matchesCurrentCandidates: false }];
  assert.equal(computeProjectStepState(input).currentStep.step, 6);
  input.evidence.exports[0].matchesCurrentCandidates = true;
  assert.equal(computeProjectStepState(input).progress.label, '6/6');
  input.evidence.candidateDeliverableIds = [];
  input.evidence.approvedDeliverableIds = [];
  assert.equal(computeProjectStepState(input).currentStep.step, 4);
  assert.equal(computeProjectStepState(input).steps[5].status, 'pending');
});
