import { useEffect, useRef, useState } from 'react';
import { canAdmin, canWrite } from '../lib/auth.js';
import { Pager } from './ui.jsx';
import DraftText from './DraftText.jsx';
import { usePage, useDebounced } from '../lib/use-paged.js';
import '../styles/creation-products.css';
const base='/api/creation';
const kinds={product:'商品',project:'项目',asset:'素材'};
export const TRASH_PAGE_SIZE=20;
const cacheOwner=backend=>backend?.session?.user?.id||backend?.session?.user?.email||'local';
export default function CreationTrash({backend,notify,onOpenProject}) {
 const [preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[kind,setKind]=useState(''),[input,setInput]=useState(''),[offset,setOffset]=useState(0);
 const api=backend.apiCall,write=canWrite(backend.session),admin=canAdmin(backend.session),close=useRef(null),query=useDebounced(input,300);
 // 回收站服务端分页（每页 20，按移入时间倒序），类型与名称筛选也在服务端完成。
 const list=usePage({request:api,owner:cacheOwner(backend),path:`${base}/trash`,params:{kind,q:query},size:TRASH_PAGE_SIZE,offset,setOffset});
 const items=list.items,loading=list.loading&&!items.length;
 const load=async()=>{list.reload();};
 useEffect(()=>{if(preview)close.current?.focus();},[preview]);
 const run=async fn=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);setPreview(null);await load().catch(()=>{});}finally{setBusy(false);}};
 const restore=item=>run(async()=>{await api(`${base}/trash/${item.id}/restore`,{revision:item.revision});await load();notify?.('已恢复');});
 const inspect=item=>run(async()=>{const result=await api(`${base}/trash/${item.id}/preview`);setPreview(result);setConfirmed(false);});
 const destroy=()=>run(async()=>{await api(`${base}/trash/${preview.id}?${new URLSearchParams({revision:String(preview.revision),token:preview.token})}`,undefined,'DELETE');setPreview(null);await load();notify?.('已永久删除');});
 return <section className="cp-surface creation-trash"><header className="cp-heading"><div><h1>回收站</h1><span>手动恢复或永久删除，不自动清理</span></div></header>{(error||list.error)&&<div role="alert" className="cp-error">{error||list.error}</div>}<div className="cp-toolbar"><DraftText type="search" aria-label="搜索回收站" placeholder="搜索名称" value={input} onCommit={v=>{setInput(v);setOffset(0);}}/><select aria-label="回收站类型" value={kind} onChange={e=>{setKind(e.target.value);setOffset(0);}}><option value="">全部类型</option>{Object.entries(kinds).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><span className="cp-type">{list.total} 项</span></div>{loading?<p role="status">正在加载…</p>:<><table className="cp-data-table"><thead><tr><th>名称</th><th>类型</th><th>移入时间</th><th>操作</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td><strong>{item.name}</strong>{item.deletionPending&&<small> · 文件清理待重试</small>}</td><td>{kinds[item.kind]}</td><td>{new Date(item.trashedAt).toLocaleString()}</td><td><div className="cp-actions">{write&&<button disabled={busy||item.deletionPending} onClick={()=>restore(item)}>恢复</button>}{admin&&<button disabled={busy} onClick={()=>inspect(item)}>预览永久删除</button>}</div></td></tr>)}</tbody></table>{!items.length&&<p className="cp-empty">{kind||query?'没有匹配的项目':'回收站为空'}</p>}<Pager total={list.total} offset={offset} size={TRASH_PAGE_SIZE} disabled={list.loading} onChange={setOffset} label="回收站分页"/></>}
 {preview&&<div className="cp-modal-backdrop"><section role="dialog" aria-modal="true" aria-label="永久删除预览" className="cp-modal"><header><h2>永久删除「{preview.name}」</h2><button ref={close} disabled={busy} aria-label="关闭删除预览" onClick={()=>setPreview(null)}>×</button></header><p>将删除此{kinds[preview.kind]}及 {preview.assets.length} 个归属文件、{preview.runCount} 条生成记录。</p>{preview.running&&<p className="cp-error">仍有运行中或未知任务，请先核实终态。</p>}{preview.projects.length>0&&<><p className="cp-error">以下项目仍在引用，请先解除引用。</p><ul>{preview.projects.map(p=><li key={p.id}><button onClick={()=>onOpenProject?.(p.id)}>{p.name}{p.trashedAt?'（回收站）':''}</button></li>)}</ul></>}{preview.assets.length>0&&<ul>{preview.assets.map(a=><li key={a.id}>{a.name}</li>)}</ul>}{!preview.blocked&&<label><span><input style={{width:'auto'}} type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 我确认永久删除，文件无法恢复</span></label>}<div className="cp-actions"><button disabled={busy} onClick={()=>setPreview(null)}>取消</button><button className="cp-primary" disabled={busy||preview.blocked||!confirmed} onClick={destroy}>{busy?'正在清理…':'确认永久删除'}</button></div></section></div>}
 </section>;
}
