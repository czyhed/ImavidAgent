import {Component,lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import AuthScreen,{BootScreen,PasswordChangeScreen} from './components/AuthScreen.jsx';
import {Modal,Toast} from './components/ui.jsx';
import {useBackend} from './lib/backend.js';
import {canAdmin,canWrite,isAuthEnabled,roleLabel,sessionUser} from './lib/auth.js';
const Dashboard=lazy(()=>import('./components/CreationDashboard.jsx'));
const Projects=lazy(()=>import('./components/CreationProjects.jsx'));
const Products=lazy(()=>import('./components/CreationProducts.jsx'));
const Assets=lazy(()=>import('./components/CreationAssets.jsx'));
const System=lazy(()=>import('./components/CreationSystem.jsx'));
const Trash=lazy(()=>import('./components/CreationTrash.jsx'));
const NAV=[['dashboard','工作台','M3 3h7v9H3zM14 3h7v5h-7zM3 16h7v5H3zM14 12h7v9h-7z'],['projects','项目','M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],['products','商品','M4 8.5 12 4l8 4.5v7L12 20l-8-4.5zM4 8.5 12 13l8-4.5M12 13v7'],['assets','素材','M3 5h18v14H3zM3 17l6-5 5 4 3-3 4 4'],['system','系统','M4 6h9M19 6h1M4 12h2M12 12h8M4 18h7M17 18h3']];
const TITLES={dashboard:'工作台',projects:'项目',project:'项目画布',products:'商品资料库',assets:'素材库',system:'系统管理',trash:'回收站'};
class Boundary extends Component{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<section className="view rv" role="alert"><div className="rv-panel" style={{textAlign:'center'}}><h2>工作区暂时无法打开</h2><p className="muted">请重新载入页面后继续。</p><button className="btn" style={{marginTop:10}} onClick={()=>location.reload()}>重新载入</button></div></section>:this.props.children;}}
function locationState(){const q=new URLSearchParams(location.search);return {screen:TITLES[q.get('screen')]?q.get('screen'):'dashboard',projectId:q.get('projectId'),productId:q.get('productId'),view:q.get('view')};}
export default function App(){
 const backend=useBackend();const [route,setRoute]=useState(locationState);const [toast,setToast]=useState('');const [dialog,setDialog]=useState(null);const toastTimer=useRef();const editing=useRef(false);const activeUrl=useRef(location.href);
 const notify=useCallback(text=>{setToast(text);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),4500);},[]);
 useEffect(()=>{document.body.dataset.screen=route.screen;return()=>{delete document.body.dataset.screen;};},[route.screen]);
 function go(screen,extra={}){if(editing.current&&!window.confirm('当前有未保存的改动，确定离开？'))return;editing.current=false;const r={screen,projectId:null,productId:null,view:null,...extra};setRoute(r);const q=new URLSearchParams({screen});if(r.projectId)q.set('projectId',r.projectId);if(r.productId)q.set('productId',r.productId);if(r.view)q.set('view',r.view);history.pushState(null,'',`${location.pathname}?${q}`);activeUrl.current=location.href;window.scrollTo({top:0});}
 useEffect(()=>{const pop=()=>{if(editing.current&&!window.confirm('当前有未保存的改动，确定离开？')){history.pushState(null,'',activeUrl.current);return;}editing.current=false;activeUrl.current=location.href;setRoute(locationState());};window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[]);
 const openProject=(id,extra={})=>go('project',{projectId:id,...extra});const openProduct=id=>go('products',{productId:id});
 const createProject=async(context={})=>{const productId=typeof context==='string'?context:(context.productId||context.id);if(!productId){go('projects',{initialTemplate:context.template||null});return;}try{const result=await backend.apiCall('/api/creation/projects',{productId,name:context.name||undefined,graphVersion:4});const id=result.project?.id||result.id;if(!id)throw new Error('项目创建未返回编号。');openProject(id);}catch(e){notify(e.message);}};
 const openDialog=useCallback((title,content)=>setDialog({title,content,message:''}),[]);const closeDialog=useCallback(()=>setDialog(null),[]);const setDialogMessage=useCallback(message=>setDialog(s=>s?{...s,message}:s),[]);
 const user=sessionUser(backend.session);const authOn=isAuthEnabled(backend.session);const writable=canWrite(backend.session);const admin=canAdmin(backend.session);
 if(!backend.sessionReady)return <BootScreen/>;
 if(!backend.session)return <div className="auth-boot" role="alert"><p>{backend.error||'无法连接工作空间。'}</p><button className="btn" onClick={()=>backend.connect().catch(()=>{})}>重新连接</button></div>;
 if(authOn&&backend.session?.authenticated===false)return <AuthScreen backend={backend} session={backend.session}/>;
 if(authOn&&backend.session?.mustChangePassword)return <PasswordChangeScreen backend={backend} session={backend.session}/>;
 const active=route.screen==='project'?'projects':route.screen==='trash'?'assets':route.screen;
 const shared={backend,notify,onWorkflowEditingChange:v=>{editing.current=v;},canWrite:writable,canAdmin:admin,onOpenProject:openProject,onOpenProduct:openProduct,onCreateProject:createProject,onNewProject:createProject,productId:route.productId,projectId:route.projectId,initialTemplate:route.initialTemplate,openDialog,closeDialog,setDialogMessage,routeView:route.view};
 return <><div className="app">
 <header className="topnav" data-topnav><button type="button" className="topnav-brand" onClick={()=>go('dashboard')} aria-label="商境工作台首页"><span className="brand-dot" aria-hidden/>商境</button>
  <nav className="topnav-menu" aria-label="主导航">{NAV.map(([id,label])=><button type="button" key={id} className={active===id?'is-active':''} data-nav={id} aria-current={active===id?'page':undefined} onClick={()=>go(id)}>{label}</button>)}</nav>
  <div className="topnav-right">{user&&<span className="auth-chip" data-auth-user={user.email} data-auth-role={user.role}><span className="avatar" aria-hidden>{(user.displayName||user.email||'?').trim().slice(0,1).toUpperCase()}</span><span className="auth-email">{user.email}</span><em>{roleLabel(user.role)}</em></span>}<button className="btn small" onClick={()=>go('trash')} title="回收站" aria-label="回收站">♲ 回收站</button>{authOn&&<button className="btn small ghost" data-auth-logout onClick={()=>backend.logout().catch(e=>notify(e.message))}>退出</button>}</div>
 </header>
 <div className="frame"><main className="stage"><Boundary key={route.screen}><Suspense fallback={<div role="status" style={{padding:24}}>正在打开工作区…</div>}>{route.screen==='dashboard'&&<Dashboard {...shared} onNav={go}/ >}{['projects','project'].includes(route.screen)&&<Projects {...shared} routeView={route.view} onBack={()=>go('projects')} onWorkflowEditingChange={v=>{editing.current=v;}}/>}{route.screen==='products'&&<Products {...shared} onSelectionChange={id=>{setRoute(s=>({...s,productId:id}));const q=new URLSearchParams(location.search);if(id)q.set('productId',id);else q.delete('productId');history.replaceState(null,'',`${location.pathname}?${q}`);activeUrl.current=location.href;}}/>}{route.screen==='assets'&&<Assets {...shared}/ >}{route.screen==='system'&&<System {...shared}/ >}{route.screen==='trash'&&<Trash {...shared}/ >}</Suspense></Boundary></main></div>
 </div>
 <nav className="gen-mobile-nav" aria-label="移动导航">{NAV.map(([id,label])=><button type="button" key={id} data-screen={id} aria-current={active===id?'page':undefined} onClick={()=>go(id)}>{label}</button>)}</nav>{dialog&&<Modal title={dialog.title} message={dialog.message} onClose={closeDialog}>{dialog.content}</Modal>}<Toast message={toast}/></>;
}
