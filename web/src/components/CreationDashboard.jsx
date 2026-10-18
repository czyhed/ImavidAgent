import {useCallback,useEffect,useRef,useState} from 'react';
import {Btn} from './ui.jsx';
import '../styles/creation-dashboard-v3.css';
const STATUS={queued:'排队中',submitting:'提交中',running:'生成中',storing:'保存中',succeeded:'已成功',failed:'已失败',unknown:'待核实',cancelled:'已取消',waiting:'待选择输入'};
// 运行中面板只收排队 / 提交 / 生成三态；storing 仍是未完成，但不再显示秒级计时。
const LIVE=['queued','submitting','running'];
const PENDING=['unknown','failed'];
const TONE={queued:'run',submitting:'run',running:'run',storing:'run',succeeded:'ok',failed:'bad',unknown:'warn',cancelling:'warn',cancelled:'idle'};
const LIVE_LIMIT=8,PENDING_LIMIT=6;
export function useOverview(backend,{pollMs=0}={}){
 const [state,set]=useState({loading:true,data:null,error:'',updatedAt:null});
 const alive=useRef(true),busy=useRef(false);
 const load=useCallback(async quiet=>{
  if(busy.current)return;
  busy.current=true;
  if(!quiet)set(s=>({...s,loading:true,error:''}));
  try{
   const data=await backend.apiCall('/api/creation/overview');
   if(alive.current)set({loading:false,data,error:'',updatedAt:Date.now()});
  }catch(e){
   if(alive.current)set(s=>({...s,loading:false,error:e.message}));
  }finally{busy.current=false;}
 },[backend.apiCall]);
 useEffect(()=>{
  alive.current=true;load(true);
  const timer=pollMs?setInterval(()=>{if(document.visibilityState!=='hidden')load(true);},pollMs):null;
  return()=>{alive.current=false;if(timer)clearInterval(timer);};
 },[load,pollMs]);
 return {...state,refresh:()=>load(false)};
}
export function CreationCosts({backend}){
 const {data,error,loading,refresh}=useOverview(backend);
 return <section className="rv-panel"><div className="rv-panel-title"><h2>实际用量与成本</h2><Btn onClick={refresh} disabled={loading}>刷新</Btn></div><p>按供应商返回的实际金额记录；未提供金额时显示「未统计」。</p>{error&&<p role="alert">{error}</p>}
 {data?.costs===null?<p>当前角色不显示费用明细。</p>:<><p>{data?.costs?.totals?.length?data.costs.totals.map(t=><strong key={t.currency} style={{marginRight:20}}>{t.currency} {(t.costMicros/1e6).toFixed(4)}</strong>):'金额未统计'}　{data?.costs?.unknown??'—'} 条费用未统计</p>
 <div className="rv-table-wrap"><table className="rv-table"><thead><tr><th>项目 / 任务</th><th>状态</th><th>用量</th><th>实际金额</th><th>时间</th></tr></thead><tbody>{[...(data?.runs||[]),...(data?.modelUsage||[]).map(r=>({...r,projectName:({product:'商品聊天',planning:'AI 规划',voice:'语音合成','voice-design':'音色设计','deleted-generation':'已删除任务的费用记录'})[r.stage]||'模型调用',taskId:r.modelId||'',status:'recorded'}))].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(r=><tr key={r.id}><td>{r.projectName}<small>{r.taskId}</small></td><td>{STATUS[r.status]||(r.status==='recorded'?'已记录':r.status)}</td><td>{usageLabel(r.usage)}</td><td>{r.costMicros==null?'未统计':`${r.currency||'未提供币种'} ${(r.costMicros/1e6).toFixed(4)}`}</td><td>{date(r.createdAt)}</td></tr>)}</tbody></table></div>{data&&!data.runs.length&&!data.modelUsage?.length&&<p className="rv-empty">暂无生成记录。</p>}</>}
 </section>;
}
function usageLabel(u){if(!u)return'未统计';const values=[(u.total_tokens??u.totalTokens)!=null?`${u.total_tokens??u.totalTokens} tokens`:null,u.total_seconds!=null?`${u.total_seconds} 秒`:null,u.images!=null?`${u.images} 张`:null,u.text_words!=null?`${u.text_words} 字符`:null,u.design_calls!=null?`${u.design_calls} 次设计`:null].filter(Boolean);return values.join(' / ')||'已保存供应商用量';}
function date(v){return v?new Date(v).toLocaleString('zh-CN'):'—';}
const pad=n=>String(n).padStart(2,'0');
function clock(v){const d=new Date(v);return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;}
function shortDate(v){if(!v)return'—';const d=new Date(v);if(Number.isNaN(d.getTime()))return'—';return `${d.getMonth()+1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;}
function elapsed(from,now){const start=from?new Date(from).getTime():NaN;if(!Number.isFinite(start))return '—';const s=Math.max(0,Math.floor((now-start)/1000));if(s<60)return `${s} 秒`;if(s<3600)return `${Math.floor(s/60)} 分 ${pad(s%60)} 秒`;return `${Math.floor(s/3600)} 小时 ${pad(Math.floor((s%3600)/60))} 分`;}
function cost(r){if(r.costMicros==null)return'未统计';const amount=(r.costMicros/1e6).toFixed(4);return r.currency?`${r.currency} ${amount}`:amount;}
function nameOf(r){return r.projectName||'未命名项目';}
function stateClass(status){return TONE[status]||'idle';}
function statusLabel(status){return STATUS[status]||status||'未知';}
function pendingReason(status){return status==='unknown'?'上游未返回明确结果，只能查询原请求，不能直接重试。':'任务执行失败，可打开项目查看原因后重新发起。';}
function Summary({metrics,loading}){
 return <span className="dash-chips" data-dash-summary>{[['running','运行中','run'],['succeeded','成功','ok'],['failed','失败','bad'],['unknown','待核实','warn']].map(([key,label,tone])=><span className="dash-chip" data-tone={tone} key={key}><i className="dash-chip-dot" aria-hidden="true"/><span className="dash-chip-label">{label}</span><strong data-dash-metric={key}>{metrics?.[key]??(loading?'—':'未统计')}</strong></span>)}
 </span>;
}
function LivePanel({runs,loading,now,onOpenProject,onNav}){
 const shown=runs.slice(0,LIVE_LIMIT);
 return <section className="dash-panel dash-panel-run" aria-labelledby="dash-live-title">
  <div className="dash-panel-head"><h2 id="dash-live-title">运行中任务</h2><span className={`dash-count ${runs.length?'is-live':''}`}>{loading&&!shown.length?'读取中':runs.length}</span></div>
  {!shown.length
   ? <div className="dash-empty"><strong>{loading?'正在读取任务…':'当前没有运行中的任务'}</strong>{!loading&&<p>从项目画布开始生成后，这里会显示运行时长与费用。</p>}{!loading&&<Btn small onClick={()=>onNav('projects')}>打开项目</Btn>}</div>
   : <ul className="dash-list">{shown.map(r=><li key={r.id}><button type="button" className="dash-row dash-row-live" onClick={()=>onOpenProject(r.projectId)} title={`打开项目：${nameOf(r)}`}>
     <span className={`dash-dot is-${stateClass(r.status)}`} aria-hidden="true"/>
     <span className="dash-row-main"><b>{nameOf(r)}</b><span className="dash-task-title">{r.taskTitle||'生成任务'}</span><small className="dash-row-meta"><span className={`dash-badge is-${stateClass(r.status)}`}>{statusLabel(r.status)}</span><span className="dash-time">已运行 <span className="dash-num">{elapsed(r.createdAt,now)}</span></span></small></span>
     <span className="dash-cost">{cost(r)}</span>
    </button></li>)}</ul>}
  {runs.length>LIVE_LIMIT&&<p className="dash-more">另有 {runs.length-LIVE_LIMIT} 个运行中任务，打开项目查看。</p>}
 </section>;
}
function PendingPanel({runs,loading,onOpenProject}){
 const shown=runs.slice(0,PENDING_LIMIT);
 return <section className="dash-panel" aria-labelledby="dash-pending-title">
  <div className="dash-panel-head"><h2 id="dash-pending-title">待处理</h2><span className={`dash-count ${runs.length?'is-warn':''}`}>{loading&&!shown.length?'读取中':runs.length}</span></div>
  {!shown.length
   ? <div className="dash-empty"><strong>{loading?'正在读取任务…':'没有待处理任务'}</strong>{!loading&&<p>失败或待核实的任务会集中在这里。</p>}</div>
   : <ul className="dash-list">{shown.map(r=><li key={r.id}><div className="dash-row dash-row-pending">
     <span className={`dash-dot is-${stateClass(r.status)}`} aria-hidden="true"/>
     <div className="dash-row-main"><b>{nameOf(r)}</b><p className="dash-reason">{pendingReason(r.status)}</p><small className="dash-row-meta"><span className={`dash-badge is-${stateClass(r.status)}`}>{statusLabel(r.status)}</span><time>{shortDate(r.createdAt)}</time></small></div>
     <Btn small onClick={()=>onOpenProject(r.projectId)}>打开处理</Btn>
    </div></li>)}</ul>}
  {runs.length>PENDING_LIMIT&&<p className="dash-more">另有 {runs.length-PENDING_LIMIT} 条待处理记录。</p>}
 </section>;
}
function RecentProjects({projects,loading,onOpenProject,onNav}){
 return <section className="dash-panel" aria-labelledby="dash-projects-title" data-recent-projects>
  <div className="dash-panel-head"><h2 id="dash-projects-title">最近项目</h2><Btn small ghost onClick={()=>onNav('projects')}>全部项目</Btn></div>
  {!projects.length
   ? <div className="dash-empty"><strong>{loading?'读取中…':'暂无项目'}</strong>{!loading&&<p>从商品创建项目即可开始。</p>}{!loading&&<Btn small onClick={()=>onNav('products')}>整理商品资料</Btn>}</div>
   : <ul className="dash-list">{projects.map(p=><li key={p.id}><button type="button" className="dash-row dash-project" onClick={()=>onOpenProject(p.id)}>
     <span className="dash-project-cover">{p.coverAssetId?<img src={`/api/creation/assets/${p.coverAssetId}/file`} alt=""/>:<span aria-hidden>▧</span>}</span><span className="dash-row-main"><b>{p.name||'未命名项目'}</b><small>{p.taskCount??0} 个创作任务</small><small className="dash-project-time">{shortDate(p.updatedAt)}</small></span>
     <span className="dash-open">打开画布 →</span>
    </button></li>)}</ul>}
 </section>;
}
export default function CreationDashboard({backend,onNewProject,onNav,onOpenProject}){
 const {data,error,loading,refresh,updatedAt}=useOverview(backend,{pollMs:5000});
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const metrics=data?.metrics,runs=data?.runs||[];
 const live=runs.filter(r=>LIVE.includes(r.status));
 const pending=runs.filter(r=>PENDING.includes(r.status));
 const open=id=>{if(id)onOpenProject?.(id);};
  return <section className="view rv dash-v3" data-creation-dashboard>
  <header className="dash-top">
   <div className="dash-top-main"><h1>工作台</h1><p>运行中的任务、待处理记录与最近项目。</p></div>
   <div className="dash-top-actions"><Summary metrics={metrics} loading={loading}/><span className="dash-stamp" data-dash-updated title="每 5 秒自动刷新">{loading&&data?'刷新中…':updatedAt?`更新于 ${clock(updatedAt)}`:loading?'读取中…':'—'}</span><Btn small ghost onClick={refresh} disabled={loading}>刷新</Btn><Btn small primary onClick={()=>onNewProject()}>＋ 新建项目</Btn></div>
  </header>
  {error&&<div className="dash-alert" role="alert">{error}</div>}
  <div className="dash-cols">
   <LivePanel runs={live} loading={loading&&!data} now={now} onOpenProject={open} onNav={onNav}/>
   <PendingPanel runs={pending} loading={loading&&!data} onOpenProject={open}/>
   <RecentProjects projects={data?.projects||[]} loading={loading&&!data} onOpenProject={open} onNav={onNav}/>
  </div>
  <div className="dash-costs"><CreationCosts backend={backend}/></div>
 </section>;
}
