import test from 'node:test';
import assert from 'node:assert/strict';
import {startCreationApp} from './creation-app-fixture.mjs';

let app;
test.before(async()=>{app=await startCreationApp({autoTick:false});});
test.after(async()=>{await app?.stop();});

test('project and product lists return summaries; details keep full bodies; API responses carry Server-Timing',async()=>{
 const {product}=await app.api('/api/creation/products',{name:'摘要茶杯',facts:{价格:'39',材质:'陶瓷'}});
 const {project}=await app.api('/api/creation/projects',{name:'摘要项目',productId:product.id,graphVersion:4});
 const list=await fetch(app.origin+'/api/creation/projects',{headers:{'X-CSRF-Token':app.csrf}});
 assert.match(list.headers.get('server-timing')||'',/^app;dur=\d/);
 assert.equal(list.headers.get('cache-control'),'no-store');
 const {projects}=await list.json();
 const summary=projects.find(p=>p.id===project.id);
 assert.ok(summary);
 assert.equal(summary.name,'摘要项目');
 assert.equal(summary.productId,product.id);
 assert.equal(typeof summary.taskCount,'number');
 assert.ok(summary.workflowCount>=1);
 assert.ok(summary.updatedAt&&summary.revision);
 for(const heavy of ['tasks','edges','workflows','storyboard'])assert.equal(heavy in summary,false,heavy+' must not be in the list');
 const {items}=await app.api('/api/creation/products');
 const item=items.find(p=>p.id===product.id);
 assert.equal(item.name,'摘要茶杯');
 assert.equal(typeof item.factCount,'number');
 assert.equal('facts' in item,false);
 assert.equal('messages' in item,false);
 const detail=await app.api('/api/creation/products/'+product.id);
 assert.equal(detail.product.id,product.id);
});

test('unhashed or traversal asset names are not served and stay no-store',async()=>{
 for(const path of ['/assets/app.js','/assets/../package.json','/assets/%2e%2e/package.json','/assets/x-12345678.js.map','/assets/a/b-12345678.js']){
  const response=await fetch(app.origin+path);
  assert.notEqual(response.status,200,path);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }
});
