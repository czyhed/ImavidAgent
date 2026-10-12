-- 打包导出 ZIP 与 manifest（Issue #18 / FLOW-11、BILL-02）。
--
-- 一张表：
--   sj_project_exports  每次项目导出一条记录，保存项目、方案版本、请求摘要、幂等键、
--                       状态、ZIP 对象键、manifest 摘要、交付项与缺项快照、文件大小、
--                       校验值、创建人与时间。ZIP 只进入私有桶 shangjing-exports；
--                       对象键与桶名只留在本表，不进入 manifest 或审计详情。
--
-- 规则：
--   - 写入前先以幂等键预约一行 building，重复请求直接返回原记录，不重复生成与上传。
--   - 只有已审核通过（approved）的交付版本会进入 items；draft / candidate / 待审核 /
--     已撤销版本一律不写包，对应交付项进入 missing。
--   - 导出不创建生成任务、不扣生成费，charge_cents 恒为 0。
--   - 记录只追加：完成后不可修改，也不可删除；失败由 error_code 说明。

CREATE TABLE IF NOT EXISTS sj_project_exports (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  -- 幂等键与请求摘要：同一键必须是同一项目与方案版本，否则冲突而不是静默复用。
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'building',
  -- ZIP 的逻辑文件名与对象键；对象键只用于服务端读取，不进入 manifest。
  file_name text,
  object_key text,
  content_type text NOT NULL DEFAULT 'application/zip',
  bytes bigint,
  zip_sha256 text,
  manifest_sha256 text,
  -- manifest 全文与交付项 / 缺项快照，便于历史记录无需重解压即可展示。
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_count integer NOT NULL DEFAULT 0,
  missing_count integer NOT NULL DEFAULT 0,
  -- 导出不收费：预留字段只用于明示 0 元，不写生成账本或预占。
  charge_cents bigint NOT NULL DEFAULT 0,
  error_code text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_project_exports_plan_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_project_exports_status_valid CHECK (status IN ('building', 'completed', 'failed')),
  CONSTRAINT sj_project_exports_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT sj_project_exports_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sj_project_exports_file_name_length CHECK (
    file_name IS NULL OR char_length(file_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT sj_project_exports_object_key_length CHECK (
    object_key IS NULL OR char_length(object_key) BETWEEN 1 AND 512
  ),
  CONSTRAINT sj_project_exports_counts_nonnegative CHECK (
    item_count >= 0 AND missing_count >= 0
  ),
  CONSTRAINT sj_project_exports_manifest_object CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT sj_project_exports_items_array CHECK (jsonb_typeof(items) = 'array'),
  CONSTRAINT sj_project_exports_missing_array CHECK (jsonb_typeof(missing) = 'array'),
  CONSTRAINT sj_project_exports_charge_zero CHECK (charge_cents = 0),
  CONSTRAINT sj_project_exports_completed_fields CHECK (
    status <> 'completed' OR (
      file_name IS NOT NULL AND object_key IS NOT NULL AND bytes IS NOT NULL
      AND zip_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND completed_at IS NOT NULL AND error_code IS NULL
      AND item_count = jsonb_array_length(items)
      AND missing_count = jsonb_array_length(missing)
    )
  ),
  CONSTRAINT sj_project_exports_failed_fields CHECK (
    status <> 'failed' OR error_code IS NOT NULL
  ),
  CONSTRAINT sj_project_exports_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sj_project_exports_project
  ON sj_project_exports (workspace_id, project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sj_project_exports_status
  ON sj_project_exports (workspace_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sj_project_exports_object_unique
  ON sj_project_exports (object_key)
  WHERE object_key IS NOT NULL;

-- 归属、请求摘要与创建信息不可改；只有 building 可以转到 completed / failed，
-- 完成或失败的记录为终态；导出记录不可删除，保留交付追溯。
CREATE OR REPLACE FUNCTION sj_project_exports_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '导出记录不可删除，请保留交付追溯';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '导出记录的归属、幂等键与创建信息不可修改';
  END IF;
  IF OLD.status <> 'building' THEN
    RAISE EXCEPTION '已完成或失败的导出记录不可修改';
  END IF;
  IF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION '导出记录只能从 building 转为 completed 或 failed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sj_project_exports_guard ON sj_project_exports;
CREATE TRIGGER sj_project_exports_guard
  BEFORE UPDATE OR DELETE ON sj_project_exports
  FOR EACH ROW EXECUTE FUNCTION sj_project_exports_guard();
