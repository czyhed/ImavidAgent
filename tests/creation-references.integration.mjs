import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationProjects, MAX_REFERENCE_IMAGES } from '../server/creation-projects.mjs';
import { CreationMedia } from '../server/creation-media.mjs';
import { routes } from '../server/routes/creation-assets.mjs';
import { generationBoundary } from './creation-projects-fixture.mjs';
import { fixturePng } from './creation-app-fixture.mjs';
let db,store;
test.before(async()=>{db=await startTestPostgres();store=new CreationStore(db.pool);});
test.after(async()=>{await db?.stop();});

const node=(id,kind,extra={})=>({id,kind,title:id,prompt:'',params:{},subject:'concept',position:{x:0,y:0},sourceAssetId:null,sourceRunId:null,...extra});
const edge=(source,target,targetHandle,sourceHandle='image')=>({id:`${source}-${target}-${targetHandle}`,source,target,sourceHandle,targetHandle});
const asset=(workspace,body)=>store.create(workspace,'asset',{name:'x.png',mime:'image/png',role:'creative',data:Buffer.from(body.tag||'asset').toString('base64'),objectKey:crypto.randomUUID(),...body});
async function begin(svc,workspace,patch){
 const {project}=await svc.create(workspace,{});
 return (await svc.update(workspace,project.id,{revision:project.revision,...patch})).project;
}
async function runNodes(svc,workspace,projectId,taskIds,extra={}){
 const p=await svc.preview(workspace,projectId,{taskIds,...extra});
 await svc.start(workspace,projectId,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
 return svc.detail(workspace,projectId);
}

test('two generated sources plus an image input need individual pins, then send three images with the primary first',async()=>{
 const b=await generationBoundary(store),workspace='refs-multi';
 try {
  const svc=new CreationProjects(store,b);
  const inputAsset=await asset(workspace,{tag:'input-image'});
  let project=await begin(svc,workspace,{tasks:[
   node('a','generate',{prompt:'背景A'}),node('b','generate',{prompt:'背景B'}),node('img','image',{sourceAssetId:inputAsset.id}),node('t','generate',{prompt:'合并三图'}),
  ],edges:[edge('a','t','ref'),edge('b','t','ref'),edge('img','t','ref')]});
  // 未固定：先生成两个上游，目标节点等待选择版本。
  let p=await svc.preview(workspace,project.id,{taskIds:['t']});
  assert.deepEqual(p.scope.map(s=>[s.taskId,s.action]).sort(),[['a','generate'],['b','generate'],['t','wait-input']]);
  let detail=await runNodes(svc,workspace,project.id,['a','b']);
  const runA=detail.runs.find(r=>r.taskId==='a'),runB=detail.runs.find(r=>r.taskId==='b');
  assert.equal(runA.status,'succeeded');assert.equal(runB.status,'succeeded');
  // 只固定一个来源仍然等待。
  project=(await svc.update(workspace,project.id,{revision:detail.project.revision,tasks:detail.project.tasks.map(t=>t.id==='t'?{...t,sourceRunId:runA.id}:t)})).project;
  assert.equal((await svc.preview(workspace,project.id,{taskIds:['t']})).scope[0].action,'wait-input');
  project=(await svc.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id==='t'?{...t,sourceRunIds:[runB.id]}:t)})).project;
  p=await svc.preview(workspace,project.id,{taskIds:['t']});
  assert.equal(p.scope[0].action,'generate');assert.equal(p.scope[0].resolved.images.length,3);assert.equal(p.scope[0].resolved.sourceAssetId,runA.output.assetId);
  const before=b.requests.filter(r=>r.url==='/generate').length;
  detail=await runNodes(svc,workspace,project.id,['t']);
  const sent=b.requests.filter(r=>r.url==='/generate').slice(before);assert.equal(sent.length,1);
  const body=sent[0].body,decode=image=>Buffer.from(image.bytes.data).toString();
  assert.equal(decode(body.sourceImage),'fixture-image');
  assert.equal(body.sourceImages.length,3);assert.equal(decode(body.sourceImages[0]),'fixture-image');assert.equal(decode(body.sourceImages[2]),'input-image');
  assert.equal(body.mask,undefined);
  const frozen=detail.runs.find(r=>r.taskId==='t').input;
  assert.deepEqual(frozen.images.map(i=>i.assetId),[runA.output.assetId,runB.output.assetId,inputAsset.id]);
 }finally{await b.stop();}
});

test('graph rejects a ninth reference image and preview blocks a primary that would exceed eight',async()=>{
 const svc=new CreationProjects(store,{hub:{resolve:async()=>({channelId:'test',modelId:'image-test'})}}),workspace='refs-limit';
 const images=await Promise.all(Array.from({length:MAX_REFERENCE_IMAGES+1},(_,i)=>asset(workspace,{tag:`i${i}`})));
 const sources=images.map((a,i)=>node(`s${i}`,'image',{sourceAssetId:a.id}));
 const {project}=await svc.create(workspace,{});
 const eight=sources.slice(0,8);
 const ok=await svc.update(workspace,project.id,{revision:project.revision,tasks:[...eight,node('t','generate',{prompt:'八张'})],edges:eight.map(s=>edge(s.id,'t','ref'))});
 await assert.rejects(svc.update(workspace,project.id,{revision:ok.project.revision,tasks:[...sources,node('t','generate',{prompt:'九张'})],edges:sources.map(s=>edge(s.id,'t','ref'))}),{code:'TOO_MANY_REFERENCES'});
 await assert.rejects(svc.update(workspace,project.id,{revision:ok.project.revision,tasks:[...sources,node('t','edit',{prompt:'九张'})],edges:sources.map(s=>edge(s.id,'t','image'))}),{code:'TOO_MANY_REFERENCES'});
 // 固定主图素材与八条连线合计九张时，预览阻塞而不是静默截断。
 const extra=await asset(workspace,{tag:'extra'});
 const blocked=await svc.update(workspace,project.id,{revision:ok.project.revision,tasks:[...eight,node('t','generate',{prompt:'八张加主图',sourceAssetId:extra.id})],edges:eight.map(s=>edge(s.id,'t','ref'))});
 const preview=await svc.preview(workspace,blocked.project.id,{taskIds:['t']});
 assert.equal(preview.scope.at(-1).action,'blocked');assert.match(preview.scope.at(-1).reason,/最多连接 8 张/);assert.equal(preview.canStart,false);
});

test('edit node with a mask sends it, a changed base image blocks the preview, and non-edit nodes cannot hold a mask',async()=>{
 const b=await generationBoundary(store),workspace='refs-mask';
 try {
  const svc=new CreationProjects(store,b);
  const base=await asset(workspace,{tag:'base-image'}),other=await asset(workspace,{tag:'other-image'});
  const mask=await asset(workspace,{role:'mask',tag:'mask-image',baseAssetId:base.id});
  let project=await begin(svc,workspace,{tasks:[node('img','image',{sourceAssetId:base.id}),node('e','edit',{prompt:'只改左上角',maskAssetId:mask.id})],edges:[edge('img','e','image')]});
  const detail=await runNodes(svc,workspace,project.id,['e']);
  const run=detail.runs.find(r=>r.taskId==='e');assert.equal(run.status,'succeeded');assert.equal(run.input.maskAssetId,mask.id);
  const sent=b.requests.find(r=>r.url==='/generate').body;
  assert.equal(Buffer.from(sent.mask.bytes.data).toString(),'mask-image');assert.equal(Buffer.from(sent.sourceImage.bytes.data).toString(),'base-image');assert.equal(sent.sourceImages,undefined);
  // 更换原图：蒙版不再对应。
  project=(await svc.update(workspace,project.id,{revision:detail.project.revision,tasks:detail.project.tasks.map(t=>t.id==='img'?{...t,sourceAssetId:other.id}:t)})).project;
  const p=await svc.preview(workspace,project.id,{taskIds:['e']});
  assert.equal(p.scope[0].action,'blocked');assert.match(p.scope[0].reason,/蒙版不再对应/);assert.equal(p.canStart,false);
  // 蒙版只允许 edit 节点，且必须是 role=mask 的 PNG。
  await assert.rejects(svc.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id==='img'?{...t,maskAssetId:mask.id}:t)}),{code:'MASK_INVALID'});
  await assert.rejects(svc.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id==='e'?{...t,maskAssetId:base.id}:t)}),{code:'MASK_INVALID'});
 }finally{await b.stop();}
});

test('sourceRunIds are validated: array, no duplicates, successful runs of connected sources only',async()=>{
 const b=await generationBoundary(store),workspace='refs-pins';
 try {
  const svc=new CreationProjects(store,b);
  const project=await begin(svc,workspace,{tasks:[node('a','generate',{prompt:'A'}),node('b','generate',{prompt:'B'}),node('c','generate',{prompt:'C'}),node('t','generate',{prompt:'T'})],edges:[edge('a','t','ref'),edge('b','t','ref')]});
  const detail=await runNodes(svc,workspace,project.id,['a','b','c']);
  const [ra,rb,rc]=['a','b','c'].map(id=>detail.runs.find(r=>r.taskId===id));
  const set=sourceRunIds=>svc.update(workspace,project.id,{revision:detail.project.revision,tasks:detail.project.tasks.map(t=>t.id==='t'?{...t,sourceRunId:ra.id,sourceRunIds}:t)});
  await assert.rejects(set('nope'),{code:'SOURCE_RUN_INVALID'});
  await assert.rejects(set([ra.id]),{code:'SOURCE_RUN_INVALID'});
  await assert.rejects(set([rc.id]),{code:'SOURCE_RUN_INVALID'});
  await assert.rejects(set([rb.id,rb.id]),{code:'SOURCE_RUN_INVALID'});
  assert.deepEqual((await set([rb.id])).project.tasks.find(t=>t.id==='t').sourceRunIds,[rb.id]);
 }finally{await b.stop();}
});

test('mask uploads need a base image in the workspace and the default asset list hides masks',async()=>{
 const workspace='refs-routes',base=await asset(workspace,{tag:'route-base'});
 const media=new CreationMedia(store,{putObject:async()=>{},listObjects:()=>[],removeObject:async()=>{}});
 const ctx={auth:{},user:{id:'u',workspaceId:workspace,role:'operator'},creationMedia:media,creationLifecycle:{store}};
 const call=async(method,path,query,body)=>{
  const route=routes().find(r=>r.method===method&&r.pattern.test(path));
  const url=new URL('http://local'+path+(query?'?'+new URLSearchParams(query):''));let out;
  await route.handler({ctx,url,body,res:{},reply:(_res,status,payload)=>{out={status,payload};}});return out;
 };
 const png=fixturePng();
 await assert.rejects(call('POST','/api/creation/assets/upload',{role:'mask',mime:'image/png',name:'mask.png'},png),{code:'INVALID_MASK_BASE'});
 await assert.rejects(call('POST','/api/creation/assets/upload',{role:'mask',mime:'image/png',name:'mask.png',baseAssetId:crypto.randomUUID()},png),{code:'INVALID_MASK_BASE'});
 const uploaded=await call('POST','/api/creation/assets/upload',{role:'mask',mime:'image/png',name:'mask.png',baseAssetId:base.id},png);
 assert.equal(uploaded.status,201);assert.equal(uploaded.payload.asset.role,'mask');assert.equal(uploaded.payload.asset.baseAssetId,base.id);
 const list=(await call('GET','/api/creation/assets')).payload.items;
 assert.ok(list.some(a=>a.id===base.id));assert.equal(list.some(a=>a.role==='mask'),false);
 const masks=(await call('GET','/api/creation/assets',{role:'mask'})).payload.items;assert.equal(masks.length,1);
});
