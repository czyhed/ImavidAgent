-- 0012: AI 查价候选与管理员采用（Issue #20）。
-- 查价记录与候选分开：一次查价可能返回多条官方/渠道候选，也可能失败或无结果。
-- 候选只是待确认草稿，不进入 sj_model_prices；只有管理员采用时才写入新的价格版本。
-- 未确认、无来源或已过期的候选不参与估价；采用动作记录操作者、依据与生效价格版本。

CREATE TABLE IF NOT EXISTS sj_price_lookups (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  capability text NOT NULL,
  model_id text NOT NULL,
  tier text NOT NULL DEFAULT 'default',
  region text,
  status text NOT NULL,
  candidate_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_price_lookups_status_valid CHECK (status IN ('completed', 'empty', 'failed')),
  CONSTRAINT sj_price_lookups_counts_valid CHECK (candidate_count >= 0 AND rejected_count >= 0)
);

CREATE INDEX IF NOT EXISTS sj_price_lookups_model
  ON sj_price_lookups (workspace_id, capability, model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_price_lookups_created
  ON sj_price_lookups (workspace_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS sj_price_candidates (
  id uuid PRIMARY KEY,
  lookup_id uuid NOT NULL REFERENCES sj_price_lookups(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL DEFAULT 'local',
  capability text NOT NULL,
  model_id text NOT NULL,
  tier text NOT NULL DEFAULT 'default',
  version integer NOT NULL,
  region text,
  currency text NOT NULL DEFAULT 'CNY',
  unit text NOT NULL,
  unit_price numeric(30, 12) NOT NULL,
  source_url text NOT NULL,
  source_title text NOT NULL,
  model_version text,
  match_note text,
  confidence numeric(5, 4),
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  adopted_by text,
  adopted_at timestamptz,
  adoption_basis text,
  adopted_price_id uuid REFERENCES sj_model_prices(id),
  adopted_price_version integer,
  adopted_expired boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_price_candidates_status_valid CHECK (
    status IN ('pending', 'adopted', 'superseded', 'rejected')
  ),
  CONSTRAINT sj_price_candidates_unit_valid CHECK (unit IN (
    'image', 'call', 'second', 'minute', 'character', 'thousand_characters',
    'token', 'thousand_tokens', 'million_tokens'
  )),
  CONSTRAINT sj_price_candidates_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT sj_price_candidates_price_nonnegative CHECK (unit_price >= 0),
  CONSTRAINT sj_price_candidates_source_required CHECK (
    length(btrim(source_url)) > 0 AND length(btrim(source_title)) > 0
  ),
  CONSTRAINT sj_price_candidates_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT sj_price_candidates_version_positive CHECK (version >= 1),
  CONSTRAINT sj_price_candidates_key_version UNIQUE (
    workspace_id, capability, model_id, tier, version
  ),
  -- 采用必须完整留痕；未采用的候选不得带采用字段。
  CONSTRAINT sj_price_candidates_adoption_complete CHECK (
    (status = 'adopted'
      AND adopted_by IS NOT NULL
      AND adopted_at IS NOT NULL
      AND adoption_basis IS NOT NULL
      AND adopted_price_id IS NOT NULL
      AND adopted_price_version IS NOT NULL)
    OR (status <> 'adopted'
      AND adopted_by IS NULL
      AND adopted_at IS NULL
      AND adoption_basis IS NULL
      AND adopted_price_id IS NULL
      AND adopted_price_version IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sj_price_candidates_lookup
  ON sj_price_candidates (workspace_id, lookup_id, version);
CREATE INDEX IF NOT EXISTS sj_price_candidates_model
  ON sj_price_candidates (workspace_id, capability, model_id, tier, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_price_candidates_status
  ON sj_price_candidates (workspace_id, status, expires_at);
