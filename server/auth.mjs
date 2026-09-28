import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';

const scrypt = promisify(scryptCallback);

// 会话 Cookie：HttpOnly + SameSite=Strict + Path=/；令牌不写入 localStorage、URL 或日志。
export const SESSION_COOKIE = 'sj_session';
export const ROLES = Object.freeze(['admin', 'operator', 'viewer']);

const TOKEN_BYTES = 32;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AppError('INVALID_EMAIL', '请输入有效的邮箱地址。');
  }
  return email;
}

export function normalizeNewPassword(value, minLength = 10) {
  if (typeof value !== 'string' || value.length < minLength || value.length > 200) {
    throw new AppError('WEAK_PASSWORD', `密码长度需为 ${minLength}–200 个字符。`);
  }
  return value;
}

export function normalizeRole(value) {
  const role = String(value ?? '').trim();
  if (!ROLES.includes(role)) throw new AppError('INVALID_ROLE', '角色只能是管理员、运营或查看者。');
  return role;
}

function normalizeDisplayName(value, email) {
  const name = String(value ?? '').trim() || String(email).split('@')[0];
  if (name.length > 80) throw new AppError('INVALID_DISPLAY_NAME', '成员名称不能超过 80 个字符。');
  return name;
}

function normalizeWorkspaceName(value) {
  const name = String(value ?? '').trim() || '商境';
  if (name.length > 80) throw new AppError('INVALID_WORKSPACE_NAME', '工作空间名称不能超过 80 个字符。');
  return name;
}

// scrypt 加盐哈希；格式 scrypt$N$r$p$salt$hash，salt 与摘要均为 base64url。
export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const derived = Buffer.from(await scrypt(password, salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM,
  }));
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, digest] = parts;
  const expected = Buffer.from(digest, 'base64url');
  if (!expected.length) return false;
  const derived = Buffer.from(await scrypt(String(password ?? ''), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
  }));
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function newSessionToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(`sj:session:${token}`).digest('hex');
}

export function sessionCookie(token, { maxAgeSeconds, secure = false } = {}) {
  const age = Math.max(0, Math.floor(maxAgeSeconds || 0));
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function isLoopbackAddress(address) {
  const value = String(address ?? '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// 失败限流只存在进程内存中：服务重启后计数与锁定全部清空。
export class RateLimiter {
  constructor({ maxFailures = 5, lockMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.now = now;
    this.entries = new Map();
  }

  check(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.lockedUntil && entry.lockedUntil > this.now()) {
      throw new AppError('LOGIN_LOCKED', '失败次数过多，请 15 分钟后再试。', 429);
    }
    if (entry.lockedUntil && entry.lockedUntil <= this.now()) this.entries.delete(key);
  }

  fail(key) {
    const entry = this.entries.get(key) || { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.failures = 0;
      entry.lockedUntil = this.now() + this.lockMs;
    }
    this.entries.set(key, entry);
    if (this.entries.size > 10_000) this.prune();
  }

  succeed(key) {
    this.entries.delete(key);
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.lockedUntil || entry.lockedUntil <= now) this.entries.delete(key);
    }
  }
}

const userRow = row => row && {
  id: row.id,
  workspaceId: row.workspace_id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  passwordHash: row.password_hash,
  mustChangePassword: row.must_change_password,
  active: row.active,
  passwordChangedAt: row.password_changed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
};

const workspaceRow = row => row && ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
});

export class AuthStore {
  constructor(pool) {
    this.pool = pool;
  }

  async findUserByEmail(email) {
    const result = await this.pool.query(
      'SELECT * FROM sj_users WHERE email=$1 ORDER BY created_at ASC LIMIT 1',
      [email],
    );
    return userRow(result.rows[0]);
  }

  async getUser(id) {
    const result = await this.pool.query('SELECT * FROM sj_users WHERE id=$1', [id]);
    return userRow(result.rows[0]);
  }

  async listUsers() {
    const result = await this.pool.query('SELECT * FROM sj_users ORDER BY created_at ASC');
    return result.rows.map(userRow);
  }

  async countActiveAdmins() {
    const result = await this.pool.query(
      "SELECT count(*)::int AS n FROM sj_users WHERE role='admin' AND active=true",
    );
    return result.rows[0].n;
  }

  async createInitialAdmin({ workspace, user }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 串行化一次性初始化，避免并发请求各建一个管理员。
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sj:auth:setup'))");
      const admins = await client.query("SELECT count(*)::int AS n FROM sj_users WHERE role='admin'");
      if (admins.rows[0].n > 0) throw new AppError('SETUP_COMPLETE', '管理员已初始化。', 409);
      const createdWorkspace = workspaceRow((await client.query(
        'INSERT INTO sj_workspaces (name) VALUES ($1) RETURNING *',
        [workspace.name],
      )).rows[0]);
      const createdUser = userRow((await client.query(
        `INSERT INTO sj_users
          (workspace_id,email,display_name,role,password_hash,must_change_password,active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [createdWorkspace.id, user.email, user.displayName, user.role, user.passwordHash,
          user.mustChangePassword, user.active],
      )).rows[0]);
      await client.query('COMMIT');
      return { workspace: createdWorkspace, user: createdUser };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createUser(user) {
    try {
      const result = await this.pool.query(
        `INSERT INTO sj_users
          (workspace_id,email,display_name,role,password_hash,must_change_password,active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [user.workspaceId, user.email, user.displayName, user.role, user.passwordHash,
          user.mustChangePassword, user.active],
      );
      return userRow(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError('MEMBER_EXISTS', '该邮箱已被使用。', 409);
      throw error;
    }
  }

  async updateUser(id, patch) {
    const columns = {
      displayName: 'display_name',
      role: 'role',
      passwordHash: 'password_hash',
      mustChangePassword: 'must_change_password',
      active: 'active',
      passwordChangedAt: 'password_changed_at',
    };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    if (!entries.length) return this.getUser(id);
    const result = await this.pool.query(
      `UPDATE sj_users SET ${entries.map(([key], index) => `${columns[key]}=$${index + 2}`).join(',')},updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, ...entries.map(([, value]) => value)],
    );
    return userRow(result.rows[0]);
  }

  async createSession({ workspaceId, userId, tokenHash, expiresAt }) {
    await this.pool.query(
      'INSERT INTO sj_sessions (workspace_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
      [workspaceId, userId, tokenHash, expiresAt],
    );
  }

  async findSessionByHash(tokenHash) {
    const result = await this.pool.query(
      `SELECT s.id AS sid, s.workspace_id AS s_workspace_id, s.user_id AS s_user_id,
              s.token_hash, s.created_at AS s_created_at, s.expires_at, s.revoked_at,
              u.id, u.workspace_id, u.email, u.display_name, u.role, u.active,
              u.must_change_password, u.password_changed_at, u.created_at, u.updated_at
       FROM sj_sessions s
       JOIN sj_users u ON u.id = s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active=true`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: {
        id: row.sid,
        workspaceId: row.s_workspace_id,
        userId: row.s_user_id,
        tokenHash: row.token_hash,
        createdAt: row.s_created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      },
      // 只返回鉴权所需的字段，密码哈希不进入请求上下文。
      user: userRow(row),
    };
  }

  async revokeSession(tokenHash) {
    if (!tokenHash) return;
    await this.pool.query(
      'UPDATE sj_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  async revokeUserSessions(userId, exceptTokenHash = null) {
    await this.pool.query(
      `UPDATE sj_sessions SET revoked_at=now()
       WHERE user_id=$1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
      [userId, exceptTokenHash],
    );
  }
}

let dummyHashPromise;
async function verifyAgainstUnknown(password) {
  dummyHashPromise ??= hashPassword('sj-invalid-credential-never-used');
  await verifyPassword(password, await dummyHashPromise);
  return false;
}

export class AuthService {
  constructor(store, options = {}) {
    this.store = store;
    this.minPasswordLength = options.minPasswordLength ?? 10;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.limiter = options.limiter || new RateLimiter({
      maxFailures: options.maxFailures ?? 5,
      lockMs: options.lockMs ?? 15 * 60 * 1000,
      now: options.now,
    });
  }

  async setupAdmin(input = {}, remoteAddress) {
    if (!isLoopbackAddress(remoteAddress)) {
      throw new AppError('SETUP_LOCAL_ONLY', '管理员初始化仅允许在本机进行。', 403);
    }
    const email = normalizeEmail(input.email);
    const password = normalizeNewPassword(input.password, this.minPasswordLength);
    const displayName = normalizeDisplayName(input.displayName, email);
    const workspaceName = normalizeWorkspaceName(input.workspaceName);
    const passwordHash = await hashPassword(password);
    const result = await this.store.createInitialAdmin({
      workspace: { name: workspaceName },
      user: {
        email,
        displayName,
        role: 'admin',
        passwordHash,
        // 初始化密码由本机操作者当场设定，不是临时密码；管理员新增/重置的成员才强制改密。
        mustChangePassword: false,
        active: true,
      },
    });
    return { workspace: result.workspace, user: publicUser(result.user) };
  }

  async login(emailInput, password) {
    const email = normalizeEmail(emailInput);
    this.limiter.check(email);
    const invalid = () => {
      this.limiter.fail(email);
      return new AppError('INVALID_CREDENTIALS', '账号或密码错误。', 401);
    };
    if (typeof password !== 'string' || password.length === 0 || password.length > 200) throw invalid();
    const user = await this.store.findUserByEmail(email);
    if (!user) {
      await verifyAgainstUnknown(password);
      throw invalid();
    }
    if (!user.active || !(await verifyPassword(password, user.passwordHash))) throw invalid();
    this.limiter.succeed(email);

    const token = newSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    await this.store.createSession({
      workspaceId: user.workspaceId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });
    return {
      token,
      tokenHash,
      user: publicUser(user),
      mustChangePassword: user.mustChangePassword,
      maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !token) return null;
    return this.store.findSessionByHash(hashSessionToken(token));
  }

  // 前端用它决定是否展示首次管理员初始化表单；初始化本身仍由本机地址限制。
  async setupRequired() {
    return (await this.store.countActiveAdmins()) === 0;
  }

  async logout(tokenHash) {
    if (tokenHash) await this.store.revokeSession(tokenHash);
  }

  async changePassword({ userId, tokenHash }, currentPassword, newPassword) {
    const user = await this.store.getUser(userId);
    if (!user || !user.active) throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AppError('INVALID_PASSWORD', '当前密码不正确。', 400);
    }
    const next = normalizeNewPassword(newPassword, this.minPasswordLength);
    if (next === currentPassword) throw new AppError('SAME_PASSWORD', '新密码不能与当前密码相同。', 400);
    const updated = await this.store.updateUser(userId, {
      passwordHash: await hashPassword(next),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    });
    // 改密后其他设备上的旧会话立即失效，保留当前会话。
    await this.store.revokeUserSessions(userId, tokenHash);
    return publicUser(updated);
  }

  requireAdmin(actor) {
    if (!actor || actor.role !== 'admin' || !actor.active) {
      throw new AppError('FORBIDDEN', '仅管理员可执行此操作。', 403);
    }
  }

  async listUsers(actor) {
    this.requireAdmin(actor);
    return (await this.store.listUsers()).map(publicUser);
  }

  async createUser(actor, input = {}) {
    this.requireAdmin(actor);
    const email = normalizeEmail(input.email);
    const password = normalizeNewPassword(input.password, this.minPasswordLength);
    const role = input.role == null ? 'operator' : normalizeRole(input.role);
    const displayName = normalizeDisplayName(input.displayName, email);
    const user = await this.store.createUser({
      workspaceId: actor.workspaceId,
      email,
      displayName,
      role,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      active: true,
    });
    return publicUser(user);
  }

  async updateUser(actor, id, patch = {}) {
    this.requireAdmin(actor);
    const target = await this.store.getUser(id);
    if (!target) throw new AppError('NOT_FOUND', '成员不存在。', 404);

    const changes = {};
    if ('displayName' in patch) changes.displayName = normalizeDisplayName(patch.displayName, target.email);
    if ('role' in patch) {
      const role = normalizeRole(patch.role);
      if (target.active && target.role === 'admin' && role !== 'admin') {
        await this.assertAdminRemains('不能取消最后一个管理员的角色。');
      }
      changes.role = role;
    }
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw new AppError('INVALID_ENABLED', 'enabled 必须是布尔值。');
      if (target.active && target.role === 'admin' && patch.enabled === false) {
        await this.assertAdminRemains('不能停用最后一个管理员。');
      }
      changes.active = patch.enabled;
    }
    if ('password' in patch) {
      changes.passwordHash = await hashPassword(normalizeNewPassword(patch.password, this.minPasswordLength));
      changes.mustChangePassword = true;
      changes.passwordChangedAt = new Date();
    }
    if (!Object.keys(changes).length) throw new AppError('EMPTY_UPDATE', '没有可更新的字段。');

    const updated = await this.store.updateUser(id, changes);
    // 停用或重置密码后，该成员所有旧会话立即失效。
    if (changes.active === false || changes.passwordHash) await this.store.revokeUserSessions(id);
    return publicUser(updated);
  }

  async assertAdminRemains(message) {
    if (await this.store.countActiveAdmins() <= 1) {
      throw new AppError('LAST_ADMIN', message, 409);
    }
  }
}
