-- 0005: append-only audit logs and generation job timeline (Issue #8).
-- 表只允许 INSERT：触发器直接拒绝 UPDATE/DELETE。保留期按 FUNCTIONAL_SPEC Q-07
-- 尚未确认，因此这里不启用自动清理。

CREATE TABLE IF NOT EXISTS sj_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 单工作空间部署（ADR 0009）；SJ_AUTH=off 的本机单用户事件允许为空。
  workspace_id uuid REFERENCES sj_workspaces (id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES sj_users (id) ON DELETE RESTRICT,
  -- 同时保存快照，账号改名后仍能还原当时的操作者。
  actor_email text,
  actor_role text CHECK (actor_role IS NULL OR actor_role IN ('admin', 'operator', 'viewer')),
  action text NOT NULL,
  target_type text,
  target_id text,
  result text NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failure')),
  -- 写入前已在应用层递归脱敏；密码、令牌、密钥、连接串不应出现在这里。
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 提示词全文单独存放：读取接口只对管理员返回，CSV 导出永不包含。
  prompt text,
  ip text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(action) BETWEEN 3 AND 120),
  CHECK (action = lower(action)),
  CHECK (target_type IS NULL OR (length(target_type) BETWEEN 1 AND 50 AND target_type = lower(target_type))),
  CHECK (target_id IS NULL OR length(target_id) <= 200),
  CHECK (actor_email IS NULL OR length(actor_email) <= 254),
  CHECK (prompt IS NULL OR length(prompt) <= 16000),
  CHECK (ip IS NULL OR length(ip) <= 100),
  CHECK (request_id IS NULL OR length(request_id) <= 200)
);

CREATE INDEX IF NOT EXISTS sj_audit_logs_created
ON sj_audit_logs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS sj_audit_logs_action_created
ON sj_audit_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS sj_audit_logs_actor_created
ON sj_audit_logs (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sj_audit_logs_target_created
ON sj_audit_logs (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sj_job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES sj_generation_jobs (id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event IN (
    'queued', 'submitting', 'running', 'storing', 'succeeded', 'failed',
    'unknown', 'cancelled', 'reconciled'
  )),
  actor_id uuid REFERENCES sj_users (id) ON DELETE RESTRICT,
  upstream_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (upstream_id IS NULL OR length(upstream_id) <= 200)
);

CREATE INDEX IF NOT EXISTS sj_job_events_job_created
ON sj_job_events (job_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS sj_job_events_created
ON sj_job_events (created_at DESC);

CREATE OR REPLACE FUNCTION sj_audit_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = '审计日志与任务事件只能追加，不能修改或删除。';
END;
$$;

DROP TRIGGER IF EXISTS sj_audit_logs_append_only ON sj_audit_logs;
CREATE TRIGGER sj_audit_logs_append_only
BEFORE UPDATE OR DELETE ON sj_audit_logs
FOR EACH ROW EXECUTE FUNCTION sj_audit_forbid_change();

DROP TRIGGER IF EXISTS sj_job_events_append_only ON sj_job_events;
CREATE TRIGGER sj_job_events_append_only
BEFORE UPDATE OR DELETE ON sj_job_events
FOR EACH ROW EXECUTE FUNCTION sj_audit_forbid_change();
