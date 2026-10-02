import test from 'node:test';
import assert from 'node:assert/strict';
import { billingService, routes as billingRoutes } from '../server/routes/billing.mjs';

// 账本工作空间隔离回归（Issue #29）：
// 修复前服务实例只按连接池缓存，登录启用时所有工作空间共用默认 'local' 价目表与流水。
// 全部使用假连接池，不连接 PostgreSQL、不产生任何任务或费用。

const WS_A = '00000000-0000-4000-8000-00000000000a';
const WS_B = '00000000-0000-4000-8000-00000000000b';

function fakePool(totals = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/count\(\*\)/i.test(sql)) {
        return { rows: [{ total: totals[params[0]] ?? 0 }] };
      }
      return { rows: [] };
    },
  };
}

function adminContext(pool, workspaceId) {
  return {
    auth: {},
    csrf: 'test-csrf',
    pool,
    session: {
      user: {
        id: '00000000-0000-4000-8000-0000000000ff',
        role: 'admin',
        workspaceId,
      },
    },
  };
}

async function invokeLedger(ctx) {
  const route = billingRoutes().find(item => item.method === 'GET' && item.pattern.test('/api/billing/ledger'));
  assert.ok(route, '未找到 GET /api/billing/ledger 路由');
  let captured;
  const reply = (_res, status, payload) => { captured = { status, payload }; };
  await route.handler({
    ctx,
    body: undefined,
    match: route.pattern.exec('/api/billing/ledger'),
    url: new URL('http://127.0.0.1/api/billing/ledger'),
    req: { headers: {} },
    res: { setHeader() {} },
    reply,
  });
  return captured;
}

test('同一连接池按工作空间缓存独立账本服务与仓储', () => {
  const pool = fakePool();
  const serviceA = billingService(adminContext(pool, WS_A));
  const serviceB = billingService(adminContext(pool, WS_B));

  assert.notEqual(serviceA, serviceB);
  assert.equal(serviceA.workspaceId, WS_A);
  assert.equal(serviceB.workspaceId, WS_B);
  assert.equal(serviceA.repository.workspaceId, WS_A);
  assert.equal(serviceB.repository.workspaceId, WS_B);

  // 同一工作空间重复访问复用同一实例，不会按请求重建。
  assert.equal(billingService(adminContext(pool, WS_A)), serviceA);
  assert.equal(billingService(adminContext(pool, WS_B)), serviceB);
});

test('账本仓储查询收到当前工作空间编号，不同工作空间结果互不影响', async () => {
  const pool = fakePool({ [WS_A]: 2, [WS_B]: 0 });
  const a = await invokeLedger(adminContext(pool, WS_A));
  const b = await invokeLedger(adminContext(pool, WS_B));

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.payload.total, 2);
  assert.equal(b.payload.total, 0);

  // 每次分页都在 SQL 参数首位带上工作空间编号，且没有一次使用默认 'local'。
  assert.ok(pool.calls.length >= 4);
  const workspaces = new Set(pool.calls.map(call => call.params[0]));
  assert.deepEqual([...workspaces].sort(), [WS_A, WS_B].sort());
  assert.equal(pool.calls.some(call => call.params[0] === 'local'), false);
});

test('关闭登录时沿用历史单工作空间 local，ctx.billing 注入仍然优先', () => {
  const pool = fakePool();
  const local = billingService({ auth: null, pool });
  assert.equal(local.workspaceId, 'local');
  assert.equal(local.repository.workspaceId, 'local');

  const injected = { workspaceId: 'injected', summary: async () => ({}) };
  assert.equal(billingService({ auth: {}, pool, billing: injected }), injected);
  assert.throws(() => billingService({ auth: null }), { code: 'DB_UNAVAILABLE', status: 503 });
});
