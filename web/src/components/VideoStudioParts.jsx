import { useEffect, useRef, useState } from 'react';
import { AssetFeed } from './AssetPicker.jsx';
import { MaterialCard } from './VideoNodeEditor.jsx';
import { VIDEO_PORT_LIMIT, VIDEO_PORT_TYPE, MEDIA_RULES, validateMediaFile } from '../lib/video-node.js';
import { MEDIA_BYTE_LIMITS } from '../../../shared/creation-video-parameters.mjs';
import { SLOT_LABEL, succeededRuns, clock } from '../lib/video-studio.js';

const fileUrl = id => `/api/creation/assets/${id}/file`;
const statusLabels = { queued: '排队中', submitting: '提交中', running: '生成中', unknown: '待核实', cancelling: '取消中', cancelled: '已取消', failed: '失败', succeeded: '成功', idle: '未生成' };
const KIND = { image: { label: '图片', prefix: 'image/', accept: 'image/png,image/jpeg,image/webp' }, video: { label: '视频', prefix: 'video/', accept: MEDIA_RULES.footage.accept }, audio: { label: '音频', prefix: 'audio/', accept: MEDIA_RULES.audio.accept } };

// 可折叠分区（手机端各分区折叠）：open 由父级控制，原生 <details> 的展开 / 收起通过 onToggle 回写。
export function Section({ id, title, badge = null, open, onToggle, flash = false, children }) {
 return <details className={`vs-sec${flash ? ' flash' : ''}`} id={`vs-sec-${id}`} data-section={id} open={open} onToggle={event => { if (event.currentTarget.open !== open) onToggle(event.currentTarget.open); }}>
  <summary><span className="vs-sec-title">{title}</span>{badge}</summary>
  <div className="vs-sec-body">{children}</div>
 </details>;
}

// 侧边抽屉（脚本 / 成片）：停靠在编辑区右侧，不遮挡顶部条与时间线，手机端占满宽度。
export function Drawer({ title, onClose, children, className = '' }) {
 return <aside className={`vs-drawer ${className}`} role="dialog" aria-label={title}>
  <header><h3>{title}</h3><button type="button" className="vs-close" aria-label={`关闭${title}`} onClick={onClose}>×</button></header>
  <div className="vs-drawer-body">{children}</div>
 </aside>;
}

// 顶部时间线（W1 / W7）：一排缩略图，点击选中，拖动排序，末尾「＋」新增；缩略图上标出自定义与需要处理的原因。
export function Timeline({ items, selectedId, writable, canAdd, onSelect, onReorder, onAdd, onIssue }) {
 const [drag, setDrag] = useState(null), [over, setOver] = useState(null);
 const track = useRef(null);
 useEffect(() => { track.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); }, [selectedId]);
 const finish = () => { setDrag(null); setOver(null); };
 return <ol className="vs-track" ref={track} aria-label="分镜时间线">
  {items.map(({ shot, index, title, state, thumb, duration, custom, customKeys, issues }) => <li key={shot.id}
   className={`vs-tile${shot.id === selectedId ? ' on' : ''}${drag === index ? ' dragging' : ''}${over === index && drag !== null && drag !== index ? ' over' : ''}`} data-tile={shot.id} data-status={state.status}
   draggable={writable} onDragStart={event => { setDrag(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', shot.id); }}
   onDragOver={event => { if (drag === null) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(index); }}
   onDrop={event => { event.preventDefault(); if (drag !== null && drag !== index) onReorder(drag, index); finish(); }} onDragEnd={finish}>
   <button type="button" className="vs-tile-main" aria-current={shot.id === selectedId ? 'true' : undefined} aria-label={`选择分镜 ${index + 1} ${title}`} onClick={() => onSelect(shot.id)}>
    <span className="vs-tile-thumb">{thumb ? <video src={`${fileUrl(thumb)}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" /> : <span aria-hidden="true">{['running', 'submitting', 'queued'].includes(state.status) ? '…' : '▷'}</span>}<b className="vs-tile-no">{index + 1}</b></span>
    <span className="vs-tile-title">{title}</span>
    <span className="vs-tile-meta"><span className={`v3-badge ${state.status}`}>{statusLabels[state.status] || '未生成'}</span><span>{duration} 秒</span></span>
   </button>
   {(custom || issues.length > 0) && <span className="vs-tile-flags">
    {custom && <span className="vs-flag custom" title={`与项目不同：${customKeys.join('、')}`}>自定义</span>}
    {issues.map(issue => <button type="button" key={issue.label} className="vs-flag issue" data-issue={issue.kind} title={`${issue.label}，点击处理`} aria-label={`处理：${issue.label}（分镜 ${index + 1}）`} onClick={() => onIssue(shot.id, issue)}>{issue.label}</button>)}
   </span>}
  </li>)}
  <li className="vs-add"><button type="button" aria-label="＋ 添加分镜" title="添加分镜" disabled={!writable || !canAdd} onClick={onAdd}>＋</button></li>
 </ol>;
}

// 单镜素材区（W2）：按当前方式显示素材槽位，每个槽位一个「＋选择素材」；卡片可点击插入提示词标签，× 移除。
export function MaterialSlots({ analysis, removeOwn, slots, locked, editor, onInsert, onPick }) {
 if (!slots.length) return <p className="vn-empty">文字方式不使用图片、视频或音频素材。需要素材时切换到「首尾帧」或「全能参考」。</p>;
 return <div className="vs-slots">{slots.map(port => {
  const list = analysis.items.filter(item => item.port === port), limit = VIDEO_PORT_LIMIT[port], single = limit === 1;
  return <div className="vs-slot" key={port} data-slot={port}>
   <div className="vs-slot-head"><strong>{SLOT_LABEL[port]}</strong><small>{list.length} / {limit}</small><span className="v3-grow" />
    <button type="button" className="v3-btn small" aria-label={`${SLOT_LABEL[port]}：选择素材`} disabled={locked || (!single && list.length >= limit)} onClick={() => onPick(port)}>{single && list.length ? '更换素材' : '＋选择素材'}</button>
   </div>
   {list.length ? <ul className="vn-cards" aria-label={`${SLOT_LABEL[port]}素材`}>{list.map(item => <MaterialCard key={item.edgeId || 'own'} item={item} locked={locked} onInsert={onInsert} onRemove={() => item.edgeId ? editor.detachMaterial(item.edgeId) : removeOwn(item)} />)}</ul>
    : <p className="vn-empty">还没有{SLOT_LABEL[port]}。</p>}
  </div>;
 })}</div>;
}

// 素材选择弹层：商品素材 / 画布结果（具体成功版本）/ 素材库 / 直接上传。选择后由 editor.attachMaterial 创建输入节点并连线。
export function MaterialPicker({ port, task, editor, productId, projectId, onClose }) {
 const type = VIDEO_PORT_TYPE[port], kind = KIND[type];
 const [tab, setTab] = useState('product'), [problem, setProblem] = useState(''), [busy, setBusy] = useState(false);
 // 商品素材：属于本项目关联商品，或在本项目里上传的创作素材（服务端取并集）；素材库：全部可用素材，服务端搜索 + 加载更多。
 const productParams = { role: 'creative', type, match: 'any', ...(productId ? { productId } : {}), projectId };
 // 画布上其它节点的具体成功版本：图片槽位取图片类节点，视频槽位取视频节点。
 const results = editor.tasks.filter(t => t.id !== task.id && ['generate', 'edit', 'composite', 'video'].includes(t.kind) && (t.kind === 'video') === (type === 'video') && type !== 'audio')
  .flatMap(t => succeededRuns(editor.runs, t.id).map((run, index) => ({ run, task: t, version: index + 1 })));
 const finish = result => { if (result.error) setProblem(result.error); else onClose(); };
 const pickAsset = asset => finish(editor.attachMaterial({ taskId: task.id, port, asset: { id: asset.id, name: asset.name } }));
 const upload = async event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  let send = file;
  if (type === 'image') {
   if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setProblem('图片仅支持 png / jpg / webp。'); return; }
   if (file.size > MEDIA_BYTE_LIMITS.image) { setProblem(`图片不能超过 ${Math.round(MEDIA_BYTE_LIMITS.image / 1024 / 1024)} MiB。`); return; }
  } else {
   const checked = validateMediaFile(type === 'video' ? 'footage' : 'audio', file);
   if (checked.error) { setProblem(checked.error); return; }
   send = new File([file], file.name, { type: checked.mime });
  }
  setBusy(true); setProblem('');
  try { pickAsset(await editor.uploadAsset(send)); }
  catch (e) { setProblem(e.message || '上传失败。'); }
  finally { setBusy(false); }
 };
 const assetButton = asset => <li key={asset.id}><button type="button" className="vs-pick" aria-label={`选择素材 ${asset.name}`} onClick={() => pickAsset(asset)}>
  <span className="vs-pick-thumb">{type === 'image' ? <img src={fileUrl(asset.id)} alt="" loading="lazy" /> : <span aria-hidden="true">{type === 'audio' ? '♪' : '▶'}</span>}</span><span className="vs-pick-name">{asset.name}</span></button></li>;
 const tabs = [['product', '商品素材'], ['results', '画布结果'], ['library', '素材库'], ['upload', '上传']];
 return <div className="v3-overlay"><div className="v3-dialog vs-picker" role="dialog" aria-modal="true" aria-label={`选择${SLOT_LABEL[port]}素材`}>
  <header><h2>选择{SLOT_LABEL[port]}（{kind.label}）</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
  <div className="v3-tabs" role="tablist">{tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); setProblem(''); }}>{label}</button>)}</div>
  {problem && <p className="vn-problem" role="alert">{problem}</p>}
  <div className="vs-pick-body">
   {tab === 'product' && <AssetFeed request={editor.request} owner={editor.owner} params={productParams} onLoaded={editor.rememberAssets} empty={<p className="v3-note">还没有{kind.label}类的商品创作素材，可以在「上传」里添加。</p>}>{items => <ul className="vs-pick-grid">{items.map(assetButton)}</ul>}</AssetFeed>}
   {tab === 'results' && (results.length ? <ul className="vs-pick-grid">{results.map(({ run, task: source, version }) => <li key={run.id}><button type="button" className="vs-pick" aria-label={`选择画布结果 ${source.title} 版本 ${version}`} onClick={() => finish(editor.attachMaterial({ taskId: task.id, port, run }))}>
    <span className="vs-pick-thumb">{type === 'image' ? <img src={fileUrl(run.output.assetId)} alt="" loading="lazy" /> : <span aria-hidden="true">▶</span>}</span><span className="vs-pick-name">{source.title} · 版本 {version}</span></button></li>)}</ul> : <p className="v3-note">画布上还没有可用的{kind.label}成功结果。选择后会固定这个具体版本。</p>)}
   {tab === 'library' && <AssetFeed request={editor.request} owner={editor.owner} params={{ type }} onLoaded={editor.rememberAssets} searchLabel="搜索素材库" empty={<p className="v3-note">素材库里没有符合的{kind.label}。</p>}>{items => <ul className="vs-pick-grid">{items.map(assetButton)}</ul>}</AssetFeed>}
   {tab === 'upload' && <div className="vs-upload"><label className="v3-file">选择{kind.label}文件<input type="file" aria-label={`上传${kind.label}`} accept={kind.accept} disabled={busy} onChange={upload} /></label>
    <small className="vn-note">{type === 'image' ? 'png / jpg / webp，单个不超过 30 MiB' : (type === 'video' ? MEDIA_RULES.footage : MEDIA_RULES.audio).hint}；上传后保存为项目创作素材并自动连入该槽位。</small>{busy && <p role="status" className="v3-note">正在上传…</p>}</div>}
  </div>
 </div></div>;
}

// 整片连播预览（W6）：不拼接，在浏览器里依次播放各镜当前展示的成功版本（有新鲜配音版时优先）；未生成的镜显示占位画面与时长。
export function PreviewPlayer({ playlist, onClose }) {
 const [index, setIndex] = useState(0), [done, setDone] = useState(false), [left, setLeft] = useState(0);
 const video = useRef(null), advanceRef = useRef(null), indexRef = useRef(0), failTimer = useRef(null);
 const item = playlist[index] || null;
 indexRef.current = index;
 const advance = () => { if (index + 1 < playlist.length) setIndex(index + 1); else setDone(true); };
 advanceRef.current = advance;
 const jump = target => { clearTimeout(failTimer.current); setDone(false); setIndex(Math.max(0, Math.min(playlist.length - 1, target))); };
 useEffect(() => {
  clearTimeout(failTimer.current);
  if (done || !item) return undefined;
  if (item.src) { try { video.current?.play?.()?.catch?.(() => {}); } catch { /* 浏览器拒绝自动播放时由用户点播放 */ } return undefined; }
  let remaining = item.duration; setLeft(remaining);
  const tick = setInterval(() => { remaining -= 1; setLeft(remaining); if (remaining <= 0) { clearInterval(tick); advanceRef.current(); } }, 1000);
  return () => clearInterval(tick);
 }, [index, done, item?.src, item?.duration]);
 useEffect(() => () => clearTimeout(failTimer.current), []);
 const total = playlist.reduce((sum, entry) => sum + entry.duration, 0);
 return <div className="v3-overlay"><div className="v3-dialog vs-player" role="dialog" aria-modal="true" aria-label="整片连播预览">
  <header><h2>整片连播预览</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
  <p className="v3-note">按顺序播放各镜当前展示的成功版本，不拼接、不产生费用；未生成的镜头显示占位画面。</p>
  <div className="vs-player-stage">
   {done ? <div className="vs-player-ph" role="status"><strong>播放结束</strong><button type="button" className="v3-btn" onClick={() => jump(0)}>从头再看</button></div>
    : item?.src ? <video key={`${item.shotId}:${item.src}`} ref={video} className="vs-player-video" src={fileUrl(item.src)} controls playsInline aria-label={`第 ${index + 1} 镜：${item.title}`}
       onEnded={advance} onError={() => { const at = indexRef.current; clearTimeout(failTimer.current); failTimer.current = setTimeout(() => { if (indexRef.current === at) advanceRef.current(); }, 1200); }} />
     : <div className="vs-player-ph" role="status"><strong>第 {index + 1} 镜还没有生成</strong><span>{item?.title}</span><span>占位 {item?.duration} 秒 · 剩余 {Math.max(0, left)} 秒</span></div>}
  </div>
  <p className="vs-player-now" aria-live="polite">{done ? `共 ${playlist.length} 镜 · ${clock(total)}` : `第 ${index + 1} / ${playlist.length} 镜 · ${item?.title || ''}${item?.dubAssetId ? ' · 配音版' : ''}`}</p>
  <ol className="vs-player-list" aria-label="连播清单">{playlist.map((entry, i) => <li key={entry.shotId}><button type="button" className={!done && i === index ? 'on' : ''} data-src={entry.src || ''} aria-label={`跳到第 ${i + 1} 镜 ${entry.title}`} onClick={() => jump(i)}>{i + 1}<small>{entry.src ? (entry.dubAssetId ? '配音' : '已生成') : '占位'}</small></button></li>)}</ol>
  <footer><button type="button" className="v3-btn" disabled={index === 0 && !done} onClick={() => jump(done ? playlist.length - 1 : index - 1)}>上一镜</button><button type="button" className="v3-btn" disabled={done || index + 1 >= playlist.length} onClick={() => jump(index + 1)}>下一镜</button><span className="v3-grow" /><button type="button" className="v3-btn primary" onClick={onClose}>关闭</button></footer>
 </div></div>;
}
