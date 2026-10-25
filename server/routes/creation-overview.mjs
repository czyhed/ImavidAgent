import { creationWorkspaceId, currentUser, requireViewer } from '../access.mjs';
import { AppError } from '../errors.mjs';
import { CreationOverview } from '../creation-overview.mjs';
export function routes(){return [{method:'GET',pattern:/^\/api\/creation\/overview$/,async handler({ctx,res,reply}){
 requireViewer(ctx);
 if(!ctx.creationStore)throw new AppError('UNAVAILABLE','创作工作台暂不可用。',503);
 const result=await new CreationOverview(ctx.creationStore).get(creationWorkspaceId(ctx));
 if(currentUser(ctx)?.role==='viewer'){result.costs=null;result.modelUsage=[];result.runs=result.runs.map(({usage,costMicros,currency,...r})=> r);}
 reply(res,200,result);return true;
}}];}
