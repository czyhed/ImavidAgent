# 动态渠道密钥加密存入 PostgreSQL，主密钥是本机文件

系统页新增的渠道需要服务端长期持有 API Key，又不能让浏览器、日志或配置文件看到明文。决定用 AES-256-GCM 加密后存入 `sj_model_channels`，前端只显示末四位；主密钥在 `.secrets/channel-encryption.key`（或 `CHANNEL_ENCRYPTION_KEY`）。静态渠道（OMYAI、DeepSeek）的 Key 仍放在忽略文件 `.env.models.local`。

**Consequences**：主密钥必须与数据库一起安全备份，丢失后已保存的动态渠道密钥无法恢复；尚无密钥轮换。
