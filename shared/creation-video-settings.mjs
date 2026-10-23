import { VIDEO_RESOLUTIONS, VIDEO_RATIOS, normalizeVideoParameters } from './creation-video-parameters.mjs';

// 视频工作台项目级参数（W4）：分辨率、比例、默认时长，存在 storyboard.settings。
// 分镜节点 params 里没有写的键跟随项目设置；写了的键就是该镜的「自定义」覆盖。
export const SETTING_KEYS = ['resolution', 'ratio', 'duration'];
// V-04 的项目默认值：没有设置、节点也没有显式值时，界面按此展示与比较。
export const SETTING_DEFAULTS = { resolution: '768P', ratio: '9:16', duration: 5 };
// 项目级比例不含 adaptive（跟随首帧依赖具体分镜是否有图片，只能按镜覆盖）。
export const SETTING_RATIOS = VIDEO_RATIOS.filter(ratio => ratio !== 'adaptive');

// 严格校验：返回 { settings } 或 { error }。undefined / 空对象视为「没有设置」。
export function checkVideoSettings(input) {
 if (input === undefined || input === null) return { settings: null };
 if (typeof input !== 'object' || Array.isArray(input)) return { error: '项目视频参数需要是对象。' };
 const settings = {};
 for (const key of Object.keys(input)) {
  if (!SETTING_KEYS.includes(key)) return { error: `项目视频参数不支持「${key}」。` };
  const value = input[key];
  if (value === undefined || value === null) continue;
  if (key === 'resolution') { if (!VIDEO_RESOLUTIONS.includes(value)) return { error: `分辨率需为 ${VIDEO_RESOLUTIONS.join('、')} 之一。` }; }
  else if (key === 'ratio') { if (!SETTING_RATIOS.includes(value)) return { error: `画面比例需为 ${SETTING_RATIOS.join('、')} 之一。` }; }
  else if (!Number.isInteger(value) || value < 4 || value > 30) return { error: '默认时长需为 4–30 的整数秒。' };
  settings[key] = value;
 }
 return { settings: Object.keys(settings).length ? settings : null };
}

// 宽松规范化（读取已存数据）：丢弃无效键，不抛错。
export function normalizeVideoSettings(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
 const settings = {};
 for (const key of SETTING_KEYS) {
  const { settings: one } = checkVideoSettings({ [key]: input[key] });
  if (one?.[key] !== undefined) settings[key] = one[key];
 }
 return Object.keys(settings).length ? settings : null;
}

// 分镜节点的有效参数：项目设置（补齐 V-04 默认值）之下叠加节点显式 params。
// 没有项目设置时原样返回节点 params，旧项目行为不变。
export function effectiveVideoParams(settings, params) {
 const own = normalizeVideoParameters(params || {});
 const base = normalizeVideoSettings(settings);
 if (!base) return own;
 return { ...SETTING_DEFAULTS, ...base, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)) };
}

// 节点上与有效项目设置不同的显式键（即「自定义」）。显式值等于项目值时不算自定义。
export function customVideoKeys(settings, params) {
 const inherited = { ...SETTING_DEFAULTS, ...(normalizeVideoSettings(settings) || {}) };
 const own = normalizeVideoParameters(params || {});
 return SETTING_KEYS.filter(key => own[key] !== undefined && own[key] !== inherited[key]);
}
