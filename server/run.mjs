import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { validateWorkflowGraph } from './workflow.mjs';

// 工作流运行器（Issue #14 / FLOW-17、ACC-20）。
//
// 生命周期：
//   estimate  -> 逐节点报价，写入/更新一份 awaiting_confirmation 运行草稿
//   confirm   -> 校验 If-Match、方案已确认、实例未变、DAG 无环，逐节点预占后
//                在一个事务内写 run + node_runs；同一幂等键返回原运行
//   execute   -> 按拓扑顺序执行；付费节点提交现有生成任务并等待终态
//   failed    -> 只把该分支下游标 blocked 并释放其预占，其他分支继续
//   unknown   -> 保留预占，下游保持 pending，等待人工查询原请求
//   retry     -> 仅失败节点可人工重试，必须新幂等键并重新报价/预占
//   reconfigure -> 开跑后修改未执行节点参数会释放预占并生成新的待确认运行
//
// 不自动重试、不自动换模型、不产生循环。执行使用确认时冻结的 graph 快照，
// 实例后续修改不会改变正在运行的批次。

export const RUN_STATUSES = Object.freeze([
  'draft', 'estimating', 'awaiting_confirmation', 'running',
  'partial_failed', 'succeeded', 'cancelled',
]);
export const NODE_RUN_STATUSES = Object.freeze([
  'pending', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'blocked', 'skipped',
]);
export const TERMINAL_NODE_STATUSES = Object.freeze([
  'succeeded', 'failed', 'unknown', 'blocked', 'skipped',
]);
export const PAID_NODE_TYPES = Object.freeze(['generate', 'edit']);
export const NODE_TYPES = Object.freeze(['input', 'prompt', 'generate', 'edit', 'composite', 'output']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ESTIMATE_FIELDS = ['workflowInstanceId', 'projectId', 'planVersion', 'deliverableId', 'reason'];
const CONFIRM_FIELDS = ['runId', 'idempotencyKey', 'revision', 'reason'];
const RETRY_FIELDS = ['nodeId', 'idempotencyKey', 'params', 'revision', 'reason'];
const CANCEL_FIELDS = ['revision', 'reason'];
const RECONCILE_FIELDS = ['nodeId', 'revision', 'reason'];
const RECONFIGURE_FIELDS = ['params', 'revision', 'reason'];

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label = '请求体') {
  if (!isObject(value)) fail('INVALID_BODY', `${label}必须是 JSON 对象。`);
}

function rejectUnknown(body, allowed, label = '请求') {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function uuidField(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_ID', `${label}不能为空。`);
    return null;
  }
  const id = String(value);
  if (!UUID.test(id)) fail('INVALID_ID', `${label}格式不正确。`);
  return id;
}

function textField(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (typeof value !== 'string') fail('INVALID_FIELD', `${label}必须是文本。`);
  const text = value.trim();
  if (required && !text) fail('INVALID_FIELD', `${label}不能为空。`);
  if (text.length > max) fail('INVALID_FIELD', `${label}不能超过 ${max} 个字符。`);
  return text || null;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value.trim())) {
    fail('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 需为 1–200 个字母、数字、点、下划线、冒号或连字符。');
  }
  return value.trim();
}

function parseRevisionValue(value) {
  const number = typeof value === 'string' && /^r?\d+$/i.test(value.trim())
    ? Number(value.trim().replace(/^r/i, '')) : value;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    fail('INVALID_REVISION', '运行修订号必须是正整数。');
  }
  return number;
}

function readExpectedRevision(body, ifMatch, { required = true } = {}) {
  let header;
  if (ifMatch !== undefined && ifMatch !== null && ifMatch !== '') {
    header = parseRevisionValue(String(ifMatch).trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1'));
  }
  let fromBody;
  if (body && Object.hasOwn(body, 'revision')) fromBody = parseRevisionValue(body.revision);
  if (header !== undefined && fromBody !== undefined && header !== fromBody) {
    fail('INVALID_REVISION', 'If-Match 与请求体 revision 不一致。');
  }
  const value = header ?? fromBody ?? null;
  if (value === null && required) {
    fail('REVISION_REQUIRED', '运行写操作需提供 If-Match 响应头或请求体中的 revision。', 428);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function capabilityFor(type) {
  return type === 'edit' ? 'image.edit' : 'image.generate';
}

function currencyQuote(overrides = {}) {
  return {
    priced: true,
    status: 'included',
    billingMode: 'none',
    capability: null,
    modelId: null,
    tier: null,
    quantity: 1,
    currency: 'CNY',
    amountCents: 0,
    unit: null,
    unitPrice: null,
    priceId: null,
    priceVersion: null,
    blocking: false,
    ...overrides,
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function edgeMap(edges) {
  const incoming = new Map();
  for (const edge of edges) {
    const list = incoming.get(edge.target) || [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  return incoming;
}

function topologicalOrder(nodes, edges) {
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (!indegree.has(edge.target) || !outgoing.has(edge.source)) continue;
    indegree.set(edge.target, indegree.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }
  const order = [];
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id)) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  // 图已在 validateWorkflowGraph 中验证无环；这里只为稳定顺序兜底。
  for (const node of nodes) if (!order.includes(node.id)) order.push(node.id);
  return order;
}

function descendantsOf(nodeId, edges) {
  const outgoing = new Map();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) || [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const result = new Set();
  const stack = [...(outgoing.get(nodeId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(outgoing.get(id) || []));
  }
  return result;
}

function ancestorsOf(nodeId, edges) {
  const incoming = new Map();
  for (const edge of edges) {
    const list = incoming.get(edge.target) || [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  const result = new Set();
  const stack = [...(incoming.get(nodeId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(incoming.get(id) || []));
  }
  return result;
}

function sumBy(list, selector) {
  return list.reduce((total, item) => total + (selector(item) || 0), 0);
}

export function publicNodeRun(row) {
  return {
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    type: row.nodeType,
    name: row.nodeName ?? null,
    status: row.status,
    dependsOn: clone(row.dependsOn || []),
    jobId: row.jobId ?? null,
    jobRequestId: row.jobRequestId ?? null,
    quote: clone(row.quote || {}),
    output: clone(row.output || {}),
    amountCents: row.amountCents ?? null,
    reservedCents: row.reservedCents ?? 0,
    actualCostCents: row.actualCostCents ?? null,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts ?? 0,
    attemptHistory: clone(row.attemptHistory || []),
    errorCode: row.errorCode ?? null,
    reused: Boolean(row.reused),
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function publicRun(run, nodeRuns = null) {
  const estimate = isObject(run.estimate) ? run.estimate : {};
  const nodes = nodeRuns ? nodeRuns.map(publicNodeRun) : clone(estimate.nodes || []);
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    planVersion: run.planVersion,
    deliverableId: run.deliverableId,
    workflowInstanceId: run.workflowInstanceId,
    instanceRevision: run.instanceRevision,
    status: run.status,
    estimate: {
      currency: 'CNY',
      totalCents: run.estimateTotalCents ?? 0,
      pendingPriceCount: run.estimatePendingCount ?? 0,
      blockingCount: estimate.blockingCount ?? 0,
      nodeCount: estimate.nodeCount ?? nodes.length,
      hasPendingPrice: (run.estimatePendingCount ?? 0) > 0,
      quotedAt: estimate.quotedAt ?? null,
      nodes: clone(estimate.nodes || []),
    },
    nodes,
    totals: {
      currency: 'CNY',
      estimatedCents: run.estimateTotalCents ?? null,
      reservedCents: run.reservedCents ?? 0,
      settledCents: run.settledCents ?? 0,
      releasedCents: run.releasedCents ?? 0,
    },
    idempotencyKey: run.idempotencyKey ?? null,
    supersedesRunId: run.supersedesRunId ?? null,
    cancelReason: run.cancelReason ?? null,
    confirmedAt: run.confirmedAt ?? null,
    confirmedBy: run.confirmedBy ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export class RunService {
  constructor(repository, {
    workflows = null,
    billing = null,
    jobs = null,
    deliverables = null,
    audit = null,
    now = () => new Date(),
    idFactory = randomUUID,
    jobTimeoutMs = 15 * 60_000,
    autoStart = true,
  } = {}) {
    if (!repository) throw new AppError('RUN_STORE_UNAVAILABLE', '工作流运行存储未配置。', 500);
    this.repository = repository;
    this.workflows = workflows;
    this.billing = billing;
    this.jobs = jobs;
    this.deliverables = deliverables;
    this.audit = audit;
    this.now = now;
    this.idFactory = idFactory;
    this.jobTimeoutMs = jobTimeoutMs;
    this.autoStart = autoStart;
    this.active = new Map();
    this.restart = new Set();
  }

  async #record(action, { targetType = 'workflow_run', targetId, result = 'success', detail = {}, context = {} }) {
    if (!this.audit) return null;
    const entry = {
      action,
      targetType,
      targetId,
      result,
      detail,
      actor: context.actor || null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
      createdAt: this.now(),
    };
    try {
      if (typeof this.audit === 'function') return await this.audit(entry);
      return await this.audit.record(entry);
    } catch {
      return null;
    }
  }

  #workspace(workspaceId, fallback = null) {
    return workspaceId || fallback || 'local';
  }

  async #resolveTarget(body, workspaceId) {
    if (!this.workflows) throw new AppError('WORKFLOW_UNAVAILABLE', '工作流服务未配置。', 503);
    if (body.workflowInstanceId !== undefined && body.workflowInstanceId !== null && body.workflowInstanceId !== '') {
      const instanceId = uuidField(body.workflowInstanceId, '工作流实例编号');
      const { instance } = await this.workflows.getInstance(instanceId, { workspaceId });
      const context = await this.workflows.getDeliverableInstance(
        instance.projectId, instance.planVersion, instance.deliverableId, { workspaceId },
      );
      return { instance, context };
    }
    const projectId = uuidField(body.projectId, '项目编号');
    const planVersion = Number(body.planVersion);
    if (!Number.isInteger(planVersion) || planVersion < 1) fail('INVALID_FIELD', '方案版本必须是正整数。');
    const deliverableId = uuidField(body.deliverableId, '交付项编号');
    const context = await this.workflows.getDeliverableInstance(
      projectId, planVersion, deliverableId, { workspaceId },
    );
    const { instance } = await this.workflows.getInstance(context.instance.id, { workspaceId });
    return { instance, context };
  }

  #graph(instance) {
    // 复用 #13 的图与端口校验：确认无环、无悬空边、必需输入连通，并规范化参数。
    const graph = validateWorkflowGraph(
      clone(instance.nodes || []), clone(instance.edges || []),
      { lockedNodes: clone(instance.lockedNodes || []) },
    );
    return { nodes: graph.nodes, edges: graph.edges, lockedNodes: graph.lockedNodes };
  }

  async #quoteNode(node) {
    const capability = capabilityFor(node.type);
    const modelId = node.params?.modelId || null;
    const tier = node.params?.tier || 'default';
    if (!modelId) {
      return {
        priced: false,
        status: 'no_model',
        billingMode: 'chargeable',
        capability,
        modelId: null,
        tier,
        quantity: 1,
        currency: 'CNY',
        amountCents: null,
        unit: null,
        unitPrice: null,
        priceId: null,
        priceVersion: null,
        blocking: true,
      };
    }
    if (!this.billing) throw new AppError('BILLING_UNAVAILABLE', '计费服务未配置，无法估价。', 503);
    const quote = await this.billing.quote({ capability, modelId, tier, quantity: 1 });
    return {
      priced: quote.priced === true,
      status: quote.status,
      billingMode: quote.billingMode,
      capability: quote.capability,
      modelId: quote.modelId,
      tier: quote.tier,
      quantity: quote.quantity,
      currency: quote.currency,
      // 未知价格保持 NULL，绝不当成 0。
      amountCents: quote.amountCents ?? null,
      unit: quote.unit ?? null,
      unitPrice: quote.unitPrice ?? null,
      priceId: quote.priceId ?? null,
      priceVersion: quote.priceVersion ?? null,
      blocking: false,
    };
  }

  async #quoteGraph(graph, existing = new Map()) {
    const incoming = edgeMap(graph.edges);
    const nodes = [];
    for (const node of graph.nodes) {
      const dependsOn = (incoming.get(node.id) || []).map(edge => edge.source);
      const current = existing.get(node.id);
      if (current?.reused && ['succeeded', 'skipped'].includes(current.status)) {
        nodes.push({
          nodeId: node.id,
          type: node.type,
          name: node.name,
          dependsOn,
          reused: true,
          status: 'reused',
          quote: clone(current.quote || {}),
          amountCents: 0,
          reservedCents: 0,
          actualCostCents: current.actualCostCents ?? null,
          blocking: false,
        });
        continue;
      }
      const quote = PAID_NODE_TYPES.includes(node.type)
        ? await this.#quoteNode(node)
        : currencyQuote({ capability: null });
      nodes.push({
        nodeId: node.id,
        type: node.type,
        name: node.name,
        dependsOn,
        reused: false,
        status: quote.blocking ? 'blocked' : quote.status,
        quote,
        amountCents: quote.amountCents,
        reservedCents: 0,
        actualCostCents: null,
        blocking: quote.blocking === true,
      });
    }
    const priced = nodes.filter(node => node.amountCents !== null && node.amountCents !== undefined);
    const pendingPriceCount = nodes.filter(node => !node.reused && node.amountCents === null
      && PAID_NODE_TYPES.includes(node.type) && !node.blocking).length;
    return {
      nodes,
      totalCents: sumBy(priced, node => node.amountCents),
      pendingPriceCount,
      blockingCount: nodes.filter(node => node.blocking).length,
      nodeCount: nodes.length,
      quotedAt: this.now().toISOString(),
    };
  }

  async #openRun(workspaceId, instanceId) {
    if (typeof this.repository.findOpenRun === 'function') {
      return this.repository.findOpenRun(workspaceId, instanceId);
    }
    return null;
  }

  // ---- 估价 ----

  async estimate(body = {}, { workspaceId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, ESTIMATE_FIELDS, '估价');
    const { instance, context: target } = await this.#resolveTarget(body, workspaceId);
    if (!target.runnable) {
      throw new AppError('PLAN_NOT_CONFIRMED', '确认方案后才能估价并开跑。', 409);
    }
    const graph = this.#graph(instance);
    const workspace = this.#workspace(workspaceId, instance.workspaceId);
    let run = await this.#openRun(workspace, instance.id);
    // 同一实例已有正在执行的批次时，禁止再估价并确认出第二份运行，
    // 否则已成功的付费节点会被重复计费。修改未执行节点请走 reconfigure。
    if (typeof this.repository.findLiveRun === 'function') {
      const live = await this.repository.findLiveRun(workspace, instance.id);
      if (live && live.id !== run?.id) {
        throw new AppError(
          'RUN_ALREADY_RUNNING',
          '该工作流已有执行中的批次；请重试失败节点、修改未执行节点或先取消当前批次。',
          409,
        );
      }
    }
    const existing = run ? await this.repository.listNodeRuns(run.id) : [];
    const byNode = new Map(existing.map(row => [row.nodeId, row]));
    const estimate = await this.#quoteGraph(graph, byNode);
    const now = this.now();

    if (run) {
      const result = await this.repository.updateRun(run.id, run.revision, {
        graph,
        instanceRevision: instance.revision,
        status: 'awaiting_confirmation',
        estimate,
        estimateTotalCents: estimate.totalCents,
        estimatePendingCount: estimate.pendingPriceCount,
        updatedAt: now,
      });
      if (result.status === 'conflict') {
        fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重新估价。', 409);
      }
      run = result.run;
    } else {
      run = await this.repository.insertRun({
        id: this.idFactory(),
        workspaceId: workspace,
        projectId: instance.projectId,
        planVersion: instance.planVersion,
        deliverableId: instance.deliverableId,
        workflowInstanceId: instance.id,
        instanceRevision: instance.revision,
        status: 'awaiting_confirmation',
        graph,
        estimate,
        estimateTotalCents: estimate.totalCents,
        estimatePendingCount: estimate.pendingPriceCount,
        reservedCents: 0,
        settledCents: 0,
        releasedCents: 0,
        idempotencyKey: null,
        requestHash: null,
        supersedesRunId: null,
        cancelReason: null,
        confirmedAt: null,
        confirmedBy: null,
        startedAt: null,
        finishedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }, []);
    }
    await this.#record('workflow.run.estimated', {
      targetId: run.id,
      detail: {
        workflowInstanceId: instance.id,
        projectId: instance.projectId,
        deliverableId: instance.deliverableId,
        nodeCount: estimate.nodeCount,
        totalCents: estimate.totalCents,
        pendingPriceCount: estimate.pendingPriceCount,
        blockingCount: estimate.blockingCount,
      },
      context,
    });
    return { run: publicRun(run), estimate, nodes: estimate.nodes };
  }

  async #releaseUnusedConfirmationReservations(runId, reserved, actorId, reason) {
    const committedRun = await this.repository.getRun(runId);
    const committedNodes = committedRun?.idempotencyKey ? await this.repository.listNodeRuns(runId) : [];
    const usedTasks = new Set(committedNodes.map(row => row.billingTaskId));
    for (const row of reserved.slice().reverse()) {
      if (usedTasks.has(row.billingTaskId)) continue;
      await this.billing.release(row.billingTaskId, {
        idempotencyKey: `release:${row.billingTaskId}`, reason,
      }, { actorId: actorId || 'local' }).catch(() => {});
    }
  }

  // ---- 确认开跑 ----

  async #runForConfirm(body, workspaceId) {
    if (!body.runId) fail('INVALID_FIELD', '请先调用估价接口并传入 runId。');
    const run = await this.repository.getRun(uuidField(body.runId, '运行编号'));
    if (!run) throw new AppError('RUN_NOT_FOUND', '工作流运行不存在。', 404);
    if (workspaceId && run.workspaceId !== workspaceId) {
      throw new AppError('FORBIDDEN', '无权操作该工作流运行。', 403);
    }
    return run;
  }

  async confirm(body = {}, { workspaceId = null, ifMatch = undefined, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, CONFIRM_FIELDS, '确认开跑');
    const key = normalizeIdempotencyKey(body.idempotencyKey);
    const expected = readExpectedRevision(body, ifMatch);

    const existing = await this.repository.getRunByIdempotencyKey(workspaceId || 'local', key);
    if (existing) {
      if (body.runId && existing.id !== String(body.runId)) {
        fail('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同的工作流运行。', 409);
      }
      return { run: publicRun(existing, await this.repository.listNodeRuns(existing.id)), created: false };
    }

    let run = await this.#runForConfirm(body, workspaceId);
    if (run.revision !== expected) {
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    if (run.status !== 'awaiting_confirmation' || run.idempotencyKey) {
      fail('RUN_ALREADY_STARTED', '该运行已确认或已结束，请重新估价。', 409);
    }

    const { instance, context: target } = await this.#resolveTarget({
      projectId: run.projectId, planVersion: run.planVersion, deliverableId: run.deliverableId,
    }, workspaceId);
    if (!target.runnable) throw new AppError('PLAN_NOT_CONFIRMED', '方案尚未确认，不能开跑。', 409);
    if (instance.id !== run.workflowInstanceId) {
      fail('INSTANCE_CHANGED', '交付项的工作流实例已变更，请重新估价。', 409);
    }
    if (instance.revision !== run.instanceRevision) {
      fail('INSTANCE_CHANGED', '工作流在估价后被修改，请重新估价并确认。', 409);
    }
    const graph = this.#graph(instance);
    const estimate = await this.#quoteGraph(graph);
    if (estimate.blockingCount > 0) {
      fail('NODE_MODEL_MISSING', '存在未选择模型的可执行节点，不能开跑；请先为节点选择模型。', 422);
    }

    const now = this.now();
    const existingRows = await this.repository.listNodeRuns(run.id);
    const rowByNode = new Map(existingRows.map(row => [row.nodeId, row]));
    const incoming = edgeMap(graph.edges);
    const reserved = [];
    const nodeRows = [];
    try {
      for (const node of graph.nodes) {
        const quoted = estimate.nodes.find(item => item.nodeId === node.id);
        const current = rowByNode.get(node.id);
        const reused = Boolean(current?.reused && ['succeeded', 'skipped'].includes(current.status));
        const dependsOn = (incoming.get(node.id) || []).map(edge => edge.source);
        if (reused) {
          nodeRows.push({ ...current, dependsOn });
          continue;
        }
        const id = current?.id || this.idFactory();
        const row = {
          id,
          runId: run.id,
          workspaceId: run.workspaceId,
          nodeId: node.id,
          nodeType: node.type,
          nodeName: node.name,
          status: 'pending',
          dependsOn,
          jobId: current?.jobId ?? null,
          jobRequestId: current?.jobRequestId ?? null,
          quote: quoted.quote,
          amountCents: quoted.amountCents,
          reservedCents: 0,
          actualCostCents: null,
          billingTaskId: current?.billingTaskId ?? id,
          idempotencyKey: current?.idempotencyKey || `run:${run.id}:${node.id}:a1`,
          attempts: current?.attempts ?? 0,
          attemptHistory: current?.attemptHistory || [],
          errorCode: null,
          reused: false,
          startedAt: null,
          finishedAt: null,
          createdAt: current?.createdAt || now,
          updatedAt: now,
        };
        if (PAID_NODE_TYPES.includes(node.type) && row.amountCents !== null) {
          const reservation = await this.billing.reserve({
            capability: capabilityFor(node.type),
            modelId: quoted.quote.modelId,
            tier: quoted.quote.tier || 'default',
            quantity: 1,
            taskId: row.billingTaskId,
            projectId: run.projectId,
            idempotencyKey: `reserve:${row.billingTaskId}`,
            reason: `工作流节点 ${node.id} 开跑预占`,
          }, { actorId: actorId || 'local' });
          row.reservedCents = reservation.entry?.amountCents ?? 0;
          if (reservation.created !== false) reserved.push(row);
        } else if (PAID_NODE_TYPES.includes(node.type)) {
          // 待核价：不扣额度，但账本留下 pending_price 记录，成功后可人工补价。
          const reservation = await this.billing.reserve({
            capability: capabilityFor(node.type),
            modelId: quoted.quote.modelId,
            tier: quoted.quote.tier || 'default',
            quantity: 1,
            taskId: row.billingTaskId,
            projectId: run.projectId,
            idempotencyKey: `reserve:${row.billingTaskId}`,
            reason: `工作流节点 ${node.id} 开跑待核价`,
          }, { actorId: actorId || 'local' });
          row.reservedCents = reservation.entry?.amountCents ?? 0;
          if (reservation.created !== false) reserved.push(row);
        }
        nodeRows.push(row);
      }
    } catch (error) {
      await this.#releaseUnusedConfirmationReservations(run.id, reserved, actorId, '预占失败，释放未使用预占');
      throw error;
    }

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ runId: run.id, workflowInstanceId: run.workflowInstanceId }))
      .digest('hex');
    const result = await this.repository.confirmRun({
      runId: run.id,
      workflowInstanceId: run.workflowInstanceId,
      expectedRevision: expected,
      expectedInstanceRevision: run.instanceRevision,
      runPatch: {
        status: 'running',
        idempotencyKey: key,
        requestHash,
        graph,
        estimate,
        estimateTotalCents: estimate.totalCents,
        estimatePendingCount: estimate.pendingPriceCount,
        reservedCents: sumBy(nodeRows, row => row.reservedCents),
        settledCents: 0,
        releasedCents: 0,
        confirmedAt: now,
        confirmedBy: actorId || 'local',
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      },
      nodeRuns: nodeRows,
    });
    if (['conflict', 'instance_conflict', 'key_conflict'].includes(result.status)) {
      await this.#releaseUnusedConfirmationReservations(run.id, reserved, actorId, '确认冲突，释放未使用预占');
      if (result.status === 'key_conflict') {
        fail('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同的工作流运行。', 409);
      }
      if (result.status === 'instance_conflict') {
        fail('INSTANCE_CHANGED', '工作流在确认期间被修改，请重新估价并确认。', 409);
      }
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    if (result.status === 'started') {
      const committedNodes = await this.repository.listNodeRuns(result.run.id);
      await this.#releaseUnusedConfirmationReservations(run.id, reserved, actorId, '重复确认，释放未使用预占');
      return { run: publicRun(result.run, committedNodes), created: false };
    }
    if (result.status === 'missing') throw new AppError('RUN_NOT_FOUND', '工作流运行不存在。', 404);

    await this.#record('workflow.run.confirmed', {
      targetId: run.id,
      detail: {
        workflowInstanceId: run.workflowInstanceId,
        nodeCount: nodeRows.length,
        reservedCents: sumBy(nodeRows, row => row.reservedCents),
        estimateTotalCents: estimate.totalCents,
        pendingPriceCount: estimate.pendingPriceCount,
      },
      context,
    });
    const confirmedRun = result.run;
    if (this.autoStart) this.startRun(confirmedRun.id);
    return { run: publicRun(confirmedRun, nodeRows), created: true };
  }

  // ---- 执行 ----

  startRun(runId) {
    if (this.active.has(runId)) {
      // 执行循环仍在运行：标记重跑，循环结束后再按最新节点状态继续。
      this.restart.add(runId);
      return;
    }
    this.executeRun(runId).catch(() => {});
  }

  async executeRun(runId) {
    if (this.active.has(runId)) return this.active.get(runId);
    const promise = this.#execute(runId).finally(() => {
      this.active.delete(runId);
      if (this.restart.delete(runId)) this.startRun(runId);
    });
    this.active.set(runId, promise);
    return promise;
  }

  async #execute(runId) {
    let run = await this.repository.getRun(runId);
    if (!run || !['running', 'partial_failed'].includes(run.status)) return run;
    await this.#record('workflow.run.started', {
      targetId: run.id,
      detail: { workflowInstanceId: run.workflowInstanceId, nodeCount: (run.graph?.nodes || []).length },
    });
    await this.#executeLoop(run);
    run = await this.repository.getRun(run.id);
    return run;
  }

  async #executeLoop(run) {
    const graph = isObject(run.graph) ? run.graph : { nodes: [], edges: [] };
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const graphNodes = new Map(nodes.map(node => [node.id, node]));
    const order = topologicalOrder(nodes, edges);
    const incoming = edgeMap(edges);
    let guard = 0;
    while (guard <= nodes.length * 3 + 5) {
      guard += 1;
      let rows = await this.repository.listNodeRuns(run.id);
      const map = new Map(rows.map(row => [row.nodeId, row]));
      let changed = false;
      for (const nodeId of order) {
        const node = nodes.find(item => item.id === nodeId);
        const row = map.get(nodeId);
        if (!node || !row || row.status !== 'pending') continue;
        const sources = (incoming.get(nodeId) || [])
          .map(edge => map.get(edge.source))
          .filter(Boolean);
        if (sources.some(source => source.status === 'unknown')) continue;
        if (sources.some(source => ['failed', 'blocked'].includes(source.status))) {
          await this.#blockNode(run, row, 'UPSTREAM_BLOCKED');
          changed = true;
        } else if (sources.every(source => ['succeeded', 'skipped'].includes(source.status))) {
          await this.#executeNode(run, node, row, incoming, map, graphNodes);
          changed = true;
        } else {
          continue;
        }
        rows = await this.repository.listNodeRuns(run.id);
        map.clear();
        for (const item of rows) map.set(item.nodeId, item);
      }
      if (!changed) break;
      rows = await this.repository.listNodeRuns(run.id);
      if (!rows.some(row => row.status === 'pending')) break;
    }
    await this.#finalize(run);
  }

  async #executeNode(run, node, row, incoming, map, graphNodes) {
    const now = this.now();
    if (node.type === 'input') {
      await this.repository.updateNodeRun(row.id, {
        status: 'succeeded', actualCostCents: 0, finishedAt: now, updatedAt: now,
      });
      return;
    }
    if (node.type === 'prompt') {
      await this.repository.updateNodeRun(row.id, {
        status: 'succeeded', actualCostCents: 0, finishedAt: now, updatedAt: now,
      });
      return;
    }
    if (node.type === 'composite') {
      // 确定性排版尚未接入执行器：保留底图并跳过该节点，不收费。
      await this.repository.updateNodeRun(row.id, {
        status: 'skipped', errorCode: 'COMPOSITE_NOT_IMPLEMENTED', actualCostCents: 0,
        finishedAt: now, updatedAt: now,
      });
      return;
    }
    if (node.type === 'output') {
      let output = {};
      if (this.deliverables) {
        // 沿冻结图向上游找最近成功图片。未实现的免费合成节点保留底图，
        // 这里只导入已有任务，绝不提交模型或自动选为候选。
        const queue = (incoming.get(node.id) || []).map(edge => edge.source);
        const visited = new Set();
        let source = null;
        while (queue.length) {
          const id = queue.shift();
          if (visited.has(id)) continue;
          visited.add(id);
          const candidate = map.get(id);
          if (candidate?.status === 'succeeded' && candidate.jobId) { source = candidate; break; }
          queue.push(...(incoming.get(id) || []).map(edge => edge.source));
        }
        if (!source) { await this.#failNode(run, row, 'DELIVERY_SOURCE_REQUIRED'); return; }
        try {
          const imported = await this.deliverables.importVersion(run.deliverableId, {
            projectId: run.projectId, planVersion: run.planVersion, jobId: source.jobId,
          }, { workspaceId: run.workspaceId, actorId: run.confirmedBy || 'local' });
          output = { jobId: source.jobId, versionId: imported.version.id };
        } catch {
          // 付费节点仍保持成功；只失败这个免费登记节点，可人工重试而不重新生图。
          await this.#failNode(run, row, 'DELIVERY_IMPORT_FAILED');
          return;
        }
      }
      await this.repository.updateNodeRun(row.id, {
        output,
        status: 'succeeded', actualCostCents: 0, finishedAt: now, updatedAt: now,
      });
      return;
    }
    await this.#executePaidNode(run, node, row, incoming, map, graphNodes);
  }

  #upstreamEdge(nodeId, port, incoming) {
    return (incoming.get(nodeId) || []).find(edge => edge.targetPort === port) || null;
  }

  async #executePaidNode(run, node, row, incoming, map, graphNodes) {
    const now = this.now();
    const attempt = (row.attempts || 0) + 1;
    const jobRequestId = row.jobRequestId || this.idFactory();
    // 提示词来自上游 prompt 节点冻结的参数；改图优先使用 instruction 输入。
    const promptEdge = node.type === 'edit'
      ? (this.#upstreamEdge(node.id, 'instruction', incoming)
        || this.#upstreamEdge(node.id, 'prompt', incoming))
      : this.#upstreamEdge(node.id, 'prompt', incoming);
    const sourcePrompt = promptEdge ? graphNodes.get(promptEdge.source)?.params?.prompt : null;
    const prompt = String(
      sourcePrompt || node.params?.prompt || node.params?.instruction || '',
    ).trim();
    if (!prompt) {
      await this.#failNode(run, row, 'PROMPT_REQUIRED');
      return;
    }
    let sourceJobId = null;
    if (node.type === 'edit') {
      const edge = this.#upstreamEdge(node.id, 'source', incoming);
      const source = edge ? map.get(edge.source) : null;
      if (!source?.jobId) {
        await this.#failNode(run, row, 'SOURCE_REQUIRED');
        return;
      }
      sourceJobId = source.jobId;
    }
    const history = Array.isArray(row.attemptHistory) ? clone(row.attemptHistory) : [];
    history.push({ attempt, key: row.idempotencyKey, requestId: jobRequestId, at: now.toISOString() });
    await this.repository.updateNodeRun(row.id, {
      status: 'queued',
      jobRequestId,
      attempts: attempt,
      attemptHistory: history,
      startedAt: now,
      updatedAt: now,
    });
    let job;
    try {
      if (!this.jobs) throw new AppError('JOB_EXECUTOR_UNAVAILABLE', '生成任务执行器未配置。', 503);
      job = await this.jobs.submit({
        requestId: jobRequestId,
        operation: node.type === 'edit' ? 'edit' : 'generate',
        modelId: node.params.modelId,
        prompt,
        size: node.params.size || null,
        quality: node.params.quality || null,
        sourceJobId,
        workspaceId: run.workspaceId,
      });
    } catch (error) {
      const code = error?.code || 'SUBMIT_FAILED';
      if (this.#isUncertain(error)) {
        await this.repository.updateNodeRun(row.id, {
          status: 'unknown', errorCode: code, updatedAt: this.now(),
        });
        await this.#record('workflow.run.node_unknown', {
          targetId: run.id,
          detail: { nodeId: node.id, errorCode: code },
        });
        return;
      }
      await this.#failNode(run, row, code);
      return;
    }
    await this.repository.updateNodeRun(row.id, {
      jobId: job.id, status: 'running', updatedAt: this.now(),
    });
    let result;
    try {
      result = await this.jobs.wait(job.id, { timeoutMs: this.jobTimeoutMs });
    } catch (error) {
      await this.repository.updateNodeRun(row.id, {
        status: 'unknown', errorCode: error?.code || 'UPSTREAM_UNKNOWN', updatedAt: this.now(),
      });
      await this.#record('workflow.run.node_unknown', {
        targetId: run.id,
        detail: { nodeId: node.id, errorCode: error?.code || 'UPSTREAM_UNKNOWN' },
      });
      return;
    }
    await this.#applyJobResult(run, node, row, result || { id: job.id, status: 'unknown' });
  }

  #isUncertain(error) {
    if (!(error instanceof AppError)) return true;
    return ['UPSTREAM_UNCERTAIN', 'UPSTREAM_UNKNOWN', 'UPSTREAM_FORMAT', 'POLL_TIMEOUT'].includes(error.code);
  }

  async #applyJobResult(run, node, row, job) {
    const now = this.now();
    if (['succeeded', 'completed', 'success'].includes(job.status)) {
      let settledCents = 0;
      const reserved = row.reservedCents || 0;
      if (reserved > 0 && row.billingTaskId) {
        await this.billing.settle(row.billingTaskId, {
          idempotencyKey: `settle:${row.billingTaskId}`,
          reason: `工作流节点 ${node.id} 成功结算`,
        }).catch(() => {});
        settledCents = reserved;
      }
      await this.repository.updateNodeRun(row.id, {
        status: 'succeeded',
        jobId: job.id || row.jobId,
        reservedCents: 0,
        actualCostCents: reserved > 0 ? settledCents : (row.amountCents === null ? null : 0),
        // 产物只保留任务引用摘要，不复制上游完整响应。
        output: {
          jobId: job.id || row.jobId,
          imageUrl: job.output ? `/api/jobs/${job.id || row.jobId}/image` : null,
          bytes: job.output?.bytes ?? null,
        },
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      });
      return;
    }
    if (['failed', 'cancelled', 'canceled', 'expired'].includes(job.status)) {
      await this.#failNode(run, row, job.error?.code || 'UPSTREAM_FAILED');
      return;
    }
    // unknown（含超时与等待中的未知）：保留预占，下游保持 pending，不自动重生。
    await this.repository.updateNodeRun(row.id, {
      status: job.status === 'unknown' ? 'unknown' : 'running',
      errorCode: job.status === 'unknown' ? (job.error?.code || 'UPSTREAM_UNKNOWN') : null,
      updatedAt: now,
    });
    if (job.status === 'unknown') {
      await this.#record('workflow.run.node_unknown', {
        targetId: run.id,
        detail: { nodeId: node.id, errorCode: job.error?.code || 'UPSTREAM_UNKNOWN' },
      });
    }
  }

  async #failNode(run, row, code) {
    const now = this.now();
    if (row.reservedCents > 0 || row.quote?.status === 'pending_price') {
      if (row.billingTaskId) {
        await this.billing.release(row.billingTaskId, {
          idempotencyKey: `release:${row.billingTaskId}`,
          reason: `工作流节点 ${row.nodeId} 失败释放预占`,
        }).catch(() => {});
      }
    }
    await this.repository.updateNodeRun(row.id, {
      status: 'failed',
      reservedCents: 0,
      actualCostCents: null,
      errorCode: code,
      finishedAt: now,
      updatedAt: now,
    });
    const blocked = await this.#blockDescendants(run, row.nodeId, 'UPSTREAM_BLOCKED');
    await this.#record('workflow.run.branch_failed', {
      targetId: run.id,
      detail: {
        nodeId: row.nodeId,
        errorCode: code,
        blockedNodeIds: blocked.ids,
        releasedCents: blocked.releasedCents,
        reservedBefore: row.reservedCents || 0,
      },
    });
  }

  async #blockNode(run, row, code) {
    const now = this.now();
    let releasedCents = 0;
    const pendingPrice = row.quote?.status === 'pending_price';
    if (row.billingTaskId && (row.reservedCents > 0 || pendingPrice)) {
      await this.billing.release(row.billingTaskId, {
        idempotencyKey: `release:${row.billingTaskId}`,
        reason: '上游失败，释放下游预占',
      }).catch(() => {});
      releasedCents = row.reservedCents;
    }
    await this.repository.updateNodeRun(row.id, {
      status: 'blocked',
      reservedCents: 0,
      errorCode: code,
      finishedAt: now,
      updatedAt: now,
    });
    return releasedCents;
  }

  async #blockDescendants(run, nodeId, code) {
    const graph = isObject(run.graph) ? run.graph : { nodes: [], edges: [] };
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const ids = [...descendantsOf(nodeId, edges)];
    const rows = await this.repository.listNodeRuns(run.id);
    const map = new Map(rows.map(row => [row.nodeId, row]));
    const blocked = [];
    let releasedCents = 0;
    for (const id of ids) {
      const row = map.get(id);
      if (!row || ['succeeded', 'skipped', 'unknown'].includes(row.status)) continue;
      releasedCents += await this.#blockNode(run, row, code);
      blocked.push(id);
    }
    return { ids: blocked, releasedCents };
  }

  async #finalize(run) {
    const fresh = await this.repository.getRun(run.id);
    if (!fresh || fresh.status === 'cancelled') return;
    const rows = await this.repository.listNodeRuns(run.id);
    const hasUnknown = rows.some(row => row.status === 'unknown');
    const active = rows.some(row => ['pending', 'queued', 'running'].includes(row.status));
    const failed = rows.some(row => ['failed', 'blocked'].includes(row.status));
    let status = 'running';
    if (hasUnknown || active) status = 'running';
    else if (failed) status = 'partial_failed';
    else status = 'succeeded';
    const now = this.now();
    await this.repository.updateRun(run.id, null, {
      status,
      reservedCents: sumBy(rows, row => row.reservedCents),
      settledCents: sumBy(rows, row => row.actualCostCents),
      finishedAt: ['partial_failed', 'succeeded'].includes(status) ? now : null,
      updatedAt: now,
    });
  }

  // ---- 人工重试 ----

  async retry(runId, body = {}, { workspaceId = null, ifMatch = undefined, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, RETRY_FIELDS, '重试');
    const run = await this.#loadForWrite(runId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    if (run.revision !== expected) {
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    if (!['running', 'partial_failed'].includes(run.status)) {
      fail('RUN_NOT_RETRYABLE', '只有执行中或部分失败的运行可以重试节点。', 409);
    }
    const nodeId = String(body.nodeId || '').trim();
    if (!nodeId) fail('INVALID_FIELD', '请提供要重试的节点。');
    const rows = await this.repository.listNodeRuns(run.id);
    const row = rows.find(item => item.nodeId === nodeId);
    if (!row) throw new AppError('NODE_RUN_NOT_FOUND', '节点运行不存在。', 404);
    if (row.status === 'unknown') {
      fail('NODE_UNKNOWN', '未知状态必须先查询原任务，不能重新生成或换模型。', 409);
    }
    if (row.status !== 'failed') {
      fail('NODE_NOT_FAILED', '只有明确失败的节点可以人工重试。', 409);
    }
    const key = normalizeIdempotencyKey(body.idempotencyKey);
    const historyKeys = new Set([row.idempotencyKey, ...(row.attemptHistory || []).map(item => item.key)]);
    if (historyKeys.has(key)) {
      fail('IDEMPOTENCY_REUSED', '重试必须使用新的幂等键，不能复用之前的尝试。', 409);
    }
    const attempt = (row.attempts || 0) + 1;
    const graph = isObject(run.graph) ? clone(run.graph) : { nodes: [], edges: [] };
    if (body.params !== undefined) {
      const nodes = (graph.nodes || []).map(node => (node.id === nodeId
        ? { ...node, params: body.params } : node));
      const validated = validateWorkflowGraph(nodes, graph.edges || [], {
        lockedNodes: graph.lockedNodes || [],
      });
      graph.nodes = validated.nodes;
      const next = validated.nodes.find(node => node.id === nodeId);
      if (next) next.params = validated.nodes.find(node => node.id === nodeId).params;
    }
    const node = (graph.nodes || []).find(item => item.id === nodeId);
    if (!node) throw new AppError('NODE_NOT_FOUND', '节点不在本次运行的图快照中。', 404);
    const quote = PAID_NODE_TYPES.includes(node.type)
      ? await this.#quoteNode(node)
      : currencyQuote({ capability: null });
    if (quote.blocking) fail('NODE_MODEL_MISSING', '重试前请先为节点选择模型。', 422);

    const billingTaskId = `${row.id}:a${attempt}`;
    let reservedCents = 0;
    if (PAID_NODE_TYPES.includes(node.type)) {
      const reservation = await this.billing.reserve({
        capability: capabilityFor(node.type),
        modelId: quote.modelId,
        tier: quote.tier || 'default',
        quantity: 1,
        taskId: billingTaskId,
        projectId: run.projectId,
        idempotencyKey: `reserve:${billingTaskId}`,
        reason: `工作流节点 ${nodeId} 人工重试预占`,
      }, { actorId: actorId || 'local' });
      reservedCents = reservation.entry?.amountCents ?? 0;
    }
    const now = this.now();
    const nextHistory = [...(row.attemptHistory || []), {
      attempt: row.attempts || 0, key: row.idempotencyKey, jobId: row.jobId ?? null,
      errorCode: row.errorCode ?? null, at: now.toISOString(),
    }];
    const unblocked = await this.#unblockDescendants(run, nodeId, rows, actorId || 'local');
    const result = await this.repository.applyRetry({
      runId: run.id,
      expectedRevision: expected,
      runPatch: {
        status: 'running',
        graph,
        finishedAt: null,
        updatedAt: now,
      },
      node: {
        id: row.id,
        status: 'pending',
        idempotencyKey: key,
        attempts: row.attempts || 0,
        attemptHistory: nextHistory,
        jobId: null,
        jobRequestId: null,
        quote,
        amountCents: quote.amountCents,
        reservedCents,
        actualCostCents: null,
        billingTaskId,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      },
      descendants: unblocked,
    });
    if (result.status === 'conflict') {
      await this.billing.release(billingTaskId, {
        idempotencyKey: `release:${billingTaskId}`, reason: '重试冲突释放预占',
      }).catch(() => {});
      for (const item of unblocked) {
        if (!item.billingTaskId) continue;
        await this.billing.release(item.billingTaskId, {
          idempotencyKey: `release:${item.billingTaskId}`, reason: '重试冲突释放解锁预占',
        }).catch(() => {});
      }
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    await this.#record('workflow.run.retried', {
      targetId: run.id,
      detail: {
        nodeId,
        attempt,
        idempotencyKey: key,
        reservedCents,
        unblockedNodeIds: unblocked.map(item => item.nodeId),
        errorCode: row.errorCode,
      },
      context,
    });
    if (this.autoStart) this.startRun(run.id);
    return {
      run: publicRun(result.run, await this.repository.listNodeRuns(run.id)),
      node: publicNodeRun((await this.repository.listNodeRuns(run.id)).find(item => item.id === row.id)),
      created: true,
    };
  }

  async #unblockDescendants(run, nodeId, rows, actorId = 'local') {
    const graph = isObject(run.graph) ? run.graph : { nodes: [], edges: [] };
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const map = new Map(rows.map(row => [row.nodeId, row]));
    const targets = descendantsOf(nodeId, edges);
    const updates = [];
    // 按拓扑顺序解锁，保证深层节点只有在全部上游恢复后才重新预占。
    for (const id of topologicalOrder(nodes, edges)) {
      if (!targets.has(id)) continue;
      const row = map.get(id);
      if (!row || row.status !== 'blocked') continue;
      const blockers = [...ancestorsOf(id, edges)]
        .filter(ancestor => ancestor !== nodeId)
        .map(ancestor => map.get(ancestor))
        .filter(ancestor => ancestor && ['failed', 'unknown', 'blocked'].includes(ancestor.status));
      if (blockers.length) continue;
      const node = nodeById.get(id);
      const now = this.now();
      const patch = {
        id: row.id,
        nodeId: id,
        status: 'pending',
        reservedCents: 0,
        errorCode: null,
        updatedAt: now,
      };
      if (PAID_NODE_TYPES.includes(node?.type)) {
        const billingTaskId = `${row.id}:u${this.idFactory()}`;
        try {
          const reservation = await this.billing.reserve({
            capability: capabilityFor(node.type),
            modelId: row.quote?.modelId || node.params?.modelId,
            tier: row.quote?.tier || node.params?.tier || 'default',
            quantity: 1,
            taskId: billingTaskId,
            projectId: run.projectId,
            idempotencyKey: `reserve:${billingTaskId}`,
            reason: `工作流节点 ${id} 重试解锁重新预占`,
          }, { actorId });
          patch.billingTaskId = billingTaskId;
          patch.reservedCents = reservation.entry?.amountCents ?? 0;
          patch.quote = { ...(row.quote || {}), status: reservation.quote?.status ?? row.quote?.status };
        } catch {
          // 预占失败（如额度不足）时保持阻塞，避免无预占提交付费任务。
          continue;
        }
      }
      updates.push(patch);
      map.set(id, { ...row, status: 'pending', ...patch });
    }
    return updates;
  }

  // ---- 未知状态：只查询原任务 ----

  async reconcile(runId, body = {}, { workspaceId = null, ifMatch = undefined, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, RECONCILE_FIELDS, '恢复查询');
    const run = await this.#loadForWrite(runId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    if (run.revision !== expected) {
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    const nodeId = String(body.nodeId || '').trim();
    const rows = await this.repository.listNodeRuns(run.id);
    const row = rows.find(item => item.nodeId === nodeId);
    if (!row) throw new AppError('NODE_RUN_NOT_FOUND', '节点运行不存在。', 404);
    if (row.status !== 'unknown') fail('NODE_NOT_UNKNOWN', '只有未知状态需要查询原任务。', 409);
    if (!row.jobId) fail('JOB_NOT_FOUND', '该节点没有可恢复的原任务。', 409);
    if (!this.jobs) throw new AppError('JOB_EXECUTOR_UNAVAILABLE', '生成任务执行器未配置。', 503);
    let job = await this.jobs.reconcile(row.jobId);
    if (job && !['succeeded', 'completed', 'success', 'failed', 'cancelled', 'canceled', 'expired', 'unknown'].includes(job.status)) {
      // 恢复接口只是重新接管原任务；这里继续等待同一任务到终态，不提交新请求。
      job = await this.jobs.wait(row.jobId, { timeoutMs: this.jobTimeoutMs });
    }
    const graph = isObject(run.graph) ? run.graph : { nodes: [], edges: [] };
    const node = (graph.nodes || []).find(item => item.id === nodeId);
    if (['succeeded', 'completed', 'success', 'failed', 'cancelled', 'canceled', 'expired'].includes(job.status)) {
      await this.#applyJobResult(run, node, row, job);
      if (this.autoStart) this.startRun(run.id);
    } else if (job.status === 'unknown') {
      await this.repository.updateNodeRun(row.id, {
        status: 'unknown', errorCode: job.error?.code || 'UPSTREAM_UNKNOWN', updatedAt: this.now(),
      });
    } else {
      await this.repository.updateNodeRun(row.id, { status: 'running', updatedAt: this.now() });
      if (this.autoStart) this.startRun(run.id);
    }
    await this.#record('workflow.run.reconciled', {
      targetId: run.id,
      detail: { nodeId, jobId: row.jobId, jobStatus: job.status },
      context,
    });
    return { run: publicRun(await this.repository.getRun(run.id), await this.repository.listNodeRuns(run.id)) };
  }

  // ---- 取消 ----

  async cancel(runId, body = {}, { workspaceId = null, ifMatch = undefined, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, CANCEL_FIELDS, '取消运行');
    const run = await this.#loadForWrite(runId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    if (run.revision !== expected) {
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    if (['cancelled', 'succeeded'].includes(run.status)) {
      fail('RUN_NOT_CANCELLABLE', '该运行已结束。', 409);
    }
    const rows = await this.repository.listNodeRuns(run.id);
    if (rows.some(row => ['queued', 'running'].includes(row.status))) {
      fail('RUN_IN_PROGRESS', '有节点正在执行，暂不能取消；请等待任务结束或查询原任务。', 409);
    }
    if (rows.some(row => row.status === 'unknown')) {
      fail('RUN_HAS_UNKNOWN', '存在未知任务，必须先查询原任务，不能直接取消。', 409);
    }
    let releasedCents = 0;
    const patches = [];
    const now = this.now();
    for (const row of rows) {
      if (!['pending', 'blocked'].includes(row.status)) continue;
      if (row.billingTaskId && (row.reservedCents > 0 || row.quote?.status === 'pending_price')) {
        await this.billing.release(row.billingTaskId, {
          idempotencyKey: `release:${row.billingTaskId}`, reason: '取消运行释放预占',
        }).catch(() => {});
        releasedCents += row.reservedCents;
      }
      patches.push({
        id: row.id,
        patch: {
          status: 'skipped', reservedCents: 0, errorCode: 'RUN_CANCELLED',
          finishedAt: now, updatedAt: now,
        },
      });
    }
    const reason = textField(body.reason, '取消原因', 500) || '人工取消运行';
    const result = await this.repository.mutateRun({
      runId: run.id,
      expectedRevision: expected,
      runPatch: {
        status: 'cancelled',
        cancelReason: reason,
        reservedCents: 0,
        releasedCents: (run.releasedCents || 0) + releasedCents,
        finishedAt: now,
        updatedAt: now,
      },
      nodePatches: patches,
    });
    if (result.status === 'conflict') fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    await this.#record('workflow.run.cancelled', {
      targetId: run.id,
      detail: { reason, releasedCents, skippedNodeIds: patches.map(item => item.id) },
      context,
    });
    return { run: publicRun(result.run, await this.repository.listNodeRuns(run.id)) };
  }

  // ---- 开跑后修改未执行节点 ----

  async reconfigure(runId, nodeIdValue, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, RECONFIGURE_FIELDS, '修改节点');
    const run = await this.#loadForWrite(runId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    if (run.revision !== expected) {
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    if (!['running', 'partial_failed'].includes(run.status)) {
      fail('RUN_NOT_RECONFIGURABLE', '只有执行中或部分失败的运行可以修改未执行节点。', 409);
    }
    if (this.active.has(run.id)) {
      fail('RUN_BUSY', '运行正在执行，请等待当前节点结束再修改。', 409);
    }
    const nodeId = String(nodeIdValue || '').trim();
    if (!isObject(body.params)) fail('INVALID_FIELD', 'params 必须是节点参数对象。');
    const rows = await this.repository.listNodeRuns(run.id);
    if (rows.some(row => ['queued', 'running'].includes(row.status))) {
      fail('RUN_IN_PROGRESS', '有节点正在执行，请等待当前节点结束后再修改。', 409);
    }
    if (rows.some(row => row.status === 'unknown')) {
      fail('RUN_HAS_UNKNOWN', '存在未知任务，必须先查询原任务，不能重新估价。', 409);
    }
    const row = rows.find(item => item.nodeId === nodeId);
    if (!row) throw new AppError('NODE_RUN_NOT_FOUND', '节点运行不存在。', 404);
    if (!['pending', 'blocked'].includes(row.status)) {
      fail('NODE_LOCKED', '只有尚未成功执行的节点可以修改；已执行节点不可改。', 409);
    }
    const graph = isObject(run.graph) ? clone(run.graph) : { nodes: [], edges: [] };
    const nodes = (graph.nodes || []).map(node => (node.id === nodeId
      ? { ...node, params: body.params } : node));
    const validated = validateWorkflowGraph(nodes, graph.edges || [], {
      lockedNodes: graph.lockedNodes || [],
    });
    const nextGraph = {
      nodes: validated.nodes, edges: validated.edges, lockedNodes: validated.lockedNodes,
    };
    const updatedInstance = await this.workflows.updateInstance(run.workflowInstanceId, {
      nodes: nextGraph.nodes,
      edges: nextGraph.edges,
    }, {
      workspaceId,
      ifMatch: `"r${run.instanceRevision}"`,
      allowStartedRun: true,
      ...context,
    });
    const now = this.now();
    // 释放被改节点及其下游的预占；旧运行整体作废，已成功节点保留在历史中。
    let releasedCents = 0;
    for (const item of rows) {
      if (!['pending', 'blocked'].includes(item.status)) continue;
      if (item.billingTaskId && (item.reservedCents > 0 || item.quote?.status === 'pending_price')) {
        await this.billing.release(item.billingTaskId, {
          idempotencyKey: `release:${item.billingTaskId}`,
          reason: '重新估价前释放预占',
        }).catch(() => {});
        releasedCents += item.reservedCents;
      }
    }
    const oldNodePatches = rows
      .filter(item => ['pending', 'blocked'].includes(item.status))
      .map(item => ({
        id: item.id,
        patch: {
          status: 'skipped', reservedCents: 0, errorCode: 'RUN_SUPERSEDED',
          finishedAt: now, updatedAt: now,
        },
      }));
    const successorId = this.idFactory();
    const successorRows = rows.map(item => {
      const base = {
        ...item,
        id: this.idFactory(),
        runId: successorId,
        dependsOn: (edgeMap(nextGraph.edges).get(item.nodeId) || []).map(edge => edge.source),
        reservedCents: 0,
        updatedAt: now,
        createdAt: now,
      };
      if (['succeeded', 'skipped'].includes(item.status)) {
        // 新批次沿用已执行节点，但幂等键必须重新生成，避免跨批次唯一约束冲突。
        return {
          ...base,
          reused: true,
          idempotencyKey: `run:${successorId}:${item.nodeId}:reused`,
        };
      }
      return {
        ...base,
        status: 'pending',
        jobId: null,
        jobRequestId: null,
        quote: {},
        amountCents: null,
        actualCostCents: null,
        billingTaskId: null,
        idempotencyKey: `run:${successorId}:${item.nodeId}:a1`,
        attempts: 0,
        attemptHistory: [],
        errorCode: null,
        reused: false,
        startedAt: null,
        finishedAt: null,
      };
    });
    const successor = {
      id: successorId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      planVersion: run.planVersion,
      deliverableId: run.deliverableId,
      workflowInstanceId: run.workflowInstanceId,
      instanceRevision: updatedInstance.instance.revision,
      status: 'awaiting_confirmation',
      graph: nextGraph,
      estimate: {},
      estimateTotalCents: null,
      estimatePendingCount: 0,
      reservedCents: 0,
      settledCents: 0,
      releasedCents: 0,
      idempotencyKey: null,
      requestHash: null,
      supersedesRunId: run.id,
      cancelReason: null,
      confirmedAt: null,
      confirmedBy: null,
      startedAt: null,
      finishedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.repository.createSuccessor({
      oldRunId: run.id,
      expectedOldRevision: expected,
      oldPatch: {
        status: 'cancelled',
        cancelReason: '节点参数变更，已由新的待确认运行替代',
        reservedCents: 0,
        releasedCents: (run.releasedCents || 0) + releasedCents,
        finishedAt: now,
        updatedAt: now,
      },
      oldNodePatches,
      successor,
      nodeRuns: successorRows,
    });
    if (created.status === 'conflict') {
      fail('REVISION_CONFLICT', '运行已被其他操作更新，请刷新后重试。', 409);
    }
    await this.#record('workflow.run.reconfigured', {
      targetId: run.id,
      detail: {
        nodeId,
        successorRunId: successorId,
        executedNodeIds: successorRows.filter(item => item.reused).map(item => item.nodeId),
      },
      context,
    });
    return {
      run: publicRun(created.run, created.nodeRuns),
      supersedesRunId: run.id,
      requiresEstimate: true,
      requiresConfirmation: true,
    };
  }

  async #loadForWrite(runId, workspaceId) {
    const run = await this.repository.getRun(uuidField(runId, '运行编号'));
    if (!run) throw new AppError('RUN_NOT_FOUND', '工作流运行不存在。', 404);
    if (workspaceId && run.workspaceId !== workspaceId) {
      throw new AppError('FORBIDDEN', '无权操作该工作流运行。', 403);
    }
    return run;
  }

  async get(runId, { workspaceId = null } = {}) {
    const run = await this.#loadForWrite(runId, workspaceId);
    return { run: publicRun(run, await this.repository.listNodeRuns(run.id)) };
  }

  // 刷新页面后按工作流实例恢复最近一次运行。没有运行返回 run:null，
  // 不凭编号猜任务，也不自动创建新批次。
  async latest(instanceId, { workspaceId = null } = {}) {
    if (!this.workflows) throw new AppError('WORKFLOW_UNAVAILABLE', '工作流服务未配置。', 503);
    const id = uuidField(instanceId, '工作流实例编号');
    const { instance } = await this.workflows.getInstance(id, { workspaceId });
    if (typeof this.repository.latestRun !== 'function') return { run: null, nodes: [] };
    const workspace = this.#workspace(workspaceId, instance.workspaceId);
    const run = await this.repository.latestRun(workspace, instance.id);
    if (!run) return { run: null, nodes: [] };
    return { run: publicRun(run, await this.repository.listNodeRuns(run.id)) };
  }
}

// 生产适配器：复用现有 GenerationService 与单执行器；等待只轮询任务状态，
// 超时或异常保持 unknown，绝不重新提交付费请求或切换模型。
export class GenerationJobAdapter {
  constructor({ generation, store, registry = null, pollMs = 500, timeoutMs = 15 * 60_000 }) {
    this.generation = generation;
    this.store = store;
    this.registry = registry;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
  }

  async submit({ requestId, operation, modelId, prompt, size, quality, sourceJobId, workspaceId }) {
    let chosenSize = size;
    let chosenQuality = quality;
    if ((!chosenSize || !chosenQuality) && this.registry) {
      const model = await this.registry.resolve(modelId).catch(() => null);
      if (model) {
        chosenSize = chosenSize || model.sizes?.[0] || null;
        chosenQuality = chosenQuality || model.qualities?.[0] || null;
      }
    }
    return this.generation.create({
      requestId,
      modelId,
      prompt,
      size: chosenSize || '1024x1024',
      quality: chosenQuality || 'standard',
      operation,
      sourceJobId: sourceJobId || null,
    }, { workspaceId });
  }

  async wait(jobId, { timeoutMs = this.timeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.store.get(jobId);
      if (!job) throw new AppError('JOB_NOT_FOUND', '生成任务不存在。', 404);
      if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(job.status)) return job;
      await delay(this.pollMs);
    }
    return {
      id: jobId,
      status: 'unknown',
      error: { code: 'POLL_TIMEOUT', message: '等待超时，保留预占，请查询原任务。' },
    };
  }

  async reconcile(jobId) {
    return this.generation.reconcile(jobId);
  }
}

// ---- PostgreSQL 仓储 ----

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planVersion: row.plan_version,
    deliverableId: row.deliverable_id,
    workflowInstanceId: row.workflow_instance_id,
    instanceRevision: row.instance_revision,
    status: row.status,
    graph: row.graph,
    estimate: row.estimate,
    estimateTotalCents: row.estimate_total_cents === null ? null : Number(row.estimate_total_cents),
    estimatePendingCount: row.estimate_pending_count,
    reservedCents: Number(row.reserved_cents),
    settledCents: Number(row.settled_cents),
    releasedCents: Number(row.released_cents),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    supersedesRunId: row.supersedes_run_id,
    cancelReason: row.cancel_reason,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nodeRunFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    nodeName: row.node_name,
    status: row.status,
    dependsOn: row.depends_on,
    jobId: row.job_id,
    jobRequestId: row.job_request_id,
    quote: row.quote,
    output: row.output,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    reservedCents: Number(row.reserved_cents),
    actualCostCents: row.actual_cost_cents === null ? null : Number(row.actual_cost_cents),
    billingTaskId: row.billing_task_id,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    attemptHistory: row.attempt_history,
    errorCode: row.error_code,
    reused: row.reused,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RUN_COLUMNS = {
  status: 'status',
  graph: 'graph',
  estimate: 'estimate',
  estimateTotalCents: 'estimate_total_cents',
  estimatePendingCount: 'estimate_pending_count',
  reservedCents: 'reserved_cents',
  settledCents: 'settled_cents',
  releasedCents: 'released_cents',
  idempotencyKey: 'idempotency_key',
  requestHash: 'request_hash',
  supersedesRunId: 'supersedes_run_id',
  cancelReason: 'cancel_reason',
  confirmedAt: 'confirmed_at',
  confirmedBy: 'confirmed_by',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  instanceRevision: 'instance_revision',
  updatedAt: 'updated_at',
};

const NODE_JSON_COLUMNS = new Set(['dependsOn', 'quote', 'output', 'attemptHistory']);

const NODE_COLUMNS = {
  runId: 'run_id',
  workspaceId: 'workspace_id',
  nodeId: 'node_id',
  nodeType: 'node_type',
  nodeName: 'node_name',
  status: 'status',
  dependsOn: 'depends_on',
  jobId: 'job_id',
  jobRequestId: 'job_request_id',
  quote: 'quote',
  output: 'output',
  amountCents: 'amount_cents',
  reservedCents: 'reserved_cents',
  actualCostCents: 'actual_cost_cents',
  billingTaskId: 'billing_task_id',
  idempotencyKey: 'idempotency_key',
  attempts: 'attempts',
  attemptHistory: 'attempt_history',
  errorCode: 'error_code',
  reused: 'reused',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const INSERT_RUN = `
  INSERT INTO sj_workflow_runs (
    id, workspace_id, project_id, plan_version, deliverable_id, workflow_instance_id,
    instance_revision, status, graph, estimate, estimate_total_cents, estimate_pending_count,
    reserved_cents, settled_cents, released_cents, idempotency_key, request_hash,
    supersedes_run_id, cancel_reason, confirmed_at, confirmed_by, started_at, finished_at,
    revision, created_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
  ) RETURNING *`;

const INSERT_NODE = `
  INSERT INTO sj_workflow_node_runs (
    id, run_id, workspace_id, node_id, node_type, node_name, status, depends_on,
    job_id, job_request_id, quote, output, amount_cents, reserved_cents, actual_cost_cents,
    billing_task_id, idempotency_key, attempts, attempt_history, error_code, reused,
    started_at, finished_at, created_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
  )
  ON CONFLICT (run_id, node_id) DO UPDATE SET
    status=EXCLUDED.status, depends_on=EXCLUDED.depends_on, job_id=EXCLUDED.job_id,
    job_request_id=EXCLUDED.job_request_id, quote=EXCLUDED.quote, output=EXCLUDED.output,
    amount_cents=EXCLUDED.amount_cents, reserved_cents=EXCLUDED.reserved_cents,
    actual_cost_cents=EXCLUDED.actual_cost_cents, billing_task_id=EXCLUDED.billing_task_id,
    idempotency_key=EXCLUDED.idempotency_key, attempts=EXCLUDED.attempts,
    attempt_history=EXCLUDED.attempt_history, error_code=EXCLUDED.error_code,
    reused=EXCLUDED.reused, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at,
    updated_at=EXCLUDED.updated_at
  RETURNING *`;

function runParams(run) {
  return [
    run.id, run.workspaceId, run.projectId, run.planVersion, run.deliverableId,
    run.workflowInstanceId, run.instanceRevision, run.status, JSON.stringify(run.graph || {}),
    JSON.stringify(run.estimate || {}), run.estimateTotalCents ?? null,
    run.estimatePendingCount ?? 0, run.reservedCents ?? 0, run.settledCents ?? 0,
    run.releasedCents ?? 0, run.idempotencyKey ?? null, run.requestHash ?? null,
    run.supersedesRunId ?? null, run.cancelReason ?? null, run.confirmedAt ?? null,
    run.confirmedBy ?? null, run.startedAt ?? null, run.finishedAt ?? null,
    run.revision ?? 1, run.createdAt ?? new Date(), run.updatedAt ?? new Date(),
  ];
}

function nodeParams(row) {
  return [
    row.id, row.runId, row.workspaceId, row.nodeId, row.nodeType, row.nodeName ?? null,
    row.status, JSON.stringify(row.dependsOn || []), row.jobId ?? null,
    row.jobRequestId ?? null, JSON.stringify(row.quote || {}), JSON.stringify(row.output || {}),
    row.amountCents ?? null, row.reservedCents ?? 0, row.actualCostCents ?? null, row.billingTaskId ?? null,
    row.idempotencyKey, row.attempts ?? 0, JSON.stringify(row.attemptHistory || []),
    row.errorCode ?? null, Boolean(row.reused), row.startedAt ?? null, row.finishedAt ?? null,
    row.createdAt ?? new Date(), row.updatedAt ?? new Date(),
  ];
}

function buildUpdate(mapping, jsonColumns, patch, startIndex = 1) {
  const values = [];
  const sets = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = mapping[key];
    if (!column) continue;
    values.push(jsonColumns.has(key) ? JSON.stringify(value) : value);
    sets.push(`${column}=$${startIndex + values.length - 1}`);
  }
  return { values, sets };
}

function appendUpdatedAt(sets) {
  if (!sets.some(set => set.startsWith('updated_at='))) sets.push('updated_at=now()');
}

export class PgRunRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async getRun(id) {
    return runFromRow((await this.pool.query(
      'SELECT * FROM sj_workflow_runs WHERE id=$1', [id],
    )).rows[0]);
  }

  async getRunByIdempotencyKey(workspaceId, key) {
    return runFromRow((await this.pool.query(
      'SELECT * FROM sj_workflow_runs WHERE workspace_id=$1 AND idempotency_key=$2',
      [workspaceId, key],
    )).rows[0]);
  }

  async findOpenRun(workspaceId, instanceId) {
    return runFromRow((await this.pool.query(
      `SELECT * FROM sj_workflow_runs
       WHERE workspace_id=$1 AND workflow_instance_id=$2 AND idempotency_key IS NULL
         AND status IN ('draft','estimating','awaiting_confirmation')
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, instanceId],
    )).rows[0]);
  }

  async findLiveRun(workspaceId, instanceId) {
    return runFromRow((await this.pool.query(
      `SELECT * FROM sj_workflow_runs
       WHERE workspace_id=$1 AND workflow_instance_id=$2
         AND status IN ('running','partial_failed')
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, instanceId],
    )).rows[0]);
  }

  async latestRun(workspaceId, instanceId) {
    return runFromRow((await this.pool.query(
      `SELECT * FROM sj_workflow_runs
       WHERE workspace_id=$1 AND workflow_instance_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, instanceId],
    )).rows[0]);
  }

  async listNodeRuns(runId) {
    return (await this.pool.query(
      'SELECT * FROM sj_workflow_node_runs WHERE run_id=$1 ORDER BY created_at, node_id',
      [runId],
    )).rows.map(nodeRunFromRow);
  }

  async insertRun(run, nodeRuns = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = (await client.query(INSERT_RUN, runParams(run))).rows[0];
      for (const row of nodeRuns) await client.query(INSERT_NODE, nodeParams(row));
      await client.query('COMMIT');
      return runFromRow(inserted);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRun(id, expectedRevision, patch) {
    const startIndex = expectedRevision === null ? 2 : 3;
    const { values, sets } = buildUpdate(RUN_COLUMNS, new Set(['graph', 'estimate']), patch, startIndex);
    appendUpdatedAt(sets);
    const filter = expectedRevision === null ? 'id=$1' : 'id=$1 AND revision=$2';
    const params = expectedRevision === null ? [id, ...values] : [id, expectedRevision, ...values];
    const updated = (await this.pool.query(
      `UPDATE sj_workflow_runs SET ${sets.join(',')}, revision=revision+${expectedRevision === null ? 0 : 1}
       WHERE ${filter} RETURNING *`, params,
    )).rows[0];
    if (updated) return { status: 'ok', run: runFromRow(updated) };
    const current = await this.getRun(id);
    return current ? { status: 'conflict', run: current } : { status: 'missing' };
  }

  async updateNodeRun(id, patch) {
    const { values, sets } = buildUpdate(NODE_COLUMNS, NODE_JSON_COLUMNS, patch, 2);
    appendUpdatedAt(sets);
    const updated = (await this.pool.query(
      `UPDATE sj_workflow_node_runs SET ${sets.join(',')} WHERE id=$1 RETURNING *`,
      [id, ...values],
    )).rows[0];
    return nodeRunFromRow(updated);
  }

  async mutateRun({ runId, expectedRevision = null, runPatch = {}, nodePatches = [], nodeUpserts = [] }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentRow = (await client.query(
        'SELECT * FROM sj_workflow_runs WHERE id=$1 FOR UPDATE', [runId],
      )).rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const current = runFromRow(currentRow);
      if (expectedRevision !== null && current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { status: 'conflict', run: current };
      }
      const startIndex = expectedRevision === null ? 2 : 3;
      const runUpdate = buildUpdate(RUN_COLUMNS, new Set(['graph', 'estimate']), runPatch, startIndex);
      appendUpdatedAt(runUpdate.sets);
      const runValues = expectedRevision === null
        ? [runId, ...runUpdate.values]
        : [runId, expectedRevision, ...runUpdate.values];
      const updatedRow = (await client.query(
        `UPDATE sj_workflow_runs SET ${runUpdate.sets.join(',')},
           revision=revision+1
         WHERE id=$1${expectedRevision === null ? '' : ' AND revision=$2'} RETURNING *`,
        runValues,
      )).rows[0];
      for (const row of nodeUpserts) await client.query(INSERT_NODE, nodeParams(row));
      for (const item of nodePatches) {
        const update = buildUpdate(NODE_COLUMNS, NODE_JSON_COLUMNS, item.patch, 2);
        appendUpdatedAt(update.sets);
        await client.query(
          `UPDATE sj_workflow_node_runs SET ${update.sets.join(',')} WHERE id=$1`,
          [item.id, ...update.values],
        );
      }
      await client.query('COMMIT');
      return { status: 'ok', run: runFromRow(updatedRow) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async confirmRun({ runId, workflowInstanceId, expectedRevision, expectedInstanceRevision, runPatch, nodeRuns }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const instance = (await client.query(
        'SELECT revision FROM sj_workflow_instances WHERE id=$1 FOR UPDATE', [workflowInstanceId],
      )).rows[0];
      if (!instance || Number(instance.revision) !== expectedInstanceRevision) {
        await client.query('ROLLBACK');
        return { status: 'instance_conflict' };
      }

      const currentRow = (await client.query(
        'SELECT * FROM sj_workflow_runs WHERE id=$1 FOR UPDATE', [runId],
      )).rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const current = runFromRow(currentRow);
      if (current.idempotencyKey && current.idempotencyKey === runPatch.idempotencyKey) {
        await client.query('ROLLBACK');
        return { status: 'started', run: current };
      }
      if (current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { status: 'conflict', run: current };
      }
      if (current.status !== 'awaiting_confirmation' || current.idempotencyKey) {
        await client.query('ROLLBACK');
        return { status: 'started', run: current };
      }

      const { values, sets } = buildUpdate(RUN_COLUMNS, new Set(['graph', 'estimate']), runPatch, 3);
      appendUpdatedAt(sets);
      const updatedRow = (await client.query(
        `UPDATE sj_workflow_runs SET ${sets.join(',')}, revision=revision+1
         WHERE id=$1 AND revision=$2 RETURNING *`, [runId, expectedRevision, ...values],
      )).rows[0];
      if (!updatedRow) {
        await client.query('ROLLBACK');
        const latest = await this.getRun(runId);
        return latest ? { status: 'conflict', run: latest } : { status: 'missing' };
      }
      for (const row of nodeRuns) await client.query(INSERT_NODE, nodeParams(row));
      await client.query('COMMIT');
      return { status: 'ok', run: runFromRow(updatedRow) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505' && error.constraint === 'sj_workflow_runs_idempotency_unique') {
        return { status: 'key_conflict' };
      }
      throw error;
    } finally {
      client.release();
    }
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentRow = (await client.query(
        'SELECT * FROM sj_workflow_runs WHERE id=$1 FOR UPDATE', [oldRunId],
      )).rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const current = runFromRow(currentRow);
      if (current.revision !== expectedOldRevision) {
        await client.query('ROLLBACK');
        return { status: 'conflict', run: current };
      }
      const update = buildUpdate(RUN_COLUMNS, new Set(['graph', 'estimate']), oldPatch, 3);
      appendUpdatedAt(update.sets);
      await client.query(
        `UPDATE sj_workflow_runs SET ${update.sets.join(',')}, revision=revision+1
         WHERE id=$1 AND revision=$2`,
        [oldRunId, expectedOldRevision, ...update.values],
      );
      for (const item of oldNodePatches) {
        const nodeUpdate = buildUpdate(NODE_COLUMNS, NODE_JSON_COLUMNS, item.patch, 2);
        appendUpdatedAt(nodeUpdate.sets);
        await client.query(
          `UPDATE sj_workflow_node_runs SET ${nodeUpdate.sets.join(',')} WHERE id=$1`,
          [item.id, ...nodeUpdate.values],
        );
      }
      const inserted = (await client.query(INSERT_RUN, runParams(successor))).rows[0];
      for (const row of nodeRuns) await client.query(INSERT_NODE, nodeParams(row));
      await client.query('COMMIT');
      return {
        status: 'ok',
        run: runFromRow(inserted),
        nodeRuns: nodeRuns.map(nodeRunFromRow),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
