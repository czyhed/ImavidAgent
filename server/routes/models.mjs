import { AppError } from '../errors.mjs';
import { requireAdmin, requireOperator, requireViewer } from '../access.mjs';

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function statusFor(call) {
  if (call.status === 'succeeded') return 200;
  if (call.status === 'running') return 202;
  switch (call.error?.code) {
    case 'MODEL_NOT_CONFIGURED':
    case 'MODEL_NOT_FOUND':
    case 'MODEL_DISABLED':
    case 'MODEL_NOT_EXECUTABLE':
    case 'UNSUPPORTED_CAPABILITY':
      return 422;
    case 'PROVIDER_UNCONFIGURED':
    case 'PROVIDER_UNAVAILABLE':
      return 503;
    default:
      return 502;
  }
}

// 由 routes/index.mjs 自动发现；网关实例由 index.mjs 构造后放进 ctx。
// 本模块只负责模型注册表路由，Host/Origin/CSRF/请求体校验仍由 http.mjs 统一处理。
export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/models\/registry$/,
      async handler({ ctx, res, reply }) {
        if (!ctx.gateway) return false;
        requireViewer(ctx);
        reply(res, 200, await ctx.gateway.registry());
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/model-defaults$/,
      async handler({ ctx, body, res, reply }) {
        if (!ctx.gateway) return false;
        requireAdmin(ctx);
        reply(res, 200, await ctx.gateway.setDefault(body));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/model-aliases$/,
      async handler({ ctx, body, res, reply }) {
        if (!ctx.gateway) return false;
        requireAdmin(ctx);
        reply(res, 200, await ctx.gateway.setAlias(body));
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/model-gateway\/invoke$/,
      async handler({ ctx, body, res, reply }) {
        if (!ctx.gateway) return false;
        requireOperator(ctx);
        const { call } = await ctx.gateway.invoke(body);
        reply(res, statusFor(call), call.status === 'succeeded' ? { call } : { call, error: call.error });
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/model-calls\/([^/]+)$/,
      async handler({ ctx, match, res, reply }) {
        if (!ctx.gateway) return false;
        // 调用记录含提示词与响应，按日志权限只允许管理员读取。
        requireAdmin(ctx);
        if (!CALL_ID.test(match[1])) throw new AppError('INVALID_CALL_ID', '调用编号格式不正确。', 422);
        const call = await ctx.gateway.getCall(match[1]);
        if (!call) throw new AppError('CALL_NOT_FOUND', '调用记录不存在。', 404);
        reply(res, 200, { call });
        return true;
      },
    },
  ];
}
