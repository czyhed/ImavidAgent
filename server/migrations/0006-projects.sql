-- 项目、方案版本与确认冻结（Issue #12）。
-- 一个项目 = 一个商品 × 一个 SKU × 一次交付。方案版本保存交付项清单、类型、数量、
-- 提示词槽位、参数与价格快照；确认时同时冻结商品资料版本快照（product_snapshot）。
-- 确认后的方案行不再接受内容修改，变更由服务层创建下一版本（v2、v3…）。
-- 交付项价格只来自服务端估价：没有价格时 amountCents 为 NULL，绝不写 0。
-- 步骤状态由 sj_project_events 追加事件推进；列表进度按六步中已完成数计算（4/6 口径）。

CREATE TABLE IF NOT EXISTS sj_projects (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  name text NOT NULL,
  product_id uuid NOT NULL REFERENCES sj_products (id) ON DELETE RESTRICT,
  -- SKU 不加外键：商品编辑会在同一事务内删除并重建 SKU 行（保留编号），
  -- 外键会让已引用该 SKU 的项目阻止商品改版。
  sku_id uuid NOT NULL,
  sku_spec text,
  owner_id text,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  current_plan_version integer NOT NULL DEFAULT 1,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_projects_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT sj_projects_status_valid CHECK (status IN (
    'draft', 'active', 'review', 'completed', 'cancelled'
  )),
  CONSTRAINT sj_projects_version_positive CHECK (version >= 1),
  CONSTRAINT sj_projects_current_plan_positive CHECK (current_plan_version >= 1)
);

CREATE INDEX IF NOT EXISTS sj_projects_workspace_updated
  ON sj_projects (workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS sj_projects_workspace_status
  ON sj_projects (workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS sj_projects_product
  ON sj_projects (workspace_id, product_id);

CREATE TABLE IF NOT EXISTS sj_project_plans (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  workspace_id text NOT NULL DEFAULT 'local',
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  requirement text,
  deliverables jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_version integer,
  product_snapshot jsonb,
  sku_snapshot jsonb,
  price jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_reason text,
  confirmed_at timestamptz,
  confirmed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_project_plans_version_positive CHECK (version >= 1),
  CONSTRAINT sj_project_plans_revision_positive CHECK (revision >= 1),
  CONSTRAINT sj_project_plans_status_valid CHECK (status IN ('draft', 'confirmed')),
  CONSTRAINT sj_project_plans_deliverables_array CHECK (jsonb_typeof(deliverables) = 'array'),
  CONSTRAINT sj_project_plans_price_object CHECK (jsonb_typeof(price) = 'object'),
  -- 已确认方案必须冻结资料版本快照、确认时间与确认人。
  CONSTRAINT sj_project_plans_confirmed_snapshot CHECK (
    status = 'draft'
    OR (product_version IS NOT NULL AND product_snapshot IS NOT NULL
        AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
  ),
  CONSTRAINT sj_project_plans_project_version UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS sj_project_plans_project
  ON sj_project_plans (project_id, version DESC);
CREATE INDEX IF NOT EXISTS sj_project_plans_workspace_status
  ON sj_project_plans (workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sj_project_events (
  id uuid PRIMARY KEY,
  -- 追加顺序是步骤状态的唯一依据；同一毫秒内的事件也必须可稳定排序。
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  workspace_id text NOT NULL DEFAULT 'local',
  step integer NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL,
  source text NOT NULL DEFAULT 'user',
  note text,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_project_events_step_valid CHECK (step BETWEEN 1 AND 6),
  CONSTRAINT sj_project_events_status_valid CHECK (status IN (
    'in_progress', 'completed', 'needs_review', 'skipped'
  )),
  CONSTRAINT sj_project_events_source_valid CHECK (source IN ('user', 'system'))
);

CREATE INDEX IF NOT EXISTS sj_project_events_project
  ON sj_project_events (project_id, seq);
