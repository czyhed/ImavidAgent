-- 0004: 平台价格档位与内部额度账本（Issue #7）。
-- 金额口径：amount_cents 为平台结算金额（整数分，调整可为负）；cost_micros 为供应商
-- 成本（微元，仅记录，不影响内部可用额度）。未知价格/未知成本写 NULL，绝不写 0。
-- 账本只追加：没有更新或删除流水的接口；唯一约束与部分唯一索引兜底重复回调。
-- 价格是版本化的：改价先停用当前 active 行再插入新版本，历史行与任务快照不被覆盖。

CREATE TABLE IF NOT EXISTS sj_model_prices (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  capability text NOT NULL,
  model_id text NOT NULL,
  tier text NOT NULL DEFAULT 'default',
  unit text NOT NULL,
  currency text NOT NULL DEFAULT 'CNY',
  unit_price numeric(30, 12) NOT NULL,
  billing_mode text NOT NULL DEFAULT 'chargeable',
  version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_model_prices_unit_price_nonnegative CHECK (unit_price >= 0),
  CONSTRAINT sj_model_prices_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT sj_model_prices_mode_valid CHECK (billing_mode IN ('chargeable', 'cost_only')),
  CONSTRAINT sj_model_prices_unit_valid CHECK (unit IN (
    'image', 'call', 'second', 'minute', 'character', 'thousand_characters',
    'token', 'thousand_tokens', 'million_tokens'
  )),
  CONSTRAINT sj_model_prices_version_positive CHECK (version >= 1),
  CONSTRAINT sj_model_prices_key_version UNIQUE (workspace_id, capability, model_id, tier, version)
);

-- 同一模型能力档位只能有一个生效行；历史版本用 active=false 保留。
CREATE UNIQUE INDEX IF NOT EXISTS sj_model_prices_active_key
  ON sj_model_prices (workspace_id, capability, model_id, tier)
  WHERE active;

CREATE INDEX IF NOT EXISTS sj_model_prices_lookup
  ON sj_model_prices (workspace_id, capability, model_id, tier, effective_from DESC);

CREATE TABLE IF NOT EXISTS sj_billing_ledger (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  task_id text NOT NULL,
  entry_type text NOT NULL,
  amount_cents bigint,
  cost_micros bigint,
  currency text NOT NULL DEFAULT 'CNY',
  billing_mode text NOT NULL DEFAULT 'chargeable',
  capability text,
  model_id text,
  tier text,
  quantity integer,
  unit text,
  unit_price numeric(30, 12),
  price_id uuid,
  price_version integer,
  project_id text,
  actor_id text,
  reason text,
  reference text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_billing_ledger_type_valid CHECK (entry_type IN (
    'adjustment', 'reserve', 'release', 'settle', 'pending_price', 'supplement', 'cost_only'
  )),
  CONSTRAINT sj_billing_ledger_mode_valid CHECK (billing_mode IN ('chargeable', 'cost_only')),
  -- 预占、结算、补价必须是有价的正整数分；调整可正可负但不能是 0；
  -- 释放、待核价、仅记成本没有内部扣款时必须是 NULL（未知不是 0）。
  CONSTRAINT sj_billing_ledger_amount_valid CHECK (
    (entry_type IN ('reserve', 'settle', 'supplement') AND amount_cents IS NOT NULL AND amount_cents > 0)
    OR (entry_type = 'adjustment' AND amount_cents IS NOT NULL AND amount_cents <> 0)
    OR (entry_type IN ('release', 'pending_price', 'cost_only')
        AND (amount_cents IS NULL OR amount_cents > 0))
  ),
  CONSTRAINT sj_billing_ledger_cost_valid CHECK (cost_micros IS NULL OR cost_micros >= 0),
  CONSTRAINT sj_billing_ledger_key_unique UNIQUE (workspace_id, idempotency_key)
);

-- 一个业务任务最多一次预占、一次待核价标记、一次结算/补价、一次释放；
-- 即使服务层检查被绕过，数据库也会拒绝重复入账。
CREATE UNIQUE INDEX IF NOT EXISTS sj_billing_ledger_task_reserve
  ON sj_billing_ledger (workspace_id, task_id) WHERE entry_type = 'reserve';
CREATE UNIQUE INDEX IF NOT EXISTS sj_billing_ledger_task_pending
  ON sj_billing_ledger (workspace_id, task_id) WHERE entry_type = 'pending_price';
CREATE UNIQUE INDEX IF NOT EXISTS sj_billing_ledger_task_terminal
  ON sj_billing_ledger (workspace_id, task_id)
  WHERE entry_type IN ('settle', 'release', 'supplement');

CREATE INDEX IF NOT EXISTS sj_billing_ledger_workspace_created
  ON sj_billing_ledger (workspace_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sj_billing_ledger_task
  ON sj_billing_ledger (workspace_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS sj_billing_ledger_model
  ON sj_billing_ledger (workspace_id, model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_billing_ledger_type
  ON sj_billing_ledger (workspace_id, entry_type, created_at DESC);
