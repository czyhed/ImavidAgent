import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import { RunService, publicRun } from '../server/run.mjs';
import { validateWorkflowGraph } from '../server/workflow.mjs';

// 全部使用内存仓储、假账本、假生成任务与假工作流实例：
// 不连接 PostgreSQL / Redis / MinIO，不调用任何付费模型，也不启动真实执行器。

function clone(value) {
  return structuredClone(value);
}

class MemoryRunRepository {
  runs = new Map();
  nodes = new Map();

  async getRun(id) {
    const row = this.runs.get(id);
    return row ? clone(row) : null;
  }

  async getRunByIdempotencyKey(workspaceId, key) {
    const row = [...this.runs.values()].find(item => item.workspaceId === workspaceId
      && item.idempotencyKey === key);
    return row ? clone(row) : null;
  }

  async findOpenRun(workspaceId, instanceId) {
    const row = [...this.runs.values()]
      .filter(item => item.workspaceId === workspaceId && item.workflowInstanceId === instanceId
        && !item.idempotencyKey
        && ['draft', 'estimating', 'awaiting_confirmation'].includes(item.status))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return row ? clone(row) : null;
  }

  async findLiveRun(workspaceId, instanceId) {
    const row = [...this.runs.values()]
      .filter(item => item.workspaceId === workspaceId && item.workflowInstanceId === instanceId
        && ['running', 'partial_failed'].includes(item.status))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return row ? clone(row) : null;
  }

  async latestRun(workspaceId, instanceId) {
    const row = [...this.runs.values()]
      .filter(item => item.workspaceId === workspaceId && item.workflowInstanceId === instanceId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return row ? clone(row) : null;
  }

  async listNodeRuns(runId) {
    return [...this.nodes.values()]
      .filter(row => row.runId === runId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.nodeId.localeCompare(b.nodeId))
      .map(clone);
  }

  #checkKey(row) {
    for (const existing of this.nodes.values()) {
      if (existing.workspaceId !== row.workspaceId) continue;
      if (existing.idempotencyKey !== row.idempotencyKey) continue;
      if (existing.runId === row.runId && existing.nodeId === row.nodeId) continue;
      throw new Error(`幂等键冲突：${row.idempotencyKey}`);
    }
  }

  #insertNode(row) {
    this.#checkKey(row);
    this.nodes.set(row.id, clone(row));
  }

  #upsertNode(row) {
    const existing = [...this.nodes.values()]
      .find(item => item.runId === row.runId && item.nodeId === row.nodeId);
    if (existing) {
      // 模拟 ON CONFLICT (run_id, node_id)：保留原主键，更新运行期字段。
      this.nodes.set(existing.id, { ...clone(row), id: existing.id });
      return clone(this.nodes.get(existing.id));
    }
    this.#insertNode(row);
    return clone(row);
  }

  async insertRun(run, nodeRuns = []) {
    this.runs.set(run.id, clone(run));
    for (const row of nodeRuns) this.#insertNode(row);
    return clone(run);
  }

  async updateRun(id, expectedRevision, patch) {
    const current = this.runs.get(id);
    if (!current) return { status: 'missing' };
    if (expectedRevision !== null && current.revision !== expectedRevision) {
      return { status: 'conflict', run: clone(current) };
    }
    const next = {
      ...clone(current), ...clone(patch),
      updatedAt: patch.updatedAt || new Date(),
      revision: expectedRevision === null ? current.revision : current.revision + 1,
    };
    this.runs.set(id, next);
    return { status: 'ok', run: clone(next) };
  }

  async updateNodeRun(id, patch) {
    const current = this.nodes.get(id);
    if (!current) return null;
    const next = { ...clone(current), ...clone(patch), updatedAt: patch.updatedAt || new Date() };
    this.nodes.set(id, next);
    return clone(next);
  }

  async mutateRun({ runId, expectedRevision = null, runPatch = {}, nodePatches = [], nodeUpserts = [] }) {
    const current = this.runs.get(runId);
    if (!current) return { status: 'missing' };
    if (expectedRevision !== null && current.revision !== expectedRevision) {
      return { status: 'conflict', run: clone(current) };
    }
    const next = {
      ...clone(current), ...clone(runPatch),
      updatedAt: runPatch.updatedAt || new Date(),
      revision: current.revision + 1,
    };
    this.runs.set(runId, next);
    for (const row of nodeUpserts) this.#upsertNode(row);
    for (const item of nodePatches) {
      const row = this.nodes.get(item.id);
      if (!row) continue;
      this.nodes.set(item.id, {
        ...clone(row), ...clone(item.patch), updatedAt: item.patch.updatedAt || new Date(),
      });
    }
    return { status: 'ok', run: clone(next) };
  }

  async confirmRun({ runId, expectedRevision, expectedInstanceRevision, runPatch, nodeRuns }) {
    const current = this.runs.get(runId);
    if (!current) return { status: 'missing' };
    if (this.currentInstanceRevision && this.currentInstanceRevision() !== expectedInstanceRevision) {
      return { status: 'instance_conflict' };
    }
    if (current.revision !== expectedRevision) return { status: 'conflict', run: clone(current) };
    if (current.status !== 'awaiting_confirmation' || current.idempotencyKey) {
      return { status: 'started', run: clone(current) };
    }
    const result = await this.mutateRun({ runId, expectedRevision, runPatch, nodeUpserts: nodeRuns });
    if (result.status === 'conflict') {
      if (result.run.idempotencyKey === runPatch.idempotencyKey) {
        return { status: 'started', run: result.run };
      }
    }
    return result;
  }

  async applyRetry({ runId, expectedRevision, runPatch, node, descendants }) {
    return this.mutateRun({
      runId,
      expectedRevision,
      runPatch,
      nodePatches: [
        { id: node.id, patch: Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'id')) },
        ...(descendants || []).map(item => ({ id: item.id, patch: item })),
      ],
    });
  }

  async createSuccessor({ oldRunId, expectedOldRevision, oldPatch, oldNodePatches = [], successor, nodeRuns }) {
    const current = this.runs.get(oldRunId);
    if (!current) return { status: 'missing' };
    if (current.revision !== expectedOldRevision) return { status: 'conflict', run: clone(current) };
    const next = {
      ...clone(current), ...clone(oldPatch),
      updatedAt: oldPatch.updatedAt || new Date(), revision: current.revision + 1,
    };
    this.runs.set(oldRunId, next);
    for (const item of oldNodePatches) {
      const row = this.nodes.get(item.id);
      if (row) this.nodes.set(item.id, { ...clone(row), ...clone(item.patch) });
    }
    this.runs.set(successor.id, clone(successor));
    for (const row of nodeRuns) this.#insertNode(row);
    return { status: 'ok', run: clone(successor), nodeRuns: nodeRuns.map(clone) };
  }

  allNodes() {
    return [...this.nodes.values()].map(clone);
  }
}

class MemoryBilling {
  prices = new Map();
  entries = [];
  state = new Map();
  releases = [];

  setPrice(capability, modelId, amountCents) {
    this.prices.set(`${capability}:${modelId}`, amountCents);
    return this;
  }

  async quote({ capability, modelId, tier = 'default', quantity = 1 }) {
    const amount = this.prices.get(`${capability}:${modelId}`);
    return {
      priced: amount !== undefined,
      status: amount === undefined ? 'pending_price' : 'priced',
      billingMode: 'chargeable',
      capability,
      modelId,
      tier,
      quantity,
      currency: 'CNY',
      amountCents: amount === undefined ? null : amount * quantity,
      unit: 'image',
      unitPrice: amount ?? null,
      priceId: null,
      priceVersion: 1,
    };
  }

  async reserve(body) {
    const state = this.state.get(body.taskId) || {};
    if (state.settle || state.release) {
      throw new AppError('TASK_FINALIZED', '任务已有终态流水。', 409);
    }
    if (state.reserve || state.pending) {
      const entry = state.reserve || state.pending;
      return { status: state.reserve ? 'reserved' : 'pending_price', created: false, entry: clone(entry), quote: entry.quote };
    }
    const quote = await this.quote(body);
    const entry = {
      taskId: body.taskId,
      amountCents: quote.amountCents,
      quote,
      idempotencyKey: body.idempotencyKey,
    };
    this.entries.push(clone(entry));
    this.state.set(body.taskId, {
      ...state,
      ...(quote.amountCents === null ? { pending: entry } : { reserve: entry }),
    });
    return {
      status: quote.amountCents === null ? 'pending_price' : 'reserved',
      created: true,
      entry: clone(entry),
      quote,
    };
  }

  async settle(taskId) {
    const state = this.state.get(taskId) || {};
    if (state.release) throw new AppError('TASK_RELEASED', '任务已释放。', 409);
    if (state.settle) return { status: 'settled', created: false, entry: clone(state.settle) };
    if (state.pending && !state.reserve) return { status: 'pending_price', created: false, entry: null };
    if (!state.reserve) throw new AppError('BILLING_TASK_NOT_FOUND', '任务不存在。', 404);
    const entry = { taskId, amountCents: state.reserve.amountCents };
    this.state.set(taskId, { ...state, settle: entry });
    return { status: 'settled', created: true, entry };
  }

  async release(taskId) {
    const state = this.state.get(taskId) || {};
    if (state.settle) throw new AppError('TASK_SETTLED', '任务已结算。', 409);
    if (state.release) return { status: 'released', created: false, entry: clone(state.release) };
    const source = state.reserve || state.pending;
    if (!source) throw new AppError('BILLING_TASK_NOT_FOUND', '任务不存在。', 404);
    this.releases.push({ taskId, amountCents: source.amountCents });
    this.state.set(taskId, { ...state, release: { taskId, amountCents: source.amountCents } });
    return { status: 'released', created: true, entry: { taskId, amountCents: source.amountCents } };
  }

  reservedTasks() {
    return [...this.state.entries()]
      .filter(([, state]) => state.reserve && !state.settle && !state.release)
      .map(([taskId]) => taskId);
  }

  heldCents() {
    return [...this.state.values()]
      .filter(state => state.reserve && !state.settle && !state.release)
      .reduce((total, state) => total + state.reserve.amountCents, 0);
  }
}

class FakeJobs {
  submissions = [];
  jobs = new Map();
  behavior = new Map();

  setBehavior(modelId, status) {
    this.behavior.set(modelId, status);
    return this;
  }

  async submit(input) {
    const id = randomUUID();
    const configured = this.behavior.get(input.modelId) || 'succeeded';
    const job = {
      id,
      status: configured,
      input,
      output: configured === 'succeeded' ? { bytes: 128 } : null,
      error: configured === 'failed'
        ? { code: 'UPSTREAM_FAILED' }
        : (configured === 'unknown' ? { code: 'UPSTREAM_UNKNOWN' } : null),
    };
    this.jobs.set(id, job);
    this.submissions.push({ ...clone(input), id });
    return clone(job);
  }

  async wait(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', '任务不存在。', 404);
    return clone(job);
  }

  async reconcile(jobId) {
    return this.wait(jobId);
  }

  complete(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('任务不存在');
    job.status = 'succeeded';
    job.output = { bytes: 128 };
    job.error = null;
    return clone(job);
  }

  countByNodeModel(modelId) {
    return this.submissions.filter(item => item.modelId === modelId).length;
  }
}

class MemoryWorkflows {
  constructor({ nodes, edges, projectId, planVersion = 1, deliverableId, planStatus = 'confirmed' }) {
    this.instance = {
      id: randomUUID(),
      workspaceId: 'local',
      projectId,
      planVersion,
      deliverableId,
      nodes: clone(nodes),
      edges: clone(edges),
      ports: {},
      lockedNodes: [],
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.planStatus = planStatus;
  }

  async getInstance(id, { workspaceId = null } = {}) {
    if (id !== this.instance.id) throw new AppError('INSTANCE_NOT_FOUND', '实例不存在。', 404);
    if (workspaceId && workspaceId !== this.instance.workspaceId) {
      throw new AppError('FORBIDDEN', '无权访问。', 403);
    }
    return { instance: clone(this.instance) };
  }

  async getDeliverableInstance(projectId, planVersion, deliverableId, { workspaceId = null } = {}) {
    const instance = this.instance;
    if (instance.projectId !== projectId || instance.planVersion !== Number(planVersion)
      || instance.deliverableId !== deliverableId) {
      throw new AppError('INSTANCE_NOT_FOUND', '实例不存在。', 404);
    }
    if (workspaceId && workspaceId !== instance.workspaceId) {
      throw new AppError('FORBIDDEN', '无权访问。', 403);
    }
    return {
      instance: clone(instance),
      deliverable: {
        id: deliverableId,
        type: 'white',
        title: '白底主图',
        status: 'planned',
        promptText: '主体：燕麦色陶瓷杯',
      },
      planStatus: this.planStatus,
      runnable: this.planStatus === 'confirmed',
    };
  }

  async updateInstance(id, body, { workspaceId = null, ifMatch = undefined } = {}) {
    const expected = Number(String(ifMatch || '').replace(/[^\d]/g, ''));
    if (id !== this.instance.id) throw new AppError('INSTANCE_NOT_FOUND', '实例不存在。', 404);
    if (workspaceId && workspaceId !== this.instance.workspaceId) {
      throw new AppError('FORBIDDEN', '无权访问。', 403);
    }
    if (!Number.isInteger(expected) || expected !== this.instance.revision) {
      throw new AppError('REVISION_CONFLICT', '实例已被修改。', 409);
    }
    const graph = validateWorkflowGraph(body.nodes, body.edges, {
      lockedNodes: this.instance.lockedNodes,
    });
    this.instance = {
      ...this.instance,
      nodes: graph.nodes,
      edges: graph.edges,
      revision: this.instance.revision + 1,
      updatedAt: new Date(),
    };
    return { instance: clone(this.instance) };
  }
}

class MemoryAudit {
  entries = [];

  async record(entry) {
    this.entries.push(clone(entry));
    return clone(entry);
  }
}

function makeGraph({ branches, prompt = '主体：燕麦色陶瓷杯' }) {
  const nodes = [
    { id: 'materials', type: 'input', name: '商品资料' },
    { id: 'prompt', type: 'prompt', name: '文本提示词', params: { prompt, copy: [] } },
  ];
  const edges = [
    { id: 'e-materials-prompt', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
  ];
  for (const branch of branches) {
    nodes.push({
      id: branch.id,
      type: branch.type,
      name: branch.name || branch.id,
      params: { modelId: branch.modelId, ...(branch.params || {}) },
    });
    const target = branch.type === 'edit' ? 'instruction' : 'prompt';
    edges.push({
      id: `e-prompt-${branch.id}`,
      source: 'prompt',
      sourcePort: 'prompt',
      target: branch.id,
      targetPort: target,
    });
    if (branch.after) {
      edges.push({
        id: `e-${branch.after}-${branch.id}`,
        source: branch.after,
        sourcePort: 'image',
        target: branch.id,
        targetPort: 'source',
      });
    }
  }
  nodes.push({ id: 'ready', type: 'output', name: '交付候选' });
  const outputSource = branches.find(branch => branch.output) || branches[0];
  edges.push({
    id: `e-${outputSource.id}-ready`,
    source: outputSource.id,
    sourcePort: 'image',
    target: 'ready',
    targetPort: 'result',
  });
  return { nodes, edges };
}

function fixture({ branches, planStatus = 'confirmed', prices = {}, behaviors = {} } = {}) {
  const projectId = randomUUID();
  const deliverableId = randomUUID();
  const graph = makeGraph({ branches });
  const workflows = new MemoryWorkflows({
    nodes: graph.nodes, edges: graph.edges, projectId, deliverableId, planStatus,
  });
  const billing = new MemoryBilling();
  for (const [key, amount] of Object.entries(prices)) {
    const [capability, modelId] = key.split('|');
    billing.setPrice(capability || 'image.generate', modelId, amount);
  }
  const jobs = new FakeJobs();
  for (const [modelId, status] of Object.entries(behaviors)) jobs.setBehavior(modelId, status);
  const audit = new MemoryAudit();
  const repository = new MemoryRunRepository();
  repository.currentInstanceRevision = () => workflows.instance.revision;
  const service = new RunService(repository, {
    workflows, billing, jobs, audit, autoStart: false,
  });
  return {
    service, workflows, billing, jobs, audit, repository,
    projectId, deliverableId, planVersion: 1, instanceId: workflows.instance.id,
  };
}

function basePrices(extra = {}) {
  return {
    'image.generate|test:image': 1000,
    'image.edit|test:image': 800,
    'image.generate|test:fail': 700,
    'image.generate|test:unknown': 900,
    'image.generate|test:unpriced': undefined,
    'image.edit|test:fail-edit': 600,
    ...extra,
  };
}

async function estimateAndConfirm(f, { key = `run-${randomUUID()}`, autoRun = false } = {}) {
  const estimated = await f.service.estimate({
    projectId: f.projectId, planVersion: f.planVersion, deliverableId: f.deliverableId,
  });
  const confirmed = await f.service.confirm({
    runId: estimated.run.id,
    idempotencyKey: key,
    revision: estimated.run.revision,
  });
  if (autoRun) await f.service.executeRun(estimated.run.id);
  return { estimated, confirmed, runId: estimated.run.id };
}

// ---- 逐节点估价 ----

test('逐节点估价：免费节点为 0，未定价节点保持 NULL 且不计入总额', async () => {
  const f = fixture({
    branches: [
      { id: 'preview', type: 'generate', modelId: 'test:image', output: true },
      { id: 'unknownPrice', type: 'generate', modelId: 'test:unpriced' },
    ],
    prices: basePrices(),
  });
  const result = await f.service.estimate({
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
  });
  const nodes = Object.fromEntries(result.estimate.nodes.map(node => [node.nodeId, node]));
  assert.equal(nodes.materials.amountCents, 0);
  assert.equal(nodes.prompt.amountCents, 0);
  assert.equal(nodes.ready.amountCents, 0);
  assert.equal(nodes.preview.amountCents, 1000);
  assert.equal(nodes.unknownPrice.amountCents, null);
  assert.equal(nodes.unknownPrice.status, 'pending_price');
  assert.equal(result.run.estimate.pendingPriceCount, 1);
  assert.equal(result.run.estimate.totalCents, 1000);
  assert.equal(result.estimate.totalCents, 1000);
  assert.equal(result.run.status, 'awaiting_confirmation');
  assert.equal(f.audit.entries.at(-1).action, 'workflow.run.estimated');
});

test('未选择模型的节点阻塞估价确认，不当成 0 元节点', async () => {
  const f = fixture({ branches: [{ id: 'modeless', type: 'generate', modelId: null, output: true }] });
  const result = await f.service.estimate({
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
  });
  const node = result.estimate.nodes.find(item => item.nodeId === 'modeless');
  assert.equal(node.amountCents, null);
  assert.equal(node.blocking, true);
  assert.equal(result.estimate.blockingCount, 1);
  await assert.rejects(
    () => f.service.confirm({
      runId: result.run.id, idempotencyKey: 'modeless-run', revision: result.run.revision,
    }),
    error => error.code === 'NODE_MODEL_MISSING',
  );
});

test('方案未确认时不能估价，也不能借确认接口绕过', async () => {
  const f = fixture({
    planStatus: 'draft',
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
  });
  await assert.rejects(
    () => f.service.estimate({
      projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
    }),
    error => error.code === 'PLAN_NOT_CONFIRMED' && error.status === 409,
  );
});

// ---- 一次确认、一次预占、重复确认幂等 ----

test('确认开跑只预占一次；同幂等键重复提交返回原运行', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const { estimated, confirmed } = await estimateAndConfirm(f, { key: 'confirm-once' });
  assert.equal(confirmed.created, true);
  assert.equal(confirmed.run.status, 'running');
  assert.equal(f.billing.reservedTasks().length, 1); // 只有一个付费节点
  assert.equal(f.billing.entries.filter(entry => entry.amountCents !== null).length, 1);

  const again = await f.service.confirm({
    runId: estimated.run.id, idempotencyKey: 'confirm-once', revision: estimated.run.revision,
  });
  assert.equal(again.created, false);
  assert.equal(again.run.id, estimated.run.id);
  assert.equal(f.billing.reservedTasks().length, 1);
  assert.equal(f.audit.entries.filter(entry => entry.action === 'workflow.run.confirmed').length, 1);

  const runs = [...f.repository.runs.values()];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].idempotencyKey, 'confirm-once');
});

test('确认时实例已被修改会要求重新估价，不按旧报价开跑', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const estimated = await f.service.estimate({
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
  });
  f.workflows.instance.revision += 1; // 模拟其他入口直接改了实例
  await assert.rejects(
    () => f.service.confirm({
      runId: estimated.run.id, idempotencyKey: 'stale-instance', revision: estimated.run.revision,
    }),
    error => error.code === 'INSTANCE_CHANGED' && error.status === 409,
  );
  assert.equal(f.billing.entries.length, 0);
});

test('确认开跑等待预占期间若工作流被保存，冲突并释放预占', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const estimated = await f.service.estimate({
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
  });
  let resumeReserve;
  let enteredReserve;
  const paused = new Promise(resolve => { resumeReserve = resolve; });
  const entered = new Promise(resolve => { enteredReserve = resolve; });
  const reserve = f.billing.reserve.bind(f.billing);
  f.billing.reserve = async (...args) => {
    enteredReserve();
    await paused;
    return reserve(...args);
  };

  const confirming = f.service.confirm({
    runId: estimated.run.id, idempotencyKey: 'save-during-reserve', revision: estimated.run.revision,
  });
  await entered;
  f.workflows.instance = { ...f.workflows.instance, revision: f.workflows.instance.revision + 1 };
  resumeReserve();

  await assert.rejects(confirming, error => error.code === 'INSTANCE_CHANGED' && error.status === 409);
  assert.equal(f.billing.reservedTasks().length, 0);
  assert.equal((await f.repository.getRun(estimated.run.id)).status, 'awaiting_confirmation');
});

// ---- 执行、DAG 顺序与产物 ----

test('按依赖顺序执行生图与改图，成功节点写入产物与成本', async () => {
  const f = fixture({
    branches: [
      { id: 'preview', type: 'generate', modelId: 'test:image' },
      {
        id: 'retouch', type: 'edit', modelId: 'test:image',
        after: 'preview', params: { instruction: '提亮背景' }, output: true,
      },
    ],
    prices: basePrices(),
  });
  const { confirmed } = await estimateAndConfirm(f, { autoRun: true });
  assert.equal(confirmed.run.status, 'running');
  assert.equal(f.jobs.submissions.length, 2);
  assert.equal(f.jobs.submissions[0].operation, 'generate');
  assert.equal(f.jobs.submissions[0].prompt, '主体：燕麦色陶瓷杯');
  assert.equal(f.jobs.submissions[1].operation, 'edit');
  assert.equal(f.jobs.submissions[1].sourceJobId, f.jobs.submissions[0].id);

  const run = await f.repository.getRun(confirmed.run.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.settledCents, 1800);
  const rows = await f.repository.listNodeRuns(run.id);
  const byNode = Object.fromEntries(rows.map(row => [row.nodeId, row]));
  assert.equal(byNode.preview.status, 'succeeded');
  assert.equal(byNode.preview.actualCostCents, 1000);
  assert.equal(byNode.preview.output.jobId, f.jobs.submissions[0].id);
  assert.equal(byNode.retouch.status, 'succeeded');
  assert.equal(byNode.retouch.actualCostCents, 800);
  assert.equal(byNode.materials.actualCostCents, 0);

  const confirmedIndex = f.audit.entries.findIndex(entry => entry.action === 'workflow.run.confirmed');
  const startedIndex = f.audit.entries.findIndex(entry => entry.action === 'workflow.run.started');
  assert.ok(confirmedIndex >= 0 && startedIndex > confirmedIndex);
});

test('待核价节点成功只留 NULL 成本，账本保留待核价记录', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:unpriced', output: true }],
    prices: basePrices(),
  });
  const { confirmed } = await estimateAndConfirm(f, { autoRun: true });
  const run = await f.repository.getRun(confirmed.run.id);
  assert.equal(run.status, 'succeeded');
  const row = (await f.repository.listNodeRuns(run.id)).find(item => item.nodeId === 'preview');
  assert.equal(row.amountCents, null);
  assert.equal(row.actualCostCents, null);
  assert.equal(row.status, 'succeeded');
  const state = f.billing.state.get(row.billingTaskId);
  assert.ok(state.pending);
  assert.equal(state.settle, undefined);
});

// ---- 失败隔离 ----

test('失败只停该分支：下游阻塞并释放预占，其他分支继续成功', async () => {
  const f = fixture({
    branches: [
      { id: 'good', type: 'generate', modelId: 'test:image', output: true },
      { id: 'bad', type: 'generate', modelId: 'test:fail' },
      {
        id: 'downstream', type: 'edit', modelId: 'test:image',
        after: 'bad', params: { instruction: '继续改图' },
      },
    ],
    prices: basePrices(),
    behaviors: { 'test:fail': 'failed' },
  });
  const { confirmed } = await estimateAndConfirm(f, { autoRun: true });
  const run = await f.repository.getRun(confirmed.run.id);
  assert.equal(run.status, 'partial_failed');
  const rows = await f.repository.listNodeRuns(run.id);
  const byNode = Object.fromEntries(rows.map(row => [row.nodeId, row]));
  assert.equal(byNode.good.status, 'succeeded');
  assert.equal(byNode.bad.status, 'failed');
  assert.equal(byNode.bad.errorCode, 'UPSTREAM_FAILED');
  assert.equal(byNode.downstream.status, 'blocked');
  assert.equal(byNode.downstream.errorCode, 'UPSTREAM_BLOCKED');
  assert.equal(byNode.downstream.reservedCents, 0);
  assert.equal(byNode.bad.reservedCents, 0);
  assert.equal(f.jobs.countByNodeModel('test:fail'), 1);
  assert.equal(f.jobs.countByNodeModel('test:image'), 1); // 下游未提交
  const releasedTasks = f.billing.releases.map(item => item.taskId);
  assert.ok(releasedTasks.includes(byNode.bad.billingTaskId));
  assert.ok(releasedTasks.includes(byNode.downstream.billingTaskId));
  assert.ok(f.audit.entries.some(entry => entry.action === 'workflow.run.branch_failed'
    && entry.detail.blockedNodeIds.includes('downstream')));
});

// ---- 未知状态 ----

test('未知状态保留预占、下游待定、不自动重生也不换模型', async () => {
  const f = fixture({
    branches: [
      { id: 'good', type: 'generate', modelId: 'test:image', output: true },
      { id: 'uncertain', type: 'generate', modelId: 'test:unknown' },
      {
        id: 'afterUncertain', type: 'edit', modelId: 'test:image',
        after: 'uncertain', params: { instruction: '等待原任务' },
      },
    ],
    prices: basePrices(),
    behaviors: { 'test:unknown': 'unknown' },
  });
  const { confirmed } = await estimateAndConfirm(f, { autoRun: true });
  let run = await f.repository.getRun(confirmed.run.id);
  assert.equal(run.status, 'running');
  let rows = await f.repository.listNodeRuns(run.id);
  let byNode = Object.fromEntries(rows.map(row => [row.nodeId, row]));
  assert.equal(byNode.uncertain.status, 'unknown');
  assert.equal(byNode.uncertain.reservedCents, 900);
  assert.equal(byNode.afterUncertain.status, 'pending');
  assert.equal(byNode.good.status, 'succeeded');
  assert.equal(f.jobs.submissions.length, 2);
  assert.equal(f.jobs.submissions[1].modelId, 'test:unknown');

  await f.service.executeRun(run.id);
  assert.equal(f.jobs.submissions.length, 2, '未知状态不能自动重新提交');
  run = await f.repository.getRun(run.id);
  assert.equal(run.status, 'running');

  await assert.rejects(
    () => f.service.retry(run.id, {
      nodeId: 'uncertain', idempotencyKey: 'retry-unknown', revision: run.revision,
    }),
    error => error.code === 'NODE_UNKNOWN' && error.status === 409,
  );

  // 人工查询原任务后按成功结算，不切换模型。
  const job = f.jobs.jobs.get(byNode.uncertain.jobId);
  f.jobs.complete(job.id);
  const reconciled = await f.service.reconcile(run.id, {
    nodeId: 'uncertain', revision: run.revision,
  });
  assert.equal(f.jobs.submissions.length, 2);
  assert.equal(f.jobs.submissions[1].modelId, 'test:unknown');
  assert.equal(reconciled.run.status, 'running'); // 下游还需执行
  await f.service.executeRun(run.id);
  rows = await f.repository.listNodeRuns(run.id);
  byNode = Object.fromEntries(rows.map(row => [row.nodeId, row]));
  assert.equal(byNode.uncertain.status, 'succeeded');
  assert.equal(byNode.afterUncertain.status, 'succeeded');
  assert.equal(f.jobs.submissions.length, 3);
  assert.equal(f.jobs.submissions[2].operation, 'edit');
});

// ---- 人工重试 ----

test('人工重试必须使用新幂等键，重试节点与解锁下游重新预占', async () => {
  const f = fixture({
    branches: [
      { id: 'bad', type: 'generate', modelId: 'test:fail' },
      {
        id: 'downstream', type: 'edit', modelId: 'test:image',
        after: 'bad', params: { instruction: '下游' }, output: true,
      },
    ],
    prices: basePrices(),
    behaviors: { 'test:fail': 'failed' },
  });
  const { confirmed } = await estimateAndConfirm(f, { autoRun: true });
  let run = await f.repository.getRun(confirmed.run.id);
  assert.equal(run.status, 'partial_failed');
  const badNode = (await f.repository.listNodeRuns(run.id)).find(row => row.nodeId === 'bad');
  const oldKey = badNode.idempotencyKey;
  const oldTaskId = badNode.billingTaskId;

  await assert.rejects(
    () => f.service.retry(run.id, {
      nodeId: 'bad', idempotencyKey: oldKey, revision: run.revision,
    }),
    error => error.code === 'IDEMPOTENCY_REUSED' && error.status === 409,
  );

  f.jobs.setBehavior('test:fail', 'succeeded');
  const retried = await f.service.retry(run.id, {
    nodeId: 'bad', idempotencyKey: 'manual-retry-1', revision: run.revision,
  });
  assert.equal(retried.created, true);
  const retryRow = retried.node;
  const retryRaw = (await f.repository.listNodeRuns(run.id)).find(row => row.nodeId === 'bad');
  assert.equal(retryRow.status, 'pending');
  assert.equal(retryRow.idempotencyKey, 'manual-retry-1');
  assert.notEqual(retryRaw.billingTaskId, oldTaskId);
  assert.equal(retryRow.reservedCents, 700);
  const lastTry = f.billing.entries.filter(entry => entry.taskId === retryRaw.billingTaskId);
  assert.equal(lastTry.length, 1);

  await f.service.executeRun(run.id);
  run = await f.repository.getRun(run.id);
  assert.equal(run.status, 'succeeded');
  const rows = await f.repository.listNodeRuns(run.id);
  const byNode = Object.fromEntries(rows.map(row => [row.nodeId, row]));
  assert.equal(byNode.bad.status, 'succeeded');
  assert.equal(byNode.bad.attempts, 2);
  assert.equal(byNode.downstream.status, 'succeeded');
  assert.equal(f.jobs.countByNodeModel('test:fail'), 2);
  assert.ok(f.audit.entries.some(entry => entry.action === 'workflow.run.retried'));
});

// ---- 开跑后修改未执行节点 ----

test('开跑后修改未执行节点会作废旧批次并要求重新估价与重新确认；已执行节点不重跑', async () => {
  const f = fixture({
    branches: [
      { id: 'good', type: 'generate', modelId: 'test:image' },
      { id: 'bad', type: 'generate', modelId: 'test:fail' },
      {
        id: 'downstream', type: 'edit', modelId: 'test:image',
        after: 'bad', params: { instruction: '旧指令' }, output: true,
      },
    ],
    prices: basePrices(),
    behaviors: { 'test:fail': 'failed' },
  });
  const { confirmed } = await estimateAndConfirm(f, { autoRun: true });
  const oldRun = await f.repository.getRun(confirmed.run.id);
  assert.equal(oldRun.status, 'partial_failed');
  const goodSubmissions = f.jobs.countByNodeModel('test:image');

  const changed = await f.service.reconfigure(oldRun.id, 'downstream', {
    params: { modelId: 'test:image', instruction: '新指令' },
    revision: oldRun.revision,
  });
  assert.equal(changed.run.status, 'awaiting_confirmation');
  assert.equal(changed.supersedesRunId, oldRun.id);
  assert.equal(changed.requiresEstimate, true);
  assert.equal(changed.requiresConfirmation, true);
  const cancelled = await f.repository.getRun(oldRun.id);
  assert.equal(cancelled.status, 'cancelled');

  const successorRows = await f.repository.listNodeRuns(changed.run.id);
  const successorByNode = Object.fromEntries(successorRows.map(row => [row.nodeId, row]));
  assert.equal(successorByNode.good.reused, true);
  assert.equal(successorByNode.good.status, 'succeeded');
  assert.equal(successorByNode.downstream.status, 'pending');
  assert.equal(successorByNode.downstream.quote.modelId, undefined);

  // 改已执行节点必须拒绝
  await assert.rejects(
    () => f.service.reconfigure(oldRun.id, 'good', {
      params: { modelId: 'test:image' }, revision: cancelled.revision,
    }),
    error => error.code === 'RUN_NOT_RECONFIGURABLE' || error.code === 'NODE_LOCKED',
  );

  // 重新估价：已成功节点不再计价，只对其余节点报价
  f.jobs.setBehavior('test:fail', 'succeeded');
  const reestimated = await f.service.estimate({
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
  });
  assert.equal(reestimated.run.id, changed.run.id);
  const estimateNodes = Object.fromEntries(reestimated.estimate.nodes.map(node => [node.nodeId, node]));
  assert.equal(estimateNodes.good.reused, true);
  assert.equal(estimateNodes.good.amountCents, 0);
  assert.equal(estimateNodes.downstream.amountCents, 800);
  assert.equal(reestimated.estimate.totalCents, 700 + 800);

  const reconfirmed = await f.service.confirm({
    runId: changed.run.id,
    idempotencyKey: 'confirm-after-reconfigure',
    revision: reestimated.run.revision,
  });
  assert.equal(reconfirmed.created, true);
  const reusedRow = (await f.repository.listNodeRuns(changed.run.id))
    .find(row => row.nodeId === 'good');
  assert.equal(reusedRow.status, 'succeeded');
  assert.equal(reusedRow.reused, true);

  await f.service.executeRun(changed.run.id);
  const finalRun = await f.repository.getRun(changed.run.id);
  assert.equal(finalRun.status, 'succeeded');
  const finalNodes = Object.fromEntries(
    (await f.repository.listNodeRuns(changed.run.id)).map(row => [row.nodeId, row]),
  );
  assert.equal(finalNodes.good.status, 'succeeded');
  assert.equal(finalNodes.bad.status, 'succeeded');
  assert.equal(finalNodes.downstream.status, 'succeeded');
  // 已成功节点没有被重新提交或重新预占
  assert.equal(f.jobs.countByNodeModel('test:image') > goodSubmissions, true);
  assert.equal(finalNodes.good.attempts, 1);
  assert.ok(f.audit.entries.some(entry => entry.action === 'workflow.run.reconfigured'));
});

// ---- 取消 ----

test('取消未开跑批次释放所有预占，已成功节点不受影响', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const { confirmed } = await estimateAndConfirm(f);
  assert.equal(f.billing.reservedTasks().length, 1);
  const run = await f.repository.getRun(confirmed.run.id);
  const cancelled = await f.service.cancel(run.id, { revision: run.revision, reason: '改需求' });
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.cancelReason, '改需求');
  assert.equal(f.billing.reservedTasks().length, 0);
  const row = (await f.repository.listNodeRuns(run.id)).find(item => item.nodeId === 'preview');
  assert.equal(row.status, 'skipped');
  assert.equal(row.errorCode, 'RUN_CANCELLED');
  assert.equal(f.jobs.submissions.length, 0);
  assert.ok(f.audit.entries.some(entry => entry.action === 'workflow.run.cancelled'));
});

// ---- HTTP 路由、ETag 与角色 ----

async function startServer(options) {
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    port: 0, root: new URL('../', import.meta.url), ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP：ETag 428/409、重复确认幂等、读角色与写角色分离', async t => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const users = {
    'viewer-token': { id: randomUUID(), role: 'viewer', active: true, workspaceId: 'local' },
    'operator-token': { id: randomUUID(), role: 'operator', active: true, workspaceId: 'local' },
  };
  const auth = {
    async authenticate(token) {
      return users[token] ? { session: { tokenHash: token }, user: users[token] } : null;
    },
  };
  const { server, base } = await startServer({ auth, run: f.service });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const operatorCookie = { Cookie: 'sj_session=operator-token' };
  const viewerCookie = { Cookie: 'sj_session=viewer-token' };
  const operatorSession = await (await fetch(`${base}/api/session`, { headers: operatorCookie })).json();
  const viewerSession = await (await fetch(`${base}/api/session`, { headers: viewerCookie })).json();

  const viewerEstimate = await fetch(`${base}/api/workflow-runs/estimate`, {
    method: 'POST',
    headers: { ...viewerCookie, 'Content-Type': 'application/json', 'x-csrf-token': viewerSession.csrfToken },
    body: JSON.stringify({
      projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
    }),
  });
  assert.equal(viewerEstimate.status, 403);

  const estimateResponse = await fetch(`${base}/api/workflow-runs/estimate`, {
    method: 'POST',
    headers: { ...operatorCookie, 'Content-Type': 'application/json', 'x-csrf-token': operatorSession.csrfToken },
    body: JSON.stringify({
      projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId,
    }),
  });
  assert.equal(estimateResponse.status, 200);
  const estimate = await estimateResponse.json();
  assert.equal(estimateResponse.headers.get('etag'), `"r${estimate.run.revision}"`);

  const body = { runId: estimate.run.id, idempotencyKey: 'http-confirm' };
  const missing = await fetch(`${base}/api/workflow-runs`, {
    method: 'POST',
    headers: { ...operatorCookie, 'Content-Type': 'application/json', 'x-csrf-token': operatorSession.csrfToken },
    body: JSON.stringify(body),
  });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).error.code, 'REVISION_REQUIRED');

  const stale = await fetch(`${base}/api/workflow-runs`, {
    method: 'POST',
    headers: {
      ...operatorCookie,
      'Content-Type': 'application/json',
      'x-csrf-token': operatorSession.csrfToken,
      'If-Match': '"r999"',
    },
    body: JSON.stringify(body),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');

  const confirmed = await fetch(`${base}/api/workflow-runs`, {
    method: 'POST',
    headers: {
      ...operatorCookie,
      'Content-Type': 'application/json',
      'x-csrf-token': operatorSession.csrfToken,
      'If-Match': `"r${estimate.run.revision}"`,
    },
    body: JSON.stringify(body),
  });
  assert.equal(confirmed.status, 201);
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.run.status, 'running');

  const repeated = await fetch(`${base}/api/workflow-runs`, {
    method: 'POST',
    headers: {
      ...operatorCookie,
      'Content-Type': 'application/json',
      'x-csrf-token': operatorSession.csrfToken,
      'If-Match': `"r${estimate.run.revision}"`,
    },
    body: JSON.stringify(body),
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).created, false);
  assert.equal([...f.repository.runs.values()].length, 1);

  const viewerRead = await fetch(`${base}/api/workflow-runs/${estimate.run.id}`, { headers: viewerCookie });
  assert.equal(viewerRead.status, 200);
  assert.equal(viewerRead.headers.get('etag'), `"r${confirmedBody.run.revision}"`);

  // 页面刷新后按工作流实例恢复最近一次运行；只读角色可读，不能借此跨实例。
  const latest = await fetch(`${base}/api/workflow-runs?workflowInstanceId=${f.instanceId}`, {
    headers: viewerCookie,
  });
  assert.equal(latest.status, 200);
  const latestBody = await latest.json();
  assert.equal(latestBody.run.id, estimate.run.id);
  assert.equal(latestBody.run.nodes.length, confirmedBody.run.nodes.length);
  assert.equal(latest.headers.get('etag'), `"r${confirmedBody.run.revision}"`);
  const missingInstanceId = await fetch(`${base}/api/workflow-runs`, { headers: viewerCookie });
  assert.equal(missingInstanceId.status, 422);
  assert.equal((await missingInstanceId.json()).error.code, 'INVALID_FIELD');
  const anonymousLatest = await fetch(`${base}/api/workflow-runs?workflowInstanceId=${f.instanceId}`);
  assert.equal(anonymousLatest.status, 401);

  const viewerRetry = await fetch(`${base}/api/workflow-runs/${estimate.run.id}/retry`, {
    method: 'POST',
    headers: { ...viewerCookie, 'Content-Type': 'application/json', 'x-csrf-token': viewerSession.csrfToken },
    body: JSON.stringify({ nodeId: 'preview', idempotencyKey: 'viewer-retry', revision: confirmedBody.run.revision }),
  });
  assert.equal(viewerRetry.status, 403);

  const anonymous = await fetch(`${base}/api/workflow-runs/${estimate.run.id}`);
  assert.equal(anonymous.status, 401);
});

test('运行详情按工作空间隔离，猜到的编号不能跨空间读取', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const { confirmed } = await estimateAndConfirm(f);
  await assert.rejects(
    () => f.service.get(confirmed.run.id, { workspaceId: 'other-workspace' }),
    error => error.code === 'FORBIDDEN' && error.status === 403,
  );
});

// ---- 公共输出 ----

test('publicRun 不泄露内部账本任务与尝试历史', async () => {
  const f = fixture({
    branches: [{ id: 'preview', type: 'generate', modelId: 'test:image', output: true }],
    prices: basePrices(),
  });
  const { confirmed } = await estimateAndConfirm(f);
  const run = await f.repository.getRun(confirmed.run.id);
  const output = publicRun(run, await f.repository.listNodeRuns(run.id));
  const node = output.nodes.find(item => item.nodeId === 'preview');
  assert.equal(Object.hasOwn(node, 'billingTaskId'), false);
  assert.equal(Object.hasOwn(node, 'attemptHistory'), true);
  assert.equal(typeof output.revision, 'number');
  assert.equal(output.totals.reservedCents > 0, true);
});


test('工作流输出自动登记交付草稿；重复执行不重复导入', async () => {
  const f = fixture({ branches: [{ id: 'generate', type: 'generate', modelId: 'test:image' }], prices: basePrices() });
  const imports = [];
  f.service.deliverables = { async importVersion(deliverableId, body, context) {
    imports.push({ deliverableId, body, context });
    return { version: { id: 'draft-version' } };
  } };
  const { runId } = await estimateAndConfirm(f, { autoRun: true });
  const rows = await f.repository.listNodeRuns(runId);
  const ready = rows.find(row => row.nodeId === 'ready');
  assert.equal(ready.status, 'succeeded');
  assert.equal(ready.output.versionId, 'draft-version');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].body.projectId, f.projectId);
  assert.equal(imports[0].body.planVersion, 1);
  assert.equal(imports[0].context.workspaceId, 'local');
  assert.ok(rows.some(row => row.jobId === imports[0].body.jobId));
  const submitted = f.jobs.submissions.length;
  await f.service.executeRun(runId);
  assert.equal(imports.length, 1);
  assert.equal(f.jobs.submissions.length, submitted);
});

test('免费交付登记失败后只重试登记节点，不重新生图或扣费', async () => {
  const f = fixture({ branches: [{ id: 'generate', type: 'generate', modelId: 'test:image' }], prices: basePrices() });
  let attempts = 0;
  f.service.deliverables = { async importVersion() {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary store error');
    return { version: { id: 'recovered-draft' } };
  } };
  const { runId } = await estimateAndConfirm(f, { autoRun: true });
  let run = await f.repository.getRun(runId);
  assert.equal(run.status, 'partial_failed');
  const rows = await f.repository.listNodeRuns(runId);
  const ready = rows.find(row => row.nodeId === 'ready');
  assert.equal(ready.errorCode, 'DELIVERY_IMPORT_FAILED');
  assert.ok(rows.some(row => row.jobId && row.status === 'succeeded'));
  const submitted = f.jobs.submissions.length;
  const entries = f.billing.entries.length;
  await f.service.retry(runId, { nodeId: 'ready', revision: run.revision, idempotencyKey: 'retry-import-only' });
  await f.service.executeRun(runId);
  run = await f.repository.getRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(attempts, 2);
  assert.equal(f.jobs.submissions.length, submitted);
  assert.equal(f.billing.entries.length, entries);
});
