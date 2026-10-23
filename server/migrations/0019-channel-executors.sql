-- 渠道表也支持首次启动时由ChannelStore.init创建；两处使用幂等加列。
ALTER TABLE IF EXISTS sj_model_channels ADD COLUMN IF NOT EXISTS executor_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS sj_model_channels ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
