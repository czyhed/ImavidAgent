import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import { RefineService } from '../server/refine.mjs';

// 全部使用内存仓储、假账本、假生成任务与假审计：
// 不连接 PostgreSQL / Redis / MinIO，不调用任何付费模型。

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

class MemoryRefineRepository {
  versions = new Map();
  states = new Map();
  requests = new Map();
  jobs = new Map();
  assets = new Map();

  constructor({ projectId, deliverableId, planVersion = 1, planStatus = 'confirmed' }) {
    this.target = {
      workspaceId: 'local',
      projectId,
      planVersion,
      planStatus,
      deliverableId,
      productId: randomUUID(),
      title: '白底主图',
      type: 'white',
      promptText: '燕麦色陶瓷杯',
      jobId: null,
      versionId: null,
      status: 'planned',
    };
  }

  addJob(job) {
    this.jobs.set(job.id, clone(job));
    return job;
  }

  addAsset(jobId, assetId) {
    this.assets.set(jobId, { id: assetId });
  }

  #key(scope) {
    return `${scope.projectId}:${scope.planVersion}:${scope.deliverableId}`;
  }

  #state(scope) {
    if (!this.states.has(this.#key(scope))) {
      this.states.set(this.#key(scope), {
        projectId: scope.projectId,
        planVersion: scope.planVersion,
        deliverableId: scope.deliverableId,
        workspaceId: scope.workspaceId,
        revision: 1,
        candidateVersionId: null,
        reworkVersionId: null,
        reworkReason: null,
        reworkAt: null,
        currentStep: null,
        updatedAt: new Date(),
      });
    }
    return this.states.get(this.#key(scope));
  }

  #bumpState(scope) {
    const state = this.#state(scope);
    state.revision += 1;
    state.updatedAt = new Date();
    return clone(state);
  }

  async getDeliverable({ workspaceId, deliverableId, projectId = null, planVersion = null }) {
    if (deliverableId !== this.target.deliverableId) return null;
    if (projectId && projectId !== this.target.projectId) return null;
    if (planVersion && Number(planVersion) !== this.target.planVersion) return null;
    if (workspaceId && workspaceId !== this.target.workspaceId) return null;
    return clone(this.target);
  }

  async getState(scope) {
    const state = this.states.get(this.#key(scope));
    return state ? clone(state) : null;
  }

  async listVersions(scope) {
    return [...this.versions.values()]
      .filter(row => row.workspaceId === scope.workspaceId && row.projectId === scope.projectId
        && row.planVersion === scope.planVersion && row.deliverableId === scope.deliverableId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async getVersion(workspaceId, versionId) {
    const row = this.versions.get(versionId);
    return row && row.workspaceId === workspaceId ? clone(row) : null;
  }

  async createVersion({ scope, row }) {
    const versions = await this.listVersions(scope);
    const existing = versions.find(item => item.jobId === row.jobId
      && (row.jobId || item.assetId === row.assetId)
      && item.sourceVersionId === row.sourceVersionId && item.refinePath === null
      && JSON.stringify(item.content) === JSON.stringify(row.content));
    if (existing) return { version: existing, state: clone(this.#state(scope)), created: false };
    const next = versions.length ? versions[0].version + 1 : 1;
    const saved = { ...clone(row), version: next };
    this.versions.set(saved.id, saved);
    const state = this.#bumpState(scope);
    return { version: clone(saved), state };
  }

  async findRequestByKey(workspaceId, key) {
    const row = [...this.requests.values()]
      .find(item => item.workspaceId === workspaceId && item.idempotencyKey === key);
    return row ? clone(row) : null;
  }

  async getRequest(workspaceId, id) {
    const row = this.requests.get(id);
    return row && (!workspaceId || row.workspaceId === workspaceId) ? clone(row) : null;
  }

  async findOpenRequest(scope) {
    const row = [...this.requests.values()]
      .filter(item => item.workspaceId === scope.workspaceId && item.projectId === scope.projectId
        && item.planVersion === scope.planVersion && item.deliverableId === scope.deliverableId
        && !item.idempotencyKey && ['draft', 'awaiting_confirmation'].includes(item.status))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return row ? clone(row) : null;
  }

  async saveDraftRequest({ scope, row }) {
    const existing = await this.findOpenRequest(scope);
    let saved;
    if (existing) {
      saved = {
        ...existing,
        path: row.path,
        sourceVersionId: row.sourceVersionId,
        targetVersionId: null,
        params: clone(row.params),
        status: 'awaiting_confirmation',
        quote: clone(row.quote),
        estimateCents: row.estimateCents,
        reservedCents: 0,
        actualCostCents: null,
        currency: 'CNY',
        billingTaskId: null,
        jobId: null,
        idempotencyKey: null,
        errorCode: null,
        confirmedBy: null,
        confirmedAt: null,
        revision: existing.revision + 1,
        updatedAt: row.updatedAt,
      };
    } else {
      saved = { ...clone(row), revision: 1 };
    }
    this.requests.set(saved.id, saved);
    const state = this.#bumpState(scope);
    return { request: clone(saved), state };
  }

  async listRequests(scope) {
    return [...this.requests.values()]
      .filter(row => row.workspaceId === scope.workspaceId && row.projectId === scope.projectId
        && row.planVersion === scope.planVersion && row.deliverableId === scope.deliverableId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(clone);
  }

  async updateRequest({ requestId, expectedRevision = null, patch }) {
    const current = this.requests.get(requestId);
    if (!current) return { status: 'missing' };
    if (expectedRevision !== null && current.revision !== expectedRevision) {
      return { status: 'conflict', request: clone(current) };
    }
    const saved = {
      ...current, ...clone(patch), revision: current.revision + 1, updatedAt: new Date(),
    };
    this.requests.set(requestId, saved);
    return { status: 'ok', request: clone(saved) };
  }

  async completeRequest({ scope, requestId, expectedRevision = null, requestPatch = {}, version }) {
    const current = this.requests.get(requestId);
    if (!current) return { status: 'missing' };
    if (current.targetVersionId) {
      return {
        status: 'already',
        request: clone(current),
        version: clone(this.versions.get(current.targetVersionId)),
        state: clone(this.#state(scope)),
      };
    }
    if (expectedRevision !== null && current.revision !== expectedRevision) {
      return { status: 'conflict', request: clone(current) };
    }
    if (current.idempotencyKey && requestPatch.idempotencyKey
      && current.idempotencyKey !== requestPatch.idempotencyKey) {
      return { status: 'conflict', request: clone(current) };
    }
    const versions = await this.listVersions(scope);
    const next = versions.length ? versions[0].version + 1 : 1;
    const savedVersion = { ...clone(version), version: next };
    this.versions.set(savedVersion.id, savedVersion);
    const saved = {
      ...current,
      ...clone(requestPatch),
      targetVersionId: savedVersion.id,
      revision: current.revision + 1,
      updatedAt: new Date(),
    };
    this.requests.set(requestId, saved);
    const state = this.#bumpState(scope);
    return {
      status: 'ok', request: clone(saved), version: clone(savedVersion), state,
    };
  }

  async selectCandidate({ scope, versionId, expectedRevision, now }) {
    const state = this.#state(scope);
    if (state.revision !== expectedRevision) return { status: 'conflict', state: clone(state) };
    const target = this.versions.get(versionId);
    if (!target) return { status: 'missing' };
    const previousCandidateVersionId = state.candidateVersionId ?? null;
    const supersededVersionIds = [];
    for (const row of this.versions.values()) {
      if (row.workspaceId !== scope.workspaceId || row.projectId !== scope.projectId
        || row.planVersion !== scope.planVersion || row.deliverableId !== scope.deliverableId) continue;
      if (row.isCandidate && row.id !== versionId) {
        row.status = 'superseded';
        row.isCandidate = false;
        row.updatedAt = now;
        supersededVersionIds.push(row.id);
      }
    }
    target.status = 'candidate';
    target.isCandidate = true;
    target.updatedAt = now;
    state.candidateVersionId = versionId;
    const savedState = this.#bumpState(scope);
    return {
      status: 'ok',
      version: clone(target),
      state: savedState,
      previousCandidateVersionId,
      supersededVersionIds,
    };
  }

  async rework({ scope, versionId, reason, expectedRevision, now }) {
    const state = this.#state(scope);
    if (state.revision !== expectedRevision) return { status: 'conflict', state: clone(state) };
    const target = this.versions.get(versionId);
    if (!target) return { status: 'missing' };
    const previousStatus = target.status;
    if (['candidate', 'approved'].includes(target.status)) {
      target.status = 'draft';
      target.isCandidate = false;
      target.updatedAt = now;
    }
    const candidateCleared = state.candidateVersionId === versionId;
    if (candidateCleared) state.candidateVersionId = null;
    state.reworkVersionId = versionId;
    state.reworkReason = reason;
    state.reworkAt = now;
    state.currentStep = 4;
    const savedState = this.#bumpState(scope);
    return {
      status: 'ok',
      version: clone(target),
      previousStatus,
      candidateCleared,
      state: savedState,
    };
  }

  async findJob(jobId) {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  async findAssetByJob({ jobId }) {
    const asset = this.assets.get(jobId);
    return asset ? clone(asset) : null;
  }
}

class MemoryBilling {
  prices = new Map();
  entries = [];
  state = new Map();

  setPrice(capability, modelId, amountCents) {
    this.prices.set(`${capability}:${modelId}`, amountCents);
    return this;
  }

  async quote({ capability, modelId, tier = 'default', quantity = 1 }) {
    const price = this.prices.get(`${capability}:${modelId}`);
    return {
      priced: price !== undefined,
      status: price === undefined ? 'pending_price' : 'priced',
      billingMode: 'chargeable',
      capability,
      modelId,
      tier,
      quantity,
      currency: 'CNY',
      amountCents: price === undefined ? null : price * quantity,
      unit: 'image',
      unitPrice: price ?? null,
      priceId: null,
      priceVersion: 1,
    };
  }

  async reserve(body, { actorId = 'local' } = {}) {
    const state = this.state.get(body.taskId) || {};
    if (state.reserve || state.pending) {
      const entry = state.reserve || state.pending;
      return { status: 'reserved', created: false, entry: clone(entry) };
    }
    const quote = await this.quote(body);
    const entry = {
      taskId: body.taskId,
      amountCents: quote.amountCents,
      idempotencyKey: body.idempotencyKey,
      actorId,
      quote,
    };
    this.entries.push(clone(entry));
    this.state.set(body.taskId, {
      ...state, ...(quote.amountCents === null ? { pending: entry } : { reserve: entry }),
    });
    return {
      status: quote.amountCents === null ? 'pending_price' : 'reserved',
      created: true,
      entry: clone(entry),
      quote,
    };
  }

  async settle(taskId, body = {}, { actorId = 'local' } = {}) {
    const state = this.state.get(taskId) || {};
    if (state.settle) return { status: 'settled', created: false, entry: clone(state.settle) };
    if (!state.reserve) throw new AppError('BILLING_TASK_NOT_FOUND', '任务不存在。', 404);
    const entry = { taskId, amountCents: state.reserve.amountCents, actorId, idempotencyKey: body.idempotencyKey };
    this.state.set(taskId, { ...state, settle: entry });
    return { status: 'settled', created: true, entry: clone(entry) };
  }

  async release(taskId, body = {}, { actorId = 'local' } = {}) {
    const state = this.state.get(taskId) || {};
    if (state.release) return { status: 'released', created: false, entry: clone(state.release) };
    if (!state.reserve && !state.pending) throw new AppError('BILLING_TASK_NOT_FOUND', '任务不存在。', 404);
    const source = state.reserve || state.pending;
    const entry = { taskId, amountCents: source.amountCents, actorId, idempotencyKey: body.idempotencyKey };
    this.state.set(taskId, { ...state, release: entry });
    return { status: 'released', created: true, entry: clone(entry) };
  }

  heldCents() {
    return [...this.state.values()]
      .filter(state => state.reserve && !state.settle && !state.release)
      .reduce((total, state) => total + (state.reserve.amountCents || 0), 0);
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
    const status = this.behavior.get(input.modelId) || 'succeeded';
    const job = {
      id,
      status,
      input,
      output: status === 'succeeded' ? { bytes: 128 } : null,
      error: status === 'failed' ? { code: 'UPSTREAM_FAILED' }
        : (status === 'unknown' ? { code: 'UPSTREAM_UNKNOWN' } : null),
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
    job.status = 'succeeded';
    job.output = { bytes: 128 };
    job.error = null;
    return clone(job);
  }
}

class MemoryAudit {
  entries = [];

  async record(entry) {
    this.entries.push(clone(entry));
    return clone(entry);
  }

  actions() {
    return this.entries.map(entry => entry.action);
  }
}

function fixture({ price = 800, jobStatus = 'succeeded' } = {}) {
  const projectId = randomUUID();
  const deliverableId = randomUUID();
  const repository = new MemoryRefineRepository({ projectId, deliverableId });
  const jobId = randomUUID();
  const assetId = randomUUID();
  repository.addJob({
    id: jobId,
    status: jobStatus,
    workspaceId: 'local',
    output: { bytes: 128 },
    input: {
      modelId: 'test:image',
      prompt: '燕麦色陶瓷杯主图',
      size: '1024x1024',
      quality: 'standard',
      operation: 'generate',
      sourceJobId: null,
      workspaceId: 'local',
    },
  });
  repository.addAsset(jobId, assetId);
  const billing = new MemoryBilling()
    .setPrice('image.edit', 'test:image', price)
    .setPrice('image.generate', 'test:image', price);
  const jobs = new FakeJobs();
  const audit = new MemoryAudit();
  const service = new RefineService(repository, { billing, jobs, audit, autoStart: false });
  return {
    service, repository, billing, jobs, audit,
    projectId, deliverableId, jobId, assetId, planVersion: 1,
  };
}

async function importSource(f) {
  return f.service.importVersion(f.deliverableId, { jobId: f.jobId });
}

async function estimateAndConfirm(f, path, params = {}) {
  const estimated = await f.service.estimate(f.deliverableId, { path, params });
  const confirmed = await f.service.confirm(f.deliverableId, {
    refineId: estimated.request.id,
    idempotencyKey: `refine-${randomUUID()}`,
    revision: estimated.request.revision,
  });
  return { estimated, confirmed };
}

// ---- 路径一：模板重排 ----

test('模板重排：报价 0、不建生成任务、不是重新生图，产物不自动成为候选', async () => {
  const f = fixture();
  await importSource(f);
  const { estimated, confirmed } = await estimateAndConfirm(f, 'template_reorder', {
    templateId: 'tmpl-01',
  });

  assert.equal(estimated.quote.amountCents, 0);
  assert.equal(estimated.quote.billingMode, 'none');
  assert.equal(estimated.quote.regeneratesImage, false);
  assert.equal(confirmed.request.status, 'succeeded');
  assert.equal(f.jobs.submissions.length, 0);
  assert.equal(f.billing.entries.length, 0);

  const version = confirmed.version;
  assert.equal(version.status, 'draft');
  assert.equal(version.isCandidate, false);
  assert.equal(version.requiresQc, false);
  assert.equal(version.refinePath, 'template_reorder');
  assert.equal(version.content.notRegenerated, true);
  assert.equal(version.content.inheritsSourceQc, true);
  assert.equal(version.cost.actualCostCents, 0);

  const versions = await f.service.listVersions(f.deliverableId);
  assert.equal(versions.state.candidateVersionId, null);
  assert.equal(versions.versions.length, 2);
});

// ---- 路径二：底图二次优化 ----

test('底图二次优化：确认才预占、成功结算，版本为 draft 且不自动候选', async () => {
  const f = fixture({ price: 800 });
  const imported = await importSource(f);
  const estimated = await f.service.estimate(f.deliverableId, {
    path: 'base_optimize',
    params: { modelId: 'test:image' },
  });
  assert.equal(estimated.quote.amountCents, 800);
  assert.equal(estimated.quote.capability, 'image.edit');
  assert.equal(f.billing.entries.length, 0, '估价不得预占');

  const confirmed = await f.service.confirm(f.deliverableId, {
    refineId: estimated.request.id,
    idempotencyKey: 'base-optimize-1',
    revision: estimated.request.revision,
  });
  assert.equal(confirmed.request.status, 'running');
  assert.equal(confirmed.request.totals.reservedCents, 800);
  assert.equal(f.billing.heldCents(), 800);

  const executed = await f.service.executeRefine(estimated.request.id);
  assert.equal(executed.status, 'succeeded');
  assert.equal(executed.totals.actualCostCents, 800);
  assert.equal(f.billing.heldCents(), 0);
  assert.equal(f.jobs.submissions.length, 1);
  assert.equal(f.jobs.submissions[0].operation, 'edit');
  assert.equal(f.jobs.submissions[0].sourceJobId, f.jobId);

  const versions = await f.service.listVersions(f.deliverableId);
  const produced = versions.versions.find(item => item.id === executed.targetVersionId);
  assert.equal(produced.status, 'draft');
  assert.equal(produced.isCandidate, false);
  assert.equal(produced.requiresQc, false);
  assert.equal(produced.sourceVersionId, imported.version.id);
  assert.equal(versions.state.candidateVersionId, null);
});

// ---- 路径三：整图润色 ----

test('整图润色：产物必须重新质检、保持 draft；候选只能显式选定，旧候选变 superseded 但保留', async () => {
  const f = fixture({ price: 900 });
  const imported = await importSource(f);
  const first = await f.service.selectCandidate(f.deliverableId, {
    versionId: imported.version.id,
    revision: imported.state.revision,
  });
  assert.equal(first.version.status, 'candidate');
  assert.equal(first.state.candidateVersionId, imported.version.id);

  const estimated = await f.service.estimate(f.deliverableId, {
    path: 'full_polish',
    params: { modelId: 'test:image', prompt: '整图润色，保持文字清晰可读' },
  });
  assert.equal(estimated.quote.amountCents, 900);
  assert.equal(estimated.quote.requiresQc, true);

  const confirmed = await f.service.confirm(f.deliverableId, {
    refineId: estimated.request.id,
    idempotencyKey: 'full-polish-1',
    revision: estimated.request.revision,
  });
  const executed = await f.service.executeRefine(estimated.request.id);
  assert.equal(executed.status, 'succeeded');

  let versions = await f.service.listVersions(f.deliverableId);
  const polished = versions.versions.find(item => item.id === executed.targetVersionId);
  assert.equal(polished.status, 'draft');
  assert.equal(polished.isCandidate, false);
  assert.equal(polished.requiresQc, true);
  assert.equal(polished.cost.actualCostCents, 900);
  assert.equal(versions.state.candidateVersionId, imported.version.id, '完成不得自动成为候选');

  const selected = await f.service.selectCandidate(f.deliverableId, {
    versionId: polished.id,
    revision: versions.state.revision,
  });
  assert.equal(selected.state.candidateVersionId, polished.id);
  assert.equal(selected.version.status, 'candidate');

  versions = await f.service.listVersions(f.deliverableId);
  const previous = versions.versions.find(item => item.id === imported.version.id);
  assert.equal(previous.status, 'superseded');
  assert.equal(previous.isCandidate, false);
  assert.equal(versions.versions.length, 2, '旧候选保留，不删除历史版本');
  assert.equal(f.audit.actions().includes('deliverable.candidate.selected'), true);
});

// ---- 返修 ----

test('返修回到第 04 步：撤销候选、记录理由与目标版本，历史版本保留', async () => {
  const f = fixture();
  const imported = await importSource(f);
  const selected = await f.service.selectCandidate(f.deliverableId, {
    versionId: imported.version.id,
    revision: imported.state.revision,
  });

  const reworked = await f.service.rework(f.deliverableId, {
    versionId: imported.version.id,
    reason: '主图文字需要重新排版',
    revision: selected.state.revision,
  });
  assert.equal(reworked.version.status, 'draft');
  assert.equal(reworked.version.isCandidate, false);
  assert.equal(reworked.state.candidateVersionId, null);
  assert.equal(reworked.state.rework.versionId, imported.version.id);
  assert.equal(reworked.state.rework.reason, '主图文字需要重新排版');
  assert.equal(reworked.state.rework.step, 4);

  const versions = await f.service.listVersions(f.deliverableId);
  assert.equal(versions.versions.length, 1);
  assert.equal(versions.versions[0].id, imported.version.id);
  assert.equal(f.audit.actions().includes('deliverable.rework.requested'), true);
});

// ---- 未知状态 ----

test('未知状态：保留原任务与预占，不自动换模型；核实只查询原任务', async () => {
  const f = fixture({ price: 700 });
  await importSource(f);
  f.jobs.setBehavior('test:image', 'unknown');
  const { estimated, confirmed } = await estimateAndConfirm(f, 'base_optimize', {
    modelId: 'test:image',
  });
  assert.equal(confirmed.request.status, 'running');

  const executed = await f.service.executeRefine(estimated.request.id);
  assert.equal(executed.status, 'unknown');
  assert.equal(f.jobs.submissions.length, 1);
  assert.equal(f.billing.heldCents(), 700, '未知状态保留预占');
  let versions = await f.service.listVersions(f.deliverableId);
  assert.equal(versions.versions.length, 1, '未知状态不产生新版本');

  const jobId = f.jobs.submissions[0].id;
  assert.equal(executed.jobId, jobId);
  f.jobs.complete(jobId);
  const reconciled = await f.service.reconcile(estimated.request.id, {
    revision: executed.revision,
  });
  assert.equal(reconciled.request.status, 'succeeded');
  assert.equal(f.jobs.submissions.length, 1, '核实不得重新提交');
  versions = await f.service.listVersions(f.deliverableId);
  assert.equal(versions.versions.length, 2);
  assert.equal(f.audit.actions().includes('refine.unknown'), true);
  assert.equal(f.audit.actions().includes('refine.reconciled'), true);
});

// ---- 幂等与鉴权 / ETag ----

async function startServer(options) {
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    port: 0, root: new URL('../', import.meta.url), ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP：ETag 缺失 428 / 过期 409、重复确认幂等、角色鉴权与审计', async t => {
  const f = fixture();
  const users = {
    'viewer-token': { id: randomUUID(), role: 'viewer', active: true, workspaceId: 'local' },
    'operator-token': { id: randomUUID(), role: 'operator', active: true, workspaceId: 'local' },
  };
  const auth = {
    async authenticate(token) {
      return users[token] ? { session: { tokenHash: token }, user: users[token] } : null;
    },
  };
  const { server, base } = await startServer({ auth, refine: f.service });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const operatorCookie = { Cookie: 'sj_session=operator-token' };
  const viewerCookie = { Cookie: 'sj_session=viewer-token' };
  const operatorSession = await (await fetch(`${base}/api/session`, { headers: operatorCookie })).json();
  const viewerSession = await (await fetch(`${base}/api/session`, { headers: viewerCookie })).json();
  const headers = session => ({
    ...operatorCookie, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken,
  });

  const imported = await fetch(`${base}/api/deliverables/${f.deliverableId}/versions`, {
    method: 'POST',
    headers: headers(operatorSession),
    body: JSON.stringify({ jobId: f.jobId }),
  });
  assert.equal(imported.status, 201);
  assert.match(imported.headers.get('etag'), /^"r\d+"$/);

  const viewerEstimate = await fetch(`${base}/api/deliverables/${f.deliverableId}/refines/estimate`, {
    method: 'POST',
    headers: { ...viewerCookie, 'Content-Type': 'application/json', 'x-csrf-token': viewerSession.csrfToken },
    body: JSON.stringify({ path: 'template_reorder' }),
  });
  assert.equal(viewerEstimate.status, 403);

  const estimateResponse = await fetch(`${base}/api/deliverables/${f.deliverableId}/refines/estimate`, {
    method: 'POST',
    headers: headers(operatorSession),
    body: JSON.stringify({ path: 'template_reorder', params: { templateId: 'tmpl-http' } }),
  });
  assert.equal(estimateResponse.status, 200);
  const estimate = await estimateResponse.json();
  assert.equal(estimateResponse.headers.get('etag'), `"r${estimate.request.revision}"`);

  const confirmBody = { refineId: estimate.request.id, idempotencyKey: 'http-refine-1' };
  const missing = await fetch(`${base}/api/deliverables/${f.deliverableId}/refines`, {
    method: 'POST', headers: headers(operatorSession), body: JSON.stringify(confirmBody),
  });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).error.code, 'REVISION_REQUIRED');

  const stale = await fetch(`${base}/api/deliverables/${f.deliverableId}/refines`, {
    method: 'POST',
    headers: { ...headers(operatorSession), 'If-Match': '"r999"' },
    body: JSON.stringify(confirmBody),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');

  const confirmed = await fetch(`${base}/api/deliverables/${f.deliverableId}/refines`, {
    method: 'POST',
    headers: { ...headers(operatorSession), 'If-Match': `"r${estimate.request.revision}"` },
    body: JSON.stringify(confirmBody),
  });
  assert.equal(confirmed.status, 201);
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.request.status, 'succeeded');

  const repeated = await fetch(`${base}/api/deliverables/${f.deliverableId}/refines`, {
    method: 'POST',
    headers: { ...headers(operatorSession), 'If-Match': `"r${estimate.request.revision}"` },
    body: JSON.stringify(confirmBody),
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).created, false);
  assert.equal(f.jobs.submissions.length, 0);
  assert.equal(f.billing.entries.length, 0);

  const viewerVersions = await fetch(`${base}/api/deliverables/${f.deliverableId}/versions`, {
    headers: viewerCookie,
  });
  assert.equal(viewerVersions.status, 200);
  assert.match(viewerVersions.headers.get('etag'), /^"r\d+"$/);

  const viewerCandidate = await fetch(`${base}/api/deliverables/${f.deliverableId}/candidates`, {
    method: 'POST',
    headers: { ...viewerCookie, 'Content-Type': 'application/json', 'x-csrf-token': viewerSession.csrfToken },
    body: JSON.stringify({ versionId: confirmedBody.version.id, revision: 1 }),
  });
  assert.equal(viewerCandidate.status, 403);

  const versionList = await viewerVersions.json();
  const candidate = await fetch(`${base}/api/deliverables/${f.deliverableId}/candidates`, {
    method: 'POST',
    headers: { ...headers(operatorSession), 'If-Match': `"r${versionList.state.revision}"` },
    body: JSON.stringify({ versionId: confirmedBody.version.id }),
  });
  assert.equal(candidate.status, 200);
  assert.equal((await candidate.json()).state.candidateVersionId, confirmedBody.version.id);

  const anonymous = await fetch(`${base}/api/deliverables/${f.deliverableId}/versions`);
  assert.equal(anonymous.status, 401);

  const actions = f.audit.actions();
  for (const action of [
    'deliverable.version.imported', 'refine.estimated', 'refine.confirmed',
    'refine.completed', 'deliverable.candidate.selected',
  ]) {
    assert.equal(actions.includes(action), true, `缺少审计动作 ${action}`);
  }
  const confirmedAudit = f.audit.entries.find(entry => entry.action === 'refine.confirmed');
  assert.equal(Object.hasOwn(confirmedAudit.detail, 'prompt'), false);
});


test('相同成功任务重复导入保持版本与状态修订号；不重复审计或计费', async () => {
  const f = fixture();
  const first = await importSource(f);
  const again = await importSource(f);
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.version.id, first.version.id);
  assert.equal(again.state.revision, first.state.revision);
  assert.equal(again.versions.length, 1);
  assert.equal(again.state.candidateVersionId, null);
});

test('素材索引后补时，同一成功任务仍复用原交付版本', async () => {
  const f = fixture();
  f.repository.assets.delete(f.jobId);

  const first = await importSource(f);
  f.repository.addAsset(f.jobId, f.assetId);
  const again = await importSource(f);

  assert.equal(first.created, true);
  assert.equal(first.version.assetId, null);
  assert.equal(again.created, false);
  assert.equal(again.version.id, first.version.id);
  assert.equal(again.state.revision, first.state.revision);
  assert.equal(again.versions.length, 1);
});
