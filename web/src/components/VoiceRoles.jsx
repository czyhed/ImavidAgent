import { useEffect, useRef, useState } from 'react';
import DraftText from './DraftText.jsx';
import { AssetFeed } from './AssetPicker.jsx';
import { DEFAULT_PREVIEW_TEXT, MAX_PREVIEW_TEXT, MAX_VOICE_ROLES, VOICE_SOURCE_LABEL, defaultResourceFor, validateVoiceRoles } from '../../../shared/creation-voice.mjs';
import '../styles/creation-voice.css';

const fileUrl = id => `/api/creation/assets/${id}/file`;
const GENDER = { female: '女声', male: '男声' };
const PAGE = 40;
const newRole = (n, source = 'system') => ({ id: crypto.randomUUID(), name: `角色 ${n}`, speaker: '', source, resourceId: defaultResourceFor(source), speechRate: 0, emotion: '', emotionScale: 4, loudnessRate: 0, contextText: '' });

// 试听按钮：同一音色、文本和参数的结果由服务端缓存，重复播放不再收费。
function Audition({ request, speaker, resourceId, params, text, label = '试听', disabled }) {
 const [state, setState] = useState({ busy: false, url: '', note: '', error: '' });
 const audio = useRef(null);
 const play = async () => {
  setState({ busy: true, url: '', note: '', error: '' });
  try {
   const result = await request('/api/creation/voice/preview', { speaker, resourceId, params, ...(text ? { text } : {}) });
   setState({ busy: false, url: result.fileUrl, note: result.cached ? '已缓存，未重复收费' : `本次消耗 ${result.textWords} 个字符`, error: '' });
   setTimeout(() => audio.current?.play?.().catch(() => {}), 50);
  } catch (e) { setState({ busy: false, url: '', note: '', error: e.message }); }
 };
 return <span className="vr-audition">
  <button type="button" className="v3-btn small" disabled={disabled || state.busy || !speaker} onClick={play}>{state.busy ? '合成中…' : label}</button>
  {state.url && <audio ref={audio} src={state.url} controls preload="none" aria-label="试听音频" />}
  {state.note && <small className="vn-note">{state.note}</small>}
  {state.error && <small className="vr-error" role="alert">{state.error}</small>}
 </span>;
}

// 系统音色选择器：按场景 / 性别 / 语言筛选，可试听。
function SystemPicker({ request, role, onPick, configured, writable }) {
 const [filters, setFilters] = useState({ scene: '', gender: '', language: '', q: '' });
 const [data, setData] = useState({ voices: [], facets: { scenes: [], languages: [] }, total: 0 });
 const [shown, setShown] = useState(PAGE), [error, setError] = useState('');
 useEffect(() => {
  let alive = true;
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  request('/api/creation/voices' + (query ? '?' + query : '')).then(result => { if (alive) { setData(result); setShown(PAGE); setError(''); } }).catch(e => alive && setError(e.message));
  return () => { alive = false; };
 }, [filters.scene, filters.gender, filters.language, filters.q]);
 const set = patch => setFilters(old => ({ ...old, ...patch }));
 return <div className="vr-picker">
  <div className="vr-filters">
   <label>场景<select aria-label="音色场景" value={filters.scene} onChange={e => set({ scene: e.target.value })}><option value="">全部</option>{data.facets.scenes.map(s => <option key={s}>{s}</option>)}</select></label>
   <label>性别<select aria-label="音色性别" value={filters.gender} onChange={e => set({ gender: e.target.value })}><option value="">全部</option>{Object.entries(GENDER).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
   <label>语言<select aria-label="音色语言" value={filters.language} onChange={e => set({ language: e.target.value })}><option value="">全部</option>{data.facets.languages.map(s => <option key={s}>{s}</option>)}</select></label>
   <label>搜索<DraftText aria-label="搜索音色" value={filters.q} maxLength={40} placeholder="音色名称" onCommit={q => set({ q })} /></label>
  </div>
  {error && <p className="vr-error" role="alert">{error}</p>}
  <p className="vn-note" aria-live="polite">共 {data.total} 个音色{data.voices.length > shown ? `，先显示 ${shown} 个` : ''}</p>
  <ul className="vr-voices" aria-label="系统音色">
   {data.voices.slice(0, shown).map(voice => <li key={voice.voiceType} className={role.speaker === voice.voiceType ? 'on' : ''}>
    <div className="vr-voice-meta"><strong>{voice.name}</strong><small>{[voice.scene, GENDER[voice.gender], voice.languages.slice(0, 2).join('、'), voice.emotion ? '可调情感' : ''].filter(Boolean).join(' · ')}</small></div>
    <Audition request={request} speaker={voice.voiceType} resourceId="seed-tts-2.0" params={{}} disabled={!configured || !writable} />
    <button type="button" className="v3-btn small" disabled={!writable} aria-label={`选用 ${voice.name}`} onClick={() => onPick(voice)}>{role.speaker === voice.voiceType ? '已选用' : '选用'}</button>
   </li>)}
  </ul>
  {data.voices.length > shown && <button type="button" className="v3-btn small" onClick={() => setShown(shown + PAGE)}>显示更多</button>}
 </div>;
}

// 音色设计：文字描述或人物图；显示剩余次数，次数用尽时给出中文提示。
function DesignPanel({ request, owner, onAssets, role, onUse, configured, writable }) {
 const [form, setForm] = useState({ speakerId: '', text: '大家好，欢迎光临我们的直播间。', textPrompt: '', imageAssetId: '', language: 0 });
 const [state, setState] = useState({ busy: false, result: null, error: '' });
 const [picked, setPicked] = useState(null);
 const set = patch => setForm(old => ({ ...old, ...patch }));
 const submit = async () => {
  setState({ busy: true, result: null, error: '' });
  try {
   const body = { speakerId: form.speakerId.trim(), text: form.text, language: Number(form.language), ...(form.imageAssetId ? { imageAssetId: form.imageAssetId } : { textPrompt: form.textPrompt }) };
   setState({ busy: false, result: await request('/api/creation/voice/design', body), error: '' });
  } catch (e) { setState({ busy: false, result: null, error: e.message }); }
 };
 const { result } = state;
 return <div className="vr-design">
  <p className="vn-note">用文字描述或人物图设计一个新音色。每个音色编号有设计次数上限，请谨慎使用。</p>
  <label>新音色编号<DraftText aria-label="新音色编号" value={form.speakerId} maxLength={100} placeholder="例如 S_shop_host_01" onCommit={speakerId => set({ speakerId })} /></label>
  <label>音色描述（不超过 200 字）<DraftText multiline rows={2} aria-label="音色描述" value={form.textPrompt} maxLength={200} disabled={Boolean(form.imageAssetId)} placeholder="例如：温柔亲切的年轻女声，语速适中" onCommit={textPrompt => set({ textPrompt })} /></label>
  <div className="vr-field"><span>或选择人物图</span><AssetFeed request={request} owner={owner} params={{ role: 'creative,result', type: 'image' }} onLoaded={onAssets} searchLabel="搜索人物图" placeholder="搜索人物图名称" always>{items => <select aria-label="人物图" value={form.imageAssetId} onChange={e => { setPicked(items.find(a => a.id === e.target.value) || null); set({ imageAssetId: e.target.value }); }}><option value="">不使用人物图</option>{form.imageAssetId && !items.some(a => a.id === form.imageAssetId) && <option value={form.imageAssetId}>{picked?.name || '已选人物图'}</option>}{items.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}</AssetFeed></div>
  <label>试听文本（不超过 300 字）<DraftText aria-label="设计试听文本" value={form.text} maxLength={300} onCommit={text => set({ text })} /></label>
  <label>语言<select aria-label="设计语言" value={form.language} onChange={e => set({ language: e.target.value })}><option value={0}>中文</option><option value={1}>英文</option></select></label>
  <button type="button" className="v3-btn primary small" disabled={!writable || !configured || state.busy || !form.speakerId.trim()} onClick={submit}>{state.busy ? '设计中…' : '设计音色'}</button>
  {state.error && <p className="vr-error" role="alert">{state.error}</p>}
  {result && <div className="vr-design-result" aria-label="设计结果">
   <p>{result.usable ? '音色设计完成，可以使用。' : '音色仍在生成或未通过，请稍后再试。'}<span className="vr-remaining">剩余设计次数：{result.remaining ?? '未知'}</span></p>
   {result.warning && <p className="vn-warn">{result.warning}</p>}
   {result.demo && <audio src={result.demo.fileUrl} controls preload="none" aria-label="设计音色试听" />}
   {result.usable && <button type="button" className="v3-btn small" disabled={!writable} onClick={() => onUse(result)}>设为「{role.name}」的音色</button>}
  </div>}
 </div>;
}

// 角色与音色面板：角色增删改，三种音色来源。保存时才写入项目。
export default function VoiceRolesPanel({ roles, configured, writable, request, owner, onAssets, onSave, onClose }) {
 const [draft, setDraft] = useState(() => roles.map(r => ({ ...r })));
 const [selected, setSelected] = useState(roles[0]?.id || null);
 const [tab, setTab] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [auditionText, setAuditionText] = useState('');
 const role = draft.find(r => r.id === selected) || null;
 const dirty = JSON.stringify(draft) !== JSON.stringify(roles);
 const update = patch => setDraft(old => old.map(r => r.id === selected ? { ...r, ...patch } : r));
 const add = () => { const next = newRole(draft.length + 1); setDraft(old => [...old, next]); setSelected(next.id); setTab(null); };
 const remove = () => { const rest = draft.filter(r => r.id !== selected); setDraft(rest); setSelected(rest[0]?.id || null); };
 const source = tab || role?.source || 'system';
 const save = async () => {
  const checked = validateVoiceRoles(draft);
  if (checked.error) { setError(checked.error); return; }
  setBusy(true); setError('');
  try { await onSave(checked.roles); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); }
 };
 const params = role ? { speechRate: role.speechRate, loudnessRate: role.loudnessRate, emotion: role.emotion, emotionScale: role.emotionScale, contextText: role.contextText } : {};
 return <div className="v3-overlay"><div className="v3-dialog vr-dialog" role="dialog" aria-modal="true" aria-label="角色与音色">
  <header><h2>角色与音色</h2><button type="button" aria-label="关闭角色与音色" onClick={() => { if (!dirty || window.confirm('角色改动尚未保存，确定关闭？')) onClose(); }}>×</button></header>
  {!configured && <p className="vn-warn" role="status">还没有配置火山引擎语音渠道，可以先整理角色；试听和合成需要先到模型中心添加渠道。</p>}
  <div className="vr-layout">
   <aside className="vr-roles" aria-label="角色列表">
    <ul>{draft.map(r => <li key={r.id}><button type="button" className={r.id === selected ? 'on' : ''} onClick={() => { setSelected(r.id); setTab(null); }}><strong>{r.name}</strong><small>{r.speaker ? `${VOICE_SOURCE_LABEL[r.source]} · ${r.speaker}` : '未选音色'}</small></button></li>)}</ul>
    <button type="button" className="v3-btn small" disabled={!writable || draft.length >= MAX_VOICE_ROLES} onClick={add}>＋ 添加角色</button>
   </aside>
   <section className="vr-detail">
    {!role ? <p className="vn-note">还没有角色。添加「旁白」「主播」「顾客」等角色，再给每个角色选一个音色。</p> : <>
     <div className="vr-name-row">
      <label>角色名称<DraftText aria-label="角色名称" value={role.name} maxLength={40} disabled={!writable} onCommit={name => update({ name })} /></label>
      <button type="button" className="v3-btn small danger" disabled={!writable} onClick={remove}>删除角色</button>
     </div>
     <p className="vr-current">当前音色：{role.speaker ? <b>{role.speaker}</b> : '未选择'}（{VOICE_SOURCE_LABEL[role.source]}，资源 {role.resourceId}）</p>
     <div className="vr-tabs" role="tablist" aria-label="音色来源">{Object.entries(VOICE_SOURCE_LABEL).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={source === id} className={source === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
     {source === 'system' && <SystemPicker request={request} role={role} configured={configured} writable={writable} onPick={voice => update({ speaker: voice.voiceType, source: 'system', resourceId: 'seed-tts-2.0' })} />}
     {source === 'custom' && <div className="vr-custom">
      <label>自有音色编号（speaker_id）<DraftText aria-label="自有音色编号" value={role.source === 'custom' ? role.speaker : ''} maxLength={100} disabled={!writable} placeholder="声音复刻得到的 speaker_id" onCommit={speaker => update({ speaker: speaker.trim(), source: 'custom' })} /></label>
      <label>资源 ID<select aria-label="资源 ID" value={role.resourceId} disabled={!writable} onChange={e => update({ resourceId: e.target.value })}><option value="seed-tts-2.0">seed-tts-2.0（系统 2.0 音色）</option><option value="seed-icl-2.0">seed-icl-2.0（复刻与设计音色）</option></select></label>
     </div>}
     {source === 'designed' && <DesignPanel request={request} owner={owner} onAssets={onAssets} role={role} configured={configured} writable={writable} onUse={result => { update({ speaker: result.speakerId, source: 'designed', resourceId: 'seed-icl-2.0' }); setTab(null); }} />}
     <fieldset className="vr-params"><legend>默认语速、音量与情感</legend>
      <label>语速 {role.speechRate}<input type="range" aria-label="语速" min="-50" max="100" step="5" value={role.speechRate} disabled={!writable} onChange={e => update({ speechRate: Number(e.target.value) })} /></label>
      <label>音量 {role.loudnessRate}<input type="range" aria-label="音量" min="-50" max="100" step="5" value={role.loudnessRate} disabled={!writable} onChange={e => update({ loudnessRate: Number(e.target.value) })} /></label>
      <label>情感（英文标识，可空）<DraftText aria-label="情感" value={role.emotion} maxLength={32} disabled={!writable} placeholder="例如 happy" onCommit={emotion => update({ emotion: emotion.trim().toLowerCase() })} /></label>
      <label>情感强度 {role.emotionScale}<input type="range" aria-label="情感强度" min="1" max="5" step="1" value={role.emotionScale} disabled={!writable || !role.emotion} onChange={e => update({ emotionScale: Number(e.target.value) })} /></label>
      <label>语气提示（不超过 200 字）<DraftText aria-label="语气提示" value={role.contextText} maxLength={200} disabled={!writable} placeholder="例如：用轻快热情的语气" onCommit={contextText => update({ contextText })} /></label>
     </fieldset>
     <div className="vr-try"><label>试听文本（留空用默认，不超过 {MAX_PREVIEW_TEXT} 字）<DraftText aria-label="试听文本" value={auditionText} maxLength={MAX_PREVIEW_TEXT} placeholder={DEFAULT_PREVIEW_TEXT} onCommit={setAuditionText} /></label>
      <Audition request={request} speaker={role.speaker} resourceId={role.resourceId} params={params} text={auditionText.trim()} label="用当前设置试听" disabled={!configured || !writable} /></div>
    </>}
   </section>
  </div>
  {error && <p className="vr-error" role="alert">{error}</p>}
  <footer><button type="button" className="v3-btn" onClick={() => { if (!dirty || window.confirm('角色改动尚未保存，确定关闭？')) onClose(); }}>取消</button><button type="button" className="v3-btn primary" disabled={!writable || busy || !dirty} onClick={save}>{busy ? '保存中…' : '保存角色'}</button></footer>
 </div></div>;
}

// 视频预览：有配音版本时可在「原声 / 配音」之间切换，默认显示配音版。
export function DubbedVideo({ original, dub, truncated, className = '', muted = false, label = '' }) {
 const [which, setWhich] = useState('dub');
 const showDub = Boolean(dub) && which === 'dub';
 return <div className="vr-dubbed">
  <video className={className} src={fileUrl(showDub ? dub : original)} muted={muted && !showDub} controls preload="metadata" aria-label={label || undefined} />
  {dub && <div className="vr-switch" role="group" aria-label="视频声音版本">
   <button type="button" aria-pressed={which === 'original'} className={which === 'original' ? 'on' : ''} onClick={() => setWhich('original')}>原声</button>
   <button type="button" aria-pressed={which === 'dub'} className={which === 'dub' ? 'on' : ''} onClick={() => setWhich('dub')}>配音</button>
  </div>}
  {showDub && truncated && <small className="vn-warn">配音比视频长，已截断到视频长度。</small>}
 </div>;
}
