// UI graph operations. The server remains authoritative for canonical ports,
// locked edges, models and revision checks. No operation submits a paid task.
export function graphError(graph, { requireInputs = true } = {}) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) return '节点编号重复。';
  if (nodes.size > 50 || graph.edges.length > 100) return '工作流超过节点或连线上限。';
  const occupied = new Set();
  const children = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) return '连线端点不存在。';
    if (source.id === target.id) return '节点不能连接自身。';
    const output = source.ports?.find(port => port.id === edge.sourcePort && port.direction === 'out');
    const input = target.ports?.find(port => port.id === edge.targetPort && port.direction === 'in');
    if (!output || !input || output.type !== input.type) return '端口类型不兼容；请连接同类型的输出和输入。';
    const key = target.id + ':' + input.id;
    if (occupied.has(key)) return '一个输入端口只能有一条连线。';
    occupied.add(key);
    children.get(source.id).push(target.id);
  }
  const visited = new Set();
  const visiting = new Set();
  function cycle(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (children.get(id).some(cycle)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (graph.nodes.some(node => cycle(node.id))) return '工作流不能形成循环。';
  if (requireInputs) {
    for (const node of graph.nodes) {
      if (node.ports?.some(port => port.direction === 'in' && port.required && !occupied.has(node.id + ':' + port.id))) {
        return node.name + '的必需输入尚未连接。';
      }
    }
  }
  return '';
}

export function protectedEdge(instance, edge) {
  const locked = new Set(instance.lockedNodes || []);
  const target = instance.nodes.find(node => node.id === edge.target);
  if (locked.has(edge.target) && target?.type === 'output' && edge.targetPort === 'result' && !locked.has(edge.source)) return false;
  return locked.has(edge.source) || locked.has(edge.target);
}

export function connectWorkflow(instance, connection) {
  const next = structuredClone(instance);
  const old = next.edges.filter(edge => edge.target === connection.target && edge.targetPort === connection.targetPort);
  if (old.some(edge => protectedEdge(instance, edge))) throw new Error('系统资料连线已锁定。');
  next.edges = next.edges.filter(edge => !old.includes(edge));
  next.edges.push({ id: 'edge-' + crypto.randomUUID(), ...connection });
  const error = graphError(next, { requireInputs: false });
  if (error) throw new Error(error);
  return next;
}
