-- 工作流运行：逐节点估价、一次确认预占、按依赖执行与失败隔离（Issue #14 / FLOW-17、ACC-20）。
--
-- 两层对象：
--   sj_workflow_runs       一次估价 + 确认开跑的批次。保存工作流图快照（graph）、逐节点估价
--                          汇总、预占/结算/释放合计、确认时间与人、revision 与幂等键。
--                          图快照保证运行开始后实例再被修改也不会改变本次执行。
--   sj_workflow_node_runs  批次内每个节点一行，记录状态、依赖、报价/预占/实际成本、
--                          关联生成任务、幂等键与尝试历史。
--
-- 只追加语义：账本与审计仍由各自模块负责；本表允许更新运行状态与节点状态，
-- 但同一批次同一节点只有一行（唯一约束），重试在行内累加尝试次数并换新幂等键。
-- 未定价节点 amount_cents 保持 NULL（待核价），绝不写 0；0 只表示明确的免费节点
-- （商品资料、提示词、模板合成、交付候选）。

CREATE TABLE IF NOT EXISTS sj_workflow_runs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  deliverable_id uuid NOT NULL,
  workflow_instance_id uuid NOT NULL REFERENCES sj_workflow_instances (id) ON DELETE RESTRICT,
  -- 估价时实例的 revision；确认时若实例已被改动则拒绝并要求重新估价。
  instance_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- 冻结的节点/边/锁定集合：执行只读这份快照。
  graph jsonb NOT NULL,
  estimate jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimate_total_cents bigint,
  estimate_pending_count integer NOT NULL DEFAULT 0,
  reserved_cents bigint NOT NULL DEFAULT 0,
  settled_cents bigint NOT NULL DEFAULT 0,
  released_cents bigint NOT NULL DEFAULT 0,
  -- 确认前为 NULL；确认后为本次确认的幂等键，跨运行唯一。
  idempotency_key text,
  request_hash text,
  supersedes_run_id uuid REFERENCES sj_workflow_runs (id) ON DELETE SET NULL,
  cancel_reason text,
  confirmed_at timestamptz,
  confirmed_by text,
  started_at timestamptz,
  finished_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_workflow_runs_status_valid CHECK (status IN (
    'draft', 'estimating', 'awaiting_confirmation', 'running',
    'partial_failed', 'succeeded', 'cancelled'
  )),
  CONSTRAINT sj_workflow_runs_plan_version_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_workflow_runs_instance_revision_positive CHECK (instance_revision >= 1),
  CONSTRAINT sj_workflow_runs_revision_positive CHECK (revision >= 1),
  CONSTRAINT sj_workflow_runs_graph_object CHECK (jsonb_typeof(graph) = 'object'),
  CONSTRAINT sj_workflow_runs_estimate_object CHECK (jsonb_typeof(estimate) = 'object'),
  CONSTRAINT sj_workflow_runs_amounts_nonnegative CHECK (
    (estimate_total_cents IS NULL OR estimate_total_cents >= 0)
    AND estimate_pending_count >= 0
    AND reserved_cents >= 0
    AND settled_cents >= 0
    AND released_cents >= 0
  ),
  -- 确认开跑后必须有确认人/时间与幂等键（待确认草稿与确认前取消可以为空）。
  CONSTRAINT sj_workflow_runs_confirmed_fields CHECK (
    status IN ('draft', 'estimating', 'awaiting_confirmation', 'cancelled')
    OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND idempotency_key IS NOT NULL)
  ),
  CONSTRAINT sj_workflow_runs_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sj_workflow_runs_workspace_updated
  ON sj_workflow_runs (workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS sj_workflow_runs_instance
  ON sj_workflow_runs (workflow_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_workflow_runs_project
  ON sj_workflow_runs (project_id, plan_version, deliverable_id);
-- 一个实例同时最多一份未确认的估价草稿；重复估价更新它，而不是堆出多份。
CREATE UNIQUE INDEX IF NOT EXISTS sj_workflow_runs_open_instance
  ON sj_workflow_runs (workspace_id, workflow_instance_id)
  WHERE idempotency_key IS NULL AND status IN ('draft', 'estimating', 'awaiting_confirmation');

CREATE TABLE IF NOT EXISTS sj_workflow_node_runs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES sj_workflow_runs (id) ON DELETE CASCADE,
  workspace_id text NOT NULL DEFAULT 'local',
  -- 节点 id 来自工作流图，同一批次内稳定。
  node_id text NOT NULL,
  node_type text NOT NULL,
  node_name text,
  status text NOT NULL DEFAULT 'pending',
  depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 生成任务：节点提交后写入；未提交或未定价节点保留 NULL。
  job_id uuid REFERENCES sj_generation_jobs (id) ON DELETE SET NULL,
  job_request_id uuid,
  quote jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 节点产物摘要（生成任务输出引用）；执行前为空对象。
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 报价金额；待核价为 NULL。
  amount_cents bigint,
  -- 本节点当前仍持有的预占；失败/阻塞/取消后清零。
  reserved_cents bigint NOT NULL DEFAULT 0,
  -- 成功后的结算金额；待核价成功时仍为 NULL。
  actual_cost_cents bigint,
  -- 账本 task_id：首次为节点运行编号，重试追加 :aN，保证每次尝试单独预占/结算。
  billing_task_id text,
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  attempt_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  -- 由上一批次沿用（已成功/已跳过），不重新执行、不重复计费。
  reused boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_workflow_node_runs_type_valid CHECK (node_type IN (
    'input', 'prompt', 'generate', 'edit', 'composite', 'output'
  )),
  CONSTRAINT sj_workflow_node_runs_status_valid CHECK (status IN (
    'pending', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'blocked', 'skipped'
  )),
  CONSTRAINT sj_workflow_node_runs_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT sj_workflow_node_runs_amounts_nonnegative CHECK (
    (amount_cents IS NULL OR amount_cents >= 0)
    AND reserved_cents >= 0
    AND (actual_cost_cents IS NULL OR actual_cost_cents >= 0)
  ),
  CONSTRAINT sj_workflow_node_runs_depends_array CHECK (jsonb_typeof(depends_on) = 'array'),
  CONSTRAINT sj_workflow_node_runs_quote_object CHECK (jsonb_typeof(quote) = 'object'),
  CONSTRAINT sj_workflow_node_runs_output_object CHECK (jsonb_typeof(output) = 'object'),
  CONSTRAINT sj_workflow_node_runs_history_array CHECK (jsonb_typeof(attempt_history) = 'array'),
  -- 同一批次同一节点只有一行。
  CONSTRAINT sj_workflow_node_runs_node_unique UNIQUE (run_id, node_id),
  CONSTRAINT sj_workflow_node_runs_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sj_workflow_node_runs_run_status
  ON sj_workflow_node_runs (run_id, status, node_id);
CREATE INDEX IF NOT EXISTS sj_workflow_node_runs_job
  ON sj_workflow_node_runs (job_id);
