# 迁移

编号 SQL 文件，例如 `0002-product-tables.sql`。启动时按文件名顺序执行一次，记录在 `sj_schema_migrations`，每个文件在事务中执行。
只追加新文件，不要修改已应用的迁移。
