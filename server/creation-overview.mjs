export class CreationOverview {
  constructor(store) { this.store = store; }
  async get(workspace) {
    const pool = this.store.pool;
    const [counts, states, recentProjects, recentRuns, amounts, recentUsage] = await Promise.all([
      pool.query(`SELECT kind,count(*)::int AS n FROM sj_creation_records WHERE workspace_id=$1 AND trashed_at IS NULL GROUP BY kind`,[workspace]),
      pool.query(`SELECT status,count(*)::int AS n FROM sj_creation_runs WHERE workspace_id=$1 GROUP BY status`,[workspace]),
      pool.query(`SELECT id,body,body->>'name' AS name,updated_at FROM sj_creation_records WHERE workspace_id=$1 AND kind='project' AND trashed_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 12`,[workspace]),
      pool.query(`SELECT r.id,r.project_id,r.task_id,r.status,r.usage,r.input,r.created_at,p.body->>'name' AS project_name FROM sj_creation_runs r JOIN sj_creation_records p ON p.id=r.project_id WHERE r.workspace_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,[workspace]),
      pool.query(`SELECT usage FROM sj_creation_runs WHERE workspace_id=$1 UNION ALL SELECT detail->'usage' AS usage FROM sj_creation_audit WHERE workspace_id=$1 AND action IN ('model.complete','creation.retained-cost')`,[workspace]),
      pool.query(`SELECT id,detail,action,created_at FROM sj_creation_audit WHERE workspace_id=$1 AND action IN ('model.complete','creation.retained-cost') ORDER BY created_at DESC,id DESC LIMIT 100`,[workspace]),
    ]);
    const metrics={products:0,projects:0,assets:0,tasks:0,running:0,succeeded:0,failed:0,unknown:0};
    for(const r of counts.rows) if(r.kind!=='template') metrics[r.kind+'s']=r.n;
    for(const r of states.rows){metrics.tasks+=r.n;if(['queued','submitting','running','storing'].includes(r.status))metrics.running+=r.n;else if(r.status in metrics)metrics[r.status]+=r.n;}
    const totals=new Map();let unknown=0;
    for(const {usage} of amounts.rows){
      const amount=knownCost(usage);
      if(amount===null){unknown++;continue;}
      const currency=usage.currency||'未提供币种';totals.set(currency,(totals.get(currency)||0)+amount);
    }
    return {metrics,modelUsage:recentUsage.rows.map(r=>({id:r.id,stage:r.action==='creation.retained-cost'?'deleted-generation':r.detail.stage,modelId:r.detail.modelId||null,usage:r.detail.usage,costMicros:knownCost(r.detail.usage),currency:r.detail.usage?.currency||null,createdAt:r.created_at})),costs:{totals:[...totals].map(([currency,costMicros])=>({currency,costMicros})),unknown},
      projects:recentProjects.rows.map(r=>({id:r.id,name:r.name,updatedAt:r.updated_at,taskCount:r.body.workflows?.length||1,coverAssetId:r.body.tasks?.find(t=>t.sourceAssetId)?.sourceAssetId||null})),
      runs:recentRuns.rows.map(r=>({id:r.id,projectId:r.project_id,projectName:r.project_name,taskId:r.task_id,taskTitle:r.input?.task?.title||null,status:r.status,usage:r.usage,costMicros:knownCost(r.usage),currency:r.usage?.currency||null,createdAt:r.created_at}))};
  }
}
// 查看者角色不返回用量与费用（概览与用量明细共用）。
export const redactUsageRows=rows=>rows.map(({usage,costMicros,currency,...r})=>r);
export function knownCost(usage){return Number.isFinite(usage?.costMicros)&&usage.costMicros>=0?usage.costMicros:null;}
