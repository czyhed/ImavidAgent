// Creative tasks contain graph nodes; execution records continue to reference node IDs.
export function withWorkflows(project) {
 const workflows = (project.workflows || []).map(w => ({ ...w }));
 if (!workflows.length) workflows.push({ id: 'initial', title: (project.tasks?.find(t => ['generate', 'edit', 'video'].includes(t.kind))?.title || '创作任务').slice(0, 100) });
 const tasks = (project.tasks || []).map(task => {
  if (workflows.some(w => w.id === task.workflowId)) return task;
  if (task.dimension === '视频分镜') {
   if (!workflows.some(w => w.id === 'storyboard')) workflows.push({ id: 'storyboard', title: '视频分镜' });
   return { ...task, workflowId: 'storyboard' };
  }
  return { ...task, workflowId: workflows[0].id };
 });
 return { ...project, workflows, tasks };
}

export function workflowScope(project, workflowId) {
 const owned = new Set(project.tasks.filter(t => t.workflowId === workflowId).map(t => t.id));
 const visible = new Set(owned);
 // Existing cross-task dependencies remain visible, but only owned nodes execute.
 let changed = true;
 while (changed) {
  changed = false;
  for (const edge of project.edges) if (visible.has(edge.target) && !visible.has(edge.source)) { visible.add(edge.source); changed = true; }
 }
 return { owned, visible };
}

export function createWorkflow(project, { title = '新建创作任务', kind = 'generate', prompt = '', sourceAssetId = null, params, id, nodeId, subject, model, dimension, templateSnapshot }, makeId) {
 const workflow = { id: id || makeId(), title: title.slice(0, 100) };
 const base = { workflowId: workflow.id, subject: subject || (project.productId ? 'product' : 'concept'), productSnapshot: project.productSnapshot, sourceRunId: null, sourceAssetId: null, params: {}, prompt: '' };
 const reference = { ...base, id: makeId(), kind: 'image', title: '参考图', position: { x: 40, y: 40 }, sourceAssetId };
 const text = { ...base, id: makeId(), kind: 'prompt', title: '提示词', prompt, position: { x: 40, y: 500 } };
 const generation = { ...base, id: nodeId || makeId(), kind, title, params: params || (kind === 'video' ? { duration: 6 } : { size: '1024x1024' }), model, dimension, templateSnapshot, position: { x: 440, y: 40 } };
 const output = { ...base, id: makeId(), kind: 'output', title: '输出', position: { x: 840, y: 40 } };
 const edge = (source, sourceHandle, target, targetHandle) => ({ id: makeId(), source, sourceHandle, target, targetHandle });
 const edges = [edge(text.id, 'text', generation.id, kind === 'composite' ? 'template' : 'prompt'), edge(generation.id, kind === 'video' ? 'video' : 'image', output.id, kind === 'video' ? 'video' : 'asset')];
 if (sourceAssetId) edges.push(edge(reference.id, 'image', generation.id, kind === 'video' ? 'first' : kind === 'edit' ? 'image' : kind === 'composite' ? 'images' : 'ref'));
 return { workflow, tasks: [reference, text, generation, output], edges };
}
