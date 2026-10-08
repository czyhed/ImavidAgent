-- 截图识别批次、指纹去重与字段证据（Issue #10）。
-- 同一工作空间 + 截图集合指纹唯一：重复提交返回原记录，不重复调用视觉模型、
-- 不重复建档。截图本身应存私有桶 shangjing-assets，本表只保存对象键与指纹；
-- result 保存字段证据/置信度评审结果，不保存图片字节，也不保存账号、订单等截图内容。
-- 视觉供应商与模型仍待 Q-02 确认；billed 表示本次尝试是否调用了视觉模型（可能计费）。

CREATE TABLE IF NOT EXISTS sj_screenshot_intakes (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  fingerprint text NOT NULL,
  request_key text,
  status text NOT NULL DEFAULT 'processing',
  images jsonb NOT NULL,
  result jsonb,
  product_id uuid REFERENCES sj_products (id) ON DELETE SET NULL,
  error jsonb,
  billed boolean NOT NULL DEFAULT false,
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_screenshot_intakes_status_valid
    CHECK (status IN ('processing', 'completed', 'needs_review', 'failed')),
  CONSTRAINT sj_screenshot_intakes_fingerprint_valid
    CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sj_screenshot_intakes_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT sj_screenshot_intakes_unique UNIQUE (workspace_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS sj_screenshot_intakes_product
  ON sj_screenshot_intakes (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_screenshot_intakes_workspace_created
  ON sj_screenshot_intakes (workspace_id, created_at DESC);
