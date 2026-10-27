import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/http.mjs';
import { startTestPostgres } from './support/postgres.mjs';
import { AuthStore, AuthService } from '../server/auth.mjs';
import { CreationStore } from '../server/creation-store.mjs';

let db,store,auth,server,base,admin,viewer,adminCookie,viewerCookie;
const at=minute=>new Date(Date.UTC(2026,0,1,0,minute)).toISOString();
const get=async(path,cookie)=>{const r=await fetch(base+path,{headers:{Cookie:cookie}});return {status:r.status,body:await r.json()};};

test.before(async()=>{
 db=await startTestPostgres();store=new CreationStore(db.pool);auth=new AuthService(new AuthStore(db.pool));
 admin=await auth.setupAdmin({email:'usage-admin@example.test',password:'UsageAdmin12345',workspaceName:'Usage'},'127.0.0.1');
 const user=await auth.createUser(admin.user,{email:'usage-viewer@example.test',password:'UsageViewer123',role:'viewer'});
 await db.pool.query('UPDATE sj_users SET must_change_password=false WHERE id=$1',[user.id]);
 adminCookie='sj_session='+(await auth.login('usage-admin@example.test','UsageAdmin12345')).token;
 viewerCookie='sj_session='+(await auth.login('usage-viewer@example.test','UsageViewer123')).token;
 const w=admin.user.workspaceId,project=await store.create(w,'project',{name:'用量项目',tasks:[{id:'t1'}],edges:[]});
 // 奇数分钟是生成记录，偶数分钟是模型调用 / 已删除任务保留的费用；共 7 条，时间交错，另有一条其他工作区不应出现。
 const run=(minute,status,usage)=>db.pool.query(`INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,usage,created_at) VALUES(gen_random_uuid(),$1,$2,'t1',gen_random_uuid(),$3,$4,$5,$6)`,[w,project.id,{task:{title:'主图任务'}},status,usage,at(minute)]);
 const audit=(minute,action,detail,workspace=w)=>db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail,created_at) VALUES(gen_random_uuid(),$1,$2,$3,$4)`,[workspace,action,detail,at(minute)]);
 await run(1,'succeeded',{costMicros:1000,currency:'CNY'});
 await audit(2,'model.complete',{stage:'product',modelId:'text-a',usage:{costMicros:200,currency:'USD'}});
 await run(3,'failed',null);
 await audit(4,'creation.retained-cost',{runId:'gone',usage:{costMicros:300,currency:'CNY'}});
 await run(5,'succeeded',{costMicros:500,currency:'CNY'});
 await audit(6,'model.complete',{stage:'planning',modelId:'text-b',usage:{total_tokens:42}});
 await run(7,'unknown',{images:1});
 await audit(8,'model.complete',{stage:'product',modelId:'other',usage:{costMicros:1}},'other-workspace');
 await audit(9,'creation.permanent_delete',{recordId:'x'});
 server=createServer({auth,creationStore:store,root:new URL('../',import.meta.url)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{await new Promise(r=>server?.close(r));await db?.stop();});

test('usage merges runs and audit rows in one created_at DESC order with total and nextOffset',async()=>{
 const all=await get('/api/creation/usage?limit=100',adminCookie);
 assert.equal(all.status,200);assert.equal(all.body.total,7,'other workspace and non-usage audit actions are excluded');
 assert.equal(all.body.nextOffset,null);
 assert.deepEqual(all.body.items.map(r=>r.createdAt),[7,6,5,4,3,2,1].map(at),'interleaved sources, newest first');
 assert.deepEqual(all.body.items.map(r=>r.source),['run','model','run','model','run','model','run']);
 const first=all.body.items[0];
 assert.equal(first.projectName,'用量项目');assert.equal(first.taskId,'t1');assert.equal(first.taskTitle,'主图任务');assert.equal(first.status,'unknown');assert.equal(first.costMicros,null);
 const model=all.body.items.find(r=>r.modelId==='text-a');
 assert.equal(model.stage,'product');assert.equal(model.status,'recorded');assert.equal(model.taskId,'text-a');assert.equal(model.costMicros,200);assert.equal(model.currency,'USD');
 assert.equal(all.body.items.find(r=>r.stage==='deleted-generation').costMicros,300);
 assert.equal(all.body.items.find(r=>r.modelId==='text-b').usage.total_tokens,42);
 const ok=all.body.items.find(r=>r.status==='succeeded');assert.deepEqual(Object.keys(ok).sort(),Object.keys(first).sort());
});

test('usage pagination walks the merged list without gaps or repeats and defaults to 20',async()=>{
 const out=[];let offset=0,pages=0;
 for(;;){
  const {status,body}=await get('/api/creation/usage?limit=3&offset='+offset,adminCookie);
  assert.equal(status,200);assert.equal(body.total,7);pages++;out.push(...body.items);
  if(body.nextOffset===null)break;assert.equal(body.nextOffset,offset+body.items.length);offset=body.nextOffset;
 }
 assert.equal(pages,3);assert.deepEqual(out.map(r=>r.createdAt),[7,6,5,4,3,2,1].map(at));
 assert.equal(new Set(out.map(r=>r.id)).size,7);
 const middle=await get('/api/creation/usage?limit=2&offset=2',adminCookie);
 assert.deepEqual(middle.body.items.map(r=>r.createdAt),[5,4].map(at));assert.equal(middle.body.nextOffset,4);
 const beyond=await get('/api/creation/usage?limit=5&offset=50',adminCookie);
 assert.equal(beyond.body.items.length,0);assert.equal(beyond.body.nextOffset,null);assert.equal(beyond.body.total,7);
 const dflt=await get('/api/creation/usage',adminCookie);
 assert.equal(dflt.body.items.length,7);assert.equal(dflt.body.nextOffset,null);
});

test('usage rejects out-of-range limit and offset with 400',async()=>{
 for(const q of ['limit=0','limit=101','limit=x','limit=1.5','limit=5&offset=-1','limit=5&offset=y']){
  const r=await get('/api/creation/usage?'+q,adminCookie);assert.equal(r.status,400,q);assert.equal(r.body.error.code,'INVALID_PAGINATION');
 }
 assert.equal((await get('/api/creation/usage?limit=100',adminCookie)).status,200);
 assert.equal((await get('/api/creation/usage?limit=1',adminCookie)).status,200);
});

test('usage requires a session and hides usage, costMicros and currency from viewers',async()=>{
 assert.equal((await get('/api/creation/usage','')).status,401);
 const seen=await get('/api/creation/usage?limit=100',viewerCookie);
 assert.equal(seen.status,200);assert.equal(seen.body.total,7);
 assert.deepEqual(seen.body.items.map(r=>r.createdAt),[7,6,5,4,3,2,1].map(at),'viewer still gets every row in order');
 for(const row of seen.body.items){for(const field of ['usage','costMicros','currency'])assert.equal(field in row,false,field);assert.ok(row.status&&row.createdAt);}
 assert.equal(seen.body.items[0].projectName,'用量项目');
});
