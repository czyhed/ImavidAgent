-- 回收站分页：按移入时间倒序读取已移入回收站的记录；部分索引只覆盖回收站行，幂等且不改动数据。
CREATE INDEX IF NOT EXISTS sj_creation_records_trash ON sj_creation_records(workspace_id,trashed_at DESC,id) WHERE trashed_at IS NOT NULL;
