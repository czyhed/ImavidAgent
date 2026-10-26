import {createHash,randomUUID} from 'node:crypto';
import {AppError} from './errors.mjs';
const TABLES=Object.freeze(['sj_job_events','sj_generation_jobs','sj_workflow_node_runs','sj_workflow_runs','sj_workflow_instances','sj_deliverable_reviews','sj_deliverable_states','sj_refine_requests','sj_deliverable_versions','sj_project_exports','sj_project_events','sj_project_plans','sj_projects','sj_screenshot_intakes','sj_product_images','sj_product_versions','sj_product_skus','sj_products','sj_billing_ledger','sj_model_calls','sj_price_candidates','sj_price_lookups']);
function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export async function previewLegacyCleanup(pool){
 const tables=[],fingerprints=[];
 for(const name of [...TABLES,'sj_assets']){
  const filter=name==='sj_assets'?" WHERE source_type<>'template'":'';
  const r=await pool.query(`SELECT count(*)::int AS n,md5(COALESCE(string_agg(row_hash,'' ORDER BY row_hash),'')) AS fingerprint FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM ${name} t${filter}) snapshot`);
  tables.push({name,count:r.rows[0].n});fingerprints.push({name,digest:r.rows[0].fingerprint});
 }
 const assets=await pool.query(`SELECT object_key FROM sj_assets WHERE source_type<>'template' UNION SELECT object_key FROM sj_product_images UNION SELECT output->>'key' FROM sj_generation_jobs WHERE output->>'key' IS NOT NULL`);
 const exports=await pool.query('SELECT object_key FROM sj_project_exports WHERE object_key IS NOT NULL');
 const objects=[...assets.rows.map(r=>({bucket:'shangjing-assets',key:r.object_key})),...exports.rows.map(r=>({bucket:'shangjing-exports',key:r.object_key}))].sort((a,b)=>(a.bucket+'/'+a.key).localeCompare(b.bucket+'/'+b.key));
 for(const o of objects){
  const allowed=new RegExp(o.bucket==='shangjing-assets'?'^(generation/[0-9a-f-]{36}/|products/[0-9a-f-]{36}/|screenshots/[0-9a-f-]{36}[.])':'^exports/[0-9a-f-]{36}/[0-9a-f-]{36}/');
  if(!allowed.test(o.key)||o.key.includes('..'))throw new AppError('CLEANUP_OWNERSHIP','发现无法确认归属的旧文件，已停止清理。',409);
 }

 const snapshot={tables,objects,fingerprints};return {...snapshot,digest:digest(snapshot)};
}
export async function applyLegacyCleanup(pool,plan){
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query(`LOCK TABLE ${[...TABLES,'sj_assets'].join(',')} IN ACCESS EXCLUSIVE MODE`);
  const actual=await previewLegacyCleanup(c);
  if(actual.digest!==plan.digest)throw new AppError('CLEANUP_CHANGED','旧数据已经变化，请重新生成清理预览。',409);
  await c.query(`TRUNCATE ${TABLES.join(',')}`);
  await c.query(`DELETE FROM sj_assets WHERE source_type<>'template'`);
  const removed=actual.tables.reduce((n,t)=>n+t.count,0);
  await c.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,'local','legacy.cleanup',$2)`,[randomUUID(),{removed,tables:actual.tables,planDigest:plan.digest}]);
  await c.query('COMMIT');return {removed,objects:actual.objects};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
