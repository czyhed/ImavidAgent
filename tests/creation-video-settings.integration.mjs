import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCreationApp } from './creation-app-fixture.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';

// 视频工作台项目级参数（W4）：storyboard.settings 的校验、持久化，以及预览 / 批量 / 开始 / 冻结输入如何继承。
// 全部使用本地夹具（真实 ModelHub + 假 H3 供应商），不调用任何付费接口。
let app, svc;
test.before(async () => {
 app = await startCreationApp({ autoTick: false });
 svc = new CreationProjects(app.store, { hub: app.hub, media: app.media });
});
test.after(async () => { await app?.stop(); });

const shotId = () => randomUUID();
// 建一个带两个分镜的项目；返回项目与两个分镜节点编号。
async function setup(workspace, settings) {
 const { project } = await svc.create(workspace, {});
 const ids = [shotId(), shotId()];
 await svc.applyOps(workspace, project.id, { ops: [{ type: 'storyboard.patch', shots: ids.map((id, index) => ({ id, title: `镜头${index + 1}`, description: '' })), ...(settings !== undefined ? { settings } : {}) }] });
 const detail = await svc.detail(workspace, project.id);
 const nodes = detail.project.storyboard.shots.map(s => s.nodeId);
 const patches = nodes.map(id => ({ type: 'task.patch', id, fields: { prompt: '杯子特写' } }));
 await svc.applyOps(workspace, project.id, { ops: patches });
 return { id: project.id, nodes, ids };
}
const setNode = (workspace, projectId, nodeId, fields, unset) => svc.applyOps(workspace, projectId, { ops: [{ type: 'task.patch', id: nodeId, fields, ...(unset ? { unset } : {}) }] });
const entryOf = (p, nodeId) => p.scope.find(e => e.taskId === nodeId);

test('storyboard.patch 保存、规范化并清除项目级参数；无效值被拒绝且不改动', async () => {
 const w = 'settings-store', { id } = await setup(w);
 assert.equal((await svc.detail(w, id)).project.storyboard.settings, undefined, '没有设置时不出现该字段');
 let detail = await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '1080P', ratio: '16:9', duration: 8 } }] });
 assert.deepEqual(detail.project.storyboard.settings, { resolution: '1080P', ratio: '16:9', duration: 8 });
 // 只改一个键：其余键以请求为准（整体替换，调用方带完整对象）。
 detail = await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '480P' } }] });
 assert.deepEqual(detail.project.storyboard.settings, { resolution: '480P' });
 // 只改脚本不影响设置。
 detail = await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', script: '新脚本' }] });
 assert.deepEqual(detail.project.storyboard.settings, { resolution: '480P' });
 for (const bad of [{ resolution: '720P' }, { ratio: 'adaptive' }, { ratio: '2:1' }, { duration: 3 }, { duration: 31 }, { duration: 4.5 }, { fps: 24 }, []]) {
  await assert.rejects(svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: bad }] }), e => ['STORYBOARD_SETTINGS_INVALID', 'OPS_INVALID'].includes(e.code), JSON.stringify(bad));
 }
 assert.deepEqual((await svc.detail(w, id)).project.storyboard.settings, { resolution: '480P' }, '拒绝后保持原值');
 detail = await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: null }] });
 assert.equal(detail.project.storyboard.settings, undefined, 'null 清除设置');
});

test('没有项目设置时行为不变：预览按节点自己的 params（或模型默认）', async () => {
 const w = 'settings-none', { id, nodes } = await setup(w);
 // 新建分镜节点仍带原默认值 768P / 9:16 / 5 秒。
 const detail = await svc.detail(w, id);
 assert.deepEqual(detail.project.tasks.find(t => t.id === nodes[0]).params, { duration: 5, resolution: '768P', ratio: '9:16' });
 await setNode(w, id, nodes[1], { params: { duration: 6, resolution: '480P' } });
 const p = await svc.preview(w, id, { taskIds: nodes });
 assert.equal(entryOf(p, nodes[0]).estimatedPoints, 50, '768P 10 积分 × 5 秒');
 assert.equal(entryOf(p, nodes[1]).estimatedPoints, 30, '480P 5 积分 × 6 秒');
});

test('分镜节点没有显式值时按项目设置预览；显式值（自定义）优先；非分镜视频节点不受影响', async () => {
 const w = 'settings-inherit', { id, nodes } = await setup(w);
 // 先清掉节点上的默认值，模拟「跟随项目」的分镜。
 for (const node of nodes) await setNode(w, id, node, { params: {} });
 await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '480P', ratio: '16:9', duration: 4 } }] });
 let p = await svc.preview(w, id, { taskIds: nodes });
 assert.equal(entryOf(p, nodes[0]).action, 'generate', entryOf(p, nodes[0]).reason);
 assert.equal(entryOf(p, nodes[0]).estimatedPoints, 20, '480P 5 积分 × 项目默认 4 秒');
 // 镜头 2 显式覆盖分辨率与时长：自定义优先；比例仍跟随项目。
 await setNode(w, id, nodes[1], { params: { resolution: '1080P', duration: 6 } });
 p = await svc.preview(w, id, { taskIds: nodes });
 assert.equal(entryOf(p, nodes[1]).estimatedPoints, 114, '1080P 19 积分 × 6 秒');
 assert.equal(entryOf(p, nodes[0]).estimatedPoints, 20, '镜头 1 仍跟随项目');
 // 改项目设置只影响跟随的分镜。
 await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '768P', duration: 5 } }] });
 p = await svc.preview(w, id, { taskIds: nodes });
 assert.equal(entryOf(p, nodes[0]).estimatedPoints, 50);
 assert.equal(entryOf(p, nodes[1]).estimatedPoints, 114);
 // 画布里手动添加、不属于分镜表的视频节点不继承项目设置。
 const loose = randomUUID();
 await svc.applyOps(w, id, { ops: [{ type: 'task.add', task: { id: loose, kind: 'video', title: '独立视频', prompt: '独立', params: { duration: 4 }, subject: 'concept', position: { x: 0, y: 900 }, sourceAssetId: null, sourceRunId: null, videoMode: 'text' } }] });
 p = await svc.preview(w, id, { taskIds: [loose] });
 assert.equal(entryOf(p, loose).estimatedPoints, 40, '节点自己的 4 秒，分辨率走模型默认 768P');
});

test('开始后冻结的运行输入使用有效参数；项目设置变化后相同节点不再复用旧成功记录', async () => {
 const w = 'settings-freeze', { id, nodes } = await setup(w);
 await setNode(w, id, nodes[0], { params: {} });
 await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '480P', ratio: '9:16', duration: 4 } }] });
 const p = await svc.preview(w, id, { taskIds: [nodes[0]] });
 const started = await svc.start(w, id, { ...p.selection, previewToken: p.previewToken, requestKey: randomUUID() });
 const run = started.runs.at(-1);
 assert.deepEqual(run.input.params, { duration: 4, resolution: '480P', ratio: '9:16' }, '冻结的是有效参数');
 assert.deepEqual(run.input.task.params, { duration: 4, resolution: '480P', ratio: '9:16' });
 await svc.tick();
 await svc.tick();
 assert.equal((await svc.detail(w, id)).runs.at(-1).status, 'succeeded');
 assert.equal(entryOf(await svc.preview(w, id, { taskIds: [nodes[0]] }), nodes[0]).action, 'reuse', '设置不变时复用');
 await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '1080P', ratio: '9:16', duration: 4 } }] });
 const again = entryOf(await svc.preview(w, id, { taskIds: [nodes[0]] }), nodes[0]);
 assert.equal(again.action, 'generate', '项目分辨率变了，不能复用 480P 的结果');
 assert.equal(again.estimatedPoints, 76);
});

test('批量预览与批量开始同样使用项目设置', async () => {
 const w = 'settings-batch', { id, ids, nodes } = await setup(w);
 for (const node of nodes) await setNode(w, id, node, { params: {} });
 await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', settings: { resolution: '480P', duration: 4 } }] });
 const plan = await svc.batchPreview(w, id, { shotIds: ids });
 assert.deepEqual(plan.entries.map(e => e.estimatedPoints), [20, 20]);
 assert.equal(plan.estimatedPoints, 40);
 await svc.batchStart(w, id, { shotIds: ids, previewToken: plan.previewToken, requestKey: randomUUID() });
 await svc.advanceBatches();
 const runs = (await svc.detail(w, id)).runs;
 assert.equal(runs.length, 2);
 for (const run of runs) assert.deepEqual([run.input.params.resolution, run.input.params.duration], ['480P', 4]);
});

test('AI 分镜与新增分镜：有项目设置时新节点只记录与项目不同的时长，分辨率与比例留空跟随', async () => {
 const w = 'settings-new', { id } = await setup(w, { resolution: '480P', ratio: '16:9', duration: 8 });
 const extra = shotId();
 const before = (await svc.detail(w, id)).project.storyboard.shots;
 await svc.applyOps(w, id, { ops: [{ type: 'storyboard.patch', shots: [...before.map(s => ({ id: s.id, title: s.title, description: s.description, nodeId: s.nodeId })), { id: extra, title: '新镜头', description: '' }] }] });
 const detail = await svc.detail(w, id);
 const node = detail.project.tasks.find(t => t.id === detail.project.storyboard.shots.at(-1).nodeId);
 assert.deepEqual(node.params, { duration: 5 }, '新建分镜的时长 5 与项目 8 不同时才记录；分辨率与比例留空');
 const first = detail.project.tasks.find(t => t.id === detail.project.storyboard.shots[0].nodeId);
 assert.deepEqual(first.params, { duration: 5 }, '同一次 patch 里带上的设置对首批分镜同样生效');
});
