// Client-side workflow graph model for the React Flow canvas (Issue #15).
//
// The browser-local demo stores one workflow per deliverable as a single
// upstream link (`node.from`). Keeping the model that simple makes the same
// data readable by the six-step view. Validation mirrors `server/workflow.mjs`:
// no self loops, no cycles, no duplicate / occupied edges, compatible port
// types, and every required input must be connected. Nothing here starts a
// generation, reserves credit or changes plan confirmation state.

export const PORT = Object.freeze({
  prompt: Object.freeze({ input: null, output: 'text' }),
  generate: Object.freeze({ input: 'text', output: 'image' }),
  edit: Object.freeze({ input: 'image', output: 'image' }),
  composite: Object.freeze({ input: 'image', output: 'image' }),
});

export const PORT_LABEL = Object.freeze({ text: '文本', image: '图片', data: '资料' });
export const LANE_GAP = 190;
export const NODE_STEP_X = 235;
export const PROMPT_X = 12;
export const LANE_X = 240;

const ok = () => ({ ok: true });
const bad = (code, message) => ({ ok: false, code, message });

export function nextFlowNodeId(item) {
  return 'n' + (Math.max(0, ...item.flow.map(node => Number(String(node.id).slice(1)) || 0)) + 1);
}

// One lane starts at each generate node and follows non-generate downstream
// nodes. Mirrors `lane()` in review.js without importing it (review.js imports
// this module for layout).
export function flowLanes(item) {
  return item.flow.filter(node => node.type === 'generate').map(generate => {
    const out = [generate];
    let current = generate;
    while ((current = item.flow.find(node => node.from === current.id && node.type !== 'generate'))) {
      out.push(current);
    }
    return out;
  });
}

export function validateFlow(item) {
  const flow = item?.flow;
  if (!Array.isArray(flow) || flow.length === 0) return bad('EMPTY_FLOW', '工作流至少需要一个节点。');
  const byId = new Map();
  for (const node of flow) {
    if (!node || typeof node.id !== 'string' || !node.id) return bad('INVALID_NODE', '节点缺少编号。');
    if (byId.has(node.id)) return bad('DUPLICATE_NODE', `节点编号重复：${node.id}。`);
    if (!PORT[node.type]) return bad('UNKNOWN_NODE_TYPE', `不支持的节点类型：${node.type}。`);
    byId.set(node.id, node);
  }
  const prompts = flow.filter(node => node.type === 'prompt');
  if (prompts.length !== 1) return bad('INVALID_ROOT', '工作流必须且只能有一个文本提示词根节点。');

  for (const node of flow) {
    if (node.type === 'prompt') {
      if (node.from) return bad('PROMPT_HAS_INPUT', '文本提示词根节点不能有输入连线。');
      continue;
    }
    if (!node.from) {
      return bad('REQUIRED_PORT_UNCONNECTED', `节点 ${node.id} 的必需输入端口未连接。`);
    }
    if (node.from === node.id) return bad('SELF_LOOP', `节点 ${node.id} 不能连接自身。`);
    const source = byId.get(node.from);
    if (!source) return bad('DANGLING_EDGE', `节点 ${node.id} 的上游 ${node.from} 不存在。`);
    const output = PORT[source.type].output;
    const input = PORT[node.type].input;
    if (output !== input) {
      return bad(
        'PORT_TYPE_MISMATCH',
        `端口类型不兼容：${PORT_LABEL[output] || output} → ${PORT_LABEL[input] || input}（${source.id} → ${node.id}）。`,
      );
    }
  }

  const edges = new Set();
  for (const node of flow) {
    if (!node.from) continue;
    const key = `${node.from}->${node.id}`;
    if (edges.has(key)) return bad('DUPLICATE_EDGE', `重复连线：${key}。`);
    edges.add(key);
  }

  // Each node has at most one upstream link, so following `from` until a root
  // detects every directed cycle / back edge.
  for (const node of flow) {
    const seen = new Set();
    let current = node;
    while (current) {
      if (seen.has(current.id)) return bad('DAG_CYCLE', '工作流不能包含有向环或回边。');
      seen.add(current.id);
      current = current.from ? byId.get(current.from) : null;
    }
  }
  return ok();
}

// Pure check used before persisting a connection. A compatible drag onto an
// already-connected input replaces that one upstream edge (the saved graph
// still has exactly one edge per input, as the server requires). The tentative
// link is restored before returning, so a rejected connection never reaches
// storage.
export function connectionError(item, sourceId, targetId) {
  const source = item.flow.find(node => node.id === sourceId);
  const target = item.flow.find(node => node.id === targetId);
  if (!source || !target) return bad('DANGLING_EDGE', '连线端点不存在。');
  if (sourceId === targetId) return bad('SELF_LOOP', '节点不能连接自身。');
  if (target.type === 'prompt') return bad('INVALID_TARGET', '文本提示词根节点没有输入端口。');
  if (target.from === sourceId) return bad('DUPLICATE_EDGE', '这两个节点之间已有相同连线。');
  const output = PORT[source.type].output;
  const input = PORT[target.type].input;
  if (output !== input) {
    return bad(
      'PORT_TYPE_MISMATCH',
      `端口类型不兼容：${PORT_LABEL[output] || output} → ${PORT_LABEL[input] || input}（${source.id} → ${target.id}）。`,
    );
  }
  const previous = target.from;
  target.from = sourceId;
  const result = validateFlow(item);
  target.from = previous ?? null;
  return result;
}

export function connectNodes(item, sourceId, targetId) {
  const result = connectionError(item, sourceId, targetId);
  if (!result.ok) return result;
  item.flow.find(node => node.id === targetId).from = sourceId;
  return ok();
}

export function removeNode(item, nodeId) {
  if (item.frozen) return bad('WORKFLOW_FROZEN', '已执行的工作流节点锁定，删除不会保存。');
  const node = item.flow.find(entry => entry.id === nodeId);
  if (!node) return bad('NODE_NOT_FOUND', '节点不存在。');
  if (node.type === 'prompt') return bad('LOCKED_NODE', '文本提示词为锁定根节点，不可删除。');
  if (node.status !== 'idle') return bad('NODE_NOT_EDITABLE', '只有待执行节点可以删除。');
  if (node.type === 'generate' && item.flow.filter(entry => entry.type === 'generate').length <= 1) {
    return bad('LAST_GENERATE', '每个交付项至少保留一个生图节点。');
  }
  if (item.flow.some(entry => entry.from === nodeId)) {
    return bad('HAS_DOWNSTREAM', '该节点仍有下游节点，请先删除下游，删除不会保存。');
  }
  const index = item.flow.indexOf(node);
  item.flow.splice(index, 1);
  return ok();
}

export function addNodeAfter(item, tailId, type) {
  if (item.frozen) return bad('WORKFLOW_FROZEN', '已执行的工作流节点锁定，不能再追加节点。');
  if (!['edit', 'composite'].includes(type)) return bad('INVALID_NODE_TYPE', '只能追加改图或模板合成节点。');
  const tail = item.flow.find(node => node.id === tailId);
  if (!tail) return bad('NODE_NOT_FOUND', '找不到上游节点。');
  if (tail.type === 'composite' && type === 'edit') {
    return bad('COMPOSITE_TERMINAL', '模板合成后不再接改图节点；请在合成前追加改图。');
  }
  const node = {
    id: nextFlowNodeId(item), type, from: tail.id,
    model: type === 'edit' ? (item.model || '演示图像模型') : '',
    status: 'idle', count: 1,
    x: (tail.x ?? 0) + NODE_STEP_X, y: tail.y ?? 0,
  };
  item.flow.push(node);
  const result = validateFlow(item);
  if (!result.ok) {
    item.flow.pop();
    return result;
  }
  return { ok: true, node };
}

export function addGenerateBranch(item) {
  if (item.frozen) return bad('WORKFLOW_FROZEN', '已执行的工作流节点锁定，不能再加分支。');
  const generates = item.flow.filter(node => node.type === 'generate');
  if (generates.length >= 3) return bad('BRANCH_LIMIT', '每个交付项最多 3 个并行出图分支。');
  const prompt = item.flow.find(node => node.type === 'prompt');
  if (!prompt) return bad('INVALID_ROOT', '缺少文本提示词根节点。');
  const maxY = Math.max(0, ...generates.map(node => node.y ?? 0));
  const node = {
    id: nextFlowNodeId(item), type: 'generate', from: prompt.id,
    model: item.model || '演示图像模型', status: 'idle', count: 1,
    x: LANE_X, y: generates.length ? maxY + LANE_GAP : 24,
  };
  item.flow.push(node);
  const result = validateFlow(item);
  if (!result.ok) {
    item.flow.pop();
    return result;
  }
  return { ok: true, node };
}

// Deterministic default layout. Saved x/y values always win so dragging
// survives reload; new nodes get a lane-appropriate slot.
export function ensureLayout(item) {
  if (!item?.flow?.length) return item;
  const laneGroups = flowLanes(item);
  const laneCount = Math.max(1, laneGroups.length);
  const prompt = item.flow.find(node => node.type === 'prompt') || item.flow[0];
  const centerY = 24 + ((laneCount - 1) * LANE_GAP) / 2;
  if (prompt.x === undefined || prompt.x === null) prompt.x = PROMPT_X;
  if (prompt.y === undefined || prompt.y === null) prompt.y = centerY;
  const placed = new Set([prompt.id]);
  laneGroups.forEach((laneNodes, laneIndex) => {
    laneNodes.forEach((node, depth) => {
      if (node.x === undefined || node.x === null) node.x = LANE_X + depth * NODE_STEP_X;
      if (node.y === undefined || node.y === null) node.y = 24 + laneIndex * LANE_GAP;
      placed.add(node.id);
    });
  });
  let orphan = 0;
  for (const node of item.flow) {
    if (placed.has(node.id)) continue;
    if (node.x === undefined || node.x === null) node.x = LANE_X + orphan * NODE_STEP_X;
    if (node.y === undefined || node.y === null) node.y = centerY;
    orphan += 1;
  }
  return item;
}

export function flowSize(item) {
  const xs = item.flow.map(node => Number(node.x) || 0);
  const ys = item.flow.map(node => Number(node.y) || 0);
  return {
    width: Math.max(560, Math.max(...xs, 0) + 252),
    height: Math.max(230, Math.max(...ys, 0) + 196),
  };
}

export function isLockedFlowNode(node) {
  return node?.type === 'prompt';
}
