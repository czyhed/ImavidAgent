import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { snapshotProduct } from './products.mjs';
import {
  ASPECT_RATIOS, COPY_SLOTS, MAX_DELIVERABLES, PROMPT_SLOT_KEYS, PROMPT_SLOT_LABELS, TYPE_LIBRARY,
} from './planner.mjs';

// 项目、方案版本与确认冻结（Issue #12 / FLOW-01、FLOW-03、FLOW-04、FLOW-18）。
//
// 一个项目 = 一个商品 × 一个 SKU × 一次交付。方案版本 sj_project_plans 保存交付项清单、
// 类型、数量、提示词槽位、参数与价格快照。确认方案时同时冻结商品资料版本快照与价格；
// 之后修改商品不会影响旧项目。确认后的任何变更创建新的方案版本（v2、v3…），
// 已执行交付项原样保留。编辑使用 revision 乐观锁，冲突返回 409。
//
// 价格只来自 billing 的 quote()/估价，本模块不保存、不推算任何单价；没有价格时
// amountCents 保持 NULL 并标为待核价。前两步来自方案事件，后四步由真实业务证据投影，
// 列表进度使用「六步中已完成数」的 4/6 口径。
export const DEFAULT_WORKSPACE_ID = 'local';
export const PROJECT_STATUSES = Object.freeze(['draft', 'active', 'review', 'completed', 'cancelled']);
export const PLAN_STATUSES = Object.freeze(['draft', 'confirmed']);
export const STEP_STATUSES = Object.freeze(['in_progress', 'completed', 'needs_review', 'skipped']);
export const DELIVERABLE_STATUSES = Object.freeze(['planned', 'executed']);
export const STEPS = Object.freeze([
  Object.freeze({ step: 1, key: 'materials', name: '商品资料' }),
  Object.freeze({ step: 2, key: 'plan', name: '方案报价' }),
  Object.freeze({ step: 3, key: 'production', name: '制作任务' }),
  Object.freeze({ step: 4, key: 'refine', name: '精修' }),
  Object.freeze({ step: 5, key: 'review', name: '质检审核' }),
  Object.freeze({ step: 6, key: 'export', name: '打包导出' }),
]);
export const STEP_COUNT = STEPS.length;
export const MAX_PAGE_SIZE = 100;
export const MAX_REQUIREMENT = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const TIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const IMAGE_CAPABILITIES = ['image.generate', 'image.edit'];
const TYPE_BY_ID = new Map(TYPE_LIBRARY.map(item => [item.type, item]));
// id 用于在编辑草稿时保留已有交付项；其余只读字段允许客户端原样回传，但服务端一律忽略，
// 以服务端保存的编号、执行状态与价格快照为准。
const DELIVERABLE_FIELDS = [
  'id', 'type', 'title', 'purpose', 'quantity', 'prompt', 'copy', 'parameters',
  'typeName', 'promptText', 'price', 'status', 'executedAt', 'jobId', 'versionId', 'executedBy',
];
const PARAMETER_FIELDS = ['capability', 'modelId', 'tier', 'size', 'quality', 'operation', 'templateId'];
const PLAN_PATCH_FIELDS = ['deliverables', 'requirement', 'revision', 'reason', 'changeReason'];
const PROJECT_PATCH_FIELDS = ['name', 'status', 'reason', 'version'];
const CONFIRM_FIELDS = ['revision', 'reason'];

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

function textField(value, label, max, { required = false, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (typeof value !== 'string') fail('INVALID_FIELD', `${label}必须是文本。`);
  const text = value.trim();
  if (!text) {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  if (text.length < min) fail('INVALID_FIELD', `${label}至少需要 ${min} 个字符。`);
  if (text.length > max) fail('INVALID_FIELD', `${label}不能超过 ${max} 个字符。`);
  return text;
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

function integerField(value, label, { min = 0, max = 2_147_483_647, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    fail('INVALID_FIELD', `${label}不能为空。`);
  }
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('INVALID_FIELD', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return number;
}

function dateField(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_DATE', `${label}格式不正确。`);
  return date;
}

function parseRevisionValue(value) {
  const number = typeof value === 'string' && /^r?\d+$/i.test(value.trim())
    ? Number(value.trim().replace(/^r/i, '')) : value;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    fail('INVALID_REVISION', '方案修订号必须是正整数。');
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
    fail('REVISION_REQUIRED', '编辑方案需提供 If-Match 响应头或请求体中的 revision。', 428);
  }
  return value;
}

function parseVersionValue(value) {
  const number = typeof value === 'string' && /^v?\d+$/i.test(value.trim())
    ? Number(value.trim().replace(/^v/i, '')) : value;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    fail('INVALID_VERSION', '方案版本号必须是正整数。');
  }
  return number;
}

function readExpectedVersion(body, ifMatch) {
  let header;
  if (ifMatch !== undefined && ifMatch !== null && ifMatch !== '') {
    header = parseVersionValue(String(ifMatch).trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1'));
  }
  let fromBody;
  if (body && Object.hasOwn(body, 'version')) fromBody = parseVersionValue(body.version);
  if (header !== undefined && fromBody !== undefined && header !== fromBody) {
    fail('INVALID_VERSION', 'If-Match 与请求体 version 不一致。');
  }
  return header ?? fromBody ?? null;
}

function normalizeRequirement(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('INVALID_FIELD', '补充要求必须是文本。');
  const text = value.trim();
  if (text.length > MAX_REQUIREMENT) fail('INVALID_FIELD', `补充要求不能超过 ${MAX_REQUIREMENT} 个字符。`);
  return text || null;
}

function listParam(value, allowed, label) {
  if (value === undefined || value === null || value === '') return [];
  const values = String(value).split(',').map(item => item.trim()).filter(Boolean);
  for (const item of values) {
    if (!allowed.includes(item)) fail('INVALID_FILTER', `${label}筛选值不受支持。`);
  }
  return [...new Set(values)];
}

function normalizeListQuery(query = {}) {
  const raw = query.q ?? query.search ?? '';
  if (raw !== undefined && typeof raw !== 'string') fail('INVALID_SEARCH', '搜索词必须是文本。');
  const q = raw.trim();
  if (q.length > 100) fail('INVALID_SEARCH', '搜索词不能超过 100 个字符。');
  const from = dateField(query.from, '起始时间');
  const to = dateField(query.to, '结束时间');
  if (from && to && from > to) fail('INVALID_DATE', '起始时间不能晚于结束时间。');
  return {
    q,
    statuses: listParam(query.status, PROJECT_STATUSES, '项目状态'),
    from,
    to,
    limit: integerField(query.limit, '每页数量', { min: 1, max: MAX_PAGE_SIZE, fallback: 20 }),
    offset: integerField(query.offset, '分页偏移', { min: 0, max: 1_000_000, fallback: 0 }),
  };
}

function normalizePrompt(raw, type) {
  const library = TYPE_BY_ID.get(type);
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('INVALID_FIELD', '提示词槽位必须是 JSON 对象。');
  for (const key of Object.keys(raw)) {
    if (!PROMPT_SLOT_KEYS.includes(key)) fail('INVALID_FIELD', `提示词包含不支持的槽位：${key}。`);
  }
  const prompt = {};
  for (const key of PROMPT_SLOT_KEYS) {
    if (key === 'aspectRatio') {
      const aspect = raw.aspectRatio === undefined || raw.aspectRatio === null || raw.aspectRatio === ''
        ? library.aspectRatio : raw.aspectRatio;
      if (!ASPECT_RATIOS.includes(aspect)) fail('INVALID_FIELD', '画幅只能是 1:1 或 3:4。');
      prompt.aspectRatio = aspect;
      continue;
    }
    const value = raw[key];
    if (value === undefined || value === null) {
      prompt[key] = '';
      continue;
    }
    if (typeof value !== 'string') fail('INVALID_FIELD', `提示词槽位 ${PROMPT_SLOT_LABELS[key]} 必须是文本。`);
    if (value.length > 300) fail('INVALID_FIELD', `提示词槽位 ${PROMPT_SLOT_LABELS[key]} 不能超过 300 个字符。`);
    prompt[key] = value.trim();
  }
  return prompt;
}

function composePromptText(prompt) {
  return PROMPT_SLOT_KEYS
    .filter(key => prompt[key])
    .map(key => `${PROMPT_SLOT_LABELS[key]}：${prompt[key]}`)
    .join('；');
}

function normalizeCopy(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('INVALID_FIELD', '文案必须是数组。');
  if (raw.length > 3) fail('INVALID_FIELD', '每个交付项最多 3 条文案。');
  const copy = [];
  const seen = new Set();
  for (const entry of raw) {
    requireObject(entry, '文案');
    rejectUnknown(entry, ['slot', 'text'], '文案');
    if (!COPY_SLOTS.includes(entry.slot)) fail('INVALID_FIELD', '文案槽位不受支持。');
    if (seen.has(entry.slot)) fail('INVALID_FIELD', '同一交付项的文案槽位不能重复。');
    seen.add(entry.slot);
    const text = textField(entry.text, '文案内容', 120, { required: true });
    copy.push({ slot: entry.slot, text });
  }
  return copy;
}

function normalizeParameters(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('INVALID_FIELD', '交付项参数必须是 JSON 对象。');
  rejectUnknown(raw, PARAMETER_FIELDS, '交付项参数');
  const operation = raw.operation === undefined || raw.operation === null ? null : String(raw.operation);
  if (operation !== null && !['generate', 'edit'].includes(operation)) {
    fail('INVALID_FIELD', '交付项操作只能是 generate 或 edit。');
  }
  let capability = raw.capability === undefined || raw.capability === null || raw.capability === ''
    ? (operation === 'edit' ? 'image.edit' : 'image.generate')
    : String(raw.capability);
  if (!IMAGE_CAPABILITIES.includes(capability)) {
    fail('INVALID_FIELD', `能力只能是：${IMAGE_CAPABILITIES.join('、')}。`);
  }
  const parameters = { capability };
  if (operation !== null) parameters.operation = operation;
  if (raw.modelId !== undefined && raw.modelId !== null && raw.modelId !== '') {
    const modelId = String(raw.modelId).trim();
    if (!MODEL_ID.test(modelId)) fail('INVALID_FIELD', '模型编号格式不正确。');
    parameters.modelId = modelId;
  }
  if (raw.tier !== undefined && raw.tier !== null && raw.tier !== '') {
    const tier = String(raw.tier).trim();
    if (!TIER.test(tier)) fail('INVALID_FIELD', '价格档位格式不正确。');
    parameters.tier = tier;
  }
  for (const [key, max] of [['size', 100], ['quality', 100], ['templateId', 200]]) {
    const value = textField(raw[key], key === 'templateId' ? '模板编号' : key === 'size' ? '尺寸' : '质量', max);
    if (value !== null) parameters[key] = value;
  }
  return parameters;
}

// 只规范化内容字段；编号、执行状态与价格由服务端拥有。
function normalizeDeliverableDefinition(raw) {
  requireObject(raw, '交付项');
  rejectUnknown(raw, DELIVERABLE_FIELDS, '交付项');
  if (!TYPE_BY_ID.has(raw.type)) fail('INVALID_TYPE', '交付项类型不在类型库内。');
  const library = TYPE_BY_ID.get(raw.type);
  const title = textField(raw.title, '交付项标题', 200, { required: true });
  const purpose = textField(raw.purpose, '用途说明', 500);
  const quantity = integerField(raw.quantity, '交付项数量', { min: 1, max: 3, fallback: 1 });
  const prompt = normalizePrompt(raw.prompt, raw.type);
  return {
    type: raw.type,
    typeName: library.name,
    title,
    purpose,
    quantity,
    prompt,
    promptText: composePromptText(prompt),
    copy: normalizeCopy(raw.copy),
    parameters: normalizeParameters(raw.parameters),
  };
}

function definitionOf(deliverable) {
  return {
    type: deliverable.type,
    title: deliverable.title,
    purpose: deliverable.purpose ?? null,
    quantity: deliverable.quantity,
    prompt: deliverable.prompt,
    copy: deliverable.copy || [],
    parameters: deliverable.parameters || {},
  };
}

function sameDefinition(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 价格快照：字段全部来自 billing.quote()。没有模型或没有价格时 amountCents 保持 NULL。
function pendingPrice(base, now) {
  return {
    priced: false,
    status: 'pending_price',
    billingMode: 'chargeable',
    capability: base.parameters.capability || 'image.generate',
    modelId: base.parameters.modelId || null,
    tier: base.parameters.tier || 'default',
    quantity: base.quantity,
    currency: 'CNY',
    amountCents: null,
    unit: null,
    unitPrice: null,
    priceId: null,
    priceVersion: null,
    quotedAt: now.toISOString(),
  };
}

async function quotePrice(base, billing, now, cached) {
  if (cached) return cached;
  const modelId = base.parameters?.modelId;
  if (!billing || !modelId) return pendingPrice(base, now);
  const quote = await billing.quote({
    capability: base.parameters.capability || 'image.generate',
    modelId,
    tier: base.parameters.tier || 'default',
    quantity: base.quantity,
  });
  return {
    priced: quote.priced === true,
    status: quote.status,
    billingMode: quote.billingMode,
    capability: quote.capability,
    modelId: quote.modelId,
    tier: quote.tier,
    quantity: quote.quantity,
    currency: quote.currency,
    amountCents: quote.amountCents === undefined ? null : quote.amountCents,
    unit: quote.unit ?? null,
    unitPrice: quote.unitPrice ?? null,
    priceId: quote.priceId ?? null,
    priceVersion: quote.priceVersion ?? null,
    quotedAt: now.toISOString(),
  };
}

export function summarizePrices(deliverables) {
  let totalCents = 0;
  let pricedCount = 0;
  let pendingPriceCount = 0;
  for (const deliverable of deliverables) {
    const price = deliverable.price || {};
    if (price.amountCents === null || price.amountCents === undefined) pendingPriceCount += 1;
    else {
      totalCents += price.amountCents;
      pricedCount += 1;
    }
  }
  return {
    currency: 'CNY',
    totalCents,
    pricedCount,
    pendingPriceCount,
    hasPendingPrice: pendingPriceCount > 0,
    deliverableCount: deliverables.length,
  };
}

async function buildNewDeliverable(raw, billing, now) {
  const definition = normalizeDeliverableDefinition(raw);
  return {
    id: randomUUID(),
    ...definition,
    status: 'planned',
    executedAt: null,
    jobId: null,
    price: await quotePrice(definition, billing, now),
  };
}

// 替换草稿清单：已有草稿项保留编号；已执行项必须原样保留，不能删除或改写。
async function replaceDeliverables(rawList, existing, billing, now) {
  if (!Array.isArray(rawList)) fail('INVALID_FIELD', '交付项必须是数组。');
  if (rawList.length > MAX_DELIVERABLES) {
    fail('DELIVERABLE_LIMIT', `每个方案版本最多 ${MAX_DELIVERABLES} 个交付项。`);
  }
  const existingById = new Map(existing.map(item => [item.id, item]));
  const seen = new Set();
  const result = [];
  for (const raw of rawList) {
    requireObject(raw, '交付项');
    let current = null;
    if (Object.hasOwn(raw, 'id') && raw.id !== null && raw.id !== '') {
      const id = uuidField(raw.id, '交付项编号');
      if (seen.has(id)) fail('INVALID_FIELD', '交付项编号不能重复。');
      current = existingById.get(id) || null;
      if (!current) fail('DELIVERABLE_NOT_FOUND', '交付项不属于当前方案版本。', 404);
      seen.add(id);
    }
    const definition = normalizeDeliverableDefinition(raw);
    if (current?.status === 'executed') {
      if (!sameDefinition(definition, definitionOf(current))) {
        fail('DELIVERABLE_LOCKED', '已执行交付项不能再修改；请追加新的交付项。', 409);
      }
      result.push(structuredClone(current));
      continue;
    }
    result.push({
      id: current?.id || randomUUID(),
      ...definition,
      status: 'planned',
      executedAt: null,
      jobId: null,
      price: await quotePrice(definition, billing, now),
    });
  }
  // 已执行项即使没有被客户端回传，也必须留在清单里。
  for (const item of existing) {
    if (item.status === 'executed' && !seen.has(item.id)) {
      fail('DELIVERABLE_LOCKED', '已执行交付项不能从方案中删除。', 409);
    }
  }
  return result;
}

async function quoteExisting(deliverables, billing, now) {
  const result = [];
  for (const deliverable of deliverables) {
    if (deliverable.status === 'executed') {
      result.push(structuredClone(deliverable));
      continue;
    }
    const base = { ...deliverable, parameters: deliverable.parameters || {} };
    result.push({
      ...structuredClone(deliverable),
      price: await quotePrice(base, billing, now),
    });
  }
  return result;
}

function emptySteps() {
  return STEPS.map(definition => ({
    ...definition,
    status: 'pending',
    note: null,
    updatedAt: null,
  }));
}

export function computeSteps(events = []) {
  const latest = new Map();
  for (const event of events) latest.set(event.step, event);
  const steps = STEPS.map(definition => {
    const event = latest.get(definition.step);
    return {
      ...definition,
      status: event?.status || 'pending',
      note: event?.note ?? null,
      updatedAt: event?.createdAt ?? null,
    };
  });
  return summarizeStepState(steps);
}

function summarizeStepState(steps) {
  const completed = steps.filter(item => item.status === 'completed').length;
  const current = steps.find(item => !['completed', 'skipped'].includes(item.status)) || null;
  return {
    steps,
    completed,
    total: STEP_COUNT,
    label: `${completed}/${STEP_COUNT}`,
    progress: { completed, total: STEP_COUNT, label: `${completed}/${STEP_COUNT}` },
    currentStep: current ? { ...current } : null,
  };
}

export const projectLifecycleKey = (projectId, planVersion) => `${projectId}:${planVersion}`;

export function computeProjectStepState({ project, plan, events = [], evidence = null } = {}) {
  const steps = computeSteps(events).steps.map(item => ({ ...item }));
  if (!evidence) return summarizeStepState(steps);

  const hasConfirmedPlan = plan?.status === 'confirmed'
    || ['active', 'review', 'completed'].includes(project?.status);
  if (plan?.status !== 'confirmed') {
    if (hasConfirmedPlan) {
      steps[1] = { ...steps[1], status: 'in_progress', note: '当前方案版本尚未确认', updatedAt: null };
    }
    for (let index = 2; index < steps.length; index += 1) {
      steps[index] = { ...steps[index], status: 'pending', note: null, updatedAt: null };
    }
    return summarizeStepState(steps);
  }

  const deliverables = plan.deliverables || [];
  const latestRuns = new Map((evidence.runs || []).map(run => [run.deliverableId, run.status]));
  const produced = new Set(evidence.producedDeliverableIds || []);
  const candidates = new Set(evidence.candidateDeliverableIds || []);
  const approved = new Set(evidence.approvedDeliverableIds || []);
  const allHave = predicate => deliverables.length > 0 && deliverables.every(predicate);
  const runStatuses = deliverables.map(item => latestRuns.get(item.id)).filter(Boolean);
  const failedRun = runStatuses.some(status => ['partial_failed', 'failed', 'cancelled', 'unknown'].includes(status));
  const activeRun = runStatuses.some(status => status === 'running');
  const productionComplete = allHave(item => latestRuns.has(item.id)
    ? latestRuns.get(item.id) === 'succeeded' : produced.has(item.id));

  steps[2] = {
    ...steps[2],
    status: productionComplete ? 'completed'
      : failedRun ? 'needs_review'
        : activeRun || runStatuses.some(status => status === 'succeeded') ? 'in_progress' : 'pending',
    note: productionComplete ? '当前方案所有交付项均已成功执行'
      : failedRun ? '存在失败、取消或未知运行，需要人工处理'
        : null,
    updatedAt: null,
  };

  const candidatesComplete = allHave(item => candidates.has(item.id));
  steps[3] = {
    ...steps[3],
    status: candidatesComplete ? 'completed' : productionComplete ? 'in_progress' : 'pending',
    note: candidatesComplete ? '所有交付项均已显式选定候选' : null,
    updatedAt: null,
  };

  const reviewsComplete = allHave(item => approved.has(item.id));
  steps[4] = {
    ...steps[4],
    status: reviewsComplete ? 'completed' : candidatesComplete ? 'in_progress' : 'pending',
    note: reviewsComplete ? '所有当前候选均已通过审核' : null,
    updatedAt: null,
  };

  const exported = productionComplete && candidatesComplete && reviewsComplete
    && (evidence.exports || []).some(item => item.status === 'completed'
      && item.missingCount === 0 && item.matchesCurrentCandidates === true);
  steps[5] = {
    ...steps[5],
    status: exported ? 'completed' : reviewsComplete ? 'in_progress' : 'pending',
    note: exported ? '当前所有审核候选均已完整导出' : null,
    updatedAt: null,
  };
  return summarizeStepState(steps);
}

export function deriveProjectStatus(project, stepState, confirmed = false) {
  if (project?.status === 'cancelled') return 'cancelled';
  if (!confirmed) return 'draft';
  // 当前步骤是第一个未完成/未跳过的步骤；全部结束后项目才算完成。
  if (!stepState.currentStep) return 'completed';
  return stepState.currentStep.step === 5 ? 'review' : 'active';
}

function stepEvent(project, step, status, { actorId = null, note = null, source = 'user', at }) {
  const definition = STEPS.find(item => item.step === step);
  return {
    id: randomUUID(),
    projectId: project.id,
    workspaceId: project.workspaceId,
    step,
    stepKey: definition.key,
    status,
    source,
    note,
    actorId,
    createdAt: at,
  };
}

function publicDeliverable(deliverable) {
  return structuredClone(deliverable);
}

export function publicPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    version: plan.version,
    status: plan.status,
    revision: plan.revision,
    requirement: plan.requirement ?? null,
    deliverables: (plan.deliverables || []).map(publicDeliverable),
    price: plan.price ? structuredClone(plan.price) : summarizePrices(plan.deliverables || []),
    productVersion: plan.productVersion ?? null,
    productSnapshot: plan.productSnapshot ?? null,
    skuSnapshot: plan.skuSnapshot ?? null,
    changeReason: plan.changeReason ?? null,
    confirmedAt: plan.confirmedAt ?? null,
    confirmedBy: plan.confirmedBy ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function planSummary(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    version: plan.version,
    status: plan.status,
    revision: plan.revision,
    requirement: plan.requirement ?? null,
    deliverableCount: (plan.deliverables || []).length,
    price: plan.price ? structuredClone(plan.price) : summarizePrices(plan.deliverables || []),
    productVersion: plan.productVersion ?? null,
    confirmedAt: plan.confirmedAt ?? null,
    confirmedBy: plan.confirmedBy ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function publicProject(project, plan, stepState, status = project.status) {
  return {
    id: project.id,
    name: project.name,
    status,
    productId: project.productId,
    skuId: project.skuId,
    skuSpec: project.skuSpec ?? null,
    ownerId: project.ownerId ?? null,
    version: project.version,
    currentPlanVersion: project.currentPlanVersion,
    planStatus: plan?.status ?? null,
    progress: stepState.progress,
    currentStep: stepState.currentStep,
    estimate: plan?.price ? structuredClone(plan.price) : summarizePrices([]),
    cancelledAt: project.cancelledAt ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export class ProjectService {
  constructor(repository, { workspaceId = DEFAULT_WORKSPACE_ID, products = null, billing = null, now = () => new Date() } = {}) {
    if (!repository) throw new AppError('PROJECT_STORE_UNAVAILABLE', '项目存储未配置。', 500);
    this.repository = repository;
    this.workspaceId = workspaceId;
    this.products = products;
    this.billing = billing;
    this.now = now;
  }

  async #product(productId) {
    if (!this.products) throw new AppError('PRODUCT_LOOKUP_UNAVAILABLE', '商品档案暂不可用。', 503);
    return this.products.get(productId);
  }

  async #events(projectId) {
    return this.repository.listEvents(projectId);
  }

  async #lifecycleEvidence(scopes) {
    if (typeof this.repository.getLifecycleEvidence !== 'function') return null;
    return this.repository.getLifecycleEvidence(scopes);
  }

  async #renderProjects(rows, evidenceByProject = null) {
    const scopes = rows.map(row => ({
      projectId: row.project.id,
      planVersion: row.project.currentPlanVersion,
      deliverableIds: (row.plan?.deliverables || []).map(item => item.id),
    }));
    const evidence = evidenceByProject || await this.#lifecycleEvidence(scopes);
    return Promise.all(rows.map(async row => {
      const events = await this.#events(row.project.id);
      const key = projectLifecycleKey(row.project.id, row.project.currentPlanVersion);
      const stepState = computeProjectStepState({
        project: row.project,
        plan: row.plan,
        events,
        evidence: evidence?.get(key) ?? null,
      });
      const hasConfirmedPlan = row.plan?.status === 'confirmed'
        || ['active', 'review', 'completed'].includes(row.project.status);
      const status = deriveProjectStatus(row.project, stepState, hasConfirmedPlan);
      return publicProject(row.project, row.plan, stepState, status);
    }));
  }

  async #detail(project, events = null) {
    const plan = await this.repository.getPlan(project.id, project.currentPlanVersion);
    const plans = await this.repository.listPlans(project.id);
    const eventRows = events || await this.#events(project.id);
    const evidence = await this.#lifecycleEvidence([{
      projectId: project.id,
      planVersion: project.currentPlanVersion,
      deliverableIds: (plan?.deliverables || []).map(item => item.id),
    }]);
    const stepState = computeProjectStepState({
      project,
      plan,
      events: eventRows,
      evidence: evidence?.get(projectLifecycleKey(project.id, project.currentPlanVersion)) ?? null,
    });
    const status = deriveProjectStatus(project, stepState, plans.some(item => item.status === 'confirmed'));
    return {
      project: publicProject(project, plan, stepState, status),
      plan: publicPlan(plan),
      plans: plans.map(planSummary),
      steps: stepState.steps,
      progress: stepState.progress,
      currentStep: stepState.currentStep,
    };
  }

  async list(query = {}) {
    const filters = normalizeListQuery(query);
    let projects;
    let total;
    if (filters.statuses.length) {
      const scanFilters = { ...filters, statuses: [], limit: MAX_PAGE_SIZE, offset: 0 };
      const matched = [];
      let scanOffset = 0;
      let sourceTotal = 0;
      do {
        const page = await this.repository.list({ ...scanFilters, offset: scanOffset });
        sourceTotal = page.total;
        const rendered = await this.#renderProjects(page.rows);
        matched.push(...rendered.filter(project => filters.statuses.includes(project.status)));
        scanOffset += page.rows.length;
        if (!page.rows.length) break;
      } while (scanOffset < sourceTotal);
      total = matched.length;
      projects = matched.slice(filters.offset, filters.offset + filters.limit);
    } else {
      const result = await this.repository.list(filters);
      total = result.total;
      projects = await this.#renderProjects(result.rows);
    }
    return {
      projects,
      total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset: filters.offset + projects.length < total ? filters.offset + projects.length : null,
    };
  }

  async get(id) {
    const project = await this.repository.getProject(uuidField(id, '项目编号'));
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    return this.#detail(project);
  }

  async create(body, { actorId = null, ownerId = null } = {}) {
    requireObject(body);
    rejectUnknown(body, ['name', 'productId', 'skuId', 'requirement', 'deliverables', 'reason', 'ownerId'], '项目');
    const productId = uuidField(body.productId, '商品编号');
    const skuId = uuidField(body.skuId, 'SKU 编号');
    const product = await this.#product(productId);
    const sku = (product.skus || []).find(item => item.id === skuId);
    if (!sku) throw new AppError('SKU_NOT_FOUND', '该 SKU 不属于所选商品。', 404);
    const now = this.now();
    const deliverables = await replaceDeliverables(body.deliverables ?? [], [], this.billing, now);
    const fallbackName = `${product.name}${sku.spec ? ` · ${sku.spec}` : ''}`.slice(0, 200);
    const name = textField(body.name, '项目名称', 200) || fallbackName;
    const requirement = normalizeRequirement(body.requirement);
    const project = {
      id: randomUUID(),
      workspaceId: this.workspaceId,
      name,
      productId,
      skuId,
      skuSpec: sku.spec ?? null,
      ownerId: body.ownerId === undefined || body.ownerId === null
        ? (ownerId || actorId || null) : textField(body.ownerId, '负责人', 200),
      status: 'draft',
      version: 1,
      currentPlanVersion: 1,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const plan = {
      id: randomUUID(),
      projectId: project.id,
      workspaceId: this.workspaceId,
      version: 1,
      status: 'draft',
      revision: 1,
      requirement,
      deliverables,
      productVersion: null,
      productSnapshot: null,
      skuSnapshot: null,
      price: summarizePrices(deliverables),
      changeReason: textField(body.reason, '修改原因', 500) || '创建项目方案草稿',
      confirmedAt: null,
      confirmedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.repository.createProject({ project, plan });
    return this.#detail(created.project, []);
  }

  async update(id, body, { ifMatch, actorId = null } = {}) {
    const projectId = uuidField(id, '项目编号');
    requireObject(body);
    rejectUnknown(body, PROJECT_PATCH_FIELDS, '项目');
    const expectedVersion = readExpectedVersion(body, ifMatch);
    if (expectedVersion === null) {
      fail('VERSION_REQUIRED', '编辑项目需提供 If-Match 响应头或请求体中的 version。', 428);
    }
    const patch = {};
    if (Object.hasOwn(body, 'name')) patch.name = textField(body.name, '项目名称', 200, { required: true });
    if (Object.hasOwn(body, 'status')) {
      if (body.status !== 'cancelled') fail('INVALID_STATUS', '编辑接口只支持取消项目；其他状态由步骤事件推进。');
      patch.status = 'cancelled';
    }
    const reason = textField(body.reason, '修改原因', 500);
    const result = await this.repository.updateProject(projectId, expectedVersion, current => ({
      ...current,
      ...patch,
      cancelledAt: patch.status === 'cancelled' ? this.now() : current.cancelledAt ?? null,
      reason,
    }));
    if (result.status === 'missing') throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (result.status === 'conflict') {
      throw new AppError('VERSION_CONFLICT', `项目已被其他修改更新到 v${result.currentVersion}，请刷新后重试。`, 409);
    }
    return this.#detail(result.project);
  }

  async plans(id) {
    const projectId = uuidField(id, '项目编号');
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    const plans = await this.repository.listPlans(projectId);
    return { projectId, currentPlanVersion: project.currentPlanVersion, plans: plans.map(planSummary) };
  }

  async plan(id, version) {
    const projectId = uuidField(id, '项目编号');
    const planVersion = parseVersionValue(version);
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    const plan = await this.repository.getPlan(projectId, planVersion);
    if (!plan) throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    return { projectId, plan: publicPlan(plan) };
  }

  async updatePlan(id, version, body, { ifMatch } = {}) {
    const projectId = uuidField(id, '项目编号');
    const planVersion = parseVersionValue(version);
    requireObject(body);
    rejectUnknown(body, PLAN_PATCH_FIELDS, '方案');
    const expectedRevision = readExpectedRevision(body, ifMatch);
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    const current = await this.repository.getPlan(projectId, planVersion);
    if (!current) throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    if (current.status === 'confirmed') {
      throw new AppError('PLAN_CONFIRMED', '已确认方案不可修改；追加交付项会生成新的方案版本。', 409);
    }
    if (body.deliverables === undefined) fail('INVALID_FIELD', '请提供完整的交付项清单。');
    const now = this.now();
    const deliverables = await replaceDeliverables(body.deliverables, current.deliverables || [], this.billing, now);
    const requirement = Object.hasOwn(body, 'requirement')
      ? normalizeRequirement(body.requirement) : current.requirement;
    const result = await this.repository.updatePlan(projectId, planVersion, expectedRevision, {
      deliverables,
      requirement,
      price: summarizePrices(deliverables),
      changeReason: textField(body.changeReason ?? body.reason, '修改原因', 500) || '编辑方案草稿',
      updatedAt: now,
    });
    if (result.status === 'missing') throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (result.status === 'plan_missing') throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    if (result.status === 'confirmed') {
      throw new AppError('PLAN_CONFIRMED', '已确认方案不可修改；追加交付项会生成新的方案版本。', 409);
    }
    if (result.status === 'conflict') {
      throw new AppError(
        'VERSION_CONFLICT',
        `方案已被其他修改更新到修订 r${result.currentRevision}，请刷新后重试。`,
        409,
      );
    }
    return { projectId, plan: publicPlan(result.plan) };
  }

  // 确认后追加交付项：复制当前已确认清单生成下一版草稿，已执行项原样保留。
  async addDeliverables(id, version, body, { ifMatch } = {}) {
    const projectId = uuidField(id, '项目编号');
    const planVersion = parseVersionValue(version);
    requireObject(body);
    rejectUnknown(body, ['deliverables', 'requirement', 'revision', 'reason', 'changeReason'], '追加交付项');
    const expectedRevision = readExpectedRevision(body, ifMatch);
    if (!Array.isArray(body.deliverables) || body.deliverables.length === 0) {
      fail('INVALID_FIELD', '请提供至少一个要追加的交付项。');
    }
    if (body.deliverables.length > MAX_DELIVERABLES) {
      fail('DELIVERABLE_LIMIT', `每个方案版本最多 ${MAX_DELIVERABLES} 个交付项。`);
    }
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    const current = await this.repository.getPlan(projectId, planVersion);
    if (!current) throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    if (project.currentPlanVersion !== planVersion) {
      throw new AppError('PLAN_CONFLICT', '只能向当前方案版本追加交付项；请刷新后重试。', 409);
    }
    if (current.revision !== expectedRevision) {
      throw new AppError(
        'VERSION_CONFLICT',
        `方案已被其他修改更新到修订 r${current.revision}，请刷新后重试。`,
        409,
      );
    }
    const now = this.now();
    const additions = [];
    for (const raw of body.deliverables) additions.push(await buildNewDeliverable(raw, this.billing, now));
    if (current.status === 'draft') {
      if ((current.deliverables || []).length + additions.length > MAX_DELIVERABLES) {
        fail('DELIVERABLE_LIMIT', `每个方案版本最多 ${MAX_DELIVERABLES} 个交付项。`);
      }
      const deliverables = [...(current.deliverables || []), ...additions];
      const result = await this.repository.updatePlan(projectId, planVersion, expectedRevision, {
        deliverables,
        requirement: Object.hasOwn(body, 'requirement')
          ? normalizeRequirement(body.requirement) : current.requirement,
        price: summarizePrices(deliverables),
        changeReason: textField(body.changeReason ?? body.reason, '修改原因', 500) || '追加交付项',
        updatedAt: now,
      });
      if (result.status === 'conflict') {
        throw new AppError('VERSION_CONFLICT', '方案已被其他修改更新，请刷新后重试。', 409);
      }
      if (result.status === 'confirmed') {
        throw new AppError('PLAN_CONFLICT', '方案刚被其他操作确认，请刷新后重试。', 409);
      }
      const fresh = await this.repository.getProject(projectId);
      return this.#detail(fresh || project);
    }
    const copies = (current.deliverables || []).map(item => structuredClone(item));
    if (copies.length + additions.length > MAX_DELIVERABLES) {
      fail('DELIVERABLE_LIMIT', `每个方案版本最多 ${MAX_DELIVERABLES} 个交付项。`);
    }
    const deliverables = [...copies, ...additions];
    const next = {
      id: randomUUID(),
      projectId,
      workspaceId: project.workspaceId,
      version: planVersion + 1,
      status: 'draft',
      revision: 1,
      requirement: Object.hasOwn(body, 'requirement')
        ? normalizeRequirement(body.requirement) : current.requirement,
      deliverables,
      productVersion: null,
      productSnapshot: null,
      skuSnapshot: null,
      price: summarizePrices(deliverables),
      changeReason: textField(body.changeReason ?? body.reason, '修改原因', 500)
        || `基于 v${planVersion} 追加交付项`,
      confirmedAt: null,
      confirmedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.repository.createPlanVersion({
      projectId,
      expectedCurrentVersion: planVersion,
      expectedProjectVersion: project.version,
      plan: next,
      projectPatch: { status: project.status, updatedAt: now },
    });
    if (result.status === 'missing') throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (result.status === 'conflict') {
      throw new AppError('VERSION_CONFLICT', '项目方案已被其他修改更新，请刷新后重试。', 409);
    }
    return this.#detail(result.project);
  }

  async confirmPlan(id, version, body = {}, { ifMatch, actorId = null } = {}) {
    const projectId = uuidField(id, '项目编号');
    const planVersion = parseVersionValue(version);
    requireObject(body);
    rejectUnknown(body, CONFIRM_FIELDS, '确认方案');
    const expectedRevision = readExpectedRevision(body, ifMatch);
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (project.status === 'cancelled') throw new AppError('PROJECT_CANCELLED', '已取消项目不能确认方案。', 409);
    const current = await this.repository.getPlan(projectId, planVersion);
    if (!current) throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    if (current.status === 'confirmed') {
      throw new AppError('PLAN_CONFIRMED', '该方案版本已经确认。', 409);
    }
    if (project.currentPlanVersion !== planVersion) {
      throw new AppError('PLAN_CONFLICT', '只能确认当前方案版本。', 409);
    }
    if (!(current.deliverables || []).length) {
      throw new AppError('PLAN_EMPTY', '方案中没有交付项，不能确认。', 409);
    }
    const product = await this.#product(project.productId);
    if (product.status !== 'confirmed') {
      throw new AppError('PRODUCT_NOT_CONFIRMED', '确认方案前需先确认商品资料。', 409);
    }
    const sku = (product.skus || []).find(item => item.id === project.skuId);
    if (!sku) throw new AppError('SKU_NOT_FOUND', '项目引用的 SKU 已不存在，请更新项目。', 409);

    const now = this.now();
    const deliverables = await quoteExisting(current.deliverables, this.billing, now);
    const price = summarizePrices(deliverables);
    const reason = textField(body.reason, '确认说明', 500) || '确认方案并冻结资料与价格';
    const prior = await this.#events(projectId);
    const events = [
      stepEvent(project, 1, 'completed', {
        actorId, note: `冻结商品资料 v${product.version}`, source: 'system', at: now,
      }),
      stepEvent(project, 2, 'completed', {
        actorId, note: `确认方案 v${planVersion}`, source: 'system', at: now,
      }),
    ];
    const stepState = computeSteps([...prior, ...events]);
    const status = deriveProjectStatus(project, stepState, true);
    const result = await this.repository.confirmPlan({
      projectId,
      version: planVersion,
      expectedRevision,
      planPatch: {
        status: 'confirmed',
        deliverables,
        price,
        productVersion: product.version,
        productSnapshot: snapshotProduct(product),
        skuSnapshot: structuredClone(sku),
        confirmedAt: now,
        confirmedBy: actorId || 'local',
        updatedAt: now,
        changeReason: reason,
      },
      events,
      projectPatch: { status, updatedAt: now },
    });
    if (result.status === 'missing') throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (result.status === 'plan_missing') throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    if (result.status === 'conflict') {
      throw new AppError(
        'VERSION_CONFLICT',
        `方案已被其他修改更新到修订 r${result.currentRevision}，请刷新后重试。`,
        409,
      );
    }
    if (result.status === 'confirmed') {
      throw new AppError('PLAN_CONFIRMED', '该方案版本已经确认。', 409);
    }
    return this.#detail(result.project, [...prior, ...events]);
  }

  async recordStepEvent(id, stepValue, body = {}, { actorId = null } = {}) {
    if (typeof this.repository.getLifecycleEvidence === 'function') {
      throw new AppError('STEP_DERIVED', '项目步骤由方案、工作流、交付候选、审核和导出状态自动更新。', 409);
    }
    const projectId = uuidField(id, '项目编号');
    const step = integerField(stepValue, '步骤', { min: 1, max: STEP_COUNT });
    requireObject(body);
    rejectUnknown(body, ['status', 'note'], '步骤事件');
    if (!STEP_STATUSES.includes(body.status)) {
      fail('INVALID_STEP_STATUS', `步骤状态只能是：${STEP_STATUSES.join('、')}。`);
    }
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (project.status === 'cancelled') throw new AppError('PROJECT_CANCELLED', '已取消项目不能再推进步骤。', 409);
    const confirmed = (await this.repository.listPlans(projectId))
      .some(plan => plan.status === 'confirmed');
    if (!confirmed) throw new AppError('PLAN_NOT_CONFIRMED', '确认方案后才能推进生产步骤。', 409);
    const prior = await this.#events(projectId);
    // 六步按顺序推进：完成/跳过后面的步骤前，前面的步骤必须已经完成或跳过。
    // 允许把已完成的步骤重新标为进行中（返工），此时后续步骤会重新变为未完成。
    if (['completed', 'skipped'].includes(body.status)) {
      const open = computeSteps(prior).steps
        .find(item => item.step < step && !['completed', 'skipped'].includes(item.status));
      if (open) {
        throw new AppError('STEP_OUT_OF_ORDER', `请先完成第 ${open.step} 步（${open.label}）。`, 409);
      }
    }
    const now = this.now();
    const event = stepEvent(project, step, body.status, {
      actorId,
      note: textField(body.note, '事件说明', 500),
      source: 'user',
      at: now,
    });
    const stepState = computeSteps([...prior, event]);
    const status = deriveProjectStatus(project, stepState, true);
    const updated = await this.repository.appendEvents({
      projectId,
      events: [event],
      projectPatch: { status, updatedAt: now },
    });
    return this.#detail(updated, [...prior, event]);
  }

  // 执行模块（#14）在此登记交付项已产出；只改当前方案里的执行状态，不改方案内容。
  async markDeliverableExecuted(id, deliverableId, body = {}, { actorId = null } = {}) {
    const projectId = uuidField(id, '项目编号');
    const targetId = uuidField(deliverableId, '交付项编号');
    requireObject(body);
    rejectUnknown(body, ['jobId', 'versionId'], '执行登记');
    const jobId = textField(body.jobId, '生成任务编号', 200);
    const versionId = textField(body.versionId, '版本编号', 200);
    const project = await this.repository.getProject(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    const plan = await this.repository.getPlan(projectId, project.currentPlanVersion);
    if (!plan) throw new AppError('PLAN_NOT_FOUND', '当前方案版本不存在。', 404);
    if (plan.status !== 'confirmed') {
      throw new AppError('PLAN_NOT_CONFIRMED', '确认方案后才能登记已执行交付项。', 409);
    }
    const index = (plan.deliverables || []).findIndex(item => item.id === targetId);
    if (index < 0) throw new AppError('DELIVERABLE_NOT_FOUND', '交付项不属于当前方案版本。', 404);
    if (plan.deliverables[index].status === 'executed') {
      return { projectId, planVersion: plan.version, deliverable: publicDeliverable(plan.deliverables[index]), created: false };
    }
    const now = this.now();
    const deliverables = plan.deliverables.map(item => (item.id === targetId ? {
      ...item,
      status: 'executed',
      executedAt: now.toISOString(),
      jobId: jobId || item.jobId || null,
      versionId: versionId || item.versionId || null,
      executedBy: actorId || 'local',
    } : item));
    const result = await this.repository.updatePlan(projectId, plan.version, plan.revision, {
      deliverables,
      price: plan.price,
      updatedAt: now,
      allowConfirmed: true,
      changeReason: '登记交付项已执行',
    });
    if (result.status === 'conflict') {
      throw new AppError('VERSION_CONFLICT', '方案已被其他操作更新，请刷新后重试。', 409);
    }
    if (result.status === 'plan_missing') throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    const deliverable = (result.plan.deliverables || []).find(item => item.id === targetId);
    return { projectId, planVersion: plan.version, deliverable: publicDeliverable(deliverable), created: true };
  }
}

// ---- PostgreSQL 仓储 ----

function projectFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    productId: row.product_id,
    skuId: row.sku_id,
    skuSpec: row.sku_spec,
    ownerId: row.owner_id,
    status: row.status,
    version: row.version,
    currentPlanVersion: row.current_plan_version,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    version: row.version,
    status: row.status,
    revision: row.revision,
    requirement: row.requirement,
    deliverables: Array.isArray(row.deliverables) ? row.deliverables : [],
    productVersion: row.product_version,
    productSnapshot: row.product_snapshot,
    skuSnapshot: row.sku_snapshot,
    price: row.price && typeof row.price === 'object' ? row.price : {},
    changeReason: row.change_reason,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    step: row.step,
    stepKey: row.step_key,
    status: row.status,
    source: row.source,
    note: row.note,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

const INSERT_PROJECT = `
  INSERT INTO sj_projects (
    id, workspace_id, name, product_id, sku_id, sku_spec, owner_id,
    status, version, current_plan_version, cancelled_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  RETURNING *`;

const INSERT_PLAN = `
  INSERT INTO sj_project_plans (
    id, project_id, workspace_id, version, status, revision, requirement, deliverables,
    product_version, product_snapshot, sku_snapshot, price, change_reason,
    confirmed_at, confirmed_by
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15)
  RETURNING *`;

const INSERT_EVENT = `
  INSERT INTO sj_project_events (
    id, project_id, workspace_id, step, step_key, status, source, note, actor_id, created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  RETURNING *`;

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

export class PgProjectRepository {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async createProject({ project, plan }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const projectRow = (await client.query(INSERT_PROJECT, [
        project.id, project.workspaceId, project.name, project.productId, project.skuId,
        project.skuSpec, project.ownerId, project.status, project.version,
        project.currentPlanVersion, project.cancelledAt,
      ])).rows[0];
      const planRow = (await client.query(INSERT_PLAN, [
        plan.id, plan.projectId, plan.workspaceId, plan.version, plan.status, plan.revision,
        plan.requirement, JSON.stringify(plan.deliverables), plan.productVersion,
        JSON.stringify(plan.productSnapshot), JSON.stringify(plan.skuSnapshot),
        JSON.stringify(plan.price), plan.changeReason, plan.confirmedAt, plan.confirmedBy,
      ])).rows[0];
      await client.query('COMMIT');
      return { project: projectFromRow(projectRow), plan: planFromRow(planRow) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getProject(id) {
    const row = (await this.pool.query(
      'SELECT * FROM sj_projects WHERE id=$1 AND workspace_id=$2',
      [id, this.workspaceId],
    )).rows[0];
    return row ? projectFromRow(row) : null;
  }

  async list(filters) {
    const where = ['p.workspace_id = $1'];
    const params = [this.workspaceId];
    if (filters.q) {
      params.push(`%${escapeLike(filters.q)}%`);
      const token = `$${params.length}`;
      where.push(`(p.name ILIKE ${token} ESCAPE '\\' OR p.sku_spec ILIKE ${token} ESCAPE '\\')`);
    }
    if (filters.statuses.length) {
      params.push(filters.statuses);
      where.push(`p.status = ANY($${params.length}::text[])`);
    }
    if (filters.from) {
      params.push(filters.from);
      where.push(`p.updated_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`p.updated_at <= $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const total = (await this.pool.query(
      `SELECT count(*)::int AS total FROM sj_projects p WHERE ${whereSql}`,
      params,
    )).rows[0].total;
    const rows = (await this.pool.query(
      `SELECT p.* FROM sj_projects p WHERE ${whereSql}
       ORDER BY p.updated_at DESC, p.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    )).rows;
    const projects = rows.map(projectFromRow);
    if (!projects.length) return { rows: [], total };
    const planRows = (await this.pool.query(
      'SELECT * FROM sj_project_plans WHERE project_id = ANY($1::uuid[])',
      [projects.map(project => project.id)],
    )).rows.map(planFromRow);
    const byProject = new Map();
    for (const plan of planRows) {
      const list = byProject.get(plan.projectId) || [];
      list.push(plan);
      byProject.set(plan.projectId, list);
    }
    return {
      total,
      rows: projects.map(project => ({
        project,
        plan: (byProject.get(project.id) || []).find(plan => plan.version === project.currentPlanVersion) || null,
      })),
    };
  }

  async getPlan(projectId, version) {
    const row = (await this.pool.query(
      'SELECT * FROM sj_project_plans WHERE project_id=$1 AND version=$2 AND workspace_id=$3',
      [projectId, version, this.workspaceId],
    )).rows[0];
    return planFromRow(row);
  }

  async listPlans(projectId) {
    const rows = (await this.pool.query(
      `SELECT * FROM sj_project_plans WHERE project_id=$1 AND workspace_id=$2
       ORDER BY version DESC`,
      [projectId, this.workspaceId],
    )).rows;
    return rows.map(planFromRow);
  }

  async listEvents(projectId) {
    const rows = (await this.pool.query(
      `SELECT * FROM sj_project_events WHERE project_id=$1 AND workspace_id=$2
       ORDER BY seq ASC`,
      [projectId, this.workspaceId],
    )).rows;
    return rows.map(eventFromRow);
  }

  async getLifecycleEvidence(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) return new Map();
    const normalized = scopes.map(scope => ({
      project_id: scope.projectId,
      plan_version: scope.planVersion,
      deliverable_ids: Array.isArray(scope.deliverableIds) ? scope.deliverableIds : [],
    }));
    const result = new Map(normalized.map(scope => [
      projectLifecycleKey(scope.project_id, scope.plan_version),
      { runs: [], producedDeliverableIds: [], candidateDeliverableIds: [], approvedDeliverableIds: [], exports: [] },
    ]));
    const rows = await this.pool.query(`
      WITH project_scopes AS (
        SELECT scope.project_id, scope.plan_version, scope.deliverable_ids
        FROM jsonb_to_recordset($1::jsonb)
          AS scope(project_id uuid, plan_version integer, deliverable_ids jsonb)
        JOIN sj_projects project ON project.id=scope.project_id AND project.workspace_id=$2
      ), requested AS (
        SELECT scope.project_id, scope.plan_version, deliverable.deliverable_id::uuid AS deliverable_id
        FROM project_scopes scope
        CROSS JOIN LATERAL jsonb_array_elements_text(scope.deliverable_ids) AS deliverable(deliverable_id)
      ), latest_runs AS (
        SELECT DISTINCT ON (run.project_id, run.plan_version, run.deliverable_id)
          run.project_id, run.plan_version, run.deliverable_id,
          CASE WHEN EXISTS (
            SELECT 1 FROM sj_workflow_node_runs node
            WHERE node.run_id=run.id AND node.workspace_id=$2 AND node.status='unknown'
          ) THEN 'unknown' ELSE run.status END AS status
        FROM sj_workflow_runs run
        JOIN requested item ON item.project_id=run.project_id
          AND item.plan_version=run.plan_version AND item.deliverable_id=run.deliverable_id
        WHERE run.workspace_id=$2 AND run.confirmed_at IS NOT NULL
        ORDER BY run.project_id, run.plan_version, run.deliverable_id, run.created_at DESC, run.id DESC
      ), versions AS (
        SELECT version.* FROM sj_deliverable_versions version
        JOIN requested item ON item.project_id=version.project_id
          AND item.plan_version=version.plan_version AND item.deliverable_id=version.deliverable_id
        WHERE version.workspace_id=$2
      ), candidates AS (
        SELECT state.project_id, state.plan_version, state.deliverable_id,
          version.id AS current_candidate_version_id, version.status
        FROM sj_deliverable_states state
        JOIN versions version ON version.id=state.current_candidate_version_id
          AND version.project_id=state.project_id AND version.plan_version=state.plan_version
          AND version.deliverable_id=state.deliverable_id
        WHERE state.workspace_id=$2 AND version.is_candidate
          AND version.status IN ('candidate','approved')
      ), approved AS (
        SELECT candidate.* FROM candidates candidate
        JOIN sj_deliverable_reviews review ON review.project_id=candidate.project_id
          AND review.plan_version=candidate.plan_version
          AND review.deliverable_id=candidate.deliverable_id
          AND review.version_id=candidate.current_candidate_version_id
          AND review.workspace_id=$2 AND review.status='approved'
        WHERE candidate.status='approved'
      )
      SELECT 'run'::text AS kind, project_id, plan_version, deliverable_id,
        status::text AS value, NULL::integer AS missing_count, NULL::boolean AS matches_current_candidates
      FROM latest_runs
      UNION ALL
      SELECT DISTINCT 'produced', version.project_id, version.plan_version, version.deliverable_id,
        NULL::text, NULL::integer, NULL::boolean
      FROM versions version
      LEFT JOIN sj_generation_jobs job ON job.id=version.job_id
        AND COALESCE(job.input->>'workspaceId','local')=$2 AND job.status='succeeded'
      LEFT JOIN sj_assets asset ON asset.id=version.asset_id AND asset.workspace_id=$2
      WHERE job.id IS NOT NULL OR asset.id IS NOT NULL
      UNION ALL
      SELECT 'candidate', project_id, plan_version, deliverable_id,
        current_candidate_version_id::text, NULL::integer, NULL::boolean
      FROM candidates
      UNION ALL
      SELECT 'approved', project_id, plan_version, deliverable_id,
        current_candidate_version_id::text, NULL::integer, NULL::boolean
      FROM approved
      UNION ALL
      SELECT 'export', export.project_id, export.plan_version, NULL::uuid,
        export.status::text, export.missing_count,
        NOT EXISTS (
          SELECT 1 FROM requested item
          LEFT JOIN approved candidate ON candidate.project_id=item.project_id
            AND candidate.plan_version=item.plan_version AND candidate.deliverable_id=item.deliverable_id
          WHERE item.project_id=export.project_id AND item.plan_version=export.plan_version
            AND (candidate.current_candidate_version_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(export.items) exported
              WHERE exported->>'deliverableId'=item.deliverable_id::text
                AND exported->>'versionId'=candidate.current_candidate_version_id::text
            ))
        ) AS matches_current_candidates
      FROM sj_project_exports export
      JOIN project_scopes scope ON scope.project_id=export.project_id
        AND scope.plan_version=export.plan_version
      WHERE export.workspace_id=$2 AND export.status='completed'
    `, [JSON.stringify(normalized), this.workspaceId]);
    for (const row of rows.rows) {
      const evidence = result.get(projectLifecycleKey(row.project_id, row.plan_version));
      if (!evidence) continue;
      if (row.kind === 'run') evidence.runs.push({ deliverableId: row.deliverable_id, status: row.value });
      else if (row.kind === 'produced') evidence.producedDeliverableIds.push(row.deliverable_id);
      else if (row.kind === 'candidate') evidence.candidateDeliverableIds.push(row.deliverable_id);
      else if (row.kind === 'approved') evidence.approvedDeliverableIds.push(row.deliverable_id);
      else if (row.kind === 'export') evidence.exports.push({
        status: row.value,
        missingCount: Number(row.missing_count),
        matchesCurrentCandidates: row.matches_current_candidates === true,
      });
    }
    return result;
  }

  async updateProject(id, expectedVersion, mutate) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT * FROM sj_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [id, this.workspaceId],
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const current = projectFromRow(row);
      if (current.version !== expectedVersion) {
        await client.query('ROLLBACK');
        return { status: 'conflict', currentVersion: current.version };
      }
      const next = await mutate(current);
      const version = current.version + 1;
      const updated = (await client.query(`
        UPDATE sj_projects SET
          name=$2, status=$3, cancelled_at=$4, version=$5, updated_at=now()
        WHERE id=$1 AND workspace_id=$6
        RETURNING *`, [
        id, next.name ?? current.name, next.status ?? current.status,
        next.status === 'cancelled' ? (next.cancelledAt || new Date()) : (next.cancelledAt ?? null),
        version, this.workspaceId,
      ])).rows[0];
      await client.query('COMMIT');
      return { status: 'ok', project: projectFromRow(updated) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updatePlan(projectId, version, expectedRevision, patch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT * FROM sj_project_plans WHERE project_id=$1 AND version=$2 AND workspace_id=$3 FOR UPDATE',
        [projectId, version, this.workspaceId],
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 'plan_missing' };
      }
      const current = planFromRow(row);
      if (current.status === 'confirmed' && !patch.allowConfirmed) {
        await client.query('ROLLBACK');
        return { status: 'confirmed' };
      }
      if (current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { status: 'conflict', currentRevision: current.revision };
      }
      const revision = current.revision + 1;
      const updated = (await client.query(`
        UPDATE sj_project_plans SET
          deliverables=$2::jsonb, requirement=$3, price=$4::jsonb,
          change_reason=COALESCE($5, change_reason), revision=$6, updated_at=now()
        WHERE project_id=$1 AND version=$7 AND workspace_id=$8
        RETURNING *`, [
        projectId, JSON.stringify(patch.deliverables ?? current.deliverables),
        patch.requirement === undefined ? current.requirement : patch.requirement,
        JSON.stringify(patch.price ?? current.price), patch.changeReason ?? null,
        revision, version, this.workspaceId,
      ])).rows[0];
      await client.query(
        'UPDATE sj_projects SET updated_at=now() WHERE id=$1 AND workspace_id=$2',
        [projectId, this.workspaceId],
      );
      await client.query('COMMIT');
      return { status: 'ok', plan: planFromRow(updated) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createPlanVersion({ projectId, expectedCurrentVersion, expectedProjectVersion, plan, projectPatch }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT * FROM sj_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [projectId, this.workspaceId],
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const project = projectFromRow(row);
      if (project.currentPlanVersion !== expectedCurrentVersion
        || (expectedProjectVersion !== undefined && project.version !== expectedProjectVersion)) {
        await client.query('ROLLBACK');
        return { status: 'conflict', currentVersion: project.version };
      }
      const planRow = (await client.query(INSERT_PLAN, [
        plan.id, plan.projectId, plan.workspaceId, plan.version, plan.status, plan.revision,
        plan.requirement, JSON.stringify(plan.deliverables), plan.productVersion,
        JSON.stringify(plan.productSnapshot), JSON.stringify(plan.skuSnapshot),
        JSON.stringify(plan.price), plan.changeReason, plan.confirmedAt, plan.confirmedBy,
      ])).rows[0];
      const updated = (await client.query(`
        UPDATE sj_projects SET
          status=$2, current_plan_version=$3, version=version+1, updated_at=now()
        WHERE id=$1 AND workspace_id=$4
        RETURNING *`, [
        projectId, projectPatch?.status ?? project.status, plan.version, this.workspaceId,
      ])).rows[0];
      await client.query('COMMIT');
      return { status: 'ok', project: projectFromRow(updated), plan: planFromRow(planRow) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async confirmPlan({ projectId, version, expectedRevision, planPatch, events, projectPatch }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const projectRow = (await client.query(
        'SELECT * FROM sj_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [projectId, this.workspaceId],
      )).rows[0];
      if (!projectRow) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const planRow = (await client.query(
        'SELECT * FROM sj_project_plans WHERE project_id=$1 AND version=$2 AND workspace_id=$3 FOR UPDATE',
        [projectId, version, this.workspaceId],
      )).rows[0];
      if (!planRow) {
        await client.query('ROLLBACK');
        return { status: 'plan_missing' };
      }
      const current = planFromRow(planRow);
      if (current.status === 'confirmed') {
        await client.query('ROLLBACK');
        return { status: 'confirmed' };
      }
      if (current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { status: 'conflict', currentRevision: current.revision };
      }
      const updatedPlan = (await client.query(`
        UPDATE sj_project_plans SET
          status='confirmed', deliverables=$2::jsonb, price=$3::jsonb,
          product_version=$4, product_snapshot=$5::jsonb, sku_snapshot=$6::jsonb,
          change_reason=COALESCE($7, change_reason), confirmed_at=$8, confirmed_by=$9,
          revision=$10, updated_at=now()
        WHERE project_id=$1 AND version=$11 AND workspace_id=$12
        RETURNING *`, [
        projectId, JSON.stringify(planPatch.deliverables), JSON.stringify(planPatch.price),
        planPatch.productVersion, JSON.stringify(planPatch.productSnapshot),
        JSON.stringify(planPatch.skuSnapshot), planPatch.changeReason,
        planPatch.confirmedAt, planPatch.confirmedBy, current.revision + 1,
        version, this.workspaceId,
      ])).rows[0];
      for (const event of events) {
        await client.query(INSERT_EVENT, [
          event.id, event.projectId, event.workspaceId, event.step, event.stepKey,
          event.status, event.source, event.note, event.actorId, event.createdAt,
        ]);
      }
      const updatedProject = (await client.query(`
        UPDATE sj_projects SET
          status=$2, current_plan_version=$3, version=version+1, updated_at=now()
        WHERE id=$1 AND workspace_id=$4
        RETURNING *`, [
        projectId, projectPatch?.status || 'active', version, this.workspaceId,
      ])).rows[0];
      await client.query('COMMIT');
      return {
        status: 'ok',
        project: projectFromRow(updatedProject),
        plan: planFromRow(updatedPlan),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async appendEvents({ projectId, events, projectPatch }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const projectRow = (await client.query(
        'SELECT * FROM sj_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [projectId, this.workspaceId],
      )).rows[0];
      if (!projectRow) {
        await client.query('ROLLBACK');
        throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
      }
      for (const event of events) {
        await client.query(INSERT_EVENT, [
          event.id, event.projectId, event.workspaceId, event.step, event.stepKey,
          event.status, event.source, event.note, event.actorId, event.createdAt,
        ]);
      }
      const updated = (await client.query(`
        UPDATE sj_projects SET
          status=$2, version=version+1, updated_at=now()
        WHERE id=$1 AND workspace_id=$3
        RETURNING *`, [
        projectId, projectPatch?.status || projectRow.status, this.workspaceId,
      ])).rows[0];
      await client.query('COMMIT');
      return projectFromRow(updated);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
