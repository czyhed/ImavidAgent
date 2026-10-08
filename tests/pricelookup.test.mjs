import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../server/errors.mjs';
import { BillingService } from '../server/billing.mjs';
import { PriceLookupService } from '../server/price-lookup.mjs';
import { routes as priceLookupRoutes } from '../server/routes/price-lookup.mjs';

// 内存仓储与 PgPriceLookupRepository 具有相同契约：候选版本按模型/能力/档位串行分配，
// 采用时同时写候选状态与新价格版本。测试不连接 PostgreSQL、Redis、MinIO 或任何网络，
// 适配器全部为本地模拟，不产生真实的搜索或模型调用。
class MemoryPriceLookupRepository {
  constructor(now = () => new Date()) {
    this.lookups = [];
    this.candidates = [];
    this.prices = [];
    this.now = now;
    this.queue = Promise.resolve();
    this.seq = 0;
  }

  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  clone(value) {
    return value === null || value === undefined ? null : structuredClone(value);
  }

  async createLookup({ workspaceId, lookup, candidates }) {
    return this.lock(() => {
      const storedLookup = { ...structuredClone(lookup), workspaceId };
      this.lookups.push(storedLookup);
      const stored = candidates.map(candidate => {
        // 与 Pg 仓储一致：版本号按每条候选自己的模型/能力/档位分配。
        const key = item => item.workspaceId === workspaceId
          && item.capability === candidate.capability
          && item.modelId === candidate.modelId
          && item.tier === candidate.tier;
        const version = Math.max(0, ...this.candidates.filter(key).map(item => item.version)) + 1;
        const row = {
          ...structuredClone(candidate),
          workspaceId,
          lookupId: lookup.id,
          version,
          status: candidate.status || 'pending',
          adoptedBy: null,
          adoptedAt: null,
          adoptionBasis: null,
          adoptedPriceId: null,
          adoptedPriceVersion: null,
          adoptedExpired: false,
          createdAt: candidate.createdAt || this.now(),
        };
        this.candidates.push(row);
        return row;
      });
      return { lookup: this.clone(storedLookup), candidates: stored.map(item => this.clone(item)) };
    });
  }

  async getLookup({ workspaceId, id }) {
    const lookup = this.lookups.find(item => item.workspaceId === workspaceId && item.id === id);
    if (!lookup) return null;
    const candidates = this.candidates
      .filter(item => item.workspaceId === workspaceId && item.lookupId === id)
      .sort((a, b) => a.version - b.version || a.createdAt - b.createdAt);
    return { lookup: this.clone(lookup), candidates: candidates.map(item => this.clone(item)) };
  }

  async getCandidate({ workspaceId, id }) {
    return this.clone(this.candidates.find(item => item.workspaceId === workspaceId && item.id === id));
  }

  async listLookups({ workspaceId, capability, modelId, status, limit, offset }) {
    const rows = this.lookups
      .filter(item => item.workspaceId === workspaceId
        && (!capability || item.capability === capability)
        && (!modelId || item.modelId === modelId)
        && (!status || item.status === status))
      .sort((a, b) => (new Date(b.createdAt) - new Date(a.createdAt)) || b.id.localeCompare(a.id));
    return {
      total: rows.length,
      lookups: rows.slice(offset, offset + limit).map(item => this.clone(item)),
    };
  }

  async adoptCandidate({
    workspaceId, candidateId, actorId, basis, priceId, adoptedAt, confirmExpired,
  }) {
    return this.lock(() => {
      const candidate = this.candidates.find(item =>
        item.workspaceId === workspaceId && item.id === candidateId);
      if (!candidate) throw new AppError('PRICE_CANDIDATE_NOT_FOUND', '价格候选不存在。', 404);
      if (candidate.status !== 'pending') {
        throw new AppError('CANDIDATE_ALREADY_DECIDED', '该候选已采用或已失效，不能重复采用。', 409);
      }
      if (!candidate.sourceUrl || !candidate.sourceTitle) {
        throw new AppError('PRICE_SOURCE_REQUIRED', '候选缺少来源链接或页面标题，不能采用。', 422);
      }
      if (!confirmExpired && new Date(candidate.expiresAt) <= new Date(adoptedAt)) {
        throw new AppError('CANDIDATE_EXPIRED', '候选已过期，请重新查价；确认复核后才可采用旧候选。', 409);
      }
      if (candidate.currency !== 'CNY') {
        throw new AppError('CURRENCY_CONVERSION_REQUIRED',
          '外币候选需先按记录的汇率、来源与日期折算为 CNY，当前不能直接采用。', 422);
      }
      const sameKey = item => item.workspaceId === workspaceId
        && item.capability === candidate.capability
        && item.modelId === candidate.modelId
        && item.tier === candidate.tier;
      for (const price of this.prices) if (sameKey(price) && price.active) price.active = false;
      const version = Math.max(0, ...this.prices.filter(sameKey).map(item => item.version)) + 1;
      const price = {
        id: priceId,
        workspaceId,
        capability: candidate.capability,
        modelId: candidate.modelId,
        tier: candidate.tier,
        unit: candidate.unit,
        currency: 'CNY',
        unitPrice: candidate.unitPrice,
        billingMode: 'chargeable',
        version,
        active: true,
        effectiveFrom: adoptedAt,
        effectiveTo: null,
        note: `AI 查价采用：${candidate.sourceTitle}`.slice(0, 500),
        createdBy: actorId,
        createdAt: adoptedAt,
        updatedAt: adoptedAt,
      };
      this.prices.push(price);
      Object.assign(candidate, {
        status: 'adopted',
        adoptedBy: actorId,
        adoptedAt,
        adoptionBasis: basis,
        adoptedPriceId: priceId,
        adoptedPriceVersion: version,
        adoptedExpired: Boolean(confirmExpired),
      });
      return { candidate: this.clone(candidate), price: this.clone(price) };
    });
  }

  // ---- 供 BillingService.quote 读取当前生效价（与 PgBillingRepository 同语义） ----
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

  // 直接写入候选，用于验证服务层的防御性校验（无来源、过期、外币）。
  seedCandidate(patch = {}) {
    const candidate = {
      id: randomUUID(),
      lookupId: randomUUID(),
      workspaceId: 'local',
      capability: 'image.generate',
      modelId: 'omyai:image-v1',
      tier: 'standard',
      version: this.candidates.length + 1,
      region: null,
      currency: 'CNY',
      unit: 'image',
      unitPrice: '0.02',
      sourceUrl: 'https://api.example.com/pricing',
      sourceTitle: '官方价格页',
      modelVersion: 'v1',
      matchNote: null,
      confidence: null,
      fetchedAt: this.now(),
      expiresAt: new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000),
      status: 'pending',
      adoptedBy: null,
      adoptedAt: null,
      adoptionBasis: null,
      adoptedPriceId: null,
      adoptedPriceVersion: null,
      adoptedExpired: false,
      createdAt: this.now(),
      ...patch,
    };
    this.candidates.push(candidate);
    return candidate;
  }
}

const MODEL = { capability: 'image.generate', modelId: 'omyai:image-v1', tier: 'standard' };

function officialAdapter(candidates) {
  return { lookup: async () => ({ candidates }) };
}

function candidate(overrides = {}) {
  return {
    sourceUrl: 'https://api.example.com/pricing',
    sourceTitle: '官方 API 价格页',
    modelVersion: 'v1',
    currency: 'CNY',
    unit: 'image',
    unitPrice: '0.02',
    matchNote: '标准档、按张计费',
    confidence: 0.9,
    ...overrides,
  };
}

function setup(adapter, now = () => new Date()) {
  const repository = new MemoryPriceLookupRepository(now);
  const priceLookup = new PriceLookupService(repository, { adapter, now });
  const billing = new BillingService(repository, { now });
  return { repository, priceLookup, billing };
}

test('管理员发起查价：候选带来源、抓取时间、价格版本与档位，无来源条目被拒绝', async () => {
  const adapter = officialAdapter([
    candidate(),
    candidate({ sourceTitle: '缺少来源链接', sourceUrl: undefined, unitPrice: '0.01' }),
    candidate({ sourceUrl: 'http://127.0.0.1/pricing', sourceTitle: '内网页面', unitPrice: '0.005' }),
    candidate({ sourceUrl: 'https://api.example.com/pricing', sourceTitle: '重复候选' }),
  ]);
  const { priceLookup, repository, billing } = setup(adapter);

  const result = await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  assert.equal(result.lookup.status, 'completed');
  assert.equal(result.lookup.candidateCount, 1);
  assert.equal(result.lookup.rejectedCount, 3);
  assert.equal(result.lookup.requestedBy, 'admin-1');
  assert.equal(repository.lookups.length, 1);

  const [stored] = result.candidates;
  assert.equal(stored.status, 'pending');
  assert.equal(stored.adoptable, true);
  assert.equal(stored.expired, false);
  assert.equal(stored.sourceUrl, 'https://api.example.com/pricing');
  assert.equal(stored.sourceTitle, '官方 API 价格页');
  assert.ok(stored.fetchedAt instanceof Date);
  assert.equal(stored.priceVersion, 1);
  assert.equal(stored.tier, 'standard');
  assert.equal(stored.currency, 'CNY');
  assert.equal(stored.unit, 'image');
  assert.equal(stored.unitPrice, '0.02');
  assert.equal(stored.modelVersion, 'v1');

  // 未确认的候选绝不进入价格表，估价仍是未定价。
  assert.equal(repository.prices.length, 0);
  const quote = await billing.quote({ ...MODEL, quantity: 2 });
  assert.equal(quote.priced, false);
  assert.equal(quote.amountCents, null);
  assert.equal(quote.priceVersion, null);
});

test('采用候选后成为平台结算价，重复采用被拒绝，改价只影响新报价', async () => {
  const { priceLookup, repository, billing } = setup(officialAdapter([candidate()]));
  const first = await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  const [pending] = first.candidates;

  const adopted = await priceLookup.adopt(pending.id, {
    basis: '核对官方 2026-10-21 价格页，标准档按张计费',
  }, { actorId: 'admin-1' });
  assert.equal(adopted.candidate.status, 'adopted');
  assert.equal(adopted.candidate.adoption.adoptedBy, 'admin-1');
  assert.equal(adopted.candidate.adoption.basis, '核对官方 2026-10-21 价格页，标准档按张计费');
  assert.equal(adopted.candidate.adoption.priceVersion, 1);
  assert.equal(adopted.price.unitPrice, '0.02');
  assert.equal(adopted.price.tier, 'standard');
  assert.equal(adopted.price.active, true);
  assert.equal(adopted.price.createdBy, 'admin-1');
  assert.match(adopted.price.note, /AI 查价采用/);

  const before = await billing.quote({ ...MODEL, quantity: 2 });
  assert.equal(before.priced, true);
  assert.equal(before.amountCents, 4);
  assert.equal(before.priceVersion, 1);

  await assert.rejects(
    priceLookup.adopt(pending.id, { basis: '再次采用' }, { actorId: 'admin-2' }),
    { code: 'CANDIDATE_ALREADY_DECIDED', status: 409 },
  );

  // 第二次查价与采用产生新的价格版本；旧版本保留但停用。
  const nextAdapter = officialAdapter([candidate({ unitPrice: '0.03' })]);
  const lookup2 = new PriceLookupService(repository, { adapter: nextAdapter });
  const second = await lookup2.lookup(MODEL, { actorId: 'admin-1' });
  assert.equal(second.candidates[0].priceVersion, 2);
  const adopted2 = await lookup2.adopt(second.candidates[0].id, {
    basis: '官方调价为 0.03',
  }, { actorId: 'admin-2' });
  assert.equal(adopted2.price.version, 2);

  const after = await billing.quote({ ...MODEL, quantity: 2 });
  assert.equal(after.amountCents, 6);
  assert.equal(after.priceVersion, 2);
  // 已返回的旧报价对象保持原快照；旧价格行未被覆盖，只是停用。
  assert.equal(before.amountCents, 4);
  assert.equal(before.priceVersion, 1);
  const historical = repository.prices.find(price => price.version === 1);
  assert.equal(historical.unitPrice, '0.02');
  assert.equal(historical.active, false);
});

test('无来源候选不能采用，也不会写入价格表', async () => {
  const { priceLookup, repository } = setup(officialAdapter([]));
  const missing = repository.seedCandidate({ sourceUrl: '', sourceTitle: '' });

  await assert.rejects(
    priceLookup.adopt(missing.id, { basis: '来源缺失仍想采用' }, { actorId: 'admin-1' }),
    { code: 'PRICE_SOURCE_REQUIRED', status: 422 },
  );
  assert.equal(repository.prices.length, 0);
  assert.equal(repository.candidates.find(item => item.id === missing.id).status, 'pending');

  // 适配器返回的无来源条目在入库前就被拒绝，不会变成可采用的候选。
  const empty = await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  assert.equal(empty.lookup.status, 'empty');
  assert.match(empty.lookup.warnings[0], /手动定价/);
});

test('过期候选标记提示，默认拒绝采用，管理员确认复核后才可覆盖并留痕', async () => {
  const { priceLookup, repository } = setup(officialAdapter([candidate()]));
  const result = await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  const [pending] = result.candidates;
  repository.candidates[0].expiresAt = new Date(Date.now() - 60_000);

  const reread = await priceLookup.get(result.lookup.id);
  assert.equal(reread.candidates[0].expired, true);
  assert.equal(reread.lookup.expiredCandidateCount, 1);
  assert.ok(reread.lookup.warnings.some(warning => /过期/.test(warning)));

  await assert.rejects(
    priceLookup.adopt(pending.id, { basis: '直接采用过期价' }, { actorId: 'admin-1' }),
    { code: 'CANDIDATE_EXPIRED', status: 409 },
  );
  assert.equal(repository.prices.length, 0);

  const adopted = await priceLookup.adopt(pending.id, {
    basis: '已重新核对官方页面，确认价格仍有效',
    confirmExpired: true,
  }, { actorId: 'admin-1' });
  assert.equal(adopted.candidate.status, 'adopted');
  assert.equal(adopted.candidate.adoption.confirmedExpired, true);
  assert.equal(repository.candidates[0].adoptedExpired, true);
  assert.equal(adopted.price.version, 1);
});

test('外币候选不能静默换汇，采用必须填写依据', async () => {
  const { priceLookup, repository } = setup(officialAdapter([candidate({ currency: 'USD' })]));
  const result = await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  const [pending] = result.candidates;
  assert.equal(pending.currency, 'USD');

  await assert.rejects(
    priceLookup.adopt(pending.id, { basis: '按 7.2 折算' }, { actorId: 'admin-1' }),
    { code: 'CURRENCY_CONVERSION_REQUIRED', status: 422 },
  );
  await assert.rejects(
    priceLookup.adopt(pending.id, {}, { actorId: 'admin-1' }),
    { code: 'INVALID_FIELD' },
  );
  assert.equal(repository.prices.length, 0);
});

test('适配器失败或未配置时记录失败查价并提示手动定价，不发任何真实调用', async () => {
  const failing = { lookup: async () => { throw new Error('upstream timeout'); } };
  const { priceLookup, repository } = setup(failing);
  const result = await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  assert.equal(result.lookup.status, 'failed');
  assert.equal(result.lookup.candidateCount, 0);
  assert.match(result.lookup.warnings[0], /手动定价|不可用/);
  assert.equal(repository.lookups.length, 1);

  const unconfigured = setup(null).priceLookup;
  const unavailable = await unconfigured.lookup(MODEL, { actorId: 'admin-1' });
  assert.equal(unavailable.lookup.status, 'failed');
  assert.match(unavailable.lookup.error, /Q-10/);
});

test('查价记录可按模型与状态筛选', async () => {
  const { priceLookup } = setup(officialAdapter([candidate()]));
  await priceLookup.lookup(MODEL, { actorId: 'admin-1' });
  await priceLookup.lookup({ capability: 'text.chat', modelId: 'deepseek:deepseek-chat', tier: 'default' },
    { actorId: 'admin-1' });
  const list = await priceLookup.list({ modelId: MODEL.modelId });
  assert.equal(list.total, 1);
  assert.equal(list.lookups[0].modelId, MODEL.modelId);
  const failed = await priceLookup.list({ status: 'failed' });
  assert.equal(failed.total, 0);
});

test('路由最小角色检查：查看者可读，运营不能查价，管理员可发起与采用', async () => {
  const { priceLookup } = setup(officialAdapter([candidate()]));
  const routeList = priceLookupRoutes();

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
      req: { headers: {}, socket: {} },
      res: { setHeader() {} },
      reply,
    });
    return captured;
  }

  const user = role => ({
    priceLookup, auth: {}, session: { user: { id: `u-${role}`, role } },
  });

  const viewer = user('viewer');
  assert.equal((await invoke('GET', '/api/price-lookups', { ctx: viewer })).status, 200);
  await assert.rejects(
    invoke('POST', '/api/price-lookups', { ctx: viewer, body: MODEL }),
    { code: 'FORBIDDEN', status: 403 },
  );

  const operator = user('operator');
  await assert.rejects(
    invoke('POST', '/api/price-lookups', { ctx: operator, body: MODEL }),
    { code: 'FORBIDDEN', status: 403 },
  );

  const admin = user('admin');
  const started = await invoke('POST', '/api/price-lookups', { ctx: admin, body: MODEL });
  assert.equal(started.status, 201);
  const candidateId = started.payload.candidates[0].id;
  await assert.rejects(
    invoke('POST', `/api/price-candidates/${candidateId}/apply`, {
      ctx: viewer, body: { basis: '越权采用' },
    }),
    { code: 'FORBIDDEN', status: 403 },
  );
  const applied = await invoke('POST', `/api/price-candidates/${candidateId}/apply`, {
    ctx: admin, body: { basis: '管理员核对后采用' },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.payload.candidate.status, 'adopted');
  assert.equal(applied.payload.price.version, 1);

  // 本机单用户模式（未配置账号体系）保留原有行为。
  const local = { priceLookup };
  const localLookup = await invoke('POST', '/api/price-lookups', { ctx: local, body: MODEL });
  assert.equal(localLookup.status, 201);
  const localApply = await invoke('POST', `/api/price-candidates/${localLookup.payload.candidates[0].id}/apply`, {
    ctx: local, body: { basis: '本机管理员采用' },
  });
  assert.equal(localApply.status, 200);
});
