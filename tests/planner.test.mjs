import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../server/errors.mjs';
import { ModelGateway } from '../server/gateway.mjs';
import { PlannerService, buildFactCorpus, findUnsupportedClaims, normalizeSnapshot } from '../server/planner.mjs';
import { createServer } from '../server/http.mjs';

// 测试只用模拟供应商与内存存储，不访问 PostgreSQL、不发起真实付费调用。
class MemoryStore {
  models = new Map();
  defaults = new Map();
  aliases = new Map();
  calls = new Map();
  byKey = new Map();

  async init() {}

  async upsertModel(model) {
    const existing = this.models.get(model.id);
    const row = {
      ...model,
      enabled: existing ? existing.enabled : model.enabled,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    };
    this.models.set(model.id, row);
    return row;
  }

  async listModels() { return [...this.models.values()]; }
  async getModel(id) { return this.models.get(id) || null; }
  async listDefaults() { return [...this.defaults.values()]; }
  async getDefault(capability) { return this.defaults.get(capability) || null; }

  async setDefault(capability, modelId) {
    const row = { capability, modelId, updatedAt: new Date() };
    this.defaults.set(capability, row);
    return row;
  }

  async listAliases() { return [...this.aliases.values()]; }
  async getAlias(alias) { return this.aliases.get(alias) || null; }

  async setAlias(alias, modelId) {
    const row = { alias, modelId, createdAt: new Date(), updatedAt: new Date() };
    this.aliases.set(alias, row);
    return row;
  }

  async beginCall(call) {
    const existing = this.byKey.get(call.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== call.requestHash) {
        throw new AppError('REQUEST_CONFLICT', '同一幂等键不能用于不同参数。', 409);
      }
      return { call: { ...existing }, created: false };
    }
    const row = {
      ...call,
      modelId: null,
      status: 'running',
      response: null,
      usage: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.calls.set(row.id, row);
    this.byKey.set(row.idempotencyKey, row);
    return { call: { ...row }, created: true };
  }

  async updateCall(id, patch) {
    const row = this.calls.get(id);
    Object.assign(row, patch, { updatedAt: new Date() });
    return { ...row };
  }

  async getCall(id) { return this.calls.get(id) || null; }
}

const TEXT_MODEL = 'deepseek:deepseek-flash';
const PROVIDERS = [{
  id: 'deepseek',
  name: 'DeepSeek',
  adapter: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  enabled: true,
  models: [{
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    capabilities: ['text.chat'],
  }],
}];

function fixture(content = modelPlan(), { configure = true } = {}) {
  const store = new MemoryStore();
  let calls = 0;
  const adapter = {
    async chat(args) {
      calls++;
      const produced = typeof content === 'function' ? content(args) : content;
      return {
        content: typeof produced === 'string' ? produced : JSON.stringify(produced),
        finishReason: 'stop',
        upstreamModel: args.upstreamModel,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  };
  const gateway = new ModelGateway(store, PROVIDERS, { deepseek: () => adapter });
  return {
    store,
    gateway,
    calls: () => calls,
    async ready() {
      await gateway.init();
      if (configure) await gateway.setDefault({ capability: 'text.chat', modelId: TEXT_MODEL });
      return gateway;
    },
  };
}

const SNAPSHOT = {
  productId: randomUUID(),
  workspaceId: 'local',
  version: 3,
  name: '燕麦色陶瓷杯',
  category: '杯具',
  description: '容量 320 mL，杯身燕麦色。',
  status: 'confirmed',
  confirmedAt: '2026-10-21T00:00:00.000Z',
  sellingPoints: ['杯身燕麦色，适合日常饮水'],
  forbiddenPhrases: ['不得宣称治疗功效'],
  skus: [{
    id: randomUUID(),
    spec: '单杯 / 燕麦色',
    selected: true,
    parameters: [
      { name: '材质', value: '陶瓷', unit: null },
      { name: '容量', value: '320', unit: 'mL' },
    ],
    price: { amount: 49, min: null, max: null, currency: 'CNY', type: 'sale', condition: null, capturedAt: null },
  }],
};

function promptSlots(overrides = {}) {
  return {
    subject: '以商品「燕麦色陶瓷杯」为唯一主体',
    scene: '简洁室内环境',
    composition: '正面视角，商品居中',
    lighting: '柔和自然光',
    style: '真实商品摄影风格',
    material: '燕麦色陶瓷杯身',
    mustKeep: '保持商品原有形状与颜色',
    forbidden: '不得添加文字或虚构卖点',
    aspectRatio: '1:1',
    ...overrides,
  };
}

function modelPlan(overrides = {}) {
  return {
    deliverables: [
      {
        type: 'white',
        title: '白底主图',
        purpose: '用于主图展示',
        quantity: 1,
        prompt: promptSlots(),
        copy: [],
        facts: ['燕麦色陶瓷杯'],
        reason: '主图合规',
      },
      {
        type: 'scene',
        title: '日常使用场景',
        purpose: '展示使用场景',
        quantity: 2,
        prompt: promptSlots({ aspectRatio: '3:4' }),
        copy: [],
        facts: ['容量 320 mL'],
        reason: '补充生活场景',
      },
    ],
    extensions: [{
      title: '使用前后对比',
      purpose: '同一空间整理前后，商品为唯一新增物品',
      prompt: promptSlots(),
      facts: [],
      reason: '类型库外的对比图',
    }],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    productSnapshot: structuredClone(SNAPSHOT),
    requirement: '突出日常饮水场景',
    ...overrides,
  };
}

test('类型库与事实语料只包含已确认资料', async () => {
  const f = fixture();
  await f.ready();
  const planner = new PlannerService(f.gateway);
  const result = await planner.plan(request());

  assert.equal(result.fallback, false);
  assert.equal(result.plan.deliverables.length, 2);
  assert.equal(result.plan.deliverables[0].type, 'white');
  assert.equal(result.plan.deliverables[1].quantity, 2);
  assert.equal(result.plan.extensions.length, 1);
  assert.equal(result.billing.mode, 'cost_only');
  assert.equal(result.planningCall.costOnly, true);
  assert.deepEqual(result.planningCall.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  assert.equal(f.calls(), 1);

  const corpus = buildFactCorpus(normalizeSnapshot(SNAPSHOT));
  assert.equal(corpus.text.includes('陶瓷'), true);
  assert.equal(corpus.numbers.has('320'), true);
  assert.equal(findUnsupportedClaims('食品级不锈钢 500 mL', corpus).length > 0, true);
});

test('编造事实被移除并标为待核实，不进入正式提示词与文案', async () => {
  const fabricated = modelPlan({
    deliverables: [{
      type: 'white',
      title: '食品级白底主图',
      purpose: '展示食品级安全',
      quantity: 1,
      prompt: promptSlots({
        subject: '商品「燕麦色陶瓷杯」500 mL 食品级不锈钢',
        material: '食品级不锈钢',
      }),
      copy: [{ slot: 'headline', text: '食品级安全 500 mL' }],
      facts: ['燕麦色陶瓷杯', '容量 320 mL', '食品级'],
      reason: '突出食品级材质',
    }],
    extensions: [],
  });
  const f = fixture(fabricated);
  await f.ready();
  const result = await new PlannerService(f.gateway).plan(request({ requirement: '突出食品级材质' }));

  const item = result.plan.deliverables[0];
  assert.equal(result.fallback, false);
  for (const banned of ['食品级', '500', '不锈钢']) {
    assert.equal(item.promptText.includes(banned), false, `正式提示词不应包含 ${banned}`);
  }
  assert.equal(item.prompt.subject, '商品「燕麦色陶瓷杯」');
  assert.equal(item.prompt.material, '颜色与表面以商品资料为准');
  assert.deepEqual(item.copy, []);
  assert.deepEqual(item.facts, ['燕麦色陶瓷杯', '容量 320 mL']);
  assert.equal(item.title, '白底主图 / 多角度');
  assert.equal(item.purpose, '正面白底、侧面、背面等主图合规用途');

  const claims = result.pendingVerification.map(entry => entry.claim);
  assert.equal(claims.includes('食品级'), true);
  assert.equal(claims.includes('500'), true);
  assert.equal(claims.includes('不锈钢'), true);
  assert.ok(result.pendingVerification.every(entry => entry.source === 'model' || entry.source === 'requirement'));
});

test('补充要求中的未核实说法会标为待核实且不进入提示词', async () => {
  const withClaim = modelPlan({
    deliverables: [{
      type: 'scene',
      title: '户外场景',
      purpose: '展示使用场景',
      quantity: 1,
      prompt: promptSlots({ aspectRatio: '3:4', scene: '户外防水场景' }),
      copy: [],
      facts: [],
      reason: '补充户外场景',
    }],
    extensions: [],
  });
  const f = fixture(withClaim);
  await f.ready();
  const result = await new PlannerService(f.gateway).plan(request({ requirement: '突出防水，多做 2 张户外场景' }));

  assert.equal(result.plan.deliverables[0].prompt.scene, '简洁纯色背景，突出商品');
  assert.equal(result.plan.deliverables[0].prompt.subject, '以商品「燕麦色陶瓷杯」为唯一主体');
  assert.equal(result.plan.deliverables[0].promptText.includes('防水'), false);
  const requirementFinding = result.pendingVerification.find(entry => entry.claim === '防水');
  assert.equal(requirementFinding.source, 'requirement');
  // “2 张”是数量不是事实，不应误报。
  assert.equal(result.pendingVerification.some(entry => entry.claim === '2'), false);
});

test('文本模型不可用时回退类型库默认清单，不发起付费调用', async () => {
  const f = fixture(modelPlan(), { configure: false });
  await f.ready();
  const result = await new PlannerService(f.gateway).plan(request());

  assert.equal(f.calls(), 0);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'MODEL_NOT_CONFIGURED');
  assert.deepEqual(result.plan.deliverables.map(item => item.type), ['white', 'scene', 'selling', 'detail']);
  assert.equal(result.plan.extensions.length, 0);
  assert.equal(result.planningCall.costOnly, true);
  assert.equal(result.billing.mode, 'cost_only');
  for (const item of result.plan.deliverables) {
    assert.equal(typeof item.promptText, 'string');
    assert.equal(item.quantity, 1);
  }
});

test('没有模型网关时同样回退默认清单', async () => {
  const result = await new PlannerService(null).plan(request());
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'MODEL_UNAVAILABLE');
  assert.equal(result.plan.deliverables.length, 4);
  assert.equal(result.billing.reserved, false);
});

test('模型输出 schema 非法时回退默认清单，已记录调用用量', async () => {
  const f = fixture(JSON.stringify({ deliverables: [] }));
  await f.ready();
  const result = await new PlannerService(f.gateway).plan(request());

  assert.equal(f.calls(), 1);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT');
  assert.equal(result.plan.deliverables.length, 4);
  assert.equal(result.planningCall.usage.totalTokens, 150);
});

test('类型库外类型或越界分支数量都会被严格拒绝并回退', async () => {
  for (const bad of [
    modelPlan({ deliverables: [{ ...modelPlan().deliverables[0], type: 'video' }] }),
    modelPlan({ deliverables: [{ ...modelPlan().deliverables[0], quantity: 4 }] }),
    modelPlan({ deliverables: [{ ...modelPlan().deliverables[0], extra: true }] }),
    modelPlan({ deliverables: [{ ...modelPlan().deliverables[0], prompt: { ...promptSlots(), extra: 'x' } }] }),
  ]) {
    const f = fixture(bad);
    await f.ready();
    const result = await new PlannerService(f.gateway).plan(request());
    assert.equal(result.fallback, true);
    assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT');
  }
});

test('重复提交幂等：相同输入只调用一次并返回同一规划', async () => {
  const f = fixture();
  await f.ready();
  const planner = new PlannerService(f.gateway);
  const body = request();
  const first = await planner.plan(body);
  const second = await planner.plan(structuredClone(body));

  assert.equal(f.calls(), 1);
  assert.equal(first.planId, second.planId);
  assert.equal(first.planningCall.id, second.planningCall.id);
  assert.deepEqual(first, second);

  const changed = await planner.plan({ ...body, requirement: '换成户外场景' });
  assert.equal(f.calls(), 2);
  assert.notEqual(changed.planId, first.planId);
});

test('输入 schema 严格校验：未知字段、未确认资料、越界要求都被拒绝', async () => {
  const f = fixture();
  await f.ready();
  const planner = new PlannerService(f.gateway);

  await assert.rejects(planner.plan({ ...request(), extra: true }), { code: 'INVALID_FIELD', status: 422 });
  await assert.rejects(
    planner.plan({ productSnapshot: { ...SNAPSHOT, status: 'draft' } }),
    { code: 'SNAPSHOT_NOT_CONFIRMED', status: 409 },
  );
  await assert.rejects(
    planner.plan({ productSnapshot: { ...SNAPSHOT, unknownField: 'x' } }),
    { code: 'INVALID_FIELD', status: 422 },
  );
  await assert.rejects(planner.plan({ productSnapshot: { status: 'confirmed' } }), { code: 'INVALID_FIELD', status: 422 });
  await assert.rejects(planner.plan(request({ requirement: '要'.repeat(501) })), { code: 'INVALID_FIELD', status: 422 });
  await assert.rejects(
    planner.plan({
      productSnapshot: {
        ...SNAPSHOT,
        skus: [{ spec: '单杯', parameters: [{ name: '材质', value: '陶瓷', extra: true }] }],
      },
    }),
    { code: 'INVALID_FIELD', status: 422 },
  );
  assert.equal(f.calls(), 0);
});

test('HTTP 路由导出类型库并执行规划，非法 schema 返回 422', async t => {
  const f = fixture();
  await f.ready();
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    gateway: f.gateway, port: 0, root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  const typesResponse = await fetch(base + '/api/planner/types');
  assert.equal(typesResponse.status, 200);
  const library = await typesResponse.json();
  assert.deepEqual(library.types.map(item => item.type), ['white', 'scene', 'selling', 'detail', 'extension']);
  assert.equal(library.limits.deliverables, 10);
  assert.equal(library.types.find(item => item.type === 'white').aspectRatio, '1:1');

  const noToken = await fetch(base + '/api/planner/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()),
  });
  assert.equal(noToken.status, 403);

  const ok = await fetch(base + '/api/planner/plan', {
    method: 'POST', headers, body: JSON.stringify(request()),
  });
  assert.equal(ok.status, 200);
  const planned = await ok.json();
  assert.equal(planned.fallback, false);
  assert.equal(planned.plan.deliverables.length, 2);

  const invalid = await fetch(base + '/api/planner/plan', {
    method: 'POST', headers, body: JSON.stringify({ ...request(), extra: true }),
  });
  assert.equal(invalid.status, 422);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, 'INVALID_FIELD');
});
