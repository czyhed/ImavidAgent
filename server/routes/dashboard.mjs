import { AppError } from '../errors.mjs';
import { businessWorkspaceId, currentUser, requireViewer } from '../access.mjs';
import { auditScope } from '../audit.mjs';
import { DashboardService, PgDashboardRepository } from '../aggregate.mjs';

// GET /api/dashboard
// 只读工作台聚合：项目、生成任务、商品待办、素材产出、账本与最近动态。
// 查看者可以读取待办与汇总数量，但金额明细返回 null；服务端逐接口鉴权不依赖前端隐藏。
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/dashboard$/,
      async handler({ ctx, res, reply }) {
        requireViewer(ctx);
        let service = ctx.dashboard;
        if (!service) {
          if (!ctx.pool) throw new AppError('DB_UNAVAILABLE', '工作台指标暂不可用。', 503);
          service = new DashboardService(new PgDashboardRepository(ctx.pool), {
            workspaceId: businessWorkspaceId(ctx),
            role: currentUser(ctx)?.role || 'local',
          });
        }
        reply(res, 200, await service.get({ auditScope: auditScope(ctx) }));
        return true;
      },
    },
  ];
}
