import { AppError } from '../errors.mjs';
import { pageParams, pageBody } from '../creation-paging.mjs';
import { requireViewer, requireOperator, creationWorkspaceId } from '../access.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const id=value=>{if(!uuid.test(String(value)))throw new AppError('NOT_FOUND','商品不存在。',404);return value;};
function service(ctx){if(!ctx.creationProducts)throw new AppError('DB_UNAVAILABLE','商品服务暂不可用。',503);return ctx.creationProducts;}
function revision(req,body){const raw=req.headers['if-match']?.replace('W/','').replaceAll('"','').replace('v','')??body?.revision;if(!Number.isInteger(Number(raw))||Number(raw)<1)throw new AppError('REVISION_REQUIRED','请重新加载后携带当前修订号保存。',428);return Number(raw);}
function respond(res,reply,product,status=200){res.setHeader('ETag','"v'+product.revision+'"');reply(res,status,{product});return true;}
const route=(method,path,handler)=>({method,pattern:new RegExp('^/api/creation/products'+path+'$'),handler});
export function routes(){return [
 route('GET','',async({ctx,url,res,reply})=>{requireViewer(ctx);const page=pageParams(url),r=await service(ctx).list(creationWorkspaceId(ctx),page);reply(res,200,pageBody('items',r.items,r.total,page));return true;}),
 route('POST','',async({ctx,body,res,reply})=>{requireOperator(ctx);return respond(res,reply,await service(ctx).create(creationWorkspaceId(ctx),body),201);}),
 route('POST','/chat',async({ctx,body,res,reply})=>{requireOperator(ctx);reply(res,201,await service(ctx).chat(creationWorkspaceId(ctx),null,body));return true;}),
 route('GET','/([^/]+)',async({ctx,match,res,reply})=>{requireViewer(ctx);return respond(res,reply,await service(ctx).get(creationWorkspaceId(ctx),id(match[1])));}),
 route('PATCH','/([^/]+)',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);return respond(res,reply,await service(ctx).patch(creationWorkspaceId(ctx),id(match[1]),revision(req,body),body));}),
 route('POST','/([^/]+)/chat',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);reply(res,200,await service(ctx).chat(creationWorkspaceId(ctx),id(match[1]),{...body,revision:revision(req,body)}));return true;}),
 route('POST','/([^/]+)/messages/([^/]+)/end-recognition',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);return respond(res,reply,await service(ctx).endRecognition(creationWorkspaceId(ctx),id(match[1]),revision(req,body),id(match[2])));}),
 route('POST','/([^/]+)/suggestions/([^/]+)',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);return respond(res,reply,await service(ctx).accept(creationWorkspaceId(ctx),id(match[1]),revision(req,body),id(match[2]),body.accept!==false));}),
 route('POST','/([^/]+)/(promote|creative-assets)',async({ctx,req,body,match,res,reply})=>{requireOperator(ctx);const method=match[2]==='promote'?'promote':'attachCreative';return respond(res,reply,await service(ctx)[method](creationWorkspaceId(ctx),id(match[1]),revision(req,body),id(body.assetId)));}),
];}
