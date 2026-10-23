import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { startCreationApp } from './creation-app-fixture.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';
import { createMediaPrep } from '../server/media-prep.mjs';

// 生视频第 3 步：单一配置迁移、上一镜尾帧、批量生成。
// 全部使用本地夹具（真实 ModelHub + 假 H3 供应商 + 假截帧 runner），不调用任何付费接口、不需要 ffmpeg。
let app, svc, extractCalls;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test.before(async () => {
 app = await startCreationApp({ autoTick: false });
 extractCalls = [];
 const frameExtractor = { extract: async input => { extractCalls.push(input.bytes.length); return { bytes: app.png, mime: 'image/png' }; } };
 svc = new CreationProjects(app.store, { hub: app.hub, media: app.media, frameExtractor, mediaPrep: createMediaPrep({ runner: async input => ({ bytes: input.bytes, mime: input.mime }) }) });
});
test.after(async () => { await app?.stop(); });

const submissions = () => app.calls.filter(c => c.method === 'POST' && c.path.endsWith('/minimax/v2/video_generation'));
const runsOf = async (w, projectId) => (await svc.detail(w, projectId)).runs;
const activeCount = runs => runs.filter(r => ['queued', 'submitting', 'running', 'unknown', 'cancelling'].includes(r.status)).length;
const batchOf = async (w, projectId) => (await svc.detail(w, projectId)).project.storyboard.batch;
const hashOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// 创建项目并保存若干分镜；spec: {title, prompt?, mode?, tail?, resolution?}。返回 {project, shots, nodeIds}。
async function shotsProject(w, specs) {
 const { project } = await svc.create(w, {});
 let detail = await svc.saveStoryboard(w, project.id, { revision: project.revision, script: '', shots: specs.map(spec => ({ id: randomUUID(), title: spec.title, description: '', prompt: spec.prompt ?? `${spec.title}的画面`, duration: 4 })) });
 const shots = detail.project.storyboard.shots;
 const tasks = detail.project.tasks.map(task => {
  const index = shots.findIndex(shot => shot.nodeId === task.id);
  if (index < 0) return task;
  const spec = specs[index];
  return { ...task, params: { duration: 4, resolution: spec.resolution || '480P', ratio: '9:16' }, ...(spec.mode ? { videoMode: spec.mode } : {}), ...(spec.tail ? { tailFrame: { fromNodeId: shots[index - 1].nodeId, runId: null, assetId: null } } : {}), ...(spec.prompt === '' ? { prompt: '' } : {}) };
 });
 detail = await svc.update(w, project.id, { revision: detail.project.revision, tasks, edges: detail.project.edges });
 return { project: detail.project, shots, nodeIds: shots.map(shot => shot.nodeId) };
}
async function startBatch(w, projectId, shotIds, requestKey = randomUUID()) {
 const preview = await svc.batchPreview(w, projectId, { shotIds });
 assert.equal(preview.canStart, true, JSON.stringify(preview.entries));
 await svc.batchStart(w, projectId, { shotIds, previewToken: preview.previewToken, revision: preview.revision, requestKey });
 return { preview, requestKey };
}
async function drain(w, projectId, until, limit = 40) {
 for (let index = 0; index < limit; index += 1) {
  if (until(await batchOf(w, projectId))) return;
  await svc.tick();
 }
 assert.fail('批次没有在预期次数内到达目标状态：' + JSON.stringify(await batchOf(w, projectId)));
}

test('旧分镜数据迁移：丢弃分镜上的配置副本，幂等，且不改动已有节点', async () => {
 const w = 'vb-migrate';
 const { project } = await svc.create(w, {});
 const nodeId = randomUUID(), shotId = randomUUID();
 const legacyNode = { id: nodeId, kind: 'video', title: '旧镜', prompt: '旧节点提示词', params: { duration: 8, resolution: '1080P', ratio: '16:9' }, subject: 'concept', position: { x: 10, y: 20 }, sourceAssetId: null, sourceRunId: null, dimension: '视频分镜' };
 const legacyShot = { id: shotId, title: '旧镜', description: '描述', prompt: '分镜上的旧提示词', duration: 9, mode: 'firstFrame', sourceAssetId: randomUUID(), sourceRunId: randomUUID(), nodeId };
 await app.store.change(w, project.id, null, current => ({ ...current, tasks: [...current.tasks, legacyNode], storyboard: { script: '脚本', shots: [legacyShot] } }));
 const before = (await app.store.get(w, project.id)).tasks.find(t => t.id === nodeId);
 const once = svc.normalizeStoryboard(await app.store.get(w, project.id));
 assert.deepEqual(Object.keys(once.shots[0]).sort(), ['description', 'id', 'nodeId', 'title']);
 assert.deepEqual(once.shots[0], { id: shotId, title: '旧镜', description: '描述', nodeId });
 assert.deepEqual(svc.normalizeStoryboard({ storyboard: once }), once, '重复归一化结果不变');
 // 重新保存分镜：节点原样保留，不补写 videoMode，也不回写提示词与时长。
 const detail = await svc.saveStoryboard(w, project.id, { revision: (await app.store.get(w, project.id)).revision });
 const after = detail.project.tasks.find(t => t.id === nodeId);
 assert.equal(hashOf(after), hashOf(before));
 assert.equal(after.videoMode, undefined);
 assert.deepEqual(detail.project.storyboard.shots[0], { id: shotId, title: '旧镜', description: '描述', nodeId });
 const again = await svc.saveStoryboard(w, project.id, { revision: detail.project.revision });
 assert.equal(again.project.revision, detail.project.revision + 1);
 assert.equal(hashOf(again.project.tasks.find(t => t.id === nodeId)), hashOf(before));
});

test('分镜表与画布节点双向一致：标题随节点、顺序与描述只在分镜、配置只在节点', async () => {
 const w = 'vb-sync';
 const { project, shots, nodeIds } = await shotsProject(w, [{ title: '甲' }, { title: '乙' }]);
 // 节点重命名 → 分镜标题跟随（节点是标题唯一来源）。
 let detail = await svc.update(w, project.id, { revision: project.revision, tasks: project.tasks.map(t => t.id === nodeIds[0] ? { ...t, title: '甲（画布改名）' } : t), edges: project.edges });
 assert.equal(detail.project.storyboard.shots[0].title, '甲（画布改名）');
 // 分镜改描述并调换顺序：节点配置与标题不变。
 const reordered = [{ ...detail.project.storyboard.shots[1], description: '乙的描述' }, detail.project.storyboard.shots[0]];
 detail = await svc.saveStoryboard(w, project.id, { revision: detail.project.revision, shots: reordered });
 assert.deepEqual(detail.project.storyboard.shots.map(s => s.title), ['乙', '甲（画布改名）']);
 assert.equal(detail.project.storyboard.shots[0].description, '乙的描述');
 assert.equal(detail.project.tasks.find(t => t.id === nodeIds[1]).prompt, '乙的画面');
 // 分镜表改标题 → 节点标题同步。
 detail = await svc.saveStoryboard(w, project.id, { revision: detail.project.revision, shots: detail.project.storyboard.shots.map(s => s.id === shots[1].id ? { ...s, title: '乙（分镜表改名）' } : s) });
 assert.equal(detail.project.tasks.find(t => t.id === nodeIds[1]).title, '乙（分镜表改名）');
 // 节点上的提示词 / 时长是唯一配置，分镜不再带副本。
 detail = await svc.update(w, project.id, { revision: detail.project.revision, tasks: detail.project.tasks.map(t => t.id === nodeIds[1] ? { ...t, prompt: '节点新提示词', params: { ...t.params, duration: 7 } } : t), edges: detail.project.edges });
 for (const shot of detail.project.storyboard.shots) assert.deepEqual(Object.keys(shot).sort(), ['description', 'id', 'nodeId', 'title']);
 assert.equal(detail.project.tasks.find(t => t.id === nodeIds[1]).params.duration, 7);
});

test('上一镜尾帧：截取写入素材与节点，首帧优先级为连线 > 尾帧 > 节点自带素材，上一镜重新生成后过期并可换用新尾帧', async () => {
 const w = 'vb-tail';
 const { project, shots, nodeIds } = await shotsProject(w, [{ title: '一镜' }, { title: '二镜', mode: 'frames', tail: true }]);
 // 第一个分镜没有上一镜；上一镜尚无成功运行时等待。
 await assert.rejects(svc.tailFrame(w, project.id, { shotId: shots[0].id, revision: project.revision }), { code: 'NO_PREVIOUS_SHOT' });
 await assert.rejects(svc.tailFrame(w, project.id, { shotId: shots[1].id, revision: project.revision }), error => error.code === 'PREVIOUS_SHOT_PENDING' && error.message === '等待上一镜生成成功');
 let preview = await svc.preview(w, project.id, { taskIds: [nodeIds[1]] });
 assert.equal(preview.scope.at(-1).action, 'wait-input');
 assert.equal(preview.scope.at(-1).reason, '等待上一镜生成成功');
 // 生成上一镜。
 preview = await svc.preview(w, project.id, { taskIds: [nodeIds[0]] });
 await svc.start(w, project.id, { ...preview.selection, revision: preview.revision, previewToken: preview.previewToken, requestKey: randomUUID() });
 await svc.tick(); await svc.tick();
 const run1 = (await runsOf(w, project.id)).find(r => r.taskId === nodeIds[0] && r.status === 'succeeded');
 assert.ok(run1);
 // 上一镜已成功但尚未截帧：提示先截取。
 preview = await svc.preview(w, project.id, { taskIds: [nodeIds[1]] });
 assert.match(preview.scope.at(-1).reason, /请先截取上一镜尾帧/);
 const current = await svc.detail(w, project.id);
 const calls = extractCalls.length;
 const captured = await svc.tailFrame(w, project.id, { shotId: shots[1].id, revision: current.project.revision });
 assert.equal(extractCalls.length, calls + 1);
 const node = captured.project.tasks.find(t => t.id === nodeIds[1]);
 assert.deepEqual({ ...node.tailFrame, assetId: Boolean(node.tailFrame.assetId) }, { fromNodeId: nodeIds[0], runId: run1.id, assetId: true });
 const asset = await app.store.get(w, node.tailFrame.assetId);
 assert.equal(asset.role, 'result');
 assert.equal(asset.mime, 'image/png');
 assert.deepEqual(asset.derivedFrom, { runId: run1.id, kind: 'tail-frame' });
 assert.equal(captured.project.storyboard.shots[1].tailFrameStale, undefined);
 // 重复截取同一次运行：不再调用截帧。
 await svc.tailFrame(w, project.id, { shotId: shots[1].id, revision: captured.project.revision });
 assert.equal(extractCalls.length, calls + 1);
 // 尾帧作为首帧提交（frames 方式）。
 preview = await svc.preview(w, project.id, { taskIds: [nodeIds[1]] });
 let entry = preview.scope.at(-1);
 assert.equal(entry.action, 'generate', entry.reason);
 assert.deepEqual(entry.resolved.media.map(m => [m.role, m.assetId]), [['first_frame', node.tailFrame.assetId]]);
 // 优先级：显式首帧连线高于尾帧。
 const linked = await app.media.put(w, { bytes: app.png, name: '连线首帧.png', role: 'creative' });
 const withEdge = await svc.update(w, project.id, { revision: captured.project.revision, tasks: [...captured.project.tasks, { id: 'img', kind: 'image', title: '首帧图', prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 }, sourceAssetId: linked.id, sourceRunId: null }], edges: [{ id: 'e1', source: 'img', target: nodeIds[1], sourceHandle: 'image', targetHandle: 'first' }] });
 assert.equal(withEdge.project.tasks.find(t => t.id === nodeIds[1]).tailFrame.assetId, node.tailFrame.assetId);
 entry = (await svc.preview(w, project.id, { taskIds: [nodeIds[1]] })).scope.at(-1);
 assert.deepEqual(entry.resolved.media.map(m => m.assetId), [linked.id], '连线首帧优先');
 // 优先级：尾帧高于节点自带 sourceAssetId。
 const own = await app.media.put(w, { bytes: app.png, name: '节点首帧.png', role: 'creative' });
 const cleaned = await svc.update(w, project.id, { revision: withEdge.project.revision, tasks: withEdge.project.tasks.filter(t => t.id !== 'img').map(t => t.id === nodeIds[1] ? { ...t, sourceAssetId: own.id } : t), edges: [] });
 entry = (await svc.preview(w, project.id, { taskIds: [nodeIds[1]] })).scope.at(-1);
 assert.deepEqual(entry.resolved.media.map(m => m.assetId), [node.tailFrame.assetId], '尾帧高于节点自带素材');
 // 上一镜重新生成成功后，尾帧过期，界面提示但不自动替换。
 preview = await svc.preview(w, project.id, { taskIds: [nodeIds[0]], regenerateTaskIds: [nodeIds[0]] });
 await svc.start(w, project.id, { ...preview.selection, revision: preview.revision, previewToken: preview.previewToken, requestKey: randomUUID() });
 await svc.tick(); await svc.tick();
 const stale = await svc.detail(w, project.id);
 const run2 = stale.runs.filter(r => r.taskId === nodeIds[0] && r.status === 'succeeded').at(-1);
 assert.notEqual(run2.id, run1.id);
 assert.equal(stale.project.storyboard.shots[1].tailFrameStale, true);
 assert.equal(stale.project.tasks.find(t => t.id === nodeIds[1]).tailFrame.runId, run1.id, '不自动替换');
 // 换用新尾帧。
 const renewed = await svc.tailFrame(w, project.id, { shotId: shots[1].id, revision: stale.project.revision });
 assert.equal(extractCalls.length, calls + 2);
 assert.equal(renewed.project.tasks.find(t => t.id === nodeIds[1]).tailFrame.runId, run2.id);
 assert.equal(renewed.project.storyboard.shots[1].tailFrameStale, undefined);
 assert.equal(cleaned.project.tasks.find(t => t.id === nodeIds[1]).sourceAssetId, own.id);
});

test('批次：活跃视频运行最多 3 个，requestKey 幂等，运行请求编号由批次编号 + 分镜 + 尝试次数派生', async () => {
 const w = 'vb-concurrency';
 const { project, shots } = await shotsProject(w, ['a', 'b', 'c', 'd', 'e'].map(title => ({ title })));
 const shotIds = shots.map(s => s.id);
 const preview = await svc.batchPreview(w, project.id, { shotIds });
 assert.equal(preview.entries.length, 5);
 assert.ok(preview.entries.every(e => e.action === 'generate' && e.estimatedPoints === 20));
 assert.equal(preview.estimatedPoints, 100);
 const key = randomUUID();
 const body = { shotIds, previewToken: preview.previewToken, revision: preview.revision, requestKey: key };
 const first = await svc.batchStart(w, project.id, body);
 assert.equal(first.project.storyboard.batch.state, 'running');
 assert.equal(Object.keys(first.project.storyboard.batch.items).length, 5);
 // 同一 requestKey 幂等：返回同一个批次；范围不同则冲突。
 const replay = await svc.batchStart(w, project.id, body);
 assert.equal(replay.project.storyboard.batch.id, first.project.storyboard.batch.id);
 assert.equal(replay.project.revision, first.project.revision);
 await assert.rejects(svc.batchStart(w, project.id, { ...body, shotIds: shotIds.slice(0, 2) }), { code: 'REQUEST_KEY_CONFLICT' });
 await assert.rejects(svc.batchStart(w, project.id, { ...body, requestKey: randomUUID() }), { code: 'BATCH_ACTIVE' });
 // 供应商保持“生成中”：并发上限 3。
 app.state.taskStatus = 'running';
 try {
  let peak = 0;
  for (let index = 0; index < 6; index += 1) {
   await svc.tick();
   const runs = await runsOf(w, project.id);
   peak = Math.max(peak, activeCount(runs));
   assert.ok(activeCount(runs) <= 3);
  }
  const midway = await runsOf(w, project.id);
  assert.equal(midway.length, 3);
  assert.equal(peak, 3);
  assert.equal((await batchOf(w, project.id)).state, 'running');
 } finally { app.state.taskStatus = 'succeeded'; }
 await drain(w, project.id, batch => batch.state === 'done');
 const batch = await batchOf(w, project.id);
 assert.ok(Object.values(batch.items).every(item => item.status === 'succeeded'));
 const runs = await runsOf(w, project.id);
 assert.equal(runs.length, 5);
 for (const shot of shots) {
  const expected = svc.derivedRequestKey(key, shot.id, 1), run = runs.find(r => r.id === batch.items[shot.id].runId);
  assert.equal(run.requestKey, expected);
  assert.equal(run.input.start.batchId, batch.id);
 }
});

test('依赖上一镜尾帧的分镜等待上一镜成功后先截帧再派发，批量预览显示「等待上一镜」', async () => {
 const w = 'vb-dependent';
 const { project, shots } = await shotsProject(w, [{ title: '甲' }, { title: '乙', mode: 'frames', tail: true }]);
 const shotIds = shots.map(s => s.id);
 const preview = await svc.batchPreview(w, project.id, { shotIds });
 assert.deepEqual(preview.entries.map(e => [e.action, e.dependsOn]), [['generate', null], ['wait-prev', shots[0].id]]);
 assert.match(preview.entries[1].reason, /等待上一镜/);
 assert.equal(preview.entries[1].estimatedPoints, 20);
 assert.equal(preview.estimatedPoints, 40);
 await startBatch(w, project.id, shotIds);
 const calls = extractCalls.length, before = submissions().length;
 app.state.taskStatus = 'running';
 try {
  await svc.tick(); await svc.tick();
  const waiting = await batchOf(w, project.id);
  assert.equal(waiting.items[shots[0].id].status, 'running');
  assert.equal(waiting.items[shots[1].id].status, 'pending');
  assert.equal(extractCalls.length, calls, '上一镜未成功前不截帧');
  assert.equal(submissions().length, before + 1);
 } finally { app.state.taskStatus = 'succeeded'; }
 await drain(w, project.id, batch => batch.state === 'done');
 assert.equal(extractCalls.length, calls + 1, '上一镜成功后先截帧');
 const batch = await batchOf(w, project.id);
 assert.equal(batch.items[shots[1].id].status, 'succeeded');
 const body = submissions().at(-1).body;
 assert.deepEqual(body.content.map(e => e.role), [undefined, 'first_frame']);
 const detail = await svc.detail(w, project.id);
 assert.equal(detail.project.tasks.find(t => t.id === shots[1].nodeId).tailFrame.runId, batch.items[shots[0].id].runId);
});

test('失败时依赖它的分镜 held 其余继续；显式重试恢复被 held 的分镜且不自动重试', async () => {
 const w = 'vb-failure';
 const { project, shots } = await shotsProject(w, [{ title: '甲' }, { title: '乙', mode: 'frames', tail: true }, { title: '丙' }]);
 const shotIds = shots.map(s => s.id);
 const { requestKey } = await startBatch(w, project.id, shotIds);
 app.state.taskStatus = 'running';
 try {
  await svc.tick(); await svc.tick();
 } finally { app.state.taskStatus = 'succeeded'; }
 // 甲被供应商确认失败；丙正常成功。
 const failedRun = (await batchOf(w, project.id)).items[shots[0].id].runId;
 await app.db.pool.query("UPDATE sj_creation_runs SET status='failed',error=$2 WHERE id=$1", [failedRun, { code: 'PROVIDER_GENERATION_FAILED', message: '供应商视频任务失败，请核对后手动重试。' }]);
 await drain(w, project.id, batch => batch.state === 'done');
 let batch = await batchOf(w, project.id);
 assert.equal(batch.items[shots[0].id].status, 'failed');
 assert.equal(batch.items[shots[0].id].reason, '供应商视频任务失败，请核对后手动重试。');
 assert.equal(batch.items[shots[1].id].status, 'held');
 assert.match(batch.items[shots[1].id].reason, /上一镜「甲」未成功/);
 assert.equal(batch.items[shots[2].id].status, 'succeeded');
 const settled = submissions().length;
 for (let index = 0; index < 4; index += 1) await svc.tick();
 assert.equal(submissions().length, settled, '不自动重试');
 // 只有失败的分镜可以重试；被 held 的分镜通过重试其上一镜恢复。
 await assert.rejects(svc.batchRetry(w, project.id, { shotId: shots[2].id, requestKey: randomUUID() }), { code: 'BATCH_ITEM_NOT_FAILED' });
 await assert.rejects(svc.batchRetry(w, project.id, { shotId: shots[1].id, requestKey: randomUUID() }), { code: 'BATCH_ITEM_NOT_FAILED' });
 const retryKey = randomUUID();
 const retried = await svc.batchRetry(w, project.id, { shotId: shots[0].id, requestKey: retryKey });
 batch = retried.project.storyboard.batch;
 assert.equal(batch.state, 'running');
 assert.deepEqual([batch.items[shots[0].id], batch.items[shots[1].id]].map(i => [i.status, i.attempt]), [['pending', 2], ['pending', 2]]);
 assert.equal(batch.items[shots[2].id].attempt, 1);
 const replay = await svc.batchRetry(w, project.id, { shotId: shots[0].id, requestKey: retryKey });
 assert.equal(replay.project.storyboard.batch.items[shots[0].id].attempt, 2, '同一重试请求幂等');
 await drain(w, project.id, b => b.state === 'done');
 batch = await batchOf(w, project.id);
 assert.ok(Object.values(batch.items).every(item => item.status === 'succeeded'));
 const runs = await runsOf(w, project.id);
 assert.equal(runs.find(r => r.id === batch.items[shots[0].id].runId).requestKey, svc.derivedRequestKey(requestKey, shots[0].id, 2));
 assert.equal(runs.filter(r => r.taskId === shots[0].nodeId).length, 2);
});

test('余额已知且不足时批次暂停并写中文原因，补足后继续；余额未知不阻止', async () => {
 const w = 'vb-balance';
 const { project, shots } = await shotsProject(w, [{ title: '甲' }, { title: '乙' }, { title: '丙' }]);
 const shotIds = shots.map(s => s.id);
 // 开始前不足：预览与开始都拒绝。
 app.state.balance = { total_points: 30, reserved_points: 0, available_points: 30 };
 try {
  const short = await svc.batchPreview(w, project.id, { shotIds });
  assert.equal(short.canStart, false);
  assert.equal(short.balanceShortfall, 30);
  assert.match(short.balanceReason, /积分不足.*60.*30.*30/);
  await assert.rejects(svc.batchStart(w, project.id, { shotIds, previewToken: short.previewToken, revision: short.revision, requestKey: randomUUID() }), { code: 'INSUFFICIENT_POINTS' });
  // 开始时足够，派发时被其他任务占用：第 1 个派发后余额只剩 25，不够再扣 20（已入队未提交的运行先占用）。
  app.state.balance = { total_points: 500, reserved_points: 0, available_points: 500 };
  const { preview } = await startBatch(w, project.id, shotIds);
  assert.equal(preview.balance.available, 500);
  app.state.balance = { total_points: 25, reserved_points: 0, available_points: 25 };
  const before = submissions().length;
  await svc.tick();
  const paused = await batchOf(w, project.id);
  assert.equal(paused.state, 'paused');
  assert.match(paused.reason, /积分不足.*「乙」.*20.*5.*暂停/);
  assert.equal((await runsOf(w, project.id)).length, 1);
  assert.equal(submissions().length, before + 1, '已派发的一个照常提交');
  for (let index = 0; index < 3; index += 1) await svc.tick();
  assert.equal((await runsOf(w, project.id)).length, 1, '暂停后不再派发');
  // 补足积分后继续。
  app.state.balance = { total_points: 500, reserved_points: 0, available_points: 500 };
  const resumed = await svc.batchResume(w, project.id);
  assert.equal(resumed.project.storyboard.batch.state, 'running');
  assert.equal((await svc.batchResume(w, project.id)).project.storyboard.batch.state, 'running', '重复继续是幂等的');
  await drain(w, project.id, batch => batch.state === 'done');
  assert.ok(Object.values((await batchOf(w, project.id)).items).every(item => item.status === 'succeeded'));
  await assert.rejects(svc.batchResume(w, project.id), { code: 'BATCH_NOT_PAUSED' });
 } finally { app.state.balance = null; }
 // 余额未知（接口 404）：预览与派发都放行。
 const unknown = await shotsProject('vb-balance-unknown', [{ title: '甲' }]);
 const plan = await svc.batchPreview('vb-balance-unknown', unknown.project.id, { shotIds: [unknown.shots[0].id] });
 assert.equal(plan.balance, null);
 assert.equal(plan.canStart, true);
 await startBatch('vb-balance-unknown', unknown.project.id, [unknown.shots[0].id]);
 await drain('vb-balance-unknown', unknown.project.id, batch => batch.state === 'done');
});

test('派发前校验不通过：该分镜 failed 并记录原因，不发送请求，其余分镜继续', async () => {
 const w = 'vb-validation';
 const { project, shots, nodeIds } = await shotsProject(w, [{ title: '甲' }, { title: '乙' }]);
 const shotIds = shots.map(s => s.id);
 await startBatch(w, project.id, shotIds);
 // 开始之后、派发之前，乙的提示词被清空。
 const detail = await svc.detail(w, project.id);
 await svc.update(w, project.id, { revision: detail.project.revision, tasks: detail.project.tasks.map(t => t.id === nodeIds[1] ? { ...t, prompt: '' } : t), edges: detail.project.edges });
 const before = submissions().length;
 await drain(w, project.id, batch => batch.state === 'done');
 const batch = await batchOf(w, project.id);
 assert.equal(batch.items[shots[1].id].status, 'failed');
 assert.match(batch.items[shots[1].id].reason, /请填写提示词/);
 assert.equal(batch.items[shots[1].id].runId, null);
 assert.equal(batch.items[shots[0].id].status, 'succeeded');
 const runs = await runsOf(w, project.id);
 assert.equal(runs.length, 1, '校验失败的分镜没有创建运行');
 assert.equal(submissions().length, before + 1, '只发送了合法分镜的请求');
});

test('停止批次：不再派发新的分镜，已在运行的不受影响', async () => {
 const w = 'vb-cancel';
 const { project, shots } = await shotsProject(w, ['a', 'b', 'c', 'd'].map(title => ({ title })));
 const shotIds = shots.map(s => s.id);
 await startBatch(w, project.id, shotIds);
 app.state.taskStatus = 'running';
 try {
  await svc.tick();
  assert.equal((await runsOf(w, project.id)).length, 3);
  const stopped = await svc.batchCancel(w, project.id);
  assert.equal(stopped.project.storyboard.batch.state, 'cancelled');
  assert.match(stopped.project.storyboard.batch.reason, /已经提交的分镜会继续完成/);
 } finally { app.state.taskStatus = 'succeeded'; }
 for (let index = 0; index < 4; index += 1) await svc.tick();
 const runs = await runsOf(w, project.id);
 assert.equal(runs.length, 3, '没有再派发第 4 个');
 assert.ok(runs.every(run => run.status === 'succeeded'), '已提交的照常完成');
 const batch = await batchOf(w, project.id);
 assert.equal(batch.state, 'cancelled');
 assert.equal(Object.values(batch.items).filter(item => item.status === 'succeeded').length, 3, '运行结果仍同步到分镜');
 assert.equal(batch.items[shots[3].id].status, 'pending');
 await assert.rejects(svc.batchRetry(w, project.id, { shotId: shots[3].id, requestKey: randomUUID() }), { code: 'BATCH_CANCELLED' });
});

test('批量范围校验：未同步的分镜不能入批，已被阻塞的分镜阻止开始', async () => {
 const w = 'vb-scope';
 const { project, shots } = await shotsProject(w, [{ title: '甲', prompt: '' }, { title: '乙' }]);
 await assert.rejects(svc.batchPreview(w, project.id, { shotIds: [] }), { code: 'BATCH_SELECTION_INVALID' });
 await assert.rejects(svc.batchPreview(w, project.id, { shotIds: [randomUUID()] }), { code: 'BATCH_SELECTION_INVALID' });
 const plan = await svc.batchPreview(w, project.id, { shotIds: shots.map(s => s.id) });
 assert.equal(plan.entries[0].action, 'blocked');
 assert.match(plan.entries[0].reason, /请填写提示词/);
 assert.equal(plan.canStart, false);
 await assert.rejects(svc.batchStart(w, project.id, { shotIds: shots.map(s => s.id), previewToken: plan.previewToken, revision: plan.revision, requestKey: randomUUID() }), { code: 'START_BLOCKED' });
 // 上一镜既不在批次内也没有成功视频：阻塞并说明原因。
 const chain = await shotsProject('vb-scope-chain', [{ title: '甲' }, { title: '乙', mode: 'frames', tail: true }]);
 const alone = await svc.batchPreview('vb-scope-chain', chain.project.id, { shotIds: [chain.shots[1].id] });
 assert.equal(alone.entries[0].action, 'blocked');
 assert.match(alone.entries[0].reason, /上一镜尚无成功视频/);
 await wait(0);
});
