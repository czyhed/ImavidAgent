-- 身份底座：单工作空间、成员与会话。只追加，不修改已应用的迁移。
CREATE TABLE IF NOT EXISTS sj_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sj_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES sj_workspaces(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator', 'viewer')),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS sj_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES sj_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES sj_users(id) ON DELETE CASCADE,
  -- 只存 SHA-256 哈希；原始令牌只存在于 HttpOnly Cookie。
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sj_users_workspace_active ON sj_users (workspace_id, active);
CREATE INDEX IF NOT EXISTS sj_users_role_active ON sj_users (role, active);
CREATE INDEX IF NOT EXISTS sj_sessions_user_active ON sj_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sj_sessions_expiry ON sj_sessions (expires_at) WHERE revoked_at IS NULL;
