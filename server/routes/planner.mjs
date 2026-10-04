import { PlannerService, publicTypeLibrary } from '../planner.mjs';
import { requireOperator, requireViewer } from '../access.mjs';

// 由 routes/index.mjs 自动发现。PlannerService 无状态，每次请求按 ctx 中的模型网关构造。
// Host/Origin/CSRF/请求体大小仍由 http.mjs 统一校验；这里只做规划接口的输入校验。
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/planner\/types$/,
      handler({ ctx, res, reply }) {
        requireViewer(ctx);
        reply(res, 200, publicTypeLibrary());
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/planner\/plan$/,
      async handler({ ctx, body, res, reply }) {
        requireOperator(ctx);
        const planner = ctx.planner || new PlannerService(ctx.gateway);
        reply(res, 200, await planner.plan(body));
        return true;
      },
    },
  ];
}
