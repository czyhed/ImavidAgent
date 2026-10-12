import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { publicDeliverableState, publicVersion } from './refine.mjs';

// 质检审核、撤销与冻结版本（Issue #17 / FLOW-10、ACC-10）。
//
// 规则：
//   - 审核只针对「当前交付候选版本」；候选由 #16 的显式选定产生。
//   - 四个检查项：商品保真（fidelity）/ 文字（text）/ 尺寸（size）/ 排版（layout），
//     逐项结果为 pending / passed / issue。四项全部 passed 才能通过；服务层先校验，
//     数据库 CHECK 与触发器再做兜底。
//   - 通过写入审核人、时间与 revision，并把版本状态置为 approved。之后版本内容与状态
//     冻结：不能再改检查项、不能换候选，必须先撤销。
//   - 撤销必须填写理由；解除批准（版本回到 draft、清空当前候选），交付项回到第 04 步，
//     复用 sj_deliverable_states 的返修字段记录理由与时间，历史审核记录保留。
//   - 审核记录只追加：已通过只能撤销，已撤销为终态，不能删除。

export const REVIEW_CHECKS = Object.freeze({
  fidelity: Object.freeze({ key: 'fidelity', label: '商品保真', column: 'fidelity_result' }),
  text: Object.freeze({ key: 'text', label: '文字', column: 'text_result' }),
  size: Object.freeze({ key: 'size', label: '尺寸', column: 'size_result' }),
  layout: Object.freeze({ key: 'layout', label: '排版', column: 'layout_result' }),
});
export const REVIEW_CHECK_KEYS = Object.freeze(Object.keys(REVIEW_CHECKS));
export const CHECK_RESULTS = Object.freeze(['pending', 'passed', 'issue']);
export const REVIEW_STATUSES = Object.freeze(['in_review', 'approved', 'revoked']);
export const REVIEW_STATUS_LABELS = Object.freeze({
  in_review: '待审核',
  approved: '已通过',
  revoked: '已撤销',
});
export const REVIEW_STEP = 4;

const START_FIELDS = ['projectId', 'planVersion', 'versionId', 'checks', 'notes'];
const UPDATE_FIELDS = ['checks', 'notes', 'revision'];
const APPROVE_FIELDS = ['revision'];
const REVOKE_FIELDS = ['reason', 'revision'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function integerField(value, label, { min = 1, max = 2_147_483_647, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('INVALID_FIELD', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return number;
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

function parseRevisionValue(value) {
  const number = typeof value === 'string' && /^r?\d+$/i.test(value.trim())
    ? Number(value.trim().replace(/^r/i, '')) : value;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    fail('INVALID_REVISION', '修订号必须是正整数。');
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
    fail('REVISION_REQUIRED', '写操作需提供 If-Match 响应头或请求体中的 revision。', 428);
  }
  return value;
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function allPassed(checks) {
  return REVIEW_CHECK_KEYS.every(key => checks?.[key] === 'passed');
}

function checksFromRow(row) {
  return Object.fromEntries(REVIEW_CHECK_KEYS.map(key => [key, row[REVIEW_CHECKS[key].column]]));
}

function reviewFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planVersion: row.plan_version,
    deliverableId: row.deliverable_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    status: row.status,
    checks: checksFromRow(row),
    notes: row.notes && typeof row.notes === 'object' ? row.notes : {},
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    revokeReason: row.revoke_reason,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planVersion: row.plan_version,
    deliverableId: row.deliverable_id,
    version: row.version,
    sourceVersionId: row.source_version_id,
    assetId: row.asset_id,
    jobId: row.job_id,
    status: row.status,
    isCandidate: row.is_candidate,
    refinePath: row.refine_path,
    requiresQc: row.requires_qc,
    content: row.content && typeof row.content === 'object' ? row.content : {},
    cost: row.cost && typeof row.cost === 'object' ? row.cost : {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stateFromRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    planVersion: row.plan_version,
    deliverableId: row.deliverable_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    candidateVersionId: row.current_candidate_version_id,
    reworkVersionId: row.rework_version_id,
    reworkReason: row.rework_reason,
    reworkAt: row.rework_at,
    currentStep: row.current_step,
    updatedAt: row.updated_at,
  };
}

export function publicReview(row) {
  if (!row) return null;
  const checks = {};
  for (const key of REVIEW_CHECK_KEYS) {
    checks[key] = {
      key,
      label: REVIEW_CHECKS[key].label,
      result: row.checks?.[key] ?? 'pending',
    };
  }
  const unresolved = REVIEW_CHECK_KEYS.filter(key => checks[key].result !== 'passed');
  const revoked = row.status === 'revoked' || Boolean(row.revokeReason);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planVersion: row.planVersion,
    deliverableId: row.deliverableId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    status: row.status,
    statusLabel: REVIEW_STATUS_LABELS[row.status] ?? row.status,
    checks,
    allPassed: allPassed(row.checks),
    unresolved,
    notes: clone(row.notes || {}),
    reviewedBy: row.reviewedBy ?? null,
    reviewedAt: row.reviewedAt ?? null,
    revocation: revoked ? {
      reason: row.revokeReason ?? null,
      by: row.revokedBy ?? null,
      at: row.revokedAt ?? null,
    } : null,
    revision: row.revision,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeChecks(raw, { partial = false } = {}) {
  if (raw === undefined || raw === null) {
    if (partial) fail('INVALID_CHECKS', '请至少提供一个检查项结果。');
    return Object.fromEntries(REVIEW_CHECK_KEYS.map(key => [key, 'pending']));
  }
  requireObject(raw, '检查项');
  rejectUnknown(raw, REVIEW_CHECK_KEYS, '检查项');
  const keys = Object.keys(raw);
  if (partial && !keys.length) fail('INVALID_CHECKS', '请至少提供一个检查项结果。');
  const checks = partial ? {} : Object.fromEntries(REVIEW_CHECK_KEYS.map(key => [key, 'pending']));
  for (const [key, value] of Object.entries(raw)) {
    if (!CHECK_RESULTS.includes(value)) {
      fail('INVALID_CHECK_RESULT', `检查项 ${key} 只能是 ${CHECK_RESULTS.join(' / ')}。`);
    }
    checks[key] = value;
  }
  return checks;
}

function normalizeNotes(raw, base = {}) {
  if (raw === undefined) return clone(base || {});
  if (raw === null) return {};
  requireObject(raw, '审核备注');
  rejectUnknown(raw, REVIEW_CHECK_KEYS, '审核备注');
  const notes = clone(base || {});
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === '') {
      delete notes[key];
      continue;
    }
    notes[key] = textField(value, `检查项 ${key} 备注`, 500);
  }
  return notes;
}

export class ReviewService {
  constructor(repository, {
    audit = null,
    now = () => new Date(),
    idFactory = randomUUID,
  } = {}) {
    if (!repository) throw new AppError('REVIEW_STORE_UNAVAILABLE', '审核存储未配置。', 500);
    this.repository = repository;
    this.audit = audit;
    this.now = now;
    this.idFactory = idFactory;
  }

  async #record(action, {
    targetType = 'deliverable', targetId, result = 'success', detail = {}, context = {},
  }) {
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

  #workspace(workspaceId) {
    return workspaceId || 'local';
  }

  #scope(target) {
    return {
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      planVersion: target.planVersion,
      deliverableId: target.deliverableId,
    };
  }

  async #deliverable(deliverableId, body, workspaceId) {
    const id = uuidField(deliverableId, '交付项编号');
    const projectId = uuidField(body?.projectId, '项目编号', { required: false });
    const planVersion = integerField(body?.planVersion, '方案版本', { required: false });
    const target = await this.repository.getDeliverable({
      workspaceId: this.#workspace(workspaceId),
      deliverableId: id,
      projectId,
      planVersion,
    });
    if (!target) throw new AppError('DELIVERABLE_NOT_FOUND', '交付项不存在。', 404);
    return target;
  }

  #assertConfirmed(target) {
    if (target.planStatus !== 'confirmed') {
      throw new AppError('PLAN_NOT_CONFIRMED', '确认方案后才能审核交付项。', 409);
    }
  }

  async #version(target, versionId) {
    const id = uuidField(versionId, '版本编号');
    const version = await this.repository.getVersion(target.workspaceId, id);
    if (!version || version.deliverableId !== target.deliverableId
      || version.projectId !== target.projectId || version.planVersion !== target.planVersion) {
      throw new AppError('VERSION_NOT_FOUND', '版本不属于该交付项。', 404);
    }
    return version;
  }

  async #state(target) {
    const state = await this.repository.getState(this.#scope(target));
    return state || {
      projectId: target.projectId,
      planVersion: target.planVersion,
      deliverableId: target.deliverableId,
      workspaceId: target.workspaceId,
      revision: 1,
      candidateVersionId: null,
      reworkVersionId: null,
      reworkReason: null,
      reworkAt: null,
      currentStep: null,
      updatedAt: null,
    };
  }

  async #review(reviewId, workspaceId) {
    const id = uuidField(reviewId, '审核记录编号');
    const review = await this.repository.getReview(this.#workspace(workspaceId), id);
    if (!review) throw new AppError('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
    return review;
  }

  // ---- 发起审核：只针对当前候选版本；重复发起返回原记录 ----

  async startReview(deliverableId, body = {}, { workspaceId = null, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, START_FIELDS, '发起审核');
    const target = await this.#deliverable(deliverableId, body, workspaceId);
    this.#assertConfirmed(target);
    const state = await this.#state(target);
    const candidateVersionId = state.candidateVersionId ?? null;
    if (!candidateVersionId) {
      throw new AppError('REVIEW_NO_CANDIDATE', '请先显式选定交付候选，再发起审核。', 409);
    }
    const requestedVersionId = uuidField(body.versionId, '版本编号', { required: false });
    const versionId = requestedVersionId || candidateVersionId;
    if (versionId !== candidateVersionId) {
      throw new AppError('REVIEW_NOT_CANDIDATE', '审核只能针对当前交付候选版本。', 409);
    }
    const version = await this.#version(target, versionId);
    if (version.status === 'approved') {
      throw new AppError('VERSION_ALREADY_APPROVED', '该候选版本已通过审核，请先撤销后再重新审核。', 409);
    }
    if (version.status !== 'candidate') {
      throw new AppError('REVIEW_NOT_CANDIDATE', '审核只能针对当前交付候选版本。', 409);
    }
    const existing = await this.repository.findOpenReview({ scope: this.#scope(target), versionId });
    if (existing) {
      return {
        review: publicReview(existing),
        state: publicDeliverableState(state),
        created: false,
      };
    }
    const now = this.now();
    const row = {
      id: this.idFactory(),
      ...this.#scope(target),
      versionId,
      versionNumber: version.version,
      status: 'in_review',
      checks: normalizeChecks(body.checks),
      notes: normalizeNotes(body.notes),
      reviewedBy: null,
      reviewedAt: null,
      revokeReason: null,
      revokedBy: null,
      revokedAt: null,
      revision: 1,
      createdBy: actorId || 'local',
      createdAt: now,
      updatedAt: now,
    };
    const outcome = await this.repository.createReview({
      scope: this.#scope(target),
      expectedCandidateVersionId: candidateVersionId,
      row,
    });
    if (outcome.status === 'not_candidate') {
      throw new AppError('REVIEW_NOT_CANDIDATE', '审核只能针对当前交付候选版本。', 409);
    }
    if (outcome.status === 'already_approved') {
      throw new AppError('VERSION_ALREADY_APPROVED', '该候选版本已通过审核，请先撤销后再重新审核。', 409);
    }
    if (outcome.status === 'existing') {
      return {
        review: publicReview(outcome.review),
        state: publicDeliverableState(outcome.state || state),
        created: false,
      };
    }
    const review = outcome.review;
    await this.#record('deliverable.review.started', {
      targetId: target.deliverableId,
      detail: {
        projectId: target.projectId,
        planVersion: target.planVersion,
        reviewId: review.id,
        versionId: review.versionId,
        versionNumber: review.versionNumber,
        checks: review.checks,
        status: review.status,
      },
      context,
    });
    return {
      review: publicReview(review),
      state: publicDeliverableState(outcome.state || await this.#state(target)),
      created: true,
    };
  }

  async listReviews(deliverableId, { workspaceId = null, projectId = null, planVersion = null } = {}) {
    const target = await this.#deliverable(deliverableId, { projectId, planVersion }, workspaceId);
    const [reviews, state] = await Promise.all([
      this.repository.listReviews(this.#scope(target)),
      this.#state(target),
    ]);
    return {
      deliverable: { ...this.#scope(target), planStatus: target.planStatus },
      reviews: reviews.map(publicReview),
      state: publicDeliverableState(state),
    };
  }

  async getReview(reviewId, { workspaceId = null } = {}) {
    const review = await this.#review(reviewId, workspaceId);
    return { review: publicReview(review) };
  }

  // ---- 逐项更新检查结果；只有待审核记录可编辑 ----

  async updateChecks(reviewId, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, UPDATE_FIELDS, '更新审核');
    const review = await this.#review(reviewId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    if (review.status !== 'in_review') {
      throw new AppError('REVIEW_NOT_EDITABLE', '只有待审核记录可以更新检查项。', 409);
    }
    const providedChecks = body.checks === undefined
      ? null : normalizeChecks(body.checks, { partial: true });
    const providedNotes = body.notes === undefined ? null : normalizeNotes(body.notes, review.notes);
    if (!providedChecks && !providedNotes) {
      fail('INVALID_BODY', '请至少更新一个检查项或备注。');
    }
    const checks = providedChecks ? { ...review.checks, ...providedChecks } : review.checks;
    const notes = providedNotes ?? review.notes;
    const outcome = await this.repository.updateReview({
      reviewId: review.id,
      expectedRevision: expected,
      checks,
      notes,
      now: this.now(),
    });
    if (outcome.status === 'missing') {
      throw new AppError('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
    }
    if (outcome.status === 'conflict') {
      fail('REVISION_CONFLICT', '审核记录已被其他操作更新，请刷新后重试。', 409);
    }
    if (outcome.status === 'not_editable') {
      throw new AppError('REVIEW_NOT_EDITABLE', '只有待审核记录可以更新检查项。', 409);
    }
    await this.#record('deliverable.review.updated', {
      targetId: review.deliverableId,
      detail: {
        reviewId: outcome.review.id,
        versionId: outcome.review.versionId,
        checks: outcome.review.checks,
        status: outcome.review.status,
      },
      context,
    });
    return {
      review: publicReview(outcome.review),
      changedBy: actorId || 'local',
    };
  }

  // ---- 通过：四项全部完成且版本仍是当前候选；通过后冻结版本 ----

  async approve(reviewId, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, APPROVE_FIELDS, '审核通过');
    const review = await this.#review(reviewId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    if (review.status === 'approved') {
      throw new AppError('REVIEW_ALREADY_APPROVED', '该审核已通过，不能重复通过。', 409);
    }
    if (review.status === 'revoked') {
      throw new AppError('REVIEW_REVOKED', '已撤销的审核不能再次通过，请重新发起审核。', 409);
    }
    if (!allPassed(review.checks)) {
      throw new AppError(
        'REVIEW_CHECKS_INCOMPLETE',
        '仍有未完成或存在问题的检查项，不能通过审核。',
        409,
      );
    }
    const outcome = await this.repository.approve({
      reviewId: review.id,
      expectedRevision: expected,
      now: this.now(),
      actorId: actorId || 'local',
    });
    if (outcome.status === 'missing') {
      throw new AppError('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
    }
    if (outcome.status === 'conflict') {
      fail('REVISION_CONFLICT', '审核记录已被其他操作更新，请刷新后重试。', 409);
    }
    if (outcome.status === 'already_approved') {
      throw new AppError('REVIEW_ALREADY_APPROVED', '该审核已通过，不能重复通过。', 409);
    }
    if (outcome.status === 'revoked') {
      throw new AppError('REVIEW_REVOKED', '已撤销的审核不能再次通过，请重新发起审核。', 409);
    }
    if (outcome.status === 'checks_incomplete') {
      throw new AppError(
        'REVIEW_CHECKS_INCOMPLETE',
        '仍有未完成或存在问题的检查项，不能通过审核。',
        409,
      );
    }
    if (outcome.status === 'not_candidate' || outcome.status === 'version_missing') {
      throw new AppError(
        'REVIEW_NOT_CANDIDATE',
        '审核只能针对当前交付候选版本；候选可能已被切换或撤销。',
        409,
      );
    }
    await this.#record('deliverable.review.approved', {
      targetId: outcome.review.deliverableId,
      detail: {
        reviewId: outcome.review.id,
        versionId: outcome.review.versionId,
        versionNumber: outcome.review.versionNumber,
        checks: outcome.review.checks,
        allPassed: true,
        reviewedBy: outcome.review.reviewedBy,
        frozenStatus: outcome.version?.status ?? 'approved',
      },
      context,
    });
    return {
      review: publicReview(outcome.review),
      version: publicVersion(outcome.version),
      state: publicDeliverableState(outcome.state),
    };
  }

  // ---- 撤销：必须理由；解除批准、回到第 04 步，保留全部历史 ----

  async revoke(reviewId, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, REVOKE_FIELDS, '撤销审核');
    const review = await this.#review(reviewId, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    const reason = textField(body.reason, '撤销理由', 500, { required: true });
    if (review.status !== 'approved') {
      throw new AppError('REVIEW_NOT_APPROVED', '只有已通过的审核可以撤销。', 409);
    }
    const outcome = await this.repository.revoke({
      reviewId: review.id,
      expectedRevision: expected,
      reason,
      now: this.now(),
      actorId: actorId || 'local',
    });
    if (outcome.status === 'missing') {
      throw new AppError('REVIEW_NOT_FOUND', '审核记录不存在。', 404);
    }
    if (outcome.status === 'conflict') {
      fail('REVISION_CONFLICT', '审核记录已被其他操作更新，请刷新后重试。', 409);
    }
    if (outcome.status === 'not_approved') {
      throw new AppError('REVIEW_NOT_APPROVED', '只有已通过的审核可以撤销。', 409);
    }
    if (outcome.status === 'version_missing') {
      throw new AppError('VERSION_NOT_FOUND', '审核关联的版本不存在。', 404);
    }
    await this.#record('deliverable.review.revoked', {
      targetId: outcome.review.deliverableId,
      detail: {
        reviewId: outcome.review.id,
        versionId: outcome.review.versionId,
        versionNumber: outcome.review.versionNumber,
        checks: outcome.review.checks,
        reasonLength: reason.length,
        currentStep: REVIEW_STEP,
        candidateCleared: outcome.candidateCleared === true,
        versionStatus: outcome.version?.status ?? 'draft',
      },
      context,
    });
    return {
      review: publicReview(outcome.review),
      version: publicVersion(outcome.version),
      state: publicDeliverableState(outcome.state),
    };
  }
}

// ---- PostgreSQL 仓储 ----

const INSERT_REVIEW = `
  INSERT INTO sj_deliverable_reviews (
    id, workspace_id, project_id, plan_version, deliverable_id, version_id,
    version_number, status, fidelity_result, text_result, size_result, layout_result,
    notes, reviewed_by, reviewed_at, revoke_reason, revoked_by, revoked_at,
    revision, created_by, created_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22
  ) RETURNING *`;

function reviewParams(row) {
  return [
    row.id, row.workspaceId, row.projectId, row.planVersion, row.deliverableId, row.versionId,
    row.versionNumber, row.status, row.checks.fidelity, row.checks.text, row.checks.size,
    row.checks.layout, JSON.stringify(row.notes || {}), row.reviewedBy ?? null,
    row.reviewedAt ?? null, row.revokeReason ?? null, row.revokedBy ?? null,
    row.revokedAt ?? null, row.revision ?? 1, row.createdBy ?? null,
    row.createdAt ?? new Date(), row.updatedAt ?? new Date(),
  ];
}

const INSERT_STATE = `
  INSERT INTO sj_deliverable_states (
    project_id, plan_version, deliverable_id, workspace_id, revision, updated_at
  ) VALUES ($1,$2,$3,$4,1,now())
  ON CONFLICT (project_id, plan_version, deliverable_id) DO NOTHING`;

async function lockState(client, scope) {
  await client.query(INSERT_STATE, [
    scope.projectId, scope.planVersion, scope.deliverableId, scope.workspaceId,
  ]);
  return stateFromRow((await client.query(
    `SELECT * FROM sj_deliverable_states
     WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 FOR UPDATE`,
    [scope.projectId, scope.planVersion, scope.deliverableId],
  )).rows[0]);
}

export class PgReviewRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async #withTransaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getDeliverable({ workspaceId, deliverableId, projectId = null, planVersion = null }) {
    const row = (await this.pool.query(
      `SELECT p.id AS project_id, p.workspace_id, pl.version AS plan_version,
              pl.status AS plan_status, d.item AS deliverable
       FROM sj_projects p
       JOIN LATERAL (
         SELECT version, status, deliverables FROM sj_project_plans
         WHERE project_id = p.id
           AND ($3::uuid IS NULL OR project_id = $3)
           AND ($4::integer IS NULL OR version = $4)
         ORDER BY version DESC LIMIT 1
       ) pl ON true
       CROSS JOIN LATERAL jsonb_array_elements(pl.deliverables) d(item)
       WHERE p.workspace_id = $1
         AND ($3::uuid IS NULL OR p.id = $3)
         AND d.item->>'id' = $2
       ORDER BY p.updated_at DESC
       LIMIT 1`,
      [workspaceId, deliverableId, projectId, planVersion],
    )).rows[0];
    if (!row) return null;
    const deliverable = isObject(row.deliverable) ? row.deliverable : {};
    return {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      planVersion: row.plan_version,
      planStatus: row.plan_status,
      deliverableId,
      title: deliverable.title ?? null,
      type: deliverable.type ?? null,
      jobId: deliverable.jobId ?? null,
      status: deliverable.status ?? null,
    };
  }

  async getState(scope) {
    return stateFromRow((await this.pool.query(
      `SELECT * FROM sj_deliverable_states
       WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3`,
      [scope.projectId, scope.planVersion, scope.deliverableId],
    )).rows[0]);
  }

  async getVersion(workspaceId, versionId) {
    return versionFromRow((await this.pool.query(
      'SELECT * FROM sj_deliverable_versions WHERE id=$1 AND workspace_id=$2',
      [versionId, workspaceId],
    )).rows[0]);
  }

  async getReview(workspaceId, id) {
    return reviewFromRow((await this.pool.query(
      `SELECT * FROM sj_deliverable_reviews
       WHERE id=$1 AND ($2::text IS NULL OR workspace_id=$2)`,
      [id, workspaceId],
    )).rows[0]);
  }

  async listReviews(scope) {
    return (await this.pool.query(
      `SELECT * FROM sj_deliverable_reviews
       WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
       ORDER BY created_at DESC, id DESC`,
      [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId],
    )).rows.map(reviewFromRow);
  }

  async findOpenReview({ scope, versionId }) {
    return reviewFromRow((await this.pool.query(
      `SELECT * FROM sj_deliverable_reviews
       WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
         AND version_id=$5 AND status='in_review'
       ORDER BY created_at DESC LIMIT 1`,
      [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId, versionId],
    )).rows[0]);
  }

  async #scopedVersion(client, scope, versionId) {
    const row = (await client.query(
      'SELECT * FROM sj_deliverable_versions WHERE id=$1 FOR UPDATE', [versionId],
    )).rows[0];
    if (!row) return null;
    const version = versionFromRow(row);
    if (version.workspaceId !== scope.workspaceId || version.projectId !== scope.projectId
      || version.planVersion !== scope.planVersion
      || version.deliverableId !== scope.deliverableId) return null;
    return version;
  }

  async createReview({ scope, expectedCandidateVersionId, row }) {
    return this.#withTransaction(async client => {
      const state = await lockState(client, scope);
      if (state.candidateVersionId !== expectedCandidateVersionId) {
        return { status: 'not_candidate', state };
      }
      const version = await this.#scopedVersion(client, scope, row.versionId);
      if (!version) return { status: 'not_candidate', state };
      if (version.status === 'approved') {
        return { status: 'already_approved', version, state };
      }
      if (version.status !== 'candidate' || state.candidateVersionId !== version.id) {
        return { status: 'not_candidate', state };
      }
      const existing = reviewFromRow((await client.query(
        `SELECT * FROM sj_deliverable_reviews
         WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
           AND version_id=$5 AND status='in_review'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId, version.id],
      )).rows[0]);
      if (existing) return { status: 'existing', review: existing, state };
      const inserted = reviewFromRow((await client.query(INSERT_REVIEW, reviewParams(row))).rows[0]);
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states SET revision=revision+1, updated_at=now()
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId],
      )).rows[0]);
      return { status: 'ok', review: inserted, version, state: updatedState };
    });
  }

  async updateReview({ reviewId, expectedRevision, checks, notes, now }) {
    return this.#withTransaction(async client => {
      const current = reviewFromRow((await client.query(
        'SELECT * FROM sj_deliverable_reviews WHERE id=$1 FOR UPDATE', [reviewId],
      )).rows[0]);
      if (!current) return { status: 'missing' };
      if (current.revision !== expectedRevision) return { status: 'conflict', review: current };
      if (current.status !== 'in_review') return { status: 'not_editable', review: current };
      const updated = reviewFromRow((await client.query(
        `UPDATE sj_deliverable_reviews
         SET fidelity_result=$2, text_result=$3, size_result=$4, layout_result=$5,
             notes=$6::jsonb, revision=revision+1, updated_at=$7
         WHERE id=$1 RETURNING *`,
        [
          reviewId, checks.fidelity, checks.text, checks.size, checks.layout,
          JSON.stringify(notes || {}), now,
        ],
      )).rows[0]);
      return { status: 'ok', review: updated };
    });
  }

  async approve({ reviewId, expectedRevision, now, actorId }) {
    return this.#withTransaction(async client => {
      const current = reviewFromRow((await client.query(
        'SELECT * FROM sj_deliverable_reviews WHERE id=$1 FOR UPDATE', [reviewId],
      )).rows[0]);
      if (!current) return { status: 'missing' };
      if (current.revision !== expectedRevision) return { status: 'conflict', review: current };
      if (current.status === 'approved') return { status: 'already_approved', review: current };
      if (current.status === 'revoked') return { status: 'revoked', review: current };
      if (!allPassed(current.checks)) return { status: 'checks_incomplete', review: current };
      const scope = {
        workspaceId: current.workspaceId,
        projectId: current.projectId,
        planVersion: current.planVersion,
        deliverableId: current.deliverableId,
      };
      const state = await lockState(client, scope);
      if (state.candidateVersionId !== current.versionId) {
        return { status: 'not_candidate', review: current, state };
      }
      const other = (await client.query(
        `SELECT id FROM sj_deliverable_reviews
         WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
           AND status='approved' AND id<>$5 LIMIT 1`,
        [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId, reviewId],
      )).rows[0];
      if (other) return { status: 'already_approved', review: current, state };
      const version = await this.#scopedVersion(client, scope, current.versionId);
      if (!version) return { status: 'version_missing', review: current, state };
      if (version.status === 'approved') {
        return { status: 'already_approved', review: current, state };
      }
      if (version.status !== 'candidate') {
        return { status: 'not_candidate', review: current, state };
      }
      const updatedVersion = versionFromRow((await client.query(
        `UPDATE sj_deliverable_versions
         SET status='approved', is_candidate=true, updated_at=$2
         WHERE id=$1 RETURNING *`,
        [current.versionId, now],
      )).rows[0]);
      const updatedReview = reviewFromRow((await client.query(
        `UPDATE sj_deliverable_reviews
         SET status='approved', reviewed_by=$2, reviewed_at=$3,
             revision=revision+1, updated_at=$3
         WHERE id=$1 RETURNING *`,
        [reviewId, actorId, now],
      )).rows[0]);
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states SET revision=revision+1, updated_at=$4
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId, now],
      )).rows[0]);
      return {
        status: 'ok',
        review: updatedReview,
        version: updatedVersion,
        state: updatedState,
      };
    });
  }

  async revoke({ reviewId, expectedRevision, reason, now, actorId }) {
    return this.#withTransaction(async client => {
      const current = reviewFromRow((await client.query(
        'SELECT * FROM sj_deliverable_reviews WHERE id=$1 FOR UPDATE', [reviewId],
      )).rows[0]);
      if (!current) return { status: 'missing' };
      if (current.revision !== expectedRevision) return { status: 'conflict', review: current };
      if (current.status !== 'approved') return { status: 'not_approved', review: current };
      const scope = {
        workspaceId: current.workspaceId,
        projectId: current.projectId,
        planVersion: current.planVersion,
        deliverableId: current.deliverableId,
      };
      const state = await lockState(client, scope);
      const version = await this.#scopedVersion(client, scope, current.versionId);
      if (!version) return { status: 'version_missing', review: current, state };
      if (version.status !== 'approved') return { status: 'not_approved', review: current, state };
      // 事务内显式放行：版本触发器只会在该设置下允许 approved -> draft。
      await client.query(`SELECT set_config('sj.review.revoke', 'on', true)`);
      const updatedVersion = versionFromRow((await client.query(
        `UPDATE sj_deliverable_versions
         SET status='draft', is_candidate=false, updated_at=$2
         WHERE id=$1 RETURNING *`,
        [current.versionId, now],
      )).rows[0]);
      const updatedReview = reviewFromRow((await client.query(
        `UPDATE sj_deliverable_reviews
         SET status='revoked', revoke_reason=$2, revoked_by=$3, revoked_at=$4,
             revision=revision+1, updated_at=$4
         WHERE id=$1 RETURNING *`,
        [reviewId, reason, actorId, now],
      )).rows[0]);
      const candidateCleared = state.candidateVersionId === current.versionId;
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states
         SET current_candidate_version_id = CASE WHEN current_candidate_version_id=$4 THEN NULL
                                                 ELSE current_candidate_version_id END,
             rework_version_id=$4, rework_reason=$5, rework_at=$6, current_step=4,
             revision=revision+1, updated_at=$6
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId, current.versionId, reason, now],
      )).rows[0]);
      return {
        status: 'ok',
        review: updatedReview,
        version: updatedVersion,
        state: updatedState,
        candidateCleared,
      };
    });
  }
}
