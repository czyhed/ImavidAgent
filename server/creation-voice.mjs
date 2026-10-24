import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AppError } from './errors.mjs';
import { createAudioRunner, JOIN_GAP_SECONDS } from './audio-join.mjs';
import { dialogueCues } from './subtitles.mjs';
import {
 validateVoiceRoles, validSpeaker, DEFAULT_PREVIEW_TEXT, MAX_PREVIEW_TEXT, MAX_DIALOGUE_CHARS, MAX_DUB_SECONDS, VOLC_RESOURCES, DEFAULT_RESOURCE_ID, RATE_RANGE,
} from '../shared/creation-voice.mjs';

// 火山语音业务层：音色库、试听缓存、音色设计、台词合成与后期混音。
// 供应商调用都经 ModelHub（渠道密钥只在服务端）；ffmpeg 通过可注入的 audioRunner，测试不依赖真实 ffmpeg。

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const chars = text => [...String(text || '').trim()].length;
const fail = (code, message, status = 422) => { throw new AppError(code, message, status); };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let library;
export function voiceLibrary() {
 if (!library) library = JSON.parse(readFileSync(new URL('../config/voices.json', import.meta.url), 'utf8'));
 return library;
}
// 按场景 / 性别 / 语言（含方言与名称关键字）筛选系统音色库。
export function filterVoices(voices, { scene, gender, language, q, group } = {}) {
 const needle = String(q || '').trim().toLowerCase();
 return voices.filter(v => (!scene || v.scenes.includes(scene)) && (!gender || v.gender === gender) && (!group || v.group === group)
  && (!language || v.languages.some(l => l.includes(language)) || v.dialects.some(d => d.includes(language)))
  && (!needle || v.name.toLowerCase().includes(needle) || v.voiceType.toLowerCase().includes(needle)));
}

// 角色的合成参数（只含影响声音的字段，角色改名不影响）。
const voiceSettings = role => ({ speaker: role.speaker, resourceId: role.resourceId || DEFAULT_RESOURCE_ID, speechRate: role.speechRate || 0, emotion: role.emotion || '', emotionScale: role.emotionScale ?? 4, loudnessRate: role.loudnessRate || 0, contextText: role.contextText || '' });
const spokenLines = dialogue => (Array.isArray(dialogue) ? dialogue : []).filter(d => d && typeof d.text === 'string' && d.text.trim());

// 台词配音的状态：hash 覆盖台词文本、语言、角色音色与参数；issue 说明为什么现在不能合成。
export function dubState(task, voiceRoles = []) {
 const lines = spokenLines(task?.dialogue);
 if (!lines.length) return { lines: [], hash: null, issue: '请先填写台词。' };
 const roles = new Map((voiceRoles || []).map(r => [r.id, r]));
 const resolved = [];
 for (const [index, line] of lines.entries()) {
  const role = roles.get(line.roleId);
  if (!line.roleId) return { lines, hash: null, issue: `第 ${index + 1} 句台词还没有选择角色。` };
  if (!role) return { lines, hash: null, issue: `第 ${index + 1} 句台词的角色已被删除，请重新选择。` };
  if (!role.speaker) return { lines, hash: null, issue: `角色「${role.name}」还没有选择音色。` };
  resolved.push({ text: line.text.trim(), language: line.language === 'en' ? 'en' : 'zh', ...voiceSettings(role) });
 }
 return { lines, resolved, hash: sha(resolved), issue: null };
}
// 节点上的配音是否与当前台词和角色一致：fresh / stale / none。
export function dialogueAudioStatus(task, voiceRoles) {
 const audio = task?.dialogueAudio;
 if (!audio?.assetId) return 'none';
 const state = dubState(task, voiceRoles);
 return state.hash && state.hash === audio.hash ? 'fresh' : 'stale';
}
export function dubSuggestion(task, durationSec) {
 const duration = Number.isInteger(task?.params?.duration) ? task.params.duration : 5;
 if (!Number.isFinite(durationSec) || durationSec <= duration) return null;
 const longer = Math.min(MAX_DUB_SECONDS, Math.ceil(durationSec + 1));
 return { durationSec, videoSeconds: duration, suggestedDuration: longer > duration && durationSec <= MAX_DUB_SECONDS - 1 ? longer : null, message: `配音约 ${durationSec.toFixed(1)} 秒，超过分镜时长 ${duration} 秒。` };
}

const isCjk = text => /[぀-ヿ㐀-鿿]/.test(text);

export class CreationVoice {
 constructor({ hub, media, store, audioRunner } = {}) {
  this.hub = hub; this.media = media; this.store = store; this.audio = audioRunner || createAudioRunner();
  this.inflight = new Map(); this.synthesizing = new Set();
 }
 list(query = {}) {
  const library = voiceLibrary();
  const voices = filterVoices(library.voices, query);
  const unique = key => [...new Set(library.voices.flatMap(v => (Array.isArray(v[key]) ? v[key] : [v[key]]).filter(Boolean)))];
  return { voices, total: voices.length, facets: { scenes: unique('scenes').filter(s => s !== '外语音色'), languages: unique('languages'), genders: ['female', 'male'] }, resourceId: library.model };
 }
 async configured() { return this.hub.voiceConfigured(); }
 // ---- 试听 ----
 previewKey({ speaker, resourceId, text, params }) { return sha({ speaker, resourceId, text, params }); }
 async findCached(workspace, key) {
  const found = (await this.store.pool.query("SELECT id FROM sj_creation_records WHERE workspace_id=$1 AND kind='asset' AND body->>'role'='voice' AND body->'derivedFrom'->>'key'=$2 AND body->>'deletionPending' IS DISTINCT FROM 'true' AND trashed_at IS NULL LIMIT 1", [workspace, key])).rows[0];
  return found ? this.store.get(workspace, found.id) : null;
 }
 normalizeSpeakerParams(input = {}) {
  const speaker = typeof input.speaker === 'string' ? input.speaker.trim() : '';
  if (!validSpeaker(speaker)) fail('VOICE_SPEAKER_INVALID', '请先选择有效的音色。');
  const resourceId = input.resourceId ?? DEFAULT_RESOURCE_ID;
  if (!VOLC_RESOURCES.includes(resourceId)) fail('VOICE_RESOURCE_INVALID', '资源 ID 需为 seed-tts-2.0 或 seed-icl-2.0。');
  const role = validateVoiceRoles([{ id: 'preview', name: '试听', speaker, source: input.source || 'system', resourceId, speechRate: input.speechRate, loudnessRate: input.loudnessRate, emotion: input.emotion, emotionScale: input.emotionScale, contextText: input.contextText }]);
  if (role.error) fail('VOICE_PARAMS_INVALID', role.error);
  return role.roles[0];
 }
 async preview(workspace, body = {}) {
  const role = this.normalizeSpeakerParams({ ...(body.params || {}), speaker: body.speaker, resourceId: body.resourceId });
  const custom = typeof body.text === 'string' ? body.text.trim() : '';
  const text = custom || DEFAULT_PREVIEW_TEXT;
  if (chars(text) > MAX_PREVIEW_TEXT) fail('VOICE_TEXT_TOO_LONG', `试听文本不超过 ${MAX_PREVIEW_TEXT} 个字。`);
  const settings = voiceSettings(role), key = this.previewKey({ speaker: settings.speaker, resourceId: settings.resourceId, text, params: { speechRate: settings.speechRate, emotion: settings.emotion, emotionScale: settings.emotionScale, loudnessRate: settings.loudnessRate, contextText: settings.contextText } });
  const cached = await this.findCached(workspace, key);
  if (cached) return { assetId: cached.id, fileUrl: `/api/creation/assets/${cached.id}/file`, cached: true, textWords: cached.textWords ?? chars(text), text };
  // 同一试听同时到达两次时只合成一次，避免重复收费。
  if (this.inflight.has(key)) return { ...(await this.inflight.get(key)), cached: true };
  const job = (async () => {
   const result = await this.hub.synthesizeSpeech({ workspaceId: workspace, text, language: isCjk(text) ? 'zh' : 'en', ...settings });
   const asset = await this.media.put(workspace, { bytes: result.bytes, mime: result.mime, name: `试听-${settings.speaker}.mp3`, role: 'voice', derivedFrom: { kind: 'voice-preview', key } });
   await this.store.change(workspace, asset.id, null, (current) => ({ ...current, textWords: result.textWords ?? chars(text) }), { keepRevision: true });
   return { assetId: asset.id, fileUrl: `/api/creation/assets/${asset.id}/file`, cached: false, textWords: result.textWords ?? chars(text), text };
  })();
  this.inflight.set(key, job);
  try { return await job; } finally { this.inflight.delete(key); }
 }
 // ---- 音色设计 ----
 async design(workspace, body = {}) {
  const speakerId = typeof body.speakerId === 'string' ? body.speakerId.trim() : '';
  if (!validSpeaker(speakerId)) fail('VOICE_SPEAKER_INVALID', '音色编号只能包含字母、数字、下划线、点和连字符，长度 3–100。');
  let imageBytes;
  if (body.imageAssetId) {
   const asset = await this.store.get(workspace, body.imageAssetId);
   if (!asset || asset.kind !== 'asset' || asset.deletionPending || !String(asset.mime).startsWith('image/')) fail('VOICE_DESIGN_IMAGE', '请选择当前工作空间内的一张人物图片。');
   imageBytes = (await this.media.read(workspace, asset.id)).bytes;
  }
  const language = Number(body.language) === 1 ? 1 : 0;
  const result = await this.hub.designSpeech({ workspaceId: workspace, speakerId, text: body.text, textPrompt: body.textPrompt, imageBytes, language });
  let demo = null, warning = null;
  if (result.usable && result.demoAudioUrl) {
   try {
    const bytes = await this.hub.downloadVoiceDemo(result.demoAudioUrl);
    const asset = await this.media.put(workspace, { bytes, mime: 'audio/mpeg', name: `设计音色-${speakerId}.mp3`, role: 'voice', derivedFrom: { kind: 'voice-design', key: sha({ speakerId, at: Date.now() }), speakerId } });
    demo = { assetId: asset.id, fileUrl: `/api/creation/assets/${asset.id}/file` };
   } catch (error) { warning = '音色已设计成功，但试听音频转存失败；可用该音色编号直接试听。'; }
  }
  return { speakerId, status: result.status, usable: result.usable, remaining: result.remaining, resourceId: 'seed-icl-2.0', demo, ...(warning ? { warning } : {}) };
 }
 // ---- 台词合成 ----
 // 按行合成并拼接；调用方保证 state 无 issue。不写数据库（由项目服务写入节点）。
 async synthesizeDialogue(workspace, task, voiceRoles) {
  const state = dubState(task, voiceRoles);
  if (state.issue) fail('DUB_NOT_READY', state.issue);
  const total = state.resolved.reduce((sum, line) => sum + chars(line.text), 0);
  if (total > MAX_DIALOGUE_CHARS) fail('DUB_TEXT_TOO_LONG', `台词合计 ${total} 字，超过单次合成上限 ${MAX_DIALOGUE_CHARS} 字。`);
  const lock = `${workspace}:${task.id}`;
  if (this.synthesizing.has(lock)) fail('DUB_IN_PROGRESS', '这个分镜的配音正在合成，请稍候。', 409);
  this.synthesizing.add(lock);
  try {
   const clips = [], subtitles = []; let textWords = 0;
   for (const line of state.resolved) {
    // 开启 enable_subtitle 取回逐字时间戳（TTS 2.0 / ICL 2.0）；拿不到时字幕按整句显示。
    const result = await this.hub.synthesizeSpeech({ workspaceId: workspace, text: line.text, language: line.language, speaker: line.speaker, resourceId: line.resourceId, speechRate: line.speechRate, emotion: line.emotion, emotionScale: line.emotionScale, loudnessRate: line.loudnessRate, contextText: line.contextText, subtitle: true });
    clips.push(result.bytes); subtitles.push(result.subtitle || null); textWords += result.textWords ?? chars(line.text);
   }
   const joined = await this.audio.join(clips);
   // 每句在拼接音频中的偏移 = 前面各句实际时长 + 行间 0.3 秒；时间戳是各句内部的相对时间。
   const cues = dialogueCues(state.resolved.map((line, index) => ({ text: line.text, language: line.language, subtitle: subtitles[index], duration: joined.lineDurations?.[index] })), { gap: JOIN_GAP_SECONDS, total: joined.durationSec });
   return { bytes: joined.bytes, durationSec: joined.durationSec, textWords, hash: state.hash, lines: state.resolved.length, cues };
  } finally { this.synthesizing.delete(lock); }
 }
 // ---- 后期混音 ----
 async mixDub({ video, audio }) {
  const result = await this.audio.mix({ video, audio });
  return { ...result, bytes: Buffer.from(result.bytes) };
 }
}

export { RATE_RANGE, clamp };
