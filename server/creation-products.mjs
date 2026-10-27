import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { nameHas } from './creation-store.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const forbidden=new Set(['__proto__','constructor','prototype']);
function facts(value) {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('INVALID_FACTS','商品资料必须是字段对象。',422);
 const result={};
 if(Object.keys(value).length>80)throw new AppError('INVALID_FACTS','商品资料最多 80 项。',422);
 for(const [key,val] of Object.entries(value)) {
  if(!key.trim()||key.length>80||forbidden.has(key)||typeof val!=='string'||val.length>4000)throw new AppError('INVALID_FACTS','资料字段名称或内容无效。',422);
  result[key]=val.trim();
 }
 return result;
}
const productBody=()=>({name:'未命名商品',facts:{},manualFields:[],messages:[],suggestions:[],evidenceIds:[],creativeAssetIds:[]});
export class CreationProducts {
 constructor(store,{hub,media}) {this.store=store;this.hub=hub;this.media=media;}
 // 列表摘要：名称、封面（第一张创作图）、资料条数；完整正文由 GET /products/:id 提供。
 // page：{limit,offset,q}；limit 缺省返回全部。返回 {items,total}。
 async list(workspace,page={}) {
  const {rows,total}=await this.store.page(workspace,{kinds:['product'],limit:page.limit,offset:page.offset,where:page.q?add=>[nameHas("body->>'name'",add,page.q)]:null,projection:`body->>'name' AS name,
   CASE WHEN jsonb_typeof(body->'creativeAssetIds')='array' AND jsonb_array_length(body->'creativeAssetIds')>0 THEN jsonb_build_array(body->'creativeAssetIds'->0) ELSE '[]'::jsonb END AS creative_asset_ids,
   CASE WHEN jsonb_typeof(body->'facts')='object' THEN (SELECT count(*)::int FROM jsonb_object_keys(body->'facts')) ELSE 0 END AS fact_count`});
  return {total,items:rows.map(r=>({id:r.id,name:r.name,revision:r.revision,creativeAssetIds:r.creative_asset_ids,factCount:r.fact_count,trashedAt:r.trashed_at,createdAt:r.created_at,updatedAt:r.updated_at}))};
 }
 async get(workspace,id) {
  const p=await this.store.get(workspace,id);
  if(!p||p.kind!=='product')throw new AppError('NOT_FOUND','商品不存在。',404);
  return p;
 }
 async create(workspace,body={}) {
  const name=String(body.name||'未命名商品').trim();if(!name||name.length>180)throw new AppError('INVALID_NAME','商品名称须为 1–180 字。',422);
  const fields=facts(body.facts||{});
  return this.store.create(workspace,'product',{...productBody(),name,facts:fields,manualFields:[...Object.keys(fields),...(body.name?['name']:[])]});
 }
 async patch(workspace,id,revision,body) {
  const fields=body.facts===undefined?null:facts(body.facts);
  if(body.name!==undefined&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>180))throw new AppError('INVALID_NAME','商品名称须为 1–180 字。',422);
  return this.store.change(workspace,id,revision,current=>{
   this.writable(current);
   return {...current,...(body.name!==undefined?{name:body.name.trim()}:{}),facts:fields?{...current.facts,...fields}:current.facts,manualFields:[...new Set([...current.manualFields,...Object.keys(fields||{}),...(body.name!==undefined?['name']:[])])]};
  });
 }
 writable(record) {if(record.kind!=='product'||record.trashedAt||record.deletionPending)throw new AppError('PRODUCT_UNAVAILABLE','请先恢复商品再编辑。',409);}
 async attachment(workspace,id,role,c=this.store.pool) {
  const asset=await this.store.get(workspace,id,c);
  if(!asset||asset.kind!=='asset'||asset.trashedAt||asset.deletionPending||asset.role!==role||!asset.mime.startsWith('image/'))throw new AppError('INVALID_ATTACHMENT','请选择当前工作区中可用的图片及正确用途。',422);
  return asset;
 }
 async chat(workspace,id,body={}) {
  const text=String(body.text||'').trim(),ids=body.evidenceIds||[];
  if(text.length>12000||!Array.isArray(ids)||ids.length>8||(!text&&!ids.length)||ids.some(x=>typeof x!=='string'))throw new AppError('INVALID_MESSAGE','请输入文字或最多 8 张资料图片。',422);
  const key=body.requestKey;
  if(!UUID.test(String(key)))throw new AppError('REQUEST_KEY_REQUIRED','请提供有效的消息编号。',422);
  // First-message identity is persisted before any model call; retries reopen it.
  if(!id) {
   const c=await this.store.pool.connect();
   try {
    await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
    const existing=(await c.query("SELECT id FROM sj_creation_records WHERE workspace_id=$1 AND kind='product' AND body->>'firstMessageKey'=$2",[workspace,key])).rows[0];
    if(existing)id=existing.id;
    else {const p=await this.store.create(workspace,'product',{...productBody(),firstMessageKey:key},c);id=p.id;}
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  const existing=await this.get(workspace,id),replay=existing.messages.find(m=>m.id===key);
  if(replay){
   if(replay.text!==text||JSON.stringify(replay.submittedEvidenceIds||replay.evidenceIds)!==JSON.stringify(ids))throw new AppError('IDEMPOTENCY_CONFLICT','同一消息编号不能提交不同资料。',409);
   return {product:existing,...(replay.status==='failed'?{error:{code:replay.errorCode,message:'此消息识别未完成，消息已保留；补充新消息后继续。'}}:{})};
  }
  const attachments=[];for(const aid of ids)attachments.push(await this.attachment(workspace,aid,'evidence'));
  let added=false;
  const saved=await this.store.change(workspace,id,body.revision,async(current,c)=>{
   this.writable(current);
   if(current.messages.some(m=>m.id===key))return null;
   if(current.messages.some(m=>m.role==='user'&&m.status==='pending'))throw new AppError('CHAT_BUSY','上一条消息仍在识别，请稍候刷新。',409);
   for(const attachment of attachments) {
    const asset=await this.attachment(workspace,attachment.id,'evidence',c);
    if(!asset||asset.trashedAt||asset.deletionPending||asset.productId&&asset.productId!==id)throw new AppError('INVALID_ATTACHMENT','资料图片已不可用或属于另一个商品。',422);
    await c.query("UPDATE sj_creation_records SET body=jsonb_set(body,'{productId}',to_jsonb($3::text)),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspace,asset.id,id]);
   }
   added=true;
   return {...current,evidenceIds:[...new Set([...current.evidenceIds,...ids])],messages:[...current.messages,{id:key,role:'user',text,evidenceIds:ids,status:'pending',createdAt:new Date().toISOString()}]};
  });
  if(!added)return {product:saved};
  try {
   const messages=[];
   for(const message of saved.messages.slice(-30)) {
    const content=[{type:'text',text:message.text||'请识别这些商品资料。'}];
    for(const aid of message.evidenceIds||[]) {const file=await this.media.read(workspace,aid);content.push({type:'image',bytes:file.bytes,mime:file.mime});}
    messages.push({role:message.role,content});
   }
   const completion=await this.hub.complete({stage:'product',workspaceId:workspace,messages,system:'你负责整理单一商品事实。只记录用户文字或图片中明确可核实的事实，不猜测、不补全缺失事实；有冲突或不确定时提问。输出严格 JSON 对象 {"reply":"回复或追问","name":"明确商品名称或空字符串","facts":{"字段名":"明确事实"}}。当前资料：'+JSON.stringify({name:saved.name,facts:saved.facts,manualFields:saved.manualFields})});
   let parsed;try {parsed=JSON.parse(completion.text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new AppError('INVALID_RECOGNITION','识别响应格式无效，聊天资料已保留。',502);}
   const proposed=facts(parsed.facts||{});
   const product=await this.store.change(workspace,id,null,current=>{
    if(current.deletionPending||current.trashedAt||current.messages.find(m=>m.id===key)?.status!=='pending')return null;
    const next={...current,facts:{...current.facts},suggestions:[...(current.suggestions||[])]};
    const propose=(field,value)=>{
     const old=field==='name'?next.name:next.facts[field];
     if(old===value)return;
     if(next.manualFields.includes(field)||(old!==undefined&&old!==''&&old!=='未命名商品'))next.suggestions.push({id:randomUUID(),field,value,previous:old??null,messageId:key});
     else if(field==='name')next.name=value;else next.facts[field]=value;
    };
    for(const [field,value] of Object.entries(proposed))if(value)propose(field,value);
    if(typeof parsed.name==='string'&&parsed.name.trim()&&parsed.name.length<=180)propose('name',parsed.name.trim());
    next.messages=current.messages.map(m=>m.id===key?{...m,status:'completed'}:m).concat({id:randomUUID(),role:'assistant',text:String(parsed.reply||'已整理明确资料；冲突项请确认。').slice(0,12000),replyTo:key,usage:completion.usage,createdAt:new Date().toISOString()});
    return next;
   });
   return {product};
  }catch(error){
   const product=await this.store.change(workspace,id,null,current=>({...current,messages:current.messages.map(m=>m.id===key?{...m,status:'failed',errorCode:error instanceof AppError?error.code:'RECOGNITION_FAILED'}:m)}));
   return {product,error:{code:error instanceof AppError?error.code:'RECOGNITION_FAILED',message:'识别未完成，消息与附件已保存。可补充新消息后继续。'}};
  }
 }
 async endRecognition(workspace,id,revision,messageId) {
  return this.store.change(workspace,id,revision,current=>{
   this.writable(current);const message=current.messages.find(m=>m.id===messageId&&m.role==='user');
   if(!message)throw new AppError('NOT_FOUND','消息不存在。',404);
   if(message.status!=='pending')return null;
   if(Date.now()-new Date(message.createdAt).getTime()<180000)throw new AppError('CHAT_BUSY','识别仍在处理中，请在三分钟后核实。',409);
   return {...current,messages:current.messages.map(m=>m.id===messageId?{...m,status:'failed',errorCode:'RECOGNITION_INTERRUPTED'}:m)};
  });
 }
 async accept(workspace,id,revision,suggestionId,accept=true) {
  return this.store.change(workspace,id,revision,current=>{
   this.writable(current);const suggestion=current.suggestions.find(s=>s.id===suggestionId);
   if(!suggestion)throw new AppError('NOT_FOUND','资料建议不存在或已处理。',404);
   const old=suggestion.field==='name'?current.name:current.facts[suggestion.field];
   if(accept&&(old??null)!==suggestion.previous)throw new AppError('FACT_CHANGED','该字段已更新，请保留当前值并重新整理。',409);
   return {...current,...(accept&&suggestion.field==='name'?{name:suggestion.value}:{}),facts:accept&&suggestion.field!=='name'?{...current.facts,[suggestion.field]:suggestion.value}:current.facts,suggestions:current.suggestions.filter(s=>s.id!==suggestionId)};
  });
 }
 async promote(workspace,id,revision,assetId) {
  await this.attachment(workspace,assetId,'evidence');
  return this.store.change(workspace,id,revision,async(current,c)=>{
   this.writable(current);if(!current.evidenceIds.includes(assetId))throw new AppError('INVALID_ATTACHMENT','只能将本商品资料图片加入创作素材。',422);
   const asset=await this.attachment(workspace,assetId,'evidence',c);
   await c.query("UPDATE sj_creation_records SET body=jsonb_set(body,'{role}','\"creative\"'::jsonb),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspace,asset.id]);
   return {...current,creativeAssetIds:[...new Set([...current.creativeAssetIds,assetId])]};
  });
 }
 async attachCreative(workspace,id,revision,assetId) {
  const asset=await this.attachment(workspace,assetId,'creative');
  if(asset.productId&&asset.productId!==id)throw new AppError('INVALID_ATTACHMENT','创作素材属于另一个商品。',422);
  return this.store.change(workspace,id,revision,async(current,c)=>{this.writable(current);const available=await this.attachment(workspace,assetId,'creative',c);if(available.productId&&available.productId!==id)throw new AppError('INVALID_ATTACHMENT','创作素材属于另一个商品。',422);return {...current,creativeAssetIds:[...new Set([...current.creativeAssetIds,assetId])]};});
 }
}
