import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';

let db, store;
test.before(async()=>{ db=await startTestPostgres();store=new CreationStore(db.pool); });
test.after(async()=>{await db?.stop();});

const fakeMedia = {
  read: async (workspace, id) => ({ bytes: Buffer.from([0,0,0,24,102,116,121,112,...Buffer.from('isom'),0,0,0,0]), mime: 'video/mp4', name: `${id}.mp4` }),
  put: async (workspace, payload) => store.create(workspace, 'asset', {
    name: payload.name || '素材.mp4', mime: payload.mime || 'video/mp4', objectKey: `creation/test/${randomUUID()}.mp4`,
    role: payload.role || 'result', productId: payload.productId || null, projectId: payload.projectId || null,
    taskId: payload.taskId || null, runId: payload.runId || null, bytes: payload.bytes?.length || 16, sha256: '0'.repeat(64),
  }),
};
const fakeHub = scriptJson => ({ complete: async () => ({ text: scriptJson, usage: { costMicros: 0, currency: 'CNY' } }) });
// 按请求任务类型返回：video-script → 脚本；video-storyboard → 分镜。
const stagedHub = shotsJson => ({ complete: async ({ messages }) => {
  const payload = JSON.parse(messages[0].content);
  const text = payload.task === 'video-storyboard' ? shotsJson : JSON.stringify({ script: '【开场】展示保温杯' });
  return { text, usage: { costMicros: 0, currency: 'CNY' } };
} });
const fakeCompile = async ({ files }) => { if (!files.length) throw new Error('no files'); return Buffer.from([0,0,0,24,102,116,121,112,...Buffer.from('isom'),0,0,0,0]); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function insertVideoRun(pool, workspace, projectId, taskId) {
  const assetId = randomUUID();
  await store.create(workspace, 'asset', { name: 'shot.mp4', mime: 'video/mp4', objectKey: `creation/test/${assetId}.mp4`, role: 'result', productId: null, projectId, taskId, runId: null, bytes: 24, sha256: '0'.repeat(64) }, undefined, assetId);
  await pool.query(
    "INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES($1,$2,$3,$4,$5,$6,'succeeded',$7)",
    [randomUUID(), workspace, projectId, taskId, randomUUID(), { kind: 'video', nodeKind: 'video', task: { title: 'shot' }, prompt: 'p', params: {}, model: null, start: { requestKey: randomUUID() } }, { assetId, fileUrl: `/api/creation/assets/${assetId}/file` }],
  );
  return assetId;
}

test('AI script generation persists the script and replays the same request key', async () => {
  const svc = new CreationProjects(store, { hub: fakeHub(JSON.stringify({ script: '【开场】展示保温杯' })), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-script', {});
  const requestKey = randomUUID();
  const done = await svc.generateScript('sb-script', project.id, { revision: project.revision, requestKey, instructions: '15秒竖屏' });
  assert.equal(done.project.storyboard.script, '【开场】展示保温杯');
  assert.equal(done.project.storyboard.scriptRequest.status, 'ready');
  const replay = await svc.generateScript('sb-script', project.id, { revision: done.project.revision, requestKey, instructions: '15秒竖屏' });
  assert.equal(replay.project.storyboard.script, '【开场】展示保温杯');
  await assert.rejects(svc.generateScript('sb-script', project.id, { revision: replay.project.revision, requestKey, instructions: '不同要求' }), { code: 'REQUEST_KEY_CONFLICT' });
});

test('AI shots are stored as a pending suggestion; applying creates dimensioned canvas nodes; stale canvases are rejected', async () => {
  const shots = JSON.stringify({ shots: [{ title: '开场', description: '产品特写', prompt: 'slow push in on the bottle', duration: 5, videoMode: 'text' }, { title: '场景', description: '厨房', prompt: 'kitchen scene', duration: 6, mode: 'firstFrame' }] });
  const svc = new CreationProjects(store, { hub: stagedHub(shots), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-shots', {});
  await svc.generateScript('sb-shots', project.id, { revision: project.revision, requestKey: randomUUID() });
  const detail = await svc.detail('sb-shots', project.id);
  const done = await svc.generateShots('sb-shots', project.id, { revision: detail.project.revision, requestKey: randomUUID() });
  assert.equal(done.project.storyboard.shotsRequest.status, 'ready');
  assert.equal(done.project.storyboard.shots.length, 0, '建议不直接写入分镜');
  assert.equal(done.project.tasks.length, detail.project.tasks.length, '建议不直接写入画布');
  assert.match(done.project.storyboard.shotsRequest.suggestion.notice, /旧版画布/, '旧版画布不提供素材并说明原因');
  const applied = await svc.applyShotsRequest('sb-shots', project.id, { revision: done.project.revision, requestId: done.project.storyboard.shotsRequest.id });
  const storyboard = applied.project.storyboard;
  assert.equal(storyboard.shots.length, 2);
  for (const shot of storyboard.shots) {
    assert.ok(shot.nodeId, '分镜应回写节点编号');
    const node = applied.project.tasks.find(t => t.id === shot.nodeId);
    assert.equal(node.kind, 'video');
    assert.equal(node.dimension, '视频分镜');
    assert.equal(shot.prompt, undefined, '分镜不再保存提示词副本');
    assert.equal(shot.duration, undefined);
  }
  const seeded = storyboard.shots.map(shot => applied.project.tasks.find(t => t.id === shot.nodeId));
  assert.deepEqual(seeded.map(n => n.prompt), ['slow push in on the bottle', 'kitchen scene'], 'AI 提示词写入新节点');
  assert.deepEqual(seeded.map(n => [n.params.duration, n.params.resolution, n.params.ratio, n.videoMode]), [[5, '768P', '9:16', 'text'], [6, '768P', '9:16', 'text']]);
  // 画布在分镜生成期间变化 → 建议失败，保留输入：模型调用挂起时并发修改画布。
  const shots2 = JSON.stringify({ shots: [{ title: '新镜', description: '', prompt: 'p', duration: 5, videoMode: 'text' }] });
  const gate = { release: null };
  const slowSvc = new CreationProjects(store, { hub: { complete: async () => { await new Promise(resolve => { gate.release = resolve; }); return { text: shots2, usage: null }; } }, media: fakeMedia, compileBytes: fakeCompile });
  const fresh = await svc.detail('sb-shots', project.id);
  const pending = slowSvc.generateShots('sb-shots', project.id, { revision: fresh.project.revision, requestKey: randomUUID() });
  for (let index = 0; index < 50 && !gate.release; index += 1) await wait(50);
  // 真正改变 tasks/edges（hash 只覆盖图结构），而不是仅改项目名。
  const current = await svc.detail('sb-shots', project.id);
  await svc.update('sb-shots', project.id, { revision: current.project.revision, tasks: current.project.tasks.map((t, i) => i === 0 ? { ...t, title: '改名节点' } : t) });
  gate.release();
  const stale = await pending;
  assert.equal(stale.project.storyboard.shotsRequest.status, 'failed');
});

// ---------- 生视频第 4 步：AI 分镜的素材清单、校验、确认与放弃 ----------
async function makeAsset(workspace, fields) {
  const id = randomUUID();
  await store.create(workspace, 'asset', { name: 'x', mime: 'image/png', objectKey: `creation/test/${id}`, role: 'creative', productId: null, projectId: null, taskId: null, runId: null, bytes: 24, sha256: '0'.repeat(64), ...fields }, undefined, id);
  return id;
}
// 项目：商品创作图、项目内一个成功的生成结果、项目上传的音频、商品下上传的视频。
async function materialProject(workspace) {
  const image = await makeAsset(workspace, { name: '杯身正面.png' });
  const product = await store.create(workspace, 'product', { name: '保温杯', facts: { 容量: '500ml' }, creativeAssetIds: [image] });
  const svc0 = new CreationProjects(store, { hub: fakeHub('{}'), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc0.create(workspace, { productId: product.id, graphVersion: 3 });
  const audio = await makeAsset(workspace, { name: '背景音乐.mp3', mime: 'audio/mpeg', projectId: project.id });
  const video = await makeAsset(workspace, { name: '工厂实拍.mp4', mime: 'video/mp4', productId: product.id });
  const generate = project.tasks.find(t => t.kind === 'generate');
  const resultAsset = await makeAsset(workspace, { name: '主图结果.png', role: 'result', projectId: project.id, taskId: generate.id });
  const runId = randomUUID();
  await db.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES($1,$2,$3,$4,$5,$6,'succeeded',$7)", [runId, workspace, project.id, generate.id, randomUUID(), { kind: 'image', task: { title: generate.title } }, { assetId: resultAsset }]);
  return { project, product, ids: { image, audio, video, resultAsset, runId, generateId: generate.id } };
}
// 模型替身：读取素材清单，按素材名取编号，返回由 build(keyOf) 给出的分镜；记录收到的全部请求。
function planningHub(build) {
  const requests = [];
  return { requests, complete: async ({ messages, system }) => {
    const payload = JSON.parse(messages[0].content);
    requests.push({ payload, system, raw: messages[0].content });
    if (payload.task !== 'video-storyboard') return { text: JSON.stringify({ script: '【开场】展示保温杯' }), usage: null };
    const keyOf = name => payload.materials.find(m => m.name.startsWith(name))?.key;
    return { text: JSON.stringify({ shots: build(keyOf) }), usage: { costMicros: 0, currency: 'CNY' } };
  } };
}
const planShots = keyOf => [
  { title: '开场首帧', description: '杯子特写', videoMode: 'frames', duration: 5, prompt: '镜头缓慢推进', materials: [{ key: keyOf('杯身正面'), slot: 'first' }] },
  { title: '参考镜', description: '参考主图与音乐', videoMode: 'reference', duration: 8, prompt: `参考 {{${keyOf('商品主图')}}} 的造型，节奏跟随 {{${keyOf('背景音乐')}}}`, materials: [{ key: keyOf('商品主图'), slot: 'refImage' }, { key: keyOf('背景音乐'), slot: 'refAudio' }, { key: keyOf('工厂实拍'), slot: 'refVideo' }], dialogue: [{ text: '这款杯子保温十二小时', language: 'zh' }] },
  { title: '违规镜', description: '混用素材', videoMode: 'frames', duration: 99, prompt: `混用 {{${keyOf('杯身正面')}}} 与 {{M99}}`, materials: [{ key: 'M99', slot: 'refImage' }, { key: keyOf('杯身正面'), slot: 'first' }, { key: keyOf('商品主图'), slot: 'refImage' }] },
  { title: '孤立音频', description: '', videoMode: 'reference', duration: 2, prompt: '只有音频', materials: [{ key: keyOf('背景音乐'), slot: 'refAudio' }] },
];
async function suggested(workspace, build = planShots) {
  const ctx = await materialProject(workspace);
  const hub = planningHub(build);
  const svc = new CreationProjects(store, { hub, media: fakeMedia, compileBytes: fakeCompile });
  const scripted = await svc.generateScript(workspace, ctx.project.id, { revision: ctx.project.revision, requestKey: randomUUID() });
  const done = await svc.generateShots(workspace, ctx.project.id, { revision: scripted.project.revision, requestKey: randomUUID() });
  return { ...ctx, svc, hub, done, request: done.project.storyboard.shotsRequest };
}
const overlaps = (a, b) => Math.abs(a.position.x - b.position.x) < 340 && Math.abs(a.position.y - b.position.y) < 200;

test('saveStoryboard syncs nodes: add, update and remove without history', async () => {
  const svc = new CreationProjects(store, { hub: fakeHub('{}'), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-sync', {});
  const shot = { id: randomUUID(), title: '特写', description: '', prompt: 'close-up', duration: 6, mode: 'text', sourceAssetId: null, sourceRunId: null, nodeId: null };
  let detail = await svc.saveStoryboard('sb-sync', project.id, { revision: project.revision, script: '', shots: [shot] });
  assert.equal(detail.project.tasks.filter(t => t.kind === 'video').length, 1);
  const nodeId = detail.project.storyboard.shots[0].nodeId;
  assert.equal(detail.project.tasks.find(t => t.id === nodeId).prompt, 'close-up', '旧客户端的提示词只在建节点时作为初始值');
  // 再次保存只同步标题；提示词与时长不再从分镜回写（V-08）。
  detail = await svc.saveStoryboard('sb-sync', project.id, { revision: detail.project.revision, script: '', shots: [{ ...shot, nodeId, title: '特写2', prompt: 'extreme close-up', duration: 8 }] });
  const node = detail.project.tasks.find(t => t.id === nodeId);
  assert.equal(node.title, '特写2');
  assert.equal(node.prompt, 'close-up');
  assert.equal(node.params.duration, 6);
  // 删除分镜（无历史）→ 节点移除。
  detail = await svc.saveStoryboard('sb-sync', project.id, { revision: detail.project.revision, script: '', shots: [] });
  assert.equal(detail.project.tasks.some(t => t.id === nodeId), false);
});

test('shots with generation history keep their nodes when removed from the storyboard', async () => {
  const svc = new CreationProjects(store, { hub: fakeHub('{}'), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-history', {});
  const shot = { id: randomUUID(), title: '历史镜', description: '', prompt: 'p', duration: 6, mode: 'text', sourceAssetId: null, sourceRunId: null, nodeId: null };
  let detail = await svc.saveStoryboard('sb-history', project.id, { revision: project.revision, script: '', shots: [shot] });
  const nodeId = detail.project.storyboard.shots[0].nodeId;
  await insertVideoRun(db.pool, 'sb-history', project.id, nodeId);
  detail = await svc.saveStoryboard('sb-history', project.id, { revision: detail.project.revision, script: '', shots: [] });
  assert.equal(detail.project.tasks.some(t => t.id === nodeId), true, '已有生成记录的节点不能移除');
});

test('compile requires every shot to succeed, then stores the film as a result asset', async () => {
  const svc = new CreationProjects(store, { hub: fakeHub('{}'), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-compile', {});
  const shots = [{ id: randomUUID(), title: 'A', description: '', prompt: 'a', duration: 5, mode: 'text', sourceAssetId: null, sourceRunId: null, nodeId: null }, { id: randomUUID(), title: 'B', description: '', prompt: 'b', duration: 6, mode: 'text', sourceAssetId: null, sourceRunId: null, nodeId: null }];
  let detail = await svc.saveStoryboard('sb-compile', project.id, { revision: project.revision, script: '', shots });
  const nodeIds = detail.project.storyboard.shots.map(s => s.nodeId);
  await assert.rejects(svc.compileStoryboard('sb-compile', project.id, { revision: detail.project.revision, requestKey: randomUUID() }), { code: 'COMPILE_INCOMPLETE' });
  await insertVideoRun(db.pool, 'sb-compile', project.id, nodeIds[0]);
  await assert.rejects(svc.compileStoryboard('sb-compile', project.id, { revision: detail.project.revision, requestKey: randomUUID() }), { code: 'COMPILE_INCOMPLETE' });
  await insertVideoRun(db.pool, 'sb-compile', project.id, nodeIds[1]);
  detail = await svc.detail('sb-compile', project.id);
  const started = await svc.compileStoryboard('sb-compile', project.id, { revision: detail.project.revision, requestKey: randomUUID() });
  assert.equal(started.project.storyboard.compile.status, 'running');
  let film = started.project.storyboard.compile;
  for (let index = 0; index < 50 && film.status === 'running'; index += 1) {
    await wait(100);
    film = (await svc.detail('sb-compile', project.id)).project.storyboard.compile;
  }
  assert.equal(film.status, 'succeeded');
  assert.ok(film.assetId, '成片应归集为素材');
  const asset = await store.get('sb-compile', film.assetId);
  assert.equal(asset.role, 'result');
  assert.equal(asset.projectId, project.id);
});

test('AI storyboard sends a keyed material list (no URLs) and stores a validated pending suggestion', async () => {
  const { hub, done, request, ids } = await suggested('sb-ai-list');
  const sent = hub.requests.find(r => r.payload.task === 'video-storyboard');
  const materials = sent.payload.materials;
  assert.deepEqual(materials.map(m => m.key), ['M1', 'M2', 'M3', 'M4'], '短编号依次为 M1、M2…');
  const by = name => materials.find(m => m.name.startsWith(name));
  assert.deepEqual([by('杯身正面').type, by('杯身正面').source], ['image', '商品创作素材']);
  assert.deepEqual([by('商品主图').type, by('商品主图').source], ['image', '项目生成结果：商品主图，版本 1']);
  assert.deepEqual([by('背景音乐').type, by('背景音乐').source], ['audio', '项目上传素材']);
  assert.deepEqual([by('工厂实拍').type, by('工厂实拍').source], ['video', '商品下上传的素材']);
  assert.ok(materials.every(m => Object.keys(m).sort().join() === 'key,name,source,type'), '只含编号、类型、名称、来源');
  assert.doesNotMatch(JSON.stringify(materials), /https?:|\/api\/creation|objectKey|[a-f0-9]{8}-[a-f0-9]{4}-/, '不向模型传 URL 或内部编号');
  for (const rule of ['首尾帧', '参考图', '合计最多 12', '参考音频不能单独使用', '口型同步', '{{M1}}']) assert.ok(sent.system.includes(rule), `system 提示包含规则：${rule}`);
  // 建议只是预览：不写分镜与画布。
  assert.equal(request.status, 'ready');
  assert.equal(done.project.storyboard.shots.length, 0);
  assert.equal(done.project.tasks.some(t => t.kind === 'video'), false);
  const [first, reference, bad, audioOnly] = request.suggestion.shots;
  assert.deepEqual([first.videoMode, first.materials.map(m => [m.slot, m.name])], ['frames', [['first', '杯身正面.png']]]);
  assert.deepEqual([reference.videoMode, reference.duration, reference.dialogue], ['reference', 8, [{ text: '这款杯子保温十二小时', language: 'zh' }]]);
  assert.equal(reference.materials.length, 3);
  // 修正：未知编号丢弃并说明；混用素材降级为文生视频；时长夹到 4～30；孤立音频降级。
  assert.equal(bad.videoMode, 'text');
  assert.equal(bad.duration, 30);
  assert.deepEqual(bad.materials, []);
  assert.ok(bad.notes.some(n => n.includes('M99') && n.includes('不在可用素材清单')));
  assert.ok(bad.notes.some(n => n.includes('不能混用参考素材') && n.includes('文生视频')));
  assert.ok(bad.notes.some(n => n.includes('时长') && n.includes('30')));
  assert.doesNotMatch(bad.prompt, /\{\{/, '没有对应素材的标签被移除');
  assert.equal(audioOnly.videoMode, 'text');
  assert.equal(audioOnly.duration, 4);
  assert.ok(audioOnly.notes.some(n => n.includes('参考音频不能单独使用')));
  assert.deepEqual(request.suggestion.materials.map(m => m.assetId).sort(), [ids.image, ids.audio, ids.video, ids.resultAsset].sort(), '只保存被用到的素材映射');
});

test('applying the AI storyboard creates nodes, edges, pinned versions, rewritten labels, modes and dialogue; repeat apply is idempotent', async () => {
  const { svc, project, request, ids } = await suggested('sb-ai-apply');
  const before = await svc.detail('sb-ai-apply', project.id);
  const applied = await svc.applyShotsRequest('sb-ai-apply', project.id, { revision: before.project.revision, requestId: request.id });
  const { tasks, edges, storyboard } = applied.project;
  assert.equal(storyboard.shotsRequest.status, 'applied');
  assert.equal(storyboard.shots.length, 4);
  const node = index => tasks.find(t => t.id === storyboard.shots[index].nodeId);
  const inbound = (target, slot) => edges.filter(e => e.target === target.id && e.targetHandle === slot);
  const [n1, n2, n3, n4] = [0, 1, 2, 3].map(node);
  // 首帧来自素材库资产 → 新建 image 输入节点。
  assert.equal(n1.videoMode, 'frames');
  const firstEdge = inbound(n1, 'first');
  assert.equal(firstEdge.length, 1);
  const firstSource = tasks.find(t => t.id === firstEdge[0].source);
  assert.deepEqual([firstSource.kind, firstSource.sourceAssetId, firstEdge[0].sourceHandle], ['image', ids.image, 'image']);
  // 已有画布结果 → 连线到该节点并固定版本；音频 / 视频资产 → 新建 audio / footage 节点。
  assert.equal(n2.videoMode, 'reference');
  assert.equal(n2.params.duration, 8);
  const refEdge = inbound(n2, 'refImage');
  assert.deepEqual([refEdge[0].source, refEdge[0].sourceHandle], [ids.generateId, 'image']);
  assert.deepEqual(n2.sourceRunIds, [ids.runId], '固定该结果版本');
  const audioNode = tasks.find(t => t.id === inbound(n2, 'refAudio')[0].source);
  const footageNode = tasks.find(t => t.id === inbound(n2, 'refVideo')[0].source);
  assert.deepEqual([audioNode.kind, audioNode.sourceAssetId], ['audio', ids.audio]);
  assert.deepEqual([footageNode.kind, footageNode.sourceAssetId], ['footage', ids.video]);
  assert.equal(n2.prompt, `参考 {{ref:${ids.generateId}}} 的造型，节奏跟随 {{ref:${audioNode.id}}}`, '{{Mk}} 改写为 {{ref:节点编号}}');
  assert.deepEqual(n2.dialogue, [{ text: '这款杯子保温十二小时', language: 'zh' }]);
  assert.equal(n2.dubMode, 'lipsync');
  // 降级的分镜：文生视频、无连线。
  for (const n of [n3, n4]) { assert.equal(n.videoMode, 'text'); assert.equal(edges.filter(e => e.target === n.id).length, 0); }
  assert.equal(n3.params.duration, 30);
  // 标签换算：运行时 {{ref:}} 被换成 <Picture 1> / <Audio 1>。
  const resolved = svc.resolveVideoInputs(n2, applied.project, applied.runs);
  assert.match(resolved.promptText, /参考 <Picture 1> 的造型，节奏跟随 <Audio 1>/);
  assert.equal(resolved.videoIssue, null);
  assert.equal(resolved.tagIssue, null);
  assert.deepEqual(resolved.media.map(m => m.role), ['reference_image', 'reference_video', 'reference_audio']);
  assert.equal(resolved.media[0].runId, ids.runId);
  // 位置：新节点不与既有节点或彼此重叠，且排在现有节点下方。
  const existingIds = new Set(before.project.tasks.map(t => t.id));
  const created = tasks.filter(t => !existingIds.has(t.id));
  assert.equal(created.length, 4 + 3, '4 个视频节点 + 3 个素材输入节点（杯身、音频、视频）');
  for (const a of created) for (const b of tasks) if (a !== b) assert.equal(overlaps(a, b), false, `${a.title} 与 ${b.title} 位置重叠`);
  assert.ok(created.every(t => t.position.y > Math.max(...before.project.tasks.map(x => x.position.y))), '新节点排在现有节点下方');
  // 幂等：同一 requestId 再次确认（即使修订号已过期）不重复创建。
  const again = await svc.applyShotsRequest('sb-ai-apply', project.id, { revision: before.project.revision, requestId: request.id });
  assert.equal(again.project.tasks.length, applied.project.tasks.length);
  assert.equal(again.project.storyboard.shots.length, 4);
  assert.equal(again.project.revision, applied.project.revision);
  await assert.rejects(svc.discardShotsRequest('sb-ai-apply', project.id, { requestId: request.id }), { code: 'SUGGESTION_INVALID' });
});

test('applying an AI storyboard is rejected when the canvas changed after the suggestion, and a discarded suggestion cannot be applied', async () => {
  const { svc, project, request } = await suggested('sb-ai-stale');
  const current = await svc.detail('sb-ai-stale', project.id);
  const renamed = await svc.update('sb-ai-stale', project.id, { revision: current.project.revision, tasks: current.project.tasks.map((t, i) => i === 0 ? { ...t, title: '改过名' } : t) });
  await assert.rejects(svc.applyShotsRequest('sb-ai-stale', project.id, { revision: renamed.project.revision, requestId: request.id }), error => error.code === 'SUGGESTION_STALE' && /重新生成/.test(error.message));
  assert.equal(renamed.project.storyboard.shots.length, 0);
  // 素材被移入回收站后也要求重新生成。
  const fresh = await suggested('sb-ai-trash');
  const trashed = fresh.request.suggestion.materials.find(m => m.name.startsWith('背景音乐'));
  await db.pool.query('UPDATE sj_creation_records SET trashed_at=now() WHERE id=$1', [trashed.assetId]);
  const state = await fresh.svc.detail('sb-ai-trash', fresh.project.id);
  await assert.rejects(fresh.svc.applyShotsRequest('sb-ai-trash', fresh.project.id, { revision: state.project.revision, requestId: fresh.request.id }), error => error.code === 'SUGGESTION_STALE' && error.message.includes('背景音乐'));
  // 放弃：标记 discarded，不改画布；重复放弃不报错；之后不能再应用。
  const kept = await fresh.svc.detail('sb-ai-trash', fresh.project.id);
  const discarded = await fresh.svc.discardShotsRequest('sb-ai-trash', fresh.project.id, { requestId: fresh.request.id });
  assert.equal(discarded.project.storyboard.shotsRequest.status, 'discarded');
  assert.equal(discarded.project.storyboard.shotsRequest.suggestion, undefined);
  assert.deepEqual(discarded.project.tasks, kept.project.tasks);
  assert.equal(discarded.project.revision, kept.project.revision, '放弃不改变项目修订号');
  await fresh.svc.discardShotsRequest('sb-ai-trash', fresh.project.id, { requestId: fresh.request.id });
  await assert.rejects(fresh.svc.applyShotsRequest('sb-ai-trash', fresh.project.id, { revision: discarded.project.revision, requestId: fresh.request.id }), { code: 'SUGGESTION_INVALID' });
  await assert.rejects(fresh.svc.applyShotsRequest('sb-ai-trash', fresh.project.id, { revision: discarded.project.revision, requestId: randomUUID() }), { code: 'SUGGESTION_INVALID' });
});

test('compile reads the video chosen by shotVideoFor for each shot and passes bytes with names to the encoder', async () => {
  const reads = [], seen = [];
  const media = { ...fakeMedia, read: async (workspace, id) => { reads.push(id); return { bytes: Buffer.from(`bytes:${id}`), mime: 'video/mp4', name: `${id}.mp4` }; } };
  const svc = new CreationProjects(store, { hub: fakeHub('{}'), media, compileBytes: async ({ files }) => { seen.push(files); return fakeCompile({ files }); } });
  const { project } = await svc.create('sb-pick', {});
  const shots = ['A', 'B'].map(title => ({ id: randomUUID(), title, description: '', nodeId: null }));
  let detail = await svc.saveStoryboard('sb-pick', project.id, { revision: project.revision, script: '', shots });
  const nodeIds = detail.project.storyboard.shots.map(s => s.nodeId);
  const latest = [await insertVideoRun(db.pool, 'sb-pick', project.id, nodeIds[0]), await insertVideoRun(db.pool, 'sb-pick', project.id, nodeIds[1])];
  const dubbed = [randomUUID(), randomUUID()];
  assert.equal(svc.shotVideoFor({ nodeId: nodeIds[0] }, (await svc.detail('sb-pick', project.id)).runs).assetId, latest[0], '默认取最新成功运行的视频');
  assert.equal(svc.shotVideoFor({ nodeId: randomUUID() }, []), null);
  // 第 5 步会在这里优先返回配音后的派生视频；调用方只认 shotVideoFor 的结果。
  svc.shotVideoFor = shot => ({ assetId: dubbed[nodeIds.indexOf(shot.nodeId)], runId: null });
  detail = await svc.detail('sb-pick', project.id);
  await svc.compileStoryboard('sb-pick', project.id, { revision: detail.project.revision, requestKey: randomUUID() });
  for (let index = 0; index < 50 && !seen.length; index += 1) await wait(100);
  assert.deepEqual(reads, dubbed, '只读取 shotVideoFor 选中的资产');
  assert.equal(seen[0].length, 2);
  assert.deepEqual(seen[0].map(f => f.bytes.toString()), dubbed.map(id => `bytes:${id}`));
  assert.deepEqual(seen[0].map(f => f.name), dubbed.map(id => `${id}.mp4`));
});

test('an oversized film is stored as a Chinese failure reason on the project', async () => {
  const { AppError } = await import('../server/errors.mjs');
  const tooLarge = async () => { throw new AppError('COMPILE_TOO_LARGE', '成片约 120 MB，超过素材库单个文件 100 MB 的上限，无法保存；请缩短分镜时长或降低分辨率后重试。', 413); };
  const svc = new CreationProjects(store, { hub: fakeHub('{}'), media: fakeMedia, compileBytes: tooLarge });
  const { project } = await svc.create('sb-big', {});
  let detail = await svc.saveStoryboard('sb-big', project.id, { revision: project.revision, script: '', shots: [{ id: randomUUID(), title: 'A', description: '', nodeId: null }] });
  await insertVideoRun(db.pool, 'sb-big', project.id, detail.project.storyboard.shots[0].nodeId);
  detail = await svc.detail('sb-big', project.id);
  await svc.compileStoryboard('sb-big', project.id, { revision: detail.project.revision, requestKey: randomUUID() });
  let film = { status: 'running' };
  for (let index = 0; index < 50 && film.status === 'running'; index += 1) { await wait(100); film = (await svc.detail('sb-big', project.id)).project.storyboard.compile; }
  assert.equal(film.status, 'failed');
  assert.match(film.error, /100 MB/);
});

test('task dimension labels are validated and survive updates', async () => {
  const svc = new CreationProjects(store, { hub: fakeHub('{}'), media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-dimension', {});
  const first = project.tasks[0];
  const changed = await svc.update('sb-dimension', project.id, { revision: project.revision, tasks: [{ ...first, dimension: '商品白底图' }] });
  assert.equal(changed.project.tasks[0].dimension, '商品白底图');
  await assert.rejects(svc.update('sb-dimension', project.id, { revision: changed.project.revision, tasks: [{ ...first, dimension: 'x'.repeat(25) }] }), { code: 'TASK_INVALID' });
});

test('AI suggestions can carry dimension labels onto new tasks', async () => {
  const plan = { additions: [{ kind: 'generate', title: '白底图', prompt: '白底', params: {}, subject: 'concept', dimension: '商品白底图' }], updates: [], edges: [] };
  const svc = new CreationProjects(store, { hub: { complete: async () => ({ text: JSON.stringify(plan) }) }, media: fakeMedia, compileBytes: fakeCompile });
  const { project } = await svc.create('sb-suggest', {});
  const proposal = await svc.suggest('sb-suggest', project.id, { revision: project.revision, requestKey: randomUUID(), instructions: '补一张白底图' });
  assert.equal(proposal.suggestion.status, 'ready');
  const applied = await svc.applySuggestion('sb-suggest', project.id, { revision: proposal.project.revision, suggestionId: proposal.suggestion.id });
  assert.equal(applied.project.tasks[1].dimension, '商品白底图');
});
