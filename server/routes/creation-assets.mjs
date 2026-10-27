import { AppError } from '../errors.mjs';
import { publicAsset } from '../creation-media.mjs';
import { pageParams, pageBody, idList } from '../creation-paging.mjs';
import { nameHas } from '../creation-store.mjs';
import { requireViewer, requireOperator, requireAdmin, creationWorkspaceId, currentUser } from '../access.mjs';
function service(ctx,key){if(!ctx[key])throw new AppError('SERVICE_UNAVAILABLE','创作存储暂不可用。',503);return ctx[key];}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function id(value){if(!uuid.test(String(value)))throw new AppError('NOT_FOUND','记录不存在。',404);return value;}
function revision(req,body,url){const raw=req.headers['if-match']?.replace('W/','').replaceAll('"','').replace('v','')??body?.revision??url?.searchParams.get('revision');if(!Number.isInteger(Number(raw))||Number(raw)<1)throw new AppError('REVISION_REQUIRED','请携带当前修订号重试。',428);return Number(raw);}
async function record(ctx,recordId){const item=await service(ctx,'creationLifecycle').load(creationWorkspaceId(ctx),id(recordId));if(item.kind!=='asset')throw new AppError('NOT_FOUND','素材不存在。',404);return item;}
function safeItem(item){return item.kind==='asset'?publicAsset(item):item;}
async function file({ctx,req,res,url,match},signed=false){
 let workspace;
 if(signed){workspace=url.searchParams.get('workspace');service(ctx,'creationMedia').verifyPublic(workspace,id(match[1]),url.searchParams.get('expires'),url.searchParams.get('signature'));}
 else{requireViewer(ctx);workspace=creationWorkspaceId(ctx);}
 const media=await service(ctx,'creationMedia').read(workspace,id(match[1]));
 const headers={'Content-Type':media.mime,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':(url.searchParams.has('download')?'attachment':'inline')+'; filename="asset"; filename*=UTF-8\'\''+encodeURIComponent(media.name).replaceAll("'",'%27')};
 let start=0,end=media.bytes.length-1,status=200;
 if(req.headers.range){
  const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if(!m||(!m[1]&&!m[2])||(!m[1]&&Number(m[2])===0)){res.writeHead(416,{'Content-Range':'bytes */'+media.bytes.length});res.end();return true;}
  if(!m[1])start=Math.max(0,media.bytes.length-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
  if(start>end||start>=media.bytes.length||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){res.writeHead(416,{'Content-Range':'bytes */'+media.bytes.length});res.end();return true;}
  status=206;headers['Content-Range']='bytes '+start+'-'+end+'/'+media.bytes.length;
 }
 headers['Content-Length']=String(end-start+1);res.writeHead(status,headers);res.end(req.method==='HEAD'?undefined:media.bytes.subarray(start,end+1));return true;
}
const route=(method,path,handler)=>({method,pattern:new RegExp('^/api/creation/'+path+'$'),handler});
export function routes(){return [
 route('POST','assets/upload',async({ctx,url,body,res,reply})=>{requireOperator(ctx);const role=url.searchParams.get('role')||'creative';if(!['evidence','creative','result','mask'].includes(role))throw new AppError('INVALID_ROLE','上传只能选择资料、创作素材、合成结果或蒙版。',422);let baseAssetId;if(role==='mask'){baseAssetId=url.searchParams.get('baseAssetId');const base=uuid.test(String(baseAssetId))?await service(ctx,'creationLifecycle').store.get(creationWorkspaceId(ctx),baseAssetId):null;if(!base||base.kind!=='asset'||base.deletionPending||!base.mime?.startsWith('image/'))throw new AppError('INVALID_MASK_BASE','蒙版需要对应本工作空间内的一张图片。',422);}const asset=await service(ctx,'creationMedia').put(creationWorkspaceId(ctx),{bytes:body,mime:url.searchParams.get('mime'),name:url.searchParams.get('name'),role,baseAssetId,productId:url.searchParams.get('productId')||undefined,projectId:url.searchParams.get('projectId')||undefined,taskId:url.searchParams.get('taskId')||undefined});reply(res,201,{asset:publicAsset(asset)});return true;}),
 route('GET','assets',async({ctx,url,res,reply})=>{requireViewer(ctx);const w=creationWorkspaceId(ctx),store=service(ctx,'creationLifecycle').store,page=pageParams(url),sp=url.searchParams,type=sp.get('type'),roles=(sp.get('role')||'').split(',').filter(r=>/^[a-z]+$/.test(r)),productId=sp.get('productId'),projectId=sp.get('projectId'),ids=idList(url);
  // ids：按编号批量取（不套用角色过滤，供引用素材的名称 / 缩略图 / 已删除检测）；role 可逗号分隔；productId+projectId 同时给出且 match=any 时取并集（商品素材 ∪ 本项目上传）。
  const {records,total}=await store.page(w,{kinds:['asset'],limit:page.limit,offset:page.offset,where:add=>{
   const c=[];
   if(ids)c.push('id=ANY('+add(ids)+'::uuid[])');else if(roles.length)c.push("body->>'role'=ANY("+add(roles)+'::text[])');else c.push("coalesce(body->>'role','') NOT IN ('evidence','mask','voice')");
   if(type)c.push("coalesce(body->>'mime','') LIKE "+add(type.replace(/[\%_]/g,'')+'/%'));
   if(page.q)c.push(nameHas("body->>'name'",add,page.q));
   const owners=[productId&&"body->>'productId'="+add(productId),projectId&&"body->>'projectId'="+add(projectId)].filter(Boolean);
   if(owners.length)c.push('('+owners.join(sp.get('match')==='any'?' OR ':' AND ')+')');
   return c;}});
  reply(res,200,pageBody('items',records.map(publicAsset),total,page));return true;}),
 ...['GET','HEAD'].map(method=>route(method,'assets/([^/]+)/file',request=>file(request))),
 route('GET','media/([^/]+)/public',request=>file(request,true)),
 route('GET','assets/([^/]+)',async({ctx,match,res,reply})=>{requireViewer(ctx);reply(res,200,{asset:publicAsset(await record(ctx,match[1]))});return true;}),
 route('PATCH','assets/([^/]+)',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);await record(ctx,match[1]);if(typeof body.name!=='string'||!body.name.trim()||body.name.length>180)throw new AppError('INVALID_NAME','素材名称须为 1–180 字。',422);const asset=await service(ctx,'creationLifecycle').store.change(creationWorkspaceId(ctx),id(match[1]),revision(req,body),a=>{if(a.trashedAt||a.deletionPending)throw new AppError('ASSET_UNAVAILABLE','请先恢复素材。',409);return {...a,name:body.name.trim()};});reply(res,200,{asset:publicAsset(asset)});return true;}),
 route('GET','templates',async({ctx,url,res,reply})=>{requireViewer(ctx);const s=service(ctx,'creationLifecycle'),w=creationWorkspaceId(ctx),page=pageParams(url);await s.initSeed(w);const r=await s.templatesPage(w,{...page,mediaKind:url.searchParams.get('type')});reply(res,200,pageBody('items',r.records,r.total,page));return true;}),
 route('POST','templates',async({ctx,body,res,reply})=>{requireOperator(ctx);reply(res,201,{template:await service(ctx,'creationLifecycle').createTemplate(creationWorkspaceId(ctx),body)});return true;}),
 route('PATCH','templates/([^/]+)',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);reply(res,200,{template:await service(ctx,'creationLifecycle').patchTemplate(creationWorkspaceId(ctx),id(match[1]),revision(req,body),body)});return true;}),
 route('DELETE','templates/([^/]+)',async({ctx,req,url,match,res,reply})=>{requireOperator(ctx);reply(res,200,await service(ctx,'creationLifecycle').deleteTemplate(creationWorkspaceId(ctx),id(match[1]),revision(req,null,url)));return true;}),
 route('GET','trash',async({ctx,url,res,reply})=>{requireViewer(ctx);const page=pageParams(url),r=await service(ctx,'creationLifecycle').listPage(creationWorkspaceId(ctx),{...page,kind:url.searchParams.get('kind')});reply(res,200,pageBody('items',r.records.map(safeItem),r.total,page));return true;}),
 route('POST','(?:trash/([^/]+)|records/([^/]+)/trash)',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);const item=await service(ctx,'creationLifecycle').trash(creationWorkspaceId(ctx),id(match[1]||match[2]),revision(req,body));reply(res,200,{item:safeItem(item)});return true;}),
 route('POST','trash/([^/]+)/restore',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);reply(res,200,{item:safeItem(await service(ctx,'creationLifecycle').restore(creationWorkspaceId(ctx),id(match[1]),revision(req,body)))});return true;}),
 route('GET','trash/([^/]+)/preview',async({ctx,match,res,reply})=>{requireAdmin(ctx);reply(res,200,await service(ctx,'creationLifecycle').preview(creationWorkspaceId(ctx),id(match[1])));return true;}),
 route('DELETE','trash/([^/]+)',async({ctx,req,url,match,res,reply})=>{requireAdmin(ctx);reply(res,200,await service(ctx,'creationLifecycle').destroy(creationWorkspaceId(ctx),id(match[1]),revision(req,null,url),url.searchParams.get('token'),currentUser(ctx)?.id||'local'));return true;}),
];}
