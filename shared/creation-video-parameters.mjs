export const VIDEO_RESOLUTIONS = ['480P', '768P', '1080P', '2K', '4K'];
export const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];

// Only translate equivalent spellings. Unknown values must survive for validation
// and display; never substitute a different quality, duration or aspect ratio.
export function normalizeVideoParameters(parameters = {}) {
 if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
 const params = { ...parameters };
 if (params.ratio === undefined && params.aspectRatio !== undefined) params.ratio = params.aspectRatio;
 delete params.aspectRatio;
 if (typeof params.resolution === 'string') {
  const value = params.resolution.trim().toUpperCase().replace(/\s/g, '').replace('×', 'X');
  const ratio = { '1080X1920': '9:16', '1920X1080': '16:9' }[value];
  if (ratio) {
   params.resolution = '1080P';
   if (params.ratio === undefined) params.ratio = ratio;
  } else if (VIDEO_RESOLUTIONS.includes(value)) params.resolution = value;
 }
 return params;
}

// H3 默认积分单价（每秒）。渠道 executorConfig.pointPrices 可覆盖。
export const DEFAULT_POINT_PRICES = { '480P': 5, '768P': 10, '1080P': 19, '2K': 20, '4K': 22 };
export const VIDEO_MODES = ['text', 'frames', 'reference'];
export const DUB_MODES = ['post', 'lipsync', 'none'];
export const DIALOGUE_LANGUAGES = ['zh', 'en'];
// H3 素材数量与体积上限。
export const VIDEO_LIMITS = { refImage: 9, refVideo: 3, refAudio: 3, refTotal: 12 };
export const MEDIA_BYTE_LIMITS = { image: 30 * 1024 * 1024, video: 50 * 1024 * 1024, audio: 15 * 1024 * 1024 };
export const MAX_REQUEST_BYTES = 72 * 1024 * 1024;
const SPEECH_CHARS_PER_SECOND = 4;
const SPEECH_WORDS_PER_SECOND = 2.5;
export function pointPricesFor(config) {
 return { ...DEFAULT_POINT_PRICES, ...(config?.pointPrices && typeof config.pointPrices === 'object' ? config.pointPrices : {}) };
}
// 台词时长估算：中文约每秒 4 个字，英文约每秒 2.5 个词。
export function estimateDialogueSeconds(dialogue = []) {
 let seconds = 0;
 for (const line of Array.isArray(dialogue) ? dialogue : []) {
  const text = String(line?.text || '').trim();
  if (!text) continue;
  seconds += line.language === 'en' ? text.split(/\s+/).filter(Boolean).length / SPEECH_WORDS_PER_SECOND : [...text.replace(/\s/g, '')].length / SPEECH_CHARS_PER_SECOND;
 }
 return seconds;
}
// 把台词写成 H3 提示词中的 <d> 段落。
export function dialoguePromptSuffix(dialogue = []) {
 return (Array.isArray(dialogue) ? dialogue : [])
  .map(line => ({ text: String(line?.text || '').replace(/<\/?d>/g, '').trim(), language: line?.language === 'en' ? 'English' : 'Chinese' }))
  .filter(line => line.text)
  .map(line => `<d>[${line.language}] ${line.text}</d>`).join('\n');
}
