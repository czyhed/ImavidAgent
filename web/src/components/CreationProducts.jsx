import { useEffect, useRef, useState } from 'react';
import { LoadMore } from './ui.jsx';
import DraftText from './DraftText.jsx';
import { useDebounced, useFeed } from '../lib/use-paged.js';
import { canWrite } from '../lib/auth.js';
import '../styles/creation-products.css';

const base='/api/creation';
async function upload(backend,file,role,productId) {
 const query=new URLSearchParams({name:file.name,mime:file.type,role,...(productId?{productId}:{})});
 const response=await fetch(`${base}/assets/upload?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':backend.csrf},body:file});
 const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'上传失败。');return result.asset;
}

// 资料完整度卡片：名称取商品名称，其余按 product.facts 的字段名匹配。
const factChecks=[
 {label:'价格',pattern:/价格|售价|单价|price/i},
 {label:'尺寸',pattern:/尺寸|规格|容量|大小|长|宽|高|size|dimension/i},
 {label:'材质',pattern:/材质|材料|material/i},
 {label:'卖点',pattern:/卖点|亮点|优势|feature|selling/i},
 {label:'场景',pattern:/场景|用途|适用|scene|occasion/i}
];
function checkFact(facts,pattern) {
 for (const [field,value] of Object.entries(facts||{})) {
  if (pattern.test(field)) return {done:true,value:String(value??'').trim()};
 }
 return {done:false,value:''};
}
const examples=[
 {label:'贴 1688 链接',hint:'粘贴链接后继续补充细节',text:'请帮我整理这个 1688 商品链接里的资料：'},
 {label:'上传截图',hint:'最多 8 张，识别后自动整理',text:'我会上传商品截图，请帮我识别并整理商品资料。'},
 {label:'手动描述',hint:'名称、价格、尺寸、材质…',text:'商品名称：\n价格：\n尺寸：\n材质：\n卖点：\n适用场景：'}
];

// 商品列表每次加载 30 条（侧栏「加载更多」），服务端搜索；缓存（stale-while-revalidate）由 use-paged.js 按登录用户 + 查询隔离。
export const PRODUCT_PAGE_SIZE=30;
const cacheOwner=backend=>backend?.session?.user?.id||backend?.session?.user?.email||'local';

export default function CreationProducts({backend,notify,onCreateProject,onOpenProduct,onSelectionChange,onWorkflowEditingChange,productId}) {
 const [product,setProduct]=useState(null),[selected,setSelected]=useState(productId||null),[input,setInput]=useState(''),[text,setText]=useState(''),[attachments,setAttachments]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(Boolean(productId)),[name,setName]=useState(''),[fields,setFields]=useState([]),[assets,setAssets]=useState({}),[tab,setTab]=useState('chat'),[dirty,setDirty]=useState(false),[listOpen,setListOpen]=useState(false);
 const key=useRef(null),epoch=useRef(0),threadRef=useRef(null),composerRef=useRef(null),write=canWrite(backend.session);
 const callbacks=useRef({onSelectionChange,onWorkflowEditingChange});callbacks.current={onSelectionChange,onWorkflowEditingChange};
 useEffect(()=>{callbacks.current.onSelectionChange?.(selected);},[selected]);
 useEffect(()=>{callbacks.current.onWorkflowEditingChange?.(Boolean(dirty||text||attachments.length||busy));},[dirty,text,attachments.length,busy]);
 useEffect(()=>()=>{callbacks.current.onWorkflowEditingChange?.(false);},[]);
 const api=backend.apiCall,query=useDebounced(input,300);
 const feed=useFeed({request:api,owner:cacheOwner(backend),path:`${base}/products`,params:{q:query},size:PRODUCT_PAGE_SIZE}),items=feed.items;
 const showError=e=>{setError(e.message);notify?.(e.message);};
 const acceptProduct=p=>{setProduct(p);setSelected(p.id);setName(p.name);setFields(Object.entries(p.facts||{}).map(([field,value])=>({field,value})));setDirty(false);feed.mutate(old=>[p,...old.filter(x=>x.id!==p.id)]);};
 useEffect(()=>{if(productId)setSelected(productId);},[productId]);
 useEffect(()=>{
  const ticket=++epoch.current;if(!selected){setProduct(null);setName('');setFields([]);setAssets({});return;}
  setLoading(true);api(`${base}/products/${selected}`).then(async r=>{
   if(ticket!==epoch.current)return;acceptProduct(r.product);
   const ids=[...new Set([...(r.product.evidenceIds||[]),...(r.product.creativeAssetIds||[])])];
   const entries=await Promise.all(ids.map(id=>api(`${base}/assets/${id}`).then(x=>[id,x.asset]).catch(()=>[id,null])));
   if(ticket===epoch.current)setAssets(Object.fromEntries(entries));
  }).catch(e=>{if(ticket===epoch.current)showError(e);}).finally(()=>{if(ticket===epoch.current)setLoading(false);});
 },[selected,api]);
 useEffect(()=>{if(!dirty&&!text&&!attachments.length)return;const prevent=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent);},[dirty,text,attachments.length]);
 // 输入框随内容自动增高，发送后回落到单行高度。
 useEffect(()=>{const el=composerRef.current;if(!el)return;el.style.height='auto';el.style.height=`${Math.min(Math.max(el.scrollHeight,44),200)}px`;},[text,attachments.length]);
 // 新消息或识别状态变化后滚动到底部。
 useEffect(()=>{const el=threadRef.current;if(el)el.scrollTop=el.scrollHeight;},[product?.messages?.length,busy,tab]);
 const navigate=id=>{if(busy)return;if((dirty||text||attachments.length)&&!window.confirm('当前输入尚未保存，仍要切换商品吗？'))return;setText('');setAttachments([]);setDirty(false);key.current=null;setListOpen(false);if(!id)setTab('chat');setSelected(id);if(id)onOpenProduct?.(id);};
 const run=async fn=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){showError(e);}finally{setBusy(false);}};
 const send=()=>run(async()=>{
  key.current ||= crypto.randomUUID();
  const payload={text,evidenceIds:attachments.map(a=>a.id),requestKey:key.current,...(product?{revision:product.revision}:{})};
  const result=await api(`${base}/products${product?'/'+product.id:''}/chat`,payload);
  acceptProduct(result.product);setAssets(old=>({...old,...Object.fromEntries(attachments.map(a=>[a.id,a]))}));
  if(result.error){setError(result.error.message);notify?.(result.error.message);}else{setText('');setAttachments([]);key.current=null;}
 });
 const addFiles=(event,role)=>{const files=[...event.target.files];event.target.value='';run(async()=>{
  if(role==='evidence'&&files.length+attachments.length>8)throw new Error('每条消息最多 8 张资料图片。');
  for(const file of files){const asset=await upload(backend,file,role,product?.id);setAssets(old=>({...old,[asset.id]:asset}));if(role==='evidence'){setAttachments(old=>[...old,asset]);key.current=null;}else if(product){const result=await api(`${base}/products/${product.id}/creative-assets`,{revision:(await api(`${base}/products/${product.id}`)).product.revision,assetId:asset.id});acceptProduct(result.product);}}
 });};
 const save=()=>run(async()=>{const facts={};for(const row of fields){if(!row.field.trim())throw new Error('请填写资料字段名称。');if(Object.hasOwn(facts,row.field.trim()))throw new Error('资料字段名称不能重复。');facts[row.field.trim()]=row.value;}const result=await api(`${base}/products/${product.id}`,{name,facts,revision:product.revision},'PATCH');acceptProduct(result.product);notify?.('商品资料已保存');});
 const suggestion=(entry,accept)=>run(async()=>acceptProduct((await api(`${base}/products/${product.id}/suggestions/${entry.id}`,{revision:product.revision,accept})).product));
 const promote=assetId=>run(async()=>{acceptProduct((await api(`${base}/products/${product.id}/promote`,{revision:product.revision,assetId})).product);setAssets(old=>({...old,[assetId]:{...old[assetId],role:'creative'}}));});
 const trash=()=>run(async()=>{await api(`${base}/trash/${product.id}`,{revision:product.revision});setSelected(null);setProduct(null);setListOpen(false);feed.mutate(old=>old.filter(x=>x.id!==product.id));notify?.('商品已移入回收站');});
 const interrupted=(product?.messages||[]).find(m=>m.status==='pending'&&Date.now()-new Date(m.createdAt).getTime()>=180000);
 const messages=product?.messages||[];
 const facts=product?.facts||{};
 const checks=[{label:'名称',done:Boolean(product?.name),value:product?.name||''},...factChecks.map(c=>({label:c.label,...checkFact(facts,c.pattern)}))];
 const doneCount=checks.filter(c=>c.done).length,pct=Math.round(doneCount/checks.length*100);
 const canStart=Boolean(product?.name&&!product.trashedAt);
 const canSend=Boolean(text.trim()||attachments.length);
 const fillExample=value=>{setText(value);key.current=null;composerRef.current?.focus();};
 const sendKey=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!busy&&canSend)send();}};
 const image=(id,creative=false)=><figure className="cp-media" key={id}>{assets[id]?.mime?.startsWith('video/')?<video src={`${base}/assets/${id}/file`} controls/>:<img src={`${base}/assets/${id}/file`} alt={assets[id]?.name||'商品资料'} loading="lazy"/>}<figcaption>{assets[id]?.name||'商品图片'}</figcaption>{!creative&&write&&!(product?.creativeAssetIds||[]).includes(id)&&<button disabled={busy} onClick={()=>promote(id)}>加入商品素材</button>}</figure>;
 return <section className="creation-products cp-surface">
  <header className="cp-heading"><div><h1>商品</h1><span>{feed.total} 件{query?'匹配':''}商品 · 边聊边整理资料</span></div>{write&&<button className="cp-primary cp-new" onClick={()=>navigate(null)} disabled={busy}>新商品</button>}</header>
  {error&&<div role="alert" className="cp-error">{error}</div>}
  {interrupted&&write&&<div className="cp-error">资料识别长时间未完成。<button disabled={busy} onClick={()=>run(async()=>acceptProduct((await api(`${base}/products/${product.id}/messages/${interrupted.id}/end-recognition`,{revision:product.revision})).product))}>结束本次识别并保留资料</button></div>}
  <div className="cp-workspace">
   <aside className={`cp-list${listOpen?' is-open':''}`}>
    <button type="button" className="cp-list-toggle" aria-label="切换商品列表" aria-expanded={listOpen} onClick={()=>setListOpen(open=>!open)}><span className="cp-list-toggle-label">商品</span><strong>{product?.name||'选择或新建商品'}</strong><span className="cp-list-caret" aria-hidden>▾</span></button>
    <div className="cp-list-body">
     <DraftText aria-label="搜索商品" type="search" placeholder="搜索商品" value={input} onCommit={setInput}/>
     {write&&<button className="cp-primary b-new-product" onClick={()=>navigate(null)} disabled={busy}>＋ 新建商品</button>}<div className="cp-product-list">{items.map(p=><button key={p.id} aria-pressed={selected===p.id} onClick={()=>navigate(p.id)}><span className="b-product-thumb">{p.creativeAssetIds?.[0]?<img src={`${base}/assets/${p.creativeAssetIds[0]}/file`} alt=""/>:<span aria-hidden>◇</span>}</span><strong>{p.name}</strong><small>{p.factCount??Object.keys(p.facts||{}).length} 项资料 · {new Date(p.updatedAt).toLocaleDateString()}</small></button>)}{feed.error&&<p className="cp-empty" role="alert">{feed.error}</p>}{!feed.loading&&!feed.error&&!items.length&&<p className="cp-empty">{query?'没有匹配的商品':'暂无商品'}</p>}<LoadMore shown={items.length} total={feed.total} hasMore={feed.hasMore} loading={feed.loadingMore} onClick={feed.loadMore}/></div>
    </div>
   </aside>
   <div className="cp-detail">
    <header className="cp-detail-head">
     <div className="cp-product-id"><span className="cp-product-avatar" aria-hidden>{product?.creativeAssetIds?.[0]?<img src={`${base}/assets/${product.creativeAssetIds[0]}/file`} alt=""/>:(product?.name||'新').trim().slice(0,1)}</span><div className="cp-product-title"><h2>{product?.name||'新商品'}</h2><p>{product?`${Object.keys(facts).length} 项资料 · 资料完整度 ${pct}%`:'从一条消息开始，建立可创作的商品资料'}</p></div></div>
     {product&&write&&<div className="cp-head-actions"><button type="button" className="cp-primary cp-start" aria-label="创建项目" disabled={!canStart||busy} onClick={()=>onCreateProject?.(product)}>开始创作<span aria-hidden> →</span></button><button type="button" className="cp-ghost" onClick={trash} disabled={busy}>移入回收站</button></div>}
    </header>
    <nav className="cp-tabs" aria-label="商品视图">{[['chat','长期聊天'],['facts','商品资料'],['creative','创作素材']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}{id==='creative'&&product?' '+product.creativeAssetIds.length:''}</button>)}</nav>
    {loading&&selected?<p className="cp-loading" role="status">正在加载商品…</p>:tab==='chat'?<div className="cp-chat-shell">
     <div className="cp-chat">
      <div className="cp-chat-scroll" ref={threadRef} aria-live="polite">
       {!messages.length?<div className="cp-empty-state"><span className="cp-empty-mark" aria-hidden>AI</span><h3>从一句话开始整理商品</h3><p>直接描述商品、贴 1688 链接或上传截图。AI 会边聊边整理名称、参数、材质与卖点，随时可以开始创作。</p><div className="cp-examples">{examples.map(item=><button type="button" className="cp-example" key={item.label} onClick={()=>fillExample(item.text)}><strong>{item.label}</strong><small>{item.hint}</small></button>)}</div></div>:<div className="cp-thread">{messages.map(m=><article key={m.id} className={`cp-message cp-${m.role}`}>{m.role!=='user'&&<span className="cp-bubble-avatar" aria-hidden>AI</span>}<div className="cp-bubble"><div className="cp-message-meta"><span>{m.role==='user'?'你':'资料整理'}</span>{m.status&&<small>{m.status==='failed'?'识别未完成':m.status==='pending'?'正在识别':''}</small>}</div><p>{m.text}</p>{m.evidenceIds?.length>0&&<div className="cp-media-grid">{m.evidenceIds.map(id=>image(id))}</div>}</div></article>)}</div>}
       {busy&&<div className="cp-typing" role="status"><span className="cp-typing-avatar" aria-hidden>AI</span><span className="cp-dots" aria-hidden><i/><i/><i/></span><span className="cp-typing-text">正在识别…</span></div>}
      </div>
      {write&&<form className="cp-composer" onSubmit={e=>{e.preventDefault();if(canSend)send();}}>
       <div className="cp-composer-shell">
        {attachments.length>0&&<div className="cp-attachments">{attachments.map(a=><span className="cp-attachment" key={a.id}>{a.mime?.startsWith('video/')?<span className="cp-attachment-file" aria-hidden>VIDEO</span>:<img src={`${base}/assets/${a.id}/file`} alt="" loading="lazy"/>}<span className="cp-attachment-name">{a.name}</span><button type="button" className="cp-attachment-remove" aria-label={`移除 ${a.name}`} onClick={()=>{setAttachments(old=>old.filter(x=>x.id!==a.id));key.current=null;}} disabled={busy}><span aria-hidden>×</span></button></span>)}</div>}
        <textarea ref={composerRef} aria-label="商品聊天" placeholder="补充名称、参数、材质，或上传商品截图…" rows={1} value={text} onChange={e=>{setText(e.target.value);key.current=null;}} onKeyDown={sendKey} disabled={busy}/>
        <div className="cp-composer-tools">
         <label className="cp-file cp-attach"><span className="cp-attach-icon" aria-hidden>+</span>添加资料图片<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e=>addFiles(e,'evidence')} disabled={busy}/></label>
         <span className="cp-composer-hint">Enter 发送 · Shift + Enter 换行</span>
         <button type="submit" className="cp-primary cp-send" aria-label="发送资料" disabled={busy||!canSend}>{busy?'正在识别…':'发送资料'}</button>
        </div>
       </div>
       <p className="cp-composer-note">每条消息最多 8 张资料图片；资料图片用于识别，加入创作素材后才用于生成。</p>
      </form>}
     </div>
     {product&&<aside className="cp-completeness" aria-label="资料完整度"><div className="cp-completeness-head"><h3>资料完整度</h3><strong>{doneCount}/{checks.length}</strong></div><div className="cp-complete-progress" aria-hidden><span style={{width:`${pct}%`}}/></div><ul>{checks.map(c=><li key={c.label} className={c.done?'is-done':''}><span className="cp-done-mark" aria-hidden>{c.done?'✓':''}</span><span className="cp-check-label">{c.label}</span><em title={c.value||undefined}>{c.done?(c.value||'已填写'):'待补充'}</em></li>)}</ul><p>补齐缺失资料，AI 规划与生图会更准确。</p></aside>}
    </div>:tab==='facts'?<div className="cp-facts">{product?<><section className="cp-card"><header className="cp-card-head"><div><h3>基础资料</h3><p>名称是唯一必填项，其余资料可以边聊边补。</p></div>{write&&<span className="cp-card-badge">{doneCount}/{checks.length} 项</span>}</header><label className="cp-field"><span>商品名称</span><input value={name} onChange={e=>{setName(e.target.value);setDirty(true);}} disabled={!write||busy}/></label><div className="cp-fact-list">{fields.map((row,index)=><div className="cp-fact-row" key={index}><input aria-label={`资料字段 ${index+1}`} value={row.field} onChange={e=>{setFields(old=>old.map((r,i)=>i===index?{...r,field:e.target.value}:r));setDirty(true);}} disabled={!write||busy}/><input aria-label={`资料内容 ${index+1}`} value={row.value} onChange={e=>{setFields(old=>old.map((r,i)=>i===index?{...r,value:e.target.value}:r));setDirty(true);}} disabled={!write||busy}/></div>)}</div>{write&&<div className="cp-actions cp-facts-actions"><button type="button" className="cp-ghost" disabled={busy} onClick={()=>{setFields(old=>[...old,{field:'',value:''}]);setDirty(true);}}>添加字段</button><button type="button" className="cp-primary" disabled={busy||!dirty} onClick={save}>保存资料</button></div>}</section>{product.suggestions?.length>0&&<section className="cp-suggestions"><h3>待确认资料</h3>{product.suggestions.map(s=><article className="cp-suggestion" key={s.id}><div className="cp-suggestion-body"><span className="cp-suggestion-tag">{s.field}</span><p>{s.previous||'未填写'} → {s.value}</p></div>{write&&<div className="cp-actions"><button type="button" className="cp-ghost" onClick={()=>suggestion(s,false)} disabled={busy}>保留原值</button><button type="button" className="cp-primary" onClick={()=>suggestion(s,true)} disabled={busy}>采纳建议</button></div>}</article>)}</section>}</>:<p className="cp-empty">发送首条资料后创建商品</p>}</div>:<div className="cp-creative">{product?<><div className="cp-creative-head"><div><h3>创作素材</h3><p>从聊天里加入或直接上传，供后续生图与项目引用。</p></div>{write&&<label className="cp-file cp-upload"><span className="cp-attach-icon" aria-hidden>+</span>上传创作素材<input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={e=>addFiles(e,'creative')}/></label>}</div>{product.creativeAssetIds.length?<div className="cp-media-grid">{product.creativeAssetIds.map(id=>image(id,true))}</div>:<div className="cp-empty-box">暂无创作素材。上传一张商品图，或把聊天里的资料图加入素材。</div>}</>:<p className="cp-empty">先添加商品资料</p>}</div>}
   </div>
  </div>
 </section>;
}
