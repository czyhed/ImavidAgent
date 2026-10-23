import test from 'node:test';
import assert from 'node:assert/strict';
import { PgProductImageRepository } from '../server/uploads.mjs';

// 登录开启后新工作空间需要能读到应用级协议登记（迁移 0017 落在 'local'），
// 否则「商品原图输入」永远无法启用；启用状态仍按工作空间独立保存。

function stubPool(rowsByWorkspace) {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push(params);
      // 模拟 SQL 的渠道过滤；工作空间和协议条件由被测代码传入。
      const rows = (rowsByWorkspace[params[0]] || []).filter(row => row.provider_id === params[1]);
      return { rows };
    },
  };
  return { pool, calls };
}

const localRow = {
  id: '00000000-0000-4000-8000-000000000026',
  provider_id: 'omyai-openai',
  model_id: 'omyai-openai:gpt-image-2.5-flare',
  protocol: 'openai-images-edits-v1',
  transport: 'json-data-url',
  status: 'verified',
  evidence: { source: 'official-openai-standard' },
  verified_at: new Date('2026-10-21T00:00:00Z'),
};

test('workspace repository falls back to the app-level verification registration', async () => {
  const { pool, calls } = stubPool({ local: [localRow] });
  const repository = new PgProductImageRepository(pool, { workspaceId: 'ws-a' });
  const verification = await repository.findVerification('omyai-openai', 'openai-images-edits-v1');
  assert.equal(verification.id, localRow.id);
  assert.equal(verification.transport, 'json-data-url');
  assert.deepEqual(calls.map(params => params[0]), ['ws-a', 'local']);
});

test('workspace registration wins and does not read the app-level row', async () => {
  const own = { ...localRow, id: '00000000-0000-4000-8000-000000000099' };
  const { pool, calls } = stubPool({ 'ws-a': [own], local: [localRow] });
  const repository = new PgProductImageRepository(pool, { workspaceId: 'ws-a' });
  const verification = await repository.findVerification('omyai-openai');
  assert.equal(verification.id, own.id);
  assert.deepEqual(calls.map(params => params[0]), ['ws-a']);
});

test('local workspace and unknown providers still fail closed', async () => {
  const { pool, calls } = stubPool({ local: [localRow] });
  assert.equal(await new PgProductImageRepository(pool, { workspaceId: 'local' })
    .findVerification('unknown-provider'), null);
  assert.deepEqual(calls.map(params => params[0]), ['local']);
  // 未验证的渠道仍返回 null，调用方继续拒绝启用和提交。
  assert.equal(await new PgProductImageRepository(pool, { workspaceId: 'ws-b' })
    .findVerification('other-provider'), null);
});
