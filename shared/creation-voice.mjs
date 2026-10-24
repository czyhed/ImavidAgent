// 火山引擎语音：前后端共用的常量与角色校验（不依赖 Node 内置模块）。
export const VOLC_BASE_URL = 'https://openspeech.bytedance.com';
export const VOLC_RESOURCES = ['seed-tts-2.0', 'seed-icl-2.0'];
export const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
export const VOICE_SOURCES = ['system', 'custom', 'designed'];
export const VOICE_SOURCE_LABEL = { system: '系统音色', custom: '自有音色', designed: '设计音色' };
export const DEFAULT_PREVIEW_TEXT = '你好，这是一段音色试听，欢迎选购这款商品。';
export const MAX_PREVIEW_TEXT = 200;
export const MAX_VOICE_ROLES = 20;
// 单次「合成配音」的台词总字数上限，避免误操作产生过多字符用量。
export const MAX_DIALOGUE_CHARS = 3000;
export const RATE_RANGE = { min: -50, max: 100 };
export const MAX_DUB_SECONDS = 30;

const SPEAKER = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,99}$/;
export const validSpeaker = value => typeof value === 'string' && SPEAKER.test(value);
const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function defaultResourceFor(source) { return source === 'designed' ? 'seed-icl-2.0' : DEFAULT_RESOURCE_ID; }

// 校验并补全一组角色；返回 { roles } 或 { error }。
export function validateVoiceRoles(input) {
 if (!Array.isArray(input) || input.length > MAX_VOICE_ROLES) return { error: `角色最多 ${MAX_VOICE_ROLES} 个。` };
 const ids = new Set(), roles = [];
 for (const role of input) {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return { error: '角色格式无效。' };
  if (typeof role.id !== 'string' || !/^[\w-]{1,100}$/.test(role.id) || ids.has(role.id)) return { error: '角色编号重复或无效。' };
  ids.add(role.id);
  const name = typeof role.name === 'string' ? role.name.trim() : '';
  if (!name || [...name].length > 40) return { error: '角色名称需为 1–40 个字。' };
  const source = role.source ?? 'system';
  if (!VOICE_SOURCES.includes(source)) return { error: '音色来源需为系统音色、自有音色或设计音色。' };
  const speaker = typeof role.speaker === 'string' ? role.speaker.trim() : '';
  if (speaker && !validSpeaker(speaker)) return { error: `角色「${name}」的音色编号只能包含字母、数字、下划线、点和连字符，长度 3–100。` };
  const resourceId = role.resourceId ?? defaultResourceFor(source);
  if (!VOLC_RESOURCES.includes(resourceId)) return { error: '资源 ID 需为 seed-tts-2.0 或 seed-icl-2.0。' };
  const speechRate = role.speechRate ?? 0, loudnessRate = role.loudnessRate ?? 0;
  if (!integerIn(speechRate, RATE_RANGE.min, RATE_RANGE.max) || !integerIn(loudnessRate, RATE_RANGE.min, RATE_RANGE.max)) return { error: '语速和音量需为 -50 到 100 的整数。' };
  const emotion = role.emotion ?? '';
  if (typeof emotion !== 'string' || !/^[a-z_]{0,32}$/.test(emotion)) return { error: '情感需为英文小写标识，例如 happy。' };
  const emotionScale = role.emotionScale ?? 4;
  if (!integerIn(emotionScale, 1, 5)) return { error: '情感强度需为 1–5 的整数。' };
  const contextText = role.contextText ?? '';
  if (typeof contextText !== 'string' || [...contextText].length > 200) return { error: '语气提示不超过 200 个字。' };
  roles.push({ id: role.id, name, speaker, source, resourceId, speechRate, emotion, emotionScale, loudnessRate, contextText });
 }
 return { roles };
}
