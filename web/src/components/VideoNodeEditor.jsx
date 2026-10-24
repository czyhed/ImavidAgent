import { useEffect, useState } from 'react';
import DraftText from './DraftText.jsx';
import { VIDEO_RESOLUTIONS, VIDEO_RATIOS, estimateDialogueSeconds } from '../../../shared/creation-video-parameters.mjs';
import { VIDEO_MODE_LABEL, VIDEO_MODE_ORDER, tagSegments, hasTags, estimateVideoPoints, pointText } from '../lib/video-node.js';

const fileUrl = id => `/api/creation/assets/${id}/file`;
const LANGUAGE = { zh: '中文', en: '英文' };

export function Thumb({ item }) {
 if (item.kind === 'image' && item.asset) return <img src={fileUrl(item.asset)} alt="" />;
 return <span aria-hidden="true">{item.kind === 'audio' ? '♪' : item.kind === 'video' ? '▶' : '▧'}</span>;
}

// 素材标签卡片：画布节点与视频工作台共用。首帧 / 尾帧不编号，其余点击在提示词光标处插入标签。
export function MaterialCard({ item, locked, onInsert, onRemove }) {
 const frame = item.port === 'first' || item.port === 'last';
 const body = <><span className={`vn-thumb ${item.kind}`}><Thumb item={item} /></span><span className="vn-meta"><strong>{item.label}</strong><small title={item.title}>{item.title}{frame ? ' · 不编号' : ''}</small></span></>;
 return <li className={`vn-card ${item.kind}`}>
  {frame ? <div className="vn-card-main">{body}</div> : <button type="button" className="vn-card-main" disabled={locked} aria-label={`插入 ${item.label} 标签`} title="点击在提示词光标处插入标签" onClick={() => onInsert(item.sourceTaskId)}>{body}</button>}
  <button type="button" className="vn-x" disabled={locked} aria-label={`移除 ${item.label}`} onClick={onRemove}>×</button>
 </li>;
}

// 方式选择、未使用连线提示、参考素材计数与素材标签卡片。
// renderItems：视频工作台用按槽位分组的素材区替换默认的卡片列表，方式切换、尾帧选择与未使用连线提示保持共用。
export function VideoModePanel({ task, analysis, locked, change, editor, onInsert, renderItems }) {
 const { mode, items, unused, refCount } = analysis;
 const removeOwnFrame = item => change(item?.tail ? { tailFrame: null } : { sourceAssetId: null, sourceRunId: null });
 return <section className="vn-panel" aria-label="视频方式与素材">
  <div className="vn-modes" role="radiogroup" aria-label="视频方式">
   {VIDEO_MODE_ORDER.map(id => <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'on' : ''} disabled={locked} onClick={() => change({ videoMode: id })}>{VIDEO_MODE_LABEL[id]}</button>)}
  </div>
  <TailFramePicker task={task} mode={mode} locked={locked} change={change} editor={editor} />
  {mode === 'reference' && <small className="canvas-ref-count vn-count" aria-label="参考素材数量">参考素材 {refCount} / 12</small>}
  {unused.length > 0 && <p className="vn-unused" role="status">当前方式不使用 {unused.length} 条连线，可移除。<button type="button" disabled={locked} onClick={() => editor.removeEdges(unused.map(u => u.edgeId))}>移除</button></p>}
  {renderItems ? renderItems({ analysis, removeOwn: removeOwnFrame }) : items.length > 0 ? <ul className="vn-cards" aria-label="已接入素材">
   {items.map(item => <MaterialCard key={item.edgeId || 'own'} item={item} locked={locked} onInsert={onInsert} onRemove={() => item.edgeId ? editor.removeEdge(item.edgeId) : removeOwnFrame(item)} />)}
  </ul> : <p className="vn-empty">{mode === 'text' ? '文字方式不使用图片、视频或音频素材。' : '从素材节点拖线到左侧端口，接入素材。'}</p>}
 </section>;
}

// 首尾帧方式下，分镜的首帧可来自上一镜尾帧（V-12）：上一镜成功后截取最后一帧；上一镜更新后只提示，不自动替换。
// editor.shotOf(taskId) 只在该节点是分镜时返回 { prevNodeId, prevTitle, prevStatus, stale }。
export function TailFramePicker({ task, mode, locked, change, editor }) {
 const shot = editor.shotOf?.(task.id);
 if (mode !== 'frames' || !shot?.prevNodeId) return null;
 const tail = task.tailFrame, pickTail = e => {
  if (e.target.value === 'link') { change({ tailFrame: null }); return; }
  change({ tailFrame: { fromNodeId: shot.prevNodeId, runId: null, assetId: null } });
  if (shot.prevStatus === 'succeeded') editor.captureTail?.(task.id);
 };
 return <div className="vn-tail">
  <label className="v3-field"><span>首帧来源</span><select aria-label="首帧来源" value={tail ? 'tail' : 'link'} disabled={locked} onChange={pickTail}>
   <option value="link">画布连线或素材</option><option value="tail">上一镜尾帧</option>
  </select></label>
  {tail && (tail.assetId
   ? <p className="vn-tail-note">已使用「{shot.prevTitle}」的尾帧作为首帧。</p>
   : shot.prevStatus === 'succeeded'
    ? <p className="vn-tail-note">上一镜已成功，还没有截取尾帧。<button type="button" className="v3-btn small" disabled={locked} onClick={() => editor.captureTail?.(task.id)}>截取尾帧</button></p>
    : <p className="vn-tail-note" role="status">等待上一镜生成成功</p>)}
  {tail?.assetId && shot.stale && <p className="vn-warn" role="status">上一镜已更新<button type="button" className="v3-btn small" disabled={locked} onClick={() => editor.captureTail?.(task.id)}>换用新尾帧</button></p>}
 </div>;
}

// 提示词下方的标签预览：按当前顺序换算 {{ref:…}}；引用已移除素材的标签标红并可删除。
export function VideoTagPreview({ task, analysis, locked, change, editor }) {
 if (!hasTags(task.prompt)) return null;
 const remove = raw => change({ prompt: (editor.latest(task.id)?.prompt ?? task.prompt).split(raw).join('') });
 return <div className="vn-tagpreview" aria-label="标签预览">
  <span className="vn-tagpreview-title">标签预览</span>
  <p>{tagSegments(task.prompt, analysis).map((part, index) => part.type === 'text' ? <span key={index}>{part.text}</span> : <span key={index} className={`vn-tag ${part.status}`} title={part.title || ''}>{part.text}{part.status !== 'ok' && <button type="button" disabled={locked} aria-label={`删除标签 ${part.text}`} onClick={() => remove(part.raw)}>删除</button>}</span>)}</p>
 </div>;
}

const cueTime = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

// 台词（每行文本 + 语言 + 角色）、配音方式、合成配音与时长对齐。
export function VideoDialogue({ task, duration, locked, change, editor }) {
 const dialogue = Array.isArray(task.dialogue) ? task.dialogue : [];
 const latest = () => editor.latest(task.id)?.dialogue ?? dialogue;
 const update = (index, patch) => change({ dialogue: latest().map((line, i) => i === index ? { ...line, ...patch } : line) });
 const roles = editor.voiceRoles || [];
 const voiceReady = Boolean(editor.voiceConfigured);
 const dubMode = task.dubMode || 'none';
 const dub = editor.dubState?.(task.id) || null;
 const [pending, setPending] = useState(false), [problem, setProblem] = useState('');
 const hasText = dialogue.some(line => line.text?.trim());
 const needed = estimateDialogueSeconds(dialogue);
 const warning = !dub?.audio && hasText && needed > duration ? `台词约需 ${Math.ceil(needed)} 秒，超过分镜时长 ${duration} 秒，建议加长时长或精简台词。` : '';
 const synthesize = async () => { setPending(true); setProblem(''); try { await editor.synthesizeDialogue(task.id); } catch (e) { setProblem(e.message); } finally { setPending(false); } };
 const remix = async () => { setPending(true); setProblem(''); try { await editor.remixDub(task.id); } catch (e) { setProblem(e.message); } finally { setPending(false); } };
 // 提醒以节点当前时长为准：加长后立即消失，不等服务端详情刷新。
 const suggestion = dub?.status === 'fresh' && dub.audio && dub.audio.durationSec > duration ? { ...dub.suggestion, message: `配音约 ${Number(dub.audio.durationSec).toFixed(1)} 秒，超过分镜时长 ${duration} 秒。`, suggestedDuration: dub.audio.durationSec <= 29 ? Math.min(30, Math.ceil(dub.audio.durationSec + 1)) : null } : null;
 const lengthen = () => change({ params: { ...(editor.latest(task.id)?.params || task.params || {}), duration: suggestion.suggestedDuration } });
 const faster = () => {
  const ids = [...new Set(dialogue.map(line => line.roleId).filter(Boolean))];
  editor.speedUpRoles?.(ids);
 };
 const dubbing = ['post', 'lipsync'].includes(dubMode) && hasText;
 const dubStatusText = dub?.status === 'fresh' ? `已合成 · ${Number(dub.audio.durationSec).toFixed(1)} 秒 · ${dub.audio.textWords ?? '—'} 个字符`
  : dub?.status === 'stale' ? '配音已过期，请重新合成' : '还没有合成配音';
 return <fieldset className="vn-dialogue">
  <legend>台词与配音</legend>
  {dialogue.map((line, index) => <div className="vn-line" key={index}>
   <DraftText aria-label={`台词 ${index + 1}`} value={line.text} maxLength={2000} disabled={locked} placeholder="这一句的台词" onCommit={text => update(index, { text })} />
   <select aria-label={`台词 ${index + 1} 语言`} value={line.language} disabled={locked} onChange={e => update(index, { language: e.target.value })}>{Object.entries(LANGUAGE).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
   <button type="button" className="vn-x" aria-label={`删除台词 ${index + 1}`} disabled={locked} onClick={() => change({ dialogue: latest().filter((_, i) => i !== index) })}>×</button>
   {roles.length > 0 && <select className="vn-line-role" aria-label={`台词 ${index + 1} 角色`} value={line.roleId || ''} disabled={locked} onChange={e => update(index, { roleId: e.target.value || undefined })}>
    <option value="">选择角色</option>
    {line.roleId && !roles.some(r => r.id === line.roleId) && <option value={line.roleId}>角色已删除</option>}
    {roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
   </select>}
  </div>)}
  <button type="button" className="v3-btn small" disabled={locked || dialogue.length >= 50} onClick={() => change({ dialogue: [...latest(), { text: '', language: 'zh', ...(roles[0] ? { roleId: roles[0].id } : {}) }] })}>＋ 添加台词</button>
  {warning && <p className="vn-warn" role="status">{warning}</p>}
  <label className="v3-field"><span>配音方式</span><select aria-label="配音方式" value={dubMode} disabled={locked} onChange={e => change({ dubMode: e.target.value })}>
   <option value="none">不配音</option><option value="lipsync">口型同步</option><option value="post" disabled={!voiceReady && dubMode !== 'post'}>{voiceReady ? '后期配音' : '后期配音（需先配置语音渠道）'}</option>
  </select></label>
  {!voiceReady && <small className="vn-note">后期配音需要先在模型中心配置火山引擎语音渠道。</small>}
  {dubMode === 'lipsync' && task.videoMode !== 'reference' && <small className="vn-note">口型同步依赖参考音频，请使用「全能参考」方式。</small>}
  {dubMode === 'post' && <small className="vn-note">后期配音：台词不写入提示词，视频生成后再把配音混入，原声压低到约 30%。</small>}
  {dubMode === 'lipsync' && <small className="vn-note">口型同步：台词写入提示词，合成语音作为参考音频一并提交。</small>}
  {dubMode === 'none' && hasText && <small className="vn-note">台词会写入提示词，由视频模型直接生成人声。</small>}
  {dubbing && <div className="vn-dub" aria-label="台词配音">
   <div className="vn-dub-head"><strong>台词配音</strong><span className={`vn-dub-badge ${dub?.status || 'none'}`}>{dubStatusText}</span></div>
   {roles.length === 0 && <small className="vn-note">先添加角色并选择音色。<button type="button" className="v3-btn small" onClick={() => editor.openRoles?.()}>角色与音色</button></small>}
   {dub?.issue && dub.status !== 'fresh' && roles.length > 0 && <small className="vn-note">{dub.issue}</small>}
   <div className="vn-dub-actions">
    <button type="button" className="v3-btn small primary" disabled={locked || pending || !voiceReady || !!dub?.issue} title={voiceReady ? '按行合成并拼接，产生少量语音字符费用' : '请先在模型中心配置火山引擎语音渠道'} onClick={synthesize}>{pending ? '处理中…' : dub?.status === 'stale' ? '重新合成配音' : '合成配音'}</button>
    {dub?.status === 'stale' && <small className="vn-warn" role="status">配音已过期，请重新合成</small>}
   </div>
   {dub?.audio && dub.status === 'fresh' && <audio src={`/api/creation/assets/${dub.audio.assetId}/file`} controls preload="none" aria-label="台词配音试听" />}
   {suggestion && <div className="vn-warn" role="status">{suggestion.message}
    <span className="vn-dub-actions">
     {suggestion.suggestedDuration && <button type="button" className="v3-btn small" disabled={locked} onClick={lengthen}>加长到 {suggestion.suggestedDuration} 秒</button>}
     <button type="button" className="v3-btn small" disabled={locked} onClick={faster}>加快语速</button>
    </span></div>}
   {dub?.status === 'fresh' && <div className="vn-subs" aria-label="分镜字幕">
    <label className="vn-subs-toggle"><input type="checkbox" aria-label="本镜显示字幕" checked={task.subtitles !== false} disabled={locked} onChange={e => change({ subtitles: e.target.checked })} />本镜显示字幕</label>
    {dub.audio?.cues?.length ? <ol className="vn-subs-list" aria-label="字幕条目预览">{dub.audio.cues.map((cue, i) => <li key={i} className={task.subtitles === false ? 'off' : ''}><time>{cueTime(cue.start)} – {cueTime(cue.end)}</time><span>{cue.text}</span></li>)}</ol>
     : <small className="vn-note">这段配音没有字幕时间戳，重新合成配音后即可生成字幕。</small>}
   </div>}
   {dubMode === 'post' && dub?.dub?.status === 'running' && <small className="vn-note" role="status">正在混音…</small>}
   {dubMode === 'post' && dub?.dub?.status === 'failed' && <p className="vn-warn" role="alert">混音失败：{dub.dub.error}（原视频不受影响）</p>}
   {dubMode === 'post' && dub?.dub?.truncated && dub.dub.assetId && <small className="vn-warn">配音比视频长，混音时已截断到视频长度。</small>}
   {dubMode === 'post' && (dub?.needsMix || dub?.dub?.status === 'failed') && <button type="button" className="v3-btn small" disabled={locked || pending} onClick={remix}>重新混音</button>}
   {problem && <p className="vr-error" role="alert">{problem}</p>}
  </div>}
 </fieldset>;
}

// 时长 / 分辨率 / 比例、去除音轨、AIGC 水印与积分预估。
// inherit：视频工作台里分镜跟随的项目级参数 { resolution, ratio, duration }；节点没写的键显示为「跟随项目（值）」。
export function VideoParams({ task, params, analysis, locked, parameter, editor, inherit = null }) {
 const invalidDuration = params.duration !== undefined && (!Number.isInteger(params.duration) || params.duration < 4 || params.duration > 30);
 const channelId = task.model?.channelId || editor.defaults?.video?.channelId;
 const effective = inherit ? { ...inherit, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) } : params;
 const points = estimateVideoPoints(effective, editor.channels?.find(c => c.id === channelId)?.executorConfig);
 const adaptiveAllowed = analysis.hasImage || effective.ratio === 'adaptive';
 const follow = key => inherit ? `跟随项目（${key === 'duration' ? `${inherit.duration} 秒` : inherit[key]}）` : '使用模型默认';
 return <>
  <div className="canvas-param-grid">
   <label className="v3-field">时长（秒）<input aria-label="时长（秒）" aria-invalid={invalidDuration} type="number" min="4" max="30" value={typeof params.duration === 'number' ? params.duration : ''} placeholder={invalidDuration ? '请填写有效时长' : inherit ? follow('duration') : '模型默认'} disabled={locked} onChange={e => parameter({ duration: e.target.value === '' ? undefined : Number(e.target.value) })} />{invalidDuration && <small role="alert">时长 {JSON.stringify(params.duration)} 无效，请填写 4–30 的整数秒。</small>}</label>
   <label className="v3-field">分辨率<select aria-label="分辨率" value={params.resolution === undefined ? '' : VIDEO_RESOLUTIONS.includes(params.resolution) ? params.resolution : 'invalid'} disabled={locked} onChange={e => parameter({ resolution: e.target.value || undefined })}>
    <option value="">{follow('resolution')}</option>
    {params.resolution !== undefined && !VIDEO_RESOLUTIONS.includes(params.resolution) && <option value="invalid" disabled>{String(params.resolution)}（无效，请选择）</option>}
    {VIDEO_RESOLUTIONS.map(v => <option key={v}>{v}</option>)}
   </select></label>
   <label className="v3-field">画面比例<select aria-label="画面比例" value={params.ratio === undefined ? '' : VIDEO_RATIOS.includes(params.ratio) ? params.ratio : 'invalid'} disabled={locked} onChange={e => parameter({ ratio: e.target.value || undefined })}>
    <option value="">{follow('ratio')}</option>
    {params.ratio !== undefined && !VIDEO_RATIOS.includes(params.ratio) && <option value="invalid" disabled>{String(params.ratio)}（无效，请选择）</option>}
    {VIDEO_RATIOS.map(v => <option key={v} value={v} disabled={v === 'adaptive' && !adaptiveAllowed}>{v === 'adaptive' ? (adaptiveAllowed ? '跟随首帧' : '跟随首帧（需先接入图片）') : v}</option>)}
   </select></label>
  </div>
  <div className="vn-switches">
   <label className="v3-check"><input type="checkbox" aria-label="去除音轨" checked={params.mute_audio === true} disabled={locked} onChange={e => parameter({ mute_audio: e.target.checked ? true : undefined })} />去除音轨</label>
   <label className="v3-check"><input type="checkbox" aria-label="AIGC 水印" checked={params.aigc_watermark === true} disabled={locked} onChange={e => parameter({ aigc_watermark: e.target.checked ? true : undefined })} />AIGC 水印</label>
  </div>
  {points !== null && <div className="vn-points" aria-label="积分预估">预估 {pointText(points)}<small>{effective.resolution || '768P'} × {Number.isInteger(effective.duration) ? effective.duration : 5} 秒</small></div>}
 </>;
}

// 高级设置：提示词优化与 Skill（展开后才读取 Skill 列表；失败只影响这个下拉）。
export function VideoAdvanced({ task, params, parameter, locked, editor, open }) {
 const [state, setState] = useState({ status: 'idle', skills: [], error: '' });
 const channelId = task.model?.channelId || editor.defaults?.video?.channelId || '';
 // 展开高级设置时读取；只依赖展开状态与渠道，避免状态变化触发清理而丢弃进行中的请求。
 useEffect(() => {
  if (!open) return;
  let alive = true;
  setState(old => ({ ...old, status: 'loading' }));
  editor.request('/api/model-hub/video/skills' + (channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''))
   .then(result => { if (alive) setState({ status: 'ready', skills: Array.isArray(result.skills) ? result.skills : [], error: '' }); })
   .catch(error => { if (alive) setState({ status: 'failed', skills: [], error: error.message || '未知原因' }); });
  return () => { alive = false; };
 }, [open, channelId]);
 const skillId = params.skill_id || '';
 const known = state.skills.some(s => s.id === skillId);
 return <div className="vn-advanced">
  <label className="v3-check"><input type="checkbox" aria-label="提示词优化" checked={params.use_context_ir === true} disabled={locked} onChange={e => parameter(e.target.checked ? { use_context_ir: true } : { use_context_ir: undefined, skill_id: undefined })} />提示词优化</label>
  <label className="v3-field"><span>Skill</span><select aria-label="Skill" value={skillId} disabled={locked || state.status === 'failed'} onChange={e => parameter(e.target.value ? { skill_id: e.target.value, use_context_ir: true } : { skill_id: undefined })}>
   <option value="">{state.status === 'failed' ? `Skill 列表加载失败：${state.error}` : state.status === 'loading' ? '正在读取 Skill…' : '不使用 Skill'}</option>
   {skillId && !known && <option value={skillId}>{skillId}（当前选择）</option>}
   {state.skills.map(s => <option key={s.id} value={s.id}>{s.name}{s.official ? '（官方）' : ''}</option>)}
  </select></label>
  {state.status === 'failed' && <small className="vn-note">Skill 暂时无法选择，其他设置不受影响。</small>}
  {skillId && params.use_context_ir !== true && <small className="vn-note">选择 Skill 需要同时开启提示词优化。</small>}
 </div>;
}
