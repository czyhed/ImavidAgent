import { VIDEO_MODES, DIALOGUE_LANGUAGES, VIDEO_LIMITS } from '../shared/creation-video-parameters.mjs';

// AI 生成分镜（V-16）：素材清单、模型输出的校验与修正。纯函数，不访问数据库，便于测试。
// 素材编号 M1、M2…只在一次建议内有效；建议里不含任何 URL。

export const SHOT_SLOTS = ['first', 'last', 'refImage', 'refVideo', 'refAudio'];
const SLOT_KIND = { first: 'image', last: 'image', refImage: 'image', refVideo: 'video', refAudio: 'audio' };
const SLOT_LABEL = { first: '首帧', last: '尾帧', refImage: '参考图', refVideo: '参考视频', refAudio: '参考音频' };
const MODE_LABEL = { text: '文生视频', frames: '首尾帧', reference: '参考素材' };
const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };
export const MAX_PLAN_MATERIALS = 40;

export const SHOT_PLANNING_SYSTEM = [
 '你是电商短视频分镜师。把脚本拆成 3 到 12 个分镜，并为每个分镜选择视频生成方式与素材。商品事实不得猜测。',
 '输出纯 JSON：{"shots":[{"title","description","videoMode","duration","prompt","materials","dialogue"}]}。',
 'title 是分镜名；description 描述画面内容；duration 为 4-30 的整数秒；prompt 是给视频生成模型的画面提示词，具体可执行。',
 'videoMode 只能是 text（文生视频，不用素材）、frames（首尾帧）、reference（参考素材）。',
 'materials 是素材清单 materials 里的编号引用：[{"key":"M1","slot":"first|last|refImage|refVideo|refAudio"}]；只能使用清单里给出的编号，不得编造。slot 与素材类型必须一致：first、last、refImage 用图片，refVideo 用视频，refAudio 用音频。',
 'H3 规则：frames 方式只能用 first 和 last（图片，各最多 1 张，至少 1 张），不能混用任何参考素材；reference 方式不能用 first、last，参考图 refImage 最多 9 张、参考视频 refVideo 最多 3 个、参考音频 refAudio 最多 3 个，合计最多 12 个，且参考音频不能单独使用，必须同时有参考图或参考视频；text 方式不用素材。',
 '在 prompt 里用 {{M1}} 的形式引用 reference 方式下的参考素材（例如“参考 {{M1}} 的杯身造型，动作节奏参考 {{M2}}”）；first、last 不要在 prompt 里引用。',
 'dialogue 可选，格式 [{"text","language":"zh|en"}]；只有脚本或要求明确需要角色开口说话（口型同步）时才安排台词，否则省略。',
 '没有合适素材时用 text 方式，不要强行使用素材。',
].join('');

// 把素材目录转为交给模型的清单：编号、类型、名称、来源说明，不含 URL 与内部编号。
export function materialsForModel(catalog) {
 return catalog.map(item => ({ key: item.key, type: item.kind, name: item.name, source: item.origin }));
}

const trimText = (value, max) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const languageOf = value => {
 const text = String(value || '').trim().toLowerCase();
 if (DIALOGUE_LANGUAGES.includes(text)) return text;
 if (['english', 'en-us', 'en-gb', '英文', '英语'].includes(text)) return 'en';
 return 'zh';
};

// 校验并修正模型输出的一个分镜。catalog 是本次建议的素材目录（以 key 为索引）。
// 返回 {title,description,videoMode,duration,prompt,materials:[{key,slot}],dialogue,notes:[]}。
export function sanitizeShotPlan(raw, index, catalogByKey) {
 const notes = [];
 const shot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
 const title = trimText(shot.title, 100) || `分镜 ${index + 1}`;
 const description = trimText(shot.description, 4000);
 let duration = Math.round(Number(shot.duration));
 if (!Number.isFinite(duration)) duration = 5;
 if (duration < 4 || duration > 30) { notes.push(`时长 ${shot.duration} 秒不在 4～30 秒范围内，已调整为 ${Math.min(30, Math.max(4, duration))} 秒。`); duration = Math.min(30, Math.max(4, duration)); }
 // 素材引用：未知编号、类型与槽位不符、重复引用逐条丢弃并说明。
 const picked = [];
 for (const item of Array.isArray(shot.materials) ? shot.materials : []) {
  const key = typeof item?.key === 'string' ? item.key.trim().toUpperCase() : '';
  const slot = typeof item?.slot === 'string' ? item.slot.trim() : '';
  const material = catalogByKey.get(key);
  if (!material) { notes.push(`素材编号「${key || String(item?.key ?? '空')}」不在可用素材清单中，已忽略。`); continue; }
  if (!SHOT_SLOTS.includes(slot)) { notes.push(`素材 ${key}（${material.name}）的用途「${slot || '空'}」无效，已忽略。`); continue; }
  if (SLOT_KIND[slot] !== material.kind) { notes.push(`素材 ${key}（${material.name}）是${KIND_LABEL[material.kind]}，不能作为${SLOT_LABEL[slot]}，已忽略。`); continue; }
  if (picked.some(p => p.key === key && p.slot === slot) || (['first', 'last'].includes(slot) && picked.some(p => p.slot === slot))) { notes.push(`素材 ${key} 或${SLOT_LABEL[slot]}重复安排，已忽略多余的一项。`); continue; }
  picked.push({ key, slot });
 }
 let videoMode = typeof shot.videoMode === 'string' ? shot.videoMode.trim() : '';
 if (!VIDEO_MODES.includes(videoMode)) {
  if (videoMode) notes.push(`视频方式「${videoMode}」无效，已按素材重新判断。`);
  videoMode = picked.some(p => ['first', 'last'].includes(p.slot)) ? 'frames' : picked.length ? 'reference' : 'text';
 }
 // 方式规则（H3）：违反时降级为文生视频，不带素材。
 const count = slot => picked.filter(p => p.slot === slot).length;
 const frames = count('first') + count('last'), refs = count('refImage') + count('refVideo') + count('refAudio');
 let issue = null;
 if (videoMode === 'frames') {
  if (!frames) issue = '首尾帧方式没有可用的首帧或尾帧图片';
  else if (refs) issue = '首尾帧方式不能混用参考素材';
 } else if (videoMode === 'reference') {
  if (frames) issue = '参考素材方式不能混用首帧或尾帧';
  else if (count('refImage') > VIDEO_LIMITS.refImage) issue = `参考图超过 ${VIDEO_LIMITS.refImage} 张`;
  else if (count('refVideo') > VIDEO_LIMITS.refVideo) issue = `参考视频超过 ${VIDEO_LIMITS.refVideo} 个`;
  else if (count('refAudio') > VIDEO_LIMITS.refAudio) issue = `参考音频超过 ${VIDEO_LIMITS.refAudio} 个`;
  else if (refs > VIDEO_LIMITS.refTotal) issue = `参考素材合计超过 ${VIDEO_LIMITS.refTotal} 个`;
  else if (!count('refImage') && !count('refVideo')) issue = count('refAudio') ? '参考音频不能单独使用' : '参考素材方式没有可用的参考图或参考视频';
 }
 let materials = picked;
 if (issue) {
  notes.push(`${issue}，已改为${MODE_LABEL.text}并移除该分镜的素材。`);
  videoMode = 'text'; materials = [];
 } else if (videoMode === 'text' && picked.length) {
  notes.push('文生视频不使用素材，已移除该分镜的素材。');
  materials = [];
 }
 // 提示词：只保留引用了本分镜参考素材的 {{Mk}}，其余标签移除；首尾帧不使用标签。
 const refKeys = new Set(materials.filter(m => ['refImage', 'refVideo', 'refAudio'].includes(m.slot)).map(m => m.key));
 let prompt = trimText(shot.prompt, 7000).replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_, rawKey) => {
  const key = String(rawKey).toUpperCase();
  if (refKeys.has(key)) return `{{${key}}}`;
  if (catalogByKey.has(key) && materials.some(m => m.key === key)) return '';
  notes.push(`提示词里的标签 {{${rawKey}}} 没有对应的参考素材，已移除。`);
  return '';
 }).replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。,.；;！!？?])/g, '$1').trim();
 if (!prompt) prompt = description;
 const dialogue = (Array.isArray(shot.dialogue) ? shot.dialogue : []).slice(0, 20)
  .map(line => ({ text: trimText(line?.text, 2000), language: languageOf(line?.language) })).filter(line => line.text);
 return { title, description, videoMode, duration, prompt, materials, dialogue, notes: [...new Set(notes)] };
}

// 把清理后的分镜加上素材名称，作为界面预览（不含 URL）。
export function previewShot(plan, catalogByKey) {
 return {
  title: plan.title, description: plan.description, videoMode: plan.videoMode, duration: plan.duration, prompt: plan.prompt,
  materials: plan.materials.map(m => { const item = catalogByKey.get(m.key); return { key: m.key, slot: m.slot, kind: item.kind, name: item.name, origin: item.origin, assetId: item.assetId }; }),
  dialogue: plan.dialogue, notes: plan.notes,
 };
}
