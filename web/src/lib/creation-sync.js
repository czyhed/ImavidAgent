// 画布 / 视频工作台的增量保存：快照比对生成操作、操作叠加（变基）、合并、保存队列与轻量状态合并。
// 全部是纯函数或可注入定时器的小类，便于单元测试。协议见 docs/requirements/creation-sync-grilling.md。

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
// 深比较；值为 undefined 的键视同缺失（JSON 序列化时本来就会丢弃）。
export function same(a, b) {
 if (a === b) return true;
 if (a === undefined || b === undefined || a === null || b === null) return false;
 if (typeof a !== 'object' || typeof b !== 'object') return false;
 if (Array.isArray(a) !== Array.isArray(b)) return false;
 if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => same(item, b[index]));
 const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
 for (const key of keys) if (!same(a[key], b[key])) return false;
 return true;
}
// 服务端独占写入的节点字段，客户端既不提交也不比较。
const SERVER_ONLY = new Set(['id', 'dialogueAudio']);
const minShot = shot => ({ id: shot.id, title: shot.title ?? '', description: shot.description ?? '', nodeId: shot.nodeId ?? null });

// 把项目详情里与保存相关的部分取成快照；分镜只取脚本与分镜表（批次 / 成片状态不属于用户编辑）。
export function toSnapshot(project) {
 const storyboard = project?.storyboard && typeof project.storyboard === 'object' ? project.storyboard : null;
 return {
  name: project?.name ?? '',
  voiceRoles: project?.voiceRoles ?? [],
  workflows: project?.workflows ?? [],
  tasks: project?.tasks ?? [],
  edges: project?.edges ?? [],
  // 还没有分镜的项目视同空分镜，首次填写脚本 / 添加分镜时才能比出差异。
  storyboard: { script: typeof storyboard?.script === 'string' ? storyboard.script : '', settings: storyboard?.settings && typeof storyboard.settings === 'object' ? storyboard.settings : null, shots: (Array.isArray(storyboard?.shots) ? storyboard.shots : []).map(minShot) },
 };
}

function diffTask(before, after) {
 const fields = {}, unset = [];
 for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (SERVER_ONLY.has(key)) continue;
  if (same(before[key], after[key])) continue;
  if (after[key] === undefined) unset.push(key); else fields[key] = clone(after[key]);
 }
 return Object.keys(fields).length || unset.length ? { type: 'task.patch', id: after.id, ...(Object.keys(fields).length ? { fields } : {}), ...(unset.length ? { unset } : {}) } : null;
}
const withoutServerOnly = task => Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'dialogueAudio'));

// 前后快照 → 操作列表。顺序保证服务端按依赖应用：先建任务容器与删连线 / 节点，再加节点与连线。
export function diffOps(prev, next) {
 const a = toSnapshot(prev), b = toSnapshot(next);
 const ops = [];
 const byId = list => new Map(list.map(item => [item.id, item]));
 const wa = byId(a.workflows), wb = byId(b.workflows);
 for (const w of b.workflows) if (!same(wa.get(w.id), w)) ops.push({ type: 'workflow.put', workflow: clone(w) });
 const ea = byId(a.edges), eb = byId(b.edges);
 // 连线内容变化（同编号）按「先删后加」处理。
 for (const e of a.edges) if (!eb.has(e.id) || !same(e, eb.get(e.id))) ops.push({ type: 'edge.remove', id: e.id });
 const ta = byId(a.tasks), tb = byId(b.tasks);
 for (const t of a.tasks) if (!tb.has(t.id)) ops.push({ type: 'task.remove', id: t.id });
 for (const w of a.workflows) if (!wb.has(w.id)) ops.push({ type: 'workflow.remove', id: w.id });
 for (const t of b.tasks) if (!ta.has(t.id)) ops.push({ type: 'task.add', task: clone(withoutServerOnly(t)) });
 for (const t of b.tasks) { const before = ta.get(t.id); if (before) { const op = diffTask(before, t); if (op) ops.push(op); } }
 for (const e of b.edges) if (!ea.has(e.id) || !same(ea.get(e.id), e)) ops.push({ type: 'edge.add', edge: clone(e) });
 const project = {};
 if (a.name !== b.name) project.name = b.name;
 if (!same(a.voiceRoles, b.voiceRoles)) project.voiceRoles = clone(b.voiceRoles);
 if (Object.keys(project).length) ops.push({ type: 'project.patch', ...project });
 {
  const sb = {};
  if (a.storyboard.script !== b.storyboard.script) sb.script = b.storyboard.script;
  if (!same(a.storyboard.shots, b.storyboard.shots)) sb.shots = clone(b.storyboard.shots);
  // 项目级视频参数（W4）：整体替换；null 表示清除。
  if (!same(a.storyboard.settings, b.storyboard.settings)) sb.settings = clone(b.storyboard.settings);
  if (Object.keys(sb).length) ops.push({ type: 'storyboard.patch', ...sb });
 }
 return ops;
}

// 服务端同样的规则：已有节点的分镜若没有 nodeId，沿用同编号分镜的节点。
function mergeShots(existing, incoming) {
 const known = new Map((existing || []).map(s => [s.id, s]));
 return incoming.map(shot => {
  const old = known.get(shot.id);
  return { ...(old || {}), ...minShot(shot), nodeId: shot.nodeId || old?.nodeId || null };
 });
}

// 把操作叠加到项目上（不修改入参）。引用不存在的节点 / 连线时静默跳过，与服务端一致。
export function applyOps(project, ops) {
 const next = clone(project);
 next.tasks = next.tasks || []; next.edges = next.edges || [];
 for (const op of ops || []) {
  if (op.type === 'project.patch') {
   if (op.name !== undefined) next.name = op.name;
   if (op.voiceRoles !== undefined) next.voiceRoles = clone(op.voiceRoles);
  } else if (op.type === 'storyboard.patch') {
   const sb = { ...(next.storyboard || {}) };
   if (op.script !== undefined) sb.script = op.script;
   if (op.shots !== undefined) sb.shots = mergeShots(sb.shots, op.shots);
   if (op.settings === null) delete sb.settings; else if (op.settings !== undefined) sb.settings = clone(op.settings);
   next.storyboard = sb;
  } else if (op.type === 'task.add') {
   if (!next.tasks.some(t => t.id === op.task.id)) next.tasks.push(clone(withoutServerOnly(op.task)));
  } else if (op.type === 'task.patch') {
   const index = next.tasks.findIndex(t => t.id === op.id);
   if (index < 0) continue;
   const { id: _id, dialogueAudio: _audio, ...fields } = clone(op.fields || {});
   const merged = { ...next.tasks[index], ...fields };
   for (const key of op.unset || []) if (!SERVER_ONLY.has(key)) delete merged[key];
   next.tasks[index] = merged;
  } else if (op.type === 'task.remove') {
   if (!next.tasks.some(t => t.id === op.id)) continue;
   next.tasks = next.tasks.filter(t => t.id !== op.id);
   next.edges = next.edges.filter(e => e.source !== op.id && e.target !== op.id);
   next.tasks = next.tasks.map(t => t.tailFrame && t.tailFrame.fromNodeId === op.id ? { ...t, tailFrame: null } : t);
  } else if (op.type === 'edge.add') {
   const edge = op.edge;
   if (next.edges.some(e => e.id === edge.id)) continue;
   if (!next.tasks.some(t => t.id === edge.source) || !next.tasks.some(t => t.id === edge.target)) continue;
   if (next.edges.some(e => e.source === edge.source && e.target === edge.target && (e.sourceHandle || null) === (edge.sourceHandle || null) && (e.targetHandle || null) === (edge.targetHandle || null))) continue;
   next.edges.push(clone(edge));
  } else if (op.type === 'edge.remove') {
   next.edges = next.edges.filter(e => e.id !== op.id);
  } else if (op.type === 'workflow.put') {
   next.workflows = next.workflows || [];
   const at = next.workflows.findIndex(w => w.id === op.workflow.id);
   if (at >= 0) next.workflows[at] = { ...next.workflows[at], ...clone(op.workflow) }; else next.workflows.push(clone(op.workflow));
  } else if (op.type === 'workflow.remove') {
   if (next.workflows) next.workflows = next.workflows.filter(w => w.id !== op.id);
  }
 }
 // 节点标题是分镜标题的唯一来源（服务端同样同步）。
 if (Array.isArray(next.storyboard?.shots)) {
  next.storyboard.shots = next.storyboard.shots.map(shot => {
   const title = typeof next.tasks.find(t => t.id === shot.nodeId)?.title === 'string' ? next.tasks.find(t => t.id === shot.nodeId).title.trim().slice(0, 100) : '';
   return title && title !== shot.title ? { ...shot, title } : shot;
  });
 }
 return next;
}

// 结构共享：内容相同的对象沿用旧引用。服务端 jsonb 会重排键序，若直接替换，依赖 JSON 字符串做 key 的受控 / 非受控输入框
// 会在用户编辑中途被重建；沿用旧引用后，没有变化的节点、连线、分镜完全不触发重渲染。
export function reuseUnchanged(prev, next) {
 if (!prev) return next;
 const share = (a, b, idOf = item => item.id) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return b;
  const old = new Map(a.map(item => [idOf(item), item]));
  const merged = b.map(item => { const before = old.get(idOf(item)); return before !== undefined && same(before, item) ? before : item; });
  return merged.length === a.length && merged.every((item, index) => item === a[index]) ? a : merged;
 };
 const out = { ...next };
 for (const key of ['tasks', 'edges', 'workflows']) if (next[key] !== undefined) out[key] = share(prev[key], next[key]);
 if (next.voiceRoles !== undefined) out.voiceRoles = same(prev.voiceRoles, next.voiceRoles) ? prev.voiceRoles : next.voiceRoles;
 if (next.storyboard && prev.storyboard) {
  const shots = share(prev.storyboard.shots, next.storyboard.shots);
  out.storyboard = same({ ...prev.storyboard, shots: undefined }, { ...next.storyboard, shots: undefined }) && shots === prev.storyboard.shots ? prev.storyboard : { ...next.storyboard, shots };
 }
 return out;
}

// 变基：以服务端最新项目为底，把尚未确认的本地操作重新叠加。
export const rebase = (serverProject, pendingOps) => applyOps(serverProject, pendingOps);

// 合并同一节点的连续修改，减少请求体：task.patch 合入同节点更早的 task.patch / task.add，project / storyboard / workflow.put 同理。
export function coalesce(ops) {
 const out = [];
 const mergePatch = (a, b) => {
  const fields = { ...(a.fields || {}) }, unset = new Set(a.unset || []);
  for (const [key, value] of Object.entries(b.fields || {})) { fields[key] = value; unset.delete(key); }
  for (const key of b.unset || []) { delete fields[key]; unset.add(key); }
  return { ...a, ...(Object.keys(fields).length ? { fields } : { fields: undefined }), ...(unset.size ? { unset: [...unset] } : { unset: undefined }) };
 };
 const clean = op => JSON.parse(JSON.stringify(op));
 for (const op of ops) {
  if (op.type === 'task.patch') {
   // 向前找同节点的最近一个 add / patch；中间若有同节点的 remove 则不能合并。
   let target = -1;
   for (let i = out.length - 1; i >= 0; i--) {
    const prev = out[i];
    if (prev.type === 'task.remove' && prev.id === op.id) break;
    if (prev.type === 'task.patch' && prev.id === op.id) { target = i; break; }
    if (prev.type === 'task.add' && prev.task.id === op.id) { target = i; break; }
   }
   if (target >= 0) {
    const prev = out[target];
    if (prev.type === 'task.patch') out[target] = clean(mergePatch(prev, op));
    else { const task = { ...prev.task, ...(op.fields || {}) }; for (const key of op.unset || []) delete task[key]; out[target] = { type: 'task.add', task: clone(task) }; }
    continue;
   }
  } else if (op.type === 'project.patch') {
   const i = out.findLastIndex(p => p.type === 'project.patch');
   if (i >= 0) { out[i] = { ...out[i], ...op }; continue; }
  } else if (op.type === 'storyboard.patch') {
   const i = out.findLastIndex(p => p.type === 'storyboard.patch');
   if (i >= 0) { out[i] = { ...out[i], ...op }; continue; }
  } else if (op.type === 'workflow.put') {
   const i = out.findLastIndex(p => p.type === 'workflow.put' && p.workflow.id === op.workflow.id);
   if (i >= 0 && !out.slice(i + 1).some(p => p.type === 'workflow.remove' && p.id === op.workflow.id)) { out[i] = { type: 'workflow.put', workflow: { ...out[i].workflow, ...op.workflow } }; continue; }
  }
  out.push(clone(op));
 }
 return out;
}

// ---------- 保存队列 ----------
export const isRetryable = error => error?.status === undefined || error.status >= 500 || error.status === 408 || error.status === 429;
// 登录过期 / 无权限：不丢弃改动，也不自动重试，等用户处理后点「重试」。
const isAuthFailure = error => error?.status === 401 || error?.status === 403;

export class SaveQueue {
 // send(ops, {keepalive}) → 服务端详情；onResult(data) 在确认后调用；onReject(error, ops) 在 4xx 丢弃一批后调用。
 constructor({ send, onResult = () => {}, onReject = () => {}, onStatus = () => {}, debounce = 1000, maxWait = 5000, retryDelays = [1000, 3000, 9000], setTimer = setTimeout, clearTimer = clearTimeout, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  // 定时器函数以普通函数调用（浏览器的 setTimeout 不能以队列实例作为 this）。
  Object.assign(this, { send, onResult, onReject, onStatus, debounce, maxWait, retryDelays, setTimer: (fn, ms) => setTimer(fn, ms), clearTimer: handle => clearTimer(handle), sleep: ms => sleep(ms), now: () => now() });
  this.pending = []; this.inflight = null; this.timer = null; this.firstAt = null; this.runner = null; this.failed = null; this.last = '';
 }
 // 已发送未确认 + 尚未发送的操作：变基时叠加到服务端状态上。
 outstanding() { return [...(this.inflight || []), ...this.pending]; }
 get state() { return this.failed ? 'failed' : this.inflight ? 'saving' : this.pending.length ? 'dirty' : 'saved'; }
 emit() { const state = this.state; const key = state + (this.failed?.message || ''); if (key !== this.last) { this.last = key; this.onStatus({ state, error: this.failed?.message || '' }); } }
 push(ops) {
  if (!ops?.length) return;
  this.pending = coalesce([...this.pending, ...ops]);
  this.emit();
  this.schedule();
 }
 // 最后一次改动后 debounce 毫秒发送；连续改动最长 maxWait 毫秒必发。
 schedule() {
  if (this.timer) this.clearTimer(this.timer);
  if (!this.pending.length) { this.timer = null; return; }
  if (this.firstAt === null) this.firstAt = this.now();
  const wait = Math.max(0, Math.min(this.debounce, this.firstAt + this.maxWait - this.now()));
  this.timer = this.setTimer(() => { this.timer = null; this.flush().catch(() => {}); }, wait);
 }
 // 立即发送并等待队列清空（含发送期间新增的改动）；失败（重试用尽 / 校验被拒）时抛出。
 flush({ keepalive = false } = {}) {
  if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
  if (this.runner) return this.runner;
  if (!this.pending.length) return Promise.resolve();
  this.runner = this.run({ keepalive }).finally(() => { this.runner = null; this.emit(); });
  return this.runner;
 }
 retry() { this.failed = null; this.emit(); return this.flush(); }
 async run({ keepalive }) {
  let rejected = null;
  while (this.pending.length) {
   const batch = this.pending; this.pending = []; this.inflight = batch; this.firstAt = null; this.failed = null; this.emit();
   let attempt = 0;
   for (;;) {
    try {
     const data = await this.send(batch, { keepalive });
     this.inflight = null;
     this.onResult(data, batch);
     break;
    } catch (error) {
     if (isAuthFailure(error) || (isRetryable(error) && attempt >= this.retryDelays.length)) {
      // 保留改动（放回队首），显示「保存失败 · 重试」。
      this.pending = coalesce([...batch, ...this.pending]); this.inflight = null; this.failed = error; this.emit();
      throw error;
     }
     if (isRetryable(error)) { await this.sleep(this.retryDelays[attempt]); attempt += 1; continue; }
     // 4xx 校验类错误：丢弃这一批，以服务端状态为准，保留其后的本地改动。
     this.inflight = null; rejected = rejected || error;
     this.onReject(error, batch);
     break;
    }
   }
  }
  if (rejected) throw rejected;
 }
 dispose() { if (this.timer) this.clearTimer(this.timer); this.timer = null; }
}

// ---------- 轻量状态 ----------
const ACTIVE = new Set(['queued', 'submitting', 'running', 'unknown', 'cancelling']);
export const isActiveRun = status => ACTIVE.has(status);
// 是否需要每 3 秒查询轻量状态：有运行中的生成、批量生成、配音 / 混音或成片拼接时。
export function needsPolling(detail) {
 if (!detail) return false;
 const batch = detail.project?.storyboard?.batch, compile = detail.project?.storyboard?.compile;
 return (detail.runs || []).some(r => isActiveRun(r.status))
  || Boolean(batch && (batch.state === 'running' || Object.values(batch.items || {}).some(item => item.status === 'running')))
  || compile?.status === 'running'
  || Object.values(detail.dubStates || {}).some(state => state?.dub?.status === 'running');
}
// 把轻量状态并入当前详情，不碰用户草稿。需要重新取完整详情时（他处编辑、出现未知运行、节点上的服务端字段可能变化、费用需刷新）返回 needsFull。
export function mergeStatus(detail, status) {
 if (!detail || !status) return { detail, needsFull: false };
 if (status.revision !== detail.project.revision) return { detail, needsFull: true, reason: 'revision' };
 const known = new Map((detail.runs || []).map(r => [r.id, r]));
 if ((status.runs || []).some(r => !known.has(r.id))) return { detail, needsFull: true, reason: 'new-run' };
 if (!same(status.dubStates || {}, detail.dubStates || {})) return { detail, needsFull: true, reason: 'dub' };
 let finished = false;
 const runs = status.runs.map(r => {
  const old = known.get(r.id);
  if (isActiveRun(old.status) && !isActiveRun(r.status)) finished = true;
  return { ...old, ...r, input: old.input };
 });
 if (finished) return { detail, needsFull: true, reason: 'finished' };
 const sb = detail.project.storyboard ? { ...detail.project.storyboard } : {};
 if (status.storyboard?.batch) sb.batch = status.storyboard.batch; else delete sb.batch;
 if (status.storyboard?.compile) sb.compile = status.storyboard.compile;
 return { detail: { ...detail, runs, project: { ...detail.project, storyboard: sb } }, needsFull: false };
}

// ---------- 画布视角（只存本机浏览器） ----------
export const viewKey = (projectId, workflowId) => `sj:canvas-view:${projectId}:${workflowId}`;
export function loadView(projectId, workflowId, storage) {
 try {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  const view = JSON.parse(store?.getItem(viewKey(projectId, workflowId)) ?? 'null');
  return view && [view.x, view.y, view.zoom].every(Number.isFinite) && view.zoom > 0 ? { x: view.x, y: view.y, zoom: view.zoom } : null;
 } catch { return null; }
}
export function saveView(projectId, workflowId, viewport, storage) {
 try {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  store?.setItem(viewKey(projectId, workflowId), JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }));
 } catch { /* 隐私模式或存储被禁用时忽略 */ }
}
