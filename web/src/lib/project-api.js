// 项目核心真实 API 客户端（Issue #27）。
//
// 只在这里拼装项目、方案、规划、工作流实例与运行的请求。页面组件不直接 fetch，
// 也不保存任何演示项目数据。写接口统一带上会话 CSRF；方案保存/确认与运行确认
// 按服务端要求带 If-Match（`"r<revision>"`）；运行确认使用新的幂等键。
// 本模块不自动重试、不切换模型，失败原样交给界面展示。

export const PROJECT_STATUS_LABELS = Object.freeze({
  draft: '草稿', active: '进行中', review: '待审核', completed: '已完成', cancelled: '已取消',
});
export const PLAN_STATUS_LABELS = Object.freeze({ draft: '方案草稿', confirmed: '方案已确认' });
export const RUN_STATUS_LABELS = Object.freeze({
  draft: '待估价', estimating: '估价中', awaiting_confirmation: '待确认开跑',
  running: '执行中', partial_failed: '部分失败', succeeded: '已成功', cancelled: '已取消',
});
export const NODE_STATUS_LABELS = Object.freeze({
  idle: '未估价', pending: '待执行', queued: '排队中', running: '执行中',
  succeeded: '成功', failed: '明确失败', unknown: '状态未知', blocked: '上游失败 · 已阻塞', skipped: '已跳过',
});
export const NODE_TYPE_LABELS = Object.freeze({
  input: '商品资料', prompt: '文本提示词', generate: '生图', edit: '改图',
  composite: '模板合成', output: '交付候选',
});
export const TYPE_LABELS = Object.freeze({
  white: '白底主图 / 多角度', scene: '场景图', selling: '卖点 / 促销图',
  detail: '细节 / 尺寸 / 包装清单', extension: 'AI 扩展建议',
});
export const TYPE_RATIOS = Object.freeze({ white: '1:1', scene: '3:4', selling: '1:1', detail: '3:4', extension: '1:1' });
export const PROJECT_STEP_LABELS = Object.freeze(['商品资料', '方案报价', '制作任务', '精修', '质检审核', '打包导出']);
export const VERSION_STATUS_LABELS = Object.freeze({
  draft: '草稿', candidate: '候选', approved: '已通过', superseded: '已被替代', rejected: '已拒绝',
});
export const REFINE_PATH_LABELS = Object.freeze({
  template_reorder: '模板重排', base_optimize: '底图二次优化', full_polish: '整图润色',
});
export const REFINE_STATUS_LABELS = Object.freeze({
  draft: '估价草稿', awaiting_confirmation: '待确认', running: '执行中',
  succeeded: '已成功', failed: '明确失败', unknown: '状态未知', cancelled: '已取消',
});
export const REVIEW_CHECK_ITEMS = Object.freeze([
  Object.freeze({ key: 'fidelity', label: '商品保真' }),
  Object.freeze({ key: 'text', label: '文字' }),
  Object.freeze({ key: 'size', label: '尺寸' }),
  Object.freeze({ key: 'layout', label: '排版' }),
]);
export const REVIEW_RESULT_LABELS = Object.freeze({ pending: '待检查', passed: '通过', issue: '有问题' });
export const REVIEW_STATUS_LABELS = Object.freeze({ in_review: '待审核', approved: '已通过', revoked: '已撤销' });
export const EXPORT_STATUS_LABELS = Object.freeze({ building: '生成中', completed: '已完成', failed: '失败' });

export const PROMPT_SLOT_LABELS = Object.freeze({
  subject: '主体/数量', scene: '场景', composition: '构图/视角', lighting: '光线',
  style: '风格', material: '材质/颜色', mustKeep: '必须保持', forbidden: '禁止出现', aspectRatio: '画幅',
});
const SLOT_BY_LABEL = new Map(Object.entries(PROMPT_SLOT_LABELS).map(([key, label]) => [label, key]));

export function moneyFromCents(cents) {
  if (cents === null || cents === undefined) return '待核价';
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

export class ProjectApiError extends Error {
  constructor(message, { code = null, status = 0 } = {}) {
    super(message);
    this.name = 'ProjectApiError';
    this.code = code;
    this.status = status;
  }
}

function requestHeaders({ csrf, method, body, ifMatch }) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf || '';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ifMatch) headers['If-Match'] = ifMatch;
  return headers;
}

export function etagFor(revision, prefix = 'r') {
  return `"${prefix}${revision}"`;
}

export function newIdempotencyKey(prefix = 'run') {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createProjectApi({ csrf = '' } = {}) {
  async function request(path, { method = 'GET', body, ifMatch } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: requestHeaders({ csrf, method, body, ifMatch }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ProjectApiError('网络请求失败，请检查本机服务是否可用。', { code: 'NETWORK_ERROR' });
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* empty or non-JSON error body */ }
    if (!response.ok) {
      throw new ProjectApiError(
        payload?.error?.message || `服务请求失败（HTTP ${response.status}）。`,
        { code: payload?.error?.code || null, status: response.status },
      );
    }
    return { data: payload, etag: response.headers.get('ETag'), status: response.status };
  }

  return {
    request,
    listProjects: ({ limit = 100 } = {}) => request(`/api/projects?limit=${encodeURIComponent(limit)}`),
    getProject: id => request(`/api/projects/${encodeURIComponent(id)}`),
    createProject: body => request('/api/projects', { method: 'POST', body }),
    updateProject: (id, body, etag) => request(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH', body, ifMatch: etag,
    }),
    recordStepEvent: (projectId, step, body) => request(
      `/api/projects/${encodeURIComponent(projectId)}/steps/${step}/events`,
      { method: 'POST', body },
    ),

    listProducts: ({ limit = 100 } = {}) => request(`/api/products?limit=${encodeURIComponent(limit)}`),
    getProduct: id => request(`/api/products/${encodeURIComponent(id)}`),

    getPlan: (projectId, version) => request(
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(version)}`,
    ),
    savePlan: (projectId, version, body, revision) => request(
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(version)}`,
      { method: 'PATCH', body, ifMatch: etagFor(revision) },
    ),
    confirmPlan: (projectId, version, revision, reason) => request(
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(version)}/confirm`,
      { method: 'POST', body: { revision, reason }, ifMatch: etagFor(revision) },
    ),
    addDeliverables: (projectId, version, body, revision) => request(
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(version)}/deliverables`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),

    planWithAI: body => request('/api/planner/plan', { method: 'POST', body }),

    getDeliverableWorkflow: (projectId, planVersion, deliverableId) => request(
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planVersion)}`
      + `/deliverables/${encodeURIComponent(deliverableId)}/workflow`,
    ),
    createWorkflowInstance: (projectId, planVersion, deliverableId, body = {}) => request(
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planVersion)}`
      + `/deliverables/${encodeURIComponent(deliverableId)}/workflow`,
      { method: 'POST', body },
    ),
    listWorkflowTemplates: taskType => request('/api/workflow-templates' + queryString({ taskType, status: 'active' })),
    saveWorkflowTemplate: (id, body, revision) => request(
      `/api/workflow-instances/${encodeURIComponent(id)}/save-as-template`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),
    getWorkflowInstance: id => request(`/api/workflow-instances/${encodeURIComponent(id)}`),

    saveWorkflowInstance: (id, body, revision) => request(
      `/api/workflow-instances/${encodeURIComponent(id)}`,
      { method: 'PATCH', body, ifMatch: etagFor(revision) },
    ),

    estimateRun: workflowInstanceId => request('/api/workflow-runs/estimate', {
      method: 'POST', body: { workflowInstanceId },
    }),
    latestRun: workflowInstanceId => request(
      `/api/workflow-runs?workflowInstanceId=${encodeURIComponent(workflowInstanceId)}`,
    ),
    confirmRun: (run, idempotencyKey) => request('/api/workflow-runs', {
      method: 'POST',
      body: { runId: run.id, idempotencyKey, revision: run.revision },
      ifMatch: etagFor(run.revision),
    }),
    getRun: id => request(`/api/workflow-runs/${encodeURIComponent(id)}`),
    retryRun: (run, nodeId) => request(`/api/workflow-runs/${encodeURIComponent(run.id)}/retry`, {
      method: 'POST',
      body: { nodeId, idempotencyKey: newIdempotencyKey('retry'), revision: run.revision },
      ifMatch: etagFor(run.revision),
    }),
    reconcileRun: (run, nodeId) => request(`/api/workflow-runs/${encodeURIComponent(run.id)}/reconcile`, {
      method: 'POST',
      body: { nodeId, revision: run.revision },
      ifMatch: etagFor(run.revision),
    }),

    // ---- 04 精修与交付候选（#16） ----
    // 版本链与精修记录用交付项状态 ETag；精修请求（估价 / 确认 / 核实）用自己的
    // `"r<revision>"` ETag。估价只写待确认草稿，确认才预占并执行。
    listDeliverableVersions: (deliverableId, { projectId, planVersion } = {}) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/versions`
      + queryString({ projectId, planVersion }),
    ),
    importDeliverableVersion: (deliverableId, body) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/versions`,
      { method: 'POST', body },
    ),
    listRefines: (deliverableId, { projectId, planVersion } = {}) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/refines`
      + queryString({ projectId, planVersion }),
    ),
    estimateRefine: (deliverableId, body) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/refines/estimate`,
      { method: 'POST', body },
    ),
    confirmRefine: (deliverableId, body, revision) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/refines`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),
    getRefine: id => request(`/api/refines/${encodeURIComponent(id)}`),
    reconcileRefine: (id, body, revision) => request(
      `/api/refines/${encodeURIComponent(id)}/reconcile`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),
    selectCandidate: (deliverableId, body, revision) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/candidates`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),
    reworkDeliverable: (deliverableId, body, revision) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/rework`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),

    // ---- 05 质检审核与撤销（#17） ----
    // 审核记录使用自己的 ETag；列表接口返回交付项状态 ETag（仅展示）。
    listReviews: (deliverableId, { projectId, planVersion } = {}) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/reviews`
      + queryString({ projectId, planVersion }),
    ),
    startReview: (deliverableId, body) => request(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/reviews`,
      { method: 'POST', body },
    ),
    getReview: id => request(`/api/reviews/${encodeURIComponent(id)}`),
    updateReview: (id, body, revision) => request(
      `/api/reviews/${encodeURIComponent(id)}`,
      { method: 'PATCH', body, ifMatch: etagFor(revision) },
    ),
    approveReview: (id, body, revision) => request(
      `/api/reviews/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),
    revokeReview: (id, body, revision) => request(
      `/api/reviews/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', body, ifMatch: etagFor(revision) },
    ),

    // ---- 06 打包导出（#18） ----
    // 创建导出必须使用幂等键；下载走真实同源端点，不使用演示 manifest。
    listExports: projectId => request(
      `/api/projects/${encodeURIComponent(projectId)}/exports`,
    ),
    createExport: (projectId, body) => request(
      `/api/projects/${encodeURIComponent(projectId)}/exports`,
      { method: 'POST', body },
    ),
    getExport: id => request(`/api/exports/${encodeURIComponent(id)}`),
    exportDownloadUrl: id => `/api/exports/${encodeURIComponent(id)}/download`,
  };
}

function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : '';
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function skuSnapshot(sku) {
  return {
    id: sku.id,
    internalSku: sku.internalSku ?? null,
    sourceSkuId: sku.sourceSkuId ?? null,
    spec: sku.spec ?? null,
    selected: sku.selected !== false,
    parameters: (sku.parameters || []).map(row => ({
      name: String(row.name || ''), value: row.value ?? '', unit: row.unit ?? null,
    })),
    price: {
      amount: sku.price?.amount ?? null,
      min: sku.price?.min ?? null,
      max: sku.price?.max ?? null,
      currency: sku.price?.currency ?? null,
      type: sku.price?.type ?? null,
      condition: sku.price?.condition ?? null,
      capturedAt: iso(sku.price?.capturedAt),
    },
  };
}

// 规划接口只接受已确认资料快照。这里只读转换真实商品，缺少的字段保持 null，
// 不补造规格、卖点或价格。
export function productToSnapshot(product, skuId = null) {
  if (!product) return null;
  const skus = (product.skus || []).filter(sku => !skuId || sku.id === skuId);
  return {
    productId: product.id,
    workspaceId: product.workspaceId ?? null,
    version: product.version,
    name: product.name,
    originalTitle: product.originalTitle ?? null,
    brand: product.brand ?? null,
    category: product.category ?? null,
    description: product.description ?? null,
    internalCode: product.internalCode ?? null,
    sourceType: product.sourceType ?? 'manual',
    sourcePlatform: product.sourcePlatform ?? null,
    sourceUrl: product.sourceUrl ?? null,
    sourceProductId: product.sourceProductId ?? null,
    status: product.status,
    confirmedAt: iso(product.confirmedAt),
    createdAt: iso(product.createdAt),
    updatedAt: iso(product.updatedAt),
    skus: skus.map(skuSnapshot),
    sellingPoints: Array.isArray(product.sellingPoints) ? product.sellingPoints : [],
    forbiddenPhrases: Array.isArray(product.forbiddenPhrases) ? product.forbiddenPhrases : [],
  };
}

export function composePromptText(prompt = {}) {
  return Object.entries(PROMPT_SLOT_LABELS)
    .filter(([key]) => key !== 'aspectRatio' && prompt[key])
    .map(([key, label]) => `${label}：${prompt[key]}`)
    .join('；');
}

// 将用户编辑的整段提示词映射回服务端认可的槽位。结构化的「标签：值」原样保留，
// 无法识别的内容并入主体槽位，不补造商品事实。
export function promptFromText(text, basePrompt = {}, type = 'white') {
  const aspectRatio = basePrompt.aspectRatio || TYPE_RATIOS[type] || '1:1';
  const prompt = { aspectRatio };
  const extras = [];
  String(text || '').split(/[；;]\s*/).map(part => part.trim()).filter(Boolean).forEach(part => {
    const index = part.indexOf('：');
    const alt = part.indexOf(':');
    const cut = index >= 0 ? index : alt;
    const label = cut >= 0 ? part.slice(0, cut).trim() : '';
    const key = SLOT_BY_LABEL.get(label);
    if (key) prompt[key] = part.slice(cut + 1).trim().slice(0, 300);
    else extras.push(part.slice(0, 300));
  });
  if (extras.length) {
    prompt.subject = [prompt.subject, ...extras].filter(Boolean).join('；').slice(0, 300);
  }
  return prompt;
}

export function defaultPromptFor(type, productName) {
  return {
    subject: productName ? `商品「${productName}」` : '',
    scene: type === 'white' ? '纯白无缝背景' : '简洁背景，突出商品',
    composition: '正面视角，商品居中',
    lighting: '柔和均匀光线',
    style: '真实商品摄影风格',
    material: '颜色与表面以商品资料为准',
    mustKeep: '保持商品原有形状与颜色，不添加未确认的信息',
    forbidden: '未在商品资料中确认的材质、容量、认证、价格与卖点',
    aspectRatio: TYPE_RATIOS[type] || '1:1',
  };
}

function baseParameters(modelId) {
  const parameters = { capability: 'image.generate' };
  if (modelId) parameters.modelId = modelId;
  return parameters;
}

export function plannerDeliverables(result, { modelId = null } = {}) {
  const deliverables = (result?.plan?.deliverables || []).map(item => ({
    key: `ai-${item.type}-${Math.random().toString(36).slice(2, 8)}`,
    id: null,
    type: item.type,
    title: item.title,
    purpose: item.purpose ?? null,
    quantity: item.quantity || 1,
    prompt: { ...item.prompt, aspectRatio: item.prompt?.aspectRatio || TYPE_RATIOS[item.type] || '1:1' },
    promptText: item.promptText || composePromptText(item.prompt),
    copy: Array.isArray(item.copy) ? item.copy : [],
    parameters: baseParameters(modelId),
    price: null,
    status: 'planned',
    saved: false,
  }));
  const suggestions = (result?.plan?.extensions || []).map(item => ({
    key: `ext-${Math.random().toString(36).slice(2, 8)}`,
    type: 'extension',
    title: item.title,
    purpose: item.purpose ?? null,
    quantity: 1,
    prompt: { ...item.prompt, aspectRatio: item.prompt?.aspectRatio || '1:1' },
    promptText: item.promptText || composePromptText(item.prompt),
    copy: [],
    parameters: baseParameters(modelId),
    price: null,
    status: 'planned',
    saved: false,
    suggestion: true,
  }));
  return { deliverables, suggestions };
}

export function toDraft(deliverable) {
  return {
    ...deliverable,
    key: deliverable.id,
    prompt: { ...(deliverable.prompt || {}) },
    promptText: deliverable.promptText || composePromptText(deliverable.prompt || {}),
    copy: Array.isArray(deliverable.copy) ? structuredClone(deliverable.copy) : [],
    parameters: { ...(deliverable.parameters || {}) },
    saved: true,
  };
}

export function planPayload(drafts, requirement) {
  return {
    requirement,
    changeReason: '前端编辑方案草稿',
    deliverables: drafts.map(draft => {
      const payload = {
        type: draft.type,
        title: draft.title,
        purpose: draft.purpose || null,
        quantity: Number(draft.quantity) || 1,
        prompt: promptFromText(draft.promptText, draft.prompt, draft.type),
        copy: draft.copy || [],
        parameters: draft.parameters || {},
      };
      if (draft.id) payload.id = draft.id;
      return payload;
    }),
  };
}

export function deliverableTitle(deliverable, snapshot = null) {
  if (deliverable?.title) return deliverable.title;
  if (snapshot?.name) return snapshot.name;
  return '未命名交付项';
}

export function priceLabel(price) {
  if (!price) return '待核价';
  if (price.amountCents === null || price.amountCents === undefined) return '待核价';
  return moneyFromCents(price.amountCents);
}

export function nodeStatusLabel(status) {
  return NODE_STATUS_LABELS[status] || status || '未估价';
}

export function runNodeMap(run) {
  return new Map((run?.nodes || []).map(node => [node.nodeId, node]));
}

function layoutInstance(instance) {
  const nodes = instance?.nodes || [];
  const edges = instance?.edges || [];
  const parents = new Map(nodes.map(node => [node.id, []]));
  edges.forEach(edge => {
    if (parents.has(edge.target)) parents.get(edge.target).push(edge.source);
  });
  const depthCache = new Map();
  const depthOf = (id, seen = new Set()) => {
    if (depthCache.has(id)) return depthCache.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const list = parents.get(id) || [];
    const depth = list.length ? Math.max(...list.map(parent => depthOf(parent, seen) + 1)) : 0;
    depthCache.set(id, depth);
    return depth;
  };
  const rows = new Map();
  const positions = new Map();
  nodes.forEach(node => {
    const depth = depthOf(node.id);
    const row = rows.get(depth) || 0;
    rows.set(depth, row + 1);
    positions.set(node.id, node.position || { x: 12 + depth * 235, y: 24 + row * 190 });
  });
  return positions;
}

// 把服务端工作流实例 + 运行详情投影成画布可渲染结构。数据仍来自同一份实例，
// 不写回本地存储，也不生成任何演示价格。
export function workflowItem(instance, run, deliverable) {
  const positions = layoutInstance(instance);
  const byId = new Map((instance?.nodes || []).map(node => [node.id, node]));
  const incoming = new Map();
  (instance?.edges || []).forEach(edge => {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge);
  });
  const runNodes = runNodeMap(run);
  const flow = (instance?.nodes || []).map(node => {
    const position = positions.get(node.id) || { x: 12, y: 24 };
    const runNode = runNodes.get(node.id);
    const inputs = incoming.get(node.id) || [];
    const edge = inputs[0];
    return {
      id: node.id,
      type: node.type,
      name: node.name,
      status: runNode?.status || 'idle',
      from: edge?.source ?? null,
      fromPort: edge?.sourcePort ?? null,
      toPort: edge?.targetPort ?? null,
      inputs: inputs.map(input => ({
        from: input.source,
        fromPort: input.sourcePort ?? null,
        toPort: input.targetPort ?? null,
      })),
      model: node.params?.modelId || '',
      count: node.params?.count || 1,
      prompt: node.params?.prompt || '',
      locked: (instance?.lockedNodes || []).includes(node.id),
      ports: Array.isArray(node.ports) ? node.ports : null,
      quote: runNode?.quote ?? null,
      amountCents: runNode ? runNode.amountCents : undefined,
      reservedCents: runNode?.reservedCents ?? null,
      errorCode: runNode?.errorCode ?? null,
      x: position.x,
      y: position.y,
    };
  });
  const promptNode = flow.find(node => node.type === 'prompt');
  const generateNode = flow.find(node => ['generate', 'edit'].includes(node.type));
  return {
    id: instance?.deliverableId || deliverable?.id,
    name: deliverable?.title || instance?.taskType || '交付项',
    type: deliverable?.type || instance?.taskType,
    status: run?.status || 'draft',
    frozen: true,
    real: true,
    prompt: promptNode?.prompt || deliverable?.promptText || '',
    model: generateNode?.model || deliverable?.parameters?.modelId || '',
    ratio: deliverable?.prompt?.aspectRatio || TYPE_RATIOS[deliverable?.type] || '1:1',
    flow,
    run,
    instance,
    deliverable,
    byId,
  };
}

export function planProgressLabel(progress) {
  if (!progress || typeof progress.completed !== 'number') return '未统计';
  return `${progress.completed} / ${progress.total} 步`;
}
