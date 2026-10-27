import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startCreationApp} from './creation-app-fixture.mjs';

let app;
test.before(async()=>{app=await startCreationApp({autoTick:false});});
test.after(async()=>{await app?.stop();});

const get=async path=>{const r=await fetch(app.origin+path,{headers:{'X-CSRF-Token':app.csrf}});return {status:r.status,body:await r.json()};};
async function upload(name,{role='creative',productId}={}){
 const r=await fetch(app.origin+'/api/creation/assets/upload?role='+role+'&name='+encodeURIComponent(name)+(productId?'&productId='+productId:''),{method:'POST',headers:{'X-CSRF-Token':app.csrf,'Content-Type':'image/png'},body:app.png});
 assert.equal(r.status,201);return (await r.json()).asset;
}
// 翻页走完全部，返回按页拼接的结果与每页形状。
async function walk(path,key,limit){
 const out=[],pages=[];let offset=0;
 for(let guard=0;guard<50;guard++){
  const {status,body}=await get(path+(path.includes('?')?'&':'?')+'limit='+limit+'&offset='+offset);
  assert.equal(status,200);pages.push(body);out.push(...body[key]);
  if(body.nextOffset===null)break;offset=body.nextOffset;
 }
 return {out,pages};
}

test('products: limit/offset/total/nextOffset, q search, ordering and compat without limit',async()=>{
 for(const n of ['分页杯A','分页杯B','分页杯C','分页杯D','分页杯E'])await app.api('/api/creation/products',{name:n});
 await app.api('/api/creation/products',{name:'无关水壶'});
 const all=await get('/api/creation/products');
 assert.equal(all.status,200);assert.equal(all.body.nextOffset,null);assert.equal(all.body.total,all.body.items.length);
 assert.equal(all.body.items[0].name,'无关水壶','updated_at DESC puts newest first');
 const {out,pages}=await walk('/api/creation/products','items',2);
 assert.deepEqual(out.map(p=>p.id),all.body.items.map(p=>p.id),'pages concatenate to the full ordered list');
 assert.equal(pages[0].items.length,2);assert.equal(pages[0].nextOffset,2);assert.equal(pages[0].total,all.body.total);
 assert.equal(pages.at(-1).nextOffset,null);
 const search=await get('/api/creation/products?q='+encodeURIComponent('分页杯')+'&limit=3');
 assert.equal(search.body.total,5);assert.equal(search.body.items.length,3);assert.equal(search.body.nextOffset,3);
 const lower=await get('/api/creation/products?q='+encodeURIComponent('分页杯a')+'&limit=10');
 assert.equal(lower.body.total,1,'search is case-insensitive');
 const wildcard=await get('/api/creation/products?q=%25&limit=10');
 assert.equal(wildcard.body.total,0,'% is literal, not a LIKE wildcard');
 const beyond=await get('/api/creation/products?limit=5&offset=1000');
 assert.equal(beyond.body.items.length,0);assert.equal(beyond.body.nextOffset,null);
});

test('limit/offset validation returns 400',async()=>{
 for(const q of ['limit=0','limit=101','limit=abc','limit=-1','limit=1.5','limit=5&offset=-1','limit=5&offset=x','offset=5'])
  for(const path of ['/api/creation/products','/api/creation/projects','/api/creation/assets','/api/creation/templates','/api/creation/trash']) {
   const r=await get(path+'?'+q);assert.equal(r.status,400,path+'?'+q);assert.equal(r.body.error.code,'INVALID_PAGINATION');
  }
});

test('projects: pagination, name and product-name search, compat',async()=>{
 const {product}=await app.api('/api/creation/products',{name:'项目商品壶'});
 for(const n of ['项目一','项目二','项目三'])await app.api('/api/creation/projects',{name:n,productId:product.id,graphVersion:4});
 await app.api('/api/creation/projects',{name:'独立项目',graphVersion:4});
 const all=await get('/api/creation/projects');
 assert.equal(all.body.total,all.body.projects.length);assert.equal(all.body.nextOffset,null);
 const {out,pages}=await walk('/api/creation/projects','projects',2);
 assert.deepEqual(out.map(p=>p.id),all.body.projects.map(p=>p.id));
 assert.equal(pages[0].nextOffset,2);
 const byName=await get('/api/creation/projects?q='+encodeURIComponent('独立')+'&limit=20');
 assert.equal(byName.body.total,1);assert.equal(byName.body.projects[0].name,'独立项目');
 const byProduct=await get('/api/creation/projects?q='+encodeURIComponent('商品壶')+'&limit=2');
 assert.equal(byProduct.body.total,3);assert.equal(byProduct.body.projects.length,2);assert.equal(byProduct.body.nextOffset,2);
 for(const heavy of ['tasks','edges'])assert.equal(heavy in byProduct.body.projects[0],false);
});

test('assets: pagination, filters, ids batch lookup, compat',async()=>{
 const {product}=await app.api('/api/creation/products',{name:'素材商品'});
 const made=[];
 for(const n of ['素材甲','素材乙','素材丙','素材丁'])made.push(await upload(n,{productId:product.id}));
 const evidence=await upload('资料图',{role:'evidence'});
 const result=await upload('结果图',{role:'result'});
 const all=await get('/api/creation/assets');
 assert.equal(all.body.nextOffset,null);assert.equal(all.body.total,all.body.items.length);
 assert.equal(all.body.items.some(a=>a.id===evidence.id),false,'evidence hidden by default');
 const {out,pages}=await walk('/api/creation/assets','items',3);
 assert.deepEqual(out.map(a=>a.id),all.body.items.map(a=>a.id));assert.equal(pages[0].items.length,3);
 const byRole=await get('/api/creation/assets?role=evidence&limit=10');
 assert.deepEqual(byRole.body.items.map(a=>a.id),[evidence.id]);
 const byResult=await get('/api/creation/assets?role=result&type=image&limit=10');
 assert.equal(byResult.body.items.some(a=>a.id===result.id),true);
 assert.equal((await get('/api/creation/assets?type=video&limit=10')).body.total,0);
 const byQ=await get('/api/creation/assets?q='+encodeURIComponent('素材')+'&productId='+product.id+'&limit=3');
 assert.equal(byQ.body.total,4);assert.equal(byQ.body.items.length,3);assert.equal(byQ.body.nextOffset,3);
 const ids=await get('/api/creation/assets?ids='+[made[0].id,evidence.id,randomUUID(),'bad'].join(','));
 assert.deepEqual(ids.body.items.map(a=>a.id).sort(),[made[0].id,evidence.id].sort(),'ids bypasses role filter, drops unknown and malformed ids');
 // 移入回收站的素材不再被 ids 命中（等同已删除）。
 const trashed=await app.api('/api/creation/trash/'+made[1].id,{revision:made[1].revision});
 assert.ok(trashed.item);
 assert.equal((await get('/api/creation/assets?ids='+made[1].id)).body.items.length,0);
 assert.equal((await get('/api/creation/assets?ids=')).body.items.length,0);
});

test('templates: pagination and q',async()=>{
 const all=await get('/api/creation/templates');
 assert.ok(all.body.total>=10);assert.equal(all.body.items.length,all.body.total);assert.equal(all.body.nextOffset,null);
 const {out,pages}=await walk('/api/creation/templates','items',4);
 assert.deepEqual(out.map(t=>t.id),all.body.items.map(t=>t.id));assert.equal(pages[0].items.length,4);assert.equal(pages[0].nextOffset,4);
 const name=all.body.items[0].name;
 const found=await get('/api/creation/templates?limit=50&q='+encodeURIComponent(name));
 assert.ok(found.body.total>=1);assert.ok(found.body.items.every(t=>t.name.toLowerCase().includes(name.toLowerCase())));
});

test('trash: pagination ordered by trashed_at DESC with q',async()=>{
 const before=(await get('/api/creation/trash')).body.total;
 const ids=[];
 for(const n of ['回收一','回收二','回收三']){const {product}=await app.api('/api/creation/products',{name:n});await app.api('/api/creation/trash/'+product.id,{revision:product.revision});ids.push(product.id);}
 const all=await get('/api/creation/trash');
 assert.equal(all.body.total,before+3);assert.equal(all.body.nextOffset,null);
 assert.deepEqual(all.body.items.slice(0,3).map(i=>i.id),ids.slice().reverse(),'most recently trashed first');
 const {out,pages}=await walk('/api/creation/trash','items',2);
 assert.deepEqual(out.map(i=>i.id),all.body.items.map(i=>i.id));assert.equal(pages[0].nextOffset,2);
 const found=await get('/api/creation/trash?q='+encodeURIComponent('回收')+'&limit=2');
 assert.equal(found.body.total,3);assert.equal(found.body.items.length,2);assert.equal(found.body.nextOffset,2);
});

test('picker filters: multi-role, product/project union, template type, trash kind',async()=>{
 const {product}=await app.api('/api/creation/products',{name:'筛选商品'});
 const {project}=await app.api('/api/creation/projects',{name:'筛选项目',graphVersion:4});
 const own=await upload('商品图',{productId:product.id});
 const r1=await fetch(app.origin+'/api/creation/assets/upload?role=creative&name=%E9%A1%B9%E7%9B%AE%E5%9B%BE&projectId='+project.id,{method:'POST',headers:{'X-CSRF-Token':app.csrf,'Content-Type':'image/png'},body:app.png});
 const inProject=(await r1.json()).asset;
 const other=await upload('无关图');
 const both=await get('/api/creation/assets?role=creative,result&limit=100');
 assert.ok([own,inProject,other].every(a=>both.body.items.some(x=>x.id===a.id)));
 const union=await get('/api/creation/assets?role=creative&productId='+product.id+'&projectId='+project.id+'&match=any&limit=50');
 assert.deepEqual(union.body.items.map(a=>a.id).sort(),[own.id,inProject.id].sort());
 const strict=await get('/api/creation/assets?role=creative&productId='+product.id+'&projectId='+project.id+'&limit=50');
 assert.equal(strict.body.total,0,'without match=any both owners must match');
 assert.equal((await get('/api/creation/assets?role=creative&type=audio&limit=5')).body.total,0);
 const videos=await get('/api/creation/templates?type=video&limit=50');
 assert.ok(videos.body.total>0&&videos.body.items.every(t=>t.mediaKind==='video'));
 const images=await get('/api/creation/templates?type=image&limit=50');
 assert.equal(videos.body.total+images.body.total,(await get('/api/creation/templates')).body.total);
 const {product:gone}=await app.api('/api/creation/products',{name:'回收筛选'});
 await app.api('/api/creation/trash/'+gone.id,{revision:gone.revision});
 const onlyProducts=await get('/api/creation/trash?kind=product&limit=50');
 assert.ok(onlyProducts.body.items.every(i=>i.kind==='product')&&onlyProducts.body.items.some(i=>i.id===gone.id));
 assert.equal((await get('/api/creation/trash?kind=project&limit=50')).body.items.some(i=>i.id===gone.id),false);
});
