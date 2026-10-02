import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../server/errors.mjs';
import { BillingService, amountCentsFor } from '../server/billing.mjs';
import { routes as billingRoutes } from '../server/routes/billing.mjs';

// 内存仓储与 PgBillingRepository 具有相同的原子操作契约：所有写操作在同一个
// 串行区间内完成余额检查与追加，测试不会连接 PostgreSQL、Redis 或任何模型。
class MemoryBillingRepository {
  constructor() {
    this.prices = [];
    this.entries = [];
    this.queue = Promise.resolve();
    this.clock = Date.now();
    this.seq = 0;
  }

  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  insert(workspaceId, entry) {
    const record = { ...structuredClone(entry), workspaceId, createdAt: new Date(this.clock + this.seq++) };
    this.entries.push(record);
    return record;
  }

  byKey(workspaceId, key) {
    return this.entries.find(entry => entry.workspaceId === workspaceId && entry.idempotencyKey === key);
  }

  state(workspaceId, taskId) {
    const state = {
      reserve: null, pending: null, settle: null, release: null, supplement: null, costOnly: null,
    };
    const map = {
      reserve: 'reserve', pending_price: 'pending', settle: 'settle',
      release: 'release', supplement: 'supplement', cost_only: 'costOnly',
    };
    for (const entry of this.entries) {
      if (entry.workspaceId !== workspaceId || entry.taskId !== taskId) continue;
      const key = map[entry.entryType];
      if (key && !state[key]) state[key] = entry;
    }
    return state;
  }

  money(workspaceId) {
    let balanceCents = 0;
    let heldCents = 0;
    for (const entry of this.entries) {
      if (entry.workspaceId !== workspaceId) continue;
      const amount = entry.amountCents ?? 0;
      if (entry.entryType === 'adjustment') balanceCents += amount;
      if (entry.entryType === 'settle' || entry.entryType === 'supplement') balanceCents -= amount;
      if (entry.entryType === 'reserve') heldCents += amount;
      if (entry.entryType === 'release' || entry.entryType === 'settle') heldCents -= amount;
    }
    return { balanceCents, heldCents };
  }

  result(status, created, entry, workspaceId) {
    const money = this.money(workspaceId);
    return {
      status,
      created,
      entry: this.clone(entry),
      balanceCents: money.balanceCents,
      heldCents: money.heldCents,
      availableCents: money.balanceCents - money.heldCents,
    };
  }

  async getActivePrice({ workspaceId, capability, modelId, tier = 'default', at = new Date() }) {
    const rows = this.prices.filter(price => price.workspaceId === workspaceId
      && price.capability === capability
      && price.modelId === modelId
      && price.active
      && (price.tier === tier || price.tier === 'default')
      && new Date(price.effectiveFrom) <= at
      && (!price.effectiveTo || new Date(price.effectiveTo) > at));
    rows.sort((a, b) => (Number(b.tier === tier) - Number(a.tier === tier))
      || (new Date(b.effectiveFrom) - new Date(a.effectiveFrom)));
    return this.clone(rows[0] || null);
  }

  async listPrices({ workspaceId, capability, modelId, tier, activeOnly, limit, offset }) {
    const rows = this.prices
      .filter(price => price.workspaceId === workspaceId
        && (!capability || price.capability === capability)
        && (!modelId || price.modelId === modelId)
        && (!tier || price.tier === tier)
        && (!activeOnly || price.active))
      .sort((a, b) => a.capability.localeCompare(b.capability)
        || a.modelId.localeCompare(b.modelId)
        || a.tier.localeCompare(b.tier)
        || b.version - a.version);
    return {
      total: rows.length,
      prices: rows.slice(offset, offset + limit).map(price => this.clone(price)),
    };
  }

  async setPrice({ workspaceId, price }) {
    return this.lock(() => {
      const sameKey = item => item.workspaceId === workspaceId
        && item.capability === price.capability
        && item.modelId === price.modelId
        && item.tier === price.tier;
      for (const item of this.prices) if (sameKey(item) && item.active) item.active = false;
      const version = Math.max(0, ...this.prices.filter(sameKey).map(item => item.version)) + 1;
      const record = {
        ...structuredClone(price),
        workspaceId,
        version,
        active: true,
        createdAt: new Date(this.clock + this.seq++),
        updatedAt: new Date(),
      };
      this.prices.push(record);
      return this.clone(record);
    });
  }

  async reserve({ workspaceId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result(statusForType(duplicate.entryType), false, duplicate, workspaceId);
      }
      const state = this.state(workspaceId, entry.taskId);
      if (state.reserve) return this.result('reserved', false, state.reserve, workspaceId);
      if (state.pending) return this.result('pending_price', false, state.pending, workspaceId);
      if (state.settle || state.release || state.supplement || state.costOnly) {
        throw new AppError('TASK_FINALIZED', '该任务已有终态流水，不能再预占。', 409);
      }
      const money = this.money(workspaceId);
      if (money.balanceCents - money.heldCents < entry.amountCents) {
        throw new AppError('INSUFFICIENT_BALANCE', '可用额度不足，未提交任务；请先充值或调整预算。', 402);
      }
      return this.result('reserved', true, this.insert(workspaceId, entry), workspaceId);
    });
  }

  async pendingPrice({ workspaceId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result(statusForType(duplicate.entryType), false, duplicate, workspaceId);
      }
      const state = this.state(workspaceId, entry.taskId);
      if (state.pending) return this.result('pending_price', false, state.pending, workspaceId);
      if (state.reserve) return this.result('reserved', false, state.reserve, workspaceId);
      if (state.settle || state.release || state.supplement || state.costOnly) {
        throw new AppError('TASK_FINALIZED', '该任务已有终态流水，不能再标记待核价。', 409);
      }
      return this.result('pending_price', true, this.insert(workspaceId, entry), workspaceId);
    });
  }

  async settle({ workspaceId, taskId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result(statusForType(duplicate.entryType), false, duplicate, workspaceId);
      }
      const state = this.state(workspaceId, taskId);
      if (state.settle) return this.result('settled', false, state.settle, workspaceId);
      if (state.release) throw new AppError('TASK_RELEASED', '任务已释放预占，不能再结算。', 409);
      if (state.supplement) throw new AppError('TASK_SUPPLEMENTED', '任务已补价结算，不能重复结算。', 409);
      if (state.costOnly) throw new AppError('TASK_COST_ONLY', '该任务按仅记成本处理，不进入内部扣款。', 409);
      if (state.pending && !state.reserve) {
        return this.result('pending_price', false, null, workspaceId);
      }
      if (!state.reserve) throw new AppError('BILLING_TASK_NOT_FOUND', '账本中不存在该任务。', 404);
      const record = this.insert(workspaceId, {
        ...entry,
        ...snapshotFrom(state.reserve),
        amountCents: state.reserve.amountCents,
        costMicros: state.reserve.costMicros,
      });
      return this.result('settled', true, record, workspaceId);
    });
  }

  async release({ workspaceId, taskId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result(statusForType(duplicate.entryType), false, duplicate, workspaceId);
      }
      const state = this.state(workspaceId, taskId);
      if (state.release) return this.result('released', false, state.release, workspaceId);
      if (state.settle) throw new AppError('TASK_SETTLED', '任务已结算，不能释放预占。', 409);
      if (state.supplement) throw new AppError('TASK_SUPPLEMENTED', '任务已补价结算，不能释放预占。', 409);
      if (state.costOnly) throw new AppError('TASK_COST_ONLY', '该任务按仅记成本处理，没有预占可释放。', 409);
      const source = state.reserve || state.pending;
      if (!source) throw new AppError('BILLING_TASK_NOT_FOUND', '账本中不存在该任务。', 404);
      const record = this.insert(workspaceId, {
        ...entry,
        ...snapshotFrom(source),
        amountCents: source.amountCents,
      });
      return this.result('released', true, record, workspaceId);
    });
  }

  async supplement({ workspaceId, taskId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result(statusForType(duplicate.entryType), false, duplicate, workspaceId);
      }
      const state = this.state(workspaceId, taskId);
      if (state.supplement) return this.result('supplemented', false, state.supplement, workspaceId);
      if (state.release) throw new AppError('TASK_RELEASED', '任务已释放，不能再补价。', 409);
      if (state.settle || state.reserve) throw new AppError('TASK_PRICED', '任务已有价格并按预占结算，不能再补价。', 409);
      if (!state.pending) throw new AppError('NOT_PENDING_PRICE', '该任务不是待核价状态。', 409);
      const money = this.money(workspaceId);
      if (money.balanceCents - money.heldCents < entry.amountCents) {
        throw new AppError('INSUFFICIENT_BALANCE', '可用额度不足，补价需先充值；可先预览差额再确认。', 402);
      }
      const record = this.insert(workspaceId, {
        ...entry,
        ...snapshotFrom(state.pending),
        costMicros: null,
      });
      return this.result('supplemented', true, record, workspaceId);
    });
  }

  async costOnly({ workspaceId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result(statusForType(duplicate.entryType), false, duplicate, workspaceId);
      }
      return this.result('cost_only', true, this.insert(workspaceId, entry), workspaceId);
    });
  }

  async adjust({ workspaceId, entry }) {
    return this.lock(() => {
      const duplicate = this.byKey(workspaceId, entry.idempotencyKey);
      if (duplicate) {
        assertSameRequest(duplicate, entry);
        return this.result('adjusted', false, duplicate, workspaceId);
      }
      const money = this.money(workspaceId);
      if (money.balanceCents + entry.amountCents < money.heldCents) {
        throw new AppError('INSUFFICIENT_BALANCE', '扣减后余额不足以覆盖当前预占，调整被拒绝。', 402);
      }
      return this.result('adjusted', true, this.insert(workspaceId, entry), workspaceId);
    });
  }

  async balance(workspaceId) {
    return this.money(workspaceId);
  }

  async summary({ workspaceId, from, to }) {
    const money = this.money(workspaceId);
    const entries = this.entries.filter(entry => entry.workspaceId === workspaceId);
    const inWindow = entries.filter(entry => {
      const at = new Date(entry.createdAt);
      return at >= from && at < to;
    });
    const settledCents = inWindow.reduce((sum, entry) =>
      sum + (['settle', 'supplement'].includes(entry.entryType) ? entry.amountCents || 0 : 0), 0);
    const costOnlyMicros = inWindow.reduce((sum, entry) =>
      sum + (entry.entryType === 'cost_only' ? entry.costMicros || 0 : 0), 0);
    const pending = new Set();
    const resolved = new Set();
    for (const entry of entries) {
      if (entry.entryType === 'pending_price') pending.add(entry.taskId);
      if (entry.entryType === 'supplement' || entry.entryType === 'release') resolved.add(entry.taskId);
    }
    const grouped = (field, label) => {
      const map = new Map();
      for (const entry of inWindow) {
        if (entry.entryType !== 'settle' && entry.entryType !== 'supplement') continue;
        const key = entry[field] ?? null;
        const current = map.get(key) || { [label]: key, amountCents: 0, entries: 0 };
        current.amountCents += entry.amountCents || 0;
        current.entries += 1;
        map.set(key, current);
      }
      return [...map.values()].sort((a, b) => b.amountCents - a.amountCents);
    };
    const byModel = grouped('modelId', 'modelId');
    const providers = new Map();
    for (const row of byModel) {
      const provider = String(row.modelId || '').split(':')[0] || 'unknown';
      const current = providers.get(provider) || { provider, amountCents: 0, entries: 0 };
      current.amountCents += row.amountCents;
      current.entries += row.entries;
      providers.set(provider, current);
    }
    return {
      balanceCents: money.balanceCents,
      heldCents: money.heldCents,
      settledCents,
      costOnlyMicros,
      pendingPriceCount: [...pending].filter(taskId => !resolved.has(taskId)).length,
      byModel,
      byCapability: grouped('capability', 'capability'),
      byProject: grouped('projectId', 'projectId'),
      byProvider: [...providers.values()],
    };
  }

  async ledger({ workspaceId, taskId, types, from, to, limit, offset }) {
    const rows = this.entries
      .filter(entry => entry.workspaceId === workspaceId
        && (!taskId || entry.taskId === taskId)
        && (!types || types.includes(entry.entryType))
        && (!from || new Date(entry.createdAt) >= from)
        && (!to || new Date(entry.createdAt) < to))
      .reverse();
    return {
      total: rows.length,
      entries: rows.slice(offset, offset + limit).map(entry => this.clone(entry)),
    };
  }
}

function assertSameRequest(existing, entry) {
  if (existing.taskId !== entry.taskId || existing.entryType !== entry.entryType) {
    throw new AppError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同任务或不同流水类型。', 409);
  }
}

function statusForType(entryType) {
  switch (entryType) {
    case 'reserve': return 'reserved';
    case 'pending_price': return 'pending_price';
    case 'settle': return 'settled';
    case 'release': return 'released';
    case 'supplement': return 'supplemented';
    case 'cost_only': return 'cost_only';
    default: return entryType;
  }
}

function snapshotFrom(source) {
  return {
    capability: source.capability,
    modelId: source.modelId,
    tier: source.tier,
    quantity: source.quantity,
    unit: source.unit,
    unitPrice: source.unitPrice,
    priceId: source.priceId,
    priceVersion: source.priceVersion,
    billingMode: source.billingMode,
    projectId: source.projectId,
  };
}

const IMAGE = { capability: 'image.generate', modelId: 'omyai:image-v1' };

function newBilling() {
  const repository = new MemoryBillingRepository();
  return { repository, billing: new BillingService(repository) };
}

function fund(billing, amountCents = 10_000) {
  return billing.adjust({
    amountCents,
    reason: '测试初始额度',
    reference: 'test-seed',
    idempotencyKey: `seed:${amountCents}`,
  });
}

function setImagePrice(billing, unitPrice = '0.02', overrides = {}) {
  return billing.setPrice({ ...IMAGE, tier: 'default', unit: 'image', unitPrice, ...overrides });
}

test('有价任务预占后在成功回调时只结算一次，重复回调不重复入账', async () => {
  const { billing } = newBilling();
  await fund(billing);
  await setImagePrice(billing);

  const reserved = await billing.reserve({ taskId: 'job-1', ...IMAGE, quantity: 3 });
  assert.equal(reserved.status, 'reserved');
  assert.equal(reserved.entry.entryType, 'reserve');
  assert.equal(reserved.entry.amountCents, 6);
  assert.equal(reserved.balanceCents, 10_000);
  assert.equal(reserved.heldCents, 6);
  assert.equal(reserved.availableCents, 9_994);
  assert.equal(reserved.quote.priced, true);
  assert.equal(reserved.quote.priceVersion, 1);

  const [first, second] = await Promise.all([
    billing.settle('job-1'),
    billing.settle('job-1'),
  ]);
  assert.equal(first.status, 'settled');
  assert.equal(second.status, 'settled');
  assert.equal(first.entry.id, second.entry.id);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);

  const balance = await billing.balance();
  assert.deepEqual(balance, {
    workspaceId: 'local', currency: 'CNY', balanceCents: 9_994, heldCents: 0, availableCents: 9_994,
  });
  const ledger = await billing.ledger({ taskId: 'job-1' });
  assert.deepEqual(ledger.entries.map(entry => entry.entryType).sort(), ['reserve', 'settle']);
  const summary = await billing.summary();
  assert.equal(summary.settledCents, 6);
  assert.equal(summary.pendingPriceCount, 0);
});

test('明确失败释放预占且不扣款，释放后不能再结算', async () => {
  const { billing } = newBilling();
  await fund(billing, 1_000);
  await setImagePrice(billing);
  await billing.reserve({ taskId: 'job-2', ...IMAGE, quantity: 2 });

  const [first, second] = await Promise.all([
    billing.release('job-2', { reason: '上游明确拒绝' }),
    billing.release('job-2', { reason: '上游明确拒绝' }),
  ]);
  assert.equal(first.status, 'released');
  assert.equal(second.status, 'released');
  assert.equal(first.entry.id, second.entry.id);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal(first.entry.amountCents, 4);

  const balance = await billing.balance();
  assert.equal(balance.balanceCents, 1_000);
  assert.equal(balance.heldCents, 0);
  assert.equal(balance.availableCents, 1_000);

  await assert.rejects(billing.settle('job-2'), { code: 'TASK_RELEASED', status: 409 });
  await assert.rejects(billing.settle('missing-task'), {
    code: 'BILLING_TASK_NOT_FOUND', status: 404,
  });
  const ledger = await billing.ledger({ taskId: 'job-2' });
  assert.deepEqual(ledger.entries.map(entry => entry.entryType).sort(), ['release', 'reserve']);
});

test('未定价任务放行并标待核价，成功后管理员补价一次，不写 0 元', async () => {
  const { billing } = newBilling();
  await fund(billing, 1_000);

  const pending = await billing.reserve({ taskId: 'job-3', ...IMAGE, quantity: 1 });
  assert.equal(pending.status, 'pending_price');
  assert.equal(pending.entry.entryType, 'pending_price');
  assert.equal(pending.entry.amountCents, null);
  assert.equal(pending.heldCents, 0);
  assert.equal(pending.availableCents, 1_000);
  assert.equal(pending.quote.priced, false);
  assert.equal(pending.quote.amountCents, null);

  const pendingAgain = await billing.reserve({ taskId: 'job-3', ...IMAGE, quantity: 1 });
  assert.equal(pendingAgain.created, false);
  assert.equal(pendingAgain.entry.id, pending.entry.id);

  const settled = await billing.settle('job-3');
  assert.equal(settled.status, 'pending_price');
  assert.equal(settled.created, false);
  assert.equal(settled.entry, null);

  const [first, second] = await Promise.all([
    billing.supplement('job-3', { amountCents: 250, reason: '管理员核价' }),
    billing.supplement('job-3', { amountCents: 250, reason: '管理员核价' }),
  ]);
  assert.equal(first.status, 'supplemented');
  assert.equal(second.status, 'supplemented');
  assert.equal(first.entry.id, second.entry.id);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);

  const balance = await billing.balance();
  assert.equal(balance.balanceCents, 750);
  assert.equal(balance.heldCents, 0);
  const summary = await billing.summary();
  assert.equal(summary.pendingPriceCount, 0);
  assert.equal(summary.settledCents, 250);
  await assert.rejects(billing.release('job-3'), { code: 'TASK_SUPPLEMENTED', status: 409 });

  const zero = await billing.ledger({ taskId: 'job-3' });
  assert.equal(zero.entries.some(entry => entry.amountCents === 0), false);
  assert.deepEqual(
    zero.entries.map(entry => entry.entryType).sort(),
    ['pending_price', 'supplement'],
  );
});

test('待核价任务明确失败时释放且不产生费用', async () => {
  const { billing } = newBilling();
  await fund(billing, 500);
  await billing.reserve({ taskId: 'job-unpriced-fail', ...IMAGE, quantity: 1 });
  const released = await billing.release('job-unpriced-fail', { reason: '明确失败' });
  assert.equal(released.status, 'released');
  assert.equal(released.entry.amountCents, null);
  assert.equal(released.balanceCents, 500);
  assert.equal(released.heldCents, 0);
  const summary = await billing.summary();
  assert.equal(summary.pendingPriceCount, 0);
  await assert.rejects(
    billing.supplement('job-unpriced-fail', { amountCents: 100, reason: '补价' }),
    { code: 'TASK_RELEASED', status: 409 },
  );
});

test('项目文本辅助为 cost_only：只记成本，不预占、不扣内部额度', async () => {
  const { billing } = newBilling();
  await fund(billing, 1_000);

  const quote = await billing.quote({
    capability: 'text.chat', modelId: 'deepseek:deepseek-chat', quantity: 1_000, billingMode: 'cost_only',
  });
  assert.equal(quote.billingMode, 'cost_only');
  assert.equal(quote.amountCents, null);
  assert.equal(quote.costMicros, null);

  const record = await billing.costOnly({
    taskId: 'call-1',
    capability: 'text.chat',
    modelId: 'deepseek:deepseek-chat',
    quantity: 1_000,
    costMicros: 123,
    projectId: 'project-1',
  });
  assert.equal(record.status, 'cost_only');
  assert.equal(record.entry.entryType, 'cost_only');
  assert.equal(record.entry.amountCents, null);
  assert.equal(record.entry.costMicros, 123);
  assert.equal(record.heldCents, 0);
  assert.equal(record.balanceCents, 1_000);

  // 即使存在可收费的平台价格，文本辅助仍不得按 image 价格预占。
  await setImagePrice(billing);
  const reserved = await billing.reserve({
    taskId: 'call-2',
    capability: 'text.chat',
    modelId: 'deepseek:deepseek-chat',
    quantity: 1_000,
    billingMode: 'cost_only',
  });
  assert.equal(reserved.status, 'cost_only');
  assert.equal(reserved.entry.amountCents, null);
  assert.equal(reserved.heldCents, 0);
  assert.equal(reserved.balanceCents, 1_000);

  // cost_only 价格行可作为成本参考；仍不产生内部扣款。
  await billing.setPrice({
    capability: 'text.chat',
    modelId: 'deepseek:deepseek-chat',
    tier: 'default',
    unit: 'token',
    unitPrice: '0.000001',
    billingMode: 'cost_only',
  });
  const priced = await billing.reserve({
    taskId: 'call-3',
    capability: 'text.chat',
    modelId: 'deepseek:deepseek-chat',
    quantity: 1_000,
    billingMode: 'cost_only',
  });
  assert.equal(priced.status, 'cost_only');
  assert.equal(priced.entry.costMicros, 1_000);
  assert.equal(priced.entry.amountCents, null);
  assert.equal((await billing.balance()).balanceCents, 1_000);
  const summary = await billing.summary();
  assert.equal(summary.costOnlyMicros, 1_123);
});

test('小于一分的单价按四舍五入精确入分，不用浮点', async () => {
  const { billing } = newBilling();
  await fund(billing, 100);

  await setImagePrice(billing, '0.005', { unit: 'call', modelId: 'provider:half-cent' });
  const half = await billing.quote({
    capability: 'image.generate', modelId: 'provider:half-cent', quantity: 1,
  });
  assert.equal(half.amountCents, 1);
  await billing.reserve({ taskId: 'precise-1', capability: 'image.generate', modelId: 'provider:half-cent', quantity: 1 });
  await billing.settle('precise-1');

  await setImagePrice(billing, '0.00000015', { unit: 'token', modelId: 'provider:tokens' });
  const tokens = await billing.quote({
    capability: 'image.generate', modelId: 'provider:tokens', quantity: 1_000_000,
  });
  assert.equal(tokens.amountCents, 15);
  await billing.reserve({
    taskId: 'precise-2', capability: 'image.generate', modelId: 'provider:tokens', quantity: 1_000_000,
  });
  await billing.settle('precise-2');

  const balance = await billing.balance();
  assert.equal(balance.balanceCents, 84);
  assert.equal(balance.heldCents, 0);

  // 0.4 分四舍五入为 0 分：有价任务不能被当成免费任务入账。
  await setImagePrice(billing, '0.004', { unit: 'call', modelId: 'provider:below-minimum' });
  await assert.rejects(
    billing.reserve({ taskId: 'precise-3', capability: 'image.generate', modelId: 'provider:below-minimum', quantity: 1 }),
    { code: 'AMOUNT_TOO_SMALL' },
  );
});

test('改价生成新版本，已结算任务保留原价格快照', async () => {
  const { billing } = newBilling();
  await fund(billing, 1_000);
  await setImagePrice(billing, '0.02');

  await billing.reserve({ taskId: 'snapshot-1', ...IMAGE, quantity: 1 });
  await billing.settle('snapshot-1');

  const second = await setImagePrice(billing, '0.05');
  assert.equal(second.version, 2);
  assert.equal(second.active, true);
  await assert.rejects(
    setImagePrice(billing, '0.06', { effectiveFrom: '2999-01-01T00:00:00.000Z' }),
    { code: 'INVALID_EFFECTIVE_TIME' },
  );
  const quote = await billing.quote({ ...IMAGE, quantity: 1 });
  assert.equal(quote.amountCents, 5);

  const ledger = await billing.ledger({ taskId: 'snapshot-1' });
  const settle = ledger.entries.find(entry => entry.entryType === 'settle');
  assert.equal(settle.amountCents, 2);
  assert.equal(settle.priceVersion, 1);
  assert.equal(settle.unitPrice, '0.02');

  const prices = await billing.prices({ includeHistory: '1' });
  assert.equal(prices.total, 2);
  const active = prices.prices.filter(price => price.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].unitPrice, '0.05');
  assert.equal(active[0].version, 2);
});

test('人工调账必须填写理由与业务引用，幂等键重复不重复入账，扣减不能吃掉预占', async () => {
  const { billing } = newBilling();
  const credit = await billing.adjust({
    amountCents: 1_000, reason: '线下充值', reference: 'order-1', idempotencyKey: 'adj-1',
  });
  assert.equal(credit.status, 'adjusted');
  assert.equal(credit.balanceCents, 1_000);
  const duplicate = await billing.adjust({
    amountCents: 1_000, reason: '线下充值', reference: 'order-1', idempotencyKey: 'adj-1',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.entry.id, credit.entry.id);
  assert.equal((await billing.ledger()).total, 1);

  await assert.rejects(
    billing.adjust({ amountCents: 100, reference: 'order-2' }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(
    billing.adjust({ amountCents: 100, reason: '补充' }),
    { code: 'INVALID_FIELD' },
  );
  await assert.rejects(
    billing.adjust({ amountCents: 0, reason: '补充', reference: 'order-3' }),
    { code: 'INVALID_AMOUNT' },
  );

  await setImagePrice(billing);
  await billing.reserve({ taskId: 'held-1', ...IMAGE, quantity: 100 });
  await assert.rejects(
    billing.adjust({ amountCents: -900, reason: '退款', reference: 'refund-1' }),
    { code: 'INSUFFICIENT_BALANCE', status: 402 },
  );
  const debit = await billing.adjust({ amountCents: -500, reason: '退款', reference: 'refund-2' });
  assert.equal(debit.balanceCents, 500);
  assert.equal(debit.heldCents, 200);
  assert.equal(debit.availableCents, 300);
});

test('结算与释放并发时只有一个终态，另一个被拒绝', async () => {
  const { billing } = newBilling();
  await fund(billing, 1_000);
  await setImagePrice(billing);
  await billing.reserve({ taskId: 'race-1', ...IMAGE, quantity: 1 });

  const results = await Promise.allSettled([
    billing.settle('race-1'),
    billing.release('race-1'),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = results.find(item => item.status === 'rejected');
  assert.ok(['TASK_RELEASED', 'TASK_SETTLED'].includes(rejected.reason.code));

  const ledger = await billing.ledger({ taskId: 'race-1' });
  const terminals = ledger.entries.filter(entry => ['settle', 'release'].includes(entry.entryType));
  assert.equal(terminals.length, 1);
  const balance = await billing.balance();
  assert.equal(balance.heldCents, 0);
  assert.equal(
    balance.balanceCents,
    terminals[0].entryType === 'settle' ? 998 : 1_000,
  );
});

test('并发预占不会超出可用额度，重复幂等键跨任务返回冲突', async () => {
  const { billing } = newBilling();
  await fund(billing, 5);
  await setImagePrice(billing);

  const attempts = await Promise.allSettled(['c1', 'c2', 'c3', 'c4'].map(taskId =>
    billing.reserve({ taskId, ...IMAGE, quantity: 1 })));
  const fulfilled = attempts.filter(item => item.status === 'fulfilled');
  const rejected = attempts.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length, 2);
  assert.equal(rejected.length, 2);
  for (const item of rejected) assert.equal(item.reason.code, 'INSUFFICIENT_BALANCE');

  const balance = await billing.balance();
  assert.equal(balance.heldCents, 4);
  assert.equal(balance.availableCents, 1);

  await billing.adjust({ amountCents: 2, reason: '补充额度', reference: 'refill-1' });
  await billing.reserve({ taskId: 'key-a', ...IMAGE, quantity: 1, idempotencyKey: 'shared-key' });
  await assert.rejects(
    billing.reserve({ taskId: 'key-b', ...IMAGE, quantity: 1, idempotencyKey: 'shared-key' }),
    { code: 'IDEMPOTENCY_CONFLICT', status: 409 },
  );
});

test('汇总按模型、能力、项目拆分，流水可按类型与任务筛选', async () => {
  const { billing } = newBilling();
  await fund(billing, 1_000);
  await setImagePrice(billing, '0.01', { modelId: 'omyai:image-a' });
  await setImagePrice(billing, '0.03', { modelId: 'omyai:image-b' });

  await billing.reserve({
    taskId: 'sum-1', capability: 'image.generate', modelId: 'omyai:image-a', quantity: 2, projectId: 'project-a',
  });
  await billing.settle('sum-1');
  await billing.reserve({
    taskId: 'sum-2', capability: 'image.generate', modelId: 'omyai:image-b', quantity: 1, projectId: 'project-b',
  });
  await billing.settle('sum-2');

  const summary = await billing.summary();
  assert.equal(summary.settledCents, 5);
  assert.deepEqual(summary.byModel, [
    { modelId: 'omyai:image-b', amountCents: 3, entries: 1 },
    { modelId: 'omyai:image-a', amountCents: 2, entries: 1 },
  ]);
  assert.deepEqual(summary.byCapability, [
    { capability: 'image.generate', amountCents: 5, entries: 2 },
  ]);
  assert.deepEqual(summary.byProject, [
    { projectId: 'project-b', amountCents: 3, entries: 1 },
    { projectId: 'project-a', amountCents: 2, entries: 1 },
  ]);
  assert.deepEqual(summary.byProvider, [
    { provider: 'omyai', amountCents: 5, entries: 2 },
  ]);

  const settles = await billing.ledger({ entryType: 'settle' });
  assert.equal(settles.total, 2);
  const both = await billing.ledger({ entryType: 'reserve,settle' });
  assert.equal(both.total, 4);
  await assert.rejects(billing.ledger({ entryType: 'unknown' }), { code: 'INVALID_FILTER' });
});

test('路由最小角色检查：管理员维护价格与调账，运营可查看和执行，查看者只读', async () => {
  const { billing } = newBilling();
  const routeList = billingRoutes();

  async function invoke(method, path, { ctx, body } = {}) {
    const route = routeList.find(item => item.method === method && item.pattern.test(path));
    assert.ok(route, `未找到路由 ${method} ${path}`);
    let captured;
    const reply = (_res, status, payload) => { captured = { status, payload }; };
    await route.handler({
      ctx: ctx || {},
      body,
      match: route.pattern.exec(path),
      url: new URL(`http://127.0.0.1${path}`),
      req: { headers: {} },
      res: { setHeader() {} },
      reply,
    });
    return captured;
  }

  const user = role => ({ billing, auth: {}, session: { user: { id: `u-${role}`, role } } });
  const priceBody = { ...IMAGE, unit: 'image', unitPrice: '0.02' };

  const viewer = user('viewer');
  assert.equal((await invoke('GET', '/api/billing', { ctx: viewer })).status, 200);
  await assert.rejects(
    invoke('POST', '/api/billing/prices', { ctx: viewer, body: priceBody }),
    { code: 'FORBIDDEN', status: 403 },
  );

  const operator = user('operator');
  assert.equal((await invoke('POST', '/api/billing/quote', {
    ctx: operator, body: { ...IMAGE, quantity: 1 },
  })).status, 200);
  await assert.rejects(
    invoke('POST', '/api/billing/prices', { ctx: operator, body: priceBody }),
    { code: 'FORBIDDEN', status: 403 },
  );

  const admin = user('admin');
  assert.equal((await invoke('POST', '/api/billing/prices', {
    ctx: admin, body: priceBody,
  })).status, 201);
  await assert.rejects(
    invoke('POST', '/api/billing/adjustments', { ctx: admin, body: { amountCents: 100 } }),
    { code: 'INVALID_FIELD' },
  );
  assert.equal((await invoke('POST', '/api/billing/adjustments', {
    ctx: admin, body: { amountCents: 100, reason: '人工充值', reference: 'order-1' },
  })).status, 201);

  // 本机模式（未配置账号体系）保留现有行为，不强制角色。
  const local = { billing };
  assert.equal((await invoke('POST', '/api/billing/prices', {
    ctx: local, body: { ...IMAGE, unit: 'image', unitPrice: '0.03' },
  })).status, 201);
});

test('金额换算函数对高精度单价做整数分四舍五入', () => {
  assert.equal(amountCentsFor('0.02', 3), 6);
  assert.equal(amountCentsFor('0.005', 1), 1);
  assert.equal(amountCentsFor('0.004', 1), 0);
  assert.equal(amountCentsFor('0.00000015', 1_000_000), 15);
  assert.equal(amountCentsFor('99.995', 1), 10_000);
});
