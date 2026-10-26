import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/http.mjs';
import { startTestPostgres } from './support/postgres.mjs';
import {AuthStore,AuthService} from '../server/auth.mjs';
import { CreationStore } from '../server/creation-store.mjs';
let db,server,origin;
test.before(async()=>{
 db=await startTestPostgres();const store=new CreationStore(db.pool);
 await store.create('local','product',{name:'实物'});
 server=createServer({creationStore:store,root:new URL('../',import.meta.url)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{await new Promise(resolve=>server?.close(resolve));await db?.stop();});
test('authenticated workspace can read actual creation counts over HTTP',async()=>{
 const response=await fetch(origin+'/api/creation/overview');const result=await response.json();
 assert.equal(response.status,200);assert.equal(result.metrics.products,1);
});
test('creation application retires all legacy quotation and balance endpoints',async()=>{
 for(const path of ['/api/billing/quote','/api/billing','/api/projects','/api/jobs','/api/models']){
  const response=await fetch(origin+path);
  assert.equal(response.status,410,path);
  assert.equal((await response.json()).error.code,'LEGACY_RETIRED');
 }
});
test('media policy permits same-origin video previews',async()=>{
 const response=await fetch(origin+'/api/session');
 assert.match(response.headers.get('content-security-policy'),/media-src 'self' blob:/);
});

test('account mode scopes overview by authenticated workspace and hides costs from viewers',async()=>{
 const auth=new AuthService(new AuthStore(db.pool));
 const admin=await auth.setupAdmin({email:'creation-admin@example.test',password:'CreationTest12345',workspaceName:'Test'},'127.0.0.1');
 const user=await auth.createUser(admin.user,{email:'creation-viewer@example.test',password:'CreationViewer123',role:'viewer'});
 await db.pool.query('UPDATE sj_users SET must_change_password=false WHERE id=$1',[user.id]);
 const store=new CreationStore(db.pool);
 await store.create(admin.user.workspaceId,'product',{name:'当前账户商品'});
 await db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES(gen_random_uuid(),$1,'model.complete',$2)`,[admin.user.workspaceId,{usage:{costMicros:985,currency:'USD'}}]);
 const protectedServer=createServer({auth,creationStore:store,root:new URL('../',import.meta.url)});
 await new Promise(r=>protectedServer.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+protectedServer.address().port;
 try{
  assert.equal((await fetch(base+'/api/creation/overview')).status,401);
  const login=await auth.login('creation-viewer@example.test','CreationViewer123');
  const response=await fetch(base+'/api/creation/overview',{headers:{Cookie:'sj_session='+login.token}});
  const result=await response.json();assert.equal(response.status,200);
  assert.equal(result.metrics.products,1);assert.equal(result.costs,null);assert.deepEqual(result.modelUsage,[]);
 }finally{await new Promise(r=>protectedServer.close(r));}
});

test('active creation application does not expose the retired prototype entry',async()=>{
 const response=await fetch(origin+'/prototype/prototype.html');
 assert.equal(response.status,410);
});
