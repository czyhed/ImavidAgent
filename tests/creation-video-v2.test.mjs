import test from 'node:test';
import assert from 'node:assert/strict';
import { submitVideo, pollVideo, validateVideoGeneration, queryVideoBalance, queryVideoSkills } from '../server/providers/creation-video.mjs';
import { createMediaPrep, checkMediaLimits, buildImagePrepArgs, buildVideoPrepArgs } from '../server/media-prep.mjs';
import { CreationMedia } from '../server/creation-media.mjs';
import { validateProtocol } from '../server/channels.mjs';
import { estimateDialogueSeconds, dialoguePromptSuffix, pointPricesFor, DEFAULT_POINT_PRICES } from '../shared/creation-video-parameters.mjs';
import { routes as hubRoutes } from '../server/routes/model-hub.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(30)]);
const model = { modelId: 'MiniMax-H3', adapter: 'minimax-h3', executorConfig: { video: 'minimax-h3' } };
const channel = { baseUrl: 'https://cp.compshare.cn', apiKey: 'fake-key-not-real', adapter: 'minimax-h3' };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const item = (role, kind, extra = {}) => ({ role, kind, bytes: kind === 'image' ? png : kind === 'video' ? mp4 : mp3, mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg', name: role, ...extra });
const snap = (extra = {}) => ({ kind: 'video', model, prompt: '镜头缓慢推进', params: { duration: 5, resolution: '768P' }, requestKey: 'req-1', ...extra });
const capture = () => { const requests = []; return { requests, transport: async (url, options) => { requests.push({ url, options }); return json({ task_id: 'task-1' }); } }; };

test('content 按 media 顺序组装：text 在前，媒体带 role 与 Data URL', async () => {
 const c = capture();
 await submitVideo(c.transport, channel, snap({ videoMode: 'reference', media: [item('reference_image', 'image'), item('reference_video', 'video'), item('reference_audio', 'audio'), item('reference_image', 'image')], prompt: '<Picture 1> 与 <Video 1>' }));
 const body = JSON.parse(c.requests[0].options.body);
 assert.deepEqual(body.content.map(e => [e.type, e.role]), [['text', undefined], ['image_url', 'reference_image'], ['video_url', 'reference_video'], ['audio_url', 'reference_audio'], ['image_url', 'reference_image']]);
 assert.equal(body.content[0].text, '<Picture 1> 与 <Video 1>');
 assert.match(body.content[1].image_url.url, /^data:image\/png;base64,/);
 assert.match(body.content[2].video_url.url, /^data:video\/mp4;base64,/);
 assert.match(body.content[3].audio_url.url, /^data:audio\/mpeg;base64,/);
 assert.equal(c.requests[0].options.headers['Idempotency-Key'], 'req-1');
});

test('旧运行只有 sourceImage 时作为单张 first_frame 提交', async () => {
 const c = capture();
 await submitVideo(c.transport, channel, snap({ sourceImage: { bytes: png, mime: 'image/png' } }));
 const body = JSON.parse(c.requests[0].options.body);
 assert.equal(body.content.length, 2);
 assert.equal(body.content[1].role, 'first_frame');
});

test('四种方式校验：文生、首尾帧、参考素材与数量上限', () => {
 const bad = extra => assert.throws(() => validateVideoGeneration(snap(extra)), { code: 'INVALID_VIDEO_PARAMETERS' });
 const ok = extra => validateVideoGeneration(snap(extra));
 ok({ videoMode: 'text', media: [] });
 bad({ videoMode: 'text', media: [item('first_frame', 'image')] });
 bad({ videoMode: 'text', media: [], prompt: '  ' });
 ok({ videoMode: 'frames', media: [item('first_frame', 'image')], prompt: '' });
 ok({ videoMode: 'frames', media: [item('last_frame', 'image')] });
 ok({ videoMode: 'frames', media: [item('first_frame', 'image'), item('last_frame', 'image')] });
 bad({ videoMode: 'frames', media: [] });
 bad({ videoMode: 'frames', media: [item('first_frame', 'image'), item('reference_image', 'image')] });
 bad({ videoMode: 'frames', media: [item('first_frame', 'image'), item('first_frame', 'image')] });
 ok({ videoMode: 'reference', media: [item('reference_image', 'image'), item('reference_audio', 'audio')], prompt: '' });
 ok({ videoMode: 'reference', media: [item('reference_video', 'video')] });
 bad({ videoMode: 'reference', media: [item('reference_audio', 'audio')] });
 bad({ videoMode: 'reference', media: [] });
 bad({ videoMode: 'reference', media: [item('first_frame', 'image'), item('reference_image', 'image')] });
 bad({ videoMode: 'reference', media: Array.from({ length: 10 }, () => item('reference_image', 'image')) });
 bad({ videoMode: 'reference', media: [item('reference_image', 'image'), ...Array.from({ length: 4 }, () => item('reference_video', 'video'))] });
 bad({ videoMode: 'reference', media: [item('reference_image', 'image'), ...Array.from({ length: 4 }, () => item('reference_audio', 'audio'))] });
 // 9 + 3 + 3 个超过合计 12
 bad({ videoMode: 'reference', media: [...Array.from({ length: 9 }, () => item('reference_image', 'image')), ...Array.from({ length: 3 }, () => item('reference_video', 'video')), item('reference_audio', 'audio')] });
 // 自适应比例需要图片来源
 bad({ params: { ratio: 'adaptive' }, videoMode: 'text', media: [] });
 ok({ params: { ratio: 'adaptive' }, videoMode: 'frames', media: [item('first_frame', 'image')] });
 // 无效字节在执行前最后一道检查中拦截
 assert.throws(() => validateVideoGeneration(snap({ videoMode: 'frames', media: [item('first_frame', 'image', { bytes: Buffer.from('not-an-image') })] })), { code: 'INVALID_MEDIA' });
 assert.throws(() => validateVideoGeneration(snap({ videoMode: 'reference', media: [item('reference_image', 'image'), item('reference_audio', 'audio', { mime: 'video/mp4' })] })), { code: 'INVALID_SOURCE_MEDIA' });
});

test('状态映射：scheduled / moderating 为运行中，blocked 为 CONTENT_BLOCKED 并保留平台原因', async () => {
 const poll = task => pollVideo(async () => json({ task: { id: 't', ...task } }), channel, { model }, 't');
 assert.equal((await poll({ status: 'scheduled' })).status, 'running');
 assert.equal((await poll({ status: 'moderating' })).status, 'running');
 assert.equal((await poll({ status: 'queued' })).status, 'queued');
 assert.equal((await poll({ status: 'mystery' })).status, 'unknown');
 const blocked = await poll({ status: 'blocked', error: { message: '含敏感内容'.repeat(100) } });
 assert.equal(blocked.status, 'failed');
 assert.equal(blocked.error.code, 'CONTENT_BLOCKED');
 assert.match(blocked.error.message, /^内容审核未通过：含敏感内容/);
 assert.ok(blocked.error.message.length <= 320);
 assert.equal((await poll({ status: 'failed' })).error.code, 'PROVIDER_GENERATION_FAILED');
});

test('余额与 Skill 查询按文档字段解析，响应无效时报错', async () => {
 const seen = [];
 const balance = await queryVideoBalance(async url => { seen.push(url); return json({ total_points: 99.67, reserved_points: 0.33, available_points: 99.34 }); }, channel, model);
 assert.deepEqual(balance, { available: 99.34, reserved: 0.33, total: 99.67 });
 assert.equal(seen[0], 'https://cp.compshare.cn/minimax/v2/query/point_usage_summary');
 await assert.rejects(queryVideoBalance(async () => json({ oops: 1 }), channel, model), { code: 'PROVIDER_RESPONSE_INVALID' });
 const skills = await queryVideoSkills(async () => json({ items: [{ id: 'official-a', name: '电影叙事', description: '简介', content: '不返回', official: true }, { id: 'mine', name: '自定义' }], total: 2 }), channel, model);
 assert.deepEqual(skills, [{ id: 'official-a', name: '电影叙事', description: '简介', official: true }, { id: 'mine', name: '自定义', description: '', official: false }]);
});

test('台词包装、时长估算与积分单价默认值', () => {
 assert.equal(dialoguePromptSuffix([{ text: '你好', language: 'zh' }, { text: 'Hello <d>there</d>', language: 'en' }, { text: '  ', language: 'zh' }]), '<d>[Chinese] 你好</d>\n<d>[English] Hello there</d>');
 assert.equal(estimateDialogueSeconds([{ text: '一二三四五六七八', language: 'zh' }]), 2);
 assert.ok(estimateDialogueSeconds([{ text: 'one two three four five', language: 'en' }]) > 1);
 assert.deepEqual(pointPricesFor({}), DEFAULT_POINT_PRICES);
 assert.equal(pointPricesFor({ pointPrices: { '768P': 12 } })['768P'], 12);
 assert.equal(pointPricesFor({ pointPrices: { '768P': 12 } })['480P'], 5);
 validateProtocol('minimax-h3', { video: 'minimax-h3', pointPrices: { '480P': 6, '4K': 0 } });
 for (const pointPrices of [{ '720P': 5 }, { '480P': -1 }, { '480P': '5' }, [], null]) assert.throws(() => validateProtocol('minimax-h3', { pointPrices }), { code: 'INVALID_EXECUTOR' });
});

test('media-prep：用假 runner 处理图片 / 视频，音频原样，损坏图片放行给执行前校验', async () => {
 const calls = [];
 const runner = async input => { calls.push(input.kind); return { bytes: Buffer.from('prepared'), mime: input.kind === 'video' ? 'video/mp4' : input.mime }; };
 const prep = createMediaPrep({ runner });
 // 视频总是转码
 const video = await prep.prepare({ kind: 'video', bytes: mp4, mime: 'video/mp4', name: 'a.mp4' });
 assert.deepEqual([...video.bytes], [...Buffer.from('prepared')]);
 // 音频原样
 const audio = await prep.prepare({ kind: 'audio', bytes: mp3, mime: 'audio/mpeg', name: 'a.mp3' });
 assert.deepEqual([...audio.bytes], [...mp3]);
 // 损坏图片原样放行，不调用 runner
 const broken = await prep.prepare({ kind: 'image', bytes: Buffer.from('not-an-image'), mime: 'image/png', name: 'b.png' });
 assert.equal(broken.bytes.toString(), 'not-an-image');
 assert.deepEqual(calls, ['video']);
 // runner 失败向上抛出
 const failing = createMediaPrep({ runner: async () => { throw Object.assign(new Error('boom'), { code: 'MEDIA_PREP_FAILED' }); } });
 await assert.rejects(failing.prepare({ kind: 'video', bytes: mp4, mime: 'video/mp4', name: 'c.mp4' }), { code: 'MEDIA_PREP_FAILED' });
 assert.ok(buildVideoPrepArgs('in', 'out').join(' ').includes('fps=24'));
 assert.ok(buildImagePrepArgs('in', 'out', { width: 3000, height: 2000 }).join(' ').includes('scale=-2:1080'));
 assert.ok(buildImagePrepArgs('in', 'out', { width: 2000, height: 3000 }).join(' ').includes('scale=1080:-2'));
});

test('media-prep：单个上限与 72 MiB 总体积检查指出素材名称', () => {
 const big = (kind, mib, name) => ({ kind, bytes: Buffer.alloc(mib * 1024 * 1024), name });
 checkMediaLimits([big('image', 30, '大图.png'), big('video', 1, 'a.mp4')]);
 assert.throws(() => checkMediaLimits([big('image', 31, '超大图.png')]), error => error.code === 'MEDIA_TOO_LARGE' && error.message.includes('超大图.png'));
 assert.throws(() => checkMediaLimits([big('video', 51, '长视频.mp4')]), error => error.code === 'MEDIA_TOO_LARGE' && error.message.includes('长视频.mp4'));
 assert.throws(() => checkMediaLimits([big('audio', 16, '长音频.mp3')]), error => error.code === 'MEDIA_TOO_LARGE' && error.message.includes('长音频.mp3'));
 // 单个都合规，但 Data URL 总体积超过 72 MiB（base64 膨胀）
 assert.throws(() => checkMediaLimits([big('video', 50, '甲.mp4'), big('image', 30, '乙.png')]), error => error.code === 'MEDIA_TOO_LARGE' && error.message.includes('72 MiB') && error.message.includes('甲.mp4'));
});

function fakeMedia() {
 const created = [];
 const store = { create: async (workspace, kind, body, client, id) => { created.push(body); return { id, ...body }; }, pool: {} };
 const client = { putObject: async () => {}, listObjects: () => [], removeObject: async () => {} };
 const sql = { query: async () => ({ rows: [] }) };
 const media = new CreationMedia(store, client);
 return { created, put: (bytes, extra = {}) => media.put('w', { bytes, name: 'x', ...extra }, sql) };
}

test('上传识别 mp3 / wav / m4a 且不会把 m4a 误判为 mp4；音频上限 15 MiB', async () => {
 const m = fakeMedia();
 const ftyp = brand => Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftyp' + brand), Buffer.alloc(16)]);
 assert.equal((await m.put(mp3)).mime, 'audio/mpeg');
 assert.equal((await m.put(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))).mime, 'audio/mpeg');
 assert.equal((await m.put(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16)]))).mime, 'audio/wav');
 assert.equal((await m.put(ftyp('M4A '))).mime, 'audio/mp4');
 assert.equal((await m.put(ftyp('isom'))).mime, 'video/mp4');
 await assert.rejects(m.put(Buffer.concat([mp3, Buffer.alloc(15 * 1024 * 1024)])), { code: 'MEDIA_TOO_LARGE' });
 // 创作素材允许音频；资料与蒙版不允许
 assert.equal((await m.put(mp3, { role: 'creative' })).role, 'creative');
 await assert.rejects(m.put(mp3, { role: 'evidence' }), { code: 'INVALID_ATTACHMENT' });
 await assert.rejects(m.put(mp3, { role: 'mask', baseAssetId: 'x' }), { code: 'INVALID_MASK' });
});

test('素材列表 type=audio 按音频 MIME 前缀筛选', async () => {
 const assets = [{ id: 'a', kind: 'asset', role: 'creative', mime: 'audio/mpeg', name: 'a.mp3' }, { id: 'b', kind: 'asset', role: 'creative', mime: 'image/png', name: 'b.png' }, { id: 'c', kind: 'asset', role: 'creative', mime: 'video/mp4', name: 'c.mp4' }];
 const { routes } = await import('../server/routes/creation-assets.mjs');
 const list = routes().find(r => r.method === 'GET' && r.pattern.test('/api/creation/assets'));
 let reply;
 await list.handler({ ctx: { creationLifecycle: { store: { list: async () => assets } } }, url: new URL('http://x/api/creation/assets?type=audio'), res: {}, reply: (res, status, body) => { reply = body; } });
 assert.deepEqual(reply.items.map(a => a.id), ['a']);
});

test('GET /api/model-hub/video/balance 与 skills：默认渠道、指定渠道、角色校验与未配置提示', async () => {
 const routeFor = path => hubRoutes().find(r => r.pattern.test(path));
 const balanceRoute = routeFor('/api/model-hub/video/balance'), skillsRoute = routeFor('/api/model-hub/video/skills');
 assert.ok(balanceRoute && skillsRoute);
 const call = async (route, ctx, query = '') => { let out; await route.handler({ ctx, url: new URL('http://x/?' + query), res: {}, reply: (res, status, body) => { out = { status, body }; } }); return out; };
 const hub = { catalog: async () => ({ defaults: { video: { channelId: 'ch_0000000000000002' } } }), videoBalance: async id => ({ available: 10, reserved: 0, total: 10, id }), videoSkills: async () => [{ id: 's' }] };
 assert.deepEqual((await call(balanceRoute, { modelHub: hub })).body.balance.id, 'ch_0000000000000002');
 assert.deepEqual((await call(skillsRoute, { modelHub: hub }, 'channelId=ch_0000000000000009')).body.skills, [{ id: 's' }]);
 // viewer 无权访问（开启登录时）
 await assert.rejects(call(balanceRoute, { modelHub: hub, auth: {}, user: { role: 'viewer' } }), { code: 'FORBIDDEN' });
 await assert.rejects(call(skillsRoute, { modelHub: hub, auth: {} }), { code: 'UNAUTHENTICATED' });
 // 未配置默认视频模型
 await assert.rejects(call(balanceRoute, { modelHub: { ...hub, catalog: async () => ({ defaults: {} }) } }), { code: 'MODEL_NOT_CONFIGURED' });
});
