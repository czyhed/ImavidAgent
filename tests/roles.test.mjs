import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import { AuthService } from '../server/auth.mjs';
import { GenerationService } from '../server/jobs.mjs';
import {
  businessWorkspaceId, creationWorkspaceId, hasRole, jobWorkspaceId,
  requireAdmin, requireJobAccess, requireOperator, requireUser, requireViewer,
} from '../server/access.mjs';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASS = 'CorrectHorse123';
const MEMBER_PASS = 'MemberPass12345';
const MODEL = {
  id: 'test:image', providerId: 'test', upstreamModel: 'image', kind: 'image',
  operations: ['generate', 'edit'], sizes: ['1024x1024'], qualities: ['low'],
};

const requestBody = (patch = {}) => ({
  requestId: randomUUID(), modelId: MODEL.id, prompt: 'A white storage box',
  size: '1024x1024', quality: 'low', operation: 'generate', ...patch,
});

const actor = (role, workspaceId = 'ws-a') => ({
  auth: {}, user: { id: `${role}-id`, role, active: true, workspaceId }, session: {},
});

const succeededJob = (id, workspaceId) => ({
  id,
  inputHash: 'irrelevant',
  input: {
    modelId: MODEL.id, prompt: 'seed', size: '1024x1024', quality: 'low',
    operation: 'generate', sourceJobId: null, workspaceId,
  },
  workspaceId,
  status: 'succeeded',
  upstreamId: randomUUID(),
  output: { key: `generation/${id}/result.png`, contentType: 'image/png', filename: `${id}.png`, bytes: 4 },
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

class MemoryAuthStore {
  workspaces = new Map();
  users = new Map();
  sessions = new Map();

  async findUserByEmail(email) {
    return [...this.users.values()].find(user => user.email === email) || null;
  }

  async getUser(id) { return this.users.get(id) || null; }
  async listUsers() { return [...this.users.values()]; }
  async countActiveAdmins() {
    return [...this.users.values()].filter(user => user.role === 'admin' && user.active).length;
  }

  async createInitialAdmin({ workspace, user }) {
    if ([...this.users.values()].some(existing => existing.role === 'admin')) {
      throw new AppError('SETUP_COMPLETE', '管理员已初始化。', 409);
    }
    const ws = { id: randomUUID(), name: workspace.name, createdAt: new Date() };
    this.workspaces.set(ws.id, ws);
    const row = {
      ...user, id: randomUUID(), workspaceId: ws.id, createdAt: new Date(), updatedAt: new Date(),
    };
    this.users.set(row.id, row);
    return { workspace: ws, user: row };
  }

  async createUser(user) {
    if ([...this.users.values()].some(existing => existing.email === user.email)) {
      throw new AppError('MEMBER_EXISTS', '该邮箱已被使用。', 409);
    }
    const row = { ...user, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    this.users.set(row.id, row);
    return row;
  }

  async updateUser(id, patch) {
    const row = this.users.get(id);
    Object.assign(row, patch, { updatedAt: new Date() });
    return { ...row };
  }

  async createSession(session) {
    this.sessions.set(session.tokenHash, {
      ...session, id: randomUUID(), createdAt: new Date(), revokedAt: null,
    });
  }

  async findSessionByHash(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date()) return null;
    const user = this.users.get(session.userId);
    if (!user || !user.active) return null;
    return { session: { ...session }, user: { ...user } };
  }

  async revokeSession(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (session) session.revokedAt = new Date();
  }

  async revokeUserSessions(userId, exceptTokenHash = null) {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt && session.tokenHash !== exceptTokenHash) {
        session.revokedAt = new Date();
      }
    }
  }
}

class MemoryJobStore {
  rows = new Map();

  async get(id) { return this.rows.get(id) || null; }

  async list(workspaceId = null) {
    const rows = [...this.rows.values()];
    return workspaceId ? rows.filter(job => jobWorkspaceId(job) === workspaceId) : rows;
  }

  async insert(job) {
    if (this.rows.has(job.id)) return this.rows.get(job.id);
    const row = { ...job, status: 'queued', createdAt: new Date(), updatedAt: new Date() };
    this.rows.set(row.id, row);
    return row;
  }

  async update(id, patch) {
    Object.assign(this.rows.get(id), patch, { updatedAt: new Date() });
    return this.rows.get(id);
  }
}

class MemoryProducts {
  rows = new Map();

  async list() {
    return {
      products: [...this.rows.values()], total: this.rows.size,
      limit: 20, offset: 0, nextOffset: null,
    };
  }

  async create(body) {
    const product = {
      id: randomUUID(), name: body?.name || '未命名商品', version: 1,
      status: 'draft', skus: [], workspaceId: 'local',
    };
    this.rows.set(product.id, product);
    return { ...product };
  }

  async get(id) {
    const product = this.rows.get(id);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。', 404);
    return { ...product };
  }

  async update(id, body) {
    const product = await this.get(id);
    return { ...product, name: body?.name || product.name, version: product.version + 1 };
  }

  async confirm(id) {
    const product = await this.get(id);
    return { ...product, status: 'confirmed' };
  }

  async versions(id) {
    await this.get(id);
    return { productId: id, version: 1, versions: [], total: 0, limit: 20, offset: 0, nextOffset: null };
  }
}

function fakeChannels() {
  const calls = [];
  return {
    calls,
    async add() { calls.push('add'); return { channel: { id: 'ch_test' }, models: [], warning: null }; },
    async remove() { calls.push('remove'); return { id: 'ch_test' }; },
    async setEnabled() { calls.push('enabled'); return { id: 'ch_test', enabled: false }; },
  };
}

function fakeGateway() {
  const invokes = [];
  return {
    invokes,
    async registry() { return { models: [], defaults: [], aliases: [] }; },
    async setDefault(body) { return body; },
    async setAlias(body) { return body; },
    async invoke(body) {
      invokes.push(body);
      return { call: { id: randomUUID(), status: 'succeeded', capability: 'text.chat' } };
    },
    async getCall(id) { return { id, status: 'succeeded' }; },
  };
}

function fakeRegistry() {
  return {
    checkedAt: Date.now(),
    publicCatalog() { return { models: [], providers: [] }; },
    async refresh() { this.checkedAt = Date.now(); return this.publicCatalog(); },
  };
}

function fakeService(store) {
  return {
    async create(body, { workspaceId = null } = {}) {
      const workspace = workspaceId || 'local';
      return store.insert({
        id: body.requestId,
        input: {
          modelId: body.modelId, prompt: body.prompt, size: body.size, quality: body.quality,
          operation: body.operation || 'generate', sourceJobId: body.sourceJobId || null,
          workspaceId: workspace,
        },
        workspaceId: workspace,
        status: 'queued',
        error: null,
      });
    },
    async reconcile(id) {
      const job = await store.get(id);
      return { ...job, status: 'running' };
    },
  };
}

async function startHttp(t, { seed = [] } = {}) {
  const authStore = new MemoryAuthStore();
  const auth = new AuthService(authStore);
  const store = new MemoryJobStore();
  for (const job of seed) store.rows.set(job.id, job);
  const products = new MemoryProducts();
  const channels = fakeChannels();
  const gateway = fakeGateway();
  const registry = fakeRegistry();
  const assets = { async get() { return Readable.from([Buffer.from([137, 80, 78, 71])]); } };
  const service = fakeService(store);
  const server = createServer({
    store, assets, registry, service, channels, auth, gateway, products,
    port: 0, root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const fetchJson = async (response) => ({ response, body: await response.json() });
  const token = (await fetchJson(await fetch(`${base}/api/session`))).body.csrfToken;

  const request = (method, path, { cookie, body } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (['POST', 'PATCH', 'DELETE'].includes(method)) headers['X-CSRF-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const setup = () => request('POST', '/api/setup/admin', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASS, displayName: '管理员', workspaceName: '商境' },
  });
  const login = async (email, password) => {
    const response = await request('POST', '/api/session', { body: { email, password } });
    return {
      response,
      body: await response.json(),
      cookie: (response.headers.get('set-cookie') || '').split(';')[0],
    };
  };
  const createMember = async (role, adminCookie) => {
    const created = await fetchJson(await request('POST', '/api/users', {
      cookie: adminCookie,
      body: { email: `${role}@example.test`, password: MEMBER_PASS, displayName: role, role },
    }));
    assert.equal(created.response.status, 201);
    // 直接跳过首次改密，专注角色矩阵；改密流程由 auth.test.mjs 覆盖。
    await authStore.updateUser(created.body.user.id, { mustChangePassword: false });
    const session = await login(`${role}@example.test`, MEMBER_PASS);
    assert.equal(session.response.status, 200);
    return { user: created.body.user, cookie: session.cookie, role };
  };

  return {
    base, token, authStore, store, products, channels, gateway, registry,
    request, fetchJson, setup, login, createMember,
  };
}

test('role helpers: viewer reads, operator writes, admin manages; auth off keeps legacy access', () => {
  for (const role of ['viewer', 'operator', 'admin']) {
    assert.equal(requireViewer(actor(role)).role, role);
    assert.equal(requireUser(actor(role)).role, role);
  }
  assert.equal(requireOperator(actor('operator')).role, 'operator');
  assert.equal(requireAdmin(actor('admin')).role, 'admin');
  assert.throws(() => requireOperator(actor('viewer')), { code: 'FORBIDDEN', status: 403 });
  assert.throws(() => requireAdmin(actor('operator')), { code: 'FORBIDDEN', status: 403 });
  assert.throws(() => requireAdmin(actor('viewer')), { code: 'FORBIDDEN', status: 403 });
  assert.throws(() => requireUser({ auth: {}, user: null }), { code: 'UNAUTHENTICATED', status: 401 });
  assert.throws(() => requireUser({ auth: {}, user: { role: 'admin', active: false } }), {
    code: 'UNAUTHENTICATED', status: 401,
  });

  // 登录关闭时保留本机单用户行为，但绝不在启用后放行。
  assert.equal(requireAdmin({}), null);
  assert.equal(requireAdmin({ auth: null, user: null }), null);
  assert.equal(requireUser({ auth: undefined }), null);

  assert.equal(hasRole({ role: 'operator', active: true }, ['admin', 'operator']), true);
  assert.equal(hasRole({ role: 'operator', active: false }, ['admin', 'operator']), false);
  assert.equal(businessWorkspaceId({ auth: null }), null);
  assert.equal(creationWorkspaceId({ auth: null }), 'local');
  assert.equal(businessWorkspaceId(actor('viewer', 'ws-x')), 'ws-x');
  assert.equal(creationWorkspaceId(actor('viewer', 'ws-x')), 'ws-x');
});

test('job access helpers reject guessed UUIDs from another workspace and missing jobs', () => {
  const own = { input: { workspaceId: 'ws-a' } };
  const foreign = { input: { workspaceId: 'ws-b' } };
  assert.equal(requireJobAccess({}, foreign), foreign); // auth off
  assert.equal(requireJobAccess(actor('viewer'), own), own);
  assert.throws(() => requireJobAccess(actor('viewer'), foreign), { code: 'FORBIDDEN', status: 403 });
  assert.throws(() => requireJobAccess(actor('admin'), foreign), { code: 'FORBIDDEN', status: 403 });
  assert.throws(() => requireJobAccess(actor('viewer'), null), { code: 'NOT_FOUND', status: 404 });
  assert.equal(jobWorkspaceId(own), 'ws-a');
  assert.equal(jobWorkspaceId({ workspaceId: 'ws-c' }), 'ws-c');
  assert.equal(jobWorkspaceId({}), null);
});

test('unauthenticated requests get 401 after login is enabled', async t => {
  const h = await startHttp(t);
  for (const path of ['/api/products', '/api/jobs', '/api/models', '/api/models/registry', '/api/users']) {
    assert.equal((await h.request('GET', path)).status, 401, path);
  }
  assert.equal((await h.request('GET', `/api/jobs/${randomUUID()}/image`)).status, 401);
  assert.equal((await h.request('POST', '/api/jobs', { body: requestBody() })).status, 401);
  assert.equal((await h.request('POST', '/api/products', { body: { name: '匿名' } })).status, 401);
  assert.equal((await h.request('GET', '/api/session')).status, 200);
});

test('three-role matrix across products, jobs, channels, models and downloads', async t => {
  const h = await startHttp(t);
  const setup = await h.fetchJson(await h.setup());
  assert.equal(setup.response.status, 201);
  const admin = {
    role: 'admin',
    cookie: (await h.login(ADMIN_EMAIL, ADMIN_PASS)).cookie,
  };
  const operator = await h.createMember('operator', admin.cookie);
  const viewer = await h.createMember('viewer', admin.cookie);
  const workspaceId = setup.body.user.workspaceId;
  const ownJobId = randomUUID();
  h.store.rows.set(ownJobId, succeededJob(ownJobId, workspaceId));

  const check = async (who, method, path, expected, options = {}) => {
    const response = await h.request(method, path, { cookie: who.cookie, ...options });
    assert.equal(response.status, expected, `${who.role} ${method} ${path}`);
    return response;
  };
  const createProduct = async (who, name) => {
    const response = await check(who, 'POST', '/api/products', 201, { body: { name } });
    return (await response.json()).product;
  };

  // 管理员：全部可读可写，包含成员、渠道密钥、默认模型与价格类配置。
  await check(admin, 'GET', '/api/users', 200);
  await check(admin, 'POST', '/api/users', 201, {
    body: { email: 'extra@example.test', password: MEMBER_PASS, role: 'viewer' },
  });
  const adminProduct = await createProduct(admin, '管理员商品');
  await check(admin, 'GET', `/api/products/${adminProduct.id}`, 200);
  await check(admin, 'GET', `/api/products/${adminProduct.id}/versions`, 200);
  await check(admin, 'PATCH', `/api/products/${adminProduct.id}`, 200, { body: { name: '管理员改' } });
  await check(admin, 'POST', `/api/products/${adminProduct.id}/confirm`, 200, { body: {} });
  await check(admin, 'GET', '/api/jobs', 200);
  await check(admin, 'POST', '/api/jobs', 202, { body: requestBody() });
  await check(admin, 'POST', `/api/jobs/${ownJobId}/reconcile`, 202, { body: {} });
  await check(admin, 'GET', `/api/jobs/${ownJobId}`, 200);
  await check(admin, 'GET', `/api/jobs/${ownJobId}/image`, 200);
  await check(admin, 'GET', `/api/jobs/${ownJobId}/image?download=1`, 200);
  await check(admin, 'POST', '/api/channels', 201, { body: { name: '渠道' } });
  await check(admin, 'POST', '/api/channels/ch_test/enabled', 200, { body: { enabled: false } });
  await check(admin, 'DELETE', '/api/channels/ch_test', 200);
  await check(admin, 'GET', '/api/models', 200);
  await check(admin, 'POST', '/api/models/refresh', 200, { body: {} });
  await check(admin, 'GET', '/api/models/registry', 200);
  await check(admin, 'POST', '/api/model-defaults', 200, {
    body: { capability: 'text.chat', modelId: 'deepseek:deepseek-flash' },
  });
  await check(admin, 'POST', '/api/model-aliases', 200, {
    body: { alias: 'planner', modelId: 'deepseek:deepseek-flash' },
  });
  await check(admin, 'POST', '/api/model-gateway/invoke', 200, { body: { capability: 'text.chat' } });
  await check(admin, 'GET', `/api/model-calls/${randomUUID()}`, 200);

  // 运营：可创建与执行生产对象，但不能管理成员、渠道密钥或默认模型。
  await check(operator, 'GET', '/api/users', 403);
  await check(operator, 'POST', '/api/users', 403, {
    body: { email: 'by-operator@example.test', password: MEMBER_PASS, role: 'viewer' },
  });
  const operatorProduct = await createProduct(operator, '运营商品');
  await check(operator, 'GET', `/api/products/${operatorProduct.id}`, 200);
  await check(operator, 'PATCH', `/api/products/${operatorProduct.id}`, 200, { body: { name: '运营改' } });
  await check(operator, 'POST', `/api/products/${operatorProduct.id}/confirm`, 200, { body: {} });
  await check(operator, 'GET', '/api/jobs', 200);
  await check(operator, 'POST', '/api/jobs', 202, { body: requestBody() });
  await check(operator, 'POST', `/api/jobs/${ownJobId}/reconcile`, 202, { body: {} });
  await check(operator, 'GET', `/api/jobs/${ownJobId}/image`, 200);
  await check(operator, 'POST', '/api/channels', 403, { body: { name: '渠道' } });
  await check(operator, 'POST', '/api/channels/ch_test/enabled', 403, { body: { enabled: false } });
  await check(operator, 'DELETE', '/api/channels/ch_test', 403);
  await check(operator, 'GET', '/api/models', 200);
  await check(operator, 'POST', '/api/models/refresh', 403, { body: {} });
  await check(operator, 'GET', '/api/models/registry', 200);
  await check(operator, 'POST', '/api/model-defaults', 403, { body: { capability: 'text.chat' } });
  await check(operator, 'POST', '/api/model-aliases', 403, { body: { alias: 'x' } });
  await check(operator, 'POST', '/api/model-gateway/invoke', 200, { body: { capability: 'text.chat' } });
  await check(operator, 'GET', `/api/model-calls/${randomUUID()}`, 403);

  // 查看者：只读，下载与任务事件可读；任何写入与执行都被拒绝。
  await check(viewer, 'GET', '/api/users', 403);
  await check(viewer, 'POST', '/api/users', 403, {
    body: { email: 'by-viewer@example.test', password: MEMBER_PASS, role: 'viewer' },
  });
  await check(viewer, 'GET', '/api/products', 200);
  await check(viewer, 'GET', `/api/products/${operatorProduct.id}`, 200);
  await check(viewer, 'GET', `/api/products/${operatorProduct.id}/versions`, 200);
  await check(viewer, 'POST', '/api/products', 403, { body: { name: '查看者商品' } });
  await check(viewer, 'PATCH', `/api/products/${operatorProduct.id}`, 403, { body: { name: '越权' } });
  await check(viewer, 'POST', `/api/products/${operatorProduct.id}/confirm`, 403, { body: {} });
  await check(viewer, 'GET', '/api/jobs', 200);
  await check(viewer, 'GET', `/api/jobs/${ownJobId}`, 200);
  await check(viewer, 'GET', `/api/jobs/${ownJobId}/image`, 200);
  await check(viewer, 'POST', '/api/jobs', 403, { body: requestBody() });
  await check(viewer, 'POST', `/api/jobs/${ownJobId}/reconcile`, 403, { body: {} });
  await check(viewer, 'POST', '/api/channels', 403, { body: { name: '渠道' } });
  await check(viewer, 'POST', '/api/channels/ch_test/enabled', 403, { body: { enabled: false } });
  await check(viewer, 'DELETE', '/api/channels/ch_test', 403);
  await check(viewer, 'GET', '/api/models', 200);
  await check(viewer, 'POST', '/api/models/refresh', 403, { body: {} });
  await check(viewer, 'GET', '/api/models/registry', 200);
  await check(viewer, 'POST', '/api/model-defaults', 403, { body: { capability: 'text.chat' } });
  await check(viewer, 'POST', '/api/model-aliases', 403, { body: { alias: 'x' } });
  await check(viewer, 'POST', '/api/model-gateway/invoke', 403, { body: { capability: 'text.chat' } });
  await check(viewer, 'GET', `/api/model-calls/${randomUUID()}`, 403);

  // 拒绝发生在业务服务之前：越权请求没有真的创建渠道或模型调用。
  assert.deepEqual(h.channels.calls, ['add', 'enabled', 'remove']);
  assert.equal(h.gateway.invokes.length, 2);
});

test('guessing a job UUID cannot cross workspaces, including list and download', async t => {
  const h = await startHttp(t);
  const setup = await h.fetchJson(await h.setup());
  const admin = { role: 'admin', cookie: (await h.login(ADMIN_EMAIL, ADMIN_PASS)).cookie };
  const operator = await h.createMember('operator', admin.cookie);
  const viewer = await h.createMember('viewer', admin.cookie);
  const workspaceId = setup.body.user.workspaceId;
  const ownJobId = randomUUID();
  const foreignJobId = randomUUID();
  h.store.rows.set(ownJobId, succeededJob(ownJobId, workspaceId));
  h.store.rows.set(foreignJobId, succeededJob(foreignJobId, 'another-workspace'));

  for (const who of [admin, operator, viewer]) {
    const own = await h.request('GET', `/api/jobs/${ownJobId}`, { cookie: who.cookie });
    assert.equal(own.status, 200, `${who.role} own job`);
    for (const [method, suffix] of [['GET', ''], ['GET', '/image'], ['POST', '/reconcile']]) {
      const response = await h.request(method, `/api/jobs/${foreignJobId}${suffix}`, { cookie: who.cookie, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 403, `${who.role} ${method} ${suffix || 'job'}`);
    }
    const list = await (await h.request('GET', '/api/jobs', { cookie: who.cookie })).json();
    const ids = list.jobs.map(job => job.id);
    assert.ok(ids.includes(ownJobId), `${who.role} sees own job`);
    assert.equal(ids.includes(foreignJobId), false, `${who.role} does not see foreign job`);
  }
});

test('generation service records workspace ownership and blocks cross-workspace id/source reuse', async () => {
  const store = new MemoryJobStore();
  const registry = { providers: new Map(), async resolve() { return MODEL; } };
  const service = new GenerationService(store, { async put() { return { key: 'x' }; } }, registry);

  const body = requestBody();
  const first = await service.create(body, { workspaceId: 'ws-a' });
  assert.equal(first.workspaceId, 'ws-a');
  assert.equal(first.input.workspaceId, 'ws-a');
  assert.equal(JSON.stringify(first).includes('ws-a'), true);

  await assert.rejects(service.create(body, { workspaceId: 'ws-b' }), {
    code: 'FORBIDDEN', status: 403,
  });

  await store.update(first.id, { status: 'succeeded', upstreamId: randomUUID() });
  const editBody = requestBody({ operation: 'edit', sourceJobId: first.id });
  await assert.rejects(service.create(editBody, { workspaceId: 'ws-b' }), {
    code: 'SOURCE_FORBIDDEN', status: 403,
  });

  const edit = await service.create(editBody, { workspaceId: 'ws-a' });
  assert.equal(edit.input.sourceUpstreamId, first.upstreamId);
  assert.deepEqual(
    (await store.list('ws-a')).map(job => job.id).sort(),
    [first.id, edit.id].sort(),
  );
  assert.deepEqual((await store.list('ws-b')), []);
});
