import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { COPY_SLOTS } from './planner.mjs';

// 工作流模板、实例与锁定节点（Issue #13 / FLOW-14—FLOW-16）。
//
// 设计边界：
// - 模板按 (template_key, version) 只追加；实例是模板节点/边/锁定集合的深拷贝，
//   改实例不会写回模板，模板后续版本也不会改变已有实例。
// - 工作流是有向无环图：保存时拒绝自环、有向环、重复节点 id、悬空边；
//   每条边必须从输出端口连到输入端口，两端端口类型必须完全一致；
//   一个输入端口最多被一条边占用。
// - 商品资料（input）与交付候选（output）由系统生成并始终锁定；模板还可以锁定
//   其它合规节点。实例修改必须保留全部锁定节点、其类型与端口，以及所有与锁定
//   节点相连的既有边，否则返回 409 LOCKED_NODE_PROTECTED / LOCKED_EDGE_PROTECTED。
// - 新模板、新实例与实例修改都拒绝已停用/不存在/不可执行的模型；已有实例保留
//   自己的模型快照，不会被静默替换。
// - 交付项实例可以在方案草稿阶段保存（W-10 允许确认前编辑），但只有方案已确认
//   时返回 runnable=true；本模块不执行节点，也不修改已冻结的方案行。

export const TASK_TYPE_KEYS = Object.freeze(['white', 'scene', 'selling', 'detail', 'extension']);
export const PORT_TYPES = Object.freeze(['data', 'text', 'image']);
export const TEMPLATE_STATUSES = Object.freeze(['active', 'disabled']);
export const MAX_NODES = 50;
export const MAX_EDGES = 100;
export const MAX_PARAMS_BYTES = 20_000;
export const MAX_PROMPT_LENGTH = 16_000;
export const MAX_COPY_ITEMS = 3;
export const ASPECT_RATIOS = Object.freeze(['1:1', '3:4', '4:3', '16:9', '9:16']);
export const IMAGE_CAPABILITIES = Object.freeze({
  generate: 'image.generate',
  edit: 'image.edit',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EDGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEMPLATE_KEY = /^[a-z][a-z0-9-]{1,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const TIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const COLOR = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

const NODE_DEFINITIONS = Object.freeze({
  input: Object.freeze({
    label: '商品资料',
    system: true,
    ports: Object.freeze([
      Object.freeze({ id: 'snapshot', direction: 'out', type: 'data', required: true }),
    ]),
  }),
  prompt: Object.freeze({
    label: '文本提示词',
    system: false,
    ports: Object.freeze([
      Object.freeze({ id: 'source', direction: 'in', type: 'data', required: true }),
      Object.freeze({ id: 'prompt', direction: 'out', type: 'text', required: true }),
      Object.freeze({ id: 'copy', direction: 'out', type: 'text', required: false }),
    ]),
  }),
  generate: Object.freeze({
    label: '生图',
    system: false,
    ports: Object.freeze([
      Object.freeze({ id: 'prompt', direction: 'in', type: 'text', required: true }),
      Object.freeze({ id: 'image', direction: 'out', type: 'image', required: true }),
    ]),
  }),
  edit: Object.freeze({
    label: '改图',
    system: false,
    ports: Object.freeze([
      Object.freeze({ id: 'source', direction: 'in', type: 'image', required: true }),
      Object.freeze({ id: 'instruction', direction: 'in', type: 'text', required: false }),
      Object.freeze({ id: 'image', direction: 'out', type: 'image', required: true }),
    ]),
  }),
  composite: Object.freeze({
    label: '模板合成',
    system: false,
    ports: Object.freeze([
      Object.freeze({ id: 'base', direction: 'in', type: 'image', required: true }),
      Object.freeze({ id: 'copy', direction: 'in', type: 'text', required: false }),
      Object.freeze({ id: 'image', direction: 'out', type: 'image', required: true }),
    ]),
  }),
  output: Object.freeze({
    label: '交付候选',
    system: true,
    ports: Object.freeze([
      Object.freeze({ id: 'result', direction: 'in', type: 'image', required: true }),
    ]),
  }),
});

export const NODE_TYPES = Object.freeze(Object.keys(NODE_DEFINITIONS));

const NODE_FIELDS = ['id', 'type', 'name', 'params', 'ports', 'position'];
const EDGE_FIELDS = ['id', 'source', 'sourcePort', 'target', 'targetPort'];
const PARAM_FIELDS = Object.freeze({
  input: [],
  output: [],
  prompt: ['prompt', 'copy', 'aspectRatio'],
  generate: ['modelId', 'size', 'quality', 'aspectRatio', 'tier'],
  edit: ['modelId', 'instruction', 'size', 'quality', 'aspectRatio', 'tier'],
  composite: ['templateId', 'brandColor', 'logoAssetId'],
});
const TEMPLATE_FIELDS = [
  'templateKey', 'name', 'description', 'taskType', 'nodes', 'edges', 'lockedNodes',
];
const TEMPLATE_VERSION_FIELDS = ['name', 'description', 'taskType', 'nodes', 'edges', 'lockedNodes'];
const SAVE_TEMPLATE_FIELDS = ['templateKey', 'name', 'description', 'revision'];
const INSTANCE_CREATE_FIELDS = ['templateKey', 'templateVersion'];
const INSTANCE_PATCH_FIELDS = ['nodes', 'edges', 'revision'];

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label = '请求体') {
  if (!isObject(value)) fail('INVALID_BODY', `${label}必须是 JSON 对象。`);
}

function rejectUnknown(value, allowed, label = '请求') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
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

function parseRevisionValue(value) {
  const number = typeof value === 'string' && /^r?\d+$/i.test(value.trim())
    ? Number(value.trim().replace(/^r/i, '')) : value;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    fail('INVALID_REVISION', '工作流修订号必须是正整数。');
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
    fail('REVISION_REQUIRED', '修改工作流需提供 If-Match 响应头或请求体中的 revision。', 428);
  }
  return value;
}

function normalizeTemplateKey(value, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_TEMPLATE_KEY', '模板键不能为空。');
    return null;
  }
  const key = String(value).trim();
  if (!TEMPLATE_KEY.test(key)) {
    fail('INVALID_TEMPLATE_KEY', '模板键需为 2–64 位小写字母、数字或连字符，并以字母开头。');
  }
  return key;
}

function normalizeTaskTypeKey(value, label = '交付项类型') {
  if (typeof value !== 'string' || !TASK_TYPE_KEYS.includes(value)) {
    fail('INVALID_TASK_TYPE', `${label}不在类型库内。`);
  }
  return value;
}

function normalizeNodeParams(type, raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('INVALID_NODE_PARAMS', '节点参数必须是 JSON 对象。');
  rejectUnknown(raw, PARAM_FIELDS[type], `${NODE_DEFINITIONS[type].label}节点参数`);
  if (JSON.stringify(raw).length > MAX_PARAMS_BYTES) {
    fail('NODE_PARAMS_TOO_LARGE', '节点参数过大。', 413);
  }
  const params = {};
  for (const key of PARAM_FIELDS[type]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (key === 'prompt') {
      if (typeof value !== 'string' || value.length > MAX_PROMPT_LENGTH) {
        fail('INVALID_NODE_PARAMS', `提示词必须是 0–${MAX_PROMPT_LENGTH} 个字符的文本。`);
      }
      params.prompt = value;
    } else if (key === 'copy') {
      if (!Array.isArray(value) || value.length > MAX_COPY_ITEMS) {
        fail('INVALID_NODE_PARAMS', `文案必须是最多 ${MAX_COPY_ITEMS} 条的数组。`);
      }
      const seen = new Set();
      params.copy = value.map(entry => {
        requireObject(entry, '文案');
        rejectUnknown(entry, ['slot', 'text'], '文案');
        if (!COPY_SLOTS.includes(entry.slot)) fail('INVALID_NODE_PARAMS', '文案槽位不受支持。');
        if (seen.has(entry.slot)) fail('INVALID_NODE_PARAMS', '同一节点的文案槽位不能重复。');
        seen.add(entry.slot);
        const text = textField(entry.text, '文案内容', 500, { required: true });
        return { slot: entry.slot, text };
      });
    } else if (key === 'modelId') {
      if (value === null || value === '') {
        params.modelId = null;
        continue;
      }
      const modelId = textField(value, '模型编号', 200, { required: true });
      if (!MODEL_ID.test(modelId)) fail('INVALID_NODE_PARAMS', '模型编号格式不正确。');
      params.modelId = modelId;
    } else if (key === 'aspectRatio') {
      if (value === null || value === '') continue;
      if (!ASPECT_RATIOS.includes(value)) {
        fail('INVALID_NODE_PARAMS', `画幅只能是：${ASPECT_RATIOS.join('、')}。`);
      }
      params.aspectRatio = value;
    } else if (key === 'tier') {
      if (value === null || value === '') continue;
      const tier = textField(value, '价格档位', 80);
      if (!TIER.test(tier)) fail('INVALID_NODE_PARAMS', '价格档位格式不正确。');
      params.tier = tier;
    } else if (key === 'brandColor') {
      if (value === null || value === '') continue;
      if (typeof value !== 'string' || !COLOR.test(value)) {
        fail('INVALID_NODE_PARAMS', '品牌色需为 #RGB 或 #RRGGBB。');
      }
      params.brandColor = value;
    } else {
      const label = key === 'size' ? '尺寸' : key === 'quality' ? '质量'
        : key === 'instruction' ? '修改指令' : key === 'templateId' ? '排版模板编号' : 'Logo 素材编号';
      const text = textField(value, label, key === 'instruction' ? 2000 : 200);
      if (text !== null) params[key] = text;
    }
  }
  return params;
}

function canonicalPorts(type) {
  return NODE_DEFINITIONS[type].ports.map(port => ({ ...port }));
}

function portsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((port, index) => {
    const other = right[index];
    return isObject(other)
      && port.id === other.id
      && port.direction === other.direction
      && port.type === other.type
      && Boolean(port.required) === Boolean(other.required);
  });
}

function normalizeNodePosition(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw) || Object.keys(raw).some(key => !['x', 'y'].includes(key))) {
    fail('INVALID_NODE_POSITION', '节点位置必须只包含 x、y 数值。');
  }
  const { x, y } = raw;
  if (![x, y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000)) {
    fail('INVALID_NODE_POSITION', '节点位置必须是有限且在画布范围内的坐标。');
  }
  return { x, y };
}

function normalizeNode(raw, index) {
  requireObject(raw, `节点 ${index + 1}`);
  rejectUnknown(raw, NODE_FIELDS, `节点 ${index + 1}`);
  const id = String(raw.id ?? '').trim();
  if (!NODE_ID.test(id)) {
    fail('INVALID_NODE_ID', '节点 id 需为 1–64 位字母、数字、下划线或连字符，并以字母开头。');
  }
  const type = String(raw.type ?? '');
  const definition = NODE_DEFINITIONS[type];
  if (!definition) fail('UNKNOWN_NODE_TYPE', `不支持的节点类型：${type}。`);
  const name = textField(raw.name, '节点名称', 100) || definition.label;
  const params = normalizeNodeParams(type, raw.params);
  const ports = canonicalPorts(type);
  if (raw.ports !== undefined && !portsEqual(raw.ports, ports)) {
    fail('INVALID_NODE_PORTS', '节点端口必须与系统定义的端口一致。');
  }
  const position = normalizeNodePosition(raw.position);
  return { id, type, name, params, ports, ...(position ? { position } : {}) };
}

function edgeKey(edge) {
  return `${edge.source}:${edge.sourcePort}->${edge.target}:${edge.targetPort}`;
}

function normalizeEdges(rawEdges, nodes, index) {
  if (!Array.isArray(rawEdges)) fail('INVALID_EDGES', '边必须是数组。');
  if (rawEdges.length > MAX_EDGES) fail('TOO_MANY_EDGES', `边不能超过 ${MAX_EDGES} 条。`);
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const seenIds = new Set();
  const occupiedInputs = new Set();
  const edges = [];
  for (let i = 0; i < rawEdges.length; i += 1) {
    const raw = rawEdges[i];
    requireObject(raw, `边 ${i + 1}`);
    rejectUnknown(raw, EDGE_FIELDS, `边 ${i + 1}`);
    const id = raw.id === undefined || raw.id === null || raw.id === ''
      ? `edge-${i + 1}` : String(raw.id).trim();
    if (!EDGE_ID.test(id)) fail('INVALID_EDGE_ID', '边 id 格式不正确。');
    if (seenIds.has(id)) fail('DUPLICATE_EDGE', `边 id 重复：${id}。`);
    seenIds.add(id);
    const source = String(raw.source ?? '').trim();
    const target = String(raw.target ?? '').trim();
    const sourcePortId = String(raw.sourcePort ?? '').trim();
    const targetPortId = String(raw.targetPort ?? '').trim();
    if (!nodeMap.has(source) || !nodeMap.has(target)) {
      fail('DANGLING_EDGE', `边 ${id} 的端点不存在。`);
    }
    if (source === target) fail('SELF_LOOP', `边 ${id} 不能连接节点自身。`);
    const sourceNode = nodeMap.get(source);
    const targetNode = nodeMap.get(target);
    const sourcePort = sourceNode.ports.find(port => port.id === sourcePortId);
    const targetPort = targetNode.ports.find(port => port.id === targetPortId);
    if (!sourcePort) fail('UNKNOWN_PORT', `源节点 ${source} 没有端口 ${sourcePortId}。`);
    if (!targetPort) fail('UNKNOWN_PORT', `目标节点 ${target} 没有端口 ${targetPortId}。`);
    if (sourcePort.direction !== 'out' || targetPort.direction !== 'in') {
      fail('INVALID_PORT_DIRECTION', '边必须从输出端口连到输入端口。');
    }
    if (sourcePort.type !== targetPort.type) {
      fail(
        'PORT_TYPE_MISMATCH',
        `端口类型不兼容：${sourcePort.id}(${sourcePort.type}) → ${targetPort.id}(${targetPort.type})。`,
      );
    }
    const inputKey = `${target}:${targetPortId}`;
    if (occupiedInputs.has(inputKey)) {
      fail('INPUT_PORT_OCCUPIED', `输入端口 ${inputKey} 已被占用，不能重复接入。`);
    }
    occupiedInputs.add(inputKey);
    edges.push({ id, source, sourcePort: sourcePortId, target, targetPort: targetPortId });
  }
  return edges;
}

function assertAcyclic(nodes, edges) {
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    indegree.set(edge.target, indegree.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }
  const queue = [];
  for (const [id, degree] of indegree) if (degree === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id)) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) {
    fail('DAG_CYCLE', '工作流不能包含有向环或回边。');
  }
}

function portMap(nodes) {
  return Object.fromEntries(nodes.map(node => [node.id, node.ports.map(port => ({ ...port }))]));
}

function normalizeLockedNodes(raw, nodes) {
  let locked = [];
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) fail('INVALID_LOCKED_NODES', '锁定节点必须是数组。');
    locked = raw.map(value => String(value));
  }
  const ids = new Set(locked);
  const nodeIds = new Set(nodes.map(node => node.id));
  for (const id of ids) {
    if (!nodeIds.has(id)) fail('UNKNOWN_LOCKED_NODE', `锁定节点 ${id} 不存在。`);
  }
  // input / output 是系统节点，永远锁定；按节点顺序输出，保证结果稳定。
  return nodes
    .filter(node => ids.has(node.id) || NODE_DEFINITIONS[node.type].system)
    .map(node => node.id);
}

// 图和端口的唯一校验入口。模板、实例创建与实例修改都走这里。
export function validateWorkflowGraph(rawNodes, rawEdges, { lockedNodes = [] } = {}) {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    fail('INVALID_NODES', '工作流至少需要一个节点。');
  }
  if (rawNodes.length > MAX_NODES) fail('TOO_MANY_NODES', `节点不能超过 ${MAX_NODES} 个。`);
  const nodes = rawNodes.map(normalizeNode);
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.id)) fail('DUPLICATE_NODE', `节点 id 重复：${node.id}。`);
    seen.add(node.id);
  }
  const inputs = nodes.filter(node => node.type === 'input');
  const outputs = nodes.filter(node => node.type === 'output');
  if (inputs.length !== 1) fail('INVALID_SYSTEM_NODE', '工作流必须且只能有一个商品资料（input）节点。');
  if (outputs.length !== 1) fail('INVALID_SYSTEM_NODE', '工作流必须且只能有一个交付候选（output）节点。');
  const edges = normalizeEdges(rawEdges, nodes, 0);
  assertAcyclic(nodes, edges);
  // 所有必需输入端口都必须有入边；否则开跑时必然缺少输入。
  const occupied = new Set(edges.map(edge => `${edge.target}:${edge.targetPort}`));
  for (const node of nodes) {
    for (const port of node.ports) {
      if (port.direction === 'in' && port.required && !occupied.has(`${node.id}:${port.id}`)) {
        fail('REQUIRED_PORT_UNCONNECTED', `节点 ${node.id} 的必需输入端口 ${port.id} 未连接。`);
      }
    }
  }
  return {
    nodes,
    edges,
    ports: portMap(nodes),
    lockedNodes: normalizeLockedNodes(lockedNodes, nodes),
  };
}

function templateNodeKey(node) {
  // JSONB 会重排对象键，不能直接用 JSON.stringify 比较端口；按字段取值比较。
  const ports = (Array.isArray(node.ports) ? node.ports : [])
    .map(port => [port.id, port.direction, port.type, Boolean(port.required)].join('/'))
    .join(',');
  return `${node.type}:${ports}`;
}

function rewritableOutputEdge(edge, lockedNodes, nodes) {
  return lockedNodes.has(edge.target)
    && nodes.get(edge.target)?.type === 'output'
    && edge.targetPort === 'result'
    && !lockedNodes.has(edge.source);
}

function protectedLockedEdges(previous) {
  const lockedNodes = new Set(previous.lockedNodes);
  const nodes = new Map(previous.nodes.map(node => [node.id, node]));
  return previous.edges
    .filter(edge => (lockedNodes.has(edge.source) || lockedNodes.has(edge.target))
      && !rewritableOutputEdge(edge, lockedNodes, nodes))
    .map(edgeKey);
}

// 系统节点本身保持锁定；唯一可替换的锁定连线是交付候选的图片输入，供插入改图节点。
export function assertLockedGraphPreserved(previous, next) {
  const previousLocked = new Set(previous.lockedNodes);
  const previousNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const nextNodes = new Map(next.nodes.map(node => [node.id, node]));
  for (const id of previousLocked) {
    const before = previousNodes.get(id);
    const after = nextNodes.get(id);
    if (!after) fail('LOCKED_NODE_PROTECTED', `锁定节点 ${id} 不可删除。`, 409);
    if (templateNodeKey(before) !== templateNodeKey(after)) {
      fail('LOCKED_NODE_PROTECTED', `锁定节点 ${id} 的类型或端口不可修改。`, 409);
    }
  }
  const nextEdges = new Set(next.edges.map(edgeKey));
  const lockedEdges = protectedLockedEdges(previous);
  for (const key of lockedEdges) {
    if (!nextEdges.has(key)) {
      fail('LOCKED_EDGE_PROTECTED', `锁定节点的必需连线 ${key} 不可断开。`, 409);
    }
  }
  return next;
}

function clone(value) {
  return structuredClone(value);
}

// 在完整图校验之前先用原始请求检查锁定结构，保证“删除/改类型/断开锁定边”
// 返回明确的 409 锁定错误，而不是被后续的端口错误掩盖。
export function assertLockedRawPreserved(previous, rawNodes, rawEdges) {
  const previousLocked = new Set(previous.lockedNodes);
  const previousNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const rawById = new Map();
  for (const node of rawNodes) {
    if (isObject(node) && typeof node.id === 'string') rawById.set(node.id, node);
  }
  for (const id of previousLocked) {
    const before = previousNodes.get(id);
    const raw = rawById.get(id);
    if (!raw) fail('LOCKED_NODE_PROTECTED', `锁定节点 ${id} 不可删除。`, 409);
    if (raw.type !== before.type) {
      fail('LOCKED_NODE_PROTECTED', `锁定节点 ${id} 的类型不可修改。`, 409);
    }
    if (raw.ports !== undefined && !portsEqual(raw.ports, before.ports)) {
      fail('LOCKED_NODE_PROTECTED', `锁定节点 ${id} 的端口不可修改。`, 409);
    }
  }
  const rawKeys = new Set(rawEdges
    .filter(isObject)
    .map(edge => `${edge.source}:${edge.sourcePort}->${edge.target}:${edge.targetPort}`));
  const lockedEdges = protectedLockedEdges(previous);
  for (const key of lockedEdges) {
    if (!rawKeys.has(key)) {
      fail('LOCKED_EDGE_PROTECTED', `锁定节点的必需连线 ${key} 不可断开。`, 409);
    }
  }
}

function fillDeliverableDefaults(rawNodes, deliverable) {
  const promptText = typeof deliverable.promptText === 'string' ? deliverable.promptText : '';
  const aspectRatio = deliverable.prompt?.aspectRatio;
  const modelId = deliverable.parameters?.modelId || null;
  const copy = Array.isArray(deliverable.copy) ? deliverable.copy : [];
  return rawNodes.map(raw => {
    const node = clone(raw);
    if (node.type === 'prompt') {
      if (!node.params.prompt && promptText) node.params.prompt = promptText;
      if ((!Array.isArray(node.params.copy) || node.params.copy.length === 0) && copy.length) {
        node.params.copy = clone(copy).slice(0, MAX_COPY_ITEMS);
      }
      if (!node.params.aspectRatio && aspectRatio) node.params.aspectRatio = aspectRatio;
    }
    if (['generate', 'edit'].includes(node.type)) {
      if (!node.params.modelId && modelId) node.params.modelId = modelId;
      if (!node.params.aspectRatio && aspectRatio) node.params.aspectRatio = aspectRatio;
    }
    return node;
  });
}

export class WorkflowService {
  constructor(repository, { projects = null, models = null, audit = null, now = () => new Date(), idFactory = randomUUID } = {}) {
    if (!repository) throw new AppError('WORKFLOW_UNAVAILABLE', '工作流仓储未配置。', 500);
    this.repository = repository;
    this.projects = projects;
    this.models = models;
    this.audit = audit;
    this.now = now;
    this.idFactory = idFactory;
  }

  async #record(action, { targetType, targetId, result = 'success', detail = {}, context = {} }) {
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
      // 审计失败不改变业务结果；与任务时间线的处理一致。
      return null;
    }
  }

  async #assertTemplateAccess(template, workspaceId) {
    if (!workspaceId || template.isSystem) return;
    if (template.workspaceId !== workspaceId) fail('FORBIDDEN', '无权访问该工作流模板。', 403);
  }

  async #assertModels(nodes, { previous = null } = {}) {
    // 已有实例的模型是快照：修改其它节点时保留原模型，即使它后来被停用；
    // 新引入（或新模板/新实例中引用）的模型必须存在、启用且可执行。
    const carried = new Set(previous
      ? previous.nodes.map(node => node.params?.modelId).filter(Boolean)
      : []);
    const checked = new Set();
    for (const node of nodes) {
      const modelId = node.params?.modelId;
      if (!modelId || checked.has(modelId)) continue;
      checked.add(modelId);
      if (carried.has(modelId)) continue;
      if (!this.models) {
        throw new AppError('MODEL_REGISTRY_UNAVAILABLE', '模型注册表暂不可用，无法校验节点模型。', 503);
      }
      const model = await this.models.getModel(modelId);
      if (!model) fail('MODEL_NOT_FOUND', `节点引用的模型 ${modelId} 不存在。`, 422);
      if (!model.enabled) fail('MODEL_DISABLED', `节点引用的模型 ${modelId} 已停用，不能用于新工作流。`, 422);
      if (!model.executable) fail('MODEL_NOT_EXECUTABLE', `节点引用的模型 ${modelId} 尚未接入执行器。`, 422);
      const capability = IMAGE_CAPABILITIES[node.type];
      if (capability && Array.isArray(model.capabilities) && !model.capabilities.includes(capability)) {
        fail('UNSUPPORTED_CAPABILITY', `模型 ${modelId} 不支持能力 ${capability}。`, 422);
      }
    }
  }

  async #projectContext(projectId, planVersion, deliverableId, workspaceId) {
    if (!this.projects) {
      throw new AppError('PROJECTS_UNAVAILABLE', '项目模块暂不可用，无法校验交付项。', 503);
    }
    const project = uuidField(projectId, '项目编号');
    const deliverable = uuidField(deliverableId, '交付项编号');
    const version = integerField(planVersion, '方案版本', { min: 1 });
    const context = await this.projects.getDeliverable({
      projectId: project, planVersion: version, deliverableId: deliverable,
    });
    if (!context) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (workspaceId && context.workspaceId !== workspaceId) {
      throw new AppError('FORBIDDEN', '无权访问该项目。', 403);
    }
    return context;
  }

  // ---- 任务类型 ----

  async listTaskTypes({ enabledOnly = false } = {}) {
    const rows = await this.repository.listTaskTypes();
    const types = rows
      .filter(row => !enabledOnly || row.enabled)
      .map(publicTaskType);
    return { types, portTypes: [...PORT_TYPES] };
  }

  async #taskType(key, { requireEnabled = true } = {}) {
    const typeKey = normalizeTaskTypeKey(key);
    const row = await this.repository.getTaskType(typeKey);
    if (!row) fail('UNKNOWN_TASK_TYPE', '交付项类型不存在。', 404);
    if (requireEnabled && !row.enabled) {
      fail('TASK_TYPE_DISABLED', '该交付项类型已停用。', 409);
    }
    return row;
  }

  // ---- 模板 ----

  async listTemplates({ taskType = null, status = null, workspaceId = null } = {}) {
    if (taskType !== null && taskType !== '') normalizeTaskTypeKey(taskType);
    if (status !== null && status !== '' && !TEMPLATE_STATUSES.includes(status)) {
      fail('INVALID_FILTER', '模板状态只能是 active 或 disabled。');
    }
    const rows = await this.repository.listTemplates({
      taskType: taskType || null,
      status: status || null,
      workspaceId,
    });
    return { templates: rows.map(publicTemplate) };
  }

  async getTemplate(key, version = null, { workspaceId = null } = {}) {
    const templateKey = normalizeTemplateKey(key);
    const versionNumber = version === null || version === undefined || version === ''
      ? null : integerField(version, '模板版本', { min: 1 });
    const row = await this.repository.getTemplate(templateKey, versionNumber);
    if (!row) fail('TEMPLATE_NOT_FOUND', '工作流模板不存在。', 404);
    await this.#assertTemplateAccess(row, workspaceId);
    return { template: publicTemplate(row) };
  }

  async listTemplateVersions(key, { workspaceId = null } = {}) {
    const templateKey = normalizeTemplateKey(key);
    const rows = await this.repository.listTemplateVersions(templateKey);
    if (!rows.length) fail('TEMPLATE_NOT_FOUND', '工作流模板不存在。', 404);
    await this.#assertTemplateAccess(rows[0], workspaceId);
    return { templateKey, versions: rows.map(publicTemplate) };
  }

  async createTemplate(body, { workspaceId = 'local', ...context } = {}) {
    requireObject(body, '模板');
    rejectUnknown(body, TEMPLATE_FIELDS, '模板');
    const templateKey = normalizeTemplateKey(body.templateKey);
    if (templateKey.startsWith('system-')) {
      fail('SYSTEM_TEMPLATE_PROTECTED', '系统模板不可修改，请另存为新模板。', 403);
    }
    const name = textField(body.name, '模板名称', 200, { required: true });
    const description = textField(body.description, '模板说明', 2000);
    const taskType = await this.#taskType(body.taskType);
    const graph = validateWorkflowGraph(body.nodes, body.edges, { lockedNodes: body.lockedNodes });
    await this.#assertModels(graph.nodes);
    const record = {
      id: this.idFactory(),
      workspaceId: workspaceId || 'local',
      templateKey,
      name,
      description,
      taskType: taskType.typeKey,
      nodes: graph.nodes,
      edges: graph.edges,
      ports: graph.ports,
      lockedNodes: graph.lockedNodes,
      status: 'active',
      isSystem: false,
      createdBy: context.actor?.id || null,
      createdAt: this.now(),
    };
    const saved = await this.repository.createTemplateVersion(record, { createOnly: true });
    await this.#record('workflow.template.created', {
      targetType: 'workflow_template',
      targetId: `${templateKey}:v${saved.version}`,
      detail: {
        templateKey, version: saved.version, taskType: taskType.typeKey, nodeCount: graph.nodes.length,
      },
      context,
    });
    return { template: publicTemplate(saved) };
  }

  async appendTemplateVersion(key, body, { workspaceId = null, ...context } = {}) {
    requireObject(body, '模板版本');
    rejectUnknown(body, TEMPLATE_VERSION_FIELDS, '模板版本');
    const templateKey = normalizeTemplateKey(key);
    if (templateKey.startsWith('system-')) {
      fail('SYSTEM_TEMPLATE_PROTECTED', '系统模板不可修改，请另存为新模板。', 403);
    }
    const latest = await this.repository.getTemplate(templateKey, null);
    if (!latest) fail('TEMPLATE_NOT_FOUND', '工作流模板不存在。', 404);
    await this.#assertTemplateAccess(latest, workspaceId);
    if (body.taskType !== undefined && normalizeTaskTypeKey(body.taskType) !== latest.taskType) {
      fail('TEMPLATE_TYPE_MISMATCH', '新版本不能更换模板绑定的交付项类型。');
    }
    const taskType = await this.#taskType(latest.taskType);
    const graph = validateWorkflowGraph(body.nodes, body.edges, {
      lockedNodes: body.lockedNodes === undefined ? latest.lockedNodes : body.lockedNodes,
    });
    await this.#assertModels(graph.nodes);
    const record = {
      id: this.idFactory(),
      workspaceId: latest.workspaceId,
      templateKey,
      name: textField(body.name, '模板名称', 200) || latest.name,
      description: body.description === undefined
        ? latest.description : textField(body.description, '模板说明', 2000),
      taskType: taskType.typeKey,
      nodes: graph.nodes,
      edges: graph.edges,
      ports: graph.ports,
      lockedNodes: graph.lockedNodes,
      status: 'active',
      isSystem: false,
      createdBy: context.actor?.id || latest.createdBy || null,
      createdAt: this.now(),
    };
    const saved = await this.repository.createTemplateVersion(record, { createOnly: false });
    await this.#record('workflow.template.version.created', {
      targetType: 'workflow_template',
      targetId: `${templateKey}:v${saved.version}`,
      detail: {
        templateKey, version: saved.version, taskType: saved.taskType,
        previousVersion: latest.version, nodeCount: graph.nodes.length,
      },
      context,
    });
    return { template: publicTemplate(saved) };
  }

  // ---- 交付项实例 ----

  async getDeliverableInstance(projectId, planVersion, deliverableId, { workspaceId = null } = {}) {
    const context = await this.#projectContext(projectId, planVersion, deliverableId, workspaceId);
    const instance = await this.repository.getInstanceForDeliverable(
      context.projectId, context.planVersion, context.deliverable.id,
    );
    if (!instance) fail('INSTANCE_NOT_FOUND', '该交付项尚未创建工作流实例。', 404);
    return {
      instance: publicInstance(instance),
      deliverable: publicDeliverable(context.deliverable),
      planStatus: context.planStatus,
      runnable: context.planStatus === 'confirmed',
    };
  }

  async getInstance(id, { workspaceId = null } = {}) {
    const instanceId = uuidField(id, '工作流实例编号');
    const instance = await this.repository.getInstance(instanceId);
    if (!instance) fail('INSTANCE_NOT_FOUND', '工作流实例不存在。', 404);
    if (workspaceId && instance.workspaceId !== workspaceId) {
      throw new AppError('FORBIDDEN', '无权访问该工作流实例。', 403);
    }
    return { instance: publicInstance(instance) };
  }

  async createInstance(projectId, planVersion, deliverableId, body = {}, { workspaceId = 'local', ...context } = {}) {
    requireObject(body, '工作流实例');
    rejectUnknown(body, INSTANCE_CREATE_FIELDS, '工作流实例');
    const contextRow = await this.#projectContext(projectId, planVersion, deliverableId, workspaceId);
    const deliverable = contextRow.deliverable;
    const taskType = await this.#taskType(deliverable.type);
    const existing = await this.repository.getInstanceForDeliverable(
      contextRow.projectId, contextRow.planVersion, deliverable.id,
    );
    if (existing) fail('INSTANCE_EXISTS', '该交付项已有工作流实例。', 409);

    const templateKey = normalizeTemplateKey(
      body.templateKey === undefined || body.templateKey === null || body.templateKey === ''
        ? taskType.defaultTemplateKey : body.templateKey,
    );
    const templateVersion = body.templateVersion === undefined || body.templateVersion === null
      || body.templateVersion === ''
      ? null : integerField(body.templateVersion, '模板版本', { min: 1 });
    const template = await this.repository.getTemplate(templateKey, templateVersion);
    if (!template) fail('TEMPLATE_NOT_FOUND', '工作流模板不存在。', 404);
    await this.#assertTemplateAccess(template, workspaceId);
    if (template.status !== 'active') fail('TEMPLATE_DISABLED', '该模板已停用。', 409);
    if (template.taskType !== taskType.typeKey) {
      fail('TEMPLATE_TYPE_MISMATCH', '模板绑定的交付项类型与当前交付项不一致。');
    }

    const nodes = fillDeliverableDefaults(template.nodes, deliverable);
    const graph = validateWorkflowGraph(nodes, clone(template.edges), {
      lockedNodes: template.lockedNodes,
    });
    await this.#assertModels(graph.nodes);
    const record = {
      id: this.idFactory(),
      workspaceId: contextRow.workspaceId || workspaceId || 'local',
      projectId: contextRow.projectId,
      planVersion: contextRow.planVersion,
      deliverableId: deliverable.id,
      taskType: taskType.typeKey,
      templateId: template.id,
      templateKey: template.templateKey,
      templateVersion: template.version,
      nodes: graph.nodes,
      edges: graph.edges,
      ports: graph.ports,
      lockedNodes: graph.lockedNodes,
      revision: 1,
      createdBy: context.actor?.id || null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const saved = await this.repository.insertInstance(record);
    await this.#record('workflow.instance.created', {
      targetType: 'workflow_instance',
      targetId: saved.id,
      detail: {
        projectId: saved.projectId,
        planVersion: saved.planVersion,
        deliverableId: saved.deliverableId,
        taskType: saved.taskType,
        templateKey: saved.templateKey,
        templateVersion: saved.templateVersion,
        nodeCount: saved.nodes.length,
        planStatus: contextRow.planStatus,
      },
      context,
    });
    return {
      instance: publicInstance(saved),
      deliverable: publicDeliverable(deliverable),
      planStatus: contextRow.planStatus,
      runnable: contextRow.planStatus === 'confirmed',
    };
  }

  async updateInstance(id, body, { workspaceId = null, ifMatch = undefined, allowStartedRun = false, ...context } = {}) {
    requireObject(body, '工作流实例');
    rejectUnknown(body, INSTANCE_PATCH_FIELDS, '工作流实例');
    const instanceId = uuidField(id, '工作流实例编号');
    const expected = readExpectedRevision(body, ifMatch);
    const current = await this.repository.getInstance(instanceId);
    if (!current) fail('INSTANCE_NOT_FOUND', '工作流实例不存在。', 404);
    if (workspaceId && current.workspaceId !== workspaceId) {
      throw new AppError('FORBIDDEN', '无权修改该工作流实例。', 403);
    }
    if (current.revision !== expected) {
      fail('REVISION_CONFLICT', '工作流已被其他改动更新，请刷新后重试。', 409);
    }
    const nodes = body.nodes === undefined ? current.nodes : body.nodes;
    const edges = body.edges === undefined ? current.edges : body.edges;
    let graph;
    try {
      if (Array.isArray(nodes) && Array.isArray(edges)) {
        assertLockedRawPreserved(current, nodes, edges);
      }
      graph = validateWorkflowGraph(nodes, edges, { lockedNodes: current.lockedNodes });
      assertLockedGraphPreserved(current, graph);
    } catch (error) {
      if (error instanceof AppError && error.code.startsWith('LOCKED_')) {
        await this.#record('workflow.instance.locked_violation', {
          targetType: 'workflow_instance',
          targetId: current.id,
          result: 'failure',
          detail: {
            code: error.code,
            projectId: current.projectId,
            deliverableId: current.deliverableId,
          },
          context,
        });
      }
      throw error;
    }
    await this.#assertModels(graph.nodes, { previous: current });
    const result = await this.repository.updateInstance(instanceId, expected, {
      nodes: graph.nodes,
      edges: graph.edges,
      ports: graph.ports,
      allowStartedRun,
      updatedAt: this.now(),
    });
    if (result.status === 'missing') fail('INSTANCE_NOT_FOUND', '工作流实例不存在。', 404);
    if (result.status === 'frozen') fail('INSTANCE_FROZEN', '工作流已开始运行，普通编辑已锁定。', 409);
    if (result.status === 'conflict') {
      fail('REVISION_CONFLICT', '工作流已被其他改动更新，请刷新后重试。', 409);
    }
    await this.#record('workflow.instance.updated', {
      targetType: 'workflow_instance',
      targetId: result.instance.id,
      detail: {
        projectId: result.instance.projectId,
        deliverableId: result.instance.deliverableId,
        revision: result.instance.revision,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
      context,
    });
    return { instance: publicInstance(result.instance) };
  }

  async saveInstanceAsTemplate(id, body = {}, { workspaceId = null, ifMatch = undefined, ...context } = {}) {
    requireObject(body, '另存模板');
    rejectUnknown(body, SAVE_TEMPLATE_FIELDS, '另存模板');
    const instanceId = uuidField(id, '工作流实例编号');
    const expected = readExpectedRevision(body, ifMatch);
    const instance = await this.repository.getInstance(instanceId);
    if (!instance) fail('INSTANCE_NOT_FOUND', '工作流实例不存在。', 404);
    if (workspaceId && instance.workspaceId !== workspaceId) {
      throw new AppError('FORBIDDEN', '无权访问该工作流实例。', 403);
    }
    if (instance.revision !== expected) {
      fail('REVISION_CONFLICT', '工作流已被其他改动更新，请刷新后重试。', 409);
    }
    const templateKey = normalizeTemplateKey(
      body.templateKey === undefined || body.templateKey === null || body.templateKey === ''
        ? `custom-${instance.id.slice(0, 8)}` : body.templateKey,
    );
    if (templateKey.startsWith('system-')) {
      fail('SYSTEM_TEMPLATE_PROTECTED', '系统模板不可修改，请另存为新模板。', 403);
    }
    const taskType = await this.#taskType(instance.taskType);
    const graph = validateWorkflowGraph(clone(instance.nodes), clone(instance.edges), {
      lockedNodes: instance.lockedNodes,
    });
    await this.#assertModels(graph.nodes);
    const latest = await this.repository.getTemplate(templateKey, null);
    if (latest) {
      await this.#assertTemplateAccess(latest, workspaceId);
      if (latest.isSystem) {
        fail('SYSTEM_TEMPLATE_PROTECTED', '系统模板不可追加版本，请使用新的模板键。', 403);
      }
      if (latest.taskType !== instance.taskType) {
        fail('TEMPLATE_TYPE_MISMATCH', '目标模板绑定了其他交付项类型。');
      }
    }
    const record = {
      id: this.idFactory(),
      workspaceId: latest?.workspaceId || instance.workspaceId || workspaceId || 'local',
      templateKey,
      name: textField(body.name, '模板名称', 200)
        || `${taskType.name}工作流（来自实例）`,
      description: textField(body.description, '模板说明', 2000)
        || `由交付项工作流实例 ${instance.id} 另存。`,
      taskType: instance.taskType,
      nodes: graph.nodes,
      edges: graph.edges,
      ports: graph.ports,
      lockedNodes: graph.lockedNodes,
      status: 'active',
      isSystem: false,
      createdBy: context.actor?.id || null,
      createdAt: this.now(),
    };
    const saved = await this.repository.createTemplateVersion(record, { createOnly: false });
    await this.#record('workflow.instance.template_saved', {
      targetType: 'workflow_template',
      targetId: `${templateKey}:v${saved.version}`,
      detail: {
        templateKey,
        version: saved.version,
        taskType: saved.taskType,
        sourceInstanceId: instance.id,
        sourceRevision: instance.revision,
      },
      context,
    });
    return { template: publicTemplate(saved) };
  }
}

export function publicTaskType(row) {
  return {
    typeKey: row.typeKey,
    name: row.name,
    purpose: row.purpose ?? null,
    defaultAspectRatio: row.defaultAspectRatio ?? null,
    defaultTemplateKey: row.defaultTemplateKey,
    defaultNodeTemplate: row.defaultNodeTemplate || {},
    enabled: row.enabled !== false,
    version: row.version,
    updatedAt: row.updatedAt ?? null,
  };
}

export function publicTemplate(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? 'local',
    templateKey: row.templateKey,
    name: row.name,
    description: row.description ?? null,
    taskType: row.taskType,
    version: row.version,
    nodes: clone(row.nodes || []),
    edges: clone(row.edges || []),
    ports: clone(row.ports || {}),
    lockedNodes: clone(row.lockedNodes || []),
    status: row.status,
    isSystem: Boolean(row.isSystem),
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
  };
}

export function publicInstance(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? 'local',
    projectId: row.projectId,
    planVersion: row.planVersion,
    deliverableId: row.deliverableId,
    taskType: row.taskType,
    templateId: row.templateId ?? null,
    templateKey: row.templateKey,
    templateVersion: row.templateVersion,
    nodes: clone(row.nodes || []),
    edges: clone(row.edges || []),
    ports: clone(row.ports || {}),
    lockedNodes: clone(row.lockedNodes || []),
    revision: row.revision,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicDeliverable(deliverable) {
  return {
    id: deliverable.id,
    type: deliverable.type,
    title: deliverable.title ?? null,
    status: deliverable.status ?? null,
  };
}

// ---- PostgreSQL 仓储 ----

function taskTypeRow(row) {
  if (!row) return null;
  return {
    typeKey: row.type_key,
    name: row.name,
    purpose: row.purpose,
    defaultAspectRatio: row.default_aspect_ratio,
    defaultTemplateKey: row.default_template_key,
    defaultNodeTemplate: row.default_node_template,
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function templateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    templateKey: row.template_key,
    name: row.name,
    description: row.description,
    taskType: row.task_type,
    version: row.version,
    nodes: row.nodes,
    edges: row.edges,
    ports: row.ports,
    lockedNodes: row.locked_nodes,
    status: row.status,
    isSystem: row.is_system,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function instanceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planVersion: row.plan_version,
    deliverableId: row.deliverable_id,
    taskType: row.task_type,
    templateId: row.template_id,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    nodes: row.nodes,
    edges: row.edges,
    ports: row.ports,
    lockedNodes: row.locked_nodes,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgWorkflowRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listTaskTypes() {
    const rows = await this.pool.query('SELECT * FROM sj_task_types ORDER BY type_key');
    return rows.rows.map(taskTypeRow);
  }

  async getTaskType(typeKey) {
    return taskTypeRow((await this.pool.query(
      'SELECT * FROM sj_task_types WHERE type_key=$1', [typeKey],
    )).rows[0]);
  }

  async listTemplates({ taskType = null, status = null, workspaceId = null } = {}) {
    const values = [];
    const where = [];
    if (taskType) {
      values.push(taskType);
      where.push(`task_type=$${values.length}`);
    }
    if (status) {
      values.push(status);
      where.push(`status=$${values.length}`);
    }
    if (workspaceId) {
      values.push(workspaceId);
      where.push(`(is_system OR workspace_id=$${values.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (template_key) *
        FROM sj_workflow_templates
        ${whereSql}
        ORDER BY template_key, version DESC
      ) latest
      ORDER BY task_type, template_key
    `, values);
    return rows.rows.map(templateRow);
  }

  async getTemplate(templateKey, version = null) {
    const rows = version
      ? await this.pool.query(
        'SELECT * FROM sj_workflow_templates WHERE template_key=$1 AND version=$2',
        [templateKey, version],
      )
      : await this.pool.query(
        'SELECT * FROM sj_workflow_templates WHERE template_key=$1 ORDER BY version DESC LIMIT 1',
        [templateKey],
      );
    return templateRow(rows.rows[0]);
  }

  async listTemplateVersions(templateKey) {
    const rows = await this.pool.query(
      'SELECT * FROM sj_workflow_templates WHERE template_key=$1 ORDER BY version DESC',
      [templateKey],
    );
    return rows.rows.map(templateRow);
  }

  // 版本号在模板键级 advisory lock 内计算，避免两个并发追加拿到同一版本。
  async createTemplateVersion(template, { createOnly = false } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sj:workflow-template:' || $1))", [
        template.templateKey,
      ]);
      const max = Number((await client.query(
        'SELECT COALESCE(MAX(version), 0)::int AS version FROM sj_workflow_templates WHERE template_key=$1',
        [template.templateKey],
      )).rows[0].version);
      if (createOnly && max > 0) {
        throw new AppError('TEMPLATE_EXISTS', '模板键已存在，请追加新版本或使用新的模板键。', 409);
      }
      const version = max + 1;
      const inserted = await client.query(`
        INSERT INTO sj_workflow_templates
          (id,workspace_id,template_key,name,description,task_type,version,
           nodes,edges,ports,locked_nodes,status,is_system,created_by,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *
      `, [
        template.id, template.workspaceId, template.templateKey, template.name,
        template.description, template.taskType, version,
        JSON.stringify(template.nodes), JSON.stringify(template.edges),
        JSON.stringify(template.ports), JSON.stringify(template.lockedNodes),
        template.status, template.isSystem, template.createdBy, template.createdAt,
      ]);
      await client.query('COMMIT');
      return templateRow(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getInstance(id) {
    return instanceRow((await this.pool.query(
      'SELECT * FROM sj_workflow_instances WHERE id=$1', [id],
    )).rows[0]);
  }

  async getInstanceForDeliverable(projectId, planVersion, deliverableId) {
    return instanceRow((await this.pool.query(
      `SELECT * FROM sj_workflow_instances
       WHERE project_id=$1 AND plan_version=$2 AND deliverable_id=$3`,
      [projectId, planVersion, deliverableId],
    )).rows[0]);
  }

  async insertInstance(instance) {
    try {
      const inserted = await this.pool.query(`
        INSERT INTO sj_workflow_instances
          (id,workspace_id,project_id,plan_version,deliverable_id,task_type,
           template_id,template_key,template_version,nodes,edges,ports,locked_nodes,
           revision,created_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING *
      `, [
        instance.id, instance.workspaceId, instance.projectId, instance.planVersion,
        instance.deliverableId, instance.taskType, instance.templateId,
        instance.templateKey, instance.templateVersion,
        JSON.stringify(instance.nodes), JSON.stringify(instance.edges),
        JSON.stringify(instance.ports), JSON.stringify(instance.lockedNodes),
        instance.revision, instance.createdBy, instance.createdAt, instance.updatedAt,
      ]);
      return instanceRow(inserted.rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError('INSTANCE_EXISTS', '该交付项已有工作流实例。', 409);
      }
      throw error;
    }
  }

  async updateInstance(id, expectedRevision, patch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lockedRow = (await client.query(
        'SELECT * FROM sj_workflow_instances WHERE id=$1 FOR UPDATE', [id],
      )).rows[0];
      if (!lockedRow) {
        await client.query('ROLLBACK');
        return { status: 'missing' };
      }
      const current = instanceRow(lockedRow);
      if (current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { status: 'conflict', revision: current.revision };
      }
      if (!patch.allowStartedRun) {
        const started = await client.query(
          'SELECT 1 FROM sj_workflow_runs WHERE workflow_instance_id=$1 AND started_at IS NOT NULL LIMIT 1', [id],
        );
        if (started.rowCount) {
          await client.query('ROLLBACK');
          return { status: 'frozen', revision: current.revision };
        }
      }
      const updated = (await client.query(`
        UPDATE sj_workflow_instances
        SET nodes=$3,edges=$4,ports=$5,revision=revision+1,updated_at=$6
        WHERE id=$1 AND revision=$2
        RETURNING *
      `, [
        id, expectedRevision, JSON.stringify(patch.nodes), JSON.stringify(patch.edges),
        JSON.stringify(patch.ports), patch.updatedAt,
      ])).rows[0];
      if (!updated) {
        await client.query('ROLLBACK');
        return { status: 'conflict', revision: current.revision };
      }
      await client.query('COMMIT');
      return { status: 'ok', instance: instanceRow(updated) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

// 项目与交付项校验：直接读取 #12 的表，但只读，不修改方案行。
export class PgWorkflowProjectLookup {
  constructor(pool) {
    this.pool = pool;
  }

  async getDeliverable({ projectId, planVersion, deliverableId }) {
    let rows;
    try {
      rows = await this.pool.query(`
        SELECT p.id AS project_id, p.workspace_id, p.status AS project_status,
               pl.version AS plan_version, pl.status AS plan_status, pl.deliverables
        FROM sj_projects p
        LEFT JOIN sj_project_plans pl ON pl.project_id=p.id AND pl.version=$2
        WHERE p.id=$1
      `, [projectId, planVersion]);
    } catch (error) {
      if (error.code === '42P01') {
        throw new AppError('PROJECTS_UNAVAILABLE', '项目模块尚未部署，无法创建工作流实例。', 503);
      }
      throw error;
    }
    const project = rows.rows[0];
    if (!project) return null;
    if (project.plan_version === null || project.plan_version === undefined) {
      throw new AppError('PLAN_NOT_FOUND', '方案版本不存在。', 404);
    }
    const deliverables = Array.isArray(project.deliverables) ? project.deliverables : [];
    const deliverable = deliverables.find(item => item?.id === deliverableId);
    if (!deliverable) throw new AppError('DELIVERABLE_NOT_FOUND', '交付项不存在。', 404);
    return {
      projectId: project.project_id,
      workspaceId: project.workspace_id,
      projectStatus: project.project_status,
      planVersion: project.plan_version,
      planStatus: project.plan_status,
      deliverable,
    };
  }
}

// 节点模型校验：只读取 sj_models，不调用供应商、不产生费用。
export class PgWorkflowModelLookup {
  constructor(pool) {
    this.pool = pool;
  }

  async getModel(id) {
    const row = (await this.pool.query(
      'SELECT id, enabled, executable, capabilities FROM sj_models WHERE id=$1', [id],
    )).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      enabled: row.enabled,
      executable: row.executable,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    };
  }
}
