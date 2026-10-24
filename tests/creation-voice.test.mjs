import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JsonStream, synthesize, designVoice, ttsHeaders, volcError, downloadDemoAudio } from '../server/providers/volc-tts.mjs';
import { buildJoinArgs, buildMixArgs, createAudioRunner } from '../server/audio-join.mjs';
import { parseVoices } from '../scripts/build-voices.mjs';
import { filterVoices, voiceLibrary, dubState, dialogueAudioStatus, dubSuggestion } from '../server/creation-voice.mjs';
import { validateVoiceRoles } from '../shared/creation-voice.mjs';
import { validateProtocol, normalizeBaseUrl } from '../server/channels.mjs';
import { AppError } from '../server/errors.mjs';

const channel = { id: 'ch_0000000000000009', adapter: 'volcengine-tts', baseUrl: 'https://openspeech.bytedance.com', apiKey: 'unit-test-not-a-real-key', executorConfig: {} };
const b64 = text => Buffer.from(text).toString('base64');
const objectText = (data, code = 0) => JSON.stringify({ code, message: '', data });
const endText = words => JSON.stringify({ code: 20000000, message: 'ok', data: null, usage: { text_words: words } });
// 把任意文本切成指定字节数的响应片段，模拟网络分片。
function streamOf(text, size) {
 const bytes = Buffer.from(text);
 const chunks = [];
 for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
 return new Response(new ReadableStream({ start(controller) { chunks.forEach(c => controller.enqueue(c)); controller.close(); } }), { status: 200, headers: { 'x-tt-logid': 'log-1' } });
}
const recorder = response => { const calls = []; return { calls, transport: async (url, options) => { calls.push({ url, options }); return typeof response === 'function' ? response(url, options) : response; } }; };

test('流式 JSON 解析：对象跨片段、多个对象在同一片段、字符串里的花括号', () => {
 const seen = [];
 const parser = new JsonStream(object => seen.push(object));
 const text = objectText(b64('AA')) + '\n' + JSON.stringify({ code: 0, data: null, sentence: { text: '含 } 和 { 的 "字符串"' } }) + endText(5);
 for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7));
 assert.equal(seen.length, 3);
 assert.equal(seen[1].sentence.text, '含 } 和 { 的 "字符串"');
 assert.equal(seen[2].usage.text_words, 5);
 assert.equal(parser.pending, false);
 const single = []; const one = new JsonStream(o => single.push(o));
 one.push(objectText(b64('1')) + objectText(b64('2')) + endText(2));
 assert.equal(single.length, 3);
 assert.throws(() => new JsonStream(() => {}).push('{"a":1,}'), /格式无效/);
});

test('synthesize：请求头与 body，分片音频累积，结束包返回字符数与 logid', async () => {
 const body = objectText(b64('ID3-first')) + '\n' + objectText(b64('-second')) + endText(12);
 const { calls, transport } = recorder(() => streamOf(body, 5));
 const result = await synthesize(transport, channel, { text: '你好，世界', speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', emotion: 'happy', emotionScale: 3, speechRate: 20, loudnessRate: -10, language: 'en', contextText: '语气轻快', subtitle: true });
 assert.equal(result.bytes.toString(), 'ID3-first-second');
 assert.equal(result.mime, 'audio/mpeg');
 assert.equal(result.textWords, 12);
 assert.equal(result.logId, 'log-1');
 assert.deepEqual(result.subtitle, []);
 const { url, options } = calls[0];
 assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
 assert.equal(options.method, 'POST');
 assert.equal(options.headers['X-Api-Key'], channel.apiKey);
 assert.equal(options.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
 assert.match(options.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/);
 assert.equal(options.headers['X-Control-Require-Usage-Tokens-Return'], 'text_words');
 const sent = JSON.parse(options.body);
 assert.equal(sent.req_params.text, '你好，世界');
 assert.equal(sent.req_params.speaker, 'zh_female_vv_uranus_bigtts');
 assert.deepEqual(sent.req_params.audio_params, { format: 'mp3', sample_rate: 24000, emotion: 'happy', emotion_scale: 3, speech_rate: 20, loudness_rate: -10, enable_subtitle: true });
 assert.equal(typeof sent.req_params.additions, 'string', 'additions 是 JSON 字符串');
 assert.deepEqual(JSON.parse(sent.req_params.additions), { explicit_language: 'en', context_texts: ['语气轻快'] });
});

test('synthesize：字幕时间戳原样保留；中文不指定 explicit_language；默认参数不带语速音量', async () => {
 const sentence = { text: '你好', words: [{ word: '你', startTime: 0.1, endTime: 0.3 }] };
 const body = objectText(b64('A')) + JSON.stringify({ code: 0, data: null, sentence }) + endText(2);
 const { calls, transport } = recorder(() => streamOf(body, 1000));
 const result = await synthesize(transport, channel, { text: '你好', speaker: 'zh_male_m191_uranus_bigtts', language: 'zh', subtitle: true });
 assert.deepEqual(result.subtitle, [sentence]);
 const sent = JSON.parse(calls[0].options.body);
 assert.equal(sent.req_params.additions, undefined);
 assert.deepEqual(sent.req_params.audio_params, { format: 'mp3', sample_rate: 24000, enable_subtitle: true });
});

test('synthesize：错误包、HTTP 错误、截断响应都转成中文错误且不含密钥', async () => {
 const message = error => `${error.code}:${error.message}`;
 const failing = async body => synthesize(recorder(() => streamOf(body, 8)).transport, channel, { text: '台词', speaker: 'zh_male_m191_uranus_bigtts' }).then(() => null, error => error);
 const denied = await failing(objectText(b64('A')) + JSON.stringify({ code: 45000000, message: 'speaker permission denied: secret-detail' }));
 assert.ok(denied instanceof AppError); assert.match(denied.message, /音色未授权/); assert.doesNotMatch(message(denied), /secret-detail|unit-test-not-a-real-key/);
 assert.match((await failing(JSON.stringify({ code: 40402003, message: 'x' }))).message, /文本长度超过/);
 assert.match((await failing(objectText(b64('A')))).message, /没有返回完整/);
 assert.match((await failing(endText(1))).message, /没有返回音频/);
 const http401 = await synthesize(recorder(() => new Response('{"code":401}', { status: 401 })).transport, channel, { text: 'a', speaker: 'zh_male_m191_uranus_bigtts' }).catch(e => e);
 assert.match(http401.message, /API Key 无效/); assert.doesNotMatch(http401.message, /unit-test-not-a-real-key/);
 const http429 = await synthesize(recorder(() => new Response('{}', { status: 429 })).transport, channel, { text: 'a', speaker: 'zh_male_m191_uranus_bigtts' }).catch(e => e);
 assert.equal(http429.code, 'VOICE_RATE_LIMITED');
 const network = await synthesize(async () => { throw new Error('socket hang up ' + channel.apiKey); }, channel, { text: 'a', speaker: 'zh_male_m191_uranus_bigtts' }).catch(e => e);
 assert.equal(network.code, 'VOICE_TRANSPORT_FAILED'); assert.doesNotMatch(network.message, /unit-test-not-a-real-key/);
 assert.equal((await synthesize(async () => new Response('', { status: 200 }), channel, { text: '', speaker: 'x' }).catch(e => e)).code, 'VOICE_TEXT_REQUIRED');
 assert.equal(ttsHeaders(channel, 'seed-icl-2.0')['X-Api-Resource-Id'], 'seed-icl-2.0');
 assert.equal(volcError(55000000, 200).code, 'VOICE_PROVIDER_ERROR');
});

test('designVoice：文字描述与人物图请求、状态、剩余次数与次数用尽', async () => {
 const ok = { status: 2, demo_audio: 'https://demo.voice.example/a.mp3', available_training_times: 14, speaker_id: 'S_unit', language: 0 };
 const { calls, transport } = recorder(() => new Response(JSON.stringify(ok), { status: 200 }));
 const result = await designVoice(transport, channel, { speakerId: 'S_unit_001', text: '大家好，欢迎光临。', textPrompt: '温柔的年轻女声', language: 0 });
 assert.deepEqual(result, { status: 2, usable: true, demoAudioUrl: ok.demo_audio, remaining: 14 });
 assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/voice_design');
 assert.equal(calls[0].options.headers['X-Api-Key'], channel.apiKey);
 assert.deepEqual(JSON.parse(calls[0].options.body), { speaker_id: 'S_unit_001', text: '大家好，欢迎光临。', prompt: { text_prompt: '温柔的年轻女声' }, language: 0 });
 const image = Buffer.from([1, 2, 3, 4]);
 await designVoice(transport, channel, { speakerId: 'S_unit_001', text: 'Hello', imageBytes: image, language: 1 });
 assert.deepEqual(JSON.parse(calls[1].options.body).prompt, { image_prompt: { image_bytes: image.toString('base64') } });
 assert.equal(JSON.parse(calls[1].options.body).language, 1);
 const running = await designVoice(recorder(() => new Response(JSON.stringify({ ...ok, status: 1 }), { status: 200 })).transport, channel, { speakerId: 'S_unit_001', text: 'a', textPrompt: 'b' });
 assert.equal(running.usable, false);
 const exhausted = await designVoice(recorder(() => new Response(JSON.stringify({ code: 45001123, message: 'x' }), { status: 200 })).transport, channel, { speakerId: 'S_unit_001', text: 'a', textPrompt: 'b' }).catch(e => e);
 assert.equal(exhausted.code, 'VOICE_DESIGN_EXHAUSTED'); assert.match(exhausted.message, /设计次数已用尽/);
 assert.equal((await designVoice(transport, channel, { speakerId: 'bad id', text: 'a', textPrompt: 'b' }).catch(e => e)).code, 'VOICE_SPEAKER_INVALID');
 assert.equal((await designVoice(transport, channel, { speakerId: 'S_unit_001', text: 'a', textPrompt: 'x'.repeat(201) }).catch(e => e)).code, 'VOICE_DESIGN_PROMPT');
 assert.equal((await designVoice(transport, channel, { speakerId: 'S_unit_001', text: 'x'.repeat(301), textPrompt: 'a' }).catch(e => e)).code, 'VOICE_DESIGN_TEXT');
});

test('试听音频转存：只接受公网 https 并限制跳转', async () => {
 assert.equal((await downloadDemoAudio(async () => new Response(Buffer.from('ID3x')), 'https://demo.voice.example/a.mp3')).toString(), 'ID3x');
 await assert.rejects(downloadDemoAudio(async () => new Response('', { status: 200 }), 'http://127.0.0.1/a.mp3'), /非公网|HTTPS/);
 await assert.rejects(downloadDemoAudio(async () => new Response('', { status: 404 }), 'https://demo.voice.example/a.mp3'), /下载失败/);
});

test('音色库脚本：解析 voices.txt 的中文与外语 2.0 音色，排除 S2S 与 1.0', () => {
 const text = ['"豆包语音合成模型2.0、S2S-O2.0、 S2S-全双工" 音色列表 #', '场景', '音色名称', 'voice_type', '语种/方言', '支持能力', '特殊标签',
  '通用场景', 'Vivi 2.0', 'zh_female_vv_uranus_bigtts', '语种：中文、日文、支持30+语种识别', '方言：粤语、四川', '指令遵循',
  '视频配音', '佩奇猪 2.0', 'zh_female_peiqi_uranus_bigtts', '中文、支持30+语种识别', '指令遵循', '抖音同款,豆包同款',
  '角色扮演', '爽朗少年 2.0', 'ICL_uranus_zh_male_shuanglangshaonian_tob', '中文',
  '"豆包语音合成模型2.0" 外语音色列表 #', '注意：个别音色仅限单向流使用', '场景', '音色名称', 'voice_type', '语种/方言', '推荐推理模式', '支持能力', '备注',
  '有声阅读,外语音色,泰语', 'Cake', 'th_female_cake_uranus_bigtts', '泰语', 'Context', '情感变化、上下文遵循', '仅限单向流使用，不支持双向流，双向流调用会直接报错；',
  '"端到端实时语音大模型 S2S-O版本、SC-2.0版本 "音色列表 #', '场景', '音色名称', 'voice_type', '语种/方言', '通用场景', '不应出现', 'saturn_zh_female_x_tob', '中文',
  '"豆包语音合成模型1.0" 音色列表 #', '通用场景', '旧音色', 'BV001_streaming', '中文'].join('\n');
 const voices = parseVoices(text);
 assert.deepEqual(voices.map(v => v.voiceType), ['zh_female_vv_uranus_bigtts', 'zh_female_peiqi_uranus_bigtts', 'ICL_uranus_zh_male_shuanglangshaonian_tob', 'th_female_cake_uranus_bigtts']);
 const [vivi, peiqi, icl, cake] = voices;
 assert.deepEqual([vivi.name, vivi.scene, vivi.gender, vivi.group, vivi.autoLanguage], ['Vivi 2.0', '通用场景', 'female', 'chinese', true]);
 assert.deepEqual(vivi.languages, ['中文', '日文']); assert.deepEqual(vivi.dialects, ['粤语', '四川']); assert.deepEqual(vivi.capabilities, ['指令遵循']);
 assert.deepEqual(peiqi.tags, ['抖音同款', '豆包同款']);
 assert.equal(icl.gender, 'male'); assert.deepEqual(icl.languages, ['中文']);
 assert.deepEqual([cake.group, cake.scene, cake.mode, cake.emotion, cake.languages], ['foreign', '有声阅读', 'Context', true, ['泰语']]);
 assert.deepEqual(cake.scenes, ['有声阅读', '外语音色', '泰语']);
});

test('config/voices.json：来自 voices.txt 的音色库结构完整，可按场景 / 性别 / 语言筛选', () => {
 const library = voiceLibrary();
 assert.ok(library.voices.length > 300);
 assert.equal(library.voices.length, library.count);
 assert.equal(new Set(library.voices.map(v => v.voiceType)).size, library.voices.length, 'voice_type 唯一');
 for (const voice of library.voices) assert.ok(voice.name && voice.voiceType && voice.scene && voice.languages.length, voice.voiceType);
 const female = filterVoices(library.voices, { gender: 'female', scene: '客服场景' });
 assert.ok(female.length > 0 && female.every(v => v.gender === 'female' && v.scenes.includes('客服场景')));
 assert.ok(filterVoices(library.voices, { language: '泰语' }).every(v => v.languages.some(l => l.includes('泰语'))));
 assert.ok(filterVoices(library.voices, { q: 'vivi' }).some(v => v.voiceType === 'zh_female_vv_uranus_bigtts'));
 assert.ok(!JSON.stringify(library).includes('saturn_'), '不收录 S2S 音色');
 const source = readFileSync(new URL('../config/voices.json', import.meta.url), 'utf8');
 assert.doesNotMatch(source, /api[_-]?key|secret|token/i);
});

test('audio-join：拼接参数含行间静音，混音参数含 30% 音量、截断与 H.264 + AAC 输出', () => {
 const join = buildJoinArgs(3, 'out.mp3');
 assert.equal(join.filter(arg => arg === '-i').length, 3);
 const graph = join[join.indexOf('-filter_complex') + 1];
 assert.match(graph, /anullsrc=r=24000:cl=mono,atrim=duration=0\.300/);
 assert.equal((graph.match(/anullsrc/g) || []).length, 2, '三句之间两个间隔');
 assert.match(graph, /concat=n=5:v=0:a=1\[out\]/);
 assert.deepEqual(join.slice(join.indexOf('-map')), ['-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '24000', '-ac', '1', '-y', 'out.mp3']);
 assert.equal(join.at(-1), 'out.mp3'); assert.equal(join.at(-2), '-y');
 assert.throws(() => buildJoinArgs(0, 'x'), /没有可拼接/);

 const withAudio = buildMixArgs({ hasAudio: true }, 'v.mp4', 'd.mp3', 'o.mp4');
 const graphA = withAudio[withAudio.indexOf('-filter_complex') + 1];
 assert.match(graphA, /\[0:a\]volume=0\.3,/);
 assert.match(graphA, /amix=inputs=2:duration=longest:normalize=0/);
 assert.ok(withAudio.includes('-shortest'), '配音比视频长时截断到视频长度');
 assert.deepEqual(withAudio.slice(withAudio.indexOf('-c:v'), withAudio.indexOf('-c:v') + 2), ['-c:v', 'libx264']);
 assert.ok(withAudio.includes('yuv420p') && withAudio.includes('aac') && withAudio.includes('+faststart'));
 assert.deepEqual(withAudio.slice(withAudio.indexOf('-map'), withAudio.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '[m]']);
 assert.equal(withAudio.at(-1), 'o.mp4');
 const silent = buildMixArgs({ hasAudio: false }, 'v.mp4', 'd.mp3', 'o.mp4');
 const graphS = silent[silent.indexOf('-filter_complex') + 1];
 assert.doesNotMatch(graphS, /volume=|amix/, '无原声时不混音，只补配音');
 assert.match(graphS, /\[1:a\].*apad\[m\]/);
});

test('audio-join runner：ffprobe / ffmpeg 通过注入的 spawn 执行，缺少 ffmpeg 给出中文错误', async () => {
 const commands = [];
 const { EventEmitter } = await import('node:events');
 const { writeFile } = await import('node:fs/promises');
 const fake = ({ missing = false } = {}) => (command, args) => {
  commands.push([command, args]);
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  setImmediate(async () => {
   if (missing) { child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); return; }
   if (command === 'ffprobe') child.stdout.emit('data', JSON.stringify(args.includes('format=duration') ? { format: { duration: '3.250' } } : { streams: [{ codec_type: 'video', width: 720, height: 1280, r_frame_rate: '24/1', duration: '5.0' }, { codec_type: 'audio' }], format: { duration: '5.0' } }));
   else await writeFile(args.at(-1), Buffer.from('OUTPUT'));
   child.emit('close', 0);
  });
  return child;
 };
 const runner = createAudioRunner({ spawnFn: fake() });
 const joined = await runner.join([Buffer.from('a'), Buffer.from('b')]);
 assert.equal(joined.bytes.toString(), 'OUTPUT'); assert.equal(joined.durationSec, 3.25);
 const mixed = await runner.mix({ video: Buffer.from('v'), audio: Buffer.from('a') });
 assert.equal(mixed.truncated, false); assert.equal(mixed.videoSeconds, 5);
 const mixCommand = commands.filter(([command]) => command === 'ffmpeg').at(-1)[1];
 assert.ok(mixCommand.includes('-shortest') && mixCommand.includes('libx264'));
 await assert.rejects(createAudioRunner({ spawnFn: fake({ missing: true }) }).join([Buffer.from('a')]), /缺少 ffmpeg/);
});

test('角色校验与台词配音状态：哈希覆盖台词、语言、角色音色与参数', () => {
 assert.equal(validateVoiceRoles('x').error !== undefined, true);
 assert.match(validateVoiceRoles([{ id: 'a', name: '旁白', speaker: 'bad speaker!' }]).error, /音色编号/);
 assert.match(validateVoiceRoles([{ id: 'a', name: '旁白', speechRate: 101 }]).error, /语速/);
 assert.match(validateVoiceRoles([{ id: 'a', name: '旁白' }, { id: 'a', name: '主播' }]).error, /重复/);
 const [designed] = validateVoiceRoles([{ id: 'd', name: '设计', speaker: 'S_x_001', source: 'designed' }]).roles;
 assert.equal(designed.resourceId, 'seed-icl-2.0');
 const roles = validateVoiceRoles([{ id: 'r1', name: '旁白', speaker: 'zh_female_vv_uranus_bigtts' }, { id: 'r2', name: '主播', speaker: 'zh_male_m191_uranus_bigtts', speechRate: 10 }]).roles;
 const task = { id: 't', params: { duration: 5 }, dialogue: [{ text: '第一句', language: 'zh', roleId: 'r1' }, { text: 'Second', language: 'en', roleId: 'r2' }] };
 const state = dubState(task, roles);
 assert.match(state.hash, /^[0-9a-f]{64}$/); assert.equal(state.issue, null);
 assert.equal(dubState({ ...task, dialogue: [{ ...task.dialogue[0], text: '改了' }, task.dialogue[1]] }, roles).hash !== state.hash, true, '台词变化');
 assert.equal(dubState({ ...task, dialogue: [{ ...task.dialogue[0], language: 'en' }, task.dialogue[1]] }, roles).hash !== state.hash, true, '语言变化');
 assert.equal(dubState({ ...task, dialogue: [{ ...task.dialogue[0], roleId: 'r2' }, task.dialogue[1]] }, roles).hash !== state.hash, true, '换角色');
 assert.equal(dubState(task, roles.map(r => r.id === 'r2' ? { ...r, speechRate: 30 } : r)).hash !== state.hash, true, '角色参数');
 assert.equal(dubState(task, roles.map(r => r.id === 'r1' ? { ...r, name: '新名字' } : r)).hash, state.hash, '角色改名不影响声音');
 assert.match(dubState({ ...task, dialogue: [{ text: '无角色', language: 'zh' }] }, roles).issue, /没有选择角色/);
 assert.match(dubState({ ...task, dialogue: [{ text: 'x', language: 'zh', roleId: 'gone' }] }, roles).issue, /已被删除/);
 assert.match(dubState({ ...task, dialogue: [] }, roles).issue, /请先填写台词/);
 assert.equal(dialogueAudioStatus({ ...task, dialogueAudio: { assetId: 'a', hash: state.hash } }, roles), 'fresh');
 assert.equal(dialogueAudioStatus({ ...task, dialogueAudio: { assetId: 'a', hash: 'old' } }, roles), 'stale');
 assert.equal(dialogueAudioStatus(task, roles), 'none');
 assert.equal(dubSuggestion(task, 4.2), null);
 assert.deepEqual(dubSuggestion(task, 6.1), { durationSec: 6.1, videoSeconds: 5, suggestedDuration: 8, message: '配音约 6.1 秒，超过分镜时长 5 秒。' });
 assert.equal(dubSuggestion(task, 40).suggestedDuration, null, '超过 30 秒只能加快语速');
});

test('火山语音渠道协议：地址固定、只允许资源 ID', () => {
 assert.equal(normalizeBaseUrl('https://attacker.example', 'volcengine-tts'), 'https://openspeech.bytedance.com');
 assert.deepEqual(validateProtocol('volcengine-tts', { resourceId: 'seed-icl-2.0' }), { resourceId: 'seed-icl-2.0' });
 assert.throws(() => validateProtocol('volcengine-tts', { resourceId: 'other' }), /资源 ID/);
 assert.throws(() => validateProtocol('volcengine-tts', { video: 'minimax-h3' }), /只能配置资源 ID/);
 assert.throws(() => validateProtocol('unknown'), /火山引擎语音/);
});
