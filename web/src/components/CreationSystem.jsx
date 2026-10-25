import {lazy,Suspense,useState} from 'react';
import {Header} from './ReviewUI.jsx';
import {Users,Logs} from './System.jsx';
import {CreationCosts} from './CreationDashboard.jsx';
import {canAdmin,isAuthEnabled} from '../lib/auth.js';
const CreationModels=lazy(()=>import('./CreationModels.jsx'));
export default function CreationSystem(props){
 const {backend}=props;const [tab,setTab]=useState('models');const admin=canAdmin(backend.session);
 return <section className="view rv b-system"><Header title="系统管理" desc="配置渠道、模型能力与使用环节，查看实际成本和操作记录。"/><div className="rv-tabs" style={{marginBottom:24}}>{[['models','模型中心'],['costs','实际用量'],...(admin?[['users','用户与权限']]:[]),['logs','审计日志']].map(([id,label])=><button type="button" className={tab===id?'active':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div>
 <Suspense fallback={<p>正在读取…</p>}>{tab==='models'?<CreationModels backend={backend} notify={props.notify}/>:tab==='costs'?<CreationCosts backend={backend}/>:tab==='users'?<Users {...props} apiCall={backend.apiCall} authOn={isAuthEnabled(backend.session)} canAdmin={admin} me={backend.session?.user}/>:<Logs apiCall={backend.apiCall}/>}</Suspense></section>;
}
