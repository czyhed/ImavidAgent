import { creationWorkspaceId, currentUser, requireViewer } from '../access.mjs';
import { AppError } from '../errors.mjs';
import { pageParams, pageBody } from '../creation-paging.mjs';
import { CreationUsage } from '../creation-usage.mjs';
import { redactUsageRows } from '../creation-overview.mjs';

// GET /api/creation/usage?limit=1..100&offset= ：用量与成本明细分页；limit 缺省取 20。查看者不返回 usage / costMicros / currency。
export function routes(){return [{method:'GET',pattern:/^\/api\/creation\/usage$/,async handler({ctx,url,res,reply}){
 requireViewer(ctx);
 if(!ctx.creationStore)throw new AppError('UNAVAILABLE','创作工作台暂不可用。',503);
 const page=pageParams(url);if(!page.limit)page.limit=20;
 const result=await new CreationUsage(ctx.creationStore).list(creationWorkspaceId(ctx),page);
 const items=currentUser(ctx)?.role==='viewer'?redactUsageRows(result.items):result.items;
 reply(res,200,pageBody('items',items,result.total,page));return true;
}}];}
