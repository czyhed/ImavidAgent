import { useCallback, useEffect, useState } from 'react';
import { canWrite } from '../lib/auth.js';
import CreationProjectCanvas, { creationRequest } from './CreationProjectCanvas.jsx';
import { ConfirmDialog } from './ui.jsx';
import '../styles/creation-projects.css';

// 列表缓存（stale-while-revalidate）：返回列表页先显示上次数据，后台刷新；按登录用户隔离。
let listCache={owner:null,projects:null};
const cacheOwner=backend=>backend?.session?.user?.id||backend?.session?.user?.email||'local';

export default function CreationProjects({ backend, notify, projectId, productId, initialTemplate, routeView, onOpenProject, onOpenProduct, onBack, onWorkflowEditingChange }) {
 const [opened,setOpened]=useState(projectId||null);
 const [projects,setProjects]=useState(()=>listCache.owner===cacheOwner(backend)&&listCache.projects||[]),[products,setProducts]=useState([]);
 const [query,setQuery]=useState(''),[loading,setLoading]=useState(()=>!(listCache.owner===cacheOwner(backend)&&listCache.projects)),[error,setError]=useState('');
 const [creating,setCreating]=useState(false),[createOpen,setCreateOpen]=useState(Boolean(productId||initialTemplate));
 const [name,setName]=useState(''),[product,setProduct]=useState(productId||'');
 const [templates,setTemplates]=useState([]),[templateId,setTemplateId]=useState(initialTemplate?.id||'');
 const [confirmTrash,setConfirmTrash]=useState(null);
 const writable=canWrite(backend?.session);
 const load=useCallback(async()=>{
  if(!(listCache.owner===cacheOwner(backend)&&listCache.projects))setLoading(true);setError('');
  try {const data=await creationRequest(backend,'/api/creation/projects');const next=data.projects||[];listCache={owner:cacheOwner(backend),projects:next};setProjects(next);}
  catch(e){setError(e.message);}finally{setLoading(false);}
 },[backend?.csrf,backend?.session]);
 useEffect(()=>{setOpened(projectId||null);},[projectId]);
 useEffect(()=>{if(productId){setProduct(productId);setCreateOpen(true);}},[productId]);
 useEffect(()=>{if(initialTemplate){setCreateOpen(true);setTemplateId(initialTemplate.id);}},[initialTemplate?.id]);
 useEffect(()=>{if(createOpen)creationRequest(backend,'/api/creation/templates').then(data=>setTemplates(data.items||data.templates||[])).catch(e=>setError(e.message));},[createOpen,backend?.csrf]);
 useEffect(()=>{if(!opened)load();},[opened,load]);
 useEffect(()=>{if(createOpen)creationRequest(backend,'/api/creation/products').then(data=>setProducts(data.items||data.products||data.records||[])).catch(e=>setError(e.message));},[createOpen,backend?.csrf]);
 const open=id=>{setOpened(id);onOpenProject?.(id);};
 async function create(event) {
  event.preventDefault();if(creating)return;setCreating(true);setError('');
  try {
   const data=await creationRequest(backend,'/api/creation/projects',{name:name.trim()||undefined,productId:product||undefined,template:templateId?{id:templateId}:undefined,graphVersion:4});
   setCreateOpen(false);setName('');open(data.project.id);notify?.('项目已创建');
  }catch(e){setError(e.message);}finally{setCreating(false);}
 }
 async function trashProject(project) {
  setCreating(true);setError('');
  try{await creationRequest(backend,'/api/creation/trash/'+project.id,{revision:project.revision});await load();notify?.('项目已移入回收站');}
  catch(e){setError(e.message);}finally{setCreating(false);setConfirmTrash(null);}
 }
 if(opened)return <CreationProjectCanvas key={opened} backend={backend} notify={notify} projectId={opened} view={routeView==='video'?'video':'canvas'} onSwitchView={nextView=>onOpenProject?.(opened,{view:nextView})} onOpenProduct={onOpenProduct} onWorkflowEditingChange={onWorkflowEditingChange} onBack={()=>{setOpened(null);onBack?.();}}/>;
 const visible=projects.filter(p=>`${p.name} ${p.productSnapshot?.name||''}`.toLowerCase().includes(query.toLowerCase()));
 const fmt=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const initial=n=>Array.from(String(n||'').trim())[0]||'项';
 return <section className="cp-projects">
  <header className="cp-heading"><div><h1>项目</h1><p>{projects.length} 个创作项目</p></div><button className="cp-primary" disabled={!writable} onClick={()=>setCreateOpen(true)}>新建项目</button></header>
  <div className="cp-list-tools"><label className="cp-search"><svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3.5 3.5"/></svg><input aria-label="搜索项目" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索项目或商品"/></label><button className="cp-refresh" onClick={load} disabled={loading} title="刷新项目">刷新</button></div>
  {error&&<div className="cp-error" role="alert">{error}<button onClick={load}>重新加载</button></div>}
  {loading?<p className="cp-empty" role="status">正在加载项目...</p>:!visible.length?<div className="cp-empty"><span className="cp-empty-mark" aria-hidden="true">▦</span><h2>{query?'没有匹配的项目':'还没有创作项目'}</h2><p>{query?'换个关键词试试':'新建一个项目，开始安排创作任务'}</p><button disabled={!writable} onClick={()=>setCreateOpen(true)}>新建项目</button></div>:<ul className="cp-project-list">
   {visible.map(p=><li className="cp-project-row" key={p.id}>
    <div className="cp-project-cover">{p.coverAssetId?<img src={`/api/creation/assets/${p.coverAssetId}/file`} loading="lazy" alt=""/>:<span className="cp-cover-initial" aria-hidden="true">{initial(p.name)}</span>}</div>
    <div className="cp-project-label"><h3 title={p.name}>{p.name}</h3><span className="cp-project-product">{p.productSnapshot?.name||'概念创作'}</span><span className="cp-project-meta">{p.taskCount||0} 个创作任务 · 更新于 <time dateTime={p.updatedAt}>{fmt(p.updatedAt)}</time></span></div>
    <div className="cp-actions"><button className="cp-open" onClick={()=>open(p.id)}>打开画布</button>{writable&&<button className="cp-trash" disabled={creating} onClick={()=>setConfirmTrash(p)}>移入回收站</button>}</div>
   </li>)}
  </ul>}
  {createOpen&&<div className="cp-overlay"><form className="cp-dialog b-drawer" role="dialog" aria-modal="true" aria-label="新建项目" onSubmit={create}><header><h2>新建项目</h2><button type="button" title="关闭" aria-label="关闭" onClick={()=>setCreateOpen(false)}>×</button></header><label>项目名称<input autoFocus value={name} maxLength={200} onChange={e=>setName(e.target.value)} placeholder="可留空，使用商品名称"/></label><label>商品<select aria-label="商品" value={product} onChange={e=>setProduct(e.target.value)}><option value="">概念创作</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>提示词模板（可选）<select value={templateId} onChange={e=>setTemplateId(e.target.value)}><option value="">从空白流程开始</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><p className="b-info">创建后进入画布，可安排任务并自由编辑流程。</p>{error&&<p role="alert" className="cp-error">{error}</p>}<footer><button type="button" onClick={()=>setCreateOpen(false)}>取消</button><button className="cp-primary" disabled={creating||!writable}>{creating?'正在创建...':'创建项目'}</button></footer></form></div>}
  <ConfirmDialog open={Boolean(confirmTrash)} title="移入回收站" message={`将项目「${confirmTrash?.name||''}」移入回收站？回收站内容不会自动清理，可随时恢复。`} confirmText="移入回收站" busy={creating} onCancel={()=>setConfirmTrash(null)} onConfirm={()=>trashProject(confirmTrash)}/>
 </section>;
}
