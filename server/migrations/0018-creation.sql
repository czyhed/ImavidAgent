CREATE TABLE sj_creation_records (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('product','project','asset','template')),
 revision integer NOT NULL DEFAULT 1, body jsonb NOT NULL, trashed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sj_creation_records_scope ON sj_creation_records(workspace_id,kind,updated_at DESC);
CREATE TABLE sj_creation_runs (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, project_id uuid NOT NULL REFERENCES sj_creation_records(id),
 task_id text NOT NULL, request_key uuid NOT NULL, input jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
 upstream_id text, output jsonb, error jsonb, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX sj_creation_runs_scope ON sj_creation_runs(workspace_id,project_id,created_at);
CREATE TABLE sj_channel_models (
 channel_id text NOT NULL, model_id text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT false,
 capabilities jsonb NOT NULL DEFAULT '[]', available boolean NOT NULL DEFAULT true, manual boolean NOT NULL DEFAULT false,
 PRIMARY KEY(channel_id,model_id)
);
CREATE TABLE sj_creation_defaults (stage text PRIMARY KEY, channel_id text NOT NULL, model_id text NOT NULL);
CREATE TABLE sj_creation_audit (id uuid PRIMARY KEY, workspace_id text NOT NULL, action text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
