import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validateUrl, boundedBytes } from './creation-http.mjs';

// 火山引擎豆包语音：语音合成 V3（HTTP Chunked 单向流式）与音色设计。
// 渠道只保存 API Key；密钥只出现在请求头，错误信息不含密钥与原始响应头。

import { VOLC_BASE_URL, VOLC_RESOURCES, DEFAULT_RESOURCE_ID } from '../../shared/creation-voice.mjs';
export { VOLC_BASE_URL, VOLC_RESOURCES, DEFAULT_RESOURCE_ID };
export const TTS_PATH = '/api/v3/tts/unidirectional';
export const DESIGN_PATH = '/api/v3/tts/voice_design';
export const TTS_TIMEOUT_MS = 120000;
export const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;

const SUCCESS_CODES = new Set([0, 20000000]);
const ERROR_TEXT = {
 45000000: '音色未授权或不存在，请检查所选音色与资源 ID。',
 40402003: '文本长度超过语音合成的上限，请缩短台词。',
 45001123: '这个音色的设计次数已用尽，请更换音色编号后再试。',
};

export function volcError(code, status) {
 if (ERROR_TEXT[code]) return new AppError(code === 45001123 ? 'VOICE_DESIGN_EXHAUSTED' : 'VOICE_REJECTED', ERROR_TEXT[code], 422);
 if (status === 401 || status === 403) return new AppError('VOICE_AUTH_FAILED', '火山引擎语音 API Key 无效或没有权限，请在模型中心检查渠道。', 502);
 if (status === 429) return new AppError('VOICE_RATE_LIMITED', '语音合成请求过于频繁，请稍后重试。', 502);
 if (code === 55000000 || status >= 500) return new AppError('VOICE_PROVIDER_ERROR', '火山引擎语音服务暂时出错，请稍后重试。', 502);
 if (Number.isInteger(code) && String(code).startsWith('4')) return new AppError('VOICE_REJECTED', '语音服务拒绝了这次请求，请检查音色、文本和参数。', 422);
 return new AppError('VOICE_PROVIDER_ERROR', '语音服务返回了无法识别的结果，请稍后重试。', 502);
}

// 流式解析：响应是连续的 JSON 对象，不保证一行一个，也可能被网络切分在任意位置。
// 按花括号深度（忽略字符串内的括号）拆分，每个完整对象交给 onObject。
export class JsonStream {
 constructor(onObject) {
  this.onObject = onObject; this.buffer = ''; this.depth = 0; this.inString = false; this.escaped = false; this.start = -1; this.scanned = 0;
 }
 push(text) {
  this.buffer += text;
  for (let i = this.scanned; i < this.buffer.length; i++) {
   const char = this.buffer[i];
   if (this.inString) {
    if (this.escaped) this.escaped = false;
    else if (char === '\\') this.escaped = true;
    else if (char === '"') this.inString = false;
    continue;
   }
   if (char === '"') { if (this.depth > 0) this.inString = true; }
   else if (char === '{') { if (this.depth === 0) this.start = i; this.depth += 1; }
   else if (char === '}' && this.depth > 0) {
    this.depth -= 1;
    if (this.depth === 0) {
     const raw = this.buffer.slice(this.start, i + 1);
     this.buffer = this.buffer.slice(i + 1); this.scanned = 0; this.start = -1; i = -1;
     let parsed;
     try { parsed = JSON.parse(raw); } catch { throw new AppError('VOICE_RESPONSE_INVALID', '语音服务返回的数据格式无效。', 502); }
     this.onObject(parsed);
    }
   }
  }
  this.scanned = this.buffer.length;
  // SSE 风格的 data: 前缀与空白落在对象之间，丢弃已经确认不属于对象的部分。
  if (this.depth === 0) { this.buffer = ''; this.scanned = 0; }
 }
 get pending() { return this.depth !== 0; }
}

function ttsBody({ text, speaker, emotion, emotionScale, speechRate, loudnessRate, language, contextText, subtitle }) {
 const audio = { format: 'mp3', sample_rate: 24000 };
 if (emotion) { audio.emotion = emotion; if (Number.isFinite(emotionScale)) audio.emotion_scale = emotionScale; }
 if (Number.isFinite(speechRate) && speechRate !== 0) audio.speech_rate = speechRate;
 if (Number.isFinite(loudnessRate) && loudnessRate !== 0) audio.loudness_rate = loudnessRate;
 if (subtitle) audio.enable_subtitle = true;
 const additions = {};
 // 中文不指定语种（默认中英混读）；其他语种代码（如 en、ja）原样指定。
 if (typeof language === 'string' && /^[a-z]{2}(-[a-z]{2})?$/.test(language) && language !== 'zh') additions.explicit_language = language;
 if (contextText) additions.context_texts = [contextText];
 // additions 是 JSON 字符串，不是对象。
 return { user: { uid: 'shangjing' }, req_params: { text, speaker, audio_params: audio, ...(Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}) } };
}

export function ttsHeaders(channel, resourceId, requestId = randomUUID()) {
 return { 'X-Api-Key': channel.apiKey, 'X-Api-Resource-Id': resourceId, 'X-Api-Request-Id': requestId, 'X-Control-Require-Usage-Tokens-Return': 'text_words', 'Content-Type': 'application/json', Accept: 'application/json' };
}

// 合成一段文本。返回 { bytes, mime, textWords, subtitle, logId }。
export async function synthesize(transport, channel, params) {
 const text = String(params?.text || '').trim();
 const speaker = String(params?.speaker || '').trim();
 if (!text) throw new AppError('VOICE_TEXT_REQUIRED', '请填写要合成的文本。', 422);
 if (!speaker) throw new AppError('VOICE_SPEAKER_REQUIRED', '请先选择音色。', 422);
 const resourceId = VOLC_RESOURCES.includes(params.resourceId) ? params.resourceId : (channel.executorConfig?.resourceId || DEFAULT_RESOURCE_ID);
 const url = validateUrl((channel.baseUrl || VOLC_BASE_URL).replace(/\/$/, '') + TTS_PATH, { local: true });
 let response;
 try {
  response = await transport(url.href, { method: 'POST', headers: ttsHeaders(channel, resourceId), body: JSON.stringify(ttsBody({ ...params, text, speaker })), redirect: 'manual', signal: AbortSignal.timeout(TTS_TIMEOUT_MS), providerLocal: true });
 } catch { throw new AppError('VOICE_TRANSPORT_FAILED', '连接火山引擎语音服务失败或超时，请稍后重试。', 502); }
 const logId = response.headers?.get?.('x-tt-logid') || null;
 if (!response.ok) {
  let code = null;
  try { code = JSON.parse((await boundedBytes(response, 64 * 1024)).toString('utf8'))?.code ?? null; } catch { await response.body?.cancel?.().catch(() => {}); }
  throw volcError(code, response.status);
 }
 const chunks = [], subtitles = [];
 let finished = false, textWords = null, size = 0, failure = null;
 const parser = new JsonStream(object => {
  const code = Number(object.code ?? 0);
  if (!SUCCESS_CODES.has(code)) { failure = failure || volcError(code, 200); return; }
  if (typeof object.data === 'string' && object.data) {
   const piece = Buffer.from(object.data, 'base64');
   size += piece.length;
   if (size > MAX_TTS_AUDIO_BYTES) { failure = failure || new AppError('VOICE_RESULT_TOO_LARGE', '合成的音频过大，请缩短台词。', 502); return; }
   chunks.push(piece);
  }
  if (object.sentence) subtitles.push(object.sentence);
  if (code === 20000000) { finished = true; if (Number.isFinite(object.usage?.text_words)) textWords = object.usage.text_words; }
 });
 try {
  if (response.body) {
   const decoder = new TextDecoder('utf-8');
   for await (const chunk of response.body) { parser.push(decoder.decode(chunk, { stream: true })); if (failure) break; }
   parser.push(decoder.decode());
  }
 } catch (error) {
  if (error instanceof AppError) throw error;
  throw new AppError('VOICE_TRANSPORT_FAILED', '语音数据接收中断，请重试。', 502);
 }
 if (failure) throw failure;
 if (!finished || parser.pending) throw new AppError('VOICE_RESPONSE_INCOMPLETE', '语音服务没有返回完整的音频，请重试。', 502);
 const bytes = Buffer.concat(chunks);
 if (!bytes.length) throw new AppError('VOICE_EMPTY', '语音服务没有返回音频内容。', 502);
 return { bytes, mime: 'audio/mpeg', textWords, ...(params.subtitle ? { subtitle: subtitles } : {}), logId };
}

// 音色设计：用文字描述或人物图设计新音色；次数用尽返回中文提示。
export async function designVoice(transport, channel, { speakerId, text, textPrompt, imageBytes, language = 0 } = {}) {
 const id = String(speakerId || '').trim();
 if (!/^[A-Za-z0-9_-]{3,100}$/.test(id)) throw new AppError('VOICE_SPEAKER_INVALID', '音色编号需为 3–100 位字母、数字、下划线或连字符。', 422);
 const sample = String(text || '').trim();
 if (!sample || [...sample].length > 300) throw new AppError('VOICE_DESIGN_TEXT', '试听文本需为 1–300 个字。', 422);
 const prompt = {};
 if (imageBytes) {
  const bytes = Buffer.from(imageBytes);
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new AppError('VOICE_DESIGN_IMAGE', '人物图需小于 10 MB。', 422);
  prompt.image_prompt = { image_bytes: bytes.toString('base64') };
 } else {
  const description = String(textPrompt || '').trim();
  if (!description || [...description].length > 200) throw new AppError('VOICE_DESIGN_PROMPT', '音色描述需为 1–200 个字。', 422);
  prompt.text_prompt = description;
 }
 const url = validateUrl((channel.baseUrl || VOLC_BASE_URL).replace(/\/$/, '') + DESIGN_PATH, { local: true });
 let response;
 try {
  response = await transport(url.href, { method: 'POST', headers: { 'X-Api-Key': channel.apiKey, 'X-Api-Request-Id': randomUUID(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ speaker_id: id, text: sample, prompt, language: Number(language) === 1 ? 1 : 0 }), redirect: 'manual', signal: AbortSignal.timeout(TTS_TIMEOUT_MS), providerLocal: true });
 } catch { throw new AppError('VOICE_TRANSPORT_FAILED', '连接火山引擎语音服务失败或超时，请稍后重试。', 502); }
 let data = null;
 try { data = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString('utf8')); } catch (error) { if (response.ok) throw new AppError('VOICE_RESPONSE_INVALID', '音色设计返回的数据格式无效。', 502); }
 const code = data?.code ?? data?.header?.code ?? data?.error?.code;
 if (!response.ok || (code && !SUCCESS_CODES.has(Number(code)))) throw volcError(Number(code), response.status);
 const body = data?.data && typeof data.data === 'object' ? data.data : data;
 const status = Number(body?.status);
 return {
  status: Number.isFinite(status) ? status : null,
  usable: status === 2 || status === 4,
  demoAudioUrl: typeof body?.demo_audio === 'string' ? body.demo_audio : null,
  remaining: Number.isFinite(body?.available_training_times) ? body.available_training_times : null,
 };
}

// 试听音频 1 小时过期：由服务端下载后转存，避免链接失效。
export async function downloadDemoAudio(transport, url) {
 let target = String(url);
 for (let hops = 0; hops <= 3; hops++) {
  const checked = validateUrl(target);
  let response;
  try { response = await transport(checked.href, { redirect: 'manual', signal: AbortSignal.timeout(60000) }); } catch { throw new AppError('VOICE_DEMO_DOWNLOAD', '试听音频下载失败，请重试。', 502); }
  if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel?.(); if (!location) break; target = new URL(location, checked).href; continue; }
  if (!response.ok) { await response.body?.cancel?.(); throw new AppError('VOICE_DEMO_DOWNLOAD', '试听音频下载失败，请重试。', 502); }
  return boundedBytes(response, MAX_TTS_AUDIO_BYTES);
 }
 throw new AppError('VOICE_DEMO_DOWNLOAD', '试听音频下载失败，请重试。', 502);
}
