import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMaterial, detachMaterial, applyProjectSetting, shotIssues, buildPlaylist, studioSummary, moveItem, shotCustomKeys, shotParams, followProjectParams } from '../web/src/lib/video-studio.js';

let n = 0;
const uid = () => `id${++n}`;
const video = (id, extra = {}) => ({ id, workflowId: 'w', kind: 'video', title: id, prompt: '', params: {}, subject: 'concept', position: { x: 100, y: 900 }, sourceAssetId: null, sourceRunId: null, videoMode: 'reference', ...extra });
const gen = { id: 'g', workflowId: 'w', kind: 'generate', title: '主图', prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 }, sourceAssetId: null, sourceRunId: null };
const draft = (tasks, edges = [], storyboard = { script: '', shots: tasks.filter(t => t.kind === 'video').map(t => ({ id: `s-${t.id}`, nodeId: t.id, title: t.title })) }) => ({ tasks, edges, workflows: [{ id: 'w', title: 'W' }], storyboard });
const run = (id, taskId, extra = {}) => ({ id, taskId, status: 'succeeded', output: { assetId: `a-${id}` }, input: { kind: 'video' }, ...extra });

test('attaching an asset creates a studio-made input node above the shot plus an edge into the right port', () => {
  const d = draft([video('v')]);
  const { draft: next, nodeId, edgeId } = attachMaterial(d, [], { taskId: 'v', port: 'refImage', asset: { id: 'img1', name: '杯子.png' } }, uid);
  const node = next.tasks.find(t => t.id === nodeId);
  assert.deepEqual([node.kind, node.sourceAssetId, node.studioMade, node.workflowId], ['image', 'img1', true, 'w']);
  assert.ok(node.position.y < 900 && node.position.x === 100);
  assert.deepEqual(next.edges, [{ id: edgeId, source: nodeId, sourceHandle: 'image', target: 'v', targetHandle: 'refImage' }]);
  const audio = attachMaterial(next, [], { taskId: 'v', port: 'refAudio', asset: { id: 'au1', name: '旁白.mp3' } }, uid);
  assert.equal(audio.draft.tasks.find(t => t.id === audio.nodeId).kind, 'audio');
  assert.equal(audio.draft.edges.at(-1).sourceHandle, 'audio');
  const footage = attachMaterial(audio.draft, [], { taskId: 'v', port: 'refVideo', asset: { id: 'vi1', name: '动作.mp4' } }, uid);
  assert.deepEqual([footage.draft.tasks.find(t => t.id === footage.nodeId).kind, footage.draft.edges.at(-1).sourceHandle], ['footage', 'video']);
  assert.notEqual(footage.draft.tasks.find(t => t.id === footage.nodeId).position.y, node.position.y, 'inputs do not stack on top of each other');
});

test('single-image ports replace the old material and clear the shot-owned first frame / tail frame', () => {
  const d = draft([video('v', { videoMode: 'frames', sourceAssetId: 'old', tailFrame: { fromNodeId: 'p', runId: null, assetId: null } })]);
  let r = attachMaterial(d, [], { taskId: 'v', port: 'first', asset: { id: 'f1', name: '首帧.png' } }, uid);
  const t = r.draft.tasks.find(x => x.id === 'v');
  assert.deepEqual([t.sourceAssetId, t.sourceRunId, t.tailFrame], [null, null, null]);
  r = attachMaterial(r.draft, [], { taskId: 'v', port: 'first', asset: { id: 'f2', name: '新首帧.png' } }, uid);
  assert.equal(r.draft.edges.filter(e => e.targetHandle === 'first').length, 1, 'one first frame only');
  assert.equal(r.draft.tasks.filter(x => x.kind === 'image').length, 1, 'the replaced studio-made node is removed');
  assert.equal(r.draft.tasks.find(x => x.kind === 'image').sourceAssetId, 'f2');
});

test('port limits are enforced with the canvas wording', () => {
  let d = draft([video('v')]);
  for (let i = 0; i < 9; i += 1) d = attachMaterial(d, [], { taskId: 'v', port: 'refImage', asset: { id: `i${i}`, name: 'x' } }, uid).draft;
  const full = attachMaterial(d, [], { taskId: 'v', port: 'refImage', asset: { id: 'extra', name: 'x' } }, uid);
  assert.match(full.error, /最多连接 9 个/);
  assert.equal(attachMaterial(draft([video('v')]), [], { taskId: 'missing', port: 'refImage', asset: { id: 'x', name: 'x' } }, uid).error, '分镜节点不存在。');
});

test('attaching a canvas result connects the producing node and pins that exact successful version', () => {
  const runs = [run('r1', 'g', { input: { kind: 'image' } }), run('r2', 'g', { input: { kind: 'image' } })];
  const d = draft([gen, video('v')]);
  const first = attachMaterial(d, runs, { taskId: 'v', port: 'refImage', run: runs[0] }, uid);
  assert.deepEqual(first.draft.tasks.find(t => t.id === 'v').sourceRunIds, ['r1']);
  assert.deepEqual(first.draft.edges.map(e => [e.source, e.sourceHandle, e.targetHandle]), [['g', 'image', 'refImage']]);
  assert.equal(first.draft.tasks.length, 2, 'no new node for canvas results');
  // 换用同一来源的另一个版本：不新增连线，只更换固定版本。
  const second = attachMaterial(first.draft, runs, { taskId: 'v', port: 'refImage', run: runs[1] }, uid);
  assert.equal(second.draft.edges.length, 1);
  assert.deepEqual(second.draft.tasks.find(t => t.id === 'v').sourceRunIds, ['r2']);
  // 类型不匹配、来自自己、失败的版本都拒绝。
  assert.match(attachMaterial(d, runs, { taskId: 'v', port: 'refVideo', run: runs[0] }, uid).error, /视频/);
  assert.match(attachMaterial(d, [run('x', 'v')], { taskId: 'v', port: 'refVideo', run: run('x', 'v') }, uid).error, /自己的结果|循环/);
  assert.match(attachMaterial(d, runs, { taskId: 'v', port: 'refImage', run: { ...runs[0], status: 'failed' } }, uid).error, /不可用/);
});

test('a canvas result that would create a cycle is rejected', () => {
  const a = video('a'), b = video('b');
  const d = draft([a, b], [{ id: 'e', source: 'a', sourceHandle: 'video', target: 'b', targetHandle: 'refVideo' }]);
  const r = attachMaterial(d, [run('ra', 'a')], { taskId: 'a', port: 'refVideo', run: run('rb', 'b') }, uid);
  assert.match(r.error, /循环/);
});

test('detaching removes the edge, its pin and the unused studio-made node only when it has no history', () => {
  const runs = [run('r1', 'g', { input: { kind: 'image' } })];
  let d = draft([gen, video('v')]);
  d = attachMaterial(d, runs, { taskId: 'v', port: 'refImage', run: runs[0] }, uid).draft;
  d = attachMaterial(d, runs, { taskId: 'v', port: 'refImage', asset: { id: 'i', name: 'a.png' } }, uid).draft;
  const assetEdge = d.edges.find(e => e.source !== 'g'), runEdge = d.edges.find(e => e.source === 'g');
  const afterAsset = detachMaterial(d, runs, assetEdge.id);
  assert.equal(afterAsset.tasks.some(t => t.studioMade), false, 'unused studio-made node removed');
  assert.deepEqual(afterAsset.tasks.find(t => t.id === 'v').sourceRunIds, ['r1']);
  const afterRun = detachMaterial(afterAsset, runs, runEdge.id);
  assert.deepEqual(afterRun.tasks.find(t => t.id === 'v').sourceRunIds, []);
  assert.ok(afterRun.tasks.some(t => t.id === 'g'), 'canvas nodes are never removed');
  // 节点有生成记录、或还被别的节点使用时保留。
  const kept = detachMaterial(d, [...runs, run('rx', assetEdge.source)], assetEdge.id);
  assert.ok(kept.tasks.some(t => t.id === assetEdge.source));
  const shared = { ...d, edges: [...d.edges, { id: 'other', source: assetEdge.source, sourceHandle: 'image', target: 'g', targetHandle: 'ref' }] };
  assert.ok(detachMaterial(shared, runs, assetEdge.id).tasks.some(t => t.id === assetEdge.source));
  // 不是工作台创建的输入节点不删除。
  const manual = { ...d, tasks: d.tasks.map(t => t.id === assetEdge.source ? { ...t, studioMade: undefined } : t) };
  assert.ok(detachMaterial(manual, runs, assetEdge.id).tasks.some(t => t.id === assetEdge.source));
});

test('project settings: writes all three keys and strips shot values that merely repeat the old or new value', () => {
  const d = draft([video('a', { params: { duration: 5, resolution: '768P', ratio: '9:16' } }), video('b', { params: { duration: 8, resolution: '480P', ratio: '9:16' } }), video('c', { params: { resolution: '768P' } })]);
  const next = applyProjectSetting(d, 'resolution', '1080P');
  assert.deepEqual(next.storyboard.settings, { resolution: '1080P', ratio: '9:16', duration: 5 });
  assert.deepEqual(next.tasks.find(t => t.id === 'a').params, { duration: 5, ratio: '9:16' }, 'followed the old default, so now follows the project');
  assert.deepEqual(next.tasks.find(t => t.id === 'b').params, { duration: 8, resolution: '480P', ratio: '9:16' }, 'real override stays');
  assert.deepEqual(shotCustomKeys(next.storyboard, next.tasks.find(t => t.id === 'b')), ['resolution', 'duration']);
  assert.deepEqual(shotCustomKeys(next.storyboard, next.tasks.find(t => t.id === 'a')), []);
  assert.deepEqual(shotParams(next.storyboard, next.tasks.find(t => t.id === 'a')), { resolution: '1080P', ratio: '9:16', duration: 5 });
  // 运行中的节点原样保留。
  assert.deepEqual(applyProjectSetting(d, 'resolution', '1080P', new Set(['a'])).tasks.find(t => t.id === 'a').params, d.tasks[0].params);
  assert.deepEqual(followProjectParams(d.tasks[1], ['resolution']), { duration: 8, ratio: '9:16' });
});

test('issues: missing material per mode, tail waiting, deleted assets, dub state and last failure', () => {
  const img = { id: 'img', workflowId: 'w', kind: 'image', title: '图', prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 }, sourceAssetId: 'gone', sourceRunId: null };
  const base = { assets: [], assetsLoaded: true, runs: [], dub: null, shotInfo: null };
  const labels = args => shotIssues(args).map(i => i.label);
  const frames = video('v', { videoMode: 'frames' });
  assert.deepEqual(labels({ ...base, task: frames, tasks: [frames], edges: [] }), ['缺少首帧或尾帧']);
  const ref = video('r');
  assert.deepEqual(labels({ ...base, task: ref, tasks: [ref], edges: [] }), ['缺少参考图或参考视频']);
  assert.deepEqual(labels({ ...base, task: video('t', { videoMode: 'text' }), tasks: [], edges: [] }), []);
  // 引用的素材已删除（素材库里没有）；素材未加载完时不误报。
  const edges = [{ id: 'e', source: 'img', sourceHandle: 'image', target: 'r', targetHandle: 'refImage' }];
  assert.deepEqual(labels({ ...base, task: ref, tasks: [ref, img], edges }), ['引用的素材已删除']);
  assert.deepEqual(labels({ ...base, assetsLoaded: false, task: ref, tasks: [ref, img], edges }), []);
  assert.deepEqual(labels({ ...base, assets: [{ id: 'gone' }], task: ref, tasks: [ref, img], edges }), []);
  assert.deepEqual(labels({ ...base, assets: [{ id: 'gone', trashedAt: 'x' }], task: ref, tasks: [ref, img], edges }), ['引用的素材已删除']);
  // 提示词标签指向已移除的素材。
  const tagged = video('r', { prompt: '看 {{ref:missing}}' });
  assert.ok(labels({ ...base, task: tagged, tasks: [tagged, img], edges }).includes('提示词引用了已移除的素材'));
  // 等待上一镜尾帧 / 尾帧待截取 / 上一镜已更新。
  const tail = video('v', { videoMode: 'frames', tailFrame: { fromNodeId: 'p', runId: null, assetId: null } });
  assert.deepEqual(labels({ ...base, task: tail, tasks: [tail], edges: [], shotInfo: { prevStatus: 'idle' } }), ['等待上一镜']);
  assert.deepEqual(labels({ ...base, task: tail, tasks: [tail], edges: [], shotInfo: { prevStatus: 'succeeded' } }), ['尾帧待截取']);
  const have = video('v', { videoMode: 'frames', tailFrame: { fromNodeId: 'p', runId: 'r', assetId: 'a' } });
  assert.deepEqual(labels({ ...base, assets: [{ id: 'a' }], task: have, tasks: [have], edges: [], shotInfo: { stale: true } }), ['上一镜已更新']);
  assert.deepEqual(labels({ ...base, task: have, tasks: [have], edges: [], shotInfo: { stale: true } }), ['上一镜已更新', '引用的素材已删除'], 'a tail frame whose asset is gone is flagged too');
  // 配音：未合成 / 已过期 / 混音失败 / 待混音；不配音的不提示。
  const dubbed = video('d', { videoMode: 'text', dubMode: 'post', dialogue: [{ text: '你好', language: 'zh' }] });
  const dubLabels = dub => labels({ ...base, task: dubbed, tasks: [dubbed], edges: [], dub });
  assert.deepEqual(dubLabels(null), ['配音未合成']);
  assert.deepEqual(dubLabels({ status: 'stale' }), ['配音已过期']);
  assert.deepEqual(dubLabels({ status: 'fresh', dub: { status: 'failed' } }), ['混音失败']);
  assert.deepEqual(dubLabels({ status: 'fresh', needsMix: true }), ['配音待混音']);
  assert.deepEqual(dubLabels({ status: 'fresh' }), []);
  assert.deepEqual(labels({ ...base, task: { ...dubbed, dubMode: 'none' }, tasks: [], edges: [], dub: null }), []);
  // 上次失败；之后成功就不再提示。
  const plain = video('p', { videoMode: 'text' });
  assert.deepEqual(shotIssues({ ...base, task: plain, tasks: [plain], edges: [], runs: [{ id: 'x', taskId: 'p', status: 'failed' }] }).map(i => [i.kind, i.section]), [['failed', 'preview']]);
  assert.deepEqual(labels({ ...base, task: plain, tasks: [plain], edges: [], runs: [{ id: 'x', taskId: 'p', status: 'failed' }, run('y', 'p')] }), []);
});

test('playlist follows shot order, prefers the fresh dub of the shown run, and summary counts only unfinished shots for cost', () => {
  const tasks = [video('a', { params: { duration: 6 } }), video('b'), video('c')];
  const storyboard = { shots: tasks.map(t => ({ id: `s-${t.id}`, nodeId: t.id, title: t.id })), settings: { duration: 4, resolution: '480P' } };
  const runs = [run('r1', 'a'), run('r2', 'a'), run('r3', 'c')];
  const dubState = id => id === 'a' ? { dub: { runId: 'r2', assetId: 'dub-a' } } : id === 'c' ? { dub: { runId: 'other', assetId: 'dub-c' } } : null;
  const list = buildPlaylist({ shots: storyboard.shots, tasks, runs, storyboard, dubState, displayRuns: {} });
  assert.deepEqual(list.map(i => [i.shotId, i.src, i.duration]), [['s-a', 'dub-a', 6], ['s-b', null, 4], ['s-c', 'a-r3', 4]]);
  const picked = buildPlaylist({ shots: storyboard.shots, tasks, runs, storyboard, dubState, displayRuns: { a: 'r1' } });
  assert.equal(picked[0].src, 'a-r1', 'the chosen older version has no matching dub, so the original plays');
  const sum = studioSummary({ shots: storyboard.shots, tasks, runs, storyboard });
  assert.deepEqual([sum.count, sum.seconds, sum.pending, sum.points], [3, 14, 1, 20], 'only shot b is pending: 480P 5 x 4s');
});

test('moveItem reorders without mutating', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(list, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(list, 3, 0), ['d', 'a', 'b', 'c']);
  assert.equal(moveItem(list, 1, 1), list);
  assert.equal(moveItem(list, 1, 9), list);
  assert.deepEqual(list, ['a', 'b', 'c', 'd']);
});
