import { AppError } from '../errors.mjs';
import { creationWorkspaceId, requireOperator, requireViewer } from '../access.mjs';

function service(ctx) {
 if(!ctx.creationProjects)throw new AppError('PROJECTS_UNAVAILABLE','创作项目服务暂不可用。',503);
 return ctx.creationProjects;
}
const projectId=match=>match[1];
function revisionBody(req,body={}) {
 const header=String(req?.headers?.['if-match']||'').match(/^(?:W\/)?"?(?:r|v)?(\d+)"?$/);
 return header?{...body,revision:Number(header[1])}:body;
}
function result(res,reply,data,status=200) {
 if(data.project)res.setHeader('ETag',`"r${data.project.revision}"`);
 reply(res,status,data);return true;
}
export function routes() {
 const collection=/^\/api\/creation\/projects$/;
 const item=/^\/api\/creation\/projects\/([\da-f-]{36})$/i;
 const action=/^\/api\/creation\/projects\/([\da-f-]{36})\/(preview|start|suggest|apply-suggestion|sync-product|recover|cancel|export|composite)$/i;
 const ops=/^\/api\/creation\/projects\/([\da-f-]{36})\/ops$/i;
 const status=/^\/api\/creation\/projects\/([\da-f-]{36})\/status$/i;
 const storyboard=/^\/api\/creation\/projects\/([\da-f-]{36})\/storyboard$/i;
 const storyboardAction=/^\/api\/creation\/projects\/([\da-f-]{36})\/storyboard\/(generate-script|generate-shots|sync|compile|tail-frame|shots-request\/apply|shots-request\/discard)$/i;
 const subtitlesFile=/^\/api\/creation\/projects\/([\da-f-]{36})\/storyboard\/subtitles\.srt$/i;
 const batchAction=/^\/api\/creation\/projects\/([\da-f-]{36})\/storyboard\/batch\/(preview|start|retry|cancel|resume)$/i;
 return [
  {method:'GET',pattern:collection,async handler({ctx,res,reply}){requireViewer(ctx);return result(res,reply,await service(ctx).list(creationWorkspaceId(ctx)));}},
  {method:'POST',pattern:collection,async handler({ctx,body,res,reply}){requireOperator(ctx);return result(res,reply,await service(ctx).create(creationWorkspaceId(ctx),body),201);}},
  {method:'GET',pattern:item,async handler({ctx,match,res,reply}){requireViewer(ctx);return result(res,reply,await service(ctx).detail(creationWorkspaceId(ctx),projectId(match)));}},
  // 增量保存：一批操作在一次事务里应用，不比较整项目修订号（见 docs/requirements/creation-sync-grilling.md）。
  {method:'POST',pattern:ops,async handler({ctx,match,body,res,reply}){requireOperator(ctx);return result(res,reply,await service(ctx).applyOps(creationWorkspaceId(ctx),projectId(match),body));}},
  // 轻量状态：只含 revision、运行记录、配音状态与分镜批次 / 成片状态，供有运行中任务时每 3 秒查询。
  {method:'GET',pattern:status,async handler({ctx,match,res,reply}){requireViewer(ctx);return result(res,reply,await service(ctx).status(creationWorkspaceId(ctx),projectId(match)));}},
  {method:'PATCH',pattern:item,async handler({ctx,match,req,body,res,reply}){requireOperator(ctx);return result(res,reply,await service(ctx).update(creationWorkspaceId(ctx),projectId(match),revisionBody(req,body)));}},
  {method:'PATCH',pattern:storyboard,async handler({ctx,match,req,body,res,reply}){requireOperator(ctx);return result(res,reply,await service(ctx).saveStoryboard(creationWorkspaceId(ctx),projectId(match),revisionBody(req,body)));}},
  {method:'GET',pattern:subtitlesFile,async handler({ctx,match,res}){
   requireViewer(ctx);
   const file=await service(ctx).subtitlesSrt(creationWorkspaceId(ctx),projectId(match));
   // 中文文件名用 RFC 5987（filename*）编码，filename 给不支持的客户端一个安全的回退名。
   res.writeHead(200,{'Content-Type':'application/x-subrip; charset=utf-8','Content-Disposition':`attachment; filename="subtitles.srt"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`,'Content-Length':file.bytes.length,'Cache-Control':'private, no-store'});
   res.end(file.bytes);return true;
  }},
  {method:'POST',pattern:storyboardAction,async handler({ctx,match,req,body,res,reply}){
   requireOperator(ctx);
   const method={'generate-script':'generateScript','generate-shots':'generateShots','sync':'saveStoryboard','compile':'compileStoryboard','tail-frame':'tailFrame','shots-request/apply':'applyShotsRequest','shots-request/discard':'discardShotsRequest'}[match[2]];
   return result(res,reply,await service(ctx)[method](creationWorkspaceId(ctx),projectId(match),revisionBody(req,body)));
  }},
  {method:'POST',pattern:batchAction,async handler({ctx,match,req,body,res,reply}){
   // 预览只读；开始、重试、停止、继续会改变项目，需要运营权限。
   if(match[2]==='preview')requireViewer(ctx);else requireOperator(ctx);
   const method={preview:'batchPreview',start:'batchStart',retry:'batchRetry',cancel:'batchCancel',resume:'batchResume'}[match[2]];
   return result(res,reply,await service(ctx)[method](creationWorkspaceId(ctx),projectId(match),revisionBody(req,body)));
  }},
  {method:'POST',pattern:action,async handler({ctx,match,req,body,res,reply}){
   const action=match[2];
   if(action==='preview'||action==='export')requireViewer(ctx);else requireOperator(ctx);
   const method={'apply-suggestion':'applySuggestion','sync-product':'syncProduct'}[action]||action;
   const data=await service(ctx)[method](creationWorkspaceId(ctx),projectId(match),revisionBody(req,body));
   if(action==='export') {
    res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="project.zip"; filename*=UTF-8''${encodeURIComponent(data.name)}`,'Content-Length':data.bytes.length,'Cache-Control':'private, no-store'});
    res.end(data.bytes);return true;
   }
   return result(res,reply,data);
  }},
 ];
}
