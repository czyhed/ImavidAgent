import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationOverview } from '../server/creation-overview.mjs';
let db,store,overview;
test.before(async()=>{db=await startTestPostgres();store=new CreationStore(db.pool);overview=new CreationOverview(store);});
test.after(async()=>{await db?.stop();});
test('workspace overview counts persisted products and excludes other workspaces',async()=>{
 await store.create('overview-a','product',{name:'保温杯',facts:{material:'钢'}});
 await store.create('overview-b','product',{name:'另一工作区'});
 const result=await overview.get('overview-a');
 assert.equal(result.metrics.products,1);
});
test('workspace overview reports task outcomes, recent projects and actual costs with unknown preserved',async()=>{
 const project=await store.create('overview-runs','project',{name:'新品主图',tasks:[{id:'a'}],edges:[]});
 await db.pool.query(`INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,usage) VALUES(gen_random_uuid(),$1,$2,'a',gen_random_uuid(),'{}','succeeded',$3),(gen_random_uuid(),$1,$2,'a',gen_random_uuid(),'{}','unknown',NULL)`,['overview-runs',project.id,{costMicros:1230000,currency:'CNY'}]);
 const result=await overview.get('overview-runs');
 assert.equal(result.metrics.projects,1);
 assert.equal(result.metrics.tasks,2);
 assert.equal(result.metrics.unknown,1);
 assert.equal(result.costs.unknown,1);
 assert.deepEqual(result.costs.totals,[{currency:'CNY',costMicros:1230000}]);
 assert.equal(result.projects[0].id,project.id);
 assert.equal(result.runs.find(r=>r.status==='unknown').costMicros,null);
});
test('chat and planning usage contributes to costs without exposing other workspaces',async()=>{
 await db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES(gen_random_uuid(),'overview-text','model.complete',$1),(gen_random_uuid(),'other','model.complete',$2)`,[{stage:'product',usage:{costMicros:456,currency:'USD'}},{usage:{costMicros:999,currency:'USD'}}]);
 const result=await overview.get('overview-text');
 assert.deepEqual(result.costs.totals,[{currency:'USD',costMicros:456}]);
 assert.equal(result.costs.unknown,0);
});


test('project permanent deletion preserves cost totals through minimal retained audit records',async()=>{
 await db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES(gen_random_uuid(),'overview-retained','creation.retained-cost',$1)`,[{runId:'removed',usage:{costMicros:790,currency:'CNY'}}]);
 const result=await overview.get('overview-retained');
 assert.deepEqual(result.costs.totals,[{currency:'CNY',costMicros:790}]);
});
