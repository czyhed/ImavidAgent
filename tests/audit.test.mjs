import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import {
  AuditService,
  auditScope,
  normalizeListQuery,
  redactText,
  sanitizeDetail,
} from '../server/audit.mjs';

// In-memory repository with the same append-only contract as PgAuditRepository.
// Tests never reach PostgreSQL or any network service.
class MemoryAuditRepository {
  constructor() {
    this.audits = [];
    this.events = [];
  }

  async insertAudit(row) {
    const stored = { ...structuredClone(row), id: randomUUID() };
    this.audits.push(stored);
    return structuredClone(stored);
  }

  async listAudit(filters) {
    const matches = this.audits.filter(row => {
      if (filters.actorId && row.actorId !== filters.actorId) return false;
      if (filters.action && row.action !== filters.action) return false;
      if (filters.actionPrefix && !row.action.startsWith(filters.actionPrefix)) return false;
      if (filters.targetType && row.targetType !== filters.targetType) return false;
      if (filters.targetId && row.targetId !== filters.targetId) return false;
      if (filters.result && row.result !== filters.result) return false;
      if (filters.from && new Date(row.createdAt) < new Date(filters.from)) return false;
      if (filters.to && new Date(row.createdAt) > new Date(filters.to)) return false;
      return true;
    }).sort((a, b) => (new Date(b.createdAt) - new Date(a.createdAt))
      || b.id.localeCompare(a.id));
    return {
      total: matches.length,
      rows: matches.slice(filters.offset, filters.offset + filters.limit).map(row => structuredClone(row)),
    };
  }

  async insertJobEvent(row) {
    const stored = { ...structuredClone(row), id: randomUUID() };
    this.events.push(stored);
    return structuredClone(stored);
  }

  async listJobEvents(filters) {
    const matches = this.events.filter(row => row.jobId === filters.jobId
      && (!filters.event || row.event === filters.event))
      .sort((a, b) => (new Date(a.createdAt) - new Date(b.createdAt))
        || a.id.localeCompare(b.id));
    return {
      total: matches.length,
      rows: matches.slice(filters.offset, filters.offset + filters.limit).map(row => structuredClone(row)),
    };
  }
}

const WORKSPACE = randomUUID();
const actor = (role, email) => ({
  id: randomUUID(),
  workspaceId: WORKSPACE,
  email,
  role,
});

function fixture({ exportLimit = 5000 } = {}) {
  const repository = new MemoryAuditRepository();
  let clock = Date.parse('2026-10-21T00:00:00.000Z');
  const audit = new AuditService(repository, {
    now: () => new Date(clock),
    exportLimit,
  });
  return {
    repository,
    audit,
    tick(minutes = 1) { clock += minutes * 60_000; },
    clock() { return new Date(clock); },
  };
}

test('audit writes are append-only and credentials are redacted before storage', async () => {
  const f = fixture();
  const admin = actor('admin', 'admin@example.test');
  const entry = await f.audit.record({
    actor: admin,
    action: 'channel.price.updated',
    targetType: 'channel',
    targetId: 'omyai',
    detail: {
      password: 'P@ssw0rd-never-store',
      apiKey: 'sk-secret123456789',
      nested: {
        connectionString: 'postgresql://user:pass@db.internal:5432/app',
        token: 'token-never-store',
        refreshToken: 'refresh-never-store',
        prompt: '完整提示词不应出现在 detail',
      },
      note: 'Authorization: Bearer abcdefghijklmnop',
      source: 'postgres://user:pass@db.internal:5432/app',
      url: 'https://example.test/hook?token=secretvalue&x=1',
      price: { currency: 'CNY', amount: 0.5, official: 1.2 },
    },
    prompt: '白色背景主图，完整提示词全文',
    ip: '127.0.0.1',
  });

  const stored = JSON.stringify(f.repository.audits);
  for (const secret of [
    'P@ssw0rd-never-store', 'sk-secret123456789', 'user:pass', 'token-never-store',
    'refresh-never-store', '完整提示词不应出现在 detail', 'abcdefghijklmnop',
    'secretvalue',
  ]) {
    assert.equal(stored.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.equal(entry.detail.password, '[已脱敏]');
  assert.equal(entry.detail.nested.connectionString, '[已脱敏]');
  assert.equal(entry.detail.nested.token, '[已脱敏]');
  assert.equal(entry.detail.nested.refreshToken, '[已脱敏]');
  assert.equal(entry.detail.nested.prompt, '[提示词全文仅管理员可见]');
  assert.match(entry.detail.source, /^postgres:\/\/\[已脱敏\]@db\.internal/);
  assert.match(entry.detail.url, /token=\[已脱敏\]/);
  assert.equal(entry.detail.price.amount, 0.5);
  assert.equal(entry.detail.price.official, 1.2);
  assert.equal(entry.prompt, '白色背景主图，完整提示词全文');
  assert.equal(f.repository.audits.length, 1);

  // 仓储只暴露追加与读取；服务也没有修改/删除入口。
  assert.equal(typeof f.repository.updateAudit, 'undefined');
  assert.equal(typeof f.repository.deleteAudit, 'undefined');
  assert.equal(typeof f.audit.update, 'undefined');
  assert.equal(typeof f.audit.delete, 'undefined');
});

test('redaction helpers strip connection strings, bearer tokens and key-shaped values', () => {
  const text = redactText('redis://user:pass@cache:6379/0 Bearer abcdefghijklmnop sk-abcdefgh12345678');
  assert.equal(text.includes('user:pass'), false);
  assert.equal(text.includes('abcdefghijklmnop'), false);
  assert.equal(text.includes('sk-abcdefgh12345678'), false);
  const detail = sanitizeDetail({ authorization: 'Bearer aaaaaaaaaaaaaaaa', normal: 'keep me' });
  assert.equal(detail.authorization, '[已脱敏]');
  assert.equal(detail.normal, 'keep me');
  assert.equal(sanitizeDetail({ 'api-key': 'x' })['api-key'], '[已脱敏]');
});

test('audit input validation rejects malformed actions, detail and prompts', async () => {
  const f = fixture();
  const admin = actor('admin', 'admin@example.test');
  await assert.rejects(f.audit.record({ actor: admin, action: 'not-an-action' }), { code: 'INVALID_ACTION' });
  await assert.rejects(f.audit.record({ actor: admin, action: 'auth..login' }), { code: 'INVALID_ACTION' });
  await assert.rejects(
    f.audit.record({ actor: admin, action: 'auth.login.succeeded', detail: [] }),
    { code: 'INVALID_DETAIL' },
  );
  await assert.rejects(
    f.audit.record({ actor: admin, action: 'auth.login.succeeded', prompt: 'x'.repeat(16001) }),
    { code: 'INVALID_PROMPT' },
  );
  await assert.rejects(
    f.audit.record({ actor: { id: 'not-a-uuid', role: 'admin' }, action: 'auth.login.succeeded' }),
    { code: 'INVALID_ID' },
  );
  assert.equal(f.repository.audits.length, 0);
});

test('filters, pagination and role scope return accurate totals', async () => {
  const f = fixture();
  const admin = actor('admin', 'admin@example.test');
  const operator = actor('operator', 'operator@example.test');
  const productId = randomUUID();
  const adminScope = auditScope({ user: admin });
  const operatorScope = auditScope({ user: operator });

  f.tick();
  await f.audit.record({
    actor: admin, action: 'auth.login.succeeded', targetType: 'user', targetId: admin.id,
  });
  f.tick();
  await f.audit.record({
    actor: operator, action: 'plan.confirmed', targetType: 'project', targetId: randomUUID(),
    prompt: 'operator prompt full text',
  });
  f.tick();
  await f.audit.record({
    actor: admin, action: 'product.confirmed', targetType: 'product', targetId: productId,
    detail: { version: 2 },
  });
  f.tick();
  await f.audit.record({
    actor: admin, action: 'plan.confirmed', targetType: 'project', targetId: randomUUID(),
    prompt: 'admin prompt full text',
  });
  f.tick();
  await f.audit.record({
    actor: admin, action: 'review.revoked', targetType: 'deliverable', targetId: randomUUID(),
  });
  f.tick();
  await f.audit.record({
    actor: admin, action: 'channel.price.updated', targetType: 'channel', targetId: 'omyai',
    detail: { amount: 0.5 },
  });
  f.tick();
  await f.audit.record({
    actor: operator, action: 'auth.login.succeeded', targetType: 'user', targetId: operator.id,
  });
  f.tick();
  await f.audit.record({
    actor: operator, action: 'auth.login.failed', targetType: 'user', result: 'failure',
    detail: { email: operator.email },
  });

  const adminAll = await f.audit.list({}, adminScope);
  assert.equal(adminAll.total, 8);
  assert.equal(adminAll.canViewPrompt, true);
  assert.equal(adminAll.logs[0].action, 'auth.login.failed');

  const operatorAll = await f.audit.list({}, operatorScope);
  assert.equal(operatorAll.total, 3);
  assert.equal(operatorAll.logs.every(row => row.actorId === operator.id), true);
  assert.equal(operatorAll.canViewPrompt, false);
  const operatorPlan = operatorAll.logs.find(row => row.action === 'plan.confirmed');
  assert.equal(operatorPlan.prompt, null);
  assert.equal(operatorPlan.hasPrompt, true);

  // 非管理员即使传入别人的 actorId，也只能看到自己的事件。
  const forced = await f.audit.list({ actorId: admin.id }, operatorScope);
  assert.equal(forced.total, 3);

  assert.equal((await f.audit.list({ action: 'auth.login.succeeded' }, adminScope)).total, 2);
  assert.equal((await f.audit.list({ action: 'auth.*' }, adminScope)).total, 3);
  assert.equal((await f.audit.list({ result: 'failure' }, adminScope)).total, 1);
  assert.equal((await f.audit.list({ targetType: 'product' }, adminScope)).total, 1);
  assert.equal((await f.audit.list({ targetId: productId }, adminScope)).total, 1);
  assert.equal((await f.audit.list({ actorId: operator.id }, adminScope)).total, 3);

  const firstPage = await f.audit.list({ limit: 3, offset: 0 }, adminScope);
  assert.equal(firstPage.logs.length, 3);
  assert.equal(firstPage.total, 8);
  assert.equal(firstPage.nextOffset, 3);
  const lastPage = await f.audit.list({ limit: 3, offset: 6 }, adminScope);
  assert.equal(lastPage.logs.length, 2);
  assert.equal(lastPage.nextOffset, null);

  const times = f.repository.audits.map(row => new Date(row.createdAt).getTime()).sort((a, b) => a - b);
  const window = await f.audit.list({
    from: new Date(times[2]).toISOString(),
    to: new Date(times[4]).toISOString(),
  }, adminScope);
  assert.equal(window.total, 3);

  await assert.rejects(f.audit.list({ limit: 0 }, adminScope), { code: 'INVALID_PAGINATION' });
  await assert.rejects(f.audit.list({ limit: 101 }, adminScope), { code: 'INVALID_PAGINATION' });
  await assert.rejects(f.audit.list({ result: 'maybe' }, adminScope), { code: 'INVALID_RESULT' });
  await assert.rejects(f.audit.list({ action: 'BAD' }, adminScope), { code: 'INVALID_ACTION' });
  await assert.rejects(f.audit.list({ actorId: 'nope' }, adminScope), { code: 'INVALID_ID' });
  await assert.rejects(f.audit.list({ from: 'not-a-date' }, adminScope), { code: 'INVALID_FILTER' });
  await assert.rejects(
    f.audit.list({ from: '2026-10-22T00:00:00Z', to: '2026-10-21T00:00:00Z' }, adminScope),
    { code: 'INVALID_FILTER' },
  );
});

test('CSV export is escaped, never contains prompts, and writes an export audit entry', async () => {
  const f = fixture({ exportLimit: 2 });
  const admin = actor('admin', 'admin@example.test');
  const operator = actor('operator', 'operator@example.test');
  const adminScope = auditScope({ user: admin });
  const operatorScope = auditScope({ user: operator });

  f.tick();
  await f.audit.record({
    actor: operator, action: 'plan.confirmed', targetType: 'project', targetId: randomUUID(),
    prompt: 'operator prompt never exported',
  });
  f.tick();
  await f.audit.record({
    actor: admin, action: 'review.revoked', targetType: 'deliverable', targetId: randomUUID(),
  });
  f.tick();
  await f.audit.record({
    actor: admin,
    action: 'channel.price.updated',
    targetType: 'channel',
    targetId: '=SUM(A1)',
    detail: { note: '逗号, 引号"与公式=1+1', password: 'never-export-this' },
    prompt: 'prompt text that must never be exported',
  });

  const exported = await f.audit.exportCsv({}, adminScope);
  assert.match(exported.filename, /^audit-logs-.*\.csv$/);
  assert.equal(exported.rowCount, 2);
  assert.equal(exported.truncated, true);
  assert.match(exported.content, /^id,created_at,actor_id,actor_email,actor_role,action/);
  assert.equal(exported.content.includes('prompt text that must never be exported'), false);
  assert.equal(exported.content.includes('operator prompt never exported'), false);
  assert.equal(exported.content.includes('never-export-this'), false);
  assert.equal(exported.content.includes("'=SUM(A1)"), true);
  assert.equal(exported.content.includes('""'), true);

  const exportLogs = await f.audit.list({ action: 'audit.exported' }, adminScope);
  assert.equal(exportLogs.total, 1);
  assert.equal(exportLogs.logs[0].actorId, admin.id);
  assert.equal(exportLogs.logs[0].detail.format, 'csv');
  assert.equal(exportLogs.logs[0].detail.filters.truncated, true);
  assert.equal(exportLogs.logs[0].detail.rowCount, 2);

  const operatorExport = await f.audit.exportCsv({}, operatorScope);
  assert.equal(operatorExport.rowCount, 1);
  assert.equal(operatorExport.content.includes(operator.email), true);
  assert.equal(operatorExport.content.includes('admin@example.test'), false);
  assert.equal(operatorExport.content.includes('never-export-this'), false);
});

test('job events form an ascending, paginated timeline and reject unknown transitions', async () => {
  const f = fixture();
  const jobId = randomUUID();
  f.tick();
  await f.audit.jobEvent({ jobId, event: 'queued', detail: { modelId: 'omyai:image' } });
  f.tick();
  await f.audit.jobEvent({ jobId, event: 'running', upstreamId: randomUUID() });
  f.tick();
  await f.audit.jobEvent({ jobId, event: 'succeeded', upstreamId: randomUUID() });

  const timeline = await f.audit.timeline({ jobId });
  assert.equal(timeline.total, 3);
  assert.deepEqual(timeline.events.map(event => event.event), ['queued', 'running', 'succeeded']);
  assert.equal(timeline.events[1].upstreamId !== null, true);
  assert.equal(timeline.nextOffset, null);

  const filtered = await f.audit.timeline({ jobId, event: 'running' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.events[0].event, 'running');

  const page = await f.audit.timeline({ jobId, limit: 2, offset: 2 });
  assert.equal(page.events.length, 1);
  assert.equal(page.nextOffset, null);

  await assert.rejects(f.audit.timeline({}), { code: 'INVALID_JOB_ID' });
  await assert.rejects(f.audit.timeline({ jobId: 'nope' }), { code: 'INVALID_ID' });
  await assert.rejects(f.audit.timeline({ jobId, event: 'retrying' }), { code: 'INVALID_JOB_EVENT' });
  await assert.rejects(f.audit.jobEvent({ jobId, event: 'retrying' }), { code: 'INVALID_JOB_EVENT' });
});

test('migration declares both append-only tables and blocks update/delete', async () => {
  const sql = await readFile(new URL('../server/migrations/0005-audit.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sj_audit_logs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sj_job_events/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON sj_audit_logs/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON sj_job_events/);
  assert.match(sql, /prompt text/);
});

test('normalizeListQuery accepts a category prefix only through the star form', () => {
  assert.equal(normalizeListQuery({ action: 'auth.*' }).actionPrefix, 'auth.');
  assert.equal(normalizeListQuery({ action: 'auth.*' }).action, null);
  assert.equal(normalizeListQuery({ action: 'auth.login.succeeded' }).action, 'auth.login.succeeded');
  assert.throws(() => normalizeListQuery({ action: 'auth.' }), { code: 'INVALID_ACTION' });
  assert.throws(() => normalizeListQuery({ offset: -1 }), { code: 'INVALID_PAGINATION' });
});

// ---- HTTP integration -------------------------------------------------------

const ADMIN_EMAIL = 'admin@example.test';
const OPERATOR_EMAIL = 'operator@example.test';
const PASSWORD = 'CorrectHorse123';

async function startHttp(t) {
  const repository = new MemoryAuditRepository();
  let clock = Date.parse('2026-10-21T00:00:00.000Z');
  const audit = new AuditService(repository, {
    now: () => { clock += 1000; return new Date(clock); },
  });
  const admin = {
    id: randomUUID(), workspaceId: WORKSPACE, email: ADMIN_EMAIL, displayName: '管理员',
    role: 'admin', active: true, mustChangePassword: false,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const operator = {
    id: randomUUID(), workspaceId: WORKSPACE, email: OPERATOR_EMAIL, displayName: '运营',
    role: 'operator', active: true, mustChangePassword: false,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const byToken = new Map([['admin-token', admin], ['operator-token', operator]]);
  const auth = {
    async authenticate(token) {
      const user = byToken.get(token);
      if (!user) return null;
      return { session: { id: randomUUID(), tokenHash: token, userId: user.id }, user };
    },
    async login(email, password) {
      const user = email === ADMIN_EMAIL ? admin : email === OPERATOR_EMAIL ? operator : null;
      if (!user || password !== PASSWORD) throw new AppError('INVALID_CREDENTIALS', '账号或密码错误。', 401);
      return {
        token: user.role === 'admin' ? 'admin-token' : 'operator-token',
        user,
        mustChangePassword: false,
        maxAgeSeconds: 3600,
      };
    },
    async logout() {},
  };
  const products = {
    async confirm(id) { return { id, version: 2, status: 'confirmed', name: '测试商品' }; },
  };
  const server = createServer({
    store: { async list() { return []; } },
    assets: {}, registry: {}, service: {}, auth, audit, products,
    port: 0, root: new URL('../', import.meta.url),
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
  const login = async (email, password) => {
    const token = await csrf();
    const response = await post('/api/session', token, { email, password });
    return {
      response,
      body: await response.json(),
      cookie: (response.headers.get('set-cookie') || '').split(';')[0],
    };
  };
  return { base, audit, repository, admin, operator, csrf, post, login };
}

const getJson = async (url, cookie) => {
  const response = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  return { response, body: await response.json() };
};

test('HTTP audit endpoints enforce login, role scope, prompt visibility and export logging', async t => {
  const h = await startHttp(t);

  assert.equal((await fetch(`${h.base}/api/audit-logs`)).status, 401);

  const failed = await h.login(ADMIN_EMAIL, 'WrongPassword123');
  assert.equal(failed.response.status, 401);
  const adminLogin = await h.login(ADMIN_EMAIL, PASSWORD);
  assert.equal(adminLogin.response.status, 200);
  const operatorLogin = await h.login(OPERATOR_EMAIL, PASSWORD);
  assert.equal(operatorLogin.response.status, 200);

  const adminList = await getJson(`${h.base}/api/audit-logs`, adminLogin.cookie);
  assert.equal(adminList.response.status, 200);
  const failedLogin = adminList.body.logs.find(row => row.action === 'auth.login.failed');
  assert.ok(failedLogin);
  assert.equal(failedLogin.detail.email, ADMIN_EMAIL);
  assert.equal(JSON.stringify(adminList.body).includes('WrongPassword123'), false);

  const operatorList = await getJson(`${h.base}/api/audit-logs`, operatorLogin.cookie);
  assert.equal(operatorList.response.status, 200);
  assert.equal(operatorList.body.logs.every(row => row.actorId === h.operator.id), true);
  assert.equal(operatorList.body.logs.some(row => row.action === 'auth.login.failed'), false);

  const adminPrompt = await h.audit.record({
    actor: h.admin,
    action: 'plan.confirmed',
    targetType: 'project',
    targetId: randomUUID(),
    prompt: 'admin-only prompt full text',
  });
  const operatorPrompt = await h.audit.record({
    actor: h.operator,
    action: 'plan.confirmed',
    targetType: 'project',
    targetId: randomUUID(),
    prompt: 'operator prompt full text',
  });
  await h.audit.record({
    actor: h.admin, action: 'review.revoked', targetType: 'deliverable', targetId: randomUUID(),
  });
  await h.audit.record({
    actor: h.admin, action: 'channel.price.updated', targetType: 'channel', targetId: 'omyai',
    detail: { amount: 0.5, currency: 'CNY' },
  });

  const adminPlans = await getJson(`${h.base}/api/audit-logs?action=plan.confirmed`, adminLogin.cookie);
  assert.equal(adminPlans.body.total, 2);
  assert.equal(adminPlans.body.logs.find(row => row.id === adminPrompt.id).prompt, 'admin-only prompt full text');

  const operatorPlans = await getJson(`${h.base}/api/audit-logs?action=plan.confirmed`, operatorLogin.cookie);
  assert.equal(operatorPlans.body.total, 1);
  assert.equal(operatorPlans.body.logs[0].id, operatorPrompt.id);
  assert.equal(operatorPlans.body.logs[0].prompt, null);
  assert.equal(operatorPlans.body.logs[0].hasPrompt, true);
  assert.equal(JSON.stringify(operatorPlans.body).includes('operator prompt full text'), false);

  const token = await h.csrf();
  const productId = randomUUID();
  const confirmed = await h.post(`/api/products/${productId}/confirm`, token, { version: 1 }, adminLogin.cookie);
  assert.equal(confirmed.status, 200);
  const productLogs = await getJson(`${h.base}/api/audit-logs?action=product.confirmed`, adminLogin.cookie);
  assert.equal(productLogs.body.total, 1);
  assert.equal(productLogs.body.logs[0].targetId, productId);
  assert.equal(productLogs.body.logs[0].actorId, h.admin.id);

  const csv = await fetch(`${h.base}/api/audit-logs/export.csv`, {
    headers: { Cookie: adminLogin.cookie },
  });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /^attachment; filename="audit-logs-.*\.csv"$/);
  const csvText = await csv.text();
  assert.match(csvText, /id,created_at,actor_id/);
  assert.equal(csvText.includes('admin-only prompt full text'), false);
  assert.equal(csvText.includes('operator prompt full text'), false);
  assert.equal(csvText.includes('WrongPassword123'), false);

  const exportLogs = await getJson(`${h.base}/api/audit-logs?action=audit.exported`, adminLogin.cookie);
  assert.equal(exportLogs.body.total, 1);
  assert.equal(exportLogs.body.logs[0].actorId, h.admin.id);
  assert.equal(exportLogs.body.logs[0].detail.format, 'csv');

  const jobId = randomUUID();
  await h.audit.jobEvent({ jobId, event: 'queued' });
  await h.audit.jobEvent({ jobId, event: 'running', upstreamId: randomUUID() });
  await h.audit.jobEvent({ jobId, event: 'succeeded', upstreamId: randomUUID() });
  const timeline = await getJson(`${h.base}/api/job-events?jobId=${jobId}`, operatorLogin.cookie);
  assert.equal(timeline.response.status, 200);
  assert.deepEqual(timeline.body.events.map(event => event.event), ['queued', 'running', 'succeeded']);
  const alias = await getJson(`${h.base}/api/jobs/${jobId}/events`, operatorLogin.cookie);
  assert.equal(alias.body.total, 3);
  const missing = await getJson(`${h.base}/api/job-events`, adminLogin.cookie);
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, 'INVALID_JOB_ID');
  const badEvent = await getJson(`${h.base}/api/job-events?jobId=${jobId}&event=retrying`, adminLogin.cookie);
  assert.equal(badEvent.response.status, 400);
  assert.equal(badEvent.body.error.code, 'INVALID_JOB_EVENT');

  const filtered = await getJson(`${h.base}/api/audit-logs?action=auth.*&limit=1&offset=0`, adminLogin.cookie);
  assert.equal(filtered.body.limit, 1);
  assert.equal(filtered.body.logs.length, 1);
  assert.equal(filtered.body.logs[0].action.startsWith('auth.'), true);
});
