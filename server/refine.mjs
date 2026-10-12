import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

// 交付项精修三路径与交付候选（Issue #16 / FLOW-08、FLOW-09、ACC-08、ACC-21）。
//
// 三路径：
//   template_reorder  模板重排：基于已有成功产物与模板版式生成新的版本元数据。
//                     不重新生图、不建生成任务、不收取生成费（报价 0）。
//   base_optimize     底图二次优化：在已有成功底图上做局部改图，走 GenerationService
//                     的改图能力并计费。
//   full_polish       整图润色：整图重绘/润色，走生成或改图能力并计费；产物需要重新质检。
//
// 精修必须单独确认：estimate 只写一份待确认草稿，confirm 才预占（模板路径不预占）
// 并提交生成任务。确认使用幂等键，同一键重复提交返回原请求，不重复扣费、不重复生成。
//
// 版本与候选：
//   - 任何执行完成（包括模板重排与整图润色）都只产生 draft 版本，绝不自动成为候选。
//   - 候选只能由 POST /api/deliverables/:id/candidates 显式选定；旧候选自动变
//     superseded 且保留历史，同一交付项同时最多一个候选（数据库部分唯一索引兜底）。
//   - 返修把目标版本退回第 04 步，记录理由与版本；不删除任何历史版本。
//   - 版本内容不可修改，只能切换 status / is_candidate（迁移触发器兜底）。

export const REFINE_PATH_KEYS = Object.freeze(['template_reorder', 'base_optimize', 'full_polish']);

export const REFINE_PATHS = Object.freeze({
  template_reorder: Object.freeze({
    key: 'template_reorder',
    label: '模板重排',
    description: '按模板版式重排已有成功产物；只生成新的版本元数据，不重新生图，不收取生成费。',
    billingMode: 'none',
    capability: null,
    chargesGeneration: false,
    regeneratesImage: false,
    requiresNewJob: false,
    requiresQc: false,
  }),
  base_optimize: Object.freeze({
    key: 'base_optimize',
    label: '底图二次优化',
    description: '在已有成功底图上做局部改图；按改图能力估价，单独确认后预占并执行。',
    billingMode: 'chargeable',
    capability: 'image.edit',
    chargesGeneration: true,
    regeneratesImage: true,
    requiresNewJob: true,
    requiresQc: false,
  }),
  full_polish: Object.freeze({
    key: 'full_polish',
    label: '整图润色',
    description: '整图重绘或润色；按生成/改图能力计费，产物必须重新质检，且不会自动成为候选。',
    billingMode: 'chargeable',
    capability: null,
    chargesGeneration: true,
    regeneratesImage: true,
    requiresNewJob: true,
    requiresQc: true,
  }),
});

export const VERSION_STATUSES = Object.freeze([
  'draft', 'candidate', 'approved', 'superseded', 'rejected',
]);
export const REFINE_REQUEST_STATUSES = Object.freeze([
  'draft', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'unknown', 'cancelled',
]);
export const OPEN_REQUEST_STATUSES = Object.freeze(['draft', 'awaiting_confirmation']);
export const REFINE_STEP = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const TIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SUCCEEDED_JOB_STATUSES = ['succeeded', 'completed', 'success'];
const FAILED_JOB_STATUSES = ['failed', 'cancelled', 'canceled', 'expired'];
const UNCERTAIN_CODES = ['UPSTREAM_UNCERTAIN', 'UPSTREAM_UNKNOWN', 'UPSTREAM_FORMAT', 'POLL_TIMEOUT'];

const IMPORT_FIELDS = ['projectId', 'planVersion', 'jobId', 'assetId', 'sourceVersionId', 'content'];
const ESTIMATE_FIELDS = ['projectId', 'planVersion', 'sourceVersionId', 'path', 'params', 'reason'];
const CONFIRM_FIELDS = ['refineId', 'idempotencyKey', 'revision', 'reason'];
const RECONCILE_FIELDS = ['revision', 'reason'];
const CANDIDATE_FIELDS = ['projectId', 'planVersion', 'versionId', 'revision', 'reason'];
const REWORK_FIELDS = ['projectId', 'planVersion', 'versionId', 'revision', 'reason'];
const PARAM_FIELDS = ['modelId', 'prompt', 'size', 'quality', 'operation', 'templateId', 'instruction', 'tier'];

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

function pathOf(value, { fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback) return fallback;
    fail('INVALID_REFINE_PATH', `精修路径只能是 ${REFINE_PATH_KEYS.join(' / ')}。`);
  }
  if (!REFINE_PATH_KEYS.includes(value)) {
    fail('INVALID_REFINE_PATH', `精修路径只能是 ${REFINE_PATH_KEYS.join(' / ')}。`);
  }
  return value;
}

function normalizeParams(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) fail('INVALID_PARAMS', '精修参数必须是 JSON 对象。');
  rejectUnknown(raw, PARAM_FIELDS, '精修参数');
  const params = {};
  if (raw.modelId !== undefined && raw.modelId !== null && raw.modelId !== '') {
    const modelId = String(raw.modelId).trim();
    if (!MODEL_ID.test(modelId)) fail('INVALID_MODEL', 'modelId 格式不正确。');
    params.modelId = modelId;
  }
  if (raw.prompt !== undefined && raw.prompt !== null && raw.prompt !== '') {
    params.prompt = textField(raw.prompt, '提示词', 16000, { required: true });
  }
  if (raw.instruction !== undefined && raw.instruction !== null && raw.instruction !== '') {
    params.instruction = textField(raw.instruction, '精修指令', 2000, { required: true });
  }
  if (raw.size !== undefined && raw.size !== null && raw.size !== '') {
    params.size = textField(raw.size, '尺寸', 100, { required: true });
  }
  if (raw.quality !== undefined && raw.quality !== null && raw.quality !== '') {
    params.quality = textField(raw.quality, '质量', 100, { required: true });
  }
  if (raw.operation !== undefined && raw.operation !== null && raw.operation !== '') {
    if (!['generate', 'edit'].includes(raw.operation)) {
      fail('INVALID_OPERATION', 'operation 只能是 generate 或 edit。');
    }
    params.operation = raw.operation;
  }
  if (raw.templateId !== undefined && raw.templateId !== null && raw.templateId !== '') {
    params.templateId = textField(raw.templateId, '模板编号', 200, { required: true });
  }
  if (raw.tier !== undefined && raw.tier !== null && raw.tier !== '') {
    const tier = String(raw.tier).trim();
    if (!TIER.test(tier)) fail('INVALID_FIELD', 'tier 格式不正确。');
    params.tier = tier;
  }
  return params;
}

function includedQuote(path) {
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
    regeneratesImage: false,
    requiresNewJob: false,
    requiresQc: false,
    description: REFINE_PATHS[path].description,
  };
}

function chargeableQuote(path, planned, quote) {
  return {
    priced: quote.priced === true,
    status: quote.status,
    billingMode: quote.billingMode,
    capability: planned.capability,
    modelId: planned.modelId,
    tier: planned.tier,
    quantity: quote.quantity ?? 1,
    currency: quote.currency || 'CNY',
    // 未知价格保持 NULL，绝不当成 0。
    amountCents: quote.amountCents ?? null,
    unit: quote.unit ?? null,
    unitPrice: quote.unitPrice ?? null,
    priceId: quote.priceId ?? null,
    priceVersion: quote.priceVersion ?? null,
    blocking: false,
    regeneratesImage: true,
    requiresNewJob: true,
    requiresQc: REFINE_PATHS[path].requiresQc,
    description: REFINE_PATHS[path].description,
  };
}

export function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planVersion: row.planVersion,
    deliverableId: row.deliverableId,
    version: row.version,
    sourceVersionId: row.sourceVersionId ?? null,
    assetId: row.assetId ?? null,
    jobId: row.jobId ?? null,
    status: row.status,
    isCandidate: row.isCandidate === true,
    refinePath: row.refinePath ?? null,
    refinePathLabel: row.refinePath ? REFINE_PATHS[row.refinePath]?.label ?? null : null,
    requiresQc: row.requiresQc === true,
    content: clone(row.content || {}),
    cost: clone(row.cost || {}),
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function publicRefineRequest(row) {
  if (!row) return null;
  const quote = clone(row.quote || {});
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planVersion: row.planVersion,
    deliverableId: row.deliverableId,
    path: row.path,
    pathLabel: REFINE_PATHS[row.path]?.label ?? row.path,
    sourceVersionId: row.sourceVersionId,
    targetVersionId: row.targetVersionId ?? null,
    params: clone(row.params || {}),
    status: row.status,
    quote,
    estimate: {
      currency: 'CNY',
      amountCents: row.estimateCents ?? null,
      hasPendingPrice: row.estimateCents === null,
      regeneratesImage: quote.regeneratesImage === true,
      requiresQc: quote.requiresQc === true,
    },
    totals: {
      currency: 'CNY',
      estimatedCents: row.estimateCents ?? null,
      reservedCents: row.reservedCents ?? 0,
      actualCostCents: row.actualCostCents ?? null,
    },
    jobId: row.jobId ?? null,
    errorCode: row.errorCode ?? null,
    confirmedBy: row.confirmedBy ?? null,
    confirmedAt: row.confirmedAt ?? null,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function publicDeliverableState(state) {
  if (!state) {
    return {
      candidateVersionId: null,
      rework: null,
      revision: 1,
    };
  }
  return {
    projectId: state.projectId,
    planVersion: state.planVersion,
    deliverableId: state.deliverableId,
    candidateVersionId: state.candidateVersionId ?? null,
    rework: state.reworkVersionId ? {
      versionId: state.reworkVersionId,
      reason: state.reworkReason ?? null,
      at: state.reworkAt ?? null,
      step: state.currentStep ?? REFINE_STEP,
    } : null,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
}

function versionFromRow(row) {
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

function amountOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function requestFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planVersion: row.plan_version,
    deliverableId: row.deliverable_id,
    path: row.path,
    sourceVersionId: row.source_version_id,
    targetVersionId: row.target_version_id,
    params: row.params && typeof row.params === 'object' ? row.params : {},
    status: row.status,
    quote: row.quote && typeof row.quote === 'object' ? row.quote : {},
    estimateCents: amountOrNull(row.estimate_cents),
    reservedCents: amountOrNull(row.reserved_cents) ?? 0,
    actualCostCents: amountOrNull(row.actual_cost_cents),
    currency: row.currency,
    billingTaskId: row.billing_task_id,
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revision: row.revision,
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

export class RefineService {
  constructor(repository, {
    billing = null,
    jobs = null,
    audit = null,
    now = () => new Date(),
    idFactory = randomUUID,
    jobTimeoutMs = 15 * 60_000,
    autoStart = true,
  } = {}) {
    if (!repository) throw new AppError('REFINE_STORE_UNAVAILABLE', '精修存储未配置。', 500);
    this.repository = repository;
    this.billing = billing;
    this.jobs = jobs;
    this.audit = audit;
    this.now = now;
    this.idFactory = idFactory;
    this.jobTimeoutMs = jobTimeoutMs;
    this.autoStart = autoStart;
    this.active = new Map();
    this.restart = new Set();
  }

  async #record(action, { targetType = 'deliverable', targetId, result = 'success', detail = {}, context = {} }) {
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
      throw new AppError('PLAN_NOT_CONFIRMED', '确认方案后才能精修交付项。', 409);
    }
  }

  async #versions(target) {
    return this.repository.listVersions(this.#scope(target));
  }

  async #latestVersion(target) {
    const versions = await this.#versions(target);
    return versions[0] || null;
  }

  async #version(target, versionId, code = 'VERSION_NOT_FOUND') {
    const id = uuidField(versionId, '版本编号');
    const version = await this.repository.getVersion(target.workspaceId, id);
    if (!version || version.deliverableId !== target.deliverableId
      || version.projectId !== target.projectId || version.planVersion !== target.planVersion) {
      throw new AppError(code, '版本不属于该交付项。', 404);
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

  // ---- 导入既有成功产物为源版本（不收费、不建任务） ----

  async importVersion(deliverableId, body = {}, { workspaceId = null, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, IMPORT_FIELDS, '导入版本');
    const target = await this.#deliverable(deliverableId, body, workspaceId);
    this.#assertConfirmed(target);

    const requestedJobId = uuidField(body.jobId, '生成任务编号', { required: false });
    // 方案里的 jobId 是历史登记文本，只有 UUID 才能查询 sj_generation_jobs。
    const fallbackJobId = UUID.test(String(target.jobId || '')) ? target.jobId : null;
    const jobId = requestedJobId || fallbackJobId;
    let job = null;
    if (jobId) {
      job = await this.repository.findJob(jobId);
      if (!job) throw new AppError('JOB_NOT_FOUND', '生成任务不存在。', 404);
      if (job.workspaceId && job.workspaceId !== target.workspaceId) {
        throw new AppError('FORBIDDEN', '生成任务不属于当前工作空间。', 403);
      }
      if (!SUCCEEDED_JOB_STATUSES.includes(job.status)) {
        throw new AppError('SOURCE_NOT_READY', '只有已成功的生成任务才能导入为交付版本。', 409);
      }
    }
    let assetId = uuidField(body.assetId, '素材编号', { required: false });
    if (!assetId && jobId) {
      const asset = await this.repository.findAssetByJob({
        workspaceId: target.workspaceId, jobId,
      });
      assetId = asset?.id ?? null;
    }
    if (!jobId && !assetId) {
      throw new AppError('SOURCE_REQUIRED', '请提供已成功的生成任务或素材。', 422);
    }
    const sourceVersionId = uuidField(body.sourceVersionId, '来源版本编号', { required: false });
    if (sourceVersionId) await this.#version(target, sourceVersionId);

    const input = isObject(job?.input) ? job.input : {};
    const extra = body.content === undefined || body.content === null ? {} : body.content;
    if (!isObject(extra)) fail('INVALID_CONTENT', 'content 必须是 JSON 对象。');
    const now = this.now();
    const row = {
      id: this.idFactory(),
      ...this.#scope(target),
      sourceVersionId,
      assetId,
      jobId,
      status: 'draft',
      isCandidate: false,
      refinePath: null,
      requiresQc: false,
      content: {
        modelId: input.modelId ?? null,
        prompt: input.prompt ?? null,
        size: input.size ?? null,
        quality: input.quality ?? null,
        operation: input.operation ?? null,
        sourceJobId: input.sourceJobId ?? null,
        productId: target.productId ?? null,
        ...clone(extra),
      },
      cost: {
        currency: 'CNY',
        billingMode: 'none',
        amountCents: 0,
        actualCostCents: 0,
        chargedGeneration: false,
        regeneratedImage: false,
        note: '既有成功产物导入，不重复计费。',
      },
      createdBy: actorId || 'local',
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.repository.createVersion({ scope: this.#scope(target), row });
    const version = result.version;
    if (result.created !== false) await this.#record('deliverable.version.imported', {
      targetId: target.deliverableId,
      detail: {
        projectId: target.projectId,
        planVersion: target.planVersion,
        versionId: version.id,
        version: version.version,
        jobId,
        assetId,
      },
      context,
    });
    return {
      version: publicVersion(version),
      created: result.created !== false,
      versions: (await this.#versions(target)).map(publicVersion),
      state: publicDeliverableState(result.state || await this.#state(target)),
    };
  }

  async listVersions(deliverableId, { workspaceId = null, projectId = null, planVersion = null } = {}) {
    const target = await this.#deliverable(deliverableId, { projectId, planVersion }, workspaceId);
    const [versions, state] = await Promise.all([this.#versions(target), this.#state(target)]);
    return {
      deliverable: { ...this.#scope(target), planStatus: target.planStatus },
      versions: versions.map(publicVersion),
      state: publicDeliverableState(state),
    };
  }

  // ---- 估价 ----

  async #plan(path, source, params) {
    const content = isObject(source.content) ? source.content : {};
    if (path === 'template_reorder') {
      return {
        templateId: params.templateId || content.templateId || 'default',
        sourceJobId: source.jobId ?? null,
      };
    }
    if (path === 'base_optimize') {
      if (!source.jobId) {
        throw new AppError('SOURCE_JOB_REQUIRED', '底图二次优化需要源版本关联已成功的生成任务。', 422);
      }
      const modelId = params.modelId || content.modelId || null;
      if (!modelId || !MODEL_ID.test(modelId)) {
        throw new AppError('MODEL_REQUIRED', '底图二次优化需要选择可用的改图模型。', 422);
      }
      return {
        modelId,
        tier: params.tier || 'default',
        capability: 'image.edit',
        operation: 'edit',
        sourceJobId: source.jobId,
        // 没有显式指令时使用通用底图优化指令；不改变商品主体。
        prompt: params.prompt || params.instruction
          || '保持商品主体、文字和构图不变，优化底图光影、质感与清晰度。',
        size: params.size || content.size || null,
        quality: params.quality || content.quality || null,
      };
    }
    const operation = params.operation || (source.jobId ? 'edit' : 'generate');
    if (operation === 'edit' && !source.jobId) {
      throw new AppError('SOURCE_JOB_REQUIRED', '整图润色选择改图时必须关联已成功的源任务。', 422);
    }
    const modelId = params.modelId || content.modelId || null;
    if (!modelId || !MODEL_ID.test(modelId)) {
      throw new AppError('MODEL_REQUIRED', '整图润色需要选择可用的生成或改图模型。', 422);
    }
    const prompt = params.prompt || content.prompt || null;
    if (!prompt) throw new AppError('PROMPT_REQUIRED', '整图润色需要提供提示词或精修指令。', 422);
    return {
      modelId,
      tier: params.tier || 'default',
      capability: operation === 'edit' ? 'image.edit' : 'image.generate',
      operation,
      sourceJobId: operation === 'edit' ? source.jobId : null,
      prompt,
      instruction: params.instruction || null,
      size: params.size || content.size || null,
      quality: params.quality || content.quality || null,
    };
  }

  async #quote(path, planned) {
    if (path === 'template_reorder') return includedQuote(path);
    if (!this.billing) throw new AppError('BILLING_UNAVAILABLE', '计费服务未配置，无法估价。', 503);
    const quote = await this.billing.quote({
      capability: planned.capability,
      modelId: planned.modelId,
      tier: planned.tier || 'default',
      quantity: 1,
    });
    return chargeableQuote(path, planned, quote);
  }

  async estimate(deliverableId, body = {}, { workspaceId = null, actorId = null, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, ESTIMATE_FIELDS, '精修估价');
    const target = await this.#deliverable(deliverableId, body, workspaceId);
    this.#assertConfirmed(target);
    const path = pathOf(body.path);
    const params = normalizeParams(body.params);
    const source = body.sourceVersionId
      ? await this.#version(target, body.sourceVersionId)
      : await this.#latestVersion(target);
    if (!source) {
      throw new AppError('VERSION_REQUIRED', '请先导入已成功的交付产物，再进行精修。', 409);
    }
    const planned = await this.#plan(path, source, params);
    const quote = await this.#quote(path, planned);
    const now = this.now();
    const scope = this.#scope(target);
    const row = {
      id: this.idFactory(),
      ...scope,
      path,
      sourceVersionId: source.id,
      targetVersionId: null,
      params: planned,
      status: 'awaiting_confirmation',
      quote,
      estimateCents: quote.amountCents ?? null,
      reservedCents: 0,
      actualCostCents: null,
      currency: 'CNY',
      billingTaskId: null,
      jobId: null,
      idempotencyKey: null,
      errorCode: null,
      confirmedBy: null,
      confirmedAt: null,
      createdBy: actorId || 'local',
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.repository.saveDraftRequest({ scope, row });
    const request = saved.request;
    await this.#record('refine.estimated', {
      targetId: target.deliverableId,
      detail: {
        requestId: request.id,
        path,
        sourceVersionId: source.id,
        modelId: planned.modelId ?? null,
        estimateCents: request.estimateCents,
        regeneratesImage: quote.regeneratesImage,
        requiresQc: quote.requiresQc,
      },
      context,
    });
    return {
      request: publicRefineRequest(request),
      quote,
      state: publicDeliverableState(saved.state || await this.#state(target)),
    };
  }

  async listRefines(deliverableId, { workspaceId = null, projectId = null, planVersion = null } = {}) {
    const target = await this.#deliverable(deliverableId, { projectId, planVersion }, workspaceId);
    const [requests, state] = await Promise.all([
      this.repository.listRequests(this.#scope(target)),
      this.#state(target),
    ]);
    return {
      deliverable: { ...this.#scope(target), planStatus: target.planStatus },
      requests: requests.map(publicRefineRequest),
      state: publicDeliverableState(state),
    };
  }

  async getRefine(requestId, { workspaceId = null } = {}) {
    const id = uuidField(requestId, '精修请求编号');
    const request = await this.repository.getRequest(this.#workspace(workspaceId), id);
    if (!request) throw new AppError('REFINE_NOT_FOUND', '精修请求不存在。', 404);
    return { request: publicRefineRequest(request) };
  }

  // ---- 单独确认：预占（模板路径不预占）并执行 ----

  #templateVersion(request, source, actorId) {
    const content = isObject(source.content) ? source.content : {};
    return {
      id: this.idFactory(),
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      planVersion: request.planVersion,
      deliverableId: request.deliverableId,
      sourceVersionId: source.id,
      assetId: source.assetId ?? null,
      jobId: source.jobId ?? null,
      status: 'draft',
      isCandidate: false,
      refinePath: 'template_reorder',
      requiresQc: false,
      content: {
        notRegenerated: true,
        regeneratedImage: false,
        inheritsSourceQc: true,
        template: {
          templateId: request.params.templateId,
          layout: 'default',
        },
        source: {
          versionId: source.id,
          jobId: source.jobId ?? null,
          assetId: source.assetId ?? null,
          modelId: content.modelId ?? null,
          prompt: content.prompt ?? null,
          size: content.size ?? null,
          quality: content.quality ?? null,
        },
        note: '按模板版式重排，未重新生图，不收取生成费。',
      },
      cost: {
        currency: 'CNY',
        billingMode: 'none',
        amountCents: 0,
        actualCostCents: 0,
        reservedCents: 0,
        chargedGeneration: false,
        regeneratedImage: false,
      },
      createdBy: actorId || 'local',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  async confirm(deliverableId, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, CONFIRM_FIELDS, '精修确认');
    const key = normalizeIdempotencyKey(body.idempotencyKey);
    const expected = readExpectedRevision(body, ifMatch);
    const target = await this.#deliverable(deliverableId, body, workspaceId);
    this.#assertConfirmed(target);

    const existing = await this.repository.findRequestByKey(target.workspaceId, key);
    if (existing) {
      if (existing.deliverableId !== target.deliverableId) {
        fail('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同的交付项。', 409);
      }
      return { request: publicRefineRequest(existing), created: false };
    }

    const requestId = uuidField(body.refineId, '精修请求编号');
    const request = await this.repository.getRequest(target.workspaceId, requestId);
    if (!request) throw new AppError('REFINE_NOT_FOUND', '精修请求不存在。', 404);
    if (request.deliverableId !== target.deliverableId) {
      throw new AppError('REFINE_NOT_FOUND', '精修请求不属于该交付项。', 404);
    }
    if (request.revision !== expected) {
      fail('REVISION_CONFLICT', '精修请求已被其他操作更新，请刷新后重试。', 409);
    }
    if (!OPEN_REQUEST_STATUSES.includes(request.status) || request.idempotencyKey) {
      fail('REFINE_ALREADY_CONFIRMED', '该精修请求已确认或已结束，请重新估价。', 409);
    }
    const source = await this.#version(target, request.sourceVersionId);
    const now = this.now();
    const confirmedBy = actorId || 'local';

    if (request.path === 'template_reorder') {
      const version = this.#templateVersion(request, source, confirmedBy);
      const outcome = await this.repository.completeRequest({
        scope: this.#scope(target),
        requestId: request.id,
        expectedRevision: expected,
        requestPatch: {
          status: 'succeeded',
          idempotencyKey: key,
          confirmedBy,
          confirmedAt: now,
          jobId: source.jobId ?? null,
          reservedCents: 0,
          actualCostCents: 0,
          errorCode: null,
          updatedAt: now,
        },
        version,
      });
      if (outcome.status === 'missing') throw new AppError('REFINE_NOT_FOUND', '精修请求不存在。', 404);
      if (outcome.status === 'conflict') {
        const duplicate = await this.repository.findRequestByKey(target.workspaceId, key);
        if (duplicate) return { request: publicRefineRequest(duplicate), created: false };
        fail('REVISION_CONFLICT', '精修请求已被其他操作更新，请刷新后重试。', 409);
      }
      const finalRequest = outcome.request;
      if (outcome.status === 'already' && finalRequest.idempotencyKey !== key) {
        fail('REFINE_ALREADY_CONFIRMED', '该精修请求已由其他请求完成，请刷新后查看。', 409);
      }
      await this.#record('refine.confirmed', {
        targetId: target.deliverableId,
        detail: {
          requestId: finalRequest.id, path: request.path, estimateCents: 0, reservedCents: 0,
        },
        context,
      });
      await this.#record('refine.completed', {
        targetId: target.deliverableId,
        detail: {
          requestId: finalRequest.id,
          versionId: outcome.version?.id ?? finalRequest.targetVersionId,
          version: outcome.version?.version ?? null,
          path: request.path,
          notRegenerated: true,
          actualCostCents: 0,
          requiresQc: false,
          candidate: false,
        },
        context,
      });
      return {
        request: publicRefineRequest(finalRequest),
        version: publicVersion(outcome.version),
        state: publicDeliverableState(outcome.state || await this.#state(target)),
        created: true,
      };
    }

    if (!this.billing) throw new AppError('BILLING_UNAVAILABLE', '计费服务未配置，无法确认。', 503);
    if (!this.jobs) throw new AppError('JOB_EXECUTOR_UNAVAILABLE', '生成任务执行器未配置。', 503);
    const billingTaskId = `refine:${request.id}`;
    const reservation = await this.billing.reserve({
      capability: request.quote.capability,
      modelId: request.quote.modelId,
      tier: request.quote.tier || 'default',
      quantity: 1,
      taskId: billingTaskId,
      projectId: request.projectId,
      idempotencyKey: `reserve:${billingTaskId}`,
      reason: `交付项精修 ${request.path} 确认预占`,
    }, { actorId: confirmedBy });
    const reservedCents = reservation.entry?.amountCents ?? 0;
    const jobRequestId = request.params.jobRequestId || this.idFactory();
    const updated = await this.repository.updateRequest({
      requestId: request.id,
      expectedRevision: expected,
      patch: {
        status: 'running',
        idempotencyKey: key,
        confirmedBy,
        confirmedAt: now,
        billingTaskId,
        reservedCents,
        params: { ...request.params, jobRequestId },
        updatedAt: now,
      },
    });
    if (updated.status === 'conflict' || updated.status === 'missing') {
      await this.billing.release(billingTaskId, {
        idempotencyKey: `release:${billingTaskId}`,
        reason: '精修确认冲突，释放未使用预占',
      }, { actorId: confirmedBy }).catch(() => {});
      const duplicate = await this.repository.findRequestByKey(target.workspaceId, key);
      if (duplicate) return { request: publicRefineRequest(duplicate), created: false };
      fail('REVISION_CONFLICT', '精修请求已被其他操作更新，请刷新后重试。', 409);
    }
    await this.#record('refine.confirmed', {
      targetId: target.deliverableId,
      detail: {
        requestId: request.id,
        path: request.path,
        modelId: request.params.modelId ?? null,
        estimateCents: request.estimateCents,
        reservedCents,
        requiresQc: request.quote.requiresQc === true,
      },
      context,
    });
    if (this.autoStart) this.startRefine(request.id, { workspaceId: target.workspaceId });
    return {
      request: publicRefineRequest(updated.request),
      state: publicDeliverableState(await this.#state(target)),
      created: true,
    };
  }

  // ---- 执行 ----

  startRefine(requestId, options = {}) {
    if (this.active.has(requestId)) {
      this.restart.add(requestId);
      return;
    }
    this.executeRefine(requestId, options).catch(() => {});
  }

  async executeRefine(requestId, { workspaceId = null } = {}) {
    if (this.active.has(requestId)) return this.active.get(requestId);
    const promise = this.#execute(requestId, { workspaceId }).finally(() => {
      this.active.delete(requestId);
      if (this.restart.delete(requestId)) this.startRefine(requestId, { workspaceId });
    });
    this.active.set(requestId, promise);
    return promise;
  }

  async #execute(requestId, { workspaceId = null } = {}) {
    const request = await this.repository.getRequest(this.#workspace(workspaceId), requestId);
    if (!request) throw new AppError('REFINE_NOT_FOUND', '精修请求不存在。', 404);
    if (request.status !== 'running') return publicRefineRequest(request);
    if (request.path === 'template_reorder') return publicRefineRequest(request);
    if (!this.jobs) throw new AppError('JOB_EXECUTOR_UNAVAILABLE', '生成任务执行器未配置。', 503);
    const target = await this.repository.getDeliverable({
      workspaceId: request.workspaceId,
      deliverableId: request.deliverableId,
      projectId: request.projectId,
      planVersion: request.planVersion,
    });
    if (!target) throw new AppError('DELIVERABLE_NOT_FOUND', '交付项不存在。', 404);
    const source = await this.repository.getVersion(request.workspaceId, request.sourceVersionId);
    if (!source) throw new AppError('VERSION_NOT_FOUND', '源版本不存在。', 404);
    const jobRequestId = request.params.jobRequestId || this.idFactory();
    let job;
    try {
      job = await this.jobs.submit({
        requestId: jobRequestId,
        operation: request.params.operation || 'edit',
        modelId: request.params.modelId,
        prompt: request.params.prompt,
        size: request.params.size || null,
        quality: request.params.quality || null,
        sourceJobId: request.params.sourceJobId || null,
        workspaceId: request.workspaceId,
      });
    } catch (error) {
      if (this.#isUncertain(error)) {
        await this.#markUnknown(request, null, error);
        return publicRefineRequest(await this.repository.getRequest(request.workspaceId, request.id));
      }
      await this.#markFailed(request, null, error?.code || 'SUBMIT_FAILED');
      return publicRefineRequest(await this.repository.getRequest(request.workspaceId, request.id));
    }
    const running = await this.repository.updateRequest({
      requestId: request.id,
      expectedRevision: null,
      patch: { status: 'running', jobId: job.id, errorCode: null, updatedAt: this.now() },
    });
    request.jobId = job.id;
    request.revision = running.request?.revision ?? request.revision;
    let result;
    try {
      result = await this.jobs.wait(job.id, { timeoutMs: this.jobTimeoutMs });
    } catch (error) {
      await this.#markUnknown(request, job.id, error);
      return publicRefineRequest(await this.repository.getRequest(request.workspaceId, request.id));
    }
    await this.#applyJobResult(request, result || { id: job.id, status: 'unknown' });
    return publicRefineRequest(await this.repository.getRequest(request.workspaceId, request.id));
  }

  #isUncertain(error) {
    if (!(error instanceof AppError)) return true;
    return UNCERTAIN_CODES.includes(error.code);
  }

  #versionFromJob(request, job, { actualCostCents, reservedCents }) {
    const planned = request.params || {};
    const path = REFINE_PATHS[request.path];
    return {
      id: this.idFactory(),
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      planVersion: request.planVersion,
      deliverableId: request.deliverableId,
      sourceVersionId: request.sourceVersionId,
      assetId: null,
      jobId: job.id || request.jobId,
      status: 'draft',
      isCandidate: false,
      refinePath: request.path,
      requiresQc: path.requiresQc,
      content: {
        notRegenerated: false,
        regeneratedImage: true,
        requiresQc: path.requiresQc,
        modelId: planned.modelId ?? null,
        prompt: planned.prompt ?? null,
        instruction: planned.instruction ?? null,
        size: planned.size ?? null,
        quality: planned.quality ?? null,
        operation: planned.operation ?? null,
        sourceJobId: planned.sourceJobId ?? null,
        sourceVersionId: request.sourceVersionId,
        imageUrl: `/api/jobs/${job.id || request.jobId}/image`,
      },
      cost: {
        currency: 'CNY',
        billingMode: request.quote.billingMode,
        estimatedCents: request.estimateCents,
        reservedCents,
        actualCostCents,
        chargedGeneration: reservedCents > 0,
        regeneratedImage: true,
      },
      createdBy: request.confirmedBy || 'local',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  async #applyJobResult(request, job) {
    const now = this.now();
    if (SUCCEEDED_JOB_STATUSES.includes(job.status)) {
      const reserved = request.reservedCents || 0;
      const billingTaskId = request.billingTaskId || `refine:${request.id}`;
      let actualCostCents = reserved > 0 ? reserved : (request.estimateCents === null ? null : 0);
      if (reserved > 0 && this.billing) {
        try {
          await this.billing.settle(billingTaskId, {
            idempotencyKey: `settle:${billingTaskId}`,
            reason: '交付项精修成功结算',
          }, { actorId: request.confirmedBy || 'local' });
        } catch {
          // 结算失败不能反过来丢失成功产物；保留实际成本供人工核对。
          actualCostCents = request.estimateCents;
        }
      }
      const version = this.#versionFromJob(request, job, {
        actualCostCents,
        reservedCents: reserved,
      });
      const outcome = await this.repository.completeRequest({
        scope: {
          workspaceId: request.workspaceId,
          projectId: request.projectId,
          planVersion: request.planVersion,
          deliverableId: request.deliverableId,
        },
        requestId: request.id,
        expectedRevision: null,
        requestPatch: {
          status: 'succeeded',
          jobId: job.id || request.jobId,
          reservedCents: 0,
          actualCostCents,
          errorCode: null,
          updatedAt: now,
        },
        version,
      });
      if (outcome.status === 'ok' || outcome.status === 'already') {
        await this.#record('refine.completed', {
          targetId: request.deliverableId,
          detail: {
            requestId: request.id,
            path: request.path,
            versionId: outcome.version?.id ?? request.targetVersionId,
            version: outcome.version?.version ?? null,
            jobId: job.id || request.jobId,
            reservedCents: reserved,
            actualCostCents,
            requiresQc: version.requiresQc,
            // 完成不自动选定候选。
            candidate: false,
          },
        });
      }
      return;
    }
    if (FAILED_JOB_STATUSES.includes(job.status)) {
      await this.#markFailed(request, job.id || request.jobId, job.error?.code || 'UPSTREAM_FAILED');
      return;
    }
    if (job.status === 'unknown') {
      await this.#markUnknown(request, job.id || request.jobId, job.error || { code: 'UPSTREAM_UNKNOWN' });
      return;
    }
    await this.repository.updateRequest({
      requestId: request.id,
      expectedRevision: null,
      patch: {
        status: 'running', jobId: job.id || request.jobId, errorCode: null, updatedAt: now,
      },
    });
  }

  async #markUnknown(request, jobId, error) {
    const code = error?.code || 'UPSTREAM_UNKNOWN';
    await this.repository.updateRequest({
      requestId: request.id,
      expectedRevision: null,
      patch: {
        status: 'unknown', jobId: jobId || request.jobId, errorCode: code, updatedAt: this.now(),
      },
    });
    await this.#record('refine.unknown', {
      targetId: request.deliverableId,
      detail: { requestId: request.id, jobId: jobId || request.jobId, errorCode: code },
    });
  }

  async #markFailed(request, jobId, code) {
    const billingTaskId = request.billingTaskId || `refine:${request.id}`;
    if (this.billing && (request.reservedCents > 0 || request.quote?.status === 'pending_price')) {
      await this.billing.release(billingTaskId, {
        idempotencyKey: `release:${billingTaskId}`,
        reason: '交付项精修失败释放预占',
      }, { actorId: request.confirmedBy || 'local' }).catch(() => {});
    }
    await this.repository.updateRequest({
      requestId: request.id,
      expectedRevision: null,
      patch: {
        status: 'failed',
        jobId: jobId || request.jobId,
        reservedCents: 0,
        actualCostCents: null,
        errorCode: code,
        updatedAt: this.now(),
      },
    });
    await this.#record('refine.failed', {
      targetId: request.deliverableId,
      detail: {
        requestId: request.id, jobId: jobId || request.jobId, errorCode: code,
        releasedCents: request.reservedCents || 0,
      },
    });
  }

  // 未知状态只查询原任务，不重新提交、不换模型。
  async reconcile(requestId, body = {}, { workspaceId = null, ifMatch = undefined, ...context } = {}) {
    requireObject(body);
    rejectUnknown(body, RECONCILE_FIELDS, '精修核实');
    const expected = readExpectedRevision(body, ifMatch, { required: false });
    const id = uuidField(requestId, '精修请求编号');
    const request = await this.repository.getRequest(this.#workspace(workspaceId), id);
    if (!request) throw new AppError('REFINE_NOT_FOUND', '精修请求不存在。', 404);
    if (expected !== null && request.revision !== expected) {
      fail('REVISION_CONFLICT', '精修请求已被其他操作更新，请刷新后重试。', 409);
    }
    if (request.status !== 'unknown') {
      throw new AppError('NOT_UNCERTAIN', '只有待核实的精修请求需要查询原任务。', 409);
    }
    if (!request.jobId) {
      throw new AppError('JOB_NOT_RECORDED', '该请求没有记录上游任务编号，请到供应商使用日志核实。', 409);
    }
    if (!this.jobs) throw new AppError('JOB_EXECUTOR_UNAVAILABLE', '生成任务执行器未配置。', 503);
    const job = await this.jobs.reconcile(request.jobId) || { id: request.jobId, status: 'unknown' };
    if (!SUCCEEDED_JOB_STATUSES.includes(job.status) && !FAILED_JOB_STATUSES.includes(job.status)
      && job.status !== 'unknown') {
      // 原任务仍在进行：保持 unknown，允许稍后再次只查询原任务。
      await this.repository.updateRequest({
        requestId: request.id,
        expectedRevision: null,
        patch: {
          status: 'unknown', jobId: request.jobId, errorCode: null, updatedAt: this.now(),
        },
      });
    } else {
      await this.#applyJobResult(request, job);
    }
    const refreshed = await this.repository.getRequest(request.workspaceId, request.id);
    await this.#record('refine.reconciled', {
      targetId: request.deliverableId,
      detail: { requestId: request.id, jobId: request.jobId, status: refreshed?.status ?? null },
      context,
    });
    return { request: publicRefineRequest(refreshed) };
  }

  // ---- 显式选定交付候选 ----

  async selectCandidate(deliverableId, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, CANDIDATE_FIELDS, '选定候选');
    const target = await this.#deliverable(deliverableId, body, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    const version = await this.#version(target, body.versionId, 'VERSION_NOT_FOUND');
    if (version.status === 'rejected') {
      throw new AppError('VERSION_REJECTED', '已拒绝的版本不能选为交付候选。', 409);
    }
    const outcome = await this.repository.selectCandidate({
      scope: this.#scope(target),
      versionId: version.id,
      expectedRevision: expected,
      now: this.now(),
      actorId: actorId || 'local',
    });
    if (outcome.status === 'missing') throw new AppError('DELIVERABLE_NOT_FOUND', '交付项不存在。', 404);
    if (outcome.status === 'conflict') {
      fail('REVISION_CONFLICT', '交付项已被其他操作更新，请刷新后重试。', 409);
    }
    await this.#record('deliverable.candidate.selected', {
      targetId: target.deliverableId,
      detail: {
        versionId: outcome.version.id,
        version: outcome.version.version,
        previousCandidateVersionId: outcome.previousCandidateVersionId ?? null,
        supersededVersionIds: outcome.supersededVersionIds || [],
        explicitlySelected: true,
      },
      context,
    });
    return {
      version: publicVersion(outcome.version),
      state: publicDeliverableState(outcome.state),
      revisions: { state: outcome.state.revision },
    };
  }

  // ---- 返修：退回第 04 步，记录理由与目标版本，不删除历史 ----

  async rework(deliverableId, body = {}, {
    workspaceId = null, ifMatch = undefined, actorId = null, ...context
  } = {}) {
    requireObject(body);
    rejectUnknown(body, REWORK_FIELDS, '返修');
    const target = await this.#deliverable(deliverableId, body, workspaceId);
    const expected = readExpectedRevision(body, ifMatch);
    const reason = textField(body.reason, '返修理由', 500, { required: true });
    const version = await this.#version(target, body.versionId, 'VERSION_NOT_FOUND');
    const outcome = await this.repository.rework({
      scope: this.#scope(target),
      versionId: version.id,
      reason,
      expectedRevision: expected,
      now: this.now(),
      actorId: actorId || 'local',
    });
    if (outcome.status === 'missing') throw new AppError('DELIVERABLE_NOT_FOUND', '交付项不存在。', 404);
    if (outcome.status === 'conflict') {
      fail('REVISION_CONFLICT', '交付项已被其他操作更新，请刷新后重试。', 409);
    }
    await this.#record('deliverable.rework.requested', {
      targetId: target.deliverableId,
      detail: {
        versionId: outcome.version.id,
        version: outcome.version.version,
        reason,
        previousStatus: outcome.previousStatus ?? null,
        currentStep: REFINE_STEP,
        candidateCleared: outcome.candidateCleared === true,
      },
      context,
    });
    return {
      version: publicVersion(outcome.version),
      state: publicDeliverableState(outcome.state),
    };
  }
}

// ---- PostgreSQL 仓储 ----

const VERSION_COLUMNS = {
  workspaceId: 'workspace_id',
  projectId: 'project_id',
  planVersion: 'plan_version',
  deliverableId: 'deliverable_id',
  version: 'version',
  sourceVersionId: 'source_version_id',
  assetId: 'asset_id',
  jobId: 'job_id',
  status: 'status',
  isCandidate: 'is_candidate',
  refinePath: 'refine_path',
  requiresQc: 'requires_qc',
  content: 'content',
  cost: 'cost',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const REQUEST_COLUMNS = {
  path: 'path',
  sourceVersionId: 'source_version_id',
  targetVersionId: 'target_version_id',
  params: 'params',
  status: 'status',
  quote: 'quote',
  estimateCents: 'estimate_cents',
  reservedCents: 'reserved_cents',
  actualCostCents: 'actual_cost_cents',
  currency: 'currency',
  billingTaskId: 'billing_task_id',
  jobId: 'job_id',
  idempotencyKey: 'idempotency_key',
  errorCode: 'error_code',
  confirmedBy: 'confirmed_by',
  confirmedAt: 'confirmed_at',
  updatedAt: 'updated_at',
};

const VERSION_JSON = new Set(['content', 'cost']);
const REQUEST_JSON = new Set(['params', 'quote']);

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

const INSERT_VERSION = `
  INSERT INTO sj_deliverable_versions (
    id, workspace_id, project_id, plan_version, deliverable_id, version, source_version_id,
    asset_id, job_id, status, is_candidate, refine_path, requires_qc, content, cost,
    created_by, created_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18
  ) RETURNING *`;

function versionParams(row) {
  return [
    row.id, row.workspaceId, row.projectId, row.planVersion, row.deliverableId, row.version,
    row.sourceVersionId ?? null, row.assetId ?? null, row.jobId ?? null, row.status,
    Boolean(row.isCandidate), row.refinePath ?? null, Boolean(row.requiresQc),
    JSON.stringify(row.content || {}), JSON.stringify(row.cost || {}),
    row.createdBy ?? null, row.createdAt ?? new Date(), row.updatedAt ?? new Date(),
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

async function nextVersionNumber(client, scope) {
  const row = (await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM sj_deliverable_versions
     WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4`,
    [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId],
  )).rows[0];
  return Number(row.next);
}

export class PgRefineRepository {
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
      promptText: deliverable.promptText ?? deliverable.prompt ?? null,
      jobId: deliverable.jobId ?? null,
      versionId: deliverable.versionId ?? null,
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

  async listVersions(scope) {
    return (await this.pool.query(
      `SELECT * FROM sj_deliverable_versions
       WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
       ORDER BY version DESC`,
      [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId],
    )).rows.map(versionFromRow);
  }

  async getVersion(workspaceId, versionId) {
    return versionFromRow((await this.pool.query(
      'SELECT * FROM sj_deliverable_versions WHERE id=$1 AND workspace_id=$2',
      [versionId, workspaceId],
    )).rows[0]);
  }

  async createVersion({ scope, row }) {
    return this.#withTransaction(async client => {
      const state = await lockState(client, scope);
      // 状态行锁串行化同一交付项的导入；恢复/重复请求不追加相同的不可变版本。
      const existing = (await client.query(`
        SELECT * FROM sj_deliverable_versions
        WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
          AND job_id IS NOT DISTINCT FROM $5::uuid
          AND (job_id IS NOT NULL OR asset_id IS NOT DISTINCT FROM $6::uuid)
          AND source_version_id IS NOT DISTINCT FROM $7::uuid AND refine_path IS NULL
          AND content=$8::jsonb
        ORDER BY version ASC LIMIT 1
      `, [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId,
        row.jobId, row.assetId, row.sourceVersionId, JSON.stringify(row.content || {})])).rows[0];
      if (existing) return { version: versionFromRow(existing), state, created: false };
      const version = { ...row, version: await nextVersionNumber(client, scope) };
      const inserted = (await client.query(INSERT_VERSION, versionParams(version))).rows[0];
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states SET revision=revision+1, updated_at=now()
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId],
      )).rows[0]);
      return { version: versionFromRow(inserted), state: updatedState, created: true };
    });
  }

  async findRequestByKey(workspaceId, key) {
    return requestFromRow((await this.pool.query(
      `SELECT * FROM sj_refine_requests
       WHERE workspace_id=$1 AND idempotency_key=$2`,
      [workspaceId, key],
    )).rows[0]);
  }

  async getRequest(workspaceId, id) {
    return requestFromRow((await this.pool.query(
      `SELECT * FROM sj_refine_requests
       WHERE id=$1 AND ($2::text IS NULL OR workspace_id=$2)`,
      [id, workspaceId],
    )).rows[0]);
  }

  async findOpenRequest(scope) {
    return requestFromRow((await this.pool.query(
      `SELECT * FROM sj_refine_requests
       WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
         AND idempotency_key IS NULL AND status IN ('draft','awaiting_confirmation')
       ORDER BY created_at DESC LIMIT 1`,
      [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId],
    )).rows[0]);
  }

  async saveDraftRequest({ scope, row }) {
    return this.#withTransaction(async client => {
      // 先锁交付项状态行，串行化同一交付项的并发估价，避免重复插入待确认草稿。
      await lockState(client, scope);
      const existing = requestFromRow((await client.query(
        `SELECT * FROM sj_refine_requests
         WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
           AND idempotency_key IS NULL AND status IN ('draft','awaiting_confirmation')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId],
      )).rows[0]);
      let request;
      if (existing) {
        const patch = {
          path: row.path,
          sourceVersionId: row.sourceVersionId,
          targetVersionId: null,
          params: row.params,
          status: 'awaiting_confirmation',
          quote: row.quote,
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
          createdAt: existing.createdAt,
          updatedAt: row.updatedAt,
        };
        const { values, sets } = buildUpdate(REQUEST_COLUMNS, REQUEST_JSON, patch, 2);
        request = requestFromRow((await client.query(
          `UPDATE sj_refine_requests SET ${sets.join(',')}, revision=revision+1
           WHERE id=$1 RETURNING *`,
          [existing.id, ...values],
        )).rows[0]);
      } else {
        request = requestFromRow((await client.query(
          `INSERT INTO sj_refine_requests (
             id, workspace_id, project_id, plan_version, deliverable_id, path,
             source_version_id, target_version_id, params, status, quote, estimate_cents,
             reserved_cents, actual_cost_cents, currency, billing_task_id, job_id,
             idempotency_key, error_code, confirmed_by, confirmed_at, revision,
             created_by, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,NULL,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,1,$21,$22,$23
           ) RETURNING *`,
          [
            row.id, row.workspaceId, row.projectId, row.planVersion, row.deliverableId,
            row.path, row.sourceVersionId, JSON.stringify(row.params || {}), row.status,
            JSON.stringify(row.quote || {}), row.estimateCents, row.reservedCents,
            row.actualCostCents, row.currency, row.billingTaskId, row.jobId,
            row.idempotencyKey, row.errorCode, row.confirmedBy, row.confirmedAt,
            row.createdBy, row.createdAt, row.updatedAt,
          ],
        )).rows[0]);
      }
      const state = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states SET revision=revision+1, updated_at=now()
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId],
      )).rows[0]);
      return { request, state };
    });
  }

  async listRequests(scope) {
    return (await this.pool.query(
      `SELECT * FROM sj_refine_requests
       WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
       ORDER BY created_at DESC`,
      [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId],
    )).rows.map(requestFromRow);
  }

  async updateRequest({ requestId, expectedRevision = null, patch }) {
    const startIndex = expectedRevision === null ? 2 : 3;
    const { values, sets } = buildUpdate(REQUEST_COLUMNS, REQUEST_JSON, patch, startIndex);
    const filter = expectedRevision === null ? 'id=$1' : 'id=$1 AND revision=$2';
    const params = expectedRevision === null ? [requestId, ...values] : [requestId, expectedRevision, ...values];
    const updated = (await this.pool.query(
      `UPDATE sj_refine_requests SET ${sets.join(',')}, revision=revision+1
       WHERE ${filter} RETURNING *`, params,
    )).rows[0];
    if (updated) return { status: 'ok', request: requestFromRow(updated) };
    const current = await this.getRequest(null, requestId);
    return current ? { status: 'conflict', request: current } : { status: 'missing' };
  }

  async completeRequest({ scope, requestId, expectedRevision = null, requestPatch = {}, version }) {
    return this.#withTransaction(async client => {
      const current = requestFromRow((await client.query(
        'SELECT * FROM sj_refine_requests WHERE id=$1 FOR UPDATE', [requestId],
      )).rows[0]);
      if (!current) return { status: 'missing' };
      if (current.targetVersionId) {
        const existing = versionFromRow((await client.query(
          'SELECT * FROM sj_deliverable_versions WHERE id=$1', [current.targetVersionId],
        )).rows[0]);
        return {
          status: 'already',
          request: current,
          version: existing,
          state: await lockState(client, scope),
        };
      }
      if (expectedRevision !== null && current.revision !== expectedRevision) {
        return { status: 'conflict', request: current };
      }
      if (current.idempotencyKey && requestPatch.idempotencyKey
        && current.idempotencyKey !== requestPatch.idempotencyKey) {
        return { status: 'conflict', request: current };
      }
      const state = await lockState(client, scope);
      const row = { ...version, version: await nextVersionNumber(client, scope) };
      const inserted = (await client.query(INSERT_VERSION, versionParams(row))).rows[0];
      const { values, sets } = buildUpdate(REQUEST_COLUMNS, REQUEST_JSON, requestPatch, 2);
      sets.push('target_version_id=$' + (values.length + 2));
      values.push(row.id);
      const updated = requestFromRow((await client.query(
        `UPDATE sj_refine_requests SET ${sets.join(',')}, revision=revision+1
         WHERE id=$1 RETURNING *`,
        [requestId, ...values],
      )).rows[0]);
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states SET revision=revision+1, updated_at=now()
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId],
      )).rows[0]);
      void state;
      return {
        status: 'ok', request: updated, version: versionFromRow(inserted), state: updatedState,
      };
    });
  }

  async selectCandidate({ scope, versionId, expectedRevision, now, actorId }) {
    return this.#withTransaction(async client => {
      const state = await lockState(client, scope);
      if (state.revision !== expectedRevision) {
        return { status: 'conflict', state };
      }
      const targetRow = (await client.query(
        'SELECT * FROM sj_deliverable_versions WHERE id=$1 FOR UPDATE', [versionId],
      )).rows[0];
      if (!targetRow) return { status: 'missing' };
      const target = versionFromRow(targetRow);
      if (target.workspaceId !== scope.workspaceId || target.projectId !== scope.projectId
        || target.planVersion !== scope.planVersion || target.deliverableId !== scope.deliverableId) {
        return { status: 'missing' };
      }
      const previousCandidateVersionId = state.candidateVersionId ?? null;
      const superseded = (await client.query(
        `UPDATE sj_deliverable_versions
         SET status='superseded', is_candidate=false, updated_at=$5
         WHERE workspace_id=$1 AND project_id=$2 AND plan_version=$3 AND deliverable_id=$4
           AND is_candidate AND id<>$6
         RETURNING id`,
        [scope.workspaceId, scope.projectId, scope.planVersion, scope.deliverableId, now, versionId],
      )).rows.map(row => row.id);
      const updated = (await client.query(
        `UPDATE sj_deliverable_versions
         SET status='candidate', is_candidate=true, updated_at=$2
         WHERE id=$1 RETURNING *`,
        [versionId, now],
      )).rows[0];
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states
         SET current_candidate_version_id=$4, revision=revision+1, updated_at=$5
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId, versionId, now],
      )).rows[0]);
      void actorId;
      return {
        status: 'ok',
        version: versionFromRow(updated),
        state: updatedState,
        previousCandidateVersionId,
        supersededVersionIds: superseded,
      };
    });
  }

  async rework({ scope, versionId, reason, expectedRevision, now, actorId }) {
    return this.#withTransaction(async client => {
      const state = await lockState(client, scope);
      if (state.revision !== expectedRevision) {
        return { status: 'conflict', state };
      }
      const targetRow = (await client.query(
        'SELECT * FROM sj_deliverable_versions WHERE id=$1 FOR UPDATE', [versionId],
      )).rows[0];
      if (!targetRow) return { status: 'missing' };
      const target = versionFromRow(targetRow);
      if (target.workspaceId !== scope.workspaceId || target.projectId !== scope.projectId
        || target.planVersion !== scope.planVersion || target.deliverableId !== scope.deliverableId) {
        return { status: 'missing' };
      }
      const previousStatus = target.status;
      let updatedRow = targetRow;
      if (['candidate', 'approved'].includes(target.status)) {
        updatedRow = (await client.query(
          `UPDATE sj_deliverable_versions
           SET status='draft', is_candidate=false, updated_at=$2
           WHERE id=$1 RETURNING *`,
          [versionId, now],
        )).rows[0];
      }
      const candidateCleared = state.candidateVersionId === versionId;
      const updatedState = stateFromRow((await client.query(
        `UPDATE sj_deliverable_states
         SET current_candidate_version_id = CASE WHEN current_candidate_version_id=$4 THEN NULL
                                                 ELSE current_candidate_version_id END,
             rework_version_id=$4, rework_reason=$5, rework_at=$6, current_step=4,
             revision=revision+1, updated_at=$6
         WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3 RETURNING *`,
        [scope.projectId, scope.planVersion, scope.deliverableId, versionId, reason, now],
      )).rows[0]);
      void actorId;
      return {
        status: 'ok',
        version: versionFromRow(updatedRow),
        previousStatus,
        candidateCleared,
        state: updatedState,
      };
    });
  }

  async findJob(jobId) {
    const row = (await this.pool.query(
      `SELECT id, status, output, input, created_at FROM sj_generation_jobs WHERE id=$1`,
      [jobId],
    )).rows[0];
    if (!row) return null;
    const input = isObject(row.input) ? row.input : {};
    return {
      id: row.id,
      status: row.status,
      output: row.output,
      input,
      workspaceId: input.workspaceId ?? null,
      createdAt: row.created_at,
    };
  }

  async findAssetByJob({ workspaceId, jobId }) {
    const row = (await this.pool.query(
      `SELECT id FROM sj_assets
       WHERE workspace_id=$1 AND source_id=$2
       ORDER BY created_at DESC, id LIMIT 1`,
      [workspaceId, String(jobId)],
    )).rows[0];
    return row ? { id: row.id } : null;
  }
}
