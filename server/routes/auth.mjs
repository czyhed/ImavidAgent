import { publicUser, sessionCookie, clearSessionCookie } from '../auth.mjs';
import { currentUser, requireAdmin, requireUser } from '../access.mjs';
import { recordAudit } from '../audit.mjs';
import { AppError } from '../errors.mjs';

// 由 routes/index.mjs 自动发现；ctx 中的 auth 未配置时返回 false 交回旧的本地页面令牌路径。
const secureRequest = req => Boolean(req.socket.encrypted)
  || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

const currentActor = currentUser;

export function routes() {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/session$/,
      handler: async ({ ctx, res, reply }) => {
        if (!ctx.auth) return false;
        const user = currentActor(ctx);
        // 测试替身可能只实现登录/登出；缺少初始化检查时按已初始化处理。
        const setupRequired = typeof ctx.auth.setupRequired === 'function'
          ? await ctx.auth.setupRequired()
          : false;
        reply(res, 200, {
          csrfToken: ctx.csrf,
          // 配置了账号体系后统一返回 account；未配置时的 local-single-user 由 http.mjs 回退处理。
          mode: 'account',
          billing: '以供应商实际账单为准，无自动重试或模型回退。',
          authenticated: Boolean(user),
          user: publicUser(user),
          mustChangePassword: Boolean(user?.mustChangePassword),
          // 无管理员时前端展示首次初始化表单；实际初始化仍只允许本机地址。
          setupRequired,
        });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/session$/,
      handler: async ({ ctx, body, req, res, reply }) => {
        if (!ctx.auth) return false;
        let result;
        try {
          result = await ctx.auth.login(body?.email, body?.password);
        } catch (error) {
          // 失败登录只记录尝试的邮箱，绝不记录密码；写入失败不能覆盖原始鉴权错误。
          await recordAudit(ctx, req, {
            action: 'auth.login.failed',
            targetType: 'user',
            result: 'failure',
            detail: { email: String(body?.email ?? '').slice(0, 254) },
          }).catch(() => {});
          throw error;
        }
        await recordAudit(ctx, req, {
          actor: result.user,
          action: 'auth.login.succeeded',
          targetType: 'user',
          targetId: result.user.id,
          detail: { role: result.user.role, mustChangePassword: result.mustChangePassword },
        });
        res.setHeader('Set-Cookie', sessionCookie(result.token, {
          maxAgeSeconds: result.maxAgeSeconds,
          secure: secureRequest(req),
        }));
        reply(res, 200, {
          csrfToken: ctx.csrf,
          authenticated: true,
          user: result.user,
          mustChangePassword: result.mustChangePassword,
        });
        return true;
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/session$/,
      handler: async ({ ctx, req, res, reply }) => {
        if (!ctx.auth) return false;
        await ctx.auth.logout(ctx.session?.session?.tokenHash);
        await recordAudit(ctx, req, {
          action: 'auth.logout',
          targetType: 'user',
          targetId: ctx.user?.id ?? null,
        });
        res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureRequest(req) }));
        reply(res, 200, { ok: true });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/setup\/admin$/,
      handler: async ({ ctx, body, req, res, reply }) => {
        if (!ctx.auth) return false;
        // 反向代理会让 socket 地址变成回环地址；带转发头的请求一律按远程处理，
        // 避免管理员初始化暴露在公网入口上。初始化应在直连本机时完成。
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) {
          throw new AppError('SETUP_LOCAL_ONLY', '管理员初始化仅允许在本机进行。', 403);
        }
        const result = await ctx.auth.setupAdmin(body || {}, req.socket.remoteAddress);
        await recordAudit(ctx, req, {
          actor: result.user,
          action: 'auth.admin.setup',
          targetType: 'workspace',
          targetId: result.workspace.id,
          detail: { email: result.user.email },
        });
        reply(res, 201, { workspace: result.workspace, user: result.user, csrfToken: ctx.csrf });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/account\/password$/,
      handler: async ({ ctx, body, req, res, reply }) => {
        if (!ctx.auth) return false;
        requireUser(ctx);
        const user = await ctx.auth.changePassword({
          userId: ctx.session.user.id,
          tokenHash: ctx.session.session.tokenHash,
        }, body?.currentPassword, body?.newPassword);
        await recordAudit(ctx, req, {
          action: 'auth.password.changed',
          targetType: 'user',
          targetId: user.id,
          detail: { revokedOtherSessions: true },
        });
        reply(res, 200, { ok: true, user });
        return true;
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/users$/,
      handler: async ({ ctx, res, reply }) => {
        if (!ctx.auth) return false;
        requireAdmin(ctx);
        reply(res, 200, { users: await ctx.auth.listUsers(currentActor(ctx)) });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/users$/,
      handler: async ({ ctx, body, req, res, reply }) => {
        if (!ctx.auth) return false;
        requireAdmin(ctx);
        const user = await ctx.auth.createUser(currentActor(ctx), body || {});
        await recordAudit(ctx, req, {
          action: 'user.created',
          targetType: 'user',
          targetId: user.id,
          detail: { email: user.email, role: user.role },
        });
        reply(res, 201, { user });
        return true;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/users\/([^/]+)$/,
      handler: async ({ ctx, match, body, req, res, reply }) => {
        if (!ctx.auth) return false;
        requireAdmin(ctx);
        const user = await ctx.auth.updateUser(currentActor(ctx), match[1], body || {});
        // 只记录字段名与新角色/状态，绝不把密码等请求值写入日志。
        await recordAudit(ctx, req, {
          action: 'user.updated',
          targetType: 'user',
          targetId: user.id,
          detail: {
            changedFields: Object.keys(body || {}),
            role: body?.role,
            enabled: body?.enabled,
          },
        });
        reply(res, 200, { user });
        return true;
      },
    },
  ];
}
