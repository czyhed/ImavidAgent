import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCreationApp } from './creation-app-fixture.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';
import { createMediaPrep } from '../server/media-prep.mjs';

// 全部使用本地夹具（真实 ModelHub + 假 H3 供应商），不调用任何付费接口。
let app, svc, prepCalls;
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
test.before(async () => {
 app = await startCreationApp({ autoTick: false });
 prepCalls = [];
 svc = new CreationProjects(app.store, { hub: app.hub, media: app.media, mediaPrep: createMediaPrep({ runner: async input => { prepCalls.push(input.kind); return { bytes: input.bytes, mime: input.mime }; } }) });
});
test.after(async () => { await app?.stop(); });

const node = (id, kind, extra = {}) => ({ id, kind, title: id, prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 }, sourceAssetId: null, sourceRunId: null, ...extra });
const edge = (source, target, targetHandle, sourceHandle) => ({ id: `${source}-${target}-${targetHandle || 'x'}`, source, target, sourceHandle, targetHandle });
const submissions = () => app.calls.filter(c => c.method === 'POST' && c.path.endsWith('/minimax/v2/video_generation'));
async function setup(workspace, tasks, edges) {
 const { project } = await svc.create(workspace, {});
 return (await svc.update(workspace, project.id, { revision: project.revision, tasks, edges })).project;
}
async function uploads(workspace) {
 const image = await app.media.put(workspace, { bytes: app.png, name: '人物.png', role: 'creative' });
 const image2 = await app.media.put(workspace, { bytes: app.png, name: '产品.png', role: 'creative' });
 const audio = await app.media.put(workspace, { bytes: mp3, name: '配音.mp3', role: 'creative' });
 const footage = await app.media.put(workspace, { bytes: mp4, name: '动作.mp4', role: 'creative' });
 return { image, image2, audio, footage };
}
const preview = (workspace, project, taskId) => svc.preview(workspace, project.id, { taskIds: [taskId] });
const startRun = async (workspace, project, p) => svc.start(workspace, project.id, { ...p.selection, revision: p.revision, previewToken: p.previewToken, requestKey: randomUUID() });
const reasonOf = p => p.scope.at(-1).reason;

test('参考素材方式：media 按连线顺序冻结，标签换算为 Picture / Video / Audio，并提交带 role 的 content', async () => {
 const w = 'v2-reference', a = await uploads(w);
 const project = await setup(w, [
  node('p', 'image', { sourceAssetId: a.image.id }), node('f', 'footage', { sourceAssetId: a.footage.id }),
  node('s', 'audio', { sourceAssetId: a.audio.id }), node('q', 'image', { sourceAssetId: a.image2.id }),
  node('v', 'video', { videoMode: 'reference', prompt: '人物外观以 {{ref:p}} 为准，动作参考 {{ref:f}}，声音参考 {{ref:s}}，产品为 {{ref:q}}', params: { duration: 5, resolution: '480P' } }),
 ], [edge('p', 'v', 'refImage', 'image'), edge('f', 'v', 'refVideo', 'video'), edge('s', 'v', 'refAudio', 'audio'), edge('q', 'v', 'refImage', 'image')]);
 const p = await preview(w, project, 'v');
 const entry = p.scope.at(-1);
 assert.equal(entry.action, 'generate', entry.reason);
 assert.equal(entry.resolved.prompt, '人物外观以 <Picture 1> 为准，动作参考 <Video 1>，声音参考 <Audio 1>，产品为 <Picture 2>');
 assert.deepEqual(entry.resolved.media.map(m => [m.role, m.kind, m.sourceTaskId]), [['reference_image', 'image', 'p'], ['reference_image', 'image', 'q'], ['reference_video', 'video', 'f'], ['reference_audio', 'audio', 's']]);
 assert.equal(entry.estimatedPoints, 25);
 const started = await startRun(w, project, p);
 assert.equal(started.runs[0].input.media.length, 4);
 assert.equal(started.runs[0].input.videoMode, 'reference');
 assert.ok(!started.runs[0].input.prompt.includes('{{ref'));
 const before = submissions().length;
 await svc.tick();
 const body = submissions().at(-1).body;
 assert.equal(submissions().length, before + 1);
 assert.deepEqual(body.content.map(e => [e.type, e.role]), [['text', undefined], ['image_url', 'reference_image'], ['image_url', 'reference_image'], ['video_url', 'reference_video'], ['audio_url', 'reference_audio']]);
 assert.equal(body.content[0].text, entry.resolved.prompt);
 assert.ok(prepCalls.includes('video'));
 await svc.tick();
 assert.equal((await svc.detail(w, project.id)).runs[0].status, 'succeeded');
 // 相同输入再次预览复用成功记录
 assert.equal((await preview(w, project, 'v')).scope.at(-1).action, 'reuse');
});

test('标签：引用已移除素材或首尾帧素材时阻塞并给出中文原因', async () => {
 const w = 'v2-tags', a = await uploads(w);
 const base = [node('p', 'image', { sourceAssetId: a.image.id }), node('q', 'image', { sourceAssetId: a.image2.id })];
 let project = await setup(w, [...base, node('v', 'video', { videoMode: 'reference', prompt: '参考 {{ref:p}} 和 {{ref:q}}' })], [edge('p', 'v', 'refImage', 'image')]);
 let p = await preview(w, project, 'v');
 assert.equal(p.scope.at(-1).action, 'blocked');
 assert.equal(reasonOf(p), '提示词引用了已移除的素材，请删除标红的标签。');
 assert.equal(p.canStart, false);
 project = (await svc.update(w, project.id, { revision: project.revision, tasks: project.tasks.map(t => t.id === 'v' ? { ...t, videoMode: 'frames', prompt: '首帧 {{ref:p}}' } : t), edges: [edge('p', 'v', 'first', 'image')] })).project;
 p = await preview(w, project, 'v');
 assert.equal(p.scope.at(-1).action, 'blocked');
 assert.match(reasonOf(p), /首尾帧素材不使用标签/);
});

test('视频方式校验：文生不可连素材，首尾帧需要帧且不混参考，参考素材需要图片或视频，音频不能单独使用', async () => {
 const w = 'v2-modes', a = await uploads(w);
 const inputs = [node('p', 'image', { sourceAssetId: a.image.id }), node('s', 'audio', { sourceAssetId: a.audio.id })];
 const reason = async (videoMode, edges, prompt = '一段描述') => {
  const project = await setup(w, [...inputs, node('v', 'video', { videoMode, prompt })], edges);
  const p = await preview(w, project, 'v');
  return [p.scope.at(-1).action, reasonOf(p)];
 };
 assert.deepEqual((await reason('text', [])).slice(0, 1), ['generate']);
 assert.match((await reason('text', [edge('p', 'v', 'first', 'image')]))[1], /文生视频不能连接/);
 assert.match((await reason('text', [], ''))[1], /请填写提示词/);
 assert.match((await reason('frames', []))[1], /需要连接首帧或尾帧/);
 assert.match((await reason('frames', [edge('p', 'v', 'first', 'image'), edge('p', 'v', 'refImage', 'image')]))[1], /不能连接参考/);
 assert.equal((await reason('frames', [edge('p', 'v', 'last', 'image')], ''))[0], 'generate');
 assert.match((await reason('reference', [edge('s', 'v', 'refAudio', 'audio')]))[1], /音频不能单独使用/);
 assert.match((await reason('reference', []))[1], /至少一张参考图片/);
 assert.match((await reason('reference', [edge('p', 'v', 'refImage', 'image'), edge('p', 'v', 'first', 'image')]))[1], /不能连接首帧或尾帧/);
 assert.equal((await reason('reference', [edge('p', 'v', 'refImage', 'image'), edge('s', 'v', 'refAudio', 'audio')], ''))[0], 'generate');
 // 空值按旧逻辑推断：有首帧为首尾帧，否则文生
 assert.equal((await reason(undefined, [edge('p', 'v', 'first', 'image')]))[0], 'generate');
});

test('graph 端口条数上限：首尾帧各 1，参考图 9，参考视频 3，参考音频 3，合计 12', async () => {
 const w = 'v2-limits', a = await uploads(w);
 const make = (kind, count, handle, type, assetId) => {
  const sources = Array.from({ length: count }, (_, i) => node(`${kind}${i}`, kind, { sourceAssetId: assetId }));
  return { tasks: [...sources, node('v', 'video', { videoMode: 'reference', prompt: 'x' })], edges: sources.map(s => edge(s.id, 'v', handle, type)) };
 };
 const attempt = async (spec) => { const { project } = await svc.create(w, {}); return svc.update(w, project.id, { revision: project.revision, tasks: spec.tasks, edges: spec.edges }); };
 await attempt(make('image', 9, 'refImage', 'image', a.image.id));
 await assert.rejects(attempt(make('image', 10, 'refImage', 'image', a.image.id)), { code: 'TOO_MANY_VIDEO_REFERENCES' });
 await attempt(make('footage', 3, 'refVideo', 'video', a.footage.id));
 await assert.rejects(attempt(make('footage', 4, 'refVideo', 'video', a.footage.id)), { code: 'TOO_MANY_VIDEO_REFERENCES' });
 await attempt(make('audio', 3, 'refAudio', 'audio', a.audio.id));
 await assert.rejects(attempt(make('audio', 4, 'refAudio', 'audio', a.audio.id)), { code: 'TOO_MANY_VIDEO_REFERENCES' });
 // 首帧只能一条
 const two = [node('i0', 'image', { sourceAssetId: a.image.id }), node('i1', 'image', { sourceAssetId: a.image.id }), node('v', 'video')];
 await assert.rejects(attempt({ tasks: two, edges: [edge('i0', 'v', 'first', 'image'), edge('i1', 'v', 'first', 'image')] }), { code: 'EDGE_INCOMPATIBLE' });
 // 合计 12：9 图 + 3 视频已是 12，再加 1 个音频超限
 const nine = Array.from({ length: 9 }, (_, i) => node(`a${i}`, 'image', { sourceAssetId: a.image.id }));
 const three = Array.from({ length: 3 }, (_, i) => node(`b${i}`, 'footage', { sourceAssetId: a.footage.id }));
 const edges = [...nine.map(n => edge(n.id, 'v', 'refImage', 'image')), ...three.map(n => edge(n.id, 'v', 'refVideo', 'video'))];
 await attempt({ tasks: [...nine, ...three, node('v', 'video')], edges });
 await assert.rejects(attempt({ tasks: [...nine, ...three, node('s', 'audio', { sourceAssetId: a.audio.id }), node('v', 'video')], edges: [...edges, edge('s', 'v', 'refAudio', 'audio')] }), { code: 'TOO_MANY_VIDEO_REFERENCES' });
 // 类型不匹配：视频不能接参考图片端口
 await assert.rejects(attempt({ tasks: [node('f', 'footage', { sourceAssetId: a.footage.id }), node('v', 'video')], edges: [edge('f', 'v', 'refImage', 'video')] }), { code: 'EDGE_INCOMPATIBLE' });
 // 素材 MIME 必须与节点类型一致
 await assert.rejects(attempt({ tasks: [node('s', 'audio', { sourceAssetId: a.image.id })], edges: [] }), { code: 'SOURCE_INVALID' });
 await assert.rejects(attempt({ tasks: [node('f', 'footage', { sourceAssetId: a.audio.id })], edges: [] }), { code: 'SOURCE_INVALID' });
});

test('上一镜成片作参考视频：必须固定成功版本，随后以 reference_video 提交', async () => {
 const w = 'v2-chain', a = await uploads(w);
 const project = await setup(w, [
  node('shot1', 'video', { prompt: '第一镜', params: { duration: 4, resolution: '480P' } }),
  node('p', 'image', { sourceAssetId: a.image.id }),
  node('shot2', 'video', { videoMode: 'reference', prompt: '延续 {{ref:shot1}}，人物 {{ref:p}}', params: { duration: 4, resolution: '480P' } }),
 ], [edge('shot1', 'shot2', 'refVideo', 'video'), edge('p', 'shot2', 'refImage', 'image')]);
 let p = await svc.preview(w, project.id, { taskIds: ['shot2'] });
 assert.deepEqual(p.scope.map(e => [e.taskId, e.action]), [['shot1', 'generate'], ['shot2', 'wait-input']]);
 const started = await startRun(w, project, p);
 await svc.tick(); await svc.tick();
 let detail = await svc.detail(w, project.id);
 const run1 = detail.runs.find(r => r.taskId === 'shot1' && r.status === 'succeeded');
 assert.ok(run1);
 await svc.update(w, project.id, { revision: detail.project.revision, tasks: detail.project.tasks.map(t => t.id === 'shot2' ? { ...t, sourceRunIds: [run1.id] } : t) });
 p = await svc.preview(w, project.id, { taskIds: ['shot2'] });
 const entry = p.scope.at(-1);
 assert.equal(entry.action, 'generate', entry.reason);
 assert.equal(entry.resolved.prompt, '延续 <Video 1>，人物 <Picture 1>');
 assert.deepEqual(entry.resolved.media.map(m => [m.role, m.runId === run1.id || m.runId === null]), [['reference_image', true], ['reference_video', true]]);
 await startRun(w, project, p);
 await svc.tick();
 assert.deepEqual(submissions().at(-1).body.content.map(e => e.role), [undefined, 'reference_image', 'reference_video']);
 assert.ok(started.runs.length === 1);
});

test('台词：none / lipsync 写入 <d> 段，post 不写入，超出时长只提醒不阻塞', async () => {
 const w = 'v2-dialogue';
 const dialogue = [{ text: '这款保温杯保温十二小时', language: 'zh' }, { text: 'Keeps drinks hot all day', language: 'en' }];
 const run = async (extra, duration = 5) => {
  const project = await setup(w, [node('v', 'video', { prompt: '手持保温杯', dialogue, params: { duration, resolution: '480P' }, ...extra })], []);
  return (await preview(w, project, 'v')).scope.at(-1);
 };
 const none = await run({});
 assert.equal(none.resolved.prompt, '手持保温杯\n<d>[Chinese] 这款保温杯保温十二小时</d>\n<d>[English] Keeps drinks hot all day</d>');
 assert.equal((await run({ dubMode: 'lipsync' })).resolved.prompt, none.resolved.prompt);
 const post = await run({ dubMode: 'post' });
 assert.equal(post.resolved.prompt, '手持保温杯');
 // 12 个中文字约 3 秒 + 5 个英文词约 2 秒 = 5 秒，4 秒时长超出
 assert.equal(none.dialogueWarning, undefined);
 const short = await run({}, 4);
 assert.match(short.dialogueWarning, /超过分镜时长 4 秒/);
 assert.equal(short.action, 'generate');
});

test('积分预估与余额：不足时阻塞并返回差额，查询失败不阻塞，余额充足可开始', async () => {
 const w = 'v2-points';
 const project = await setup(w, [node('v', 'video', { prompt: '一段', params: { duration: 4, resolution: '1080P' } })], []);
 app.state.balance = { total_points: 80, reserved_points: 20, available_points: 60 };
 let p = await preview(w, project, 'v');
 assert.equal(p.estimatedPoints, 76);
 assert.deepEqual(p.balance, { available: 60 });
 assert.equal(p.canStart, false);
 assert.equal(p.balanceShortfall, 16);
 assert.match(p.balanceReason, /积分不足.*76.*60.*16/);
 assert.equal(p.scope.at(-1).estimatedPoints, 76);
 app.state.balance = { total_points: 500, reserved_points: 0, available_points: 500 };
 p = await preview(w, project, 'v');
 assert.equal(p.canStart, true);
 assert.equal(p.balanceShortfall, undefined);
 // 余额接口失败（404）：balance 为 null，不阻塞
 app.state.balance = null;
 p = await preview(w, project, 'v');
 assert.equal(p.balance, null);
 assert.equal(p.canStart, true);
 assert.equal(p.estimatedPoints, 76);
 // 渠道自定义单价覆盖默认值
 const catalog = await app.hub.catalog();
 const h3 = catalog.channels.find(c => c.id === 'ch_0000000000000002');
 await app.hub.channels.update(h3.id, { executorConfig: { ...h3.executorConfig, pointPrices: { '1080P': 30 } } });
 try {
  p = await preview(w, project, 'v');
  assert.equal(p.estimatedPoints, 120);
 } finally { await app.hub.channels.update(h3.id, { executorConfig: h3.executorConfig }); }
 // 未写分辨率与时长时按 768P、5 秒
 const bare = await setup('v2-points-default', [node('v', 'video', { prompt: '默认' })], []);
 assert.equal((await preview('v2-points-default', bare, 'v')).estimatedPoints, 50);
});

test('start 在事务前检查余额：已知且不足时以 INSUFFICIENT_POINTS 拒绝，未知或充足时放行，重复请求不受影响', async () => {
 const w = 'v2-start-balance';
 const project = await setup(w, [node('v', 'video', { prompt: '余额检查', params: { duration: 4, resolution: '480P' } })], []);
 app.state.balance = { total_points: 500, reserved_points: 0, available_points: 500 };
 try {
 const p = await preview(w, project, 'v');
 assert.equal(p.canStart, true);
 // 预览之后余额被其他任务占用：start 必须拒绝，且不创建运行
 app.state.balance = { total_points: 500, reserved_points: 490, available_points: 10 };
 const key = randomUUID();
 await assert.rejects(svc.start(w, project.id, { ...p.selection, revision: p.revision, previewToken: p.previewToken, requestKey: key }), error => error.code === 'INSUFFICIENT_POINTS' && /积分不足.*20.*10.*10/.test(error.message));
 assert.equal((await svc.detail(w, project.id)).runs.length, 0);
 // 余额查询失败（接口 404）：放行
 app.state.balance = null;
 const started = await svc.start(w, project.id, { ...p.selection, revision: p.revision, previewToken: p.previewToken, requestKey: key });
 assert.equal(started.runs.length, 1);
 // 余额之后变得不足时，同一请求编号的重复提交仍然走幂等分支
 app.state.balance = { total_points: 5, reserved_points: 0, available_points: 5 };
 try {
  const replay = await svc.start(w, project.id, { ...p.selection, revision: p.revision, previewToken: p.previewToken, requestKey: key });
  assert.equal(replay.runs.length, 1);
 } finally { app.state.balance = null; }
 await svc.tick(); await svc.tick(); // 清空本用例排队的运行，避免被后续用例的 tick 提交
} finally { app.state.balance = null; }
});

test('超限素材：运行以 MEDIA_TOO_LARGE 失败并指出素材名称，且不提交', async () => {
 const w = 'v2-too-large';
 const image = await app.media.put(w, { bytes: app.png, name: '首帧.png', role: 'creative' });
 const big = await app.media.put(w, { bytes: Buffer.concat([mp4, Buffer.alloc(51 * 1024 * 1024)]), name: '超长动作.mp4', role: 'creative' });
 const project = await setup(w, [node('p', 'image', { sourceAssetId: image.id }), node('f', 'footage', { sourceAssetId: big.id }), node('v', 'video', { videoMode: 'reference', prompt: '动作参考 {{ref:f}}', params: { duration: 4, resolution: '480P' } })], [edge('p', 'v', 'refImage', 'image'), edge('f', 'v', 'refVideo', 'video')]);
 const p = await preview(w, project, 'v');
 assert.equal(p.scope.at(-1).action, 'generate');
 await startRun(w, project, p);
 const before = submissions().length;
 await svc.tick();
 const run = (await svc.detail(w, project.id)).runs[0];
 assert.equal(run.status, 'failed');
 assert.equal(run.error.code, 'MEDIA_TOO_LARGE');
 assert.match(run.error.message, /超长动作\.mp4/);
 assert.equal(submissions().length, before);
});

test('审核未通过（blocked）：运行失败，错误码 CONTENT_BLOCKED，保留平台原因而非通用文案', async () => {
 const w = 'v2-blocked';
 const project = await setup(w, [node('v', 'video', { prompt: '违规内容', params: { duration: 4, resolution: '480P' } })], []);
 await startRun(w, project, await preview(w, project, 'v'));
 await svc.tick();
 assert.equal((await svc.detail(w, project.id)).runs[0].status, 'running');
 app.state.taskStatus = 'blocked'; app.state.taskError = '提示词包含不允许的内容';
 try {
  await svc.tick();
  const run = (await svc.detail(w, project.id)).runs[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'CONTENT_BLOCKED');
  assert.match(run.error.message, /内容审核未通过：提示词包含不允许的内容/);
  assert.ok(!run.error.message.includes('供应商已确认失败'));
 } finally { app.state.taskStatus = 'succeeded'; app.state.taskError = null; }
});

test('moderating / scheduled 保持运行中，不会被当作失败', async () => {
 const w = 'v2-moderating';
 const project = await setup(w, [node('v', 'video', { prompt: '审核中', params: { duration: 4, resolution: '480P' } })], []);
 await startRun(w, project, await preview(w, project, 'v'));
 await svc.tick();
 for (const status of ['moderating', 'scheduled']) {
  app.state.taskStatus = status;
  await svc.tick();
  assert.equal((await svc.detail(w, project.id)).runs[0].status, 'running', status);
 }
 app.state.taskStatus = 'succeeded';
 await svc.tick();
 assert.equal((await svc.detail(w, project.id)).runs[0].status, 'succeeded');
});

test('旧单首帧运行兼容：仅有 sourceAssetId 的旧图仍按单张 first_frame 提交，且旧成功记录可复用', async () => {
 const w = 'v2-legacy';
 const source = await app.media.put(w, { bytes: app.png, name: '旧首帧.png', role: 'creative' });
 const { project } = await svc.create(w, {});
 const legacy = (await svc.update(w, project.id, { revision: project.revision, tasks: [{ ...project.tasks[0], kind: 'video', prompt: '旧版首帧视频', params: { duration: 5, resolution: '480P' }, sourceAssetId: source.id }] })).project;
 const p = await svc.preview(w, legacy.id, { taskIds: [legacy.tasks[0].id] });
 assert.equal(p.scope[0].action, 'generate', p.scope[0].reason);
 await startRun(w, legacy, p);
 await svc.tick();
 const body = submissions().at(-1).body;
 assert.deepEqual(body.content.map(e => [e.type, e.role]), [['text', undefined], ['image_url', 'first_frame']]);
 await svc.tick();
 assert.equal((await svc.detail(w, legacy.id)).runs[0].status, 'succeeded');
 assert.equal((await svc.preview(w, legacy.id, { taskIds: [legacy.tasks[0].id] })).scope[0].action, 'reuse');
 // 新图（非旧版）里没有 media / videoMode 的旧成功运行同样视为文生 / 首帧，可复用
 const w2 = 'v2-legacy-graph', t = await app.media.put(w2, { bytes: app.png, name: '首帧.png', role: 'creative' });
 const graph = await setup(w2, [node('i', 'image', { sourceAssetId: t.id }), node('v', 'video', { prompt: '旧图运行', params: { duration: 4, resolution: '480P' } })], [edge('i', 'v', 'first', 'image')]);
 const gp = await preview(w2, graph, 'v');
 assert.equal(gp.scope.at(-1).resolved.videoMode, 'frames');
 await startRun(w2, graph, gp);
 await svc.tick(); await svc.tick();
 const { rows } = await app.db.pool.query('SELECT id FROM sj_creation_runs WHERE workspace_id=$1', [w2]);
 await app.db.pool.query("UPDATE sj_creation_runs SET input=input-'media'-'videoMode'-'dubMode'-'dialogue' WHERE id=$1", [rows[0].id]);
 const reuse = await preview(w2, graph, 'v');
 assert.equal(reuse.scope.at(-1).action, 'reuse', reuse.scope.at(-1).reason);
});

test('模型中心 videoBalance / videoSkills：只对 H3 渠道生效，失败返回中文 502 且不含密钥', async () => {
 const h3 = 'ch_0000000000000002';
 app.state.balance = { total_points: 10.5, reserved_points: 0.5, available_points: 10 };
 assert.deepEqual(await app.hub.videoBalance(h3), { available: 10, reserved: 0.5, total: 10.5 });
 app.state.skills = [{ id: 'official-a', name: '电影叙事', description: '增强连续性', official: true }];
 assert.deepEqual(await app.hub.videoSkills(h3), [{ id: 'official-a', name: '电影叙事', description: '增强连续性', official: true }]);
 await assert.rejects(app.hub.videoBalance('ch_0000000000000001'), { code: 'MODEL_INCOMPATIBLE' });
 await assert.rejects(app.hub.videoSkills('ch_0000000000000009'), { code: 'CHANNEL_NOT_FOUND' });
 app.state.balance = null; app.state.skills = null;
 for (const call of [() => app.hub.videoBalance(h3), () => app.hub.videoSkills(h3)]) {
  await assert.rejects(call(), error => error.status === 502 && /[一-龥]/.test(error.message) && !error.message.includes('fixture-not-live') && !JSON.stringify(error).includes('fixture-not-live'));
 }
 // 经 HTTP 路由
 app.state.balance = { total_points: 8, reserved_points: 0, available_points: 8 };
 assert.deepEqual((await app.api('/api/model-hub/video/balance')).balance, { available: 8, reserved: 0, total: 8 });
 app.state.balance = null;
 await assert.rejects(app.api('/api/model-hub/video/balance'), { status: 502 });
});
