import { AppError } from '../errors.mjs';
import { requireOperator } from '../access.mjs';
import { parseLink } from '../link-parse.mjs';

// 商品链接解析路由（Issue #22）。自动发现约定：导出 routes()。
// 只做解析并返回“待核实草稿”，不创建、不修改、不覆盖任何商品记录；
// 建档由用户确认后调用商品接口完成。运营及以上角色才能发起外链请求。

const defaultParser = Object.freeze({ parse: url => parseLink(url) });

function parser(ctx) {
  return ctx.linkParser || defaultParser;
}

function readUrl(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('INVALID_BODY', '请求体必须是 JSON 对象。', 400);
  }
  for (const key of Object.keys(body)) {
    if (key !== 'url') throw new AppError('INVALID_FIELD', `请求包含不支持的字段：${key}。`, 400);
  }
  if (typeof body.url !== 'string' || !body.url.trim()) {
    throw new AppError('INVALID_URL', '请粘贴一个 1688 商品链接。', 400);
  }
  return body.url.trim();
}

// POST /api/link-parse  { url }
export function routes() {
  return [
    {
      method: 'POST',
      pattern: /^\/api\/link-parse$/,
      async handler({ ctx, body, res, reply }) {
        requireOperator(ctx);
        const url = readUrl(body);
        const result = await parser(ctx).parse(url);
        reply(res, 200, result);
        return true;
      },
    },
  ];
}
