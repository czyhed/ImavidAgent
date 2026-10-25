import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
let db, store;
test.before(async () => { db = await startTestPostgres(); store = new CreationStore(db.pool); });
test.after(async () => { await db?.stop(); });
test('record identity cannot be forged through JSON body', async () => {
 const product = await store.create('shop-a','product',{name:'茶杯',id:'forged',workspaceId:'shop-b',kind:'project',revision:99,trashedAt:'2000-01-01'});
 assert.notEqual(product.id,'forged'); assert.equal(product.workspaceId,'shop-a'); assert.equal(product.kind,'product'); assert.equal(product.revision,1); assert.equal(product.trashedAt,null);
 const reopened = await new CreationStore(db.pool).get('shop-a',product.id);
 assert.equal(reopened.name,'茶杯'); assert.equal(await store.get('shop-b',product.id),undefined);
});

import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from 'minio';
import { CreationMedia } from '../server/creation-media.mjs';
import { CreationProducts } from '../server/creation-products.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';
import { deflateSync, crc32 } from 'node:zlib';
function png() {
 const chunk=(type,data)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(64*(64*3+1)))),chunk('IEND',Buffer.alloc(0))]);
}
let storage, media, objects=new Map(), storageFail=false;
test.before(async()=>{
 storage=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'), key=decodeURIComponent(url.pathname).slice('/shangjing-assets/'.length);
  if(storageFail){res.writeHead(403);res.end('<Error><Code>AccessDenied</Code></Error>');return;}
  if(url.searchParams.has('versions')){res.setHeader('Content-Type','application/xml');res.end('<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'+[...objects.keys()].filter(k=>k.startsWith(url.searchParams.get('prefix')||'')).map(k=>`<Version><Key>${k}</Key><VersionId>one</VersionId><IsLatest>true</IsLatest><LastModified>2026-10-22T00:00:00.000Z</LastModified><ETag>etag</ETag><Size>99</Size></Version>`).join('')+'<IsTruncated>false</IsTruncated></ListVersionsResult>');return;}
  if(req.method==='PUT'){const chunks=[];for await(const c of req)chunks.push(c);objects.set(key,Buffer.concat(chunks));res.setHeader('ETag','"d41d8cd98f00b204e9800998ecf8427e"');res.end();return;}
  if(req.method==='DELETE'){objects.delete(key);res.writeHead(204);res.end();return;}
  const data=objects.get(key);if(!data){res.writeHead(404);res.end('<Error><Code>NoSuchKey</Code></Error>');return;}
  res.setHeader('Content-Length',data.length);res.setHeader('Content-Type','image/png');res.end(req.method==='HEAD'?undefined:data);
 });storage.listen(0,'127.0.0.1');await once(storage,'listening');
 const client=new Client({endPoint:'127.0.0.1',port:storage.address().port,useSSL:false,region:'us-east-1',accessKey:'external-test-only',secretKey:'external-test-only'});
 media=new CreationMedia(store,client);
});
test.beforeEach(()=>{media.store=store;});
test.after(async()=>{storage?.closeAllConnections();await new Promise(resolve=>storage?.close(resolve));});
test('private media survives service recreation and never returns cross-workspace bytes',async()=>{
 media.store=store; const asset=await media.put('shop-a',{bytes:png(),mime:'image/png',name:'茶杯.png',role:'creative'});
 assert.equal(asset.role,'creative');assert.equal(asset.mime,'image/png');
 const reopened=new CreationMedia(new CreationStore(db.pool),media.client);
 assert.deepEqual((await reopened.read('shop-a',asset.id)).bytes,png());
 await assert.rejects(reopened.read('shop-b',asset.id),{code:'NOT_FOUND'});
});

test('first chat is persisted before failed recognition and is not resubmitted on replay',async()=>{
 const key=crypto.randomUUID();
 const hub={complete:async()=>{throw new Error('simulated external timeout');}};
 const products=new CreationProducts(store,{hub,media});
 const result=await products.chat('shop-a',null,{text:'这是一只茶杯',requestKey:key});
 assert.equal(result.product.messages[0]?.text,'这是一只茶杯');
 assert.equal(result.product.name,'未命名商品');
 assert.equal(result.product.messages[0].status,'failed');
 const reopened=new CreationProducts(new CreationStore(db.pool),{hub,media});
 const replay=await reopened.chat('shop-a',null,{text:'这是一只茶杯',requestKey:key});
 assert.equal(replay.product.id,result.product.id);
 assert.equal(replay.product.messages.length,1);
});


test('facts merge preserves manual and conflicting fields until explicit acceptance',async()=>{
 const provider=createServer(async(req,res)=>{for await(const chunk of req){} res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:JSON.stringify({reply:'已整理；材质需要确认。',name:'茶杯',facts:{材质:'陶瓷',容量:'300ml'}}),usage:{inputTokens:12,costMicros:null}}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 try{
  const hub={complete:async(payload)=>(await fetch(`http://127.0.0.1:${provider.address().port}`,{method:'POST',body:JSON.stringify(payload)})).json()};
  const products=new CreationProducts(store,{hub,media});
  let product=await products.create('shop-a',{name:'手工名称',facts:{材质:'玻璃'}});
  product=(await products.chat('shop-a',product.id,{text:'图上写容量300ml、材质陶瓷',requestKey:crypto.randomUUID(),revision:product.revision})).product;
  assert.equal(product.facts.材质,'玻璃');assert.equal(product.facts.容量,'300ml');assert.equal(product.name,'手工名称');
  const change=product.suggestions.find(s=>s.field==='材质');assert.equal(change.value,'陶瓷');
  product=await products.accept('shop-a',product.id,product.revision,change.id);
  assert.equal(product.facts.材质,'陶瓷');assert.ok(product.manualFields.includes('材质'));
  const reopened=await new CreationProducts(new CreationStore(db.pool),{hub,media}).get('shop-a',product.id);
  assert.equal(reopened.messages.at(-1).usage.costMicros,null);assert.equal(reopened.facts.容量,'300ml');
 }finally{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
});
test('evidence stays separate until promoted and trashed media remains readable for existing references',async()=>{
 const products=new CreationProducts(store,{hub:{complete:async()=>({text:'{"reply":"收到","facts":{}}'})},media});
 const evidence=await media.put('shop-a',{bytes:png(),name:'资料.png',role:'evidence'});
 let product=(await products.chat('shop-a',null,{evidenceIds:[evidence.id],requestKey:crypto.randomUUID()})).product;
 assert.deepEqual(product.creativeAssetIds,[]);assert.deepEqual(product.evidenceIds,[evidence.id]);
 product=await products.promote('shop-a',product.id,product.revision,evidence.id);
 assert.deepEqual(product.creativeAssetIds,[evidence.id]);
 await store.change('shop-a',evidence.id,null,a=>({...a,trashedAt:new Date().toISOString()}));
 assert.deepEqual((await media.source('shop-a',evidence.id)).bytes,png());
});

import { CreationLifecycle } from '../server/creation-lifecycle.mjs';
test('permanent deletion preview blocks references in trashed projects and frozen runs',async()=>{
 const lifecycle=new CreationLifecycle(store,{media});
 const product=await store.create('references','product',{name:'被引用茶杯'});
 let project=await store.create('references','project',{name:'回收站项目',productId:product.id,tasks:[]});
 project=await store.change('references',project.id,null,p=>({...p,trashedAt:new Date().toISOString()}));
 const preview=await lifecycle.preview('references',product.id);
 assert.equal(preview.blocked,true);assert.equal(preview.projects[0].id,project.id);assert.ok(preview.projects[0].trashedAt);
 const source=await media.put('references',{bytes:png(),name:'参考.png',role:'creative'});
 await db.pool.query('INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),'references',project.id,'task-1',crypto.randomUUID(),{sourceAssetId:source.id},'succeeded']);
 const assetPreview=await lifecycle.preview('references',source.id);
 assert.equal(assetPreview.blocked,true);assert.equal(assetPreview.projects[0].id,project.id);
});

test('running or unknown projects cannot enter trash; restored records do not run tasks',async()=>{
 const lifecycle=new CreationLifecycle(store,{media});
 const project=await store.create('lifecycle','project',{name:'运行中',tasks:[]});
 await db.pool.query('INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),'lifecycle',project.id,'task-1',crypto.randomUUID(),{},'unknown']);
 await assert.rejects(lifecycle.trash('lifecycle',project.id,1),{code:'PROJECT_RUNNING'});
 const product=await store.create('lifecycle','product',{name:'可恢复'});
 const trashed=await lifecycle.trash('lifecycle',product.id,1);assert.ok(trashed.trashedAt);
 assert.equal((await lifecycle.list('lifecycle')).some(x=>x.id===product.id),true);
 const restored=await lifecycle.restore('lifecycle',product.id,trashed.revision);assert.equal(restored.trashedAt,null);
});
test('storage purge failure keeps tombstone, retry removes owned project outputs and preserves minimal audit',async()=>{
 const lifecycle=new CreationLifecycle(store,{media});
 let project=await store.create('delete-retry','project',{name:'可删除',tasks:[]});
 const asset=await media.put('delete-retry',{bytes:png(),name:'生成.png',role:'result',projectId:project.id});
 await db.pool.query('INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,usage) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),'delete-retry',project.id,'task-1',crypto.randomUUID(),{},'succeeded',{costMicros:null,inputTokens:5}]);
 project=await lifecycle.trash('delete-retry',project.id,project.revision);
 let preview=await lifecycle.preview('delete-retry',project.id);assert.equal(preview.assets.length,1);
 storageFail=true;
 try {await assert.rejects(lifecycle.destroy('delete-retry',project.id,project.revision,preview.token),{code:'MEDIA_DELETE_FAILED'});}finally{storageFail=false;}
 const pending=await store.get('delete-retry',project.id);assert.equal(pending.deletionPending,true);
 await assert.rejects(lifecycle.restore('delete-retry',project.id,pending.revision),{code:'DELETION_PENDING'});
 preview=await lifecycle.preview('delete-retry',project.id);
 assert.equal((await lifecycle.destroy('delete-retry',project.id,pending.revision,preview.token)).deleted,true);
 assert.equal(await store.get('delete-retry',asset.id),undefined);assert.equal(await store.get('delete-retry',project.id),undefined);
 const audit=(await db.pool.query('SELECT action,detail FROM sj_creation_audit WHERE workspace_id=$1',['delete-retry'])).rows;
 assert.equal(audit.find(a=>a.action==='creation.retained-cost').detail.usage.costMicros,null);assert.equal(JSON.stringify(audit).includes('objectKey'),false);
});
test('image and video template edits do not alter applied copies and seed initialization does not overwrite edits',async()=>{
 const workspace='templates',lifecycle=new CreationLifecycle(store,{media}),projects=new CreationProjects(store);
 await lifecycle.initSeed(workspace);
 const seeds=await lifecycle.templates(workspace);assert.equal(seeds.length,10);
 const imageSeed=seeds.find(t=>t.mediaKind==='image'),videoSeed=seeds.find(t=>t.mediaKind==='video');
 assert.ok(imageSeed);assert.ok(videoSeed);
 // Use explicit distinct values so losing either task input or snapshot is observable.
 const cases=[
  {seed:imageSeed,kind:'image',name:'Original image template',prompt:'A teacup in morning light',params:{size:'1024x1024',quality:'high'}},
  {seed:videoSeed,kind:'video',name:'Original video template',prompt:'Slow orbit around the teacup',params:{duration:6,resolution:'768P',ratio:'16:9'}}
 ];
 const applied=[];
 for(const item of cases){
  const template=await lifecycle.patchTemplate(workspace,item.seed.id,item.seed.revision,item);
  const {project}=await projects.create(workspace,{name:item.name+' project',template:{id:template.id}});
  applied.push({...item,template,projectId:project.id});
 }
 const assertApplied=async service=>{
  for(const item of applied){
   const {project,runs}=await service.detail(workspace,item.projectId);
   assert.equal(project.tasks.length,1);assert.deepEqual(runs,[]);
   const task=project.tasks[0];
   assert.equal(task.kind,item.kind);assert.equal(task.prompt,item.prompt);assert.deepEqual(task.params,item.params);
   assert.deepEqual(task.templateSnapshot,{id:item.template.id,revision:item.template.revision,name:item.name,mediaKind:item.kind,prompt:item.prompt,params:item.params});
  }
 };
 await assertApplied(projects);
 const updated=[];
 for(const item of applied){
  updated.push(await lifecycle.patchTemplate(workspace,item.template.id,item.template.revision,{kind:item.kind,name:item.name+' edited',prompt:'Changed after project creation',params:item.kind==='image'?{size:'1536x1024',quality:'low'}:{duration:10,resolution:'1080P',ratio:'9:16'}}));
 }
 // Recreate services to read persisted projects, not the old objects returned at creation.
 let reopenedStore=new CreationStore(db.pool),reopened=new CreationLifecycle(reopenedStore,{media});
 await reopened.initSeed(workspace);
 const edited=await reopened.templates(workspace);
 for(const template of updated)assert.deepEqual(edited.find(t=>t.id===template.id),template);
 await assertApplied(new CreationProjects(reopenedStore));
 for(const template of updated)await reopened.deleteTemplate(workspace,template.id,template.revision);
 reopenedStore=new CreationStore(db.pool);reopened=new CreationLifecycle(reopenedStore,{media});
 await reopened.initSeed(workspace);
 const remaining=await reopened.templates(workspace);
 assert.equal(remaining.length,8);
 for(const item of applied)assert.equal(remaining.some(t=>t.id===item.template.id),false);
 await assertApplied(new CreationProjects(reopenedStore));
});

test('deleting a preset template stays deleted after restart and reinitialization',async()=>{
 const lifecycle=new CreationLifecycle(store,{media});await lifecycle.initSeed('seed-delete');
 const template=(await lifecycle.templates('seed-delete'))[0];await lifecycle.deleteTemplate('seed-delete',template.id,template.revision);
 const reopened=new CreationLifecycle(new CreationStore(db.pool),{media});await reopened.initSeed('seed-delete');
 assert.equal((await reopened.templates('seed-delete')).some(t=>t.id===template.id),false);
});

test('evidence uploads reject videos before storage and message keys cannot change payload',async()=>{
 const before=objects.size;
 const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(100)]);
 await assert.rejects(media.put('bad-media',{bytes:video,name:'资料.mp4',role:'evidence'}),{code:'INVALID_ATTACHMENT'});
 assert.equal(objects.size,before);
 const products=new CreationProducts(store,{hub:{complete:async()=>({text:'{"reply":"收到","facts":{}}'})},media}),key=crypto.randomUUID();
 const result=await products.chat('keys',null,{text:'原始资料',requestKey:key});
 await assert.rejects(products.chat('keys',result.product.id,{text:'换了资料',requestKey:key,revision:result.product.revision}),{code:'IDEMPOTENCY_CONFLICT'});
 const replay=await products.chat('keys',result.product.id,{text:'原始资料',requestKey:key,revision:1});assert.equal(replay.product.messages.length,2);
});

test('tombstones prevent new project and product references while storage cleanup is pending',async()=>{
 const asset=await media.put('delete-lock',{bytes:png(),name:'待删.png',role:'creative'});
 await store.change('delete-lock',asset.id,1,a=>({...a,trashedAt:new Date().toISOString(),deletionPending:true}));
 await assert.rejects(store.create('delete-lock','project',{name:'新项目',tasks:[{id:'image-1',sourceAssetId:asset.id}]}),{code:'DELETION_PENDING'});
 const product=await store.create('delete-lock','product',{name:'新商品'});
 await assert.rejects(store.change('delete-lock',product.id,1,p=>({...p,creativeAssetIds:[asset.id]})),{code:'DELETION_PENDING'});
});

test('expired interrupted recognition can be ended without resubmitting the model and new messages continue',async()=>{
 const products=new CreationProducts(store,{hub:{complete:async()=>({text:'{"reply":"继续整理","facts":{}}'})},media});
 let product=await products.create('interrupted',{name:'断线商品'});const messageId=crypto.randomUUID();
 product=await store.change('interrupted',product.id,product.revision,p=>({...p,messages:[{id:messageId,role:'user',text:'中断资料',status:'pending',evidenceIds:[],createdAt:'2026-01-01T00:00:00Z'}]}));
 product=await products.endRecognition('interrupted',product.id,product.revision,messageId);
 assert.equal(product.messages[0].status,'failed');
 const result=await products.chat('interrupted',product.id,{text:'补充资料',requestKey:crypto.randomUUID(),revision:product.revision});
 assert.equal(result.product.messages.length,3);
});

test('promoted evidence can replay its original message without another recognition',async()=>{
 const products=new CreationProducts(store,{hub:{complete:async()=>({text:'{"reply":"收到","facts":{}}'})},media});
 const evidence=await media.put('promoted-replay',{bytes:png(),name:'资料.png',role:'evidence'}),requestKey=crypto.randomUUID();
 let product=(await products.chat('promoted-replay',null,{evidenceIds:[evidence.id],requestKey})).product;
 product=await products.promote('promoted-replay',product.id,product.revision,evidence.id);
 const replay=await products.chat('promoted-replay',product.id,{evidenceIds:[evidence.id],requestKey,revision:1});
 assert.equal(replay.product.messages.length,2);assert.equal(replay.product.id,product.id);
});

test('deleting an unreferenced asset detaches product attachments so future chat still works',async()=>{
 const products=new CreationProducts(store,{hub:{complete:async()=>({text:'{"reply":"收到","facts":{}}'})},media}),lifecycle=new CreationLifecycle(store,{media});
 const evidence=await media.put('detach-asset',{bytes:png(),name:'资料.png',role:'evidence'});
 let product=(await products.chat('detach-asset',null,{evidenceIds:[evidence.id],requestKey:crypto.randomUUID()})).product;
 product=await products.promote('detach-asset',product.id,product.revision,evidence.id);
 const asset=await lifecycle.trash('detach-asset',evidence.id,(await store.get('detach-asset',evidence.id)).revision);
 const preview=await lifecycle.preview('detach-asset',asset.id);await lifecycle.destroy('detach-asset',asset.id,asset.revision,preview.token);
 product=await products.get('detach-asset',product.id);
 assert.deepEqual(product.evidenceIds,[]);assert.deepEqual(product.creativeAssetIds,[]);assert.deepEqual(product.messages[0].evidenceIds,[]);
 assert.equal((await products.chat('detach-asset',product.id,{text:'继续补充',requestKey:crypto.randomUUID(),revision:product.revision})).error,undefined);
});
