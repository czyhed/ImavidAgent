import { useRef, useState } from 'react';
import DraftText from './DraftText.jsx';
import MediaInputEditor from './MediaInputEditor.jsx';
import { DubbedVideo } from './VoiceRoles.jsx';
import { VideoModePanel, VideoTagPreview, VideoDialogue, VideoParams, VideoAdvanced } from './VideoNodeEditor.jsx';
import { analyzeVideoNode, PORT_LABEL } from '../lib/video-node.js';
import { normalizeVideoParameters } from '../../../shared/creation-video-parameters.mjs';

const fileUrl = id => `/api/creation/assets/${id}/file`;
const EXECUTABLE = new Set(['generate', 'edit', 'composite', 'video']);
const ACTIVE = new Set(['queued', 'submitting', 'running', 'unknown', 'cancelling']);
const STATUS = { queued: '排队中', submitting: '提交中', running: '运行中', unknown: '待核实', cancelling: '取消中', cancelled: '已取消', failed: '失败', succeeded: '成功' };

export default function CanvasNodeEditor({ data }) {
 const { task, run, asset, writable, versions, displayRun, onDisplayRun, editor } = data;
 const [picker, setPicker] = useState(false), [sourceTab, setSourceTab] = useState('creative'), [parameterError, setParameterError] = useState(''), [advancedOpen, setAdvancedOpen] = useState(false);
 const promptBox = useRef(null);
 const locked = !writable || editor.busy || ACTIVE.has(run?.status) || data.shared;
 const change = patch => editor.edit(task.id, patch);
 const params = task.kind === 'video' ? normalizeVideoParameters(task.params) : (task.params || {});
 const parameter = patch => change({ params: Object.fromEntries(Object.entries({ ...params, ...patch }).filter(([, v]) => v !== undefined)) });
 const isVideo = task.kind === 'video';
 const analysis = isVideo ? analyzeVideoNode(task, { edges: editor.edges, tasks: editor.tasks, runs: editor.runs }) : null;
 const videoDuration = Number.isInteger(params.duration) ? params.duration : 5;
 // 点击素材卡片：在提示词光标处插入 {{ref:来源节点}}，并把光标放回标签之后。
 const insertTag = ref => {
  const box = promptBox.current; if (!box) return;
  const tag = `{{ref:${ref}}}`, text = box.value, start = box.selectionStart ?? text.length, end = box.selectionEnd ?? start;
  const next = text.slice(0, start) + tag + text.slice(end), caret = start + tag.length;
  change({ prompt: next });
  let tries = 0;
  const restore = () => { if (promptBox.current?.value === next || tries++ > 40) { promptBox.current?.focus(); promptBox.current?.setSelectionRange(caret, caret); } else requestAnimationFrame(restore); };
  requestAnimationFrame(restore);
 };
 const inputs = editor.edges.filter(e => e.target === task.id);
 const sourceRuns = inputs.flatMap(edge => editor.runs.filter(r => r.taskId === edge.source && r.status === 'succeeded' && r.output?.assetId));
 // 生图 / 改图的图片端口可连多张参考图（最多 8 张）；每个上游可执行来源各固定一个成功版本。
 const imageHandle = task.kind === 'generate' ? 'ref' : task.kind === 'edit' ? 'image' : null;
 const imageInputs = imageHandle ? inputs.filter(e => e.targetHandle === imageHandle) : isVideo ? inputs.filter(e => e.targetHandle !== 'prompt') : [];
 const executableSources = [...new Set(imageInputs.map(e => e.source))].map(id => editor.tasks.find(t => t.id === id)).filter(t => t && EXECUTABLE.has(t.kind) && editor.runs.some(r => r.taskId === t.id && r.status === 'succeeded' && r.output?.assetId));
 const pinOf = source => [task.sourceRunId, ...(task.sourceRunIds || [])].find(id => editor.runs.some(r => r.id === id && r.taskId === source.id)) || '';
 const pinSource = (source, runId) => {
  const pins = executableSources.map(s => s.id === source.id ? runId : pinOf(s)).filter(Boolean);
  // 视频节点的固定版本全部放进 sourceRunIds：sourceRunId 在服务端会被当成首帧。
  if (isVideo) change({ sourceRunId: null, sourceRunIds: pins }); else change({ sourceRunId: pins[0] || null, sourceRunIds: pins.slice(1) });
 };
 const shownRun = versions.find(r => r.id === displayRun) || versions.at(-1);
 const dubInfo = isVideo ? editor.dubState?.(task.id)?.dub : null;
 const canRefine = ['generate', 'edit'].includes(task.kind) && asset && shownRun?.output?.assetId === asset && shownRun.input?.kind !== 'video' && editor.openRefine;
 const models = editor.models.filter(m => m.enabled && m.available !== false && m.capabilities?.includes(task.kind === 'video' ? 'video' : 'image'));
 const templates = editor.templates.filter(t => (t.mediaKind || t.taskKind || t.type) === (task.kind === 'video' ? 'video' : 'image'));
 const images = editor.assets.filter(a => ['creative', 'result'].includes(a.role) && a.mime?.startsWith('image/') && !a.trashedAt && !a.deletionPending);
 const outputs = task.kind === 'output' ? inputs.flatMap(edge => {
  const source = editor.tasks.find(t => t.id === edge.source);
  const selected = editor.runs.find(r => r.id === editor.displayRuns[edge.source]);
  const result = selected || editor.runs.filter(r => r.taskId === edge.source && r.status === 'succeeded').at(-1);
  const id = result?.output?.assetId || source?.sourceAssetId;
  return id ? [{ id, video: source?.kind === 'video', title: source?.title }] : [];
 }) : [];
 return <div className="canvas-node-editor nodrag nopan nowheel" onDoubleClick={e => e.stopPropagation()}>
  <DraftText className="canvas-node-name" aria-label="节点名称" value={task.title} disabled={locked} maxLength={200} onCommit={title => change({ title })} />
  {data.shared && <p className="v3-note">上游任务引用 · 在所属任务中编辑</p>}
  {['image', 'product'].includes(task.kind) && <>
   <div className="canvas-reference">{task.sourceAssetId ? <><img src={fileUrl(task.sourceAssetId)} alt="参考图" /><button aria-label="移除参考图" disabled={locked} onClick={() => change({ sourceAssetId: null, sourceRunId: null })}>×</button></> : <span>添加商品图片或创作素材</span>}</div>
   <div className="canvas-node-actions"><button className="v3-btn" disabled={locked} onClick={() => setPicker(!picker)}>＋ {task.sourceAssetId ? '更换参考图' : '添加图片'}</button><label className="v3-file">上传<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={e => editor.upload(e, task.id)} /></label></div>
   {picker && <div className="canvas-asset-picker"><div className="v3-tabs">{[['creative', '商品素材'], ['result', '生成结果']].map(([id, title]) => <button key={id} className={sourceTab === id ? 'on' : ''} onClick={() => setSourceTab(id)}>{title}</button>)}</div><div className="canvas-asset-options">{images.filter(a => a.role === sourceTab).map(a => <button key={a.id} title={a.name} aria-label={`选择参考图 ${a.name}`} disabled={locked} onClick={() => { change({ sourceAssetId: a.id, sourceRunId: null }); setPicker(false); }}><img src={fileUrl(a.id)} alt={a.name} /><span>{a.name}</span></button>)}</div>{!images.some(a => a.role === sourceTab) && <p className="v3-note">暂无图片，可上传创作素材。</p>}</div>}
   {task.productSnapshot && <details className="v3-adv"><summary>商品资料</summary><pre>{JSON.stringify(task.productSnapshot.facts || {}, null, 2)}</pre>{editor.openProduct && <button className="v3-btn" onClick={editor.openProduct}>打开商品</button>}</details>}
  </>}
  {['audio', 'footage'].includes(task.kind) && <MediaInputEditor task={task} assets={editor.assets} locked={locked} change={change} upload={editor.uploadMedia} />}
  {isVideo && <VideoModePanel task={task} analysis={analysis} locked={locked} change={change} editor={editor} onInsert={insertTag} />}
  {(task.kind === 'prompt' || ['generate', 'edit', 'video'].includes(task.kind)) && <label className="v3-field"><span>提示词</span><DraftText ref={promptBox} multiline aria-label="提示词" rows={task.kind === 'prompt' ? 7 : 3} maxLength={20000} value={task.prompt || ''} disabled={locked} onCommit={prompt => change({ prompt })} placeholder={task.kind === 'prompt' ? '描述想要生成的画面…' : data.displayPrompt || '使用上游提示词，或在这里填写'} /><small className="canvas-field-count">{(task.prompt || '').length} / 20000</small></label>}
  {isVideo && <VideoTagPreview task={task} analysis={analysis} locked={locked} change={change} editor={editor} />}
  {isVideo && <VideoDialogue task={task} duration={videoDuration} locked={locked} change={change} editor={editor} />}
  {['generate', 'edit', 'video'].includes(task.kind) && <>
   <label className="v3-field canvas-field-row"><span>模型</span><select aria-label="模型" value={task.model ? `${task.model.channelId}:${task.model.modelId}` : ''} disabled={locked} onChange={e => { const m = models.find(m => `${m.channelId}:${m.modelId}` === e.target.value); change({ model: m ? { channelId: m.channelId, modelId: m.modelId } : null }); }}><option value="">使用环节默认</option>{task.model && !models.some(m => m.channelId === task.model.channelId && m.modelId === task.model.modelId) && <option value={`${task.model.channelId}:${task.model.modelId}`}>{task.model.modelId}（不可用）</option>}{models.map(m => <option key={`${m.channelId}:${m.modelId}`} value={`${m.channelId}:${m.modelId}`}>{m.name || m.modelId}</option>)}</select></label>
   {isVideo ? <VideoParams task={task} params={params} analysis={analysis} locked={locked} parameter={parameter} editor={editor} /> : <label className="v3-field canvas-field-row"><span>尺寸</span><select aria-label="尺寸" value={task.params?.size || '1024x1024'} disabled={locked} onChange={e => parameter({ size: e.target.value })}>{[...new Set(['1024x1024', '1536x1024', '1024x1536', task.params?.size].filter(Boolean))].map(v => <option key={v} value={v}>{v.replace('x', ' × ')}</option>)}</select></label>}
   {imageHandle && <small className="canvas-ref-count">参考图 {imageInputs.length} / 8</small>}
   {task.kind === 'edit' && task.maskAssetId && <div className="canvas-mask"><img src={fileUrl(task.maskAssetId)} alt="局部精修蒙版" /><div><small>局部精修：仅重绘蒙版涂抹的区域</small><button className="v3-btn small" disabled={locked} onClick={() => editor.redrawMask(task.id)}>重新绘制</button><button className="v3-btn small" disabled={locked} onClick={() => change({ maskAssetId: null })}>移除蒙版</button></div></div>}
   {(imageHandle || isVideo) && executableSources.length > (isVideo ? 0 : 1) && <div className="canvas-source-list">{executableSources.map(source => { const list = editor.runs.filter(r => r.taskId === source.id && r.status === 'succeeded' && r.output?.assetId); return <label className="v3-field" key={source.id}><span>来源版本 · {source.title}</span><select aria-label={`来源版本 · ${source.title}`} value={pinOf(source)} disabled={locked} onChange={e => pinSource(source, e.target.value)}><option value="">请选择具体成功版本</option>{list.map((r, i) => <option key={r.id} value={r.id}>{source.title} · 版本 {i + 1}</option>)}</select></label>; })}</div>}
   {!isVideo && !(imageHandle && executableSources.length > 1) && sourceRuns.length > 0 && <label className="v3-field"><span>来源版本</span><select aria-label="来源版本" value={task.sourceRunId || ''} disabled={locked} onChange={e => change({ sourceRunId: e.target.value || null })}><option value="">请选择具体成功版本</option>{sourceRuns.map((r, i) => <option key={r.id} value={r.id}>{editor.tasks.find(t => t.id === r.taskId)?.title} · 版本 {i + 1}</option>)}</select></label>}
  </>}
  {task.kind === 'composite' && <><label className="v3-field"><span>布局</span><select value={task.params?.layout || 'vertical3'} disabled={locked} onChange={e => parameter({ layout: e.target.value })}><option value="vertical3">三图竖排</option><option value="grid4">四宫格</option><option value="single">单图满版</option></select></label><p className="v3-note">在浏览器内拼图，无需调用模型。</p></>}
  {EXECUTABLE.has(task.kind) && <details className="v3-adv" onToggle={e => setAdvancedOpen(e.currentTarget.open)}><summary>高级参数与模板</summary>{isVideo && <VideoAdvanced task={task} params={params} parameter={parameter} locked={locked} editor={editor} open={advancedOpen} />}<label className="v3-field"><span>创作对象</span><select value={task.subject} disabled={locked} onChange={e => change({ subject: e.target.value })}><option value="concept">背景 / 概念</option><option value="product">商品外观</option></select></label><label className="v3-field"><span>提示词与参数模板</span><select value="" disabled={locked} onChange={e => { const template = templates.find(t => t.id === e.target.value); if (template) change({ prompt: template.prompt || task.prompt, params: structuredClone(template.params || task.params), templateSnapshot: structuredClone(template) }); }}><option value="">选择模板</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label className="v3-field"><span>参数 JSON</span><textarea aria-label="高级参数" rows={5} key={JSON.stringify(params)} defaultValue={JSON.stringify(params, null, 2)} disabled={locked} onBlur={e => { try { const params = JSON.parse(e.target.value); if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error(); setParameterError(''); change({ params: task.kind === 'video' ? normalizeVideoParameters(params) : params }); } catch { setParameterError('参数需要有效的 JSON 对象。'); } }} /></label>{parameterError && <p role="alert">{parameterError}</p>}</details>}
  {EXECUTABLE.has(task.kind) && <div className="canvas-result"><div className="canvas-result-heading"><span>上次结果</span>{versions.length > 0 && <select aria-label={`${task.title} 查看版本`} value={displayRun || 'latest'} onChange={e => onDisplayRun(task.id, e.target.value === 'latest' ? null : e.target.value)}><option value="latest">最新成功版本</option>{versions.map((r, i) => <option key={r.id} value={r.id}>版本 {i + 1}</option>)}</select>}</div>{asset ? task.kind === 'video' ? (dubInfo?.assetId && dubInfo.runId === shownRun?.id ? <DubbedVideo original={asset} dub={dubInfo.assetId} truncated={dubInfo.truncated} /> : <video src={fileUrl(asset)} controls preload="metadata" />) : <img src={fileUrl(asset)} alt={task.title} /> : <div className="canvas-result-empty">{STATUS[run?.status] || '等待生成'}</div>}</div>}
  {task.kind === 'output' && <div className="canvas-output">{outputs.length ? outputs.map((result, i) => <div key={`${result.id}-${i}`}>{result.video ? <video src={fileUrl(result.id)} controls preload="metadata" /> : <img src={fileUrl(result.id)} alt={result.title} />}<div className="canvas-node-actions"><a className="v3-btn" href={`${fileUrl(result.id)}?download=1`} download>↓ 下载</a><a className="v3-btn" href={fileUrl(result.id)} target="_blank" rel="noreferrer">查看原文件</a></div></div>) : <div className="canvas-result-empty">连接生成节点，查看输出结果</div>}</div>}
  {inputs.length > 0 && <details className="v3-adv"><summary>输入连线 · {inputs.length}</summary>{inputs.map(e => <div className="v3-edge-row" key={e.id}><span>{editor.tasks.find(t => t.id === e.source)?.title} · {(isVideo && PORT_LABEL[e.targetHandle]) || e.targetHandle}</span><button disabled={locked} onClick={() => editor.removeEdge(e.id)}>移除</button></div>)}</details>}
  <div className="canvas-node-actions">{EXECUTABLE.has(task.kind) && <button className="v3-btn primary" disabled={locked} onClick={() => editor.run([task.id])}>预览运行</button>}{canRefine && <button className="v3-btn" disabled={locked} onClick={() => editor.openRefine(task.id, shownRun.id)}>局部精修</button>}{EXECUTABLE.has(task.kind) && versions.length > 0 && <button className="v3-btn" disabled={locked} onClick={() => editor.run([task.id], { regenerate: [task.id] })}>再生成一版</button>}<details className="canvas-node-menu"><summary aria-label="节点操作">•••</summary><button disabled={locked} onClick={() => editor.duplicate(task.id)}>复制节点</button><button disabled={locked} onClick={() => editor.remove(task.id)}>删除节点</button></details></div>
 </div>;
}
