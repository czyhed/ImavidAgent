import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import { ReviewService } from '../server/review.mjs';

// 全部使用内存仓储与假审计：不连接 PostgreSQL / Redis / MinIO，不调用任何模型，
// 不产生付费任务。真实数据库约束在迁移验证脚本中另行检查。

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

class MemoryReviewRepository {
  versions = new Map();
  states = new Map();
  reviews = new Map();

  constructor({ projectId, deliverableId, planVersion = 1, planStatus = 'confirmed' }) {
    this.target = {
      workspaceId: 'local',
      projectId,
      planVersion,
      planStatus,
      deliverableId,
      title: '白底主图',
      type: 'white',
      jobId: null,
      status: 'planned',
    };
  }

  addVersion({ id = randomUUID(), version, status = 'candidate', isCandidate = false } = {}) {
    const row = {
      id,
      workspaceId: this.target.workspaceId,
      projectId: this.target.projectId,
      planVersion: this.target.planVersion,
      deliverableId: this.target.deliverableId,
      version,
      sourceVersionId: null,
      assetId: null,
      jobId: null,
      status,
      isCandidate,
      refinePath: null,
      requiresQc: false,
      content: { prompt: '燕麦色陶瓷杯' },
      cost: { currency: 'CNY', amountCents: 0 },
      createdBy: 'local',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.versions.set(row.id, row);
    return row;
  }

  setCandidate(versionId) {
    const state = this.#state(this.scope);
    for (const row of this.versions.values()) {
      if (row.isCandidate && row.id !== versionId) {
        row.status = 'superseded';
        row.isCandidate = false;
      }
    }
    const version = this.versions.get(versionId);
    version.status = 'candidate';
    version.isCandidate = true;
    state.candidateVersionId = versionId;
    state.currentStep = null;
    state.revision += 1;
    return clone(state);
  }

  get scope() {
    return {
      workspaceId: this.target.workspaceId,
      projectId: this.target.projectId,
      planVersion: this.target.planVersion,
      deliverableId: this.target.deliverableId,
    };
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

  async getVersion(workspaceId, versionId) {
    const row = this.versions.get(versionId);
    return row && row.workspaceId === workspaceId ? clone(row) : null;
  }

  async getReview(workspaceId, id) {
    const row = this.reviews.get(id);
    return row && (!workspaceId || row.workspaceId === workspaceId) ? clone(row) : null;
  }

  async listReviews(scope) {
    return [...this.reviews.values()]
      .filter(row => row.workspaceId === scope.workspaceId && row.projectId === scope.projectId
        && row.planVersion === scope.planVersion && row.deliverableId === scope.deliverableId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(clone);
  }

  async findOpenReview({ scope, versionId }) {
    const row = [...this.reviews.values()].find(item => item.workspaceId === scope.workspaceId
      && item.projectId === scope.projectId && item.planVersion === scope.planVersion
      && item.deliverableId === scope.deliverableId && item.versionId === versionId
      && item.status === 'in_review');
    return row ? clone(row) : null;
  }

  async createReview({ scope, expectedCandidateVersionId, row }) {
    const state = this.#state(scope);
    if (state.candidateVersionId !== expectedCandidateVersionId) {
      return { status: 'not_candidate', state: clone(state) };
    }
    const version = this.versions.get(row.versionId);
    if (!version) return { status: 'not_candidate', state: clone(state) };
    if (version.status === 'approved') {
      return { status: 'already_approved', version: clone(version), state: clone(state) };
    }
    if (version.status !== 'candidate' || state.candidateVersionId !== version.id) {
      return { status: 'not_candidate', state: clone(state) };
    }
    const existing = await this.findOpenReview({ scope, versionId: version.id });
    if (existing) return { status: 'existing', review: existing, state: clone(state) };
    const saved = { ...clone(row), revision: 1 };
    this.reviews.set(saved.id, saved);
    state.revision += 1;
    state.updatedAt = new Date();
    return {
      status: 'ok', review: clone(saved), version: clone(version), state: clone(state),
    };
  }

  async updateReview({ reviewId, expectedRevision, checks, notes, now }) {
    const current = this.reviews.get(reviewId);
    if (!current) return { status: 'missing' };
    if (current.revision !== expectedRevision) {
      return { status: 'conflict', review: clone(current) };
    }
    if (current.status !== 'in_review') return { status: 'not_editable', review: clone(current) };
    current.checks = clone(checks);
    current.notes = clone(notes);
    current.revision += 1;
    current.updatedAt = now;
    return { status: 'ok', review: clone(current) };
  }

  async approve({ reviewId, expectedRevision, now, actorId }) {
    const current = this.reviews.get(reviewId);
    if (!current) return { status: 'missing' };
    if (current.revision !== expectedRevision) {
      return { status: 'conflict', review: clone(current) };
    }
    if (current.status === 'approved') return { status: 'already_approved', review: clone(current) };
    if (current.status === 'revoked') return { status: 'revoked', review: clone(current) };
    if (!['fidelity', 'text', 'size', 'layout'].every(key => current.checks[key] === 'passed')) {
      return { status: 'checks_incomplete', review: clone(current) };
    }
    const scope = this.scope;
    const state = this.#state(scope);
    if (state.candidateVersionId !== current.versionId) {
      return { status: 'not_candidate', review: clone(current), state: clone(state) };
    }
    const other = [...this.reviews.values()].find(item => item.id !== reviewId
      && item.projectId === current.projectId && item.planVersion === current.planVersion
      && item.deliverableId === current.deliverableId && item.status === 'approved');
    if (other) return { status: 'already_approved', review: clone(current), state: clone(state) };
    const version = this.versions.get(current.versionId);
    if (!version) return { status: 'version_missing', review: clone(current), state: clone(state) };
    if (version.status === 'approved') {
      return { status: 'already_approved', review: clone(current), state: clone(state) };
    }
    if (version.status !== 'candidate') {
      return { status: 'not_candidate', review: clone(current), state: clone(state) };
    }
    version.status = 'approved';
    version.isCandidate = true;
    version.updatedAt = now;
    current.status = 'approved';
    current.reviewedBy = actorId;
    current.reviewedAt = now;
    current.revision += 1;
    current.updatedAt = now;
    state.revision += 1;
    state.updatedAt = now;
    return {
      status: 'ok',
      review: clone(current),
      version: clone(version),
      state: clone(state),
    };
  }

  async revoke({ reviewId, expectedRevision, reason, now, actorId }) {
    const current = this.reviews.get(reviewId);
    if (!current) return { status: 'missing' };
    if (current.revision !== expectedRevision) {
      return { status: 'conflict', review: clone(current) };
    }
    if (current.status !== 'approved') return { status: 'not_approved', review: clone(current) };
    const scope = this.scope;
    const state = this.#state(scope);
    const version = this.versions.get(current.versionId);
    if (!version) return { status: 'version_missing', review: clone(current), state: clone(state) };
    if (version.status !== 'approved') {
      return { status: 'not_approved', review: clone(current), state: clone(state) };
    }
    const candidateCleared = state.candidateVersionId === current.versionId;
    version.status = 'draft';
    version.isCandidate = false;
    version.updatedAt = now;
    current.status = 'revoked';
    current.revokeReason = reason;
    current.revokedBy = actorId;
    current.revokedAt = now;
    current.revision += 1;
    current.updatedAt = now;
    if (candidateCleared) state.candidateVersionId = null;
    state.reworkVersionId = current.versionId;
    state.reworkReason = reason;
    state.reworkAt = now;
    state.currentStep = 4;
    state.revision += 1;
    state.updatedAt = now;
    return {
      status: 'ok',
      review: clone(current),
      version: clone(version),
      state: clone(state),
      candidateCleared,
    };
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

function fixture({ planStatus = 'confirmed' } = {}) {
  const projectId = randomUUID();
  const deliverableId = randomUUID();
  const repository = new MemoryReviewRepository({ projectId, deliverableId, planStatus });
  const version = repository.addVersion({ version: 1, status: 'candidate', isCandidate: true });
  repository.setCandidate(version.id);
  const audit = new MemoryAudit();
  const service = new ReviewService(repository, {
    audit,
    now: () => new Date('2026-10-21T10:00:00.000Z'),
  });
  return {
    service, repository, audit, projectId, deliverableId, versionId: version.id,
  };
}

async function approveAll(f, checks = {}) {
  const started = await f.service.startReview(f.deliverableId, {});
  let review = started.review;
  review = (await f.service.updateChecks(review.id, {
    checks: { fidelity: 'passed', text: 'passed', size: 'passed', layout: 'passed', ...checks },
  }, { ifMatch: `r${review.revision}` })).review;
  const approved = await f.service.approve(review.id, {}, {
    ifMatch: `r${review.revision}`, actorId: 'operator-1',
  });
  return approved;
}

// ---- 未完成检查项不能通过 ----

test('未完成检查项不能通过：pending 与 issue 都被拒绝，记录保持待审核', async () => {
  const f = fixture();
  const started = await f.service.startReview(f.deliverableId, {});
  assert.equal(started.created, true);
  assert.equal(started.review.status, 'in_review');
  assert.deepEqual(
    Object.fromEntries(Object.entries(started.review.checks).map(([key, item]) => [key, item.result])),
    { fidelity: 'pending', text: 'pending', size: 'pending', layout: 'pending' },
  );
  assert.equal(started.review.allPassed, false);

  let review = (await f.service.updateChecks(started.review.id, {
    checks: { fidelity: 'passed', text: 'issue' },
  }, { ifMatch: 'r1' })).review;
  assert.deepEqual(review.unresolved, ['text', 'size', 'layout']);

  await assert.rejects(
    f.service.approve(review.id, {}, { ifMatch: `r${review.revision}` }),
    error => error instanceof AppError
      && error.code === 'REVIEW_CHECKS_INCOMPLETE' && error.status === 409,
  );
  const after = await f.service.getReview(review.id);
  assert.equal(after.review.status, 'in_review');
  assert.equal(after.review.reviewedBy, null);

  review = (await f.service.updateChecks(review.id, {
    checks: { fidelity: 'passed', text: 'issue', size: 'passed' },
  }, { ifMatch: `r${review.revision}` })).review;
  await assert.rejects(
    f.service.approve(review.id, {}, { ifMatch: `r${review.revision}` }),
    error => error.code === 'REVIEW_CHECKS_INCOMPLETE',
  );

  // 迁移里的数据库约束与触发器是同一门禁的兜底。
  const sql = await readFile(new URL('../server/migrations/0015-review.sql', import.meta.url), 'utf8');
  assert.match(sql, /sj_deliverable_reviews_approved_checks_complete/);
  assert.match(sql, /fidelity_result = 'passed' AND text_result = 'passed'/);
  assert.match(sql, /CREATE TRIGGER sj_deliverable_reviews_guard/);
});

// ---- 四项完成可通过，通过后冻结 ----

test('四项检查全部通过才可通过；通过后版本冻结为 approved，不能重复通过或重新发起审核', async () => {
  const f = fixture();
  const approved = await approveAll(f);
  assert.equal(approved.review.status, 'approved');
  assert.equal(approved.review.reviewedBy, 'operator-1');
  assert.equal(approved.review.reviewedAt.toISOString(), '2026-10-21T10:00:00.000Z');
  assert.equal(approved.review.allPassed, true);
  assert.equal(approved.version.status, 'approved');
  assert.equal(approved.version.isCandidate, true);
  assert.equal(approved.state.candidateVersionId, f.versionId, '冻结后仍是当前候选');
  assert.equal(f.audit.actions().includes('deliverable.review.approved'), true);

  await assert.rejects(
    f.service.approve(approved.review.id, {}, { ifMatch: `r${approved.review.revision}` }),
    error => error.code === 'REVIEW_ALREADY_APPROVED' && error.status === 409,
  );
  await assert.rejects(
    f.service.startReview(f.deliverableId, {}),
    error => error.code === 'VERSION_ALREADY_APPROVED' && error.status === 409,
  );

  const sql = await readFile(new URL('../server/migrations/0015-review.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TRIGGER sj_deliverable_versions_approved_guard/);
  assert.match(sql, /sj\.review\.revoke/);
});

// ---- 通过只能针对当前候选版本 ----

test('通过只能针对当前候选版本：审核发起后切换候选或指定非候选版本都被拒绝', async () => {
  const f = fixture();
  const second = f.repository.addVersion({ version: 2, status: 'draft' });
  await assert.rejects(
    f.service.startReview(f.deliverableId, { versionId: second.id }),
    error => error.code === 'REVIEW_NOT_CANDIDATE' && error.status === 409,
  );

  const started = await f.service.startReview(f.deliverableId, {});
  const review = (await f.service.updateChecks(started.review.id, {
    checks: { fidelity: 'passed', text: 'passed', size: 'passed', layout: 'passed' },
  }, { ifMatch: `r${started.review.revision}` })).review;
  f.repository.setCandidate(second.id);
  await assert.rejects(
    f.service.approve(review.id, {}, { ifMatch: `r${review.revision}` }),
    error => error.code === 'REVIEW_NOT_CANDIDATE' && error.status === 409,
  );
});

// ---- 撤销必须理由、回到 04、历史保留 ----

test('撤销必须填写理由：撤销后版本解除批准、候选清空、交付项回到第 04 步并保留历史', async () => {
  const f = fixture();
  const approved = await approveAll(f);

  await assert.rejects(
    f.service.revoke(approved.review.id, { reason: '   ' }, {
      ifMatch: `r${approved.review.revision}`,
    }),
    error => error.code === 'INVALID_FIELD' && error.status === 422,
  );

  const revoked = await f.service.revoke(approved.review.id, {
    reason: '主图文字与商品事实不符，需要重新排版',
  }, { ifMatch: `r${approved.review.revision}`, actorId: 'operator-2' });

  assert.equal(revoked.review.status, 'revoked');
  assert.equal(revoked.review.revocation.reason, '主图文字与商品事实不符，需要重新排版');
  assert.equal(revoked.review.revocation.by, 'operator-2');
  assert.equal(revoked.version.status, 'draft');
  assert.equal(revoked.version.isCandidate, false);
  assert.equal(revoked.state.candidateVersionId, null);
  assert.equal(revoked.state.rework.step, 4);
  assert.equal(revoked.state.rework.versionId, f.versionId);
  assert.equal(revoked.state.rework.reason, '主图文字与商品事实不符，需要重新排版');
  assert.equal(f.repository.reviews.size, 1, '撤销保留原审核记录');
  assert.equal(f.repository.versions.size, 1, '版本历史不删除');

  const revokedAudit = f.audit.entries.find(entry => entry.action === 'deliverable.review.revoked');
  assert.equal(revokedAudit.detail.reasonLength, 18);
  assert.equal(Object.hasOwn(revokedAudit.detail, 'reason'), false, '审计不落完整撤销理由');

  await assert.rejects(
    f.service.revoke(approved.review.id, { reason: '再次撤销' }, {
      ifMatch: `r${revoked.review.revision}`,
    }),
    error => error.code === 'REVIEW_NOT_APPROVED',
  );

  // 回到 04 后重新选定候选并重新审核：新增记录，旧记录保留。
  f.repository.setCandidate(f.versionId);
  const restarted = await f.service.startReview(f.deliverableId, {});
  assert.equal(restarted.created, true);
  assert.notEqual(restarted.review.id, approved.review.id);
  assert.equal(f.repository.reviews.size, 2);
});

// ---- HTTP：ETag / 角色 / 审计 ----

async function startServer(options) {
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    port: 0, root: new URL('../', import.meta.url), ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP：If-Match 缺失 428 / 过期 409、角色鉴权、重复通过与审计', async t => {
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
  const { server, base } = await startServer({ auth, review: f.service });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const operatorCookie = { Cookie: 'sj_session=operator-token' };
  const viewerCookie = { Cookie: 'sj_session=viewer-token' };
  const operatorSession = await (await fetch(`${base}/api/session`, { headers: operatorCookie })).json();
  const viewerSession = await (await fetch(`${base}/api/session`, { headers: viewerCookie })).json();
  const headers = (session, extra = {}) => ({
    ...operatorCookie,
    'Content-Type': 'application/json',
    'x-csrf-token': session.csrfToken,
    ...extra,
  });
  const viewerHeaders = extra => ({
    ...viewerCookie,
    'Content-Type': 'application/json',
    'x-csrf-token': viewerSession.csrfToken,
    ...extra,
  });

  const started = await fetch(`${base}/api/deliverables/${f.deliverableId}/reviews`, {
    method: 'POST', headers: headers(operatorSession), body: JSON.stringify({}),
  });
  assert.equal(started.status, 201);
  const startBody = await started.json();
  assert.equal(started.headers.get('etag'), `"r${startBody.review.revision}"`);

  const viewerList = await fetch(`${base}/api/deliverables/${f.deliverableId}/reviews`, {
    headers: viewerCookie,
  });
  assert.equal(viewerList.status, 200);
  assert.match(viewerList.headers.get('etag'), /^"r\d+"$/);

  const missing = await fetch(`${base}/api/reviews/${startBody.review.id}`, {
    method: 'PATCH',
    headers: headers(operatorSession),
    body: JSON.stringify({ checks: { fidelity: 'passed' } }),
  });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).error.code, 'REVISION_REQUIRED');

  const stale = await fetch(`${base}/api/reviews/${startBody.review.id}`, {
    method: 'PATCH',
    headers: headers(operatorSession, { 'If-Match': '"r999"' }),
    body: JSON.stringify({ checks: { fidelity: 'passed' } }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');

  const viewerPatch = await fetch(`${base}/api/reviews/${startBody.review.id}`, {
    method: 'PATCH',
    headers: viewerHeaders({ 'If-Match': '"r1"' }),
    body: JSON.stringify({ checks: { fidelity: 'passed' } }),
  });
  assert.equal(viewerPatch.status, 403);

  const patched = await fetch(`${base}/api/reviews/${startBody.review.id}`, {
    method: 'PATCH',
    headers: headers(operatorSession, { 'If-Match': `"r${startBody.review.revision}"` }),
    body: JSON.stringify({
      checks: { fidelity: 'passed', text: 'passed', size: 'passed', layout: 'passed' },
    }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.equal(patched.headers.get('etag'), `"r${patchedBody.review.revision}"`);

  const approveMissing = await fetch(`${base}/api/reviews/${startBody.review.id}/approve`, {
    method: 'POST', headers: headers(operatorSession), body: JSON.stringify({}),
  });
  assert.equal(approveMissing.status, 428);

  const approved = await fetch(`${base}/api/reviews/${startBody.review.id}/approve`, {
    method: 'POST',
    headers: headers(operatorSession, { 'If-Match': `"r${patchedBody.review.revision}"` }),
    body: JSON.stringify({}),
  });
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json();
  assert.equal(approvedBody.version.status, 'approved');

  const duplicate = await fetch(`${base}/api/reviews/${startBody.review.id}/approve`, {
    method: 'POST',
    headers: headers(operatorSession, { 'If-Match': `"r${approvedBody.review.revision}"` }),
    body: JSON.stringify({}),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'REVIEW_ALREADY_APPROVED');

  const viewerRevoke = await fetch(`${base}/api/reviews/${startBody.review.id}/revoke`, {
    method: 'POST',
    headers: viewerHeaders({ 'If-Match': `"r${approvedBody.review.revision}"` }),
    body: JSON.stringify({ reason: 'viewer 不能撤销' }),
  });
  assert.equal(viewerRevoke.status, 403);

  const noReason = await fetch(`${base}/api/reviews/${startBody.review.id}/revoke`, {
    method: 'POST',
    headers: headers(operatorSession, { 'If-Match': `"r${approvedBody.review.revision}"` }),
    body: JSON.stringify({}),
  });
  assert.equal(noReason.status, 422);

  const revoked = await fetch(`${base}/api/reviews/${startBody.review.id}/revoke`, {
    method: 'POST',
    headers: headers(operatorSession, { 'If-Match': `"r${approvedBody.review.revision}"` }),
    body: JSON.stringify({ reason: '审核后发现文字错误，退回精修' }),
  });
  assert.equal(revoked.status, 200);
  const revokedBody = await revoked.json();
  assert.equal(revokedBody.review.status, 'revoked');
  assert.equal(revokedBody.state.rework.step, 4);

  const detail = await fetch(`${base}/api/reviews/${startBody.review.id}`, { headers: viewerCookie });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).review.status, 'revoked');

  const anonymous = await fetch(`${base}/api/deliverables/${f.deliverableId}/reviews`);
  assert.equal(anonymous.status, 401);

  const actions = f.audit.actions();
  for (const action of [
    'deliverable.review.started',
    'deliverable.review.updated',
    'deliverable.review.approved',
    'deliverable.review.revoked',
  ]) {
    assert.equal(actions.includes(action), true, `缺少审计动作 ${action}`);
  }
  const approvedAudit = f.audit.entries.find(entry => entry.action === 'deliverable.review.approved');
  assert.equal(Object.hasOwn(approvedAudit.detail, 'prompt'), false);
  assert.equal(approvedAudit.detail.allPassed, true);
});
