import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCreationApp } from './creation-app-fixture.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';

let app;
test.before(async () => { app = await startCreationApp({ autoTick: false }); });
test.after(async () => { await app?.stop(); });

const url = id => `/api/creation/projects/${id}`;
const ops = (id, list) => app.api(`${url(id)}/ops`, { ops: list });
const patch = (id, fields, unset) => ({ type: 'task.patch', id, fields, ...(unset ? { unset } : {}) });
const newProject = async name => { const data = await app.api('/api/creation/projects', { name, graphVersion: 4 }); return { project: data.project, tasks: Object.fromEntries(data.project.tasks.map(t => [t.kind, t])) }; };
const rawPost = (path, body, headers = {}) => fetch(app.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('two clients editing different nodes both succeed without any revision check', async () => {
  const { project, tasks } = await newProject('双窗口');
  // 两个窗口都以同一个旧版本为底，各改各的节点。
  const a = await ops(project.id, [patch(tasks.prompt.id, { prompt: '窗口 A 的提示词' })]);
  const b = await ops(project.id, [patch(tasks.generate.id, { title: '窗口 B 的标题' })]);
  const detail = await app.api(url(project.id));
  assert.equal(detail.project.tasks.find(t => t.id === tasks.prompt.id).prompt, '窗口 A 的提示词');
  assert.equal(detail.project.tasks.find(t => t.id === tasks.generate.id).title, '窗口 B 的标题');
  assert.ok(b.project.revision > a.project.revision, '用户编辑递增内容版本');
  assert.deepEqual(b.skipped, []);
});

test('the same field is last-write-wins and a field patch leaves other fields of the node alone', async () => {
  const { project, tasks } = await newProject('同字段');
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '先写', title: '标题保持', dimension: '维度' })]);
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '后写' })]);
  const node = (await app.api(url(project.id))).project.tasks.find(t => t.id === tasks.prompt.id);
  assert.equal(node.prompt, '后写');
  assert.equal(node.title, '标题保持');
  // unset 清除字段。
  await ops(project.id, [patch(tasks.prompt.id, {}, ['dimension'])]);
  const cleared = (await app.api(url(project.id))).project.tasks.find(t => t.id === tasks.prompt.id);
  assert.equal(cleared.dimension, undefined);
  assert.equal(cleared.title, '标题保持');
});

test('operations on nodes or edges already deleted elsewhere are skipped and reported, not fatal', async () => {
  const { project, tasks } = await newProject('跳过');
  const gone = randomUUID();
  const result = await ops(project.id, [
    patch(gone, { prompt: 'x' }),
    { type: 'task.remove', id: gone },
    { type: 'edge.remove', id: randomUUID() },
    { type: 'edge.add', edge: { id: randomUUID(), source: tasks.prompt.id, sourceHandle: 'text', target: gone, targetHandle: 'prompt' } },
    patch(tasks.prompt.id, { prompt: '照常生效' }),
  ]);
  assert.deepEqual(result.skipped.map(s => [s.index, s.type, s.reason]), [[0, 'task.patch', 'missing'], [1, 'task.remove', 'missing'], [2, 'edge.remove', 'missing'], [3, 'edge.add', 'missing-node']]);
  assert.equal(result.project.tasks.find(t => t.id === tasks.prompt.id).prompt, '照常生效');
  // 全部跳过的重复提交不写库，也不递增版本。
  const again = await ops(project.id, [patch(gone, { prompt: 'x' })]);
  assert.equal(again.project.revision, result.project.revision);
  assert.equal(again.skipped.length, 1);
});

test('replaying a batch is idempotent: adds are skipped as existing and nothing changes', async () => {
  const { project, tasks } = await newProject('幂等');
  const node = { id: randomUUID(), workflowId: tasks.generate.workflowId, kind: 'prompt', title: '新提示词', prompt: '', params: {}, position: { x: 10, y: 20 }, subject: 'concept', sourceAssetId: null, sourceRunId: null };
  const edge = { id: randomUUID(), source: node.id, sourceHandle: 'text', target: tasks.generate.id, targetHandle: 'prompt' };
  const first = await ops(project.id, [{ type: 'edge.remove', id: project.edges.find(e => e.targetHandle === 'prompt').id }, { type: 'task.add', task: node }, { type: 'edge.add', edge }]);
  assert.deepEqual(first.skipped, []);
  const replay = await ops(project.id, [{ type: 'task.add', task: node }, { type: 'edge.add', edge }]);
  assert.deepEqual(replay.skipped.map(s => s.reason), ['exists', 'exists']);
  assert.equal(replay.project.revision, first.project.revision);
  assert.equal(replay.project.tasks.filter(t => t.id === node.id).length, 1);
});

test('validation failures reject the whole batch with the existing error codes', async () => {
  const { project, tasks } = await newProject('整批拒绝');
  const before = await app.api(url(project.id));
  // 环：generate → prompt 的反向连线，同批里先改的提示词也不能落库。
  await assert.rejects(ops(project.id, [patch(tasks.prompt.id, { prompt: '不应保存' }), { type: 'edge.add', edge: { id: randomUUID(), source: tasks.generate.id, sourceHandle: 'image', target: tasks.image.id, targetHandle: 'image' } }]), error => ['EDGE_INCOMPATIBLE', 'GRAPH_CYCLE'].includes(error.code));
  await assert.rejects(ops(project.id, [patch(tasks.prompt.id, { title: '' })]), { code: 'TASK_INVALID' });
  await assert.rejects(ops(project.id, [{ type: 'workflow.put', workflow: { id: 'w', title: '' } }]), { code: 'WORKFLOW_INVALID' });
  await assert.rejects(ops(project.id, [{ type: 'project.patch', name: '' }]), { code: 'NAME_INVALID' });
  await assert.rejects(ops(project.id, [{ type: 'project.patch', voiceRoles: 'bad' }]), { code: 'VOICE_ROLES_INVALID' });
  await assert.rejects(ops(project.id, [{ type: 'nope' }]), { code: 'OPS_INVALID' });
  await assert.rejects(ops(project.id, []), { code: 'OPS_INVALID' });
  await assert.rejects(ops(project.id, Array.from({ length: 501 }, () => patch(tasks.prompt.id, { prompt: 'x' }))), { code: 'OPS_INVALID' });
  const after = await app.api(url(project.id));
  assert.deepEqual(after.project.tasks, before.project.tasks);
  assert.equal(after.project.revision, before.project.revision);
});

test('running nodes still reject input edits (TASK_RUNNING) but allow moving; nodes with history cannot be removed', async () => {
  const { project, tasks } = await newProject('运行保护');
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '森林背景' })]);
  const preview = await app.api(`${url(project.id)}/preview`, { taskIds: [tasks.generate.id] });
  assert.equal(preview.canStart, true);
  await app.api(`${url(project.id)}/start`, { ...preview.selection, previewToken: preview.previewToken, requestKey: randomUUID() });
  // 生成节点已排队：改执行输入被拒绝，整批回滚。
  await assert.rejects(ops(project.id, [patch(tasks.prompt.id, { prompt: '无关节点照常可改' }), patch(tasks.generate.id, { prompt: '改运行中节点' })]), { code: 'TASK_RUNNING' });
  assert.equal((await app.api(url(project.id))).project.tasks.find(t => t.id === tasks.prompt.id).prompt, '森林背景', '被拒绝的整批没有任何一条落库');
  const moved = await ops(project.id, [patch(tasks.generate.id, { position: { x: 900, y: -200 } })]);
  assert.deepEqual(moved.project.tasks.find(t => t.id === tasks.generate.id).position, { x: 900, y: -200 });
  await assert.rejects(ops(project.id, [{ type: 'task.remove', id: tasks.generate.id }]), { code: 'TASK_HAS_HISTORY' });
});

test('system and background writes do not bump revision; user edits do', async () => {
  const { project, tasks } = await newProject('系统写入');
  const edited = await ops(project.id, [patch(tasks.prompt.id, { prompt: '阳光下的杯子' })]);
  const revision = edited.project.revision;
  const preview = await app.api(`${url(project.id)}/preview`, { taskIds: [tasks.generate.id] });
  const started = await app.api(`${url(project.id)}/start`, { ...preview.selection, previewToken: preview.previewToken, requestKey: randomUUID() });
  assert.equal(started.project.revision, revision, '开始运行不递增内容版本');
  for (let i = 0; i < 4; i += 1) await app.projects.tick();
  const done = await app.api(url(project.id));
  assert.equal(done.runs.at(-1).status, 'succeeded');
  assert.equal(done.project.revision, revision, '运行结果写回不递增内容版本');
  // AI 脚本请求状态（含失败路径）、批量进度同样是系统写入。
  const svc = new CreationProjects(app.store, { hub: { complete: async () => ({ text: JSON.stringify({ script: '【开场】杯子' }), usage: { costMicros: 0, currency: 'CNY' } }) }, media: app.media });
  const workspace = (await app.db.pool.query('SELECT workspace_id FROM sj_creation_records WHERE id=$1', [project.id])).rows[0].workspace_id;
  const scripted = await svc.generateScript(workspace, project.id, { requestKey: randomUUID(), instructions: '15 秒' });
  assert.equal(scripted.project.storyboard.script, '【开场】杯子');
  assert.equal(scripted.project.revision, revision, '没有传修订号也能调用，且不递增内容版本');
  // 用户在画布上改名递增版本。
  const renamed = await ops(project.id, [{ type: 'project.patch', name: '改名' }]);
  assert.equal(renamed.project.revision, revision + 1);
});

test('preview-to-start compares frozen inputs of the selection, not the project revision', async () => {
  const { project, tasks } = await newProject('预览哈希');
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '原提示词' })]);
  const preview = await app.api(`${url(project.id)}/preview`, { taskIds: [tasks.generate.id] });
  // 无关节点的编辑使整项目版本变化，但不应使预览失效。
  const extra = { id: randomUUID(), workflowId: tasks.generate.workflowId, kind: 'prompt', title: '无关', prompt: '', params: {}, position: { x: 0, y: 0 }, subject: 'concept', sourceAssetId: null, sourceRunId: null };
  await ops(project.id, [{ type: 'task.add', task: extra }]);
  // 所选节点的上游提示词变了：令牌不再匹配，要求重新预览。
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '改过的提示词' })]);
  await assert.rejects(app.api(`${url(project.id)}/start`, { ...preview.selection, previewToken: preview.previewToken, requestKey: randomUUID() }), { code: 'PREVIEW_CHANGED' });
  const fresh = await app.api(`${url(project.id)}/preview`, { taskIds: [tasks.generate.id] });
  await ops(project.id, [{ type: 'task.remove', id: extra.id }]);
  const started = await app.api(`${url(project.id)}/start`, { ...fresh.selection, previewToken: fresh.previewToken, requestKey: randomUUID() });
  assert.equal(started.replayed, false, '无关节点的增删不影响预览令牌');
});

test('viewport is never persisted by ops, and the old project PATCH keeps working', async () => {
  const { project } = await newProject('视角');
  const result = await ops(project.id, [{ type: 'project.patch', name: '视角测试', viewport: { x: 500, y: 500, zoom: 3 } }]);
  assert.equal(result.project.name, '视角测试');
  assert.deepEqual(result.project.viewport, project.viewport);
  const legacy = await app.api(url(project.id), { revision: result.project.revision, name: '兼容路径' }, 'PATCH');
  assert.equal(legacy.project.name, '兼容路径');
  await assert.rejects(app.api(url(project.id), { revision: result.project.revision, name: '过期' }, 'PATCH'), { code: 'REVISION_CONFLICT' });
});

test('storyboard.patch creates shot nodes once, keeps them on replay, and syncs node titles', async () => {
  const { project } = await newProject('分镜操作');
  const shot = { id: randomUUID(), title: '开场', description: '杯子特写', nodeId: null };
  const first = await ops(project.id, [{ type: 'storyboard.patch', script: '脚本', shots: [shot] }]);
  const nodeId = first.project.storyboard.shots[0].nodeId;
  assert.ok(nodeId);
  assert.equal(first.project.storyboard.script, '脚本');
  assert.equal(first.project.tasks.find(t => t.id === nodeId).title, '开场');
  // 响应丢失后重发同一批（仍不带 nodeId）：沿用已建节点，不会重复建。
  const replay = await ops(project.id, [{ type: 'storyboard.patch', script: '脚本', shots: [shot] }]);
  assert.equal(replay.project.tasks.filter(t => t.kind === 'video').length, 1);
  assert.equal(replay.project.revision, first.project.revision);
  // 同一批里改节点标题：分镜表标题随之同步。
  const renamed = await ops(project.id, [patch(nodeId, { title: '新开场' })]);
  assert.equal(renamed.project.storyboard.shots[0].title, '新开场');
  const removed = await ops(project.id, [{ type: 'storyboard.patch', shots: [] }]);
  assert.equal(removed.project.tasks.some(t => t.id === nodeId), false);
});

test('status returns only revision, light runs, dub states and batch / compile state', async () => {
  const { project, tasks } = await newProject('轻量状态');
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '状态' })]);
  const preview = await app.api(`${url(project.id)}/preview`, { taskIds: [tasks.generate.id] });
  await app.api(`${url(project.id)}/start`, { ...preview.selection, previewToken: preview.previewToken, requestKey: randomUUID() });
  const full = await app.api(url(project.id));
  const status = await app.api(`${url(project.id)}/status`);
  assert.deepEqual(Object.keys(status).sort(), ['dubStates', 'revision', 'runs', 'storyboard']);
  assert.equal(status.revision, full.project.revision);
  assert.deepEqual(Object.keys(status.storyboard).sort(), ['batch', 'compile']);
  assert.equal(status.storyboard.compile.status, 'idle');
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].id, full.runs[0].id);
  assert.equal(status.runs[0].status, full.runs[0].status);
  assert.equal(status.runs[0].taskId, tasks.generate.id);
  assert.deepEqual(status.runs[0].input, { kind: 'image' }, '冻结输入不随轻量状态下发');
  assert.equal(status.project, undefined);
  await assert.rejects(app.api(`/api/creation/projects/${randomUUID()}/status`), { code: 'NOT_FOUND' });
});

test('ops accept bodies over 100 KB (up to 8 MB), require CSRF, and stay JSON-only', async () => {
  const { project, tasks } = await newProject('大请求');
  const big = await ops(project.id, [patch(tasks.prompt.id, { prompt: '长'.repeat(19000) }), patch(tasks.generate.id, { prompt: '长'.repeat(19000) }), patch(tasks.output.id, { prompt: '长'.repeat(19000) }), patch(tasks.image.id, { prompt: '长'.repeat(19000) })]);
  assert.equal(big.project.tasks.find(t => t.id === tasks.prompt.id).prompt.length, 19000);
  assert.ok(Buffer.byteLength(JSON.stringify({ ops: [patch(tasks.prompt.id, { prompt: '长'.repeat(19000) })] })) > 50_000);
  const missing = await rawPost(`${url(project.id)}/ops`, { ops: [patch(tasks.prompt.id, { prompt: 'x' })] });
  assert.equal(missing.status, 403);
  const oversized = await rawPost(`${url(project.id)}/ops`, { ops: [patch(tasks.prompt.id, { prompt: 'x'.repeat(9 * 1024 * 1024) })] }, { 'X-CSRF-Token': app.csrf });
  assert.equal(oversized.status, 413);
});

test('legacy action endpoints no longer require a project revision', async () => {
  const { project, tasks } = await newProject('无修订号动作');
  await ops(project.id, [patch(tasks.prompt.id, { prompt: '动作' })]);
  const preview = await app.api(`${url(project.id)}/preview`, { taskIds: [tasks.generate.id] });
  const started = await app.api(`${url(project.id)}/start`, { ...preview.selection, previewToken: preview.previewToken, requestKey: randomUUID() });
  assert.equal(started.runs.length, 1);
  const synced = await app.api(`${url(project.id)}/sync-product`, {}).catch(error => error);
  assert.notEqual(synced.code, 'REVISION_REQUIRED');
  const compile = await app.api(`${url(project.id)}/storyboard/compile`, { requestKey: randomUUID() }).catch(error => error);
  assert.equal(compile.code, 'COMPILE_EMPTY');
  const batch = await app.api(`${url(project.id)}/storyboard/batch/start`, { requestKey: randomUUID(), shotIds: [randomUUID()], previewToken: 'x' }).catch(error => error);
  assert.equal(batch.code, 'BATCH_SELECTION_INVALID');
});
