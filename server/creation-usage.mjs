import { knownCost } from './creation-overview.mjs';

// 实际用量与成本明细：生成记录（sj_creation_runs）与模型调用 / 已删除任务保留的费用审计（sj_creation_audit）合并，
// 在 SQL 里按 created_at DESC, id DESC 排序分页；行结构与工作台表格一致。page：{limit,offset}。
export class CreationUsage {
  constructor(store) { this.store = store; }
  async list(workspace, { limit = 20, offset = 0 } = {}) {
    const pool = this.store.pool;
    const [count, rows] = await Promise.all([
      pool.query(`SELECT (SELECT count(*) FROM sj_creation_runs WHERE workspace_id=$1)+(SELECT count(*) FROM sj_creation_audit WHERE workspace_id=$1 AND action IN ('model.complete','creation.retained-cost')) AS n`, [workspace]),
      pool.query(`SELECT * FROM (
        SELECT r.id, 'run' AS source, r.project_id, p.body->>'name' AS project_name, r.task_id, r.input->'task'->>'title' AS task_title, NULL::text AS stage, NULL::text AS model_id, r.status, r.usage, r.created_at
          FROM sj_creation_runs r JOIN sj_creation_records p ON p.id=r.project_id WHERE r.workspace_id=$1
        UNION ALL
        SELECT a.id, 'model', NULL::uuid, NULL, NULL, NULL, CASE WHEN a.action='creation.retained-cost' THEN 'deleted-generation' ELSE a.detail->>'stage' END, a.detail->>'modelId', 'recorded', a.detail->'usage', a.created_at
          FROM sj_creation_audit a WHERE a.workspace_id=$1 AND a.action IN ('model.complete','creation.retained-cost')
      ) u ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [workspace, limit, offset]),
    ]);
    const total = Number(count.rows[0].n);
    const items = rows.rows.map(r => ({ id: r.id, source: r.source, projectId: r.project_id, projectName: r.project_name, taskId: r.source === 'run' ? r.task_id : r.model_id || '', taskTitle: r.task_title, stage: r.stage, modelId: r.model_id, status: r.status, usage: r.usage, costMicros: knownCost(r.usage), currency: r.usage?.currency || null, createdAt: r.created_at }));
    return { items, total };
  }
}
