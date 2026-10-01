-- 0003: persistent model registry, defaults, aliases and gateway calls.
-- Catalog sync may add or update rows, but must not silently delete or disable
-- administrator-managed configuration (FUNCTIONAL_SPEC MODEL-02).

CREATE TABLE IF NOT EXISTS sj_models (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  upstream_model text NOT NULL,
  name text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'config',
  enabled boolean NOT NULL DEFAULT true,
  executable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sj_models_provider
ON sj_models (provider_id);

CREATE TABLE IF NOT EXISTS sj_model_defaults (
  capability text PRIMARY KEY,
  model_id text NOT NULL REFERENCES sj_models (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sj_model_aliases (
  alias text PRIMARY KEY,
  model_id text NOT NULL REFERENCES sj_models (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sj_model_calls (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  capability text NOT NULL,
  model_id text,
  alias text,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  response jsonb,
  usage jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sj_model_calls_created
ON sj_model_calls (created_at DESC);

CREATE INDEX IF NOT EXISTS sj_model_calls_model
ON sj_model_calls (model_id);
