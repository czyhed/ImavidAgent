import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCreationApp } from './creation-app-fixture.mjs';

// 假语音 transport + 假 ffmpeg runner + 真实 PostgreSQL / ModelHub；不调用任何真实接口。
let app, svc;
const SECRET = 'volc-test-key-never-real-1234';
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
test.before(async () => { app = await startCreationApp({ autoTick: false }); svc = app.projects; });
test.after(async () => { await app?.stop(); });

const node = (id, kind, extra = {}) => ({ id, kind, title: id, prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 }, sourceAssetId: null, sourceRunId: null, ...extra });
const edge = (source, target, targetHandle, sourceHandle) => ({ id: `${source}-${target}-${targetHandle || 'x'}`, source, target, sourceHandle, targetHandle });
const ROLES = [{ id: 'narrator', name: '旁白', speaker: 'zh_female_vv_uranus_bigtts' }, { id: 'host', name: '主播', speaker: 'zh_male_m191_uranus_bigtts', speechRate: 10 }];
const LINES = [{ text: '这款保温杯保温十二小时', language: 'zh', roleId: 'narrator' }, { text: '现在下单立减二十元', language: 'zh', roleId: 'host' }];
const voiceCalls = () => app.voiceCalls.filter(c => c.path.endsWith('/unidirectional'));
const submissions = () => app.calls.filter(c => c.method === 'POST' && c.path.endsWith('/minimax/v2/video_generation'));
async function setup(workspace, tasks, edges, extra = {}) {
 const { project } = await svc.create(workspace, {});
 return (await svc.update(workspace, project.id, { revision: project.revision, tasks, edges, voiceRoles: ROLES, ...extra })).project;
}
const latest = async (workspace, id) => (await svc.detail(workspace, id)).project;
const preview = (workspace, project, taskId) => svc.preview(workspace, project.id, { taskIds: [taskId] });
async function run(workspace, project, taskId) {
 const p = await preview(workspace, project, taskId);
 assert.equal(p.scope.at(-1).action, 'generate', p.scope.at(-1).reason);
 await svc.start(workspace, project.id, { ...p.selection, revision: p.revision, previewToken: p.previewToken, requestKey: randomUUID() });
 await svc.tick(); await svc.tick();
 return (await svc.detail(workspace, project.id)).runs.filter(r => r.taskId === taskId).at(-1);
}
async function modelHub(path, body, method = 'POST') {
 const etag = (await fetch(app.origin + '/api/model-hub')).headers.get('etag');
 const response = await fetch(app.origin + '/api/model-hub' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.csrf, 'If-Match': etag }, body: JSON.stringify(body) });
 const parsed = await response.json();
 return { status: response.status, body: parsed, text: JSON.stringify(parsed) };
}

test('未配置语音渠道：配音前置条件提示去模型中心，试听与合成报中文错误，音色库仍可浏览', async () => {
 const w = 'voice-unconfigured';
 const project = await setup(w, [node('v', 'video', { prompt: '手持保温杯', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })], []);
 const p = await preview(w, project, 'v');
 assert.equal(p.scope.at(-1).action, 'blocked');
 assert.match(p.scope.at(-1).reason, /语音渠道未配置.*模型中心/);
 assert.equal(await svc.voice.configured(), false);
 await assert.rejects(svc.voice.preview(w, { speaker: 'zh_female_vv_uranus_bigtts' }), /请先在模型中心配置火山引擎语音渠道/);
 await assert.rejects(svc.voiceDialogue(w, project.id, { taskId: 'v' }), /请先在模型中心配置火山引擎语音渠道/);
 const list = await app.api('/api/creation/voices?gender=female&scene=' + encodeURIComponent('客服场景'));
 assert.equal(list.configured, false);
 assert.ok(list.voices.length > 0 && list.voices.every(v => v.gender === 'female' && v.scenes.includes('客服场景')));
 assert.equal(voiceCalls().length, 0);
});

test('新增火山语音渠道：密钥只显示末四位、地址固定、默认指向该渠道、连接测试不合成', async () => {
 const created = await modelHub('/channels', { name: '火山语音', adapter: 'volcengine-tts', baseUrl: 'https://attacker.example', apiKey: SECRET, executorConfig: { resourceId: 'seed-tts-2.0' } });
 assert.equal(created.status, 201, created.text);
 const channel = created.body.channel;
 assert.equal(channel.adapter, 'volcengine-tts');
 assert.equal(channel.baseUrl, 'https://openspeech.bytedance.com', '地址固定，不接受自定义');
 assert.equal(channel.keyHint, '••••1234');
 assert.ok(!created.text.includes(SECRET) && !created.text.includes('volc-test-key'), '响应不含完整密钥');
 const catalog = await (await fetch(app.origin + '/api/model-hub')).json();
 assert.ok(!JSON.stringify(catalog).includes('volc-test-key'));
 assert.deepEqual(catalog.defaults.voice, { channelId: channel.id, modelId: 'voice' });
 assert.deepEqual(catalog.channels.find(c => c.id === channel.id).executorConfig, { resourceId: 'seed-tts-2.0' });
 const before = voiceCalls().length;
 const tested = await modelHub(`/channels/${channel.id}/test`, {});
 assert.equal(tested.status, 200); assert.match(tested.body.message, /不调用合成/); assert.equal(voiceCalls().length, before);
 assert.ok(!tested.text.includes('volc-test-key'));
 assert.equal((await modelHub(`/channels/${channel.id}/sync`, {})).status, 422, '没有模型目录可同步');
 const bad = await modelHub('/channels', { name: '坏渠道', adapter: 'volcengine-tts', apiKey: SECRET, executorConfig: { resourceId: 'bogus' } });
 assert.equal(bad.status, 422);
 // 编辑与停用：停用后语音不可用，启用后恢复；密钥留空保留。
 const edited = await modelHub(`/channels/${channel.id}`, { name: '火山语音（改）', executorConfig: { resourceId: 'seed-icl-2.0' } }, 'PATCH');
 assert.equal(edited.body.channel.keyHint, '••••1234'); assert.equal(edited.body.channel.executorConfig.resourceId, 'seed-icl-2.0');
 await modelHub(`/channels/${channel.id}`, { executorConfig: { resourceId: 'seed-tts-2.0' } }, 'PATCH');
 await modelHub(`/channels/${channel.id}`, { enabled: false }, 'PATCH');
 assert.equal(await svc.voice.configured(), false);
 await modelHub(`/channels/${channel.id}`, { enabled: true }, 'PATCH');
 assert.equal(await svc.voice.configured(), true);
});

test('试听：按音色 + 文本 + 参数缓存为 voice 素材，重复请求不再调用接口，素材库默认列表不显示', async () => {
 const w = 'local';
 const before = voiceCalls().length;
 const first = await app.api('/api/creation/voice/preview', { speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', params: { speechRate: 10 } });
 assert.equal(first.cached, false); assert.equal(voiceCalls().length, before + 1);
 assert.match(first.fileUrl, /^\/api\/creation\/assets\/[\w-]+\/file$/);
 assert.equal(first.textWords, [...first.text].length);
 const call = voiceCalls().at(-1);
 assert.equal(call.headers['X-Api-Key'], SECRET);
 assert.equal(call.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
 assert.equal(call.body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
 assert.equal(call.body.req_params.audio_params.speech_rate, 10);
 const second = await app.api('/api/creation/voice/preview', { speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', params: { speechRate: 10 } });
 assert.equal(second.cached, true); assert.equal(second.assetId, first.assetId); assert.equal(voiceCalls().length, before + 1, '命中缓存，没有再调用接口');
 const other = await app.api('/api/creation/voice/preview', { speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', params: { speechRate: 20 } });
 assert.equal(other.cached, false, '参数不同视为不同试听');
 const custom = await app.api('/api/creation/voice/preview', { speaker: 'zh_male_m191_uranus_bigtts', text: '自定义试听文本', params: {} });
 assert.equal(custom.textWords, 7);
 await Promise.all([1, 2].map(() => app.api('/api/creation/voice/preview', { speaker: 'zh_male_m191_uranus_bigtts', text: '并发试听', params: {} })));
 assert.equal(voiceCalls().filter(c => c.body.req_params.text === '并发试听').length, 1, '并发的相同试听只合成一次');
 const file = await fetch(app.origin + first.fileUrl); assert.equal(file.headers.get('content-type'), 'audio/mpeg');
 const assets = (await app.api('/api/creation/assets')).items;
 assert.ok(!assets.some(a => a.role === 'voice'), '默认素材列表不含 voice');
 assert.ok((await app.api('/api/creation/assets?role=voice')).items.some(a => a.id === first.assetId));
 await assert.rejects(app.api('/api/creation/voice/preview', { speaker: 'bad speaker', params: {} }), /有效的音色/);
 await assert.rejects(app.api('/api/creation/voice/preview', { speaker: 'zh_male_m191_uranus_bigtts', text: 'x'.repeat(201), params: {} }), /不超过 200/);
 void w;
});

test('字符用量写入用量记录：stage voice，text_words 字符数，不换算金额', async () => {
 const usage = (await app.hub.usage('local')).filter(u => u.stage === 'voice');
 assert.ok(usage.length >= 3);
 assert.ok(usage.every(u => Number.isFinite(u.usage.text_words) && u.usage.costMicros === null && u.usage.currency === null));
 const overview = await app.api('/api/creation/overview');
 const row = overview.modelUsage.find(u => u.stage === 'voice');
 assert.ok(row && row.usage.text_words > 0 && row.costMicros === null);
 assert.ok(!JSON.stringify(overview).includes('volc-test-key'));
});

test('音色设计：返回状态与剩余次数，试听转存为 voice 素材，次数用尽给中文提示', async () => {
 const before = app.state.designRemaining;
 const result = await app.api('/api/creation/voice/design', { speakerId: 'S_design_001', text: '大家好，欢迎光临本店。', textPrompt: '温柔的年轻女声', language: 0 });
 assert.equal(result.status, 2); assert.equal(result.usable, true); assert.equal(result.remaining, before - 1); assert.equal(result.resourceId, 'seed-icl-2.0');
 assert.match(result.demo.fileUrl, /\/api\/creation\/assets\/.+\/file/);
 const demo = await fetch(app.origin + result.demo.fileUrl); assert.equal(Buffer.from(await demo.arrayBuffer()).toString(), 'ID3demo');
 const sent = app.voiceCalls.filter(c => c.path.endsWith('/voice_design')).at(-1);
 assert.equal(sent.headers['X-Api-Key'], SECRET);
 assert.deepEqual(sent.body.prompt, { text_prompt: '温柔的年轻女声' });
 // 人物图方式
 const image = await app.media.put('local', { bytes: app.png, name: '人物.png', role: 'creative' });
 await app.api('/api/creation/voice/design', { speakerId: 'S_design_002', text: 'Hello', imageAssetId: image.id, language: 1 });
 const withImage = app.voiceCalls.filter(c => c.path.endsWith('/voice_design')).at(-1).body;
 assert.equal(withImage.language, 1); assert.equal(withImage.prompt.image_prompt.image_bytes, app.png.toString('base64'));
 app.state.designRemaining = 0;
 await assert.rejects(app.api('/api/creation/voice/design', { speakerId: 'S_design_003', text: 'a', textPrompt: 'b' }), /设计次数已用尽/);
 app.state.designRemaining = 10;
 await assert.rejects(app.api('/api/creation/voice/design', { speakerId: 'bad id', text: 'a', textPrompt: 'b' }), /音色编号/);
});

test('项目角色：保存校验，非法角色被拒绝，语速超范围被拒绝', async () => {
 const w = 'voice-roles';
 const project = await setup(w, [node('v', 'video', { prompt: 'x', params: { duration: 5 } })], []);
 assert.deepEqual(project.voiceRoles.map(r => [r.id, r.speaker, r.resourceId, r.speechRate]), [['narrator', 'zh_female_vv_uranus_bigtts', 'seed-tts-2.0', 0], ['host', 'zh_male_m191_uranus_bigtts', 'seed-tts-2.0', 10]]);
 await assert.rejects(svc.update(w, project.id, { revision: project.revision, voiceRoles: [{ id: 'x', name: '坏', speaker: '有 空格' }] }), /音色编号/);
 await assert.rejects(svc.update(w, project.id, { revision: project.revision, voiceRoles: [{ id: 'x', name: '快', speaker: 'abc', speechRate: 500 }] }), /语速/);
 const updated = (await svc.update(w, project.id, { revision: project.revision, voiceRoles: [{ id: 'designed', name: '设计', speaker: 'S_design_001', source: 'designed' }] })).project;
 assert.equal(updated.voiceRoles[0].resourceId, 'seed-icl-2.0');
});

test('合成配音：写入 dialogueAudio 与哈希，台词或角色改动后过期，客户端不能伪造 dialogueAudio', async () => {
 const w = 'voice-dialogue';
 const project = await setup(w, [node('v', 'video', { prompt: '手持保温杯', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })], []);
 const before = voiceCalls().length, joinsBefore = app.audioRunner.state.joins.length;
 const synthesized = await svc.voiceDialogue(w, project.id, { taskId: 'v', revision: project.revision });
 const calls = voiceCalls().slice(before);
 assert.equal(calls.length, 2, '每行一次合成');
 assert.deepEqual(calls.map(c => c.body.req_params.speaker), ['zh_female_vv_uranus_bigtts', 'zh_male_m191_uranus_bigtts']);
 assert.equal(calls[1].body.req_params.audio_params.speech_rate, 10);
 assert.equal(app.audioRunner.state.joins.at(-1), 2); assert.equal(app.audioRunner.state.joins.length, joinsBefore + 1);
 const task = synthesized.project.tasks.find(t => t.id === 'v');
 assert.match(task.dialogueAudio.hash, /^[0-9a-f]{64}$/);
 assert.equal(task.dialogueAudio.durationSec, 3.2);
 assert.equal(task.dialogueAudio.textWords, [...LINES[0].text].length + [...LINES[1].text].length);
 assert.equal(synthesized.project.revision, project.revision, '不递增修订号，不打断画布自动保存');
 assert.equal(synthesized.dubStates.v.status, 'fresh');
 const asset = await app.store.get(w, task.dialogueAudio.assetId);
 assert.equal(asset.role, 'voice'); assert.equal(asset.mime, 'audio/mpeg');
 // 改台词 → 过期
 const edited = (await svc.update(w, project.id, { revision: synthesized.project.revision, tasks: synthesized.project.tasks.map(t => t.id === 'v' ? { ...t, dialogue: [{ ...LINES[0], text: '这款保温杯保温二十四小时' }, LINES[1]] } : t) })).project;
 assert.equal(edited.tasks[0].dialogueAudio.hash, task.dialogueAudio.hash, '更新节点不会清除或改写已有配音');
 assert.equal((await svc.detail(w, project.id)).dubStates.v.status, 'stale');
 const blocked = await preview(w, edited, 'v');
 assert.equal(blocked.scope.at(-1).action, 'blocked'); assert.equal(blocked.scope.at(-1).reason, '配音已过期，请重新合成台词配音。');
 // 改角色参数同样过期；改回去恢复
 const reverted = (await svc.update(w, project.id, { revision: edited.revision, tasks: edited.tasks.map(t => t.id === 'v' ? { ...t, dialogue: LINES } : t) })).project;
 assert.equal((await svc.detail(w, project.id)).dubStates.v.status, 'fresh');
 const rolesChanged = (await svc.update(w, project.id, { revision: reverted.revision, voiceRoles: ROLES.map(r => r.id === 'host' ? { ...r, speechRate: 30 } : r) })).project;
 assert.equal((await svc.detail(w, project.id)).dubStates.v.status, 'stale');
 assert.equal(rolesChanged.tasks[0].dialogueAudio.hash, task.dialogueAudio.hash);
 // 客户端伪造的 dialogueAudio 被忽略；复制出的新节点没有配音
 const forged = (await svc.update(w, project.id, { revision: rolesChanged.revision, tasks: [...rolesChanged.tasks.map(t => ({ ...t, dialogueAudio: { assetId: randomUUID(), hash: 'forged', durationSec: 1 } })), node('copy', 'video', { dialogue: LINES, dialogueAudio: { assetId: randomUUID(), hash: 'forged', durationSec: 1 } })] })).project;
 assert.equal(forged.tasks.find(t => t.id === 'v').dialogueAudio.hash, task.dialogueAudio.hash);
 assert.equal(forged.tasks.find(t => t.id === 'copy').dialogueAudio, undefined);
 // 缺角色 / 未配置音色 / 过长都给出中文原因，且不调用接口
 const calls2 = voiceCalls().length;
 const noRole = await setup(w + '-b', [node('v', 'video', { dialogue: [{ text: '没有角色', language: 'zh' }] })], []);
 await assert.rejects(svc.voiceDialogue(w + '-b', noRole.id, { taskId: 'v' }), /还没有选择角色/);
 const long = await setup(w + '-c', [node('v', 'video', { dialogue: [{ text: '长'.repeat(2000), language: 'zh', roleId: 'narrator' }, { text: '长'.repeat(1500), language: 'zh', roleId: 'narrator' }] })], []);
 await assert.rejects(svc.voiceDialogue(w + '-c', long.id, { taskId: 'v' }), /超过单次合成上限/);
 assert.equal(voiceCalls().length, calls2);
});

test('配音前置条件与时长对齐：post / lipsync 没有最新配音时阻塞；配音超出视频时提示加长到 N 秒，不阻塞', async () => {
 const w = 'voice-preconditions';
 const project = await setup(w, [node('v', 'video', { prompt: '手持保温杯', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })], []);
 let p = await preview(w, project, 'v');
 assert.equal(p.scope.at(-1).action, 'blocked'); assert.equal(p.scope.at(-1).reason, '请先合成台词配音。');
 assert.equal(p.canStart, false);
 app.audioRunner.state.durationSec = 6.4;
 const synthesized = await svc.voiceDialogue(w, project.id, { taskId: 'v' });
 p = await preview(w, synthesized.project, 'v');
 const entry = p.scope.at(-1);
 assert.equal(entry.action, 'generate', entry.reason);
 assert.deepEqual(entry.dubWarning, { durationSec: 6.4, videoSeconds: 5, suggestedDuration: 8, message: '配音约 6.4 秒，超过分镜时长 5 秒。' });
 assert.equal(entry.dialogueWarning, undefined, '有真实时长时不再显示按字数估算的提醒');
 assert.equal(entry.resolved.prompt, '手持保温杯', '后期配音：台词不写入 H3 提示词');
 assert.equal(synthesized.dubStates.v.suggestion.suggestedDuration, 8);
 // 加长到 8 秒后不再提醒
 const longer = (await svc.update(w, project.id, { revision: synthesized.project.revision, tasks: synthesized.project.tasks.map(t => t.id === 'v' ? { ...t, params: { ...t.params, duration: 8 } } : t) })).project;
 assert.equal((await preview(w, longer, 'v')).scope.at(-1).dubWarning, undefined);
 app.audioRunner.state.durationSec = 3.2;
 // lipsync 只能用全能参考
 const lip = (await svc.update(w, project.id, { revision: longer.revision, tasks: longer.tasks.map(t => t.id === 'v' ? { ...t, dubMode: 'lipsync', videoMode: 'text' } : t) })).project;
 assert.match((await preview(w, lip, 'v')).scope.at(-1).reason, /口型同步需要使用「全能参考」/);
});

test('口型同步：配音作为最后一条 reference_audio，提示词追加台词与参考 <Audio N>，计入音频上限', async () => {
 const w = 'voice-lipsync';
 const image = await app.media.put(w, { bytes: app.png, name: '人物.png', role: 'creative' });
 const audio = await app.media.put(w, { bytes: mp3, name: '参考声.mp3', role: 'creative' });
 const tasks = [node('p', 'image', { sourceAssetId: image.id }), node('s', 'audio', { sourceAssetId: audio.id }),
  node('v', 'video', { videoMode: 'reference', dubMode: 'lipsync', prompt: '人物 {{ref:p}} 说话，节奏参考 {{ref:s}}', dialogue: LINES, params: { duration: 8, resolution: '480P' } })];
 const edges = [edge('p', 'v', 'refImage', 'image'), edge('s', 'v', 'refAudio', 'audio')];
 const project = await setup(w, tasks, edges);
 assert.equal((await preview(w, project, 'v')).scope.at(-1).reason, '请先合成台词配音。');
 const synthesized = await svc.voiceDialogue(w, project.id, { taskId: 'v' });
 const p = await preview(w, synthesized.project, 'v');
 const entry = p.scope.at(-1);
 assert.equal(entry.action, 'generate', entry.reason);
 assert.deepEqual(entry.resolved.media.map(m => [m.role, m.kind, m.sourceTaskId]), [['reference_image', 'image', 'p'], ['reference_audio', 'audio', 's'], ['reference_audio', 'audio', null]]);
 assert.equal(entry.resolved.media.at(-1).assetId, synthesized.project.tasks.find(t => t.id === 'v').dialogueAudio.assetId);
 assert.equal(entry.resolved.prompt, '人物 <Picture 1> 说话，节奏参考 <Audio 1>\n<d>[Chinese] 这款保温杯保温十二小时</d>\n<d>[Chinese] 现在下单立减二十元</d>\n说话人的音色与表达方式参考 <Audio 2>');
 await svc.start(w, project.id, { ...p.selection, revision: p.revision, previewToken: p.previewToken, requestKey: randomUUID() });
 const before = submissions().length;
 await svc.tick();
 const body = submissions().at(-1).body;
 assert.equal(submissions().length, before + 1);
 assert.deepEqual(body.content.map(e => e.role), [undefined, 'reference_image', 'reference_audio', 'reference_audio']);
 // 已有 3 个参考音频时，加上配音超出上限，预览阻塞并说明
 const w2 = w + '-full';
 const image2 = await app.media.put(w2, { bytes: app.png, name: '人物.png', role: 'creative' });
 const audio2 = await app.media.put(w2, { bytes: mp3, name: '参考声.mp3', role: 'creative' });
 const extra = [1, 2, 3].map(i => node('a' + i, 'audio', { sourceAssetId: audio2.id }));
 const crowded = await setup(w2, [node('p', 'image', { sourceAssetId: image2.id }), ...extra, { ...tasks[2], prompt: '' }], [edges[0], ...extra.map(a => edge(a.id, 'v', 'refAudio', 'audio'))]);
 const crowdedSynth = await svc.voiceDialogue(w2, crowded.id, { taskId: 'v' });
 assert.match((await preview(w2, crowdedSynth.project, 'v')).scope.at(-1).reason, /参考音频最多 3 个/);
});

test('后期配音：单镜成功后混音得到派生视频，shotVideoFor 优先派生、过期或混音失败时回退原视频，可重新混音', async () => {
 const w = 'voice-post';
 const tasks = [node('v', 'video', { title: '开场', prompt: '手持保温杯', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })];
 let project = await setup(w, tasks, []);
 project = (await svc.voiceDialogue(w, project.id, { taskId: 'v' })).project;
 const mixesBefore = app.audioRunner.state.mixes.length, pointsBefore = submissions().length;
 const runRow = await run(w, project, 'v');
 assert.equal(runRow.status, 'succeeded');
 assert.equal(submissions().length, pointsBefore + 1, '只提交一次 H3，混音不调用付费接口');
 assert.equal(runRow.input.dialogueAudio.assetId, project.tasks[0].dialogueAudio.assetId, '运行冻结了配音');
 assert.equal(runRow.input.prompt, '手持保温杯');
 assert.equal(app.audioRunner.state.mixes.length, mixesBefore + 1);
 let detail = await svc.detail(w, project.id);
 const dub = detail.runs.find(r => r.id === runRow.id).output.dub;
 assert.equal(dub.status, 'succeeded'); assert.equal(dub.dialogueHash, project.tasks[0].dialogueAudio.hash);
 const derived = await app.store.get(w, dub.assetId);
 assert.equal(derived.role, 'result'); assert.equal(derived.mime, 'video/mp4');
 assert.deepEqual(derived.derivedFrom, { runId: runRow.id, kind: 'dub', dialogueHash: dub.dialogueHash });
 assert.notEqual(dub.assetId, runRow.output.assetId, '原视频保留');
 assert.ok(await app.store.get(w, runRow.output.assetId));
 const shot = { nodeId: 'v' };
 assert.deepEqual(svc.shotVideoFor(shot, detail.runs, detail.project), { assetId: dub.assetId, runId: runRow.id, dub: true });
 assert.deepEqual(svc.shotVideoFor(shot, detail.runs), { assetId: runRow.output.assetId, runId: runRow.id }, '没有项目上下文时返回原视频');
 assert.equal(detail.dubStates.v.dub.assetId, dub.assetId); assert.equal(detail.dubStates.v.needsMix, false);
 // 改台词 → 配音过期 → 回退原视频
 const stale = (await svc.update(w, project.id, { revision: (await latest(w, project.id)).revision, tasks: project.tasks.map(t => t.id === 'v' ? { ...t, dialogue: [LINES[0]] } : t) })).project;
 detail = await svc.detail(w, project.id);
 assert.equal(svc.shotVideoFor(shot, detail.runs, detail.project).assetId, runRow.output.assetId);
 assert.equal(detail.dubStates.v.status, 'stale'); assert.equal(detail.dubStates.v.dub.outdated, true);
 // 重新合成（只剩一行）→ 与旧混音哈希不同 → 需要重新混音；混音失败时原视频仍然成功
 const resynth = (await svc.voiceDialogue(w, project.id, { taskId: 'v' })).project;
 detail = await svc.detail(w, project.id);
 assert.equal(detail.dubStates.v.needsMix, true);
 assert.equal(svc.shotVideoFor(shot, detail.runs, detail.project).assetId, runRow.output.assetId);
 app.audioRunner.state.failMix = true;
 const failed = await svc.voiceRemix(w, project.id, { taskId: 'v' });
 const failedRun = failed.runs.find(r => r.id === runRow.id);
 assert.equal(failedRun.status, 'succeeded', '混音失败不影响原视频成功状态');
 assert.equal(failedRun.output.dub.status, 'failed'); assert.match(failedRun.output.dub.error, /混音失败/);
 assert.equal(svc.shotVideoFor(shot, failed.runs, failed.project).assetId, runRow.output.assetId, '失败时回退原视频');
 assert.equal(failed.dubStates.v.dub.status, 'failed');
 // 重新混音成功 → 使用新的派生视频
 app.audioRunner.state.failMix = false; app.audioRunner.state.truncated = true;
 const remixed = await svc.voiceRemix(w, project.id, { taskId: 'v' });
 const fresh = remixed.runs.find(r => r.id === runRow.id).output.dub;
 assert.equal(fresh.status, 'succeeded'); assert.equal(fresh.truncated, true, '配音比视频长时截断并在节点提示');
 assert.equal(fresh.dialogueHash, resynth.tasks[0].dialogueAudio.hash);
 assert.equal(remixed.dubStates.v.dub.truncated, true);
 assert.equal(svc.shotVideoFor(shot, remixed.runs, remixed.project).assetId, fresh.assetId);
 app.audioRunner.state.truncated = false;
 void stale;
});

test('成片拼接使用配音版本；没有配音的镜头仍用原视频', async () => {
 const w = 'voice-compile';
 const nid = randomUUID();
 const project = await setup(w, [node(nid, 'video', { title: '一镜', prompt: '手持保温杯', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })], []);
 const withAudio = (await svc.voiceDialogue(w, project.id, { taskId: nid })).project;
 const row = await run(w, withAudio, nid);
 const read = [];
 const original = svc.compileBytes;
 svc.compileBytes = async ({ files }) => { read.push(files.map(f => f.bytes.length)); return Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypmp42'), 1, 2, 3]); };
 try {
  const saved = (await svc.update(w, project.id, { revision: (await latest(w, project.id)).revision, name: '配音成片' })).project;
  await svc.saveStoryboard(w, project.id, { revision: saved.revision, script: '脚本', shots: [{ id: randomUUID(), title: '一镜', description: '', nodeId: nid }] });
  const current = await svc.detail(w, project.id);
  await svc.compileStoryboard(w, project.id, { revision: current.project.revision, requestKey: randomUUID() });
  for (let i = 0; i < 40 && !read.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(read.length, 1);
  const dubbedBytes = (await app.media.read(w, row.output.dub?.assetId || (await svc.detail(w, project.id)).runs.at(-1).output.dub.assetId)).bytes.length;
  assert.equal(read[0][0], dubbedBytes, '拼接读取的是配音后的派生视频');
 } finally { svc.compileBytes = original; }
});

// ---- 字幕（V-25）----
const waitCompile = async (w, id) => {
 for (let i = 0; i < 60; i++) { const c = (await svc.detail(w, id)).project.storyboard.compile; if (c.status !== 'running') return c; await new Promise(r => setTimeout(r, 50)); }
 throw new Error('compile did not finish');
};
async function subtitleProject(w) {
 const nid = randomUUID();
 const project = await setup(w, [node(nid, 'video', { title: '一镜', prompt: '手持保温杯', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })], []);
 app.audioRunner.state.lineDurations = [2.4, 2.2]; app.audioRunner.state.durationSec = 5.2;
 const withAudio = (await svc.voiceDialogue(w, project.id, { taskId: nid })).project;
 const row = await run(w, withAudio, nid);
 assert.equal(row.status, 'succeeded');
 const saved = (await svc.update(w, project.id, { revision: (await latest(w, project.id)).revision, name: '字幕成片' })).project;
 await svc.saveStoryboard(w, project.id, { revision: saved.revision, script: '脚本', shots: [{ id: randomUUID(), title: '一镜', description: '', nodeId: nid }] });
 return { id: project.id, nid };
}
const startCompile = async (w, id, extra = {}) => svc.compileStoryboard(w, id, { revision: (await svc.detail(w, id)).project.revision, requestKey: randomUUID(), ...extra });

test('字幕：合成台词时开启 enable_subtitle，cues 按句偏移写入 dialogueAudio 并随哈希失效', async () => {
 const w = 'voice-subtitles';
 const before = voiceCalls().length;
 const { id, nid } = await subtitleProject(w);
 const calls = voiceCalls().slice(before);
 assert.ok(calls.length >= 2 && calls.every(c => c.body.req_params.audio_params.enable_subtitle === true), '每句都开启字幕时间戳');
 const task = (await latest(w, id)).tasks.find(t => t.id === nid);
 const cues = task.dialogueAudio.cues;
 // 假服务每字 0.2 秒、从 0.1 秒开始；第二句偏移 = 2.4 + 0.3。两句都不超过 18 字，各为一条。
 assert.deepEqual(cues.map(c => c.text), [LINES[0].text, LINES[1].text]);
 assert.equal(cues[0].start, 0.1); assert.equal(cues[0].end, 2.3);
 assert.equal(cues[1].start, 2.8); assert.equal(cues[1].end, 4.6);
 assert.ok(cues.every(c => c.end > c.start && c.end <= 5.2));
 let states = (await svc.detail(w, id)).dubStates[nid];
 assert.deepEqual(states.subtitles, { enabled: true, available: true, active: true });
 assert.equal(states.audio.cues.length, 2);
 // 开关：关闭后本镜没有字幕；非布尔值被拒绝。
 const off = (await svc.update(w, id, { revision: (await latest(w, id)).revision, tasks: (await latest(w, id)).tasks.map(t => t.id === nid ? { ...t, subtitles: false } : t) })).project;
 assert.equal(off.tasks[0].subtitles, false);
 states = (await svc.detail(w, id)).dubStates[nid];
 assert.deepEqual(states.subtitles, { enabled: false, available: true, active: false });
 await assert.rejects(svc.update(w, id, { revision: off.revision, tasks: off.tasks.map(t => ({ ...t, subtitles: 'yes' })) }), /本镜显示字幕/);
 // 改台词 -> 配音过期 -> 字幕随之失效（不再使用旧时间戳）。
 const stale = (await svc.update(w, id, { revision: off.revision, tasks: off.tasks.map(t => ({ ...t, subtitles: true, dialogue: [LINES[0]] })) })).project;
 states = (await svc.detail(w, id)).dubStates[nid];
 assert.equal(states.status, 'stale'); assert.deepEqual(states.subtitles, { enabled: true, available: false, active: false });
 assert.equal(svc.shotCues(stale.tasks[0], stale.voiceRoles).length, 0);
 // 重新合成会覆盖 cues。
 const again = (await svc.voiceDialogue(w, id, { taskId: nid })).project.tasks[0].dialogueAudio;
 assert.equal(again.cues.length, 1); assert.equal(again.cues[0].text, LINES[0].text);
});

test('字幕：服务没有返回时间戳时整句显示且不报错；后期配音与口型同步有字幕，不配音没有', async () => {
 const w = 'voice-subtitles-fallback';
 app.state.subtitles = false;
 try {
  const nid = randomUUID();
  const project = await setup(w, [node(nid, 'video', { prompt: 'x', dialogue: LINES, dubMode: 'post', params: { duration: 5, resolution: '480P' } })], []);
  app.audioRunner.state.lineDurations = [2.4, 2.2]; app.audioRunner.state.durationSec = 5.2;
  const done = (await svc.voiceDialogue(w, project.id, { taskId: nid })).project.tasks[0];
  assert.deepEqual(done.dialogueAudio.cues, [{ start: 0, end: 2.4, text: LINES[0].text }, { start: 2.7, end: 4.9, text: LINES[1].text }]);
  for (const [mode, expected] of [['lipsync', 2], ['post', 2], ['none', 0]]) assert.equal(svc.shotCues({ ...done, dubMode: mode }, ROLES).length, expected, mode);
 } finally { app.state.subtitles = true; }
});

test('成片 burnSubtitles：把选择与各镜字幕交给编码器，记录 compile.subtitles，详情不下发 SRT 全文', async () => {
 const w = 'voice-compile-burn';
 const { id } = await subtitleProject(w);
 const seen = [], original = svc.compileBytes;
 svc.compileBytes = async ({ files, burnSubtitles, report }) => {
  seen.push({ burnSubtitles, cues: files.map(f => f.cues), fallback: files.map(f => f.fallbackDuration) });
  Object.assign(report, { cueCount: 2, burned: burnSubtitles, srt: '1\n00:00:00,100 --> 00:00:02,300\n字幕一\n', durations: [5] });
  return mp4;
 };
 try {
  await assert.rejects(startCompile(w, id, { burnSubtitles: 'yes' }), /烧录字幕/);
  await startCompile(w, id, { burnSubtitles: true });
  let film = await waitCompile(w, id);
  assert.equal(film.status, 'succeeded');
  assert.equal(seen.length, 1); assert.equal(seen[0].burnSubtitles, true);
  assert.equal(seen[0].cues[0].length, 2, '把该镜的字幕条目交给编码器'); assert.equal(seen[0].fallback[0], 5);
  assert.deepEqual(film.subtitles, { burned: true, cueCount: 2 }); assert.equal(film.burnSubtitles, true);
  assert.ok(!JSON.stringify((await svc.detail(w, id)).project).includes('字幕一'), 'SRT 全文只在服务端保存');
  // 不烧录：同样记录条数，burned 为 false。
  await startCompile(w, id, { burnSubtitles: false });
  film = await waitCompile(w, id);
  assert.deepEqual(film.subtitles, { burned: false, cueCount: 2 }); assert.equal(seen[1].burnSubtitles, false);
  // 关闭本镜字幕后，交给编码器的字幕为空。
  const current = await latest(w, id);
  await svc.update(w, id, { revision: current.revision, tasks: current.tasks.map(t => ({ ...t, subtitles: false })) });
  await startCompile(w, id, {}); await waitCompile(w, id);
  assert.deepEqual(seen[2].cues, [[]]); assert.equal(seen[2].burnSubtitles, false);
 } finally { svc.compileBytes = original; }
});

test('成片烧录失败：成片状态为失败并给中文原因，不留下成片素材', async () => {
 const w = 'voice-compile-burn-fail';
 const { id } = await subtitleProject(w);
 const original = svc.compileBytes, { AppError } = await import('../server/errors.mjs');
 svc.compileBytes = async () => { throw new AppError('SUBTITLE_BURN_FAILED', '字幕烧录失败，没有生成成片：Error opening filters!', 503); };
 try {
  await startCompile(w, id, { burnSubtitles: true });
  const film = await waitCompile(w, id);
  assert.equal(film.status, 'failed'); assert.equal(film.assetId, null);
  assert.match(film.error, /字幕烧录失败，没有生成成片/); assert.equal(film.burnSubtitles, true);
  assert.ok(!film.subtitles, '失败时不记录字幕结果');
  assert.equal((await app.api('/api/creation/assets?role=result')).items.filter(a => a.projectId === id && /成片/.test(a.name)).length, 0);
 } finally { svc.compileBytes = original; }
});

test('GET storyboard/subtitles.srt：无成片时按当前分镜生成，成片后下载成片对应字幕，中文文件名走 RFC 5987', async () => {
 const w = 'local';
 const { id, nid } = await subtitleProject(w);
 const response = await fetch(`${app.origin}/api/creation/projects/${id}/storyboard/subtitles.srt`);
 assert.equal(response.status, 200);
 assert.match(response.headers.get('content-type'), /^application\/x-subrip; charset=utf-8/);
 const disposition = response.headers.get('content-disposition');
 assert.match(disposition, /^attachment; filename="subtitles\.srt"; filename\*=UTF-8''/);
 assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), '字幕成片-字幕.srt');
 assert.ok(!/[^\x20-\x7e]/.test(disposition), '头部只含 ASCII，中文已百分号编码');
 // 无成片：单镜无需平移。
 assert.equal(await response.text(), `1\n00:00:00,100 --> 00:00:02,300\n${LINES[0].text}\n\n2\n00:00:02,800 --> 00:00:04,600\n${LINES[1].text}\n`);
 // 成片后：下载成片对应的字幕（来自编码器 report）。
 const original = svc.compileBytes;
 svc.compileBytes = async ({ report }) => { Object.assign(report, { cueCount: 1, burned: false, srt: '1\n00:00:07,000 --> 00:00:08,000\n成片字幕\n', durations: [6] }); return mp4; };
 try { await startCompile(w, id, {}); await waitCompile(w, id); } finally { svc.compileBytes = original; }
 assert.equal(await (await fetch(`${app.origin}/api/creation/projects/${id}/storyboard/subtitles.srt`)).text(), '1\n00:00:07,000 --> 00:00:08,000\n成片字幕\n');
 // 没有任何字幕（关闭本镜字幕、且没有成片字幕记录）：409 + 中文原因。
 const bare = await subtitleProject('local');
 const task = (await latest('local', bare.id)).tasks.find(t => t.id === bare.nid);
 await svc.update('local', bare.id, { revision: (await latest('local', bare.id)).revision, tasks: [{ ...task, subtitles: false }] });
 const none = await fetch(`${app.origin}/api/creation/projects/${bare.id}/storyboard/subtitles.srt`);
 assert.equal(none.status, 409); assert.match((await none.json()).error?.message || '', /还没有可导出的字幕/);
 void nid;
});
