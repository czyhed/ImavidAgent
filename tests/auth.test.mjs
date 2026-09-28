import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import {
  AuthService, hashPassword, verifyPassword, newSessionToken, hashSessionToken,
} from '../server/auth.mjs';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASS = 'CorrectHorse123';
const MEMBER_TEMP = 'TempPass12345';
const MEMBER_PASS = 'MemberPass12345';
const NEW_PASS = 'ChangedHorse123';

class MemoryAuthStore {
  workspaces = new Map();
  users = new Map();
  sessions = new Map();

  async findUserByEmail(email) {
    return [...this.users.values()].find(user => user.email === email) || null;
  }

  async getUser(id) {
    return this.users.get(id) || null;
  }

  async listUsers() {
    return [...this.users.values()];
  }

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

async function startHttp(t, { uploads } = {}) {
  const authStore = new MemoryAuthStore();
  const auth = new AuthService(authStore);
  const server = createServer({
    store: { async list() { return []; } },
    assets: {}, registry: {}, service: {}, auth, port: 0, root: new URL('../', import.meta.url),
    ...(uploads ? { uploads } : {}),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const csrf = async () => (await (await fetch(`${base}/api/session`)).json()).csrfToken;
  const post = (path, token, body, cookie) => fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const setup = async () => {
    const token = await csrf();
    const response = await post('/api/setup/admin', token, {
      email: ADMIN_EMAIL, password: ADMIN_PASS, displayName: '管理员', workspaceName: '商境',
    });
    return { response, token, body: await response.json() };
  };
  const login = async (email, password, token) => {
    const response = await post('/api/session', token ?? await csrf(), { email, password });
    return {
      response,
      body: await response.json(),
      cookie: (response.headers.get('set-cookie') || '').split(';')[0],
    };
  };
  return { base, auth, authStore, csrf, post, setup, login };
}

test('password hashes are salted and session tokens are stored only as SHA-256 hashes', async () => {
  const first = await hashPassword('CorrectHorse123');
  const second = await hashPassword('CorrectHorse123');
  assert.notEqual(first, second);
  assert.equal(first.includes('CorrectHorse123'), false);
  assert.equal(await verifyPassword('CorrectHorse123', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.equal(await verifyPassword('CorrectHorse123', 'not-a-hash'), false);

  const token = newSessionToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(newSessionToken(), token);
  const hash = hashSessionToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes(token), false);
});

test('five consecutive login failures lock the account for fifteen minutes in memory', async () => {
  const store = new MemoryAuthStore();
  let clock = 1_700_000_000_000;
  const auth = new AuthService(store, { now: () => clock });
  await auth.setupAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASS }, '127.0.0.1');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.login(ADMIN_EMAIL, 'wrong-password'), { code: 'INVALID_CREDENTIALS', status: 401 });
  }
  await assert.rejects(auth.login(ADMIN_EMAIL, ADMIN_PASS), { code: 'LOGIN_LOCKED', status: 429 });

  clock += 15 * 60 * 1000 + 1;
  const session = await auth.login(ADMIN_EMAIL, ADMIN_PASS);
  assert.ok(session.token);

  // 计数只在进程内存中；新实例（等价于服务重启）没有旧锁定。
  const restarted = new AuthService(store);
  const afterRestart = await restarted.login(ADMIN_EMAIL, ADMIN_PASS);
  assert.ok(afterRestart.token);
});

test('admin initialisation stays local even when a reverse proxy connects from loopback', async (t) => {
  const { base, csrf, authStore } = await startHttp(t);
  const token = await csrf();
  const response = await fetch(`${base}/api/setup/admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
      'X-Forwarded-For': '203.0.113.9',
    },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SETUP_LOCAL_ONLY');
  assert.equal(authStore.users.size, 0);
});

test('initialisation is local-only and one-time and the last administrator is protected', async () => {
  const store = new MemoryAuthStore();
  const auth = new AuthService(store);

  await assert.rejects(
    auth.setupAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASS }, '203.0.113.9'),
    { code: 'SETUP_LOCAL_ONLY', status: 403 },
  );
  assert.equal(store.users.size, 0);

  const { user: admin } = await auth.setupAdmin(
    { email: ADMIN_EMAIL, password: ADMIN_PASS, displayName: '管理员', workspaceName: '商境' },
    '::ffff:127.0.0.1',
  );
  assert.equal(admin.role, 'admin');
  assert.equal(admin.mustChangePassword, false);

  await assert.rejects(
    auth.setupAdmin({ email: 'other@example.test', password: ADMIN_PASS }, '127.0.0.1'),
    { code: 'SETUP_COMPLETE', status: 409 },
  );
  await assert.rejects(
    auth.updateUser(admin, admin.id, { enabled: false }),
    { code: 'LAST_ADMIN', status: 409 },
  );
  await assert.rejects(
    auth.updateUser(admin, admin.id, { role: 'operator' }),
    { code: 'LAST_ADMIN', status: 409 },
  );

  const second = await auth.createUser(admin, {
    email: 'second@example.test', password: MEMBER_TEMP, displayName: '第二管理员', role: 'admin',
  });
  assert.equal(second.mustChangePassword, true);
  await auth.updateUser(admin, admin.id, { role: 'operator' });

  const secondActor = await store.getUser(second.id);
  await assert.rejects(
    auth.updateUser(secondActor, second.id, { enabled: false }),
    { code: 'LAST_ADMIN', status: 409 },
  );
  await assert.rejects(
    auth.updateUser(secondActor, second.id, { role: 'viewer' }),
    { code: 'LAST_ADMIN', status: 409 },
  );
});

test('disabling, resetting or demoting a member revokes sessions immediately', async () => {
  const store = new MemoryAuthStore();
  const auth = new AuthService(store);
  const { user: admin } = await auth.setupAdmin(
    { email: ADMIN_EMAIL, password: ADMIN_PASS }, '127.0.0.1',
  );
  const member = await auth.createUser(admin, { email: 'member@example.test', password: MEMBER_TEMP });

  const firstLogin = await auth.login('member@example.test', MEMBER_TEMP);
  assert.ok(await auth.authenticate(firstLogin.token));
  await auth.updateUser(admin, member.id, { password: MEMBER_PASS });
  assert.equal(await auth.authenticate(firstLogin.token), null);
  await assert.rejects(auth.login('member@example.test', MEMBER_TEMP), { code: 'INVALID_CREDENTIALS' });

  const secondLogin = await auth.login('member@example.test', MEMBER_PASS);
  assert.ok(await auth.authenticate(secondLogin.token));
  // 即使会话行尚未删除，停用后的成员也不能再通过鉴权。
  await store.updateUser(member.id, { active: false });
  assert.equal(await auth.authenticate(secondLogin.token), null);

  await store.updateUser(member.id, { active: true });
  const thirdLogin = await auth.login('member@example.test', MEMBER_PASS);
  await auth.updateUser(admin, member.id, { enabled: false });
  assert.equal(await auth.authenticate(thirdLogin.token), null);
});

test('HTTP requires login, enforces CSRF, sets a strict HttpOnly cookie and honours logout', async t => {
  const h = await startHttp(t);

  assert.equal((await fetch(`${h.base}/api/jobs`)).status, 401);

  const setup = await h.setup();
  assert.equal(setup.response.status, 201);
  assert.equal(setup.body.user.role, 'admin');
  assert.equal(JSON.stringify(setup.body).includes(ADMIN_PASS), false);
  assert.equal(JSON.stringify(setup.body).includes('passwordHash'), false);
  assert.equal((await h.setup()).response.status, 409);

  const noCsrf = await fetch(`${h.base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  assert.equal(noCsrf.status, 403);

  const token = await h.csrf();
  const bad = await h.login(ADMIN_EMAIL, 'WrongPassword123', token);
  assert.equal(bad.response.status, 401);
  assert.equal(JSON.stringify(bad.body).includes('WrongPassword123'), false);

  const good = await h.login(ADMIN_EMAIL, ADMIN_PASS, token);
  assert.equal(good.response.status, 200);
  const setCookie = good.response.headers.get('set-cookie');
  assert.match(setCookie, /^sj_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.equal(good.body.authenticated, true);
  assert.equal(JSON.stringify(good.body).includes(ADMIN_PASS), false);

  const jobs = await fetch(`${h.base}/api/jobs`, { headers: { Cookie: good.cookie } });
  assert.equal(jobs.status, 200);
  assert.deepEqual(await jobs.json(), { jobs: [] });

  const session = await (await fetch(`${h.base}/api/session`, { headers: { Cookie: good.cookie } })).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.user.email, ADMIN_EMAIL);
  assert.equal(JSON.stringify(session).includes('passwordHash'), false);

  const logout = await fetch(`${h.base}/api/session`, {
    method: 'DELETE', headers: { 'X-CSRF-Token': token, Cookie: good.cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${h.base}/api/jobs`, { headers: { Cookie: good.cookie } })).status, 401);
});

test('administrator manages members, first login forces a password change and role checks hold', async t => {
  const h = await startHttp(t);
  await h.setup();
  const token = await h.csrf();
  const adminLogin = await h.login(ADMIN_EMAIL, ADMIN_PASS, token);

  const created = await h.post('/api/users', token, {
    email: 'operator@example.test', password: MEMBER_TEMP, displayName: '运营', role: 'operator',
  }, adminLogin.cookie);
  assert.equal(created.status, 201);
  const member = (await created.json()).user;
  assert.equal(member.mustChangePassword, true);
  assert.equal(JSON.stringify(member).includes(MEMBER_TEMP), false);
  assert.equal(JSON.stringify(member).includes('passwordHash'), false);

  const memberLogin = await h.login('operator@example.test', MEMBER_TEMP, token);
  assert.equal(memberLogin.response.status, 200);
  assert.equal(memberLogin.body.mustChangePassword, true);
  assert.equal((await fetch(`${h.base}/api/jobs`, { headers: { Cookie: memberLogin.cookie } })).status, 403);

  const changed = await h.post('/api/account/password', token, {
    currentPassword: MEMBER_TEMP, newPassword: MEMBER_PASS,
  }, memberLogin.cookie);
  assert.equal(changed.status, 200);
  assert.equal((await fetch(`${h.base}/api/jobs`, { headers: { Cookie: memberLogin.cookie } })).status, 200);

  const forbidden = await fetch(`${h.base}/api/users`, { headers: { Cookie: memberLogin.cookie } });
  assert.equal(forbidden.status, 403);
  const forbiddenCreate = await h.post('/api/users', token, {
    email: 'other@example.test', password: MEMBER_TEMP,
  }, memberLogin.cookie);
  assert.equal(forbiddenCreate.status, 403);

  const disabled = await h.post(`/api/users/${member.id}`, token, { enabled: false }, adminLogin.cookie);
  assert.equal(disabled.status, 200);
  assert.equal((await fetch(`${h.base}/api/jobs`, { headers: { Cookie: memberLogin.cookie } })).status, 401);

  const selfDisable = await h.post(`/api/users/${adminLogin.body.user.id}`, token, { enabled: false }, adminLogin.cookie);
  assert.equal(selfDisable.status, 409);
  const selfDemote = await h.post(`/api/users/${adminLogin.body.user.id}`, token, { role: 'operator' }, adminLogin.cookie);
  assert.equal(selfDemote.status, 409);
});

test('changing a password keeps the current session and revokes other sessions', async t => {
  const h = await startHttp(t);
  await h.setup();
  const token = await h.csrf();
  const first = await h.login(ADMIN_EMAIL, ADMIN_PASS, token);
  const second = await h.login(ADMIN_EMAIL, ADMIN_PASS, token);

  const changed = await h.post('/api/account/password', token, {
    currentPassword: ADMIN_PASS, newPassword: NEW_PASS,
  }, first.cookie);
  assert.equal(changed.status, 200);

  assert.equal((await fetch(`${h.base}/api/jobs`, { headers: { Cookie: first.cookie } })).status, 200);
  assert.equal((await fetch(`${h.base}/api/jobs`, { headers: { Cookie: second.cookie } })).status, 401);
  assert.equal((await h.login(ADMIN_EMAIL, ADMIN_PASS, token)).response.status, 401);
  assert.equal((await h.login(ADMIN_EMAIL, NEW_PASS, token)).response.status, 200);
});

test('product image intake requires operator and its settings require administrator', async t => {
  const h = await startHttp(t);
  await h.setup();
  const token = await h.csrf();
  const admin = await h.login(ADMIN_EMAIL, ADMIN_PASS, token);
  await h.post('/api/users', token, {
    email: 'viewer@example.test', password: MEMBER_TEMP, displayName: '只读', role: 'viewer',
  }, admin.cookie);
  await h.post('/api/users', token, {
    email: 'operator@example.test', password: MEMBER_TEMP, displayName: '运营', role: 'operator',
  }, admin.cookie);
  const viewer = await h.login('viewer@example.test', MEMBER_TEMP, token);
  const operator = await h.login('operator@example.test', MEMBER_TEMP, token);
  // 首次登录必须改密，否则所有业务接口都会先被改密门槛拦截。
  assert.equal((await h.post('/api/account/password', token, {
    currentPassword: MEMBER_TEMP, newPassword: MEMBER_PASS,
  }, operator.cookie)).status, 200);

  const upload = cookie => fetch(`${h.base}/api/product-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': token, Cookie: cookie },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal((await upload(viewer.cookie)).status, 403);
  // 运营通过角色校验后才会触及存储服务；此处刻意没有注入 uploads，返回参数错误即证明已放行。
  const operatorUpload = await upload(operator.cookie);
  assert.notEqual(operatorUpload.status, 403);

  const settings = cookie => h.post('/api/product-images/input', token, { enabled: true }, cookie);
  assert.equal((await settings(operator.cookie)).status, 403);
  assert.equal((await settings(viewer.cookie)).status, 403);
  assert.equal((await settings(admin.cookie)).status, 503);
});

test('injected uploads service is scoped to the signed-in workspace', async t => {
  // 生产在 createServer 注入单一 ProductImageApi（默认工作空间 'local'）。
  // 登录后必须按会话工作空间派生作用域，否则商品原图会被判成不存在。
  const scopes = [];
  const image = {
    id: randomUUID(), productId: null, kind: 'screenshot', contentType: 'image/png',
    extension: 'png', bytes: 4, width: 64, height: 64, sha256: '0'.repeat(64),
    createdAt: new Date(),
  };
  const uploads = {
    forWorkspace(workspaceId) { scopes.push(workspaceId); return this; },
    async upload() { return image; },
    async list() { return { images: [], total: 0 }; },
  };
  const h = await startHttp(t, { uploads });
  await h.setup();
  const token = await h.csrf();
  const admin = await h.login(ADMIN_EMAIL, ADMIN_PASS, token);
  await h.post('/api/users', token, {
    email: 'scope@example.test', password: MEMBER_TEMP, displayName: '运营', role: 'operator',
  }, admin.cookie);
  const operator = await h.login('scope@example.test', MEMBER_TEMP, token);
  assert.equal((await h.post('/api/account/password', token, {
    currentPassword: MEMBER_TEMP, newPassword: MEMBER_PASS,
  }, operator.cookie)).status, 200);

  const uploaded = await fetch(`${h.base}/api/product-images?kind=screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': token, Cookie: operator.cookie },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(uploaded.status, 201);
  const listed = await fetch(`${h.base}/api/product-images`, { headers: { Cookie: operator.cookie } });
  assert.equal(listed.status, 200);
  assert.ok(scopes.length >= 2);
  assert.deepEqual([...new Set(scopes)], [operator.body.user.workspaceId]);
});
