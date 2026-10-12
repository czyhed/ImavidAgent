import { AppError } from '../errors.mjs';
import { businessWorkspaceId, requireOperator, requireViewer } from '../access.mjs';
import { auditService } from '../audit.mjs';
import { PgReviewRepository, ReviewService } from '../review.mjs';

// 由 routes/index.mjs 自动发现。测试可通过 ctx.review 注入内存审核服务。
// 读接口 requireViewer；发起审核、更新检查项、通过、撤销都改变状态，统一 requireOperator。
//
// 审核记录使用自己的 ETag `"r<revision>"`：更新检查项、通过与撤销都要携带 If-Match，
// 缺失 428、revision 过期 409。列表接口沿用交付项状态 ETag。
const services = new WeakMap();

function actorId(ctx) {
  return (ctx.session?.user || ctx.user)?.id || 'local';
}

function service(ctx) {
  if (ctx.review) return ctx.review;
  if (!ctx.pool) throw new AppError('REVIEW_UNAVAILABLE', '审核存储暂不可用。', 503);
  let instance = services.get(ctx.pool);
  if (!instance) {
    instance = new ReviewService(new PgReviewRepository(ctx.pool), {
      audit: auditService(ctx),
    });
    services.set(ctx.pool, instance);
  }
  return instance;
}

function ifMatch(req) {
  return req.headers['if-match'];
}

function readContext(ctx, req) {
  return {
    workspaceId: businessWorkspaceId(ctx),
    actorId: actorId(ctx),
    actor: ctx.user || null,
    ip: req.socket?.remoteAddress ?? null,
    requestId: req.headers['x-request-id'] ?? null,
  };
}

function setReviewEtag(res, review) {
  res.setHeader('ETag', `"r${review.revision}"`);
}

function setStateEtag(res, state) {
  res.setHeader('ETag', `"r${state.revision}"`);
}

export function routes() {
  return [
    // ---- 发起审核（只针对当前候选版本；重复发起返回原记录） ----
    {
      method: 'POST',
      pattern: /^\/api\/deliverables\/([^/]+)\/reviews$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).startReview(match[1], body || {}, readContext(ctx, req));
        setReviewEtag(res, result.review);
        reply(res, result.created ? 201 : 200, result);
        return true;
      },
    },

    // ---- 审核历史 ----
    {
      method: 'GET',
      pattern: /^\/api\/deliverables\/([^/]+)\/reviews$/,
      async handler({ ctx, url, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).listReviews(match[1], {
          workspaceId: businessWorkspaceId(ctx),
          projectId: url.searchParams.get('projectId'),
          planVersion: url.searchParams.get('planVersion'),
        });
        setStateEtag(res, result.state);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 审核详情 ----
    {
      method: 'GET',
      pattern: /^\/api\/reviews\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        requireViewer(ctx);
        const result = await service(ctx).getReview(match[1], {
          workspaceId: businessWorkspaceId(ctx),
        });
        setReviewEtag(res, result.review);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 逐项更新检查结果；只有待审核记录可编辑 ----
    {
      method: 'PATCH',
      pattern: /^\/api\/reviews\/([^/]+)$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).updateChecks(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setReviewEtag(res, result.review);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 通过：四项检查全部完成且版本仍是当前候选；通过后冻结版本 ----
    {
      method: 'POST',
      pattern: /^\/api\/reviews\/([^/]+)\/approve$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).approve(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setReviewEtag(res, result.review);
        reply(res, 200, result);
        return true;
      },
    },

    // ---- 撤销：必须理由；解除批准、回到第 04 步，历史保留 ----
    {
      method: 'POST',
      pattern: /^\/api\/reviews\/([^/]+)\/revoke$/,
      async handler({ ctx, req, match, body, res, reply }) {
        requireOperator(ctx);
        const result = await service(ctx).revoke(match[1], body || {}, {
          ...readContext(ctx, req),
          ifMatch: ifMatch(req),
        });
        setReviewEtag(res, result.review);
        reply(res, 200, result);
        return true;
      },
    },
  ];
}
