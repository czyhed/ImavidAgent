-- 素材全量索引（Issue #4）。每次成功的真实生成/改图各占一行，来源类型 + 来源 ID + 版本唯一，
-- 因此同一个供应商回调重复写入不会产生重复素材。
-- created_at 保留原任务创建时间（历史回填也使用它），indexed_at 才是索引写入时间。
-- 文件在对象存储中缺失时保留记录，只把 file_available 标为 false，不从列表消失。
-- 示意图属于模板资源：source_type='template'，不计入真实产出统计，也不进入默认列表。

CREATE TABLE IF NOT EXISTS sj_assets (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  source_type text NOT NULL,
  source_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  chain_position integer NOT NULL DEFAULT 1,
  media_type text NOT NULL DEFAULT 'image',
  title text,
  prompt text,
  model_id text,
  provider_id text,
  operation text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_type text NOT NULL,
  object_key text NOT NULL,
  filename text,
  bytes bigint,
  file_available boolean NOT NULL DEFAULT true,
  missing_reason text,
  root_id uuid REFERENCES sj_assets (id) ON DELETE SET NULL,
  parent_id uuid REFERENCES sj_assets (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_assets_source_unique UNIQUE (source_type, source_id, version),
  CONSTRAINT sj_assets_source_type_valid
    CHECK (source_type IN ('generation', 'edit', 'project', 'template')),
  CONSTRAINT sj_assets_media_type_valid CHECK (media_type IN ('image', 'video')),
  CONSTRAINT sj_assets_version_positive CHECK (version >= 1),
  CONSTRAINT sj_assets_chain_positive CHECK (chain_position >= 1),
  CONSTRAINT sj_assets_bytes_nonnegative CHECK (bytes IS NULL OR bytes >= 0)
);

-- 稳定游标分页：按 created_at DESC, id DESC 读取；id 用于同一时间戳的确定性排序。
CREATE INDEX IF NOT EXISTS sj_assets_created_cursor
  ON sj_assets (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sj_assets_source
  ON sj_assets (workspace_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS sj_assets_root
  ON sj_assets (root_id, chain_position);
CREATE INDEX IF NOT EXISTS sj_assets_media_created
  ON sj_assets (workspace_id, media_type, created_at DESC, id DESC);
