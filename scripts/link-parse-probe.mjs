import { parseLink } from '../server/link-parse.mjs';
import { AppError } from '../server/errors.mjs';

// 1688 真实样本探测脚本（Issue #22）；不属于 npm test，不联网的单元测试在
// tests/link-parse.test.mjs。用法：
//   node scripts/link-parse-probe.mjs <1688 商品链接> [...]
//   node scripts/link-parse-probe.mjs --require-success <链接>
// 硬限制最多 3 个公开链接；只发一次普通 GET，不带 Cookie、不模拟登录、
// 不绕过验证码或风控。被拦截时如实记录为失败，不重试、不换 IP、不改指纹。
// 输出只含链接、结果状态与字段计数，不打印页面内容或任何凭据。

const MAX_URLS = 3;
const TIMEOUT_MS = 10_000;

const args = process.argv.slice(2);
const requireSuccess = args.includes('--require-success');
const urls = args.filter(arg => !arg.startsWith('--')).slice(0, MAX_URLS);

if (!urls.length) {
  console.error('用法：node scripts/link-parse-probe.mjs [--require-success] <1688 商品链接> [...]');
  console.error(`最多请求 ${MAX_URLS} 个公开链接；被验证码/登录拦截时如实记录，不绕过。`);
  process.exit(2);
}

function summarize(url, result) {
  return {
    url,
    outcome: result.status,
    httpStatus: result.source?.httpStatus ?? null,
    finalUrl: result.source?.finalUrl ?? null,
    productId: result.source?.productId ?? null,
    redirects: result.source?.redirects?.length ?? 0,
    name: result.draft?.name ? result.draft.name.slice(0, 60) : null,
    hasDescription: Boolean(result.draft?.description),
    parameters: result.draft?.parameters?.length ?? 0,
    priceCandidates: result.draft?.prices?.length ?? 0,
    confidence: result.confidence ?? null,
    warnings: result.warnings ?? [],
  };
}

const results = [];
for (const url of urls) {
  try {
    const result = await parseLink(url, { timeoutMs: TIMEOUT_MS });
    results.push(summarize(url, result));
  } catch (error) {
    results.push({
      url,
      outcome: 'failed',
      code: error instanceof AppError ? error.code : 'ERROR',
      message: error instanceof AppError ? error.message : '探测脚本内部错误。',
    });
  }
}

const counts = results.reduce((accumulator, item) => {
  accumulator[item.outcome] = (accumulator[item.outcome] || 0) + 1;
  return accumulator;
}, {});

console.log(JSON.stringify({
  testedAt: new Date().toISOString(),
  attempted: results.length,
  counts,
  results,
}, null, 2));

if (requireSuccess && !results.some(item => item.outcome === 'parsed' || item.outcome === 'partial')) {
  process.exitCode = 1;
}
