import { useState } from 'react';
import { MEDIA_RULES, validateMediaFile } from '../lib/video-node.js';
import { AssetFeed } from './AssetPicker.jsx';

const fileUrl = id => `/api/creation/assets/${id}/file`;

// 音频输入 / 视频输入节点：从素材库选择或上传，音频可试听，视频可预览。
export default function MediaInputEditor({ task, editor, locked, change, upload }) {
 const rule = MEDIA_RULES[task.kind], prefix = task.kind === 'audio' ? 'audio/' : 'video/';
 const [picker, setPicker] = useState(false), [problem, setProblem] = useState('');

 const current = editor.assets.find(a => a.id === task.sourceAssetId);
 const choose = event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const checked = validateMediaFile(task.kind, file);
  if (checked.error) { event.target.value = ''; setProblem(checked.error); return; }
  setProblem('');
  // 浏览器给出的类型可能为空或不准确：按扩展名补全后再上传。
  upload(event, task.id, new File([file], file.name, { type: checked.mime }));
 };
 return <>
  <div className="canvas-reference vn-media">
   {task.sourceAssetId ? <>
    {task.kind === 'audio' ? <audio src={fileUrl(task.sourceAssetId)} controls preload="metadata" aria-label="试听音频" /> : <video src={fileUrl(task.sourceAssetId)} controls preload="metadata" aria-label="预览视频" />}
    <button aria-label={`移除${rule.label}`} disabled={locked} onClick={() => change({ sourceAssetId: null, sourceRunId: null })}>×</button>
   </> : <span>{task.kind === 'audio' ? '添加音频素材' : '添加视频素材'}</span>}
  </div>
  {current && <small className="vn-note" title={current.name}>{current.name}</small>}
  <div className="canvas-node-actions">
   <button className="v3-btn" disabled={locked} onClick={() => setPicker(!picker)}>＋ {task.sourceAssetId ? `更换${rule.label}` : `从素材库选择`}</button>
   <label className="v3-file">上传<input aria-label={`上传${rule.label}`} type="file" accept={rule.accept} disabled={locked} onChange={choose} /></label>
  </div>
  <small className="vn-note">{rule.hint}</small>
  {problem && <p className="vn-problem" role="alert">{problem}</p>}
  {picker && <div className="canvas-asset-picker vn-library">
   <AssetFeed request={editor.request} owner={editor.owner} params={{ role: 'creative,result', type: prefix.slice(0, -1) }} onLoaded={editor.rememberAssets} searchLabel={`搜索${rule.label}素材`} empty={<p className="v3-note">素材库里还没有{rule.label}素材，可以直接上传。</p>}>
    {items => <ul>{items.map(a => <li key={a.id}><button type="button" disabled={locked} aria-label={`选择${rule.label} ${a.name}`} onClick={() => { editor.rememberAssets([a]); change({ sourceAssetId: a.id, sourceRunId: null }); setPicker(false); }}><span aria-hidden="true">{task.kind === 'audio' ? '♪' : '▶'}</span><span>{a.name}</span></button></li>)}</ul>}
   </AssetFeed>
  </div>}
 </>;
}
