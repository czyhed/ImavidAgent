-- 0017: 官方 OpenAI 标准生图渠道的商品原图输入协议登记（Issue #26）。
-- omyai-openai 走 /images/edits；OMYAI 网关拒绝 multipart，改用 JSON base64 data URL。
-- 这里只登记协议证据，不自动启用输入设置；启用仍由现有 #9 门禁显式操作。
-- MCP 渠道 omyai 没有任意图片上传协议，继续禁止，不在此登记。

INSERT INTO sj_model_input_verifications (
  id, workspace_id, provider_id, model_id, protocol, transport, status, evidence, verified_at
)
SELECT
  '00000000-0000-4000-8000-000000000026',
  'local',
  'omyai-openai',
  'omyai-openai:gpt-image-2.5-flare',
  'openai-images-edits-v1',
  'json-data-url',
  'verified',
  '{
    "source": "official-openai-standard",
    "endpoint": "/v1/images/edits",
    "field": "image",
    "encoding": "data:image/png;base64",
    "generateEndpointVerified": true,
    "generateModel": "gpt-image-2.5-flare",
    "note": "OMYAI multipart rejected with 400 Model name not specified; JSON data URL returned HTTP 200 with data[0].b64_json. No repeated paid edit call in this change."
  }'::jsonb,
  '2026-10-21T00:00:00Z'
WHERE NOT EXISTS (
  SELECT 1 FROM sj_model_input_verifications
  WHERE workspace_id = 'local'
    AND provider_id = 'omyai-openai'
    AND protocol = 'openai-images-edits-v1'
);
