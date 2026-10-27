import { useCallback, useEffect, useState } from 'react';
import { canWrite } from '../lib/auth.js';
import CreationProjectCanvas, { creationRequest } from './CreationProjectCanvas.jsx';
import { ConfirmDialog, Pager } from './ui.jsx';
import { FeedSelect } from './AssetPicker.jsx';
import DraftText from './DraftText.jsx';
import { usePage, useDebounced } from '../lib/use-paged.js';
import '../styles/creation-projects.css';

// 列表按「查询 + 页码」缓存（stale-while-revalidate，见 use-paged.js）：返回列表页先显示上次数据，后台刷新；按登录用户隔离。
const cacheOwner=backend=>backend?.session?.user?.id||backend?.session?.user?.email||'local';
export const PROJECT_PAGE_SIZE=20,PICKER_SIZE=30;

export default function CreationProjects({ backend, notify, projectId, productId, initialTemplate, routeView, onOpenProject, onOpenProduct, onBack, onWorkflowEditingChange }) {
 const [opened,setOpened]=useState(projectId||null);
 const [input,setInput]=useState(''),[offset,setOffset]=useState(0),[error,setError]=useState('');
 const query=useDebounced(input,300);
 const request=useCallback(path=>creationRequest(backend,path),[backend?.csrf,backend?.session]);
 const list=usePage({request,owner:cacheOwner(backend),path:'/api/creation/projects',key:'projects',params:{q:query},size:PROJECT_PAGE_SIZE,offset,setOffset,enabled:!opened});
 const projects=list.items,loading=list.loading;
 const [creating,setCreating]=useState(false),[createOpen,setCreateOpen]=useState(Boolean(productId||initialTemplate));
 const [name,setName]=useState(''),[product,setProduct]=useState(productId||'');
 const [templateId,setTemplateId]=useState(initialTemplate?.id||'');
 const [confirmTrash,setConfirmTrash]=useState(null);
 const writable=canWrite(backend?.session);
 const load=list.reload;
 useEffect(()=>{setOpened(projectId||null);},[projectId]);
 useEffect(()=>{if(productId){setProduct(productId);setCreateOpen(true);}},[productId]);
 useEffect(()=>{if(initialTemplate){setCreateOpen(true);setTemplateId(initialTemplate.id);}},[initialTemplate?.id]);
 useEffect(()=>{setOffset(0);},[query]);
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
 const visible=projects,total=list.total;
 const fmt=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const initial=n=>Array.from(String(n||'').trim())[0]||'项';
 return <section className="cp-projects">
  <header className="cp-heading"><div><h1>项目</h1><p>{query?`${total} 个匹配项目`:`${total} 个创作项目`}</p></div><button className="cp-primary" disabled={!writable} onClick={()=>setCreateOpen(true)}>新建项目</button></header>
  <div className="cp-list-tools"><label className="cp-search"><svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3.5 3.5"/></svg><DraftText aria-label="搜索项目" type="search" value={input} onCommit={setInput} placeholder="搜索项目或商品"/></label><button className="cp-refresh" onClick={load} disabled={loading} title="刷新项目">刷新</button></div>
  {(error||list.error)&&<div className="cp-error" role="alert">{error||list.error}<button onClick={()=>{setError('');load();}}>重新加载</button></div>}
  {loading?<p className="cp-empty" role="status">正在加载项目...</p>:!visible.length?<div className="cp-empty"><span className="cp-empty-mark" aria-hidden="true">▦</span><h2>{query?'没有匹配的项目':'还没有创作项目'}</h2><p>{query?'换个关键词试试':'新建一个项目，开始安排创作任务'}</p><button disabled={!writable} onClick={()=>setCreateOpen(true)}>新建项目</button></div>:<ul className="cp-project-list">
   {visible.map(p=><li className="cp-project-row" key={p.id}>
    <div className="cp-project-cover">{p.coverAssetId?<img src={`/api/creation/assets/${p.coverAssetId}/file`} loading="lazy" alt=""/>:<span className="cp-cover-initial" aria-hidden="true">{initial(p.name)}</span>}</div>
    <div className="cp-project-label"><h3 title={p.name}>{p.name}</h3><span className="cp-project-product">{p.productSnapshot?.name||'概念创作'}</span><span className="cp-project-meta">{p.taskCount||0} 个创作任务 · 更新于 <time dateTime={p.updatedAt}>{fmt(p.updatedAt)}</time></span></div>
    <div className="cp-actions"><button className="cp-open" onClick={()=>open(p.id)}>打开画布</button>{writable&&<button className="cp-trash" disabled={creating} onClick={()=>setConfirmTrash(p)}>移入回收站</button>}</div>
   </li>)}
  </ul>}
  <Pager total={total} offset={offset} size={PROJECT_PAGE_SIZE} disabled={loading} onChange={setOffset} label="项目分页"/>
  {createOpen&&<div className="cp-overlay"><form className="cp-dialog b-drawer" role="dialog" aria-modal="true" aria-label="新建项目" onSubmit={create}><header><h2>新建项目</h2><button type="button" title="关闭" aria-label="关闭" onClick={()=>setCreateOpen(false)}>×</button></header><label>项目名称<input autoFocus value={name} maxLength={200} onChange={e=>setName(e.target.value)} placeholder="可留空，使用商品名称"/></label><div className="cp-field"><span>商品</span><FeedSelect request={request} owner={cacheOwner(backend)} path="/api/creation/products" label="商品" searchLabel="搜索商品" emptyLabel="概念创作" value={product} onChange={setProduct} pinned={product&&{id:product}} resolvePath={id=>'/api/creation/products/'+id}/></div><div className="cp-field"><span>提示词模板（可选）</span><FeedSelect request={request} owner={cacheOwner(backend)} path="/api/creation/templates" label="提示词模板" searchLabel="搜索模板" emptyLabel="从空白流程开始" value={templateId} onChange={setTemplateId} pinned={initialTemplate&&templateId===initialTemplate.id?initialTemplate:null}/></div><p className="b-info">创建后进入画布，可安排任务并自由编辑流程。</p>{error&&<p role="alert" className="cp-error">{error}</p>}<footer><button type="button" onClick={()=>setCreateOpen(false)}>取消</button><button className="cp-primary" disabled={creating||!writable}>{creating?'正在创建...':'创建项目'}</button></footer></form></div>}
  <ConfirmDialog open={Boolean(confirmTrash)} title="移入回收站" message={`将项目「${confirmTrash?.name||''}」移入回收站？回收站内容不会自动清理，可随时恢复。`} confirmText="移入回收站" busy={creating} onCancel={()=>setConfirmTrash(null)} onConfirm={()=>trashProject(confirmTrash)}/>
 </section>;
}
