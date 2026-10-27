import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { nameHas } from './creation-store.mjs';
import { TEMPLATES } from '../web/src/lib/templates.js';

const active = new Set(['queued','running','submitting','pending','unknown','processing','cancel_requested','cancelling']);
function contains(value,ids) {
 if(typeof value==='string')return ids.has(value);
 if(Array.isArray(value))return value.some(item=>contains(item,ids));
 return value&&typeof value==='object'&&Object.values(value).some(item=>contains(item,ids));
}
export class CreationLifecycle {
 constructor(store,{media}) {this.store=store;this.media=media;}
 async list(workspace) {return (await Promise.all(['product','project','asset'].map(kind=>this.store.list(workspace,kind,true)))).flat().sort((a,b)=>new Date(b.trashedAt)-new Date(a.trashedAt));}
 // 回收站分页：按移入时间倒序，q 匹配名称；返回 {records,total}。
 async listPage(workspace,{limit=null,offset=0,q='',kind=null}={}) {
  const kinds=['product','project','asset'].filter(k=>!kind||k===kind);
  const {records,total}=await this.store.page(workspace,{kinds,trash:true,order:"trashed_at DESC,id",limit,offset,where:q?add=>[nameHas("body->>'name'",add,q)]:null});
  return {records,total};
 }
 async load(workspace,id,c=this.store.pool) {const item=await this.store.get(workspace,id,c);if(!item)throw new AppError('NOT_FOUND','记录不存在。',404);return item;}
 async running(workspace,id,c) {return (await c.query('SELECT status FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id])).rows.some(r=>active.has(r.status));}
 async trash(workspace,id,revision) {
  return this.store.change(workspace,id,revision,async(item,c)=>{
   if(item.deletionPending)throw new AppError('DELETION_PENDING','永久删除尚未完成，请管理员重试。',409);
   if(item.kind==='project'&&await this.running(workspace,id,c))throw new AppError('PROJECT_RUNNING','项目仍有运行中或未知任务，请先核实终态或明确取消。',409);
   if(item.kind==='product'&&item.messages?.some(m=>m.status==='pending'))throw new AppError('CHAT_BUSY','商品资料仍在识别，请稍候。',409);
   if(item.trashedAt)return null;
   return {...item,trashedAt:new Date().toISOString()};
  });
 }
 async restore(workspace,id,revision) {
  return this.store.change(workspace,id,revision,item=>{
   if(item.deletionPending)throw new AppError('DELETION_PENDING','永久删除已开始，不能恢复部分文件。请管理员重试清理。',409);
   return item.trashedAt?{...item,trashedAt:null}:null;
  });
 }
 async preview(workspace,id,c=this.store.pool) {
  const item=await this.load(workspace,id,c);
  const rows=(await c.query('SELECT id FROM sj_creation_records WHERE workspace_id=$1 ORDER BY id',[workspace])).rows;
  const records=[];for(const r of rows)records.push(await this.store.get(workspace,r.id,c));
  const runs=(await c.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 ORDER BY id',[workspace])).rows;
  const owned=records.filter(a=>a.kind==='asset'&&(item.kind==='project'&&a.projectId===id||item.kind==='product'&&(a.productId===id||(item.evidenceIds||[]).includes(a.id)||(item.creativeAssetIds||[]).includes(a.id))&&!a.projectId));
  const targets=new Set([id,...owned.map(a=>a.id),...runs.filter(r=>r.project_id===id).map(r=>r.id)]);
  const projects=records.filter(p=>p.kind==='project'&&p.id!==id&&(contains(p,targets)||runs.some(r=>r.project_id===p.id&&(contains(r.input,targets)||contains(r.output,targets))))).map(p=>({id:p.id,name:p.name,trashedAt:p.trashedAt}));
  const busy=item.kind==='project'&&runs.some(r=>r.project_id===id&&active.has(r.status))||item.kind==='product'&&item.messages?.some(m=>m.status==='pending');
  const assets=item.kind==='asset'?[item]:owned;
  const relatedRuns=runs.filter(r=>r.project_id===id);
  const fingerprint={id,revision:item.revision,projects,assets:assets.map(a=>[a.id,a.revision]),runs:relatedRuns.map(r=>[r.id,r.status,r.updated_at]),busy:Boolean(busy)};
  return {id,kind:item.kind,name:item.name,revision:item.revision,blocked:Boolean(projects.length||busy),projects,running:Boolean(busy),assets:assets.map(a=>({id:a.id,name:a.name,mime:a.mime})),runCount:relatedRuns.length,token:createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')};
 }
 async destroy(workspace,id,revision,token,actor='local') {
  let plan;
  await this.store.change(workspace,id,revision,async(item,c)=>{
   if(!item.trashedAt)throw new AppError('TRASH_REQUIRED','请先移入回收站。',409);
   plan=await this.preview(workspace,id,c);
   if(!token||token!==plan.token)throw new AppError('DELETE_PREVIEW_STALE','删除影响已变化，请重新预览后确认。',409);
   if(plan.blocked)throw new AppError('RESOURCE_REFERENCED',plan.running?'仍有运行中或未知任务，请先核实终态。':'仍被项目引用，请先解除列出的项目引用。',409);
   for(const asset of plan.assets)if(asset.id!==id)await c.query("UPDATE sj_creation_records SET body=body || '{\"deletionPending\":true}'::jsonb,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspace,asset.id]);
   return {...item,deletionPending:true};
  });
  for(const asset of plan.assets)await this.media.remove(workspace,asset.id);
  const c=await this.store.pool.connect();
  try {
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
   const check=await this.preview(workspace,id,c);
   if(check.blocked)throw new AppError('RESOURCE_REFERENCED','出现新的项目引用，记录保留，请联系管理员。',409);
   const usage=(await c.query('SELECT id,status,usage FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id])).rows;
   for(const run of usage)await c.query('INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,$2,$3,$4)',[randomUUID(),workspace,'creation.retained-cost',{runId:run.id,usage:run.usage}]);
   await c.query('INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,$2,$3,$4)',[randomUUID(),workspace,'creation.permanent_delete',{recordId:id,kind:plan.kind,actor,assetCount:plan.assets.length,runCount:plan.runCount,costs:usage.map(r=>({status:r.status,usage:r.usage}))}]);
   await c.query('DELETE FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id]);
   const ids=[id,...plan.assets.map(a=>a.id)],removed=new Set(ids);
   const products=(await c.query("SELECT id,body FROM sj_creation_records WHERE workspace_id=$1 AND kind='product'",[workspace])).rows;
   for(const product of products) {
    if(removed.has(product.id))continue;
    const body=product.body;
    if(!(body.evidenceIds||[]).some(a=>removed.has(a))&&!(body.creativeAssetIds||[]).some(a=>removed.has(a)))continue;
    const next={...body,evidenceIds:(body.evidenceIds||[]).filter(a=>!removed.has(a)),creativeAssetIds:(body.creativeAssetIds||[]).filter(a=>!removed.has(a)),messages:(body.messages||[]).map(m=>m.evidenceIds?.some(a=>removed.has(a))?{...m,submittedEvidenceIds:m.submittedEvidenceIds||m.evidenceIds,evidenceIds:m.evidenceIds.filter(a=>!removed.has(a))}:m)};
    await c.query('UPDATE sj_creation_records SET body=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[workspace,product.id,next]);
   }
   await c.query('DELETE FROM sj_creation_records WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspace,ids]);
   await c.query('COMMIT');return {deleted:true,id};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async initSeed(workspace='local') {
  const c=await this.store.pool.connect();
  try {
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
   const seeded=(await c.query("SELECT 1 FROM sj_creation_audit WHERE workspace_id=$1 AND action='creation.template_seeded' LIMIT 1",[workspace])).rows.length;
   if(seeded){await c.query('COMMIT');return;}
   for(const template of TEMPLATES) {
    const hash=createHash('sha256').update(workspace+':'+template.id).digest('hex');
    const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const size=template.compat.size.replace(/\s/g,'').replace('×','x');
    const body={name:template.name,mediaKind:template.taskType==='video'?'video':'image',prompt:template.prompt,params:template.taskType==='video'?{duration:6}: /^\d+x\d+$/.test(size)?{size}:{},seedKey:template.id};
    await c.query('INSERT INTO sj_creation_records(id,workspace_id,kind,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[id,workspace,'template',body]);
   }
   await c.query('INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,$2,$3,$4)',[randomUUID(),workspace,'creation.template_seeded',{count:TEMPLATES.length}]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async templates(workspace) {return this.store.list(workspace,'template');}
 async templatesPage(workspace,{limit=null,offset=0,q='',mediaKind=null}={}) {
  const {records,total}=await this.store.page(workspace,{kinds:['template'],limit,offset,where:add=>[...(q?[nameHas("body->>'name'",add,q)]:[]),...(['image','video'].includes(mediaKind)?["body->>'mediaKind'="+add(mediaKind)]:[])]});
  return {records,total};
 }
 normalizeTemplate(body) {
  if(!body||typeof body.name!=='string'||!body.name.trim()||body.name.length>180||!['image','video'].includes(body.kind)||typeof body.prompt!=='string'||body.prompt.length>12000||!body.params||typeof body.params!=='object'||Array.isArray(body.params)||JSON.stringify(body.params).length>16000)throw new AppError('INVALID_TEMPLATE','请填写名称、图片或视频类型、提示词与有效参数。',422);
  return {name:body.name.trim(),mediaKind:body.kind,prompt:body.prompt,params:body.params};
 }
 async createTemplate(workspace,body) {return this.store.create(workspace,'template',this.normalizeTemplate(body));}
 async patchTemplate(workspace,id,revision,body) {
  const data=this.normalizeTemplate(body);
  return this.store.change(workspace,id,revision,item=>{if(item.kind!=='template')throw new AppError('NOT_FOUND','模板不存在。',404);return {...item,...data};});
 }
 async deleteTemplate(workspace,id,revision) {
  const c=await this.store.pool.connect();try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
   const item=await this.load(workspace,id,c);if(item.kind!=='template')throw new AppError('NOT_FOUND','模板不存在。',404);
   if(item.revision!==Number(revision))throw new AppError('REVISION_CONFLICT','模板已更新，请重新加载。',409);
   await c.query('DELETE FROM sj_creation_records WHERE workspace_id=$1 AND id=$2',[workspace,id]);await c.query('COMMIT');return {deleted:true,id};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
}
