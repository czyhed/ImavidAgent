-- 商品档案、SKU 与不可变版本快照（Issue #2）。
-- 一期只有一个工作空间，workspace_id 预留并默认 'local'，避免日后多租户迁移全部表。
-- 价格缺失必须是 NULL，不能写 0；价格按 SKU 保存，币种与类型随价格一起记录。
-- 版本快照写入后只能追加，业务代码不提供更新或删除版本的接口。

CREATE TABLE IF NOT EXISTS sj_products (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  name text NOT NULL,
  original_title text,
  brand text,
  category text,
  description text,
  internal_code text,
  source_type text NOT NULL DEFAULT 'manual',
  source_platform text,
  source_url text,
  source_product_id text,
  status text NOT NULL DEFAULT 'draft',
  current_version integer NOT NULL DEFAULT 1,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_products_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT sj_products_status_valid CHECK (status IN ('draft', 'pending', 'confirmed')),
  CONSTRAINT sj_products_source_type_valid CHECK (source_type IN ('manual', 'link', 'screenshot')),
  CONSTRAINT sj_products_version_positive CHECK (current_version >= 1)
);

CREATE INDEX IF NOT EXISTS sj_products_workspace_updated
  ON sj_products (workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS sj_products_workspace_status
  ON sj_products (workspace_id, status);
CREATE INDEX IF NOT EXISTS sj_products_workspace_source
  ON sj_products (workspace_id, source_type);

CREATE TABLE IF NOT EXISTS sj_product_skus (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES sj_products (id) ON DELETE CASCADE,
  workspace_id text NOT NULL DEFAULT 'local',
  internal_sku text,
  source_sku_id text,
  spec text,
  is_selected boolean NOT NULL DEFAULT true,
  price_amount numeric(18, 4),
  price_min numeric(18, 4),
  price_max numeric(18, 4),
  currency text,
  price_type text,
  price_condition text,
  price_captured_at timestamptz,
  parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_product_skus_price_nonnegative CHECK (
    (price_amount IS NULL OR price_amount >= 0)
    AND (price_min IS NULL OR price_min >= 0)
    AND (price_max IS NULL OR price_max >= 0)
  ),
  CONSTRAINT sj_product_skus_price_range CHECK (
    price_min IS NULL OR price_max IS NULL OR price_min <= price_max
  ),
  CONSTRAINT sj_product_skus_currency_valid CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT sj_product_skus_price_type_valid CHECK (
    price_type IS NULL OR price_type IN ('sale', 'starting', 'list', 'coupon', 'member')
  )
);

CREATE INDEX IF NOT EXISTS sj_product_skus_product
  ON sj_product_skus (product_id, created_at);

CREATE TABLE IF NOT EXISTS sj_product_versions (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES sj_products (id) ON DELETE CASCADE,
  workspace_id text NOT NULL DEFAULT 'local',
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_reason text,
  created_by text NOT NULL DEFAULT 'local',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_product_versions_version_positive CHECK (version >= 1),
  CONSTRAINT sj_product_versions_unique UNIQUE (product_id, version)
);

CREATE INDEX IF NOT EXISTS sj_product_versions_product
  ON sj_product_versions (product_id, version DESC);
