import { useEffect, useRef, useState } from 'react';
import '../styles/creation-video-studio.css';
import { ConfirmDialog } from './ui.jsx';
import DraftText from './DraftText.jsx';
import { VideoModePanel, VideoTagPreview, VideoDialogue, VideoParams, VideoAdvanced } from './VideoNodeEditor.jsx';
import { DubbedVideo } from './VoiceRoles.jsx';
import { Section, Drawer, Timeline, MaterialSlots, MaterialPicker, PreviewPlayer } from './VideoStudioParts.jsx';
import { pointText, analyzeVideoNode } from '../lib/video-node.js';
import { normalizeVideoParameters, VIDEO_RESOLUTIONS } from '../../../shared/creation-video-parameters.mjs';
import { SETTING_DEFAULTS, SETTING_RATIOS } from '../../../shared/creation-video-settings.mjs';
import { SLOT_BY_MODE, shownSettings, shotDuration, shotCustomKeys, followProjectParams, shotIssues, shownRun, succeededRuns, dubAssetFor, buildPlaylist, studioSummary, moveItem, clock } from '../lib/video-studio.js';

const uid = () => crypto.randomUUID();
const statusLabels = { queued: '排队中', submitting: '正在提交', running: '生成中', unknown: '生成中', cancelling: '正在取消', cancelled: '已取消', failed: '失败', succeeded: '成功' };
const isActive = status => ['queued', 'submitting', 'running', 'unknown', 'cancelling'].includes(status);
// 批量生成：分镜状态与批次状态的中文名称。
const batchItemLabels = { pending: '待派发', running: '生成中', succeeded: '已完成', failed: '失败', held: '等待上一镜（已暂停）' };
const batchStateLabels = { running: '进行中', paused: '已暂停', done: '已结束', cancelled: '已停止' };
// AI 分镜建议预览：方式与素材用途的中文名称。
const modeLabels = { text: '文生视频', frames: '首尾帧', reference: '参考素材' };
const slotLabels = { first: '首帧', last: '尾帧', refImage: '参考图', refVideo: '参考视频', refAudio: '参考音频' };
const kindLabels = { image: '图片', video: '视频', audio: '音频' };
const planActionLabels = { generate: '新生成', 'wait-prev': '等待上一镜', reuse: '复用成功版本', recover: '继续查询原任务', blocked: '需要处理' };
// 单镜编辑区各分区的默认展开状态：素材、提示词、预览展开，台词与参数折叠（W4）。
const SECTION_DEFAULT = { materials: true, prompt: true, dialogue: false, params: false, preview: true };

// 分镜表只保存顺序、标题、描述与节点编号；提示词、时长、方式、素材都在画布视频节点上（V-08）。
const emptyShot = index => ({ id: uid(), title: `分镜 ${index + 1}`, description: '', nodeId: null });
const normalize = sb => {
 const input = sb && typeof sb === 'object' ? sb : {};
 return {
  script: typeof input.script === 'string' ? input.script : '',
  shots: Array.isArray(input.shots) ? input.shots.map((shot, index) => ({ id: shot.id || uid(), title: shot.title || `分镜 ${index + 1}`, description: shot.description || '', nodeId: shot.nodeId || null })) : [],
  compile: input.compile && typeof input.compile === 'object' ? input.compile : { status: 'idle' },
  scriptRequest: input.scriptRequest || null,
  shotsRequest: input.shotsRequest || null,
  batch: input.batch || null,
 };
};

export default function CreationVideoStudio({ backend, notify, projectId, detail, draft: canvasDraft, editor, flush, accept, busy, writable, creationRequest, fileUrl, openPreview }) {
 const base = `/api/creation/projects/${projectId}`;
 const server = normalize(detail?.project?.storyboard);
 const runs = detail?.runs || [];
 // 脚本与分镜表就是画布草稿里的 storyboard：与画布共用同一保存队列，改动 1 秒后自动保存，没有单独的「保存分镜」。
 const local = normalize(canvasDraft?.storyboard);
 const sb = canvasDraft?.storyboard || null;
 const draft = { ...server, script: local.script, shots: local.shots.map(shot => ({ ...shot, tailFrameStale: server.shots.find(s => s.id === shot.id)?.tailFrameStale })) };
 const [error, setError] = useState(''), [saving, setSaving] = useState(false), [instructions, setInstructions] = useState('');
 const [confirmShot, setConfirmShot] = useState(null), [batchPlan, setBatchPlan] = useState(null), [burnSubtitles, setBurnSubtitles] = useState(false);
 const [selectedId, setSelectedId] = useState(null), [drawerChoice, setDrawerChoice] = useState(undefined), [player, setPlayer] = useState(false), [picker, setPicker] = useState(null);
 const [sections, setSections] = useState(SECTION_DEFAULT), [flash, setFlash] = useState(''), [focusReq, setFocusReq] = useState(null), [advancedOpen, setAdvancedOpen] = useState(false), [durationError, setDurationError] = useState('');
 const promptBox = useRef(null);
 const nodeOf = shot => (shot?.nodeId ? canvasDraft?.tasks.find(t => t.id === shot.nodeId) : null) || null;
 const plainShots = () => (editor.storyboard()?.shots || []).map(({ id, title, description, nodeId }) => ({ id, title, description, nodeId: nodeId || null }));
 const patchShots = update => editor.patchStoryboard({ shots: update(plainShots()) });
 const patchShot = (shotId, patch) => patchShots(shots => shots.map(s => s.id === shotId ? { ...s, ...patch } : s));
 useEffect(() => { setError(server.scriptRequest?.status === 'failed' ? server.scriptRequest.error || '' : server.shotsRequest?.status === 'failed' ? server.shotsRequest.error || '' : ''); }, [server.scriptRequest?.status, server.shotsRequest?.status]);

 // 状态按最近一次运行；预览按用户选择的版本（默认最新成功版本），上次失败时仍可看到之前的成功版本。
 const shotState = shot => {
  const run = shot.nodeId ? runs.filter(r => r.taskId === shot.nodeId).at(-1) : null;
  const shown = shot.nodeId ? shownRun(runs, shot.nodeId, editor.displayRuns) : null;
  return { run, status: run?.status || 'idle', shown, asset: shown?.output.assetId || null };
 };
 const batch = server.batch;
 const allDone = draft.shots.length > 0 && draft.shots.every(shot => succeededRuns(runs, shot.nodeId).length > 0);
 const compile = server.compile || { status: 'idle' };
 const videoRuns = runs.filter(r => r.input?.kind === 'video');
 // 字幕（V-25）：只统计配音最新、方式为后期配音或口型同步、且「本镜显示字幕」开启的分镜。
 const subtitleShots = draft.shots.filter(shot => editor.dubState?.(shot.nodeId)?.subtitles?.active).length;
 const hasSubtitles = subtitleShots > 0;
 const batchActive = batch && ['running', 'paused'].includes(batch.state);
 const batchItems = batch ? draft.shots.filter(shot => batch.items?.[shot.id]) : [];
 const batchDone = batchItems.filter(shot => batch.items[shot.id].status === 'succeeded').length;
 const shown = shownSettings(sb);
 const summary = studioSummary({ shots: draft.shots, tasks: editor.tasks, runs, storyboard: sb, channels: editor.channels, defaults: editor.defaults });
 const current = draft.shots.find(s => s.id === selectedId) || draft.shots[0] || null;
 const suggestionRequest = server.shotsRequest?.status === 'ready' && server.shotsRequest.suggestion?.shots?.length ? server.shotsRequest : null;
 // 抽屉：没有分镜时默认打开脚本；有分镜后默认收起；AI 分镜建议就绪时自动打开脚本抽屉。
 const drawer = drawerChoice !== undefined ? drawerChoice : (draft.shots.length ? null : 'script');
 useEffect(() => { if (suggestionRequest) setDrawerChoice('script'); }, [suggestionRequest?.id]);
 // 选中项始终固定在某个分镜编号上：排序、增删后不会悄悄换成别的分镜。
 useEffect(() => { if (current && current.id !== selectedId) setSelectedId(current.id); }, [current?.id, selectedId]);

 async function guard(fn) {
  if (busy || saving) return null;
  setSaving(true); setError('');
  try { return await fn(); }
  catch (e) { setError(e.message); return null; }
  finally { setSaving(false); }
 }
 const generateScript = () => guard(async () => {
  await flush();
  accept(await creationRequest(backend, base + '/storyboard/generate-script', { instructions, requestKey: uid() }));
 });
 const generateShots = () => guard(async () => {
  await flush();
  accept(await creationRequest(backend, base + '/storyboard/generate-shots', { requestKey: uid() }));
  notify?.('分镜建议已生成，请确认后应用到画布');
 });
 // 建议只是预览：「应用」才创建分镜和画布节点，「放弃」只标记建议作废。
 const applySuggestion = () => guard(async () => {
  await flush();
  accept(await creationRequest(backend, base + '/storyboard/shots-request/apply', { requestId: suggestionRequest.id }));
  setDrawerChoice(null);
  notify?.('分镜已应用，画布上已创建对应节点');
 });
 const discardSuggestion = () => guard(async () => {
  const data = await creationRequest(backend, base + '/storyboard/shots-request/discard', { requestId: suggestionRequest.id });
  accept(data); notify?.('已放弃分镜建议');
 });
 const compileFilm = () => guard(async () => {
  await flush();
  accept(await creationRequest(backend, base + '/storyboard/compile', { requestKey: uid(), burnSubtitles: burnSubtitles && hasSubtitles }));
  notify?.('成片拼接已开始');
 });
 // 新增分镜后立即发送，让服务端建好画布节点、节点配置马上可编辑；并选中新分镜。
 const addShot = () => guard(async () => {
  const shot = emptyShot(draft.shots.length);
  patchShots(shots => [...shots, shot]);
  setSelectedId(shot.id);
  await flush();
 });
 // 生成本镜 / 再生成一版 / 确认重试：都先弹出执行范围预览，由用户点击「开始」才创建请求。
 const runShot = (shot, { regenerate = false } = {}) => guard(async () => {
  await flush();
  const nodeId = editor.storyboard()?.shots?.find(s => s.id === shot.id)?.nodeId;
  if (!nodeId) { setError('分镜还没有同步到画布，请稍后再试。'); return; }
  const failed = shotState(shot).status === 'failed';
  const data = await creationRequest(backend, base + '/preview', { taskIds: [nodeId], ...(failed ? { retryTaskIds: [nodeId] } : {}), ...(regenerate ? { regenerateTaskIds: [nodeId] } : {}) });
  openPreview?.(data);
 });
 const removeShot = shot => guard(async () => {
  const index = draft.shots.findIndex(s => s.id === shot.id);
  patchShots(shots => shots.filter(s => s.id !== shot.id));
  setConfirmShot(null);
  setSelectedId(draft.shots[index + 1]?.id || draft.shots[index - 1]?.id || null);
  await flush();
 });
 const reorder = (from, to) => { if (writable) patchShots(shots => moveItem(shots, from, to)); };

 // 批量生成：先保存，再弹出批次预览（每镜预估积分、合计、余额、等待上一镜的分镜）。
 const openBatchPreview = () => guard(async () => {
  if (!draft.shots.length) { setError('请先添加分镜。'); return; }
  const saved = await flush();
  const synced = (saved.project.storyboard?.shots || []).filter(shot => shot.nodeId).map(shot => shot.id);
  setBatchPlan(await creationRequest(backend, base + '/storyboard/batch/preview', { shotIds: synced }));
 });
 const startBatch = () => guard(async () => {
  const plan = batchPlan;
  setBatchPlan(null);
  try {
   accept(await creationRequest(backend, base + '/storyboard/batch/start', { shotIds: plan.shotIds, previewToken: plan.previewToken, requestKey: uid() }));
   notify?.('批量生成已开始');
  } catch (e) {
   // 所选分镜的输入在预览后被改动：重新预览并提示，不锁定编辑。
   if (e.code !== 'PREVIEW_CHANGED') throw e;
   setBatchPlan(await creationRequest(backend, base + '/storyboard/batch/preview', { shotIds: plan.shotIds }));
   notify?.('分镜内容已变化，请确认新的预览后再开始');
  }
 });
 const retryBatchShot = shot => guard(async () => { accept(await creationRequest(backend, base + '/storyboard/batch/retry', { shotId: shot.id, requestKey: uid() })); });
 const stopBatch = () => guard(async () => { accept(await creationRequest(backend, base + '/storyboard/batch/cancel', {})); notify?.('已停止批量生成'); });
 const resumeBatch = () => guard(async () => { accept(await creationRequest(backend, base + '/storyboard/batch/resume', {})); });
 const titleOf = shot => nodeOf(shot)?.title ?? shot.title;
 const changeTitle = (shot, title) => {
  const node = nodeOf(shot);
  if (node) editor.edit(node.id, { title }); else patchShot(shot.id, { title });
 };
 const locked = shot => !writable || busy || saving || isActive(shotState(shot).status);

 // 项目级默认时长：校验后才写入，错误就地显示。
 const commitDuration = text => {
  if (text.trim() === '') return;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 4 || value > 30) { setDurationError('默认时长需为 4–30 的整数秒。'); return; }
  setDurationError(''); editor.setProjectSetting('duration', value);
 };
 // 点击缩略图上的问题标记：选中该镜，展开并滚动到对应分区，焦点落到分区内第一个可操作控件。
 const focusIssue = (shotId, issue) => {
  setSelectedId(shotId);
  setSections(old => ({ ...old, [issue.section]: true }));
  setFocusReq({ section: issue.section, at: Date.now() });
 };
 useEffect(() => {
  if (!focusReq) return undefined;
  const section = document.getElementById(`vs-sec-${focusReq.section}`);
  setFocusReq(null);
  if (!section) return undefined;
  section.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  (section.querySelector('.vs-sec-body button:not(:disabled), .vs-sec-body input, .vs-sec-body textarea, .vs-sec-body select') || section.querySelector('summary'))?.focus?.({ preventScroll: true });
  setFlash(focusReq.section);
  const timer = setTimeout(() => setFlash(''), 1600);
  return () => clearTimeout(timer);
 }, [focusReq]);
 const toggle = id => open => setSections(old => ({ ...old, [id]: open }));

 const items = draft.shots.map((shot, index) => {
  const node = nodeOf(shot), state = shotState(shot), customKeys = shotCustomKeys(sb, node);
  const issues = shotIssues({ task: node, edges: editor.edges, tasks: editor.tasks, runs, assets: editor.assets, assetsLoaded: editor.assetsLoaded, dub: node ? editor.dubState?.(node.id) : null, shotInfo: node ? editor.shotOf?.(node.id) : null });
  return { shot, index, title: titleOf(shot), state, thumb: state.asset, duration: node ? shotDuration(sb, node) : SETTING_DEFAULTS.duration, custom: customKeys.length > 0, customKeys, issues };
 });
 const playlist = buildPlaylist({ shots: draft.shots, tasks: editor.tasks, runs, storyboard: sb, dubState: editor.dubState, displayRuns: editor.displayRuns });

 // ---------- 单镜编辑区 ----------
 const renderShot = shot => {
  const index = draft.shots.findIndex(s => s.id === shot.id), node = nodeOf(shot), state = shotState(shot), item = batch?.items?.[shot.id], lock = locked(shot);
  const versions = node ? succeededRuns(runs, node.id) : [];
  const dub = node ? editor.dubState?.(node.id) : null;
  const dubAsset = dubAssetFor(editor.dubState, node?.id, state.shown);
  const head = <div className="vs-shot-head"><span className="vs-shot-no">{index + 1}</span><strong>{titleOf(shot)}</strong>
   <span className={`v3-badge ${state.status}`}>{isActive(state.status) && <i className="v3-pulse" />}{statusLabels[state.status] || '未生成'}</span>
   {item && <span className={`v3-badge vs-item ${item.status}`} aria-label="批量状态">批量：{batchItemLabels[item.status]}</span>}
   <span className="v3-grow" />
   <button className="v3-btn small" disabled={!writable || busy || saving || index === 0} aria-label={`上移${titleOf(shot)}`} onClick={() => reorder(index, index - 1)}>↑</button>
   <button className="v3-btn small" disabled={!writable || busy || saving || index === draft.shots.length - 1} aria-label={`下移${titleOf(shot)}`} onClick={() => reorder(index, index + 1)}>↓</button>
   <button className="v3-btn small danger" disabled={!writable || busy || saving} aria-label={`删除${titleOf(shot)}`} onClick={() => setConfirmShot(shot)}>删除</button>
  </div>;
  const names = <div className="vs-names">
   <label className="v3-field"><span>标题</span><DraftText value={titleOf(shot)} maxLength={100} disabled={!writable || (node && lock)} onCommit={title => changeTitle(shot, title)} /></label>
   <label className="v3-field"><span>画面描述<span className="count">{shot.description.length} / 4000</span></span><DraftText multiline rows={2} maxLength={4000} value={shot.description} disabled={!writable} placeholder="这一镜拍什么：景别、主体、动作" onCommit={description => patchShot(shot.id, { description })} /></label>
  </div>;
  if (!node) return <div className="vs-shot" data-shot={shot.id}>{head}{names}<p className="v3-note">分镜正在同步到画布，完成后这里可以设置视频方式、提示词、素材和参数。</p></div>;
  const change = patch => editor.edit(node.id, patch);
  const own = normalizeVideoParameters(node.params), params = own;
  const parameter = patch => change({ params: Object.fromEntries(Object.entries({ ...own, ...patch }).filter(([, v]) => v !== undefined)) });
  const analysis = analyzeVideoNode(node, { edges: editor.edges, tasks: editor.tasks, runs: editor.runs });
  const customKeys = shotCustomKeys(sb, node);
  const insertTag = ref => {
   const box = promptBox.current; if (!box) return;
   const tag = `{{ref:${ref}}}`, text = box.value, start = box.selectionStart ?? text.length, end = box.selectionEnd ?? start;
   change({ prompt: text.slice(0, start) + tag + text.slice(end) });
  };
  // 恢复跟随项目：节点上的分辨率 / 比例 / 时长覆盖全部清除；项目还没有设置时先把显示的默认值写成项目设置。
  const followProject = () => { if (!sb?.settings) editor.setProjectSetting('resolution', shown.resolution); change({ params: followProjectParams(node) }); };
  const dialogueCount = (node.dialogue || []).filter(line => line.text?.trim()).length;
  return <div className="vs-shot" data-shot={shot.id}>
   {head}
   <div className="vs-editor">
    <div className="vs-edit-main">
     {names}
     <Section id="materials" flash={flash === 'materials'} title="生成方式与素材" open={sections.materials} onToggle={toggle('materials')} badge={<small className="vs-sec-badge">{VIDEO_MODE_NAME[analysis.mode]} · {analysis.items.length} 个素材</small>}>
      <VideoModePanel task={node} analysis={analysis} locked={lock} change={change} editor={editor} onInsert={insertTag}
       renderItems={({ analysis: current, removeOwn }) => <MaterialSlots analysis={current} removeOwn={removeOwn} slots={SLOT_BY_MODE[current.mode]} locked={lock} editor={editor} onInsert={insertTag} onPick={port => setPicker({ port, taskId: node.id })} />} />
     </Section>
     <Section id="prompt" flash={flash === 'prompt'} title="提示词" open={sections.prompt} onToggle={toggle('prompt')}>
      <label className="v3-field"><span>视频提示词<span className="count">{(node.prompt || '').length} / 20000</span></span><DraftText ref={promptBox} multiline aria-label="视频提示词" rows={3} maxLength={20000} value={node.prompt || ''} disabled={lock} onCommit={prompt => change({ prompt })} placeholder="给视频模型的画面提示词；点击上方素材卡片可插入 <Picture N> 等标签" /></label>
      <VideoTagPreview task={node} analysis={analysis} locked={lock} change={change} editor={editor} />
     </Section>
     <Section id="dialogue" flash={flash === 'dialogue'} title="台词与配音" open={sections.dialogue} onToggle={toggle('dialogue')} badge={<small className="vs-sec-badge">{dialogueCount ? `${dialogueCount} 句` : '无台词'}{dub?.status === 'fresh' ? ' · 已配音' : dub?.status === 'stale' ? ' · 已过期' : ''}</small>}>
      <VideoDialogue task={node} duration={shotDuration(sb, node)} locked={lock} change={change} editor={editor} />
      {!(editor.voiceRoles || []).length && <p className="v3-note">还没有角色。台词配音需要先给角色选择音色（顶部「角色与音色」）。</p>}
     </Section>
     <Section id="params" flash={flash === 'params'} title="参数" open={sections.params} onToggle={toggle('params')} badge={customKeys.length ? <span className="vs-flag custom">自定义</span> : <small className="vs-sec-badge">跟随项目</small>}>
      {customKeys.length > 0 && <p className="vn-warn" role="status">本镜自定义了{customKeys.map(key => ({ resolution: '分辨率', ratio: '画面比例', duration: '时长' })[key]).join('、')}，不随项目设置变化。<button type="button" className="v3-btn small" disabled={lock} onClick={followProject}>恢复跟随项目</button></p>}
      <VideoParams task={node} params={params} analysis={analysis} locked={lock} parameter={parameter} editor={editor} inherit={sb?.settings ? shown : null} />
      <details className="v3-adv" onToggle={e => setAdvancedOpen(e.currentTarget.open)}><summary>高级设置</summary><VideoAdvanced task={node} params={params} parameter={parameter} locked={lock} editor={editor} open={advancedOpen} /></details>
     </Section>
    </div>
    <div className="vs-edit-side">
     <Section id="preview" flash={flash === 'preview'} title="本镜预览" open={sections.preview} onToggle={toggle('preview')}>
      {versions.length > 1 && <label className="v3-field"><span>版本</span><select aria-label="查看版本" value={editor.displayRuns?.[node.id] || 'latest'} onChange={e => editor.setDisplayRun(node.id, e.target.value === 'latest' ? null : e.target.value)}><option value="latest">最新成功版本</option>{versions.map((r, i) => <option key={r.id} value={r.id}>版本 {i + 1}</option>)}</select></label>}
      {state.asset ? (dubAsset ? <DubbedVideo className="vs-shot-preview" original={state.asset} dub={dubAsset} truncated={dub?.dub?.truncated} muted /> : <video className="vs-shot-preview" src={fileUrl(state.asset)} muted controls preload="metadata" />) : <div className="vs-shot-preview empty">{isActive(state.status) ? '生成中…' : '尚无视频'}</div>}
      <div className="vs-shot-foot">
       <button className="v3-btn small primary" disabled={!writable || busy || saving || isActive(state.status)} onClick={() => runShot(shot)}>{state.status === 'failed' ? '重试本镜' : '生成本镜'}</button>
       {versions.length > 0 && <button className="v3-btn small" disabled={!writable || busy || saving || isActive(state.status)} onClick={() => runShot(shot, { regenerate: true })}>再生成一版</button>}
      </div>
      {state.status === 'failed' && <p className="v3-note" title={state.run?.error?.message || ''}>上次失败：{state.run?.error?.message || '请查看错误后重试'}</p>}
     </Section>
    </div>
   </div>
  </div>;
 };

 const queueTitle = <><h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>视频任务队列</h3><span className="v3-note">{videoRuns.length} 条记录</span></>;
 return <div className="vs-shell">
  <div className="vs-top" role="toolbar" aria-label="视频工作台工具条">
   <div className="vs-settings" role="group" aria-label="项目视频参数">
    <label>分辨率<select aria-label="项目分辨率" value={shown.resolution} disabled={!writable} onChange={e => editor.setProjectSetting('resolution', e.target.value)}>{VIDEO_RESOLUTIONS.map(v => <option key={v}>{v}</option>)}</select></label>
    <label>比例<select aria-label="项目画面比例" value={shown.ratio} disabled={!writable} onChange={e => editor.setProjectSetting('ratio', e.target.value)}>{SETTING_RATIOS.map(v => <option key={v}>{v}</option>)}</select></label>
    <label>默认时长<DraftText type="number" min="4" max="30" aria-label="项目默认时长（秒）" aria-invalid={Boolean(durationError)} value={String(shown.duration)} disabled={!writable} onCommit={commitDuration} />秒</label>
   </div>
   <span className="vs-summary" aria-label="整片合计">{summary.count} 镜 · 总时长 {clock(summary.seconds)} · {summary.count === 0 ? '无预估' : summary.pending === 0 ? '全部镜头已生成' : summary.points > 0 ? `待生成预估 ${pointText(summary.points)}` : '待生成预估 —'}</span>
   <span className="v3-grow" />
   <button className={`v3-btn${drawer === 'script' ? ' on' : ''}`} aria-pressed={drawer === 'script'} onClick={() => setDrawerChoice(drawer === 'script' ? null : 'script')}>脚本</button>
   <button className="v3-btn" onClick={() => editor.openRoles?.()}>角色与音色</button>
   <button className="v3-btn" disabled={!draft.shots.length} onClick={() => setPlayer(true)}>连播预览</button>
   <button className="v3-btn" aria-label="生成全部分镜" disabled={!writable || busy || saving || !draft.shots.length || batchActive} onClick={openBatchPreview}>生成全部</button>
   <button className={`v3-btn${drawer === 'film' ? ' on' : ''}`} aria-pressed={drawer === 'film'} onClick={() => setDrawerChoice(drawer === 'film' ? null : 'film')}>{compile.status === 'running' ? '成片（拼接中…）' : '成片'}</button>
  </div>
  {durationError && <div className="v3-alert" role="alert">{durationError}<button aria-label="关闭" onClick={() => setDurationError('')}>×</button></div>}
  <div className="vs-stage">
   <div className="vs-body">
    {error && <div className="v3-alert" role="alert" style={{ borderRadius: 8 }}>{error}<button aria-label="关闭" onClick={() => setError('')}>×</button></div>}
    {batch && <div className="vs-card vs-batch" role="region" aria-label="批量生成进度">
     <h3>批量生成<span className={`vs-batch-state ${batch.state}`}>{batchStateLabels[batch.state]}</span><span className="v3-grow" />
      {batch.state === 'paused' && <button className="v3-btn small primary" disabled={!writable || busy || saving} onClick={resumeBatch}>继续</button>}
      {batchActive && <button className="v3-btn small danger" disabled={!writable || busy || saving} onClick={stopBatch}>停止</button>}
     </h3>
     <div className="vs-progress" role="progressbar" aria-label="批量生成总进度" aria-valuemin={0} aria-valuemax={batchItems.length} aria-valuenow={batchDone}><i style={{ width: `${batchItems.length ? Math.round(batchDone / batchItems.length * 100) : 0}%` }} /></div>
     <p className="vs-progress-text">已完成 {batchDone} / {batchItems.length}</p>
     {batch.reason && <p className={batch.state === 'paused' ? 'vn-warn' : 'v3-note'} role="status">{batch.reason}</p>}
     <ul className="vs-batch-list">{batchItems.map(shot => {
      const entry = batch.items[shot.id];
      return <li key={shot.id}>
       <span className="vs-batch-title">{titleOf(shot)}</span>
       <span className={`v3-badge vs-item ${entry.status}`}>{batchItemLabels[entry.status]}</span>
       {entry.attempt > 1 && <small className="v3-note">第 {entry.attempt} 次</small>}
       {['failed', 'held'].includes(entry.status) && entry.reason && <small className="vs-batch-reason">{entry.reason}</small>}
       {entry.status === 'failed' && batch.state !== 'cancelled' && <button className="v3-btn small" aria-label={`重试批次分镜 ${titleOf(shot)}`} disabled={!writable || busy || saving} onClick={() => retryBatchShot(shot)}>重试</button>}
      </li>;
     })}</ul>
    </div>}
    <Timeline items={items} selectedId={current?.id} writable={writable && !busy && !saving} canAdd={draft.shots.length < 30} onSelect={setSelectedId} onReorder={reorder} onAdd={addShot} onIssue={focusIssue} />
    {current ? renderShot(current) : <div className="vs-card"><p className="v3-note">{server.shotsRequest?.status === 'pending' ? '分镜建议正在生成…' : '还没有分镜。点击时间线末尾的「＋」手动添加，或在「脚本」里用 AI 按脚本拆分。'}</p></div>}
   </div>
   {drawer === 'script' && <Drawer title="脚本" onClose={() => setDrawerChoice(null)}>
    <h4>视频脚本<span className="v3-grow" /><button className="v3-btn small" disabled={!writable || busy || saving} onClick={generateScript}>AI 生成脚本</button></h4>
    <DraftText multiline className="vs-script" aria-label="视频脚本" maxLength={40000} disabled={!writable} value={draft.script} placeholder="点击「AI 生成脚本」，或直接填写带货短视频脚本；分镜将依据脚本拆分。" onCommit={script => editor.patchStoryboard({ script })} />
    <label className="v3-field" style={{ marginTop: 8 }}><span>补充要求（可选）</span><DraftText value={instructions} maxLength={2000} disabled={!writable} placeholder="例如：15 秒竖屏，突出防尘盖与保温时长" onCommit={setInstructions} /></label>
    {server.scriptRequest?.status === 'pending' && <p className="v3-note">脚本正在生成…</p>}
    <div className="vs-drawer-actions"><button className="v3-btn small primary" disabled={!writable || busy || saving || !draft.script.trim()} onClick={generateShots}>AI 生成分镜</button>{server.shotsRequest?.status === 'pending' && <span className="v3-note">分镜建议正在生成…</span>}</div>
    {suggestionRequest && <div className="vs-card vs-suggest" role="region" aria-label="AI 分镜建议">
     <h3>AI 分镜建议（{suggestionRequest.suggestion.shots.length} 个）<span className="v3-grow" />
      <button className="v3-btn small" disabled={!writable || busy || saving} onClick={discardSuggestion}>放弃</button>
      <button className="v3-btn small primary" disabled={!writable || busy || saving} onClick={applySuggestion}>应用</button>
     </h3>
     <p className="v3-note">这只是预览，还没有写入分镜和画布；点击「应用」才会创建分镜、视频节点并连接素材。应用后可继续逐镜修改，不会自动生成视频。</p>
     {suggestionRequest.suggestion.notice && <p className="vn-warn" role="status">{suggestionRequest.suggestion.notice}</p>}
     <ol className="vs-suggest-list">{suggestionRequest.suggestion.shots.map((shot, index) => <li key={index} className="vs-suggest-item" data-suggest-shot={index}>
      <div className="vs-suggest-head"><span className="vs-shot-no">{index + 1}</span><strong>{shot.title}</strong><span className="v3-badge">{modeLabels[shot.videoMode] || shot.videoMode}</span><span className="v3-note">{shot.duration} 秒</span></div>
      {shot.description && <p className="vs-suggest-desc">{shot.description}</p>}
      {shot.materials.length > 0 && <ul className="vs-suggest-materials" aria-label="素材">{shot.materials.map(material => <li key={material.key + material.slot} title={material.origin}>
       {material.kind === 'image' ? <img src={fileUrl(material.assetId)} alt={material.name} loading="lazy" /> : <span className="vs-suggest-kind">{kindLabels[material.kind]}</span>}
       <span className="vs-suggest-name">{material.name}</span><small>{slotLabels[material.slot] || material.slot}（{material.key}）</small>
      </li>)}</ul>}
      <p className="vs-suggest-prompt"><span>提示词</span>{shot.prompt || '（空）'}</p>
      {shot.dialogue?.length > 0 && <p className="vs-suggest-dialogue"><span>台词</span>{shot.dialogue.map(line => `[${line.language === 'en' ? '英文' : '中文'}] ${line.text}`).join(' ')}</p>}
      {shot.notes?.length > 0 && <ul className="vs-suggest-notes" aria-label="已修正">{shot.notes.map(note => <li key={note} className="vn-warn">已修正：{note}</li>)}</ul>}
     </li>)}</ol>
    </div>}
    <details className="v3-adv vs-product"><summary>商品资料摘要</summary>
     {detail?.project?.productSnapshot ? <><strong>{detail.project.productSnapshot.name}</strong><ul>{Object.entries(detail.project.productSnapshot.facts || {}).slice(0, 12).map(([key, value]) => <li key={key}>{key}：{typeof value === 'object' ? JSON.stringify(value) : String(value)}</li>)}</ul><p className="v3-note">脚本与分镜仅使用已知事实，不猜测缺失信息。</p></> : <p className="v3-note">概念创作（未关联商品）。</p>}
    </details>
   </Drawer>}
   {drawer === 'film' && <Drawer title="成片" onClose={() => setDrawerChoice(null)}>
    <div className="vs-compile">
     <div className="vs-compile-head"><button className="v3-btn small primary" disabled={!writable || busy || saving || !allDone || compile.status === 'running'} onClick={compileFilm}>{compile.status === 'running' ? '拼接中…' : '拼接成片'}</button></div>
     <div className="vs-subs" aria-label="字幕选项">
      <label className="vs-subs-burn"><input type="checkbox" aria-label="烧录字幕" checked={burnSubtitles && hasSubtitles} disabled={!hasSubtitles || compile.status === 'running'} onChange={e => setBurnSubtitles(e.target.checked)} />烧录字幕</label>
      {hasSubtitles ? <a className="v3-btn small" href={`${base}/storyboard/subtitles.srt`} download>下载字幕 SRT</a> : <button type="button" className="v3-btn small" disabled>下载字幕 SRT</button>}
      <small className="v3-note" role="status">{hasSubtitles ? `${subtitleShots} 个分镜有字幕；烧录会重新编码视频，字幕为白字黑描边、位于画面底部。` : '还没有字幕：需要先为分镜合成台词配音（后期配音或口型同步），并开启「本镜显示字幕」。'}</small>
     </div>
     {compile.status === 'succeeded' && compile.assetId ? <>
      <video src={fileUrl(compile.assetId)} controls playsInline preload="metadata" />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
       <a className="v3-btn small" href={`${fileUrl(compile.assetId)}?download=1`} download>下载成片</a>
       <span className="v3-note" style={{ alignSelf: 'center' }}>成片保留各镜原声，没有声音的镜头自动补静音；镜头之间不加转场。</span>
      </div>
      {compile.subtitles && <p className="v3-note" role="status">{compile.subtitles.burned ? `字幕已烧录到画面，共 ${compile.subtitles.cueCount} 条。` : compile.subtitles.cueCount ? `未烧录字幕（共 ${compile.subtitles.cueCount} 条，可下载 SRT）。` : '这版成片没有字幕。'}</p>}
     </> : compile.status === 'running' ? <div className="vs-compile-empty">正在服务端拼接分镜（不产生模型费用），完成后自动显示。</div>
      : compile.status === 'failed' ? <div className="vs-compile-empty" role="alert">拼接失败：{compile.error || '请重试'}</div>
       : <div className="vs-compile-empty">{allDone ? '全部分镜已成功，点击「拼接成片」。' : '完成全部分镜后，可拼接为一个完整成片（服务端 ffmpeg 转码，逐镜顺序拼接）。想先看整体效果，可用顶部「连播预览」。'}</div>}
    </div>
   </Drawer>}
  </div>
  <details className="vs-bottom" aria-label="视频任务队列">
   <summary>{queueTitle}</summary>
   <div className="v3-queue-scroll">
    <table><thead><tr><th>#</th><th>分镜</th><th>状态</th><th>耗时</th><th>费用</th><th>错误</th><th /></tr></thead>
     <tbody>{videoRuns.toReversed().map((r, index) => {
      const shot = draft.shots.find(s => s.nodeId === r.taskId);
      const seconds = Math.max(1, Math.round((new Date(r.updatedAt) - new Date(r.createdAt)) / 1000));
      return <tr key={r.id}>
       <td className="num">{index + 1}</td>
       <td className="name">{(shot && titleOf(shot)) || r.input?.task?.title || '已删除分镜'}</td>
       <td className="status"><span className={r.status}><i />{statusLabels[r.status]}</span></td>
       <td>{isActive(r.status) ? '—' : `${seconds}s`}</td>
       <td>{Number.isSafeInteger(r.usage?.costMicros) ? `¥${(r.usage.costMicros / 1e6).toFixed(2)}` : '未统计'}</td>
       <td className="err" title={r.error?.message || ''}>{r.error?.message || '—'}</td>
       <td className="actions" onClick={e => e.stopPropagation()}>
        {r.status === 'succeeded' && r.output?.assetId && <a href={`${fileUrl(r.output.assetId)}?download=1`} download>下载</a>}
       </td>
      </tr>;
     })}
      {!videoRuns.length && <tr><td colSpan="7" className="v3-empty">还没有视频生成记录。</td></tr>}
     </tbody></table>
   </div>
  </details>
  {player && <PreviewPlayer playlist={playlist} onClose={() => setPlayer(false)} />}
  {picker && nodeOf(current) && <MaterialPicker port={picker.port} task={nodeOf(current)} editor={editor} productId={canvasDraft?.productId} projectId={projectId} onClose={() => setPicker(null)} />}
  <ConfirmDialog open={Boolean(confirmShot)} title="删除分镜" message={`删除「${confirmShot ? titleOf(confirmShot) : ''}」？画布上的对应视频节点会一并移除（已有生成记录的节点会保留）。`} confirmText="删除分镜" busy={saving} onCancel={() => setConfirmShot(null)} onConfirm={() => removeShot(confirmShot)} />
  {batchPlan && <div className="v3-overlay"><div className="v3-dialog" role="dialog" aria-modal="true" aria-label="批量生成预览">
   <header><h2>批量生成预览</h2><button aria-label="关闭" onClick={() => setBatchPlan(null)}>×</button></header>
   <p className="v3-note">无依赖的分镜并发提交，同时最多 3 个；依赖上一镜尾帧的分镜会等上一镜成功后自动截帧再提交。确认后，批内后续派发不再逐个询问。</p>
   <ol>{batchPlan.entries.map(entry => <li key={entry.shotId}>
    <div><strong>{entry.title}</strong><span>{planActionLabels[entry.action] || entry.action}</span></div>
    {entry.reason && <p>{entry.reason}</p>}
    {entry.estimatedPoints > 0 && <p className="pv-points">预估 {pointText(entry.estimatedPoints)}</p>}
   </li>)}</ol>
   <div className="pv-summary" aria-label="积分预估">
    <div><span>预估合计</span><strong>{pointText(batchPlan.estimatedPoints || 0)}</strong></div>
    <div><span>可用积分</span><strong>{batchPlan.balance ? pointText(batchPlan.balance.available) : '余额未知'}</strong></div>
    {batchPlan.balanceReason && <p className="pv-short" role="alert">{batchPlan.balanceReason}</p>}
   </div>
   <footer><button className="v3-btn" onClick={() => setBatchPlan(null)}>取消</button><button className="v3-btn primary" disabled={!batchPlan.canStart || busy || saving || !writable} onClick={startBatch}>开始生成</button></footer>
  </div></div>}
 </div>;
}
const VIDEO_MODE_NAME = { text: '文字', frames: '首尾帧', reference: '全能参考' };
