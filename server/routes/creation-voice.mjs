import { AppError } from '../errors.mjs';
import { creationWorkspaceId, requireOperator, requireViewer } from '../access.mjs';

function projects(ctx) {
 if (!ctx.creationProjects) throw new AppError('PROJECTS_UNAVAILABLE', '创作项目服务暂不可用。', 503);
 return ctx.creationProjects;
}
function revisionBody(req, body = {}) {
 const header = String(req?.headers?.['if-match'] || '').match(/^(?:W\/)?"?(?:r|v)?(\d+)"?$/);
 return header ? { ...body, revision: Number(header[1]) } : body;
}
const projectAction = /^\/api\/creation\/projects\/([\da-f-]{36})\/voice\/(dialogue|remix)$/i;

export function routes() {
 return [
  // 系统音色库：可按场景 / 性别 / 语言 / 关键字筛选。
  { method: 'GET', pattern: /^\/api\/creation\/voices$/, async handler({ ctx, url, res, reply }) {
   requireViewer(ctx);
   const query = Object.fromEntries(['scene', 'gender', 'language', 'q', 'group'].map(key => [key, url.searchParams.get(key) || undefined]));
   const result = projects(ctx).voice.list(query);
   reply(res, 200, { ...result, configured: await projects(ctx).voice.configured() });
   return true;
  } },
  // 试听：同一音色 + 文本 + 参数命中缓存时不再调用接口。
  { method: 'POST', pattern: /^\/api\/creation\/voice\/preview$/, async handler({ ctx, body, res, reply }) {
   requireOperator(ctx);
   reply(res, 200, await projects(ctx).voice.preview(creationWorkspaceId(ctx), body || {}));
   return true;
  } },
  { method: 'POST', pattern: /^\/api\/creation\/voice\/design$/, async handler({ ctx, body, res, reply }) {
   requireOperator(ctx);
   reply(res, 200, await projects(ctx).voice.design(creationWorkspaceId(ctx), body || {}));
   return true;
  } },
  { method: 'POST', pattern: projectAction, async handler({ ctx, match, req, body, res, reply }) {
   requireOperator(ctx);
   const method = match[2] === 'dialogue' ? 'voiceDialogue' : 'voiceRemix';
   const data = await projects(ctx)[method](creationWorkspaceId(ctx), match[1], revisionBody(req, body || {}));
   if (data.project) res.setHeader('ETag', `"r${data.project.revision}"`);
   reply(res, 200, data);
   return true;
  } },
 ];
}
