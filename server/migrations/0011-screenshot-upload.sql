-- 0011: 截图先上传、识别成功后再归属商品（Issue #23）。
-- #9 的图片上传要求先有商品，#10 的截图识别又信任客户端提供的对象键与指纹；
-- 本迁移允许 kind='screenshot' 的记录在建档前存在（product_id 为空），
-- 原图仍必须绑定商品。对象键继续由服务端生成并校验形状：
--   原图    products/{productId}/originals/{imageId}.{ext}
--   截图    products/{productId}/screenshots/{imageId}.{ext}（上传时已绑定商品）
--           screenshots/{imageId}.{ext}（建档前上传，识别成功后回填 product_id）
-- 不修改 0009 / 0010 已应用的内容，只追加本文件。

ALTER TABLE sj_product_images ALTER COLUMN product_id DROP NOT NULL;

-- 只有来源截图可以在建档前存在；商品原图必须绑定商品。
ALTER TABLE sj_product_images DROP CONSTRAINT IF EXISTS sj_product_images_product_binding;
ALTER TABLE sj_product_images ADD CONSTRAINT sj_product_images_product_binding
  CHECK (product_id IS NOT NULL OR kind = 'screenshot');

-- 保持对象键形状校验，并为未绑定商品的截图增加服务端目录形状。
ALTER TABLE sj_product_images DROP CONSTRAINT IF EXISTS sj_product_images_key_shape;
ALTER TABLE sj_product_images ADD CONSTRAINT sj_product_images_key_shape CHECK (
  (kind = 'original' AND object_key ~ '^products/[0-9a-f-]{36}/originals/[0-9a-f-]{36}\.(png|jpg|webp)$')
  OR (kind = 'screenshot' AND (
    object_key ~ '^products/[0-9a-f-]{36}/screenshots/[0-9a-f-]{36}\.(png|jpg|webp)$'
    OR object_key ~ '^screenshots/[0-9a-f-]{36}\.(png|jpg|webp)$'
  ))
);

-- 目录与 kind 的对应关系同样保留；未绑定截图直接位于 screenshots/ 下。
ALTER TABLE sj_product_images DROP CONSTRAINT IF EXISTS sj_product_images_key_kind;
ALTER TABLE sj_product_images ADD CONSTRAINT sj_product_images_key_kind CHECK (
  (kind = 'original' AND object_key LIKE 'products/%/originals/%')
  OR (kind = 'screenshot' AND (
    object_key LIKE 'products/%/screenshots/%' OR object_key LIKE 'screenshots/%'
  ))
);

-- 识别批次按 imageId 读取待绑定截图；部分索引只覆盖建当前未归属的记录。
CREATE INDEX IF NOT EXISTS sj_product_images_unbound_screenshots
  ON sj_product_images (workspace_id, created_at DESC)
  WHERE kind = 'screenshot' AND product_id IS NULL;
