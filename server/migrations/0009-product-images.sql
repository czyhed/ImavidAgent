-- 0009: 商品原图 / 来源截图私有存储与模型输入验证门禁（Issue #9）。
-- 原图与来源截图分表内 kind 区分，并在对象键目录上再分开（originals / screenshots）。
-- 对象键只能由服务端生成；数据库校验键形状，拒绝客户端路径。
-- 未经真实供应商接收验证，原图输入不得启用：settings.enabled=true 必须引用一条
-- sj_model_input_verifications 记录，业务层还要求该记录 status='verified'。

CREATE TABLE IF NOT EXISTS sj_product_images (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  product_id uuid NOT NULL REFERENCES sj_products (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  extension text NOT NULL,
  bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_product_images_kind_valid CHECK (kind IN ('original', 'screenshot')),
  CONSTRAINT sj_product_images_content_type_valid
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT sj_product_images_extension_valid CHECK (extension IN ('png', 'jpg', 'webp')),
  CONSTRAINT sj_product_images_bytes_valid CHECK (bytes BETWEEN 1 AND 10485760),
  CONSTRAINT sj_product_images_dimensions_valid
    CHECK (width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192),
  CONSTRAINT sj_product_images_sha256_valid CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sj_product_images_key_shape CHECK (
    object_key ~ '^products/[0-9a-f-]{36}/(originals|screenshots)/[0-9a-f-]{36}\.(png|jpg|webp)$'
  ),
  CONSTRAINT sj_product_images_key_kind CHECK (
    (kind = 'original' AND object_key LIKE '%/originals/%')
    OR (kind = 'screenshot' AND object_key LIKE '%/screenshots/%')
  )
);

CREATE INDEX IF NOT EXISTS sj_product_images_product
  ON sj_product_images (workspace_id, product_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS sj_model_input_verifications (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  provider_id text NOT NULL,
  model_id text,
  protocol text NOT NULL,
  transport text,
  status text NOT NULL DEFAULT 'pending',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_model_input_verifications_status_valid
    CHECK (status IN ('pending', 'verified', 'failed')),
  CONSTRAINT sj_model_input_verifications_provider_valid
    CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT sj_model_input_verifications_protocol_valid
    CHECK (protocol ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT sj_model_input_verifications_verified_at
    CHECK (status <> 'verified' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS sj_model_input_verifications_lookup
  ON sj_model_input_verifications (workspace_id, provider_id, protocol, status, verified_at DESC);

CREATE TABLE IF NOT EXISTS sj_product_image_input_settings (
  workspace_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  provider_id text,
  model_id text,
  protocol text,
  verification_id uuid REFERENCES sj_model_input_verifications (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_product_image_input_settings_verified
    CHECK (enabled = false OR (provider_id IS NOT NULL AND protocol IS NOT NULL AND verification_id IS NOT NULL))
);

-- Do not seed any verification or settings row. OMYAI has no documented arbitrary image
-- upload protocol; the gate must stay closed until a real acceptance run is recorded.
