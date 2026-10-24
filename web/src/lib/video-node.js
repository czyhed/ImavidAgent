import { DEFAULT_POINT_PRICES, pointPricesFor, VIDEO_LIMITS } from '../../../shared/creation-video-parameters.mjs';

// 视频节点端口、方式与素材编号规则：与 server/creation-projects.mjs 的 resolveVideoInputs 保持一致。
export const VIDEO_MODE_LABEL = { text: '文字', frames: '首尾帧', reference: '全能参考' };
export const VIDEO_MODE_ORDER = ['text', 'frames', 'reference'];
export const PORT_LABEL = { prompt: '提示词', first: '首帧', last: '尾帧', refImage: '参考图', refVideo: '参考视频', refAudio: '参考音频', audio: '音频', video: '视频', image: '图片', text: '文本' };
export const VIDEO_PORT_ORDER = ['first', 'last', 'refImage', 'refVideo', 'refAudio'];
export const VIDEO_PORT_LIMIT = { first: 1, last: 1, refImage: VIDEO_LIMITS.refImage, refVideo: VIDEO_LIMITS.refVideo, refAudio: VIDEO_LIMITS.refAudio };
export const VIDEO_PORT_TYPE = { prompt: 'text', first: 'image', last: 'image', refImage: 'image', refVideo: 'video', refAudio: 'audio' };
const PORTS_BY_MODE = { text: ['prompt'], frames: ['prompt', 'first', 'last'], reference: ['prompt', 'refImage', 'refVideo', 'refAudio'] };
const ROLE = { first: 'first_frame', last: 'last_frame', refImage: 'reference_image', refVideo: 'reference_video', refAudio: 'reference_audio' };
const REF_PORTS = ['refImage', 'refVideo', 'refAudio'];
const TAG = /\{\{ref:([^}]*)\}\}/g;
// 来源节点输出的类型 → 视频节点默认端口（与服务端按类型推断一致）。
const DEFAULT_TARGET = { image: 'first', video: 'refVideo', audio: 'refAudio', text: 'prompt' };
export const MEDIA_RULES = {
 audio: { label: '音频', accept: 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a', mimes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'], extensions: { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }, maxBytes: 15 * 1024 * 1024, hint: 'mp3 / wav / m4a，单个不超过 15 MiB' },
 footage: { label: '视频', accept: 'video/mp4,video/webm,.mp4,.webm', mimes: ['video/mp4', 'video/webm'], extensions: { mp4: 'video/mp4', webm: 'video/webm' }, maxBytes: 50 * 1024 * 1024, hint: 'mp4 / webm，单个不超过 50 MiB' },
};

export function portsForMode(mode) { return PORTS_BY_MODE[mode] || PORTS_BY_MODE.text; }
// 来源节点的输出类型：product 有 text / image 两个输出，其余节点只有一个。
const OUT_TYPE = { image: 'image', audio: 'audio', footage: 'video', prompt: 'text', generate: 'image', edit: 'image', composite: 'image', video: 'video' };
export function targetHandleOf(edge, tasks) {
 if (edge.targetHandle) return edge.targetHandle;
 const source = tasks.find(t => t.id === edge.source);
 const type = source?.kind === 'product' ? (edge.sourceHandle === 'text' ? 'text' : 'image') : OUT_TYPE[source?.kind];
 return DEFAULT_TARGET[type] || null;
}
// 方式推断：显式 videoMode 优先；旧节点按服务端规则（有首帧 / 尾帧素材为首尾帧，否则文字）。
export function inferVideoMode(task, edges, tasks = []) {
 if (VIDEO_MODE_ORDER.includes(task.videoMode)) return task.videoMode;
 const handles = edges.filter(e => e.target === task.id).map(e => targetHandleOf(e, tasks));
 return handles.includes('first') || handles.includes('last') || task.sourceAssetId || task.sourceRunId ? 'frames' : 'text';
}
export function ratioNeedsImage(items) { return items.some(item => item.kind === 'image'); }

const KIND_NOTE = { image: '图片', video: '视频', audio: '音频' };
// 视频节点已接入素材：items 为当前方式使用的素材，unused 为已存在但当前方式不使用的连线。
export function analyzeVideoNode(task, { edges, tasks, runs = [] }) {
 const mode = inferVideoMode(task, edges, tasks);
 const active = new Set(portsForMode(mode));
 const incoming = edges.filter(e => e.target === task.id);
 // 上一镜尾帧只在显式选择的首尾帧方式下生效：低于首帧连线、高于节点自带素材（与服务端一致）。
 const tail = task.videoMode === 'frames' && task.tailFrame?.fromNodeId ? task.tailFrame : null;
 const firstEdge = incoming.some(e => targetHandleOf(e, tasks) === 'first');
 const taskFirst = !tail && (task.sourceAssetId || task.sourceRunId) && mode !== 'text' && mode !== 'reference';
 const all = [], unused = [];
 if (tail && !firstEdge) all.push({ port: 'first', role: ROLE.first, kind: 'image', sourceTaskId: null, edgeId: null, title: tail.assetId ? '上一镜尾帧' : '上一镜尾帧（等待截取）', asset: tail.assetId || null, own: true, tail: true, pending: !tail.assetId });
 if (taskFirst) all.push({ port: 'first', role: ROLE.first, kind: 'image', sourceTaskId: null, edgeId: null, title: '本节点首帧', asset: task.sourceAssetId || runs.find(r => r.id === task.sourceRunId)?.output?.assetId || null, own: true });
 for (const port of VIDEO_PORT_ORDER) {
  for (const edge of incoming.filter(e => targetHandleOf(e, tasks) === port)) {
   const source = tasks.find(t => t.id === edge.source);
   if (!source) continue;
   if (!active.has(port)) { unused.push({ edgeId: edge.id, port, title: source.title }); continue; }
   if (port === 'first' && taskFirst) continue;
   all.push({ port, role: ROLE[port], kind: VIDEO_PORT_TYPE[port], sourceTaskId: source.id, edgeId: edge.id, title: source.title, asset: thumbnailAsset(source, runs), sourceKind: source.kind, own: false });
  }
 }
 // 编号规则与服务端一致：参考素材按端口与连线顺序依次编号，首帧 / 尾帧不编号。
 const counters = { image: 0, video: 0, audio: 0 }, labelOf = new Map();
 for (const item of all) {
  if (item.port === 'first' || item.port === 'last') { item.label = item.port === 'first' ? '首帧' : '尾帧'; continue; }
  counters[item.kind] += 1;
  item.index = counters[item.kind];
  item.label = `${{ image: 'Picture', video: 'Video', audio: 'Audio' }[item.kind]} ${item.index}`;
  if (!labelOf.has(item.sourceTaskId) || labelOf.get(item.sourceTaskId).kind !== item.kind) labelOf.set(item.sourceTaskId, { kind: item.kind, label: item.label });
 }
 const refCount = all.filter(item => REF_PORTS.includes(item.port)).length;
 return { mode, items: all, unused, labelOf, refCount, hasImage: ratioNeedsImage(all) };
}
function thumbnailAsset(source, runs) {
 if (['generate', 'edit', 'composite', 'video'].includes(source.kind)) return runs.filter(r => r.taskId === source.id && r.status === 'succeeded' && r.output?.assetId).at(-1)?.output?.assetId || null;
 return source.sourceAssetId || null;
}
// 提示词标签预览：把 {{ref:节点}} 换算成与提交时相同的 Picture / Video / Audio 编号。
export function tagSegments(prompt, analysis) {
 const parts = [];
 let last = 0;
 for (const match of String(prompt || '').matchAll(TAG)) {
  if (match.index > last) parts.push({ type: 'text', text: prompt.slice(last, match.index) });
  const ref = match[1];
  const item = analysis.items.find(i => i.sourceTaskId === ref && ref);
  if (!item) parts.push({ type: 'tag', status: 'removed', raw: match[0], ref, text: '已移除的素材' });
  else if (item.port === 'first' || item.port === 'last') parts.push({ type: 'tag', status: 'frame', raw: match[0], ref, text: `${item.label}不使用标签`, title: item.title });
  else parts.push({ type: 'tag', status: 'ok', raw: match[0], ref, text: analysis.labelOf.get(ref).label, title: item.title });
  last = match.index + match[0].length;
 }
 if (last < String(prompt || '').length) parts.push({ type: 'text', text: prompt.slice(last) });
 return parts;
}
export const hasTags = prompt => /\{\{ref:[^}]*\}\}/.test(String(prompt || ''));

// 积分预估：单价（渠道可覆盖）× 时长，未填写时按 768P、5 秒，与服务端 preview 一致。
export function estimateVideoPoints(params, executorConfig) {
 const prices = pointPricesFor(executorConfig);
 const price = prices[params?.resolution || '768P'];
 if (!Number.isFinite(price)) return null;
 return Math.round(price * (Number.isInteger(params?.duration) ? params.duration : 5) * 100) / 100;
}
export const pointText = value => `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')} 积分`;
export { DEFAULT_POINT_PRICES };

// 连线前校验：与服务端 graph() 的单端口上限和参考合计相同；其余组合（如只有参考音频）交给预览判断。
export function videoConnectIssue(target, targetHandle, edges, tasks) {
 const incoming = edges.filter(e => e.target === target.id);
 const count = handle => incoming.filter(e => targetHandleOf(e, tasks) === handle).length;
 const limit = VIDEO_PORT_LIMIT[targetHandle];
 if (limit && count(targetHandle) >= limit) {
  if (limit === 1) return '该输入端口只能连接一条连线。';
  return `视频节点的${{ refImage: '参考图片', refVideo: '参考视频', refAudio: '参考音频' }[targetHandle]}最多连接 ${limit} 个。`;
 }
 if (REF_PORTS.includes(targetHandle) && REF_PORTS.reduce((sum, handle) => sum + count(handle), 0) >= VIDEO_LIMITS.refTotal) return `视频节点的参考素材合计最多 ${VIDEO_LIMITS.refTotal} 个。`;
 return null;
}

// 上传前校验素材类型与大小。返回 { error } 或 { mime }（浏览器给出的 type 可能为空，按扩展名补全）。
export function validateMediaFile(kind, file) {
 const rule = MEDIA_RULES[kind];
 if (!rule || !file) return { error: '不支持的素材类型。' };
 const extension = String(file.name || '').split('.').pop().toLowerCase();
 const mime = rule.extensions[extension];
 if (!mime || (file.type && !rule.mimes.includes(file.type))) return { error: `${rule.label}仅支持 ${rule.hint.split('，')[0]}。` };
 if (file.size > rule.maxBytes) return { error: `${rule.label}不能超过 ${Math.round(rule.maxBytes / 1024 / 1024)} MiB（当前 ${(file.size / 1024 / 1024).toFixed(1)} MiB）。` };
 if (!file.size) return { error: '文件为空。' };
 return { mime };
}
export { KIND_NOTE };
