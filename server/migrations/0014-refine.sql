-- 交付项精修三路径、版本链、交付候选与返修（Issue #16 / FLOW-08、FLOW-09、ACC-08、ACC-21）。
--
-- 三张表：
--   sj_deliverable_versions  交付项版本链。每个版本属于「项目 + 方案版本 + 交付项」，
--                            保存来源版本、产物引用（素材 id 或生成任务 id）、状态、精修路径、
--                            成本快照与内容快照。内容只追加、不可修改；只允许切换
--                            status / is_candidate，旧版本永不删除。
--   sj_refine_requests       手动精修请求。估价 -> 单独确认预占 -> 执行；模板重排报价 0 且
--                            不建生成任务，底图二次优化 / 整图润色走生成/改图能力并计费。
--   sj_deliverable_states    交付项级修订号与当前候选。候选显式选定，同一交付项同时最多一个
--                            is_candidate 版本（部分唯一索引）；返修记录理由与目标版本。
--
-- 候选只由用户显式选定：任何生成、精修或重排完成都只产生 draft 版本，
-- 不会自动成为交付候选（FLOW-09）。

CREATE TABLE IF NOT EXISTS sj_deliverable_versions (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  deliverable_id uuid NOT NULL,
  version integer NOT NULL,
  -- 精修来源版本；首个导入版本为 NULL。自引用保证版本链在库内可追溯。
  source_version_id uuid REFERENCES sj_deliverable_versions (id) ON DELETE SET NULL,
  -- 产物引用二选一或同时存在：素材索引行或成功生成任务。
  asset_id uuid REFERENCES sj_assets (id) ON DELETE SET NULL,
  job_id uuid REFERENCES sj_generation_jobs (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  -- 同一交付项同时最多一个候选；候选切换时旧候选变为 superseded 且保留。
  is_candidate boolean NOT NULL DEFAULT false,
  -- 精修路径：模板重排 / 底图二次优化 / 整图润色。导入的原始产物为 NULL。
  refine_path text,
  -- 整图润色可能改变文字和商品，必须重新质检；其余路径沿用来源检查结论。
  requires_qc boolean NOT NULL DEFAULT false,
  -- 版式、指令、模型等不可变内容快照。
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 估价 / 实际成本快照；不重复计费的模板重排为 0 且 billingMode='none'。
  cost jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_deliverable_versions_version_positive CHECK (version >= 1),
  CONSTRAINT sj_deliverable_versions_plan_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_deliverable_versions_status_valid CHECK (status IN (
    'draft', 'candidate', 'approved', 'superseded', 'rejected'
  )),
  CONSTRAINT sj_deliverable_versions_path_valid CHECK (
    refine_path IS NULL OR refine_path IN ('template_reorder', 'base_optimize', 'full_polish')
  ),
  CONSTRAINT sj_deliverable_versions_content_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT sj_deliverable_versions_cost_object CHECK (jsonb_typeof(cost) = 'object'),
  -- 只有 draft 及以上版本可以被显式选为候选；候选状态与布尔位保持一致。
  CONSTRAINT sj_deliverable_versions_candidate_valid CHECK (
    (NOT is_candidate OR status IN ('candidate', 'approved'))
    AND (status <> 'candidate' OR is_candidate)
  ),
  CONSTRAINT sj_deliverable_versions_unique UNIQUE (project_id, plan_version, deliverable_id, version)
);

CREATE INDEX IF NOT EXISTS sj_deliverable_versions_deliverable
  ON sj_deliverable_versions (workspace_id, project_id, plan_version, deliverable_id, version DESC);
CREATE INDEX IF NOT EXISTS sj_deliverable_versions_job
  ON sj_deliverable_versions (job_id);
CREATE INDEX IF NOT EXISTS sj_deliverable_versions_asset
  ON sj_deliverable_versions (asset_id);
-- 同一交付项同时最多一个候选；切换候选由服务层在同一事务内先撤销旧候选。
CREATE UNIQUE INDEX IF NOT EXISTS sj_deliverable_versions_candidate_unique
  ON sj_deliverable_versions (workspace_id, project_id, plan_version, deliverable_id)
  WHERE is_candidate;

-- 版本内容不可变：只允许改 status / is_candidate / updated_at，且禁止删除。
CREATE OR REPLACE FUNCTION sj_deliverable_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '交付项版本不可删除，请保留历史版本';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
     OR NEW.deliverable_id IS DISTINCT FROM OLD.deliverable_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.refine_path IS DISTINCT FROM OLD.refine_path
     OR NEW.requires_qc IS DISTINCT FROM OLD.requires_qc
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.cost IS DISTINCT FROM OLD.cost
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '交付项版本内容不可修改；只能切换候选状态';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sj_deliverable_versions_guard ON sj_deliverable_versions;
CREATE TRIGGER sj_deliverable_versions_guard
  BEFORE UPDATE OR DELETE ON sj_deliverable_versions
  FOR EACH ROW EXECUTE FUNCTION sj_deliverable_versions_guard();

CREATE TABLE IF NOT EXISTS sj_refine_requests (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  deliverable_id uuid NOT NULL,
  path text NOT NULL,
  source_version_id uuid NOT NULL REFERENCES sj_deliverable_versions (id) ON DELETE RESTRICT,
  target_version_id uuid REFERENCES sj_deliverable_versions (id) ON DELETE SET NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  quote jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 估价金额：未定价保持 NULL（待核价），模板重排明确为 0。
  estimate_cents bigint,
  reserved_cents bigint NOT NULL DEFAULT 0,
  actual_cost_cents bigint,
  currency text NOT NULL DEFAULT 'CNY',
  billing_task_id text,
  job_id uuid REFERENCES sj_generation_jobs (id) ON DELETE SET NULL,
  -- 确认幂等键：同一键重复确认返回原请求，不重复预占、不重复生成。
  idempotency_key text,
  error_code text,
  confirmed_by text,
  confirmed_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_refine_requests_plan_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_refine_requests_path_valid CHECK (path IN (
    'template_reorder', 'base_optimize', 'full_polish'
  )),
  CONSTRAINT sj_refine_requests_status_valid CHECK (status IN (
    'draft', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'unknown', 'cancelled'
  )),
  CONSTRAINT sj_refine_requests_revision_positive CHECK (revision >= 1),
  CONSTRAINT sj_refine_requests_params_object CHECK (jsonb_typeof(params) = 'object'),
  CONSTRAINT sj_refine_requests_quote_object CHECK (jsonb_typeof(quote) = 'object'),
  CONSTRAINT sj_refine_requests_amounts_nonnegative CHECK (
    (estimate_cents IS NULL OR estimate_cents >= 0)
    AND reserved_cents >= 0
    AND (actual_cost_cents IS NULL OR actual_cost_cents >= 0)
  ),
  CONSTRAINT sj_refine_requests_currency_cny CHECK (currency = 'CNY'),
  CONSTRAINT sj_refine_requests_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sj_refine_requests_deliverable
  ON sj_refine_requests (workspace_id, project_id, plan_version, deliverable_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_refine_requests_job
  ON sj_refine_requests (job_id);
-- 同一交付项同时最多一份待确认精修草稿；重复估价更新它，而不是堆出多份。
CREATE UNIQUE INDEX IF NOT EXISTS sj_refine_requests_open_deliverable
  ON sj_refine_requests (workspace_id, project_id, plan_version, deliverable_id)
  WHERE idempotency_key IS NULL AND status IN ('draft', 'awaiting_confirmation');

CREATE TABLE IF NOT EXISTS sj_deliverable_states (
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  deliverable_id uuid NOT NULL,
  workspace_id text NOT NULL DEFAULT 'local',
  -- 交付项级乐观锁：候选切换与返修使用 ETag "r<revision>" + If-Match。
  revision integer NOT NULL DEFAULT 1,
  current_candidate_version_id uuid REFERENCES sj_deliverable_versions (id) ON DELETE SET NULL,
  rework_version_id uuid REFERENCES sj_deliverable_versions (id) ON DELETE SET NULL,
  rework_reason text,
  rework_at timestamptz,
  -- 返修后回到第 04 步精修；未返修时为空。
  current_step integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, plan_version, deliverable_id),
  CONSTRAINT sj_deliverable_states_plan_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_deliverable_states_revision_positive CHECK (revision >= 1),
  CONSTRAINT sj_deliverable_states_step_valid CHECK (current_step IS NULL OR current_step BETWEEN 1 AND 6),
  CONSTRAINT sj_deliverable_states_reason_length CHECK (
    rework_reason IS NULL OR char_length(rework_reason) BETWEEN 1 AND 500
  )
);

CREATE INDEX IF NOT EXISTS sj_deliverable_states_candidate
  ON sj_deliverable_states (current_candidate_version_id);
