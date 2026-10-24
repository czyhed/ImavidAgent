import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVideoNode, tagSegments, videoConnectIssue, estimateVideoPoints, inferVideoMode, validateMediaFile, portsForMode } from '../web/src/lib/video-node.js';

const node = (id, kind, extra = {}) => ({ id, kind, title: id, prompt: '', params: {}, sourceAssetId: null, sourceRunId: null, ...extra });
const edge = (source, target, targetHandle) => ({ id: `${source}-${targetHandle}`, source, target, targetHandle });

test('方式推断：显式方式优先，旧节点有首帧连线为首尾帧，否则文字', () => {
 const tasks = [node('i', 'image'), node('v', 'video')];
 assert.equal(inferVideoMode(tasks[1], [], tasks), 'text');
 assert.equal(inferVideoMode(tasks[1], [edge('i', 'v', 'first')], tasks), 'frames');
 assert.equal(inferVideoMode(tasks[1], [{ id: 'x', source: 'i', target: 'v' }], tasks), 'frames');
 assert.equal(inferVideoMode({ ...tasks[1], videoMode: 'reference' }, [edge('i', 'v', 'first')], tasks), 'reference');
 assert.deepEqual(portsForMode('text'), ['prompt']);
 assert.deepEqual(portsForMode('frames'), ['prompt', 'first', 'last']);
 assert.deepEqual(portsForMode('reference'), ['prompt', 'refImage', 'refVideo', 'refAudio']);
});

test('素材编号与服务端一致：参考素材按端口顺序编号，首尾帧不编号，当前方式不用的连线单独列出', () => {
 const tasks = [node('p', 'image'), node('q', 'image'), node('s', 'audio'), node('f', 'footage'), node('v', 'video', { videoMode: 'reference' })];
 const edges = [edge('s', 'v', 'refAudio'), edge('q', 'v', 'refImage'), edge('p', 'v', 'refImage'), edge('f', 'v', 'refVideo'), edge('p', 'v', 'first')];
 const analysis = analyzeVideoNode(tasks[4], { edges, tasks });
 assert.deepEqual(analysis.items.map(i => [i.sourceTaskId, i.label]), [['q', 'Picture 1'], ['p', 'Picture 2'], ['f', 'Video 1'], ['s', 'Audio 1']]);
 assert.equal(analysis.refCount, 4);
 assert.deepEqual(analysis.unused.map(u => u.port), ['first']);
 const frames = analyzeVideoNode({ ...tasks[4], videoMode: 'frames' }, { edges, tasks });
 assert.deepEqual(frames.items.map(i => i.label), ['首帧']);
 assert.equal(frames.unused.length, 4);
});

test('标签预览：换算为编号；引用已移除素材或首尾帧素材时标红', () => {
 const tasks = [node('p', 'image'), node('v', 'video', { videoMode: 'reference' })];
 const analysis = analyzeVideoNode(tasks[1], { edges: [edge('p', 'v', 'refImage')], tasks });
 const parts = tagSegments('人物 {{ref:p}} 和 {{ref:gone}}', analysis);
 assert.deepEqual(parts.map(p => p.type === 'text' ? p.text : `${p.status}:${p.text}`), ['人物 ', 'ok:Picture 1', ' 和 ', 'removed:已移除的素材']);
 const frames = analyzeVideoNode({ ...tasks[1], videoMode: 'frames' }, { edges: [edge('p', 'v', 'first')], tasks });
 assert.equal(tagSegments('{{ref:p}}', frames)[0].status, 'frame');
});

test('连线上限：首尾帧各 1，参考图 9，视频 3，音频 3，参考合计 12', () => {
 const many = (count, handle) => Array.from({ length: count }, (_, i) => edge(`s${handle}${i}`, 'v', handle));
 const v = node('v', 'video');
 assert.match(videoConnectIssue(v, 'first', many(1, 'first'), []), /只能连接一条/);
 assert.equal(videoConnectIssue(v, 'refImage', many(8, 'refImage'), []), null);
 assert.match(videoConnectIssue(v, 'refImage', many(9, 'refImage'), []), /参考图片最多连接 9 个/);
 assert.match(videoConnectIssue(v, 'refVideo', many(3, 'refVideo'), []), /参考视频最多连接 3 个/);
 assert.match(videoConnectIssue(v, 'refAudio', many(3, 'refAudio'), []), /参考音频最多连接 3 个/);
 assert.match(videoConnectIssue(v, 'refVideo', [...many(8, 'refImage'), ...many(2, 'refVideo'), ...many(2, 'refAudio')], []), /合计最多 12 个/);
 // 只有参考音频等组合不在连线时拦截，交给预览判断
 assert.equal(videoConnectIssue(v, 'refAudio', [], []), null);
});

test('积分预估：渠道单价覆盖默认值，未填写时按 768P、5 秒', () => {
 assert.equal(estimateVideoPoints({ duration: 5, resolution: '480P' }), 25);
 assert.equal(estimateVideoPoints({ duration: 4, resolution: '1080P' }), 76);
 assert.equal(estimateVideoPoints({}), 50);
 assert.equal(estimateVideoPoints({ duration: 4, resolution: '1080P' }, { pointPrices: { '1080P': 30 } }), 120);
});

test('素材上传校验：类型与大小', () => {
 const file = (name, size, type = '') => ({ name, size, type });
 assert.equal(validateMediaFile('audio', file('a.mp3', 1000, 'audio/mpeg')).mime, 'audio/mpeg');
 assert.equal(validateMediaFile('audio', file('a.m4a', 1000)).mime, 'audio/mp4');
 assert.match(validateMediaFile('audio', file('a.ogg', 1000)).error, /仅支持 mp3 \/ wav \/ m4a/);
 assert.match(validateMediaFile('audio', file('a.mp3', 16 * 1024 * 1024)).error, /不能超过 15 MiB/);
 assert.equal(validateMediaFile('footage', file('a.webm', 1000, 'video/webm')).mime, 'video/webm');
 assert.match(validateMediaFile('footage', file('a.mov', 1000)).error, /仅支持 mp4 \/ webm/);
 assert.match(validateMediaFile('footage', file('a.mp4', 51 * 1024 * 1024)).error, /不能超过 50 MiB/);
 assert.match(validateMediaFile('audio', file('a.mp3', 1000, 'video/mp4')).error, /仅支持/);
});
