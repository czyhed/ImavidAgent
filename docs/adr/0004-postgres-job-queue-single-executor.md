# 生成任务队列先用 PostgreSQL + advisory lock 单执行器

Redis 已部署并约定 `sj:` / `sj:bullmq` 前缀，但生成任务的事实来源必须是持久、可审计的数据库记录，Redis AOF everysec 也不保证零丢失。当前用 PostgreSQL 表做队列、advisory lock 保证同库只有一个执行器，最多 10 个排队 / 执行中任务。代价是并行分支和多交付项实际串行；需要多机扩容时再引入 BullMQ，且数据库记录仍是唯一事实来源。
