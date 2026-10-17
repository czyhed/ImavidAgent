import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, MiniMap, Handle, Position, applyNodeChanges, applyEdgeChanges, getNodesBounds, useUpdateNodeInternals } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { canWrite } from '../lib/auth.js';
import DraftText from './DraftText.jsx';
import { autoLayout } from '../lib/canvas-layout.js';
import { withWorkflows, workflowScope, createWorkflow } from '../../../shared/creation-workflows.mjs';
import CanvasNodeEditor from './CanvasNodeEditor.jsx';
import MaskEditor from './MaskEditor.jsx';
import CreationVideoStudio from './CreationVideoStudio.jsx';
import { attachMaterial as studioAttach, detachMaterial as studioDetach, applyProjectSetting } from '../lib/video-studio.js';
import { PORT_LABEL, VIDEO_PORT_ORDER, VIDEO_PORT_LIMIT, portsForMode, inferVideoMode, targetHandleOf, videoConnectIssue, estimateVideoPoints, pointText } from '../lib/video-node.js';
import '../styles/creation-canvas-v3.css';
import '../styles/creation-task-canvas.css';
import '../styles/creation-video-node.css';
import VoiceRolesPanel from './VoiceRoles.jsx';
import { SaveQueue, diffOps, applyOps, reuseUnchanged, mergeStatus, needsPolling, loadView, saveView } from '../lib/creation-sync.js';

export async function creationRequest(backend, path, body, method, options = {}) {
 const verb = method || (body === undefined ? 'GET' : 'POST');
 const response = await fetch(path, { method: verb, keepalive: options.keepalive || undefined, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(verb !== 'GET' ? { 'X-CSRF-Token': backend?.csrf || backend?.session?.csrfToken || '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
 // 网关错误页等非 JSON 响应按空对象处理，状态码仍随错误抛出，供保存队列判断是否重试。
 const data = await response.json().catch(() => ({}));
 if (!response.ok) { const error = new Error(data.error?.message || '请求失败，请重试。'); error.code = data.error?.code; error.status = response.status; throw error; }
 return data;
}

const NODE = {
 product: { label: '商品输入', color: '#F59E0B', ins: [], outs: [['text', 'text'], ['image', 'image']] },
 image: { label: '图片输入', color: '#38BDF8', ins: [], outs: [['image', 'image']] },
 audio: { label: '音频输入', color: '#F59E0B', ins: [], outs: [['audio', 'audio']] },
 footage: { label: '视频输入', color: '#F43F5E', ins: [], outs: [['video', 'video']] },
 prompt: { label: '提示词', color: '#A78BFA', ins: [], outs: [['text', 'text']] },
 generate: { label: '生图', color: '#6366F1', ins: [['prompt', 'text'], ['ref', 'image', true]], outs: [['image', 'image']] },
 edit: { label: '改图', color: '#8B5CF6', ins: [['image', 'image', true], ['prompt', 'text']], outs: [['image', 'image']] },
 composite: { label: '合成', color: '#14B8A6', ins: [['images', 'image', true], ['template', 'text']], outs: [['image', 'image']] },
 // 端口第四项为条数上限；与 server/creation-projects.mjs 的 PORTS.video 保持一致。
 video: { label: '视频', color: '#EC4899', ins: [['prompt', 'text'], ['first', 'image'], ['last', 'image'], ['refImage', 'image', true, 9], ['refVideo', 'video', true, 3], ['refAudio', 'audio', true, 3]], outs: [['video', 'video']] },
 output: { label: '输出', color: '#22C55E', ins: [['asset', 'image', true], ['video', 'video', true]], outs: [] },
};
const EXECUTABLE = new Set(['generate', 'edit', 'composite', 'video']);
const MAX_REFERENCES = 8;
const portDef = (kind, dir, id) => (NODE[kind]?.[dir] || []).find(([pid]) => pid === id) || null;
const statusLabels = { queued: '排队中', submitting: '正在提交', running: '运行中', unknown: '待核实', cancelling: '正在取消', cancelled: '已取消', failed: '失败', succeeded: '成功' };
const isActive = status => ['queued', 'submitting', 'running', 'unknown', 'cancelling'].includes(status);
const fileUrl = id => `/api/creation/assets/${id}/file`;
const copy = value => JSON.parse(JSON.stringify(value));
const costText = cost => cost?.amount === null || cost?.amount === undefined ? '未统计' : `${cost.amount.toFixed(2)} ${cost.currency || ''}`;
const defaultParams = kind => kind === 'composite' ? { layout: 'vertical3', width: 1242, height: 1660 } : kind === 'video' ? { duration: 6 } : ['audio', 'footage'].includes(kind) ? {} : { size: '1024x1024' };
const uid = () => crypto.randomUUID();

// 分镜节点的上一镜信息（尾帧选择器用）：以分镜顺序为准；纯数据，便于参与节点重建签名。
function computeShotMap(project, runs) {
 const shots = project?.storyboard?.shots || [], map = {};
 shots.forEach((shot, index) => {
  if (!shot.nodeId) return;
  const prev = shots[index - 1], prevNode = prev?.nodeId ? project.tasks.find(t => t.id === prev.nodeId) : null;
  map[shot.nodeId] = prevNode ? { shotId: shot.id, prevNodeId: prevNode.id, prevTitle: prevNode.title, prevStatus: runs.some(r => r.taskId === prevNode.id && r.status === 'succeeded' && r.output?.assetId) ? 'succeeded' : 'idle', stale: Boolean(shot.tailFrameStale) } : { shotId: shot.id, prevNodeId: null };
 });
 return map;
}

// 视频节点按方式只渲染需要的输入端口；已有连线但当前方式不用的端口保留（变暗且不可再连），避免连线丢失端点。
function visibleInputs(task, edges, tasks) {
 const defs = NODE[task.kind]?.ins || [];
 if (task.kind !== 'video') return defs.map(def => ({ def, unused: false }));
 const mode = inferVideoMode(task, edges, tasks), active = new Set(portsForMode(mode));
 const used = new Set(edges.filter(e => e.target === task.id).map(e => targetHandleOf(e, tasks)));
 return defs.filter(([id]) => active.has(id) || used.has(id)).map(def => ({ def, unused: !active.has(def[0]) }));
}
function HandleRow({ task, dir, writable, edges, tasks }) {
 const list = dir === 'in' ? visibleInputs(task, edges, tasks) : (NODE[task.kind]?.outs || []).map(def => ({ def, unused: false }));
 return list.map(({ def: [id, type], unused }, index) => (
  <Handle key={id} id={id} type={dir === 'in' ? 'target' : 'source'} position={dir === 'in' ? Position.Left : Position.Right}
   isConnectable={writable && !unused} className={`v3-port ${type}${unused ? ' unused' : ''}`} style={{ top: 46 + index * 24 }} title={task.kind === 'video' && dir === 'in' ? PORT_LABEL[id] : undefined}>
   <span className="v3-port-label">{task.kind === 'video' || ['audio', 'footage'].includes(task.kind) ? PORT_LABEL[id] || id : id}</span>
  </Handle>
 ));
}

function V3Node({ data, selected }) {
 const { task, run, writable } = data;
 const update = useUpdateNodeInternals();
 const edges = data.editor.edges, tasks = data.editor.tasks;
 const signature = visibleInputs(task, edges, tasks).map(({ def, unused }) => def[0] + (unused ? '-' : '')).join();
 useEffect(() => { update(task.id); }, [signature, task.id, update]);
 return <div className={`v3-node ${selected ? 'is-selected' : ''} kind-${task.kind}`}>
  <HandleRow task={task} dir="in" writable={writable && !data.shared} edges={edges} tasks={tasks} />
  <header><span className="v3-dot" style={{ '--c': NODE[task.kind].color }} /><span className="v3-kind">{NODE[task.kind].label}</span><span className="v3-node-head-more">{task.dimension && <span className="v3-dim-tag">{task.dimension}</span>}<span className={`v3-badge ${run?.status || 'idle'}`}>{statusLabels[run?.status] || (EXECUTABLE.has(task.kind) ? '未开始' : '可编辑')}</span></span></header>
  <CanvasNodeEditor data={data} />
  <HandleRow task={task} dir="out" writable={writable && !data.shared} edges={edges} tasks={tasks} />
 </div>;
}
const nodeTypes = { v3node: V3Node };

export default function CreationProjectCanvas({ backend, notify, projectId, view = 'canvas', onSwitchView, onBack, onOpenProduct, onWorkflowEditingChange }) {
 const writable = canWrite(backend?.session), base = `/api/creation/projects/${projectId}`;
 const [detail, setDetail] = useState(null), [draft, setDraft] = useState(null), [saveState, setSaveState] = useState({ state: 'saved', error: '' });
 const [nodes, setNodes] = useState([]), [edges, setEdges] = useState([]), [selected, setSelected] = useState([]);
 const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
 const [assets, setAssets] = useState([]), [assetsLoaded, setAssetsLoaded] = useState(false), [models, setModels] = useState([]), [templates, setTemplates] = useState([]), [hub, setHub] = useState({ channels: [], defaults: {} });
 const [preview, setPreview] = useState(null), [planning, setPlanning] = useState(false), [instructions, setInstructions] = useState('');
 const [allowVideo, setAllowVideo] = useState(false), [showPalette, setShowPalette] = useState(false);
 const [queueFilter, setQueueFilter] = useState('all'), [queueOpen, setQueueOpen] = useState(false);
 const [workflowId, setWorkflowId] = useState(null), [taskQuery, setTaskQuery] = useState(''), [newWorkflow, setNewWorkflow] = useState(false), [workflowName, setWorkflowName] = useState(''), [workflowKind, setWorkflowKind] = useState('generate');
 const [dismissedProposal, setDismissedProposal] = useState(null), [rolesOpen, setRolesOpen] = useState(false);
 const [refine, setRefine] = useState(null), [tool, setTool] = useState('pan'), [zoomPct, setZoomPct] = useState(100), [displayRun, setDisplayRunMap] = useState({});
 const draftRef = useRef(null), detailRef = useRef(null), busyRef = useRef(false), flow = useRef(null), queueRef = useRef(null), epoch = useRef(0), live = useRef({}), undoRef = useRef([]), redoRef = useRef([]), canvasBox = useRef(null), gestureRef = useRef(false), pointerDownRef = useRef(false), renderedRef = useRef(''); const [layoutTick, bumpLayoutTick] = useState(0);
 const selectedId = selected[0] || null;
 const currentWorkflow = draft?.workflows.find(w => w.id === workflowId) || draft?.workflows[0];
 const viewKeyRef = useRef('all'); viewKeyRef.current = currentWorkflow?.id || 'all';
 const scope = useMemo(() => draft && currentWorkflow ? workflowScope(draft, currentWorkflow.id) : { owned: new Set(), visible: new Set() }, [draft, currentWorkflow?.id]);
 const runs = detail?.runs || [];
 const dirty = saveState.state !== 'saved';
 live.current = { backend, base };

 function normalizeProject(project) {
  const legacy = !project.workflows?.length && project.tasks?.length && project.tasks.every(t => !t.workflowId && ['image', 'video'].includes(t.kind)) && (project.edges || []).every(e => !e.sourceHandle && !e.targetHandle);
  if (!legacy) return project;
  const tasks = project.tasks.map(t => t.kind === 'image' ? { ...t, kind: 'generate' } : t);
  const edges = (project.edges || []).map(edge => {
   if (edge.sourceHandle || edge.targetHandle) return edge;
   const source = tasks.find(t => t.id === edge.source), target = tasks.find(t => t.id === edge.target);
   const out = NODE[source?.kind]?.outs?.[0], input = NODE[target?.kind]?.ins?.find(port => port[1] === out?.[1]);
   return out && input ? { ...edge, sourceHandle: out[0], targetHandle: input[0] } : edge;
  });
  return { ...project, tasks, edges };
 }
 const accept = useCallback(data => {
  // 服务端状态 + 尚未确认的本地操作 = 显示的草稿（变基）；保存确认后 epoch 加一，让更早发出的详情请求作废。
  epoch.current += 1;
  const server = { ...data, project: copy(withWorkflows(normalizeProject(data.project))) };
  detailRef.current = server; setDetail(server);
  const pending = queueRef.current?.outstanding() || [];
  const next = pending.length ? applyOps(server.project, pending) : copy(server.project);
  const shared = reuseUnchanged(draftRef.current, next);
  draftRef.current = shared; setDraft(shared); setLoaded(true);
 }, []);
 const reload = useCallback(async () => { try { const data = await creationRequest(backend, base); accept(data); setError(''); return data; } catch (e) { setError(e.message); setLoaded(true); throw e; } }, [base, backend?.csrf, accept]);
 // 静默刷新（标签页切回、他处编辑后）：期间若已有保存确认（epoch 变化），丢弃这份可能过期的详情。
 const refresh = useCallback(async () => {
  const mark = epoch.current;
  try { const data = await creationRequest(live.current.backend, live.current.base); if (epoch.current === mark) accept(data); } catch { /* 下次轮询或切回时再试 */ }
 }, [accept]);
 useEffect(() => { reload().catch(() => {}); }, [reload]);
 // 保存队列：改动合并后按增量操作提交，确认后以服务端返回为底重新叠加未确认的改动。
 useEffect(() => {
  const queue = new SaveQueue({
   send: (ops, { keepalive } = {}) => creationRequest(live.current.backend, `${live.current.base}/ops`, { ops }, 'POST', { keepalive }),
   onResult: data => accept(data),
   onReject: error => { setError(error.message); refresh(); },
   onStatus: setSaveState,
  });
  queueRef.current = queue;
  return () => { queue.flush({ keepalive: true }).catch(() => {}); queue.dispose(); queueRef.current = null; };
 }, [accept, refresh]);
 // 画布节点与视频工作台分镜卡片共用的编辑接口：读写同一份项目草稿与 change()，两处即时一致。
 function buildEditor() {
  const shots = computeShotMap(draft, runs);
  return { tasks: draft.tasks, edges: draft.edges, assets, assetsLoaded, models, channels: hub.channels, defaults: hub.defaults, templates, runs, busy, displayRuns: displayRun, shots, shotOf: id => shots[id] || null, captureTail: captureTail, voiceRoles: draft.voiceRoles || [], voiceConfigured, dubStates: detail?.dubStates || {}, dubState: id => detail?.dubStates?.[id] || null, synthesizeDialogue, remixDub, speedUpRoles, openRoles: () => setRolesOpen(true), storyboard: () => draftRef.current?.storyboard || null, patchStoryboard, setProjectSetting, attachMaterial, detachMaterial, uploadAsset, setDisplayRun, flush, edit: editNode, run: runTasks, duplicate: duplicateTask, remove: deleteTask, removeEdge, removeEdges, latest: id => draftRef.current?.tasks.find(t => t.id === id), request: path => creationRequest(backend, path), uploadMedia: (e, id, file) => addFile(e, 'creative', id, file), openRefine: (taskId, runId) => setRefine({ mode: 'create', taskId, runId }), redrawMask: taskId => setRefine({ mode: 'redraw', taskId }), upload: (e, id) => addFile(e, 'creative', id), openProduct: draft.productId && onOpenProduct ? () => onOpenProduct(draft.productId) : null };
 }
 const voiceConfigured = hub.channels.some(c => c.adapter === 'volcengine-tts' && c.enabled);
 // 台词配音：先保存画布草稿，再按行合成（少量语音字符费用）；结果写在服务端节点上。
 async function synthesizeDialogue(taskId) {
  await flush();
  accept(await creationRequest(backend, base + '/voice/dialogue', { taskId }));
 }
 async function remixDub(taskId) {
  await flush();
  accept(await creationRequest(backend, base + '/voice/remix', { taskId }));
 }
 // 「加快语速」：提高所用角色的语速并提示重新合成。
 async function speedUpRoles(ids) {
  const roles = (draftRef.current.voiceRoles || []).map(r => ids.includes(r.id) ? { ...r, speechRate: Math.min(100, (r.speechRate || 0) + 15) } : r);
  await saveRoles(roles);
  notify?.('已提高所用角色的语速，请重新合成配音');
 }
 // 角色与音色走同一保存队列（project.patch）；这里立即发送，校验错误显示在角色面板里。
 async function saveRoles(voiceRoles) {
  commit({ ...draftRef.current, voiceRoles }, { undoable: false });
  await flush();
 }
 // 立即发送队列中的全部改动并等待确认（动作类请求前调用）；保存失败时抛出，调用方不继续。
 async function flush() { await queueRef.current?.flush(); return detailRef.current; }
 // 截取上一镜尾帧写入该分镜节点；先保存画布草稿，确保服务端已看到「首尾帧方式」与尾帧选择。
 async function captureTail(taskId) {
  await work(async () => {
   const saved = await flush();
   const shot = (saved.project.storyboard?.shots || []).find(s => s.nodeId === taskId);
   if (!shot) throw new Error('请先在视频工作台添加分镜，再截取尾帧。');
   accept(await creationRequest(backend, base + '/storyboard/tail-frame', { shotId: shot.id }));
  });
 }
 useEffect(() => {
  Promise.allSettled([creationRequest(backend, '/api/creation/assets'), creationRequest(backend, '/api/model-hub'), creationRequest(backend, '/api/creation/templates')]).then(results => {
   if (results[0].status === 'fulfilled') { setAssets(results[0].value.items || []); setAssetsLoaded(true); }
   if (results[1].status === 'fulfilled') { setModels(results[1].value.models || []); setHub({ channels: results[1].value.channels || [], defaults: results[1].value.defaults || {} }); }
   if (results[2].status === 'fulfilled') setTemplates(results[2].value.templates || results[2].value.items || []);
  });
 }, [backend?.csrf]);
 // 轻量状态轮询：只在有运行中的生成 / 批量 / 配音 / 成片时每 3 秒查询一次，结束即停；他处编辑（修订号变化）时再取一次详情并重新叠加本地改动。
 const polling = needsPolling(detail);
 useEffect(() => {
  if (!polling) return undefined;
  const poll = setInterval(async () => {
   if (busyRef.current || gestureRef.current || pointerDownRef.current || document.hidden) return;
   const mark = epoch.current;
   try {
    const status = await creationRequest(backend, `${base}/status`);
    if (epoch.current !== mark || !detailRef.current) return;
    const merged = mergeStatus(detailRef.current, status);
    if (merged.needsFull) { await refresh(); return; }
    detailRef.current = merged.detail; setDetail(merged.detail);
   } catch { /* 暂时失败不打断编辑，下个周期再试 */ }
  }, 3000);
  return () => clearInterval(poll);
 }, [polling, base, backend?.csrf, refresh]);
 // 标签页切走 / 离开页面立即发送；切回时刷新一次。
 useEffect(() => {
  const onVisibility = () => { if (document.hidden) queueRef.current?.flush({ keepalive: true }).catch(() => {}); else refresh(); };
  const onHide = () => { queueRef.current?.flush({ keepalive: true }).catch(() => {}); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
  return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onHide); };
 }, [refresh]);
 useEffect(() => { onWorkflowEditingChange?.(dirty || Boolean(preview)); return () => onWorkflowEditingChange?.(false); }, [dirty, preview, onWorkflowEditingChange]);
 useEffect(() => {
  const warn = event => { if (queueRef.current && queueRef.current.state !== 'saved') { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
 }, []);
 useEffect(() => { if (runs.length) setQueueOpen(true); }, [runs.length]);

 const lastRun = useCallback(id => runs.filter(r => r.taskId === id).at(-1), [runs]);
 const successRuns = useCallback(id => runs.filter(r => r.taskId === id && r.status === 'succeeded' && r.output?.assetId), [runs]);
 const setDisplayRun = useCallback((taskId, runId) => setDisplayRunMap(old => ({ ...old, [taskId]: runId })), []);

 // 指针按在画布上（拖拽 / 连线 / 平移）期间冻结轮询与节点重建，避免手势被服务端快照打断。
 useEffect(() => {
  const el = canvasBox.current; if (!el) return;
  const down = () => { pointerDownRef.current = true; };
  const up = () => { if (!pointerDownRef.current) return; pointerDownRef.current = false; bumpLayoutTick(t => t + 1); };
  el.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  return () => { el.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
 }, [loaded, view]);
 useEffect(() => {
  if (!draft || gestureRef.current || pointerDownRef.current) return;
  const buildNodes = () => draft.tasks.filter(task => scope.visible.has(task.id)).map(task => {
   const versions = successRuns(task.id);
   const shown = displayRun[task.id] ? versions.find(r => r.id === displayRun[task.id]) : versions.at(-1);
   const asset = shown?.output?.assetId || task.sourceAssetId || null;
   const incoming = draft.edges.filter(e => e.target === task.id && e.targetHandle === 'images').length;
   const promptEdge = draft.edges.find(e => e.target === task.id && (e.targetHandle === 'prompt' || e.targetHandle === 'template'));
   const promptSource = promptEdge ? draft.tasks.find(t => t.id === promptEdge.source) : null;
   const displayPrompt = task.prompt || (promptSource?.kind === 'product' ? '使用商品资料' : promptSource?.prompt) || '';
   return {
    id: task.id, type: 'v3node', position: task.position, draggable: scope.owned.has(task.id),
    data: { shared: !scope.owned.has(task.id), editor: buildEditor(), task, run: lastRun(task.id), writable, asset, displayPrompt, hasPromptSource: Boolean(promptSource), versions, displayRun: displayRun[task.id] || null, onDisplayRun: setDisplayRun, upstream: incoming, layout: task.params?.size || '1024×1024' },
   };
  });
  const nextEdges = draft.edges.filter(e => scope.visible.has(e.source) && scope.visible.has(e.target)).map(e => ({ ...e, type: 'smoothstep', animated: runs.some(r => r.taskId === e.target && isActive(r.status)) }));
  // 内容未变化时跳过重建：反复替换 nodes/edges 会让 xyflow 重新测量并把节点重新隐藏。
  const nextNodes = buildNodes();
  const signature = JSON.stringify([nextNodes, nextEdges]);
  if (signature === renderedRef.current) return;
  renderedRef.current = signature;
  // 选择与测量由 React Flow 的 onNodesChange 维护；内容刷新不能回写旧选择，
  // 否则点击节点按钮时，选择回调和内容 effect 会互相覆盖并无限更新。
  setNodes(previous => {
   const existing = new Map(previous.map(node => [node.id, node]));
   return nextNodes.map(node => ({ ...existing.get(node.id), ...node }));
  });
  setEdges(nextEdges);
 }, [draft, runs, writable, lastRun, successRuns, displayRun, setDisplayRun, layoutTick, scope, assets, models, hub, templates, busy]);

 // 打开项目或切换任务时，按当前任务的节点适应视图，避免沿用其它任务的视角把节点裁掉。
 const fittedFor = useRef(null), programmaticMove = useRef(false);
 useEffect(() => {
  const key = currentWorkflow?.id || 'all';
  if (!flow.current || !nodes.length || fittedFor.current === key) return;
  const measured = nodes.every(node => node.measured?.width || node.width);
  if (!measured) return;
  fittedFor.current = key;
  // 自动适应只是浏览视角，不写入服务器；字号过小不如保留可读缩放并从左上角开始。本机保存过该任务的视角时直接恢复。
  programmaticMove.current = true;
  requestAnimationFrame(() => {
   const instance = flow.current, box = canvasBox.current?.querySelector('.react-flow');
   if (!instance || !box) { programmaticMove.current = false; return; }
   const saved = loadView(projectId, key);
   if (saved) { instance.setViewport(saved); setZoomPct(Math.round(saved.zoom * 100)); requestAnimationFrame(() => { programmaticMove.current = false; }); return; }
   const bounds = getNodesBounds(nodes), width = box.clientWidth, height = box.clientHeight, pad = 48;
   const fit = Math.min((width - pad * 2) / bounds.width, (height - pad * 2) / bounds.height, 1);
   const zoom = Math.max(fit, 0.75);
   // 放得下时居中显示；放不下时保持可读缩放，从任务左上角开始。
   const x = fit >= 0.75 ? (width - bounds.width * zoom) / 2 - bounds.x * zoom : pad - bounds.x * zoom;
   const y = fit >= 0.75 ? (height - bounds.height * zoom) / 2 - bounds.y * zoom : pad - bounds.y * zoom;
   instance.setViewport({ x, y, zoom });
   setZoomPct(Math.round(zoom * 100));
   requestAnimationFrame(() => { programmaticMove.current = false; });
  });
 }, [nodes, currentWorkflow?.id]);
 const onSelectionChangeCallback = useCallback(({ nodes: selection }) => {
  const ids = selection.map(n => n.id).filter(id => !id.startsWith('result:'));
  setSelected(old => old.join() === ids.join() ? old : ids);
 }, []);
 function selectNodes(ids) {
  setNodes(previous => previous.map(node => ({ ...node, selected: ids.includes(node.id) })));
  setSelected(ids);
 }
 // 拖拽 / 连线手势期间不接受轮询重建，避免节点被服务端位置拉回、连线被取消。
 const onNodeDragStartCallback = useCallback(() => { gestureRef.current = true; }, []);
 const onNodeDragStopCallback = useCallback((_, node) => {
  gestureRef.current = false;
  change({ ...draftRef.current, tasks: draftRef.current.tasks.map(t => t.id === node.id ? { ...t, position: node.position } : t) });
 }, []);
 const onConnectStartCallback = useCallback(() => { gestureRef.current = true; }, []);
 const onConnectEndCallback = useCallback(() => { gestureRef.current = false; }, []);
 const isValidConnectionCallback = useCallback(connection => {
  const current = draftRef.current;
  const source = current?.tasks.find(t => t.id === connection.source), target = current?.tasks.find(t => t.id === connection.target);
  const out = portDef(source?.kind, 'outs', connection.sourceHandle), input = portDef(target?.kind, 'ins', connection.targetHandle);
  return Boolean(out && input && out[1] === input[1] && connection.source !== connection.target);
 }, []);
 const onMoveEndCallback = useCallback((event, viewport) => {
  setZoomPct(Math.round((viewport.zoom || 1) * 100));
  if (programmaticMove.current || !event) return;
  // 视角只存本机浏览器（按项目与创作任务区分），不再写入服务器，平移 / 缩放不会触发保存。
  saveView(projectId, viewKeyRef.current, viewport);
 }, [projectId]);
 const onInitCallback = useCallback(instance => { flow.current = instance; }, []);
 const nodesChange = useCallback(changes => setNodes(old => applyNodeChanges(changes, old)), []);
 const edgesChange = useCallback(changes => {
  setEdges(old => applyEdgeChanges(changes, old));
  for (const change of changes) if (change.type === 'remove' && !String(change.id).startsWith('result-edge:')) commitEdges(draftRef.current.edges.filter(e => e.id !== change.id));
 }, []);
 const commitEdges = next => change({ ...draftRef.current, edges: next });

 // 撤销 / 重做快照只含画布内容；视角、分镜与角色不进入撤销栈。
 function snapshot() { const current = draftRef.current; return { name: current.name, workflows: copy(current.workflows), tasks: copy(current.tasks), edges: copy(current.edges) }; }
 // 把新草稿与当前草稿比对成增量操作并入队；草稿立即显示，保存在 1 秒无改动后（连续改动最长 5 秒）发出。
 function commit(next, { undoable = true } = {}) {
  const prev = draftRef.current, ops = diffOps(prev, next);
  if (!ops.length) return false;
  if (undoable) { undoRef.current.push(snapshot()); if (undoRef.current.length > 50) undoRef.current.shift(); redoRef.current = []; }
  draftRef.current = next; setDraft(next);
  queueRef.current?.push(ops);
  return true;
 }
 function applySnapshot(snap) { commit({ ...draftRef.current, ...snap }, { undoable: false }); bumpLayoutTick(t => t + 1); }
 function change(next) {
  if (!writable || !next) return;
  commit({ ...draftRef.current, name: next.name, workflows: next.workflows, tasks: next.tasks, edges: next.edges, ...(next.voiceRoles !== undefined ? { voiceRoles: next.voiceRoles } : {}) });
 }
 // 视频工作台的脚本 / 分镜编辑：同一保存队列（storyboard.patch），不进入撤销栈。
 function patchStoryboard(patch) {
  if (!writable) return;
  const current = draftRef.current, sb = current.storyboard || { script: '', shots: [] };
  commit({ ...current, storyboard: { ...sb, ...(patch.script !== undefined ? { script: patch.script } : {}), ...(patch.shots !== undefined ? { shots: patch.shots } : {}) } }, { undoable: false });
 }
 // 视频工作台的项目级参数（W4）：写入 storyboard.settings，并清除分镜上只是重复旧值 / 新值的显式参数；运行中的分镜不改。
 function setProjectSetting(key, value) {
  if (!writable) return;
  const locked = new Set((detailRef.current?.runs || []).filter(r => isActive(r.status)).map(r => r.taskId));
  commit(applyProjectSetting(draftRef.current, key, value, locked), { undoable: false });
 }
 // 视频工作台选素材：新建输入节点 + 连线（或连到画布结果并固定版本），走同一个 change() / 保存队列，画布立即可见。
 function attachMaterial(args) {
  if (!writable) return { error: '当前账号没有编辑权限。' };
  const current = draftRef.current, runsNow = detailRef.current?.runs || [];
  if (runsNow.some(r => r.taskId === args.taskId && isActive(r.status))) return { error: '运行中的分镜不能修改素材。' };
  const result = studioAttach(current, runsNow, args);
  if (result.error) return result;
  change(result.draft);
  return { nodeId: result.nodeId, edgeId: result.edgeId };
 }
 function detachMaterial(edgeId) {
  if (!writable) return;
  const current = draftRef.current, edge = current.edges.find(e => e.id === edgeId), runsNow = detailRef.current?.runs || [];
  if (!edge) return;
  if (runsNow.some(r => r.taskId === edge.target && isActive(r.status))) { setError('运行中的分镜不能修改素材。'); return; }
  change(studioDetach(current, runsNow, edgeId));
 }
 // 上传一个素材到项目（创作素材），不绑定到任何节点；失败时抛出，由调用方显示。
 async function uploadAsset(file) {
  const asset = await uploadBlob(file, file.name, 'creative', projectId);
  setAssets(old => [asset, ...old]);
  return asset;
 }
 function undo() { if (!writable || !undoRef.current.length) return; redoRef.current.push(snapshot()); applySnapshot(undoRef.current.pop()); }
 function redo() { if (!writable || !redoRef.current.length) return; undoRef.current.push(snapshot()); applySnapshot(redoRef.current.pop()); }
 async function work(action) {
  if (busyRef.current) return null; busyRef.current = true; setBusy(true); setError('');
  try { return await action(); }
  catch (e) { setError(e.message); return null; }
  finally { busyRef.current = false; setBusy(false); }
 }
 function editNode(id, patch) {
  const current = draftRef.current;
  if (!writable || !current?.tasks.some(t => t.id === id)) return;
  if (detailRef.current.runs.some(r => r.taskId === id && isActive(r.status))) { setError('运行中的节点不能修改执行输入。'); return; }
  let nextEdges = current.edges;
  const node = current.tasks.find(t => t.id === id);
  if (patch.sourceAssetId && ['image', 'product'].includes(node.kind) && !nextEdges.some(e => e.source === id)) {
   const target = current.tasks.find(t => t.workflowId === node.workflowId && EXECUTABLE.has(t.kind));
   const input = target?.kind === 'video' ? (inferVideoMode(target, nextEdges, current.tasks) === 'reference' ? 'refImage' : 'first') : target?.kind === 'edit' ? 'image' : target?.kind === 'composite' ? 'images' : 'ref';
   const textVideo = target?.kind === 'video' && target.videoMode === 'text';
   if (target && !textVideo && !nextEdges.some(e => e.target === target.id && e.targetHandle === input)) nextEdges = [...nextEdges, { id: uid(), source: id, sourceHandle: 'image', target: target.id, targetHandle: input }];
  }
  change({ ...current, edges: nextEdges, tasks: current.tasks.map(t => t.id === id ? { ...t, ...patch } : t) });
 }
 function selectWorkflow(id) { setWorkflowId(id); selectNodes([]); setQueueFilter('all'); }
 function addWorkflow(event) {
  event.preventDefault(); if (!writable) return;
  const created = createWorkflow(draftRef.current, { title: workflowName.trim() || '新建创作任务', kind: workflowKind }, uid);
  change({ ...draftRef.current, workflows: [...draftRef.current.workflows, created.workflow], tasks: [...draftRef.current.tasks, ...created.tasks], edges: [...draftRef.current.edges, ...created.edges] });
  selectWorkflow(created.workflow.id); setNewWorkflow(false); setWorkflowName('');
 }
 function removeWorkflow() {
  if (!writable || !currentWorkflow) return;
  if (draft.workflows.length === 1) { setError('项目至少保留一个创作任务。'); return; }
  if (runs.some(r => scope.owned.has(r.taskId)) || draft.edges.some(e => scope.owned.has(e.source) && !scope.owned.has(e.target))) { setError('任务已有运行记录或被其他任务引用，不能删除。'); return; }
  if (!window.confirm(`删除创作任务「${currentWorkflow.title}」及其流程？`)) return;
  change({ ...draft, workflows: draft.workflows.filter(w => w.id !== currentWorkflow.id), tasks: draft.tasks.filter(t => !scope.owned.has(t.id)), edges: draft.edges.filter(e => !scope.owned.has(e.source) && !scope.owned.has(e.target)) });
  setWorkflowId(null); selectNodes([]);
 }
 function addNode(kind) {
  if (!writable) return;
  const center = flow.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) || { x: 320, y: 200 };
  const id = uid();
  const item = { id, workflowId: currentWorkflow.id, kind, title: NODE[kind].label, prompt: '', params: defaultParams(kind), subject: draft.productId ? 'product' : 'concept', productSnapshot: draft.productSnapshot, position: center, sourceAssetId: null, sourceRunId: null, ...(kind === 'video' ? { videoMode: 'text' } : {}) };
  change({ ...draft, tasks: [...draft.tasks, item] }); selectNodes([id]); setShowPalette(false);
 }
 function arrangeLayout() {
  if (!writable || !draft?.tasks?.length) return;
  const positions = autoLayout(draft.tasks.filter(t => scope.owned.has(t.id)), draft.edges.filter(e => scope.owned.has(e.source) && scope.owned.has(e.target)), { columnGap: 440, rowGap: 760 });
  change({ ...draft, tasks: draft.tasks.map(t => positions[t.id] ? { ...t, position: positions[t.id] } : t) });
  requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2, duration: 300 }));
 }
 function connect(connection) {
  if (!writable || !connection.source || !connection.target) return;
  const source = draft.tasks.find(t => t.id === connection.source), target = draft.tasks.find(t => t.id === connection.target);
  const out = portDef(source?.kind, 'outs', connection.sourceHandle), input = portDef(target?.kind, 'ins', connection.targetHandle);
  if (!out || !input || out[1] !== input[1] || connection.source === connection.target) { setError('端口类型不匹配，不能连接。'); return; }
  if (!input[2] && draft.edges.some(e => e.target === connection.target && e.targetHandle === connection.targetHandle)) { setError('该输入端口只能连接一条连线。'); return; }
  if (['generate', 'edit'].includes(target.kind) && input[1] === 'image' && draft.edges.filter(e => e.target === target.id && e.targetHandle === connection.targetHandle).length >= MAX_REFERENCES) { setError(`每个生图 / 改图节点最多连接 ${MAX_REFERENCES} 张参考图。`); return; }
  // 视频节点：与服务端相同的单端口上限和参考合计 12；其余组合（如只有参考音频）交给执行预览判断。
  if (target.kind === 'video') { const issue = videoConnectIssue(target, connection.targetHandle, draft.edges, draft.tasks); if (issue) { setError(issue); return; } }
  const nextEdges = [...draft.edges, { id: uid(), source: connection.source, sourceHandle: connection.sourceHandle, target: connection.target, targetHandle: connection.targetHandle }];
  const seen = new Set();
  const reaches = id => { if (id === connection.source) return true; if (seen.has(id)) return false; seen.add(id); return nextEdges.filter(e => e.source === id).some(e => reaches(e.target)); };
  if (reaches(connection.target)) { setError('连线会形成循环依赖。'); return; }
  if (runs.some(r => r.taskId === target.id && isActive(r.status))) { setError('运行中的节点不能修改连线。'); return; }
  // 多参考图端口保留已有的固定版本与素材（服务端会拒绝失效的固定）；单图端口沿用清空旧选择。
  change({ ...draft, edges: nextEdges, tasks: draft.tasks.map(t => t.id === target.id && !input[2] && (target.kind !== 'video' || connection.targetHandle === 'first') ? { ...t, sourceRunId: null, ...(target.kind === 'video' ? {} : { sourceRunIds: [] }), sourceAssetId: null } : t) });
 }
 function deleteTask(id) {
  if (!writable || id?.startsWith('result:')) return;
  const item = draft.tasks.find(t => t.id === id); if (!item) return;
  if (runs.some(r => r.taskId === id)) { setError('已有生成记录的节点不能删除。'); return; }
  if (runs.some(r => r.taskId === id && isActive(r.status))) { setError('运行中的节点不能删除。'); return; }
  change({ ...draft, tasks: draft.tasks.filter(t => t.id !== id), edges: draft.edges.filter(e => e.source !== id && e.target !== id) });
  selectNodes([]);
 }
 function duplicateTask(id) {
  if (!writable) return;
  const item = draft.tasks.find(t => t.id === id); if (!item) return;
  const nextId = uid();
  change({ ...draft, tasks: [...draft.tasks, { ...copy(item), id: nextId, title: `${item.title} 副本`, position: { x: item.position.x + 40, y: item.position.y + 40 }, sourceRunId: null, sourceRunIds: [] }] });
  selectNodes([nextId]);
 }
 async function startPreview(data) {
  const composite = data.scope.filter(s => s.action === 'composite').map(s => s.taskId);
  const regular = data.scope.filter(s => ['generate', 'reuse', 'recover'].includes(s.action)).map(s => s.taskId);
  if (regular.length) {
   try {
    accept(await creationRequest(backend, base + '/start', { ...data.selection, previewToken: data.previewToken, requestKey: uid() }));
   } catch (e) {
    // 所选节点的输入在预览后被改动：重新预览并提示，不锁定编辑。
    if (e.code !== 'PREVIEW_CHANGED') throw e;
    setPreview(await creationRequest(backend, base + '/preview', { taskIds: data.selection.taskIds, retryTaskIds: data.selection.retryTaskIds || [], regenerateTaskIds: data.selection.regenerateTaskIds || [] }));
    notify?.('执行范围已变化，请确认新的预览后再开始');
    return;
   }
  }
  for (const id of composite) await runComposite(id);
  notify?.(regular.length ? '已开始运行' : '合成完成');
 }
 async function runTasks(ids, options = {}) {
  if (!ids.length) { setError('请先选择要运行的节点。'); return; }
  await work(async () => {
   await flush();
   const data = await creationRequest(backend, base + '/preview', { taskIds: ids, retryTaskIds: options.retry || [], regenerateTaskIds: options.regenerate || [] });
   if (options.direct && data.canStart) { await startPreview(data); return; }
   setPreview(data);
  });
 }
 async function runComposite(id) {
  const item = draftRef.current.tasks.find(t => t.id === id);
  const images = draftRef.current.edges.filter(e => e.target === id && e.targetHandle === 'images').map(e => {
   const source = draftRef.current.tasks.find(t => t.id === e.source);
   if (!source) return null;
   if (source.kind === 'product' || source.kind === 'image') return source.sourceAssetId;
   return runs.filter(r => r.taskId === source.id && r.status === 'succeeded' && r.output?.assetId).at(-1)?.output?.assetId || null;
  }).filter(Boolean);
  if (!images.length) throw new Error('合成节点需要至少一张上游成功图片。');
  const layout = item.params?.layout || 'vertical3', width = Number(item.params?.width) || 1242, height = Number(item.params?.height) || 1660;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d'); context.fillStyle = '#f4f5f7'; context.fillRect(0, 0, width, height);
  const slots = layout === 'grid4' ? 4 : layout === 'single' ? 1 : 3;
  const use = images.slice(0, slots);
  const cols = layout === 'grid4' ? 2 : 1, rows = Math.ceil(use.length / cols);
  const slotW = width / cols, slotH = height / rows;
  for (const [index, assetId] of use.entries()) {
   const blob = await (await fetch(fileUrl(assetId))).blob();
   const bitmap = await createImageBitmap(blob);
   const x = (index % cols) * slotW, y = Math.floor(index / cols) * slotH, gap = 12;
   const scale = Math.max((slotW - gap * 2) / bitmap.width, (slotH - gap * 2) / bitmap.height);
   const drawW = bitmap.width * scale, drawH = bitmap.height * scale;
   context.save(); context.beginPath(); context.rect(x + gap, y + gap, slotW - gap * 2, slotH - gap * 2); context.clip();
   context.drawImage(bitmap, x + (slotW - drawW) / 2, y + (slotH - drawH) / 2, drawW, drawH); context.restore();
  }
  const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('合成图片生成失败。');
  const asset = await uploadBlob(png, `合成-${item.title}.png`, 'result', projectId, id);
  const data = await creationRequest(backend, base + '/composite', { taskId: id, requestKey: uid(), assetId: asset.id });
  accept(data);
 }
 async function uploadBlob(blob, name, role, projectId, taskId, baseAssetId) {
  const query = new URLSearchParams({ name, mime: blob.type || 'image/png', role, ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}), ...(baseAssetId ? { baseAssetId } : {}) });
  const response = await fetch(`/api/creation/assets/upload?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': backend?.csrf || backend?.session?.csrfToken || '' }, body: blob });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '上传失败。'); return data.asset;
 }
 async function runAll() {
  const ids = draft.tasks.filter(t => scope.owned.has(t.id) && EXECUTABLE.has(t.kind)).map(t => t.id);
  await runTasks(ids);
 }
 async function retryRun(run) {
  if (!window.confirm('为这个失败节点创建新的生成请求？')) return;
  await runTasks([run.taskId], { retry: [run.taskId], direct: true });
 }
 async function retryAllFailed() {
  const ids = [...new Set(runs.filter(r => scope.owned.has(r.taskId) && r.status === 'failed').map(r => r.taskId))];
  if (!ids.length) { notify?.('没有失败任务'); return; }
  if (!window.confirm(`为当前任务的 ${ids.length} 个失败节点创建新的生成请求？`)) return;
  await runTasks(ids, { retry: ids, direct: true });
 }
 async function suggest() {
  await work(async () => {
   await flush();
   const data = await creationRequest(backend, base + '/suggest', { instructions, allowVideo, requestKey: uid() });
   accept(data); setPlanning(false);
   if (data.suggestion?.status === 'failed') setError(data.suggestion.error);
  });
 }
 async function applyProposal(proposal) {
  await work(async () => { await flush(); accept(await creationRequest(backend, base + '/apply-suggestion', { suggestionId: proposal.id })); setDismissedProposal(proposal.id); });
 }
 async function downloadZip() {
  await work(async () => {
   const runIds = runs.filter(r => scope.owned.has(r.taskId) && r.status === 'succeeded' && r.output?.assetId).map(r => r.id);
   const response = await fetch(base + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': backend?.csrf || backend?.session?.csrfToken || '' }, body: JSON.stringify({ runIds }) });
   if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message || '打包失败'); }
   const url = URL.createObjectURL(await response.blob()), a = document.createElement('a'); a.href = url; a.download = `${draft.name}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
 }
 async function addFile(event, role, nodeId, picked) {
  const file = picked || event.target.files?.[0]; if (event?.target) event.target.value = ''; if (!file) return;
  await work(async () => { const asset = await uploadBlob(file, file.name, role, projectId); setAssets(old => [asset, ...old]); editNode(nodeId, { sourceAssetId: asset.id, sourceRunId: null }); });
 }
 function removeEdge(edgeId) { removeEdges([edgeId]); }
 function removeEdges(edgeIds) {
  if (!writable) return;
  const gone = draft.edges.filter(e => edgeIds.includes(e.id));
  // 同步清理附加固定版本：来源连线被移除后，指向该来源的固定会被服务端拒绝。
  const tasks = draft.tasks.map(t => {
   const lost = gone.filter(g => g.target === t.id);
   if (!lost.length || !t.sourceRunIds?.length) return t;
   const remaining = draft.edges.filter(e => !edgeIds.includes(e.id) && e.target === t.id).map(e => e.source);
   return { ...t, sourceRunIds: t.sourceRunIds.filter(id => { const source = runs.find(r => r.id === id)?.taskId; return remaining.includes(source) || !lost.some(g => g.source === source); }) };
  });
  change({ ...draft, tasks, edges: draft.edges.filter(e => !edgeIds.includes(e.id)) });
 }
 // 局部精修：上传蒙版后新建连好线的改图节点并弹出执行预览（不会直接开始付费生成）。
 async function submitRefine({ blob, instruction }) {
  const target = refine, task = draftRef.current.tasks.find(t => t.id === target.taskId);
  if (!task) throw new Error('节点已不存在。');
  if (target.mode === 'redraw') {
   const run = runs.find(r => r.id === task.sourceRunId && r.output?.assetId);
   const baseId = run?.output?.assetId || task.sourceAssetId;
   if (!baseId) throw new Error('找不到这个改图节点的原图，请先选择来源版本。');
   const mask = await uploadBlob(blob, `蒙版-${task.title}.png`, 'mask', projectId, task.id, baseId);
   editNode(task.id, { maskAssetId: mask.id, ...(instruction ? { prompt: instruction } : {}) });
   setRefine(null); return;
  }
  const run = runs.find(r => r.id === target.runId && r.status === 'succeeded' && r.output?.assetId);
  if (!run) throw new Error('这个结果版本不可用，请重新选择。');
  const mask = await uploadBlob(blob, `蒙版-${task.title}.png`, 'mask', projectId, task.id, run.output.assetId);
  const current = draftRef.current, id = uid();
  const created = { id, workflowId: task.workflowId, kind: 'edit', title: '局部精修', prompt: instruction, params: { size: task.params?.size || '1024x1024' }, subject: task.subject || 'concept', productSnapshot: task.productSnapshot ?? current.productSnapshot, position: { x: task.position.x + 400, y: task.position.y }, sourceAssetId: null, sourceRunId: run.id, sourceRunIds: [], maskAssetId: mask.id };
  change({ ...current, tasks: [...current.tasks, created], edges: [...current.edges, { id: uid(), source: task.id, sourceHandle: 'image', target: id, targetHandle: 'image' }] });
  setRefine(null); selectNodes([id]);
  await runTasks([id]);
 }
 function toggleFullscreen() {
  const box = canvasBox.current; if (!box) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else box.requestFullscreen?.().catch(() => {});
 }
 function zoomStep(direction) {
  const instance = flow.current; if (!instance) return;
  const zoom = Math.min(2, Math.max(0.05, (instance.getViewport()?.zoom || 1) * (direction > 0 ? 1.2 : 1 / 1.2)));
  instance.zoomTo(zoom, { duration: 200 });
 }

 useEffect(() => {
  const onKey = event => {
   if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
   if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
   if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
   if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) { event.preventDefault(); deleteTask(selectedId); }
  };
  window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
 }, [selectedId, draft, runs]);

 if (!loaded) return <p className="cp-empty" role="status">正在加载画布…</p>;
 if (!draft) return <div className="cp-error" role="alert">{error}<button onClick={() => reload().catch(() => {})}>重新加载</button></div>;
 const proposal = (draft.suggestions || []).findLast(s => s.status === 'ready' && s.id !== dismissedProposal);
 const workflowRuns = runs.filter(r => scope.owned.has(r.taskId));
 const activeCount = workflowRuns.filter(r => isActive(r.status)).length;
 const succeedCount = workflowRuns.filter(r => r.status === 'succeeded').length;
 const failedCount = workflowRuns.filter(r => r.status === 'failed').length;
 const unknownCount = workflowRuns.filter(r => r.status === 'unknown').length;
 const visibleRuns = workflowRuns.filter(r => queueFilter === 'all' || (queueFilter === 'active' ? isActive(r.status) : r.status === queueFilter)).toReversed();
 const saveLabel = { saved: '已保存', dirty: '未保存', saving: '保存中…', failed: '保存失败' }[saveState.state];

 // 编辑器失焦（输入框 / 文本域 / 下拉框）时立即发送；延后一拍，让 DraftText 先完成提交。
 const flushOnBlur = event => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) setTimeout(() => queueRef.current?.flush().catch(() => {}), 0); };
 return <section className="v3-shell task-canvas" onBlur={flushOnBlur}>
  <header className="v3-topbar">
   <button className="v3-icon" title="返回项目" aria-label="返回项目" onClick={async () => { if (!dirty) { onBack?.(); return; } try { await flush(); onBack?.(); } catch { if (window.confirm('改动还没有保存成功，确定返回？')) onBack?.(); } }}>←</button>
   <div className="v3-crumb"><DraftText aria-label="项目名称" value={draft.name} disabled={!writable} maxLength={200} onCommit={name => change({ ...draftRef.current, name })} /><small><span className={`v3-saved${saveState.state === 'failed' ? ' failed' : dirty ? ' pending' : ''}`} role="status" title={saveState.error || undefined}>{saveLabel}</span>{saveState.state === 'failed' && <button type="button" className="v3-link" onClick={() => queueRef.current?.retry().catch(() => {})}>重试</button>} · 实际成本 {costText(detail.cost)}</small></div>
   <div className="v3-top-actions">
    <button className="v3-btn" disabled={!undoRef.current.length} onClick={undo} title="撤销 Ctrl+Z" aria-label="撤销">↶</button>
    <button className="v3-btn" disabled={!redoRef.current.length} onClick={redo} title="重做 Ctrl+Shift+Z" aria-label="重做">↷</button>
    <button className="v3-btn vr-toolbar-btn" onClick={() => setRolesOpen(true)}>角色与音色</button>
    <button className="v3-btn" disabled={!succeedCount || busy} onClick={downloadZip}>打包当前任务</button>
    {draft.productId && <button className="v3-btn" disabled={!writable || busy} onClick={() => { if (window.confirm('将最新商品资料同步到本项目未开始的节点？已有生成记录保持不变。')) work(async () => { await flush(); accept(await creationRequest(backend, base + '/sync-product', {})); notify?.('商品资料已同步'); }); }}>同步商品资料</button>}
    <button className="v3-btn" disabled={!writable || busy} onClick={() => setPlanning(true)}>AI 安排</button>
    <button className="v3-btn primary" disabled={!writable || busy} onClick={runAll}>预览并运行当前任务</button>
   </div>
  </header>
  <nav className="v3-viewtabs" aria-label="项目视图">
   <button className={view !== 'video' ? 'on' : ''} onClick={() => onSwitchView?.('canvas')}>画布</button>
   <button className={view === 'video' ? 'on' : ''} onClick={() => onSwitchView?.('video')}>视频工作台</button>
   <span className="v3-grow" />
   <span className="v3-viewtabs-note">视频工作台：脚本 → 分镜 → 逐镜生成 → 拼接成片</span>
  </nav>
  {rolesOpen && <VoiceRolesPanel roles={draft.voiceRoles || []} configured={voiceConfigured} writable={writable} assets={assets} request={(path, body) => creationRequest(backend, path, body)} onSave={saveRoles} onClose={() => setRolesOpen(false)} />}
  {error && <div className="v3-alert" role="alert">{error}<button aria-label="关闭" onClick={() => setError('')}>×</button></div>}
  {view === 'video' ? <CreationVideoStudio backend={backend} notify={notify} projectId={projectId} detail={detail} draft={draft} editor={buildEditor()} flush={flush} accept={accept} busy={busy} writable={writable} creationRequest={creationRequest} fileUrl={fileUrl} openPreview={data => setPreview(data)} />
   : <>
  <div className="task-workspace">
   <aside className="creative-task-list" aria-label="创作任务">
    <header><div><h2>创作任务 <small>{draft.workflows.length}</small></h2><p>选择任务，编辑完整流程</p></div><button className="v3-btn primary" disabled={!writable || busy} onClick={() => setNewWorkflow(true)}>＋ 新增任务</button></header>
    <input type="search" aria-label="搜索任务" placeholder="搜索任务" value={taskQuery} onChange={e => setTaskQuery(e.target.value)} />
    <div className="creative-task-items">{draft.workflows.filter(w => w.title.toLowerCase().includes(taskQuery.toLowerCase())).map(w => {
     const members = draft.tasks.filter(t => t.workflowId === w.id), history = runs.filter(r => members.some(t => t.id === r.taskId));
     const active = history.findLast(r => isActive(r.status)); const last = active || history.at(-1);
     const thumbnail = history.findLast(r => r.status === 'succeeded' && r.output?.assetId && r.input?.kind !== 'video')?.output?.assetId || members.find(t => t.sourceAssetId)?.sourceAssetId;
     return <button key={w.id} className={`creative-task-item ${currentWorkflow.id === w.id ? 'selected' : ''}`} aria-pressed={currentWorkflow.id === w.id} onClick={() => selectWorkflow(w.id)}><span className="creative-task-thumb">{thumbnail ? <img src={fileUrl(thumbnail)} alt="" /> : members.some(t => t.kind === 'video') ? '▷' : '▧'}</span><span><strong>{w.title}</strong><small>{members.length} 个流程节点</small><span className={`v3-badge ${last?.status || 'idle'}`}>{statusLabels[last?.status] || '未开始'}</span></span></button>;
    })}</div>
    <footer><span>所有修改自动保存</span></footer>
   </aside>
   <div className="task-workspace-main">
  <div className="v3-main">
   <div className="v3-canvas-area">
    <div className="v3-toolbar">
     <div className="current-task-title"><DraftText aria-label="创作任务名称" maxLength={100} value={currentWorkflow.title} disabled={!writable} onCommit={title => change({ ...draftRef.current, workflows: draftRef.current.workflows.map(w => w.id === currentWorkflow.id ? { ...w, title } : w) })} /><small>当前任务流程 · {scope.owned.size} 个节点</small></div><span className="v3-grow" />
     <button className="v3-tool add" onClick={() => setShowPalette(v => !v)} disabled={!writable}>＋ 添加节点</button>

     <button className="v3-tool" disabled={!writable || busy} onClick={arrangeLayout} title="整理当前任务的节点布局">⇔ 整理布局</button>
     <button className="v3-tool" disabled={!writable} onClick={removeWorkflow} title="删除当前任务">删除任务</button>
     {showPalette && <div className="v3-palette-list">{Object.entries(NODE).map(([kind, meta]) => <button key={kind} onClick={() => addNode(kind)}><i style={{ '--c': meta.color }} />{meta.label}</button>)}</div>}
    </div>
    <div className="v3-canvas" ref={canvasBox}>
     <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.05} maxZoom={2}
      nodesDraggable={writable && !busy} nodesConnectable={writable && !busy} elementsSelectable deleteKeyCode={null}
      panOnDrag={tool !== 'select'} selectionOnDrag={tool === 'select'}
      onNodesChange={nodesChange} onEdgesChange={edgesChange} onConnect={connect}
      isValidConnection={isValidConnectionCallback}
      onSelectionChange={onSelectionChangeCallback}
      onNodeDragStart={onNodeDragStartCallback}
      onNodeDragStop={onNodeDragStopCallback}
      onConnectStart={onConnectStartCallback}
      onConnectEnd={onConnectEndCallback}
      onMoveEnd={onMoveEndCallback}
      onInit={onInitCallback}>
      <Background gap={24} size={1} /><MiniMap position="bottom-right" pannable zoomable style={{ width: 150, height: 100, marginBottom: 48, marginRight: 2 }} nodeColor={n => n.data.task ? NODE[n.data.task.kind].color : '#22C55E'} />
     </ReactFlow>
     <div className="v3-rail" role="toolbar" aria-label="画布工具">
      <button className={tool === 'pan' ? 'on' : ''} title="抓手（拖动画布）" aria-label="抓手工具" onClick={() => setTool('pan')}>✋</button>
      <button className={tool === 'select' ? 'on' : ''} title="选择（框选节点）" aria-label="选择工具" onClick={() => setTool('select')}>➤</button>
      <hr />
      <button title="适应视图" aria-label="适应视图" onClick={() => flow.current?.fitView({ padding: 0.2, duration: 250 })}>⤢</button>
     </div>
     <div className="v3-zoom" role="toolbar" aria-label="缩放">
      <button onClick={() => zoomStep(-1)} aria-label="缩小">−</button>
      <span className="pct">{zoomPct}%</span>
      <button onClick={() => zoomStep(1)} aria-label="放大">＋</button>
      <button onClick={toggleFullscreen} aria-label="全屏">⛶</button>
     </div>
     <div className="v3-hint">拖动端口连线 · Delete 删除选中 · Ctrl+Z 撤销</div>
    </div>
   </div>
  </div>
  <section className="v3-queue" aria-label="任务队列">
   <header><button className="queue-toggle" aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)}><h3>当前任务运行记录</h3><span>{queueOpen ? "⌄" : "⌃"}</span></button><div className="v3-tabs">{[['all', `全部 ${workflowRuns.length}`], ['active', `运行中 ${activeCount}`], ['succeeded', `成功 ${succeedCount}`], ['failed', `失败 ${failedCount}`], ['unknown', `待核实 ${unknownCount}`]].map(([key, label]) => <button key={key} className={queueFilter === key ? 'on' : ''} onClick={() => setQueueFilter(key)}>{label}</button>)}</div><div className="v3-grow" /><button className="v3-btn small" onClick={retryAllFailed} disabled={!writable || busy || !failedCount}>↻ 重试失败</button></header>
   {queueOpen && <div className="v3-queue-scroll">
    <table><thead><tr><th>#</th><th /><th>任务名称</th><th>类型</th><th>状态</th><th>模型</th><th>耗时</th><th>费用</th><th>错误</th><th /></tr></thead>
     <tbody>{visibleRuns.map((r, index) => { const item = draft.tasks.find(t => t.id === r.taskId); const seconds = Math.max(1, Math.round((new Date(r.updatedAt) - new Date(r.createdAt)) / 1000)); const thumb = r.output?.assetId || item?.sourceAssetId || null; const isVideo = r.input?.kind === 'video' || item?.kind === 'video'; return <tr key={r.id} data-run={r.id} onClick={() => item && selectNodes([item.id])}>
      <td className="num">{index + 1}</td>
      <td className="thumb">{thumb ? (isVideo ? <span className="qthumb video">▶</span> : <img className="qthumb" src={fileUrl(thumb)} alt="" loading="lazy" />) : <span className="qthumb video">—</span>}</td>
      <td className="name">{item?.title || r.input?.task?.title || '已删除节点'}{r.error?.message && <small className="qerr">{r.error.message}</small>}</td>
      <td>{item ? NODE[item.kind]?.label || item.kind : r.input?.nodeKind || '—'}</td>
      <td className="status"><span className={r.status}><i />{statusLabels[r.status]}</span></td>
      <td>{r.input?.model?.modelId || r.input?.task?.model?.modelId || '默认模型'}</td>
      <td>{isActive(r.status) ? '—' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`}</td>
      <td>{Number.isSafeInteger(r.usage?.costMicros) ? `¥${(r.usage.costMicros / 1e6).toFixed(2)}` : '未统计'}</td>
      <td className="err" title={r.error?.message || ''}>{r.error?.message || '—'}</td>
      <td className="actions" onClick={e => e.stopPropagation()}>
       {r.status === 'failed' && <button onClick={() => retryRun(r)} disabled={!writable || busy}>重试</button>}
       {isActive(r.status) && <button onClick={() => work(async () => accept(await creationRequest(backend, base + '/cancel', { runIds: [r.id] })))} disabled={!writable || busy}>取消</button>}
       {r.status === 'unknown' && <button onClick={() => work(async () => accept(await creationRequest(backend, base + '/recover', { runIds: [r.id] })))} disabled={!writable || busy}>核实</button>}
       {r.status === 'succeeded' && r.output?.assetId && <a href={`${fileUrl(r.output.assetId)}?download=1`} download>下载</a>}
      </td>
     </tr>; })}
      {!visibleRuns.length && <tr><td colSpan="10" className="v3-empty">还没有运行记录。选择节点后点「运行选中」，或点「预览并运行」。</td></tr>}
     </tbody></table>
   </div>}
  </section>
   </div></div>
   </>}
  {newWorkflow && <div className="v3-overlay"><form className="v3-dialog" role="dialog" aria-modal="true" aria-label="新增创作任务" onSubmit={addWorkflow}><header><h2>新增创作任务</h2><button type="button" aria-label="关闭" onClick={() => setNewWorkflow(false)}>×</button></header><label className="v3-field"><span>任务名称</span><input autoFocus required maxLength={100} value={workflowName} onChange={e => setWorkflowName(e.target.value)} placeholder="例如：秋日场景主图" /></label><label className="v3-field"><span>任务类型</span><select value={workflowKind} onChange={e => setWorkflowKind(e.target.value)}><option value="generate">图片生成</option><option value="edit">图片修改</option><option value="video">视频生成</option><option value="composite">图片合成</option></select></label><p className="v3-note">创建后，在画布中修改参考图、提示词与生成参数。</p><footer><button type="button" className="v3-btn" onClick={() => setNewWorkflow(false)}>取消</button><button className="v3-btn primary">创建任务</button></footer></form></div>}
  {refine && (() => { const task = draft.tasks.find(t => t.id === refine.taskId); const baseId = refine.mode === 'redraw' ? (runs.find(r => r.id === task?.sourceRunId)?.output?.assetId || task?.sourceAssetId) : runs.find(r => r.id === refine.runId)?.output?.assetId; return baseId ? <MaskEditor assetId={baseId} title={refine.mode === 'redraw' ? '重新绘制蒙版' : '局部精修'} confirmLabel={refine.mode === 'redraw' ? '保存蒙版' : '确认并预览'} initialInstruction={refine.mode === 'redraw' ? task?.prompt || '' : ''} onCancel={() => setRefine(null)} onConfirm={submitRefine} /> : null; })()}
  {preview && <div className="v3-overlay"><div className="v3-dialog" role="dialog" aria-modal="true" aria-label="执行范围预览"><header><h2>执行范围</h2><button aria-label="关闭" onClick={() => setPreview(null)}>×</button></header><ol>{preview.scope.map(entry => <li key={entry.taskId}><div><strong>{entry.title}</strong><span>{entry.action === 'blocked' ? '需要处理' : entry.action === 'reuse' ? '复用成功版本' : entry.action === 'recover' ? '核实原请求' : entry.action === 'retry-confirm' ? '待确认重试' : entry.action === 'composite' ? '本地合成' : '新生成'}</span></div>{entry.reason && <p>{entry.reason}</p>}{entry.estimatedPoints > 0 && <p className="pv-points">预估 {pointText(entry.estimatedPoints)}</p>}{entry.dialogueWarning && <p className="pv-warn">{entry.dialogueWarning}</p>}</li>)}</ol>{preview.estimatedPoints > 0 && <div className="pv-summary" aria-label="积分预估"><div><span>预估合计</span><strong>{pointText(preview.estimatedPoints)}</strong></div><div><span>可用积分</span><strong>{preview.balance ? pointText(preview.balance.available) : '余额未知'}</strong></div>{preview.balanceReason && <p className="pv-short" role="alert">{preview.balanceReason}</p>}</div>}<footer><button className="v3-btn" onClick={() => setPreview(null)}>取消</button><button className="v3-btn primary" disabled={!preview.canStart || busy || !writable} onClick={() => { const data = preview; setPreview(null); work(() => startPreview(data)); }}>开始</button></footer></div></div>}
  {planning && <div className="v3-overlay"><div className="v3-dialog" role="dialog" aria-modal="true" aria-label="AI 安排"><header><h2>AI 安排</h2><button aria-label="关闭" onClick={() => setPlanning(false)}>×</button></header><label className="v3-field"><span>创作要求</span><textarea autoFocus rows={6} maxLength={8000} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="例如：再补两张衣柜场景图，突出防尘盖" /></label><label className="v3-check"><input type="checkbox" checked={allowVideo} onChange={e => setAllowVideo(e.target.checked)} />包含视频任务</label><footer><button className="v3-btn" onClick={() => setPlanning(false)}>取消</button><button className="v3-btn primary" disabled={!instructions.trim() || busy || !writable} onClick={suggest}>{busy ? '正在安排…' : '生成安排'}</button></footer></div></div>}
  {proposal && proposal.status === 'ready' && <div className="v3-overlay"><div className="v3-dialog" role="dialog" aria-modal="true" aria-label="待确认的 AI 安排"><header><h2>待确认的 AI 安排</h2><button aria-label="关闭" onClick={() => setDismissedProposal(proposal.id)}>×</button></header><p className="v3-dialog-lead">新增 {proposal.plan.additions.length} 个节点，修改 {proposal.plan.updates.length} 个节点。确认后才会写入画布，不会自动生成。</p><div className="v3-plan-list">{proposal.plan.additions.map((t, i) => <article key={i}><strong>{t.title}</strong><span>{t.kind === 'video' ? '视频' : t.kind === 'edit' ? '改图' : '生图'}</span><p>{t.prompt}</p></article>)}{proposal.plan.updates.map(t => <article key={t.id}><strong>{draft.tasks.find(x => x.id === t.id)?.title || t.id}</strong><span>修改</span><p>{JSON.stringify(t.changes)}</p></article>)}</div><footer><button className="v3-btn" onClick={() => setDismissedProposal(proposal.id)}>取消</button><button className="v3-btn primary" disabled={!writable || busy} onClick={() => applyProposal(proposal)}>确认应用</button></footer></div></div>}
 </section>;
}
