// 视频工作台的纯逻辑：项目级参数继承、素材 ⇄ 画布节点 / 连线映射、问题标记、连播清单与合计。
// 不依赖 React，便于单元测试；界面在 components/CreationVideoStudio.jsx 与 VideoStudioParts.jsx。
import { normalizeVideoParameters } from '../../../shared/creation-video-parameters.mjs';
import { SETTING_DEFAULTS, normalizeVideoSettings, effectiveVideoParams, customVideoKeys } from '../../../shared/creation-video-settings.mjs';
import { VIDEO_PORT_LIMIT, VIDEO_PORT_TYPE, targetHandleOf, videoConnectIssue, tagSegments, estimateVideoPoints, analyzeVideoNode } from './video-node.js';

export { customVideoKeys };
// 方式 → 工作台显示的素材槽位（与 video-node.js 的 PORTS_BY_MODE 去掉 prompt 一致）。
export const SLOT_BY_MODE = { text: [], frames: ['first', 'last'], reference: ['refImage', 'refVideo', 'refAudio'] };
export const SLOT_LABEL = { first: '首帧', last: '尾帧', refImage: '参考图', refVideo: '参考视频', refAudio: '参考音频' };
// 槽位 → 自动创建的输入节点类型与输出端口。
const INPUT_NODE = { image: { kind: 'image', handle: 'image' }, video: { kind: 'footage', handle: 'video' }, audio: { kind: 'audio', handle: 'audio' } };
const EXECUTABLE = new Set(['generate', 'edit', 'composite', 'video']);

// ---------- 项目级参数 ----------
export const projectSettings = storyboard => normalizeVideoSettings(storyboard?.settings) || {};
// 顶部条显示的值：项目设置补齐 V-04 默认值。
export const shownSettings = storyboard => ({ ...SETTING_DEFAULTS, ...projectSettings(storyboard) });
// 分镜节点的有效参数（用于时长合计、积分预估、参数区显示）。没有项目设置且节点没写时，保持「模型默认」的空值。
export const shotParams = (storyboard, task) => effectiveVideoParams(storyboard?.settings, task?.params);
export const shotDuration = (storyboard, task) => { const d = shotParams(storyboard, task).duration; return Number.isInteger(d) ? d : SETTING_DEFAULTS.duration; };
export const shotCustomKeys = (storyboard, task) => (task ? customVideoKeys(storyboard?.settings, task.params) : []);
const omit = (params, keys) => Object.fromEntries(Object.entries(normalizeVideoParameters(params || {})).filter(([key]) => !keys.includes(key)));
// 清除分镜上的覆盖，恢复跟随项目。
export const followProjectParams = (task, keys = ['resolution', 'ratio', 'duration']) => omit(task.params, keys);

// 修改一个项目级参数：写入完整的 settings（三个键齐全，与服务端补齐规则一致），
// 并清除分镜上与旧值或新值相同的显式值（它们本来就不是真正的覆盖），让它们继续跟随项目。运行中的节点不能改执行输入，跳过。
export function applyProjectSetting(draft, key, value, lockedIds = new Set()) {
 const storyboard = draft.storyboard || { script: '', shots: [] };
 const before = shownSettings(storyboard), next = { ...before, [key]: value };
 const nodes = new Set((storyboard.shots || []).map(shot => shot.nodeId).filter(Boolean));
 const tasks = draft.tasks.map(task => {
  if (task.kind !== 'video' || !nodes.has(task.id) || lockedIds.has(task.id)) return task;
  const own = normalizeVideoParameters(task.params || {});
  if (own[key] === undefined || (own[key] !== before[key] && own[key] !== value)) return task;
  return { ...task, params: omit(task.params, [key]) };
 });
 return { ...draft, tasks, storyboard: { ...storyboard, settings: next } };
}

// ---------- 素材 ⇄ 画布节点 / 连线 ----------
const reaches = (edges, from, to, seen = new Set()) => {
 if (from === to) return true;
 if (seen.has(from)) return false;
 seen.add(from);
 return edges.filter(e => e.source === from).some(e => reaches(edges, e.target, to, seen));
};
const sameTarget = (edges, task, edge, port, tasks) => edge.target === task.id && targetHandleOf(edge, tasks) === port;

// 移除一条素材连线：同时清理只为它存在的固定版本，以及工作台自动创建、不再被使用且没有生成记录的输入节点。
export function detachMaterial(draft, runs, edgeId) {
 const edge = draft.edges.find(e => e.id === edgeId);
 if (!edge) return draft;
 const edges = draft.edges.filter(e => e.id !== edgeId);
 let tasks = draft.tasks;
 const stillFeeds = edges.some(e => e.source === edge.source && e.target === edge.target);
 if (!stillFeeds) tasks = tasks.map(t => t.id === edge.target && t.sourceRunIds?.length ? { ...t, sourceRunIds: t.sourceRunIds.filter(id => runs.find(r => r.id === id)?.taskId !== edge.source) } : t);
 const source = tasks.find(t => t.id === edge.source);
 const orphan = source?.studioMade === true && !edges.some(e => e.source === source.id) && !runs.some(r => r.taskId === source.id);
 return { ...draft, tasks: orphan ? tasks.filter(t => t.id !== source.id) : tasks, edges };
}

// 把素材接到分镜节点的某个槽位：
//  - asset：创作素材 / 素材库 / 上传 → 新建图片 / 视频 / 音频输入节点（标记 studioMade）并连线；
//  - run：画布上某个节点的具体成功版本 → 连线到该节点并在分镜上固定这个版本。
// 单图槽位（首帧 / 尾帧）会先换掉旧素材。返回 { draft } 或 { error }。
export function attachMaterial(draft, runs, { taskId, port, asset, run }, uid = () => crypto.randomUUID()) {
 const target = draft.tasks.find(t => t.id === taskId);
 if (!target || target.kind !== 'video') return { error: '分镜节点不存在。' };
 if (!VIDEO_PORT_TYPE[port] || port === 'prompt') return { error: '素材槽位无效。' };
 let next = draft;
 if (VIDEO_PORT_LIMIT[port] === 1) for (const edge of next.edges.filter(e => sameTarget(next.edges, target, e, port, next.tasks))) next = detachMaterial(next, runs, edge.id);
 const issue = videoConnectIssue(target, port, next.edges, next.tasks);
 if (issue) return { error: issue };
 // 首帧由连线提供：任务自带首帧与上一镜尾帧选择不再生效，一并清除，避免界面显示与实际提交不一致。
 const clearFirst = port === 'first' ? { sourceAssetId: null, sourceRunId: null, tailFrame: null } : {};
 if (asset) {
  const spec = INPUT_NODE[VIDEO_PORT_TYPE[port]];
  const count = next.edges.filter(e => e.target === target.id).length;
  const node = {
   id: uid(), workflowId: target.workflowId, kind: spec.kind, title: String(asset.name || '素材').slice(0, 100) || '素材', prompt: '', params: {},
   subject: target.subject || 'concept', ...(target.productSnapshot ? { productSnapshot: target.productSnapshot } : {}),
   position: { x: target.position.x, y: target.position.y - 300 * (count + 1) }, sourceAssetId: asset.id, sourceRunId: null, studioMade: true,
  };
  const edge = { id: uid(), source: node.id, sourceHandle: spec.handle, target: target.id, targetHandle: port };
  return { draft: { ...next, tasks: [...next.tasks.map(t => t.id === target.id ? { ...t, ...clearFirst } : t), node], edges: [...next.edges, edge] }, nodeId: node.id, edgeId: edge.id };
 }
 const source = run && next.tasks.find(t => t.id === run.taskId);
 if (!source || !EXECUTABLE.has(source.kind) || run.status !== 'succeeded' || !run.output?.assetId) return { error: '这个结果版本不可用，请重新选择。' };
 if (source.id === target.id || reaches(next.edges, target.id, source.id)) return { error: '不能选用这个分镜自己的结果，也不能形成循环依赖。' };
 const outType = source.kind === 'video' ? 'video' : 'image';
 if (outType !== VIDEO_PORT_TYPE[port]) return { error: `${SLOT_LABEL[port]}需要${VIDEO_PORT_TYPE[port] === 'video' ? '视频' : VIDEO_PORT_TYPE[port] === 'audio' ? '音频' : '图片'}结果。` };
 const existing = next.edges.find(e => e.source === source.id && sameTarget(next.edges, target, e, port, next.tasks));
 const edge = existing || { id: uid(), source: source.id, sourceHandle: outType, target: target.id, targetHandle: port };
 // 固定版本放进 sourceRunIds（sourceRunId 在服务端会被当成首帧）；同一来源只固定一个版本。
 const pins = [...(target.sourceRunIds || []).filter(id => runs.find(r => r.id === id)?.taskId !== source.id), run.id];
 return { draft: { ...next, tasks: next.tasks.map(t => t.id === target.id ? { ...t, ...clearFirst, sourceRunIds: pins } : t), edges: existing ? next.edges : [...next.edges, edge] }, edgeId: edge.id };
}

// ---------- 问题标记（W7） ----------
export const ISSUE_SECTION = { material: 'materials', tail: 'materials', deleted: 'materials', dub: 'dialogue', failed: 'preview' };
const textOf = dialogue => (Array.isArray(dialogue) ? dialogue : []).some(line => line?.text?.trim());
const assetGone = (assets, id) => { const a = assets.find(item => item.id === id); return !a || Boolean(a.trashedAt) || Boolean(a.deletionPending); };

// 一个分镜当前需要处理的原因。每项 { kind, label, section }，只用已有数据推导，不发请求。
export function shotIssues({ task, edges, tasks, runs, assets, assetsLoaded, dub, shotInfo }) {
 if (!task) return [];
 const issues = [], add = (kind, label) => { if (!issues.some(i => i.label === label)) issues.push({ kind, label, section: ISSUE_SECTION[kind] }); };
 const analysis = analyzeVideoNode(task, { edges, tasks, runs });
 const { mode, items } = analysis;
 const at = ports => items.filter(i => ports.includes(i.port));
 if (mode === 'frames' && !at(['first', 'last']).length) add('material', '缺少首帧或尾帧');
 if (mode === 'reference' && !at(['refImage', 'refVideo']).length) add('material', '缺少参考图或参考视频');
 for (const item of items) if (!item.asset && !item.pending) add('material', `${item.label}还没有成功版本`);
 // 尾帧：等待上一镜成功 / 已成功待截取 / 上一镜已更新。
 const tail = mode === 'frames' && task.tailFrame?.fromNodeId && !edges.some(e => e.target === task.id && targetHandleOf(e, tasks) === 'first') ? task.tailFrame : null;
 if (tail && !tail.assetId) add('tail', shotInfo?.prevStatus === 'succeeded' ? '尾帧待截取' : '等待上一镜');
 if (tail?.assetId && shotInfo?.stale) add('tail', '上一镜已更新');
 // 引用的素材已删除：来源输入节点 / 自带首帧 / 尾帧素材不在可用素材里，或提示词标签指向已移除的素材。
 if (assetsLoaded) {
  const gone = id => id && assetGone(assets, id);
  const sources = edges.filter(e => e.target === task.id).map(e => tasks.find(t => t.id === e.source)).filter(Boolean);
  if (sources.some(s => !EXECUTABLE.has(s.kind) && gone(s.sourceAssetId)) || gone(task.sourceAssetId) || gone(task.tailFrame?.assetId)) add('deleted', '引用的素材已删除');
 }
 if (tagSegments(task.prompt, analysis).some(part => part.type === 'tag' && part.status === 'removed')) add('deleted', '提示词引用了已移除的素材');
 // 台词配音：只有后期配音 / 口型同步且有台词时才需要配音。
 if (['post', 'lipsync'].includes(task.dubMode) && textOf(task.dialogue)) {
  if (!dub || dub.status === 'none') add('dub', '配音未合成');
  else if (dub.status === 'stale') add('dub', '配音已过期');
  else if (dub.dub?.status === 'failed') add('dub', '混音失败');
  else if (dub.needsMix) add('dub', '配音待混音');
 }
 const last = runs.filter(r => r.taskId === task.id).at(-1);
 if (last?.status === 'failed') add('failed', '上次失败');
 return issues;
}

// ---------- 连播清单与合计（W6） ----------
export const succeededRuns = (runs, nodeId) => runs.filter(r => r.taskId === nodeId && r.status === 'succeeded' && r.output?.assetId);
// 分镜当前展示的成功版本：用户在版本切换里选的，否则最新成功版本。
export const shownRun = (runs, nodeId, displayRuns = {}) => {
 const list = succeededRuns(runs, nodeId);
 return (displayRuns[nodeId] && list.find(r => r.id === displayRuns[nodeId])) || list.at(-1) || null;
};
// 配音版只有在与展示版本是同一次运行、且仍然新鲜（服务端只在新鲜时下发 assetId）时才使用。
export const dubAssetFor = (dubState, nodeId, run) => { const dub = dubState?.(nodeId)?.dub; return run && dub?.assetId && dub.runId === run.id ? dub.assetId : null; };
export function buildPlaylist({ shots, tasks, runs, storyboard, dubState, displayRuns }) {
 return shots.map(shot => {
  const task = tasks.find(t => t.id === shot.nodeId) || null, run = task ? shownRun(runs, task.id, displayRuns) : null, dub = dubAssetFor(dubState, task?.id, run);
  return { shotId: shot.id, title: task?.title ?? shot.title, duration: task ? shotDuration(storyboard, task) : SETTING_DEFAULTS.duration, assetId: run?.output.assetId || null, dubAssetId: dub, src: dub || run?.output.assetId || null };
 });
}
// 顶部合计：镜数、总时长、尚未生成的分镜的预估积分（沿用批量预览同一套单价；不发请求）。
export function studioSummary({ shots, tasks, runs, storyboard, channels = [], defaults = {} }) {
 let seconds = 0, points = 0, pending = 0;
 for (const shot of shots) {
  const task = tasks.find(t => t.id === shot.nodeId);
  if (!task) { seconds += SETTING_DEFAULTS.duration; continue; }
  seconds += shotDuration(storyboard, task);
  if (succeededRuns(runs, task.id).length) continue;
  pending += 1;
  const channelId = task.model?.channelId || defaults.video?.channelId;
  const value = estimateVideoPoints(shotParams(storyboard, task), channels.find(c => c.id === channelId)?.executorConfig);
  if (value !== null) points += value;
 }
 return { count: shots.length, seconds, pending, points: Math.round(points * 100) / 100 };
}

// 把第 from 项移到第 to 项的位置。
export function moveItem(list, from, to) {
 if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
 const next = [...list];
 next.splice(to, 0, next.splice(from, 1)[0]);
 return next;
}
export const clock = seconds => { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
