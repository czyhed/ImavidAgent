import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';
let db,store,projects;
test.before(async()=>{ db=await startTestPostgres();store=new CreationStore(db.pool);projects=new CreationProjects(store); });
test.after(async()=>{await db?.stop();});

test('confirming AI video additions and updates preserves canonical parameters and rejects malformed shapes',async()=>{
 let plan,generated=0;
 const svc=new CreationProjects(store,{hub:{complete:async()=>({text:JSON.stringify(plan)}),submitGeneration:async()=>{generated++;}}});
 const workspace='video-plan-params';
 let {project}=await svc.create(workspace,{graphVersion:4,name:'视频安排'});
 async function propose(next){
  plan=next;
  const proposal=await svc.suggest(workspace,project.id,{revision:project.revision,requestKey:crypto.randomUUID(),instructions:'安排视频',allowVideo:true});
  project=proposal.project;
  return {revision:project.revision,suggestionId:proposal.suggestion.id};
 }
 let body=await propose({additions:[{kind:'video',title:'竖屏',prompt:'自然光',params:{duration:15,resolution:'1080x1920',aspectRatio:'9:16'}}],updates:[]});
 ({project}=await svc.applySuggestion(workspace,project.id,body));
 const id=project.tasks.find(t=>t.kind==='video').id;
 assert.deepEqual(project.tasks.find(t=>t.id===id).params,{duration:15,resolution:'1080P',ratio:'9:16'});
 body=await propose({additions:[],updates:[{id,changes:{params:{duration:10,resolution:'1920x1080'}}}]});
 ({project}=await svc.applySuggestion(workspace,project.id,body));
 assert.deepEqual(project.tasks.find(t=>t.id===id).params,{duration:10,resolution:'1080P',ratio:'16:9'});
 for(const invalid of [
  {additions:[{kind:'video',title:'非法',prompt:'test',params:[]}],updates:[]},
  {additions:[{kind:'video',title:'非法',prompt:'test',params:null}],updates:[]},
  {additions:[],updates:[{id,changes:{params:null}}]},
 ]){
  body=await propose(invalid);
  const original=structuredClone(project.tasks);
  await assert.rejects(svc.applySuggestion(workspace,project.id,body));
  project=(await svc.detail(workspace,project.id)).project;
  assert.deepEqual(project.tasks,original);
 }
 assert.equal(generated,0);assert.equal((await svc.detail(workspace,project.id)).runs.length,0);
});
test('creative workflows persist edits and isolate execution selection',async()=>{
 const {createWorkflow}=await import('../shared/creation-workflows.mjs');
 const svc=new CreationProjects(store,{hub:{resolve:async()=>({channelId:'test',modelId:'image-test'})}});
 let {project}=await svc.create('task-containers',{graphVersion:4,name:'任务画布'});
 assert.equal(project.workflows.length,1);assert.equal(project.tasks.length,4);
 const created=createWorkflow(project,{title:'独立任务',prompt:'自然光背景'},()=>crypto.randomUUID());
 ({project}=await svc.update('task-containers',project.id,{revision:project.revision,name:'改名后',workflows:[...project.workflows,created.workflow],tasks:[...project.tasks,...created.tasks],edges:[...project.edges,...created.edges],viewport:{x:10,y:-20,zoom:0.8}}));
 const loaded=(await new CreationProjects(store).detail('task-containers',project.id)).project;
 assert.equal(loaded.name,'改名后');assert.equal(loaded.workflows[1].title,'独立任务');assert.equal(loaded.viewport.zoom,0.8);
 const target=created.tasks.find(t=>t.kind==='generate');
 const preview=await svc.preview('task-containers',project.id,{taskIds:[target.id]});
 assert.ok(preview.scope.every(t=>created.tasks.some(n=>n.id===t.taskId)));
 await assert.rejects(svc.update('task-containers',project.id,{revision:project.revision,workflows:[created.workflow,created.workflow]}),{code:'WORKFLOW_INVALID'});
 await assert.rejects(svc.update('task-containers',project.id,{revision:project.revision,workflows:[created.workflow]}),{code:'WORKFLOW_INVALID'});
 assert.equal((await svc.detail('task-containers',project.id)).runs.length,0);
});
test('creating a product project immediately persists an image task with product facts',async()=>{
 const product=await store.create('canvas-test','product',{name:'青瓷杯',facts:{material:'陶瓷'},creativeAssetIds:[]});
 const created=await projects.create('canvas-test',{productId:product.id});
 assert.equal(created?.project?.tasks?.length,1);
 const loaded=await new CreationProjects(store).detail('canvas-test',created.project.id);
 assert.equal(loaded.project.tasks[0].kind,'image');
 assert.equal(loaded.project.tasks[0].productSnapshot.facts.material,'陶瓷');
 assert.equal(loaded.project.productId,product.id);
});
test('task edits and viewport survive reload while stale revisions and cycles are rejected',async()=>{
 const {project}=await projects.create('canvas-graph',{});
 const first=project.tasks[0];
 const tasks=[{...first,prompt:'背景海报',position:{x:-400,y:900}},{id:'detail',kind:'image',title:'细节',prompt:'细节',params:{},subject:'concept',position:{x:400,y:900}}];
 const changed=await projects.update('canvas-graph',project.id,{revision:1,tasks,edges:[{id:'edge',source:first.id,target:'detail'}],viewport:{x:300,y:-200,zoom:0.4}});
 assert.equal(changed?.project?.tasks[0].prompt,'背景海报');
 assert.equal((await new CreationProjects(store).detail('canvas-graph',project.id)).project.viewport.zoom,0.4);
 await assert.rejects(projects.update('canvas-graph',project.id,{revision:1,name:'覆盖'}),{code:'REVISION_CONFLICT'});
 await assert.rejects(projects.update('canvas-graph',project.id,{revision:2,edges:[...changed.project.edges,{id:'back',source:'detail',target:first.id}]}),{code:'GRAPH_CYCLE'});
});
test('range preview includes unfinished ancestors and pauses downstream without a chosen version',async()=>{
 const svc=new CreationProjects(store,{hub:{resolve:async()=>({channelId:'test',modelId:'image-test'})}});
 let {project}=await svc.create('canvas-range',{});
 const root={...project.tasks[0],prompt:'雨林背景'};
 ({project}=await svc.update('canvas-range',project.id,{revision:1,tasks:[root,{id:'child',kind:'video',title:'镜头',prompt:'慢速推进',subject:'concept',params:{},position:{x:600,y:0}}],edges:[{id:'link',source:root.id,target:'child'}]}));
 const range=await svc.preview('canvas-range',project.id,{taskIds:['child']});
 assert.equal(range?.scope?.length,2);
 assert.equal(range.scope[0].action,'generate');
 assert.equal(range.scope[1].action,'wait-input');
 assert.match(range.previewToken,/^[a-f0-9]{64}$/);
});
test('explicit start persists one request, freezes inputs, collects results and retains unknown cost',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');
 const boundary=await generationBoundary(store);
 try {
  const svc=new CreationProjects(store,boundary);let {project}=await svc.create('canvas-start',{});
  ({project}=await svc.update('canvas-start',project.id,{revision:1,tasks:[{...project.tasks[0],prompt:'森林背景'}]}));
  const preview=await svc.preview('canvas-start',project.id,{taskIds:[project.tasks[0].id]});
  const requestKey=crypto.randomUUID(),body={...preview.selection,revision:preview.revision,previewToken:preview.previewToken,requestKey};
  const started=await svc.start('canvas-start',project.id,body);
  assert.equal(started?.runs?.length,1);
  await Promise.all([svc.tick(),new CreationProjects(store,boundary).tick()]);
  const done=await svc.detail('canvas-start',project.id);
  assert.equal(done.runs[0].status,'succeeded');
  assert.equal(done.runs[0].input.task.prompt,'森林背景');
  assert.equal(done.cost.amount,null);
  assert.equal((await store.get('canvas-start',done.runs[0].output.assetId)).runId,done.runs[0].id);
  await svc.start('canvas-start',project.id,body);await svc.tick();
  assert.equal(boundary.requests.filter(r=>r.url==='/generate').length,1);
  await svc.update('canvas-start',project.id,{revision:done.project.revision,tasks:[{...done.project.tasks[0],prompt:'海洋背景'}]});
  assert.equal((await svc.detail('canvas-start',project.id)).runs[0].input.task.prompt,'森林背景');
  assert.equal((await svc.preview('canvas-start',project.id,{taskIds:[project.tasks[0].id]})).scope[0].action,'generate');
 }finally{await boundary.stop();}
});
test('AI planning saves a preview and usage, applies only on confirmation and never generates',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store);
 try {
  const svc=new CreationProjects(store,b);const {project}=await svc.create('canvas-plan',{});
  const requestKey=crypto.randomUUID();
  const proposal=await svc.suggest('canvas-plan',project.id,{revision:1,requestKey,instructions:'增加一张森林背景'});
  assert.equal(proposal?.suggestion?.status,'ready');
  assert.equal((await svc.detail('canvas-plan',project.id)).project.tasks.length,1);
  const again=await svc.suggest('canvas-plan',project.id,{revision:1,requestKey,instructions:'增加一张森林背景'});
  assert.equal(again.suggestion.id,proposal.suggestion.id);
  assert.equal(b.requests.filter(r=>r.url==='/plan').length,1);
  const confirmed=await svc.applySuggestion('canvas-plan',project.id,{revision:proposal.project.revision,suggestionId:proposal.suggestion.id});
  assert.equal(confirmed.project.tasks.length,2);
  assert.equal(confirmed.project.tasks[1].kind,'generate');
  assert.equal(b.requests.filter(r=>r.url==='/generate').length,0);
 }finally{await b.stop();}
});
test('unknown requests recover the original request after restart and cancel without resubmitting',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store,{status:'unknown'});
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create('canvas-unknown',{});
  ({project}=await svc.update('canvas-unknown',project.id,{revision:1,tasks:[{...project.tasks[0],prompt:'雨夜街道'}]}));
  const p=await svc.preview('canvas-unknown',project.id,{taskIds:[project.tasks[0].id]});
  await svc.start('canvas-unknown',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  const unknown=await svc.detail('canvas-unknown',project.id);assert.equal(unknown.runs[0].status,'unknown');
  const restarted=new CreationProjects(store,b);await restarted.recover('canvas-unknown',project.id,{runIds:[unknown.runs[0].id]});
  assert.equal(b.requests.filter(r=>r.url==='/generate').length,1);
  assert.equal(b.requests.filter(r=>r.url==='/generate/upstream-fixed').length,1);
  assert.equal(b.requests.find(r=>r.url==='/generate').body.requestKey,b.requests.find(r=>r.url==='/generate/upstream-fixed').body.requestKey);
  const cancelled=await restarted.cancel('canvas-unknown',project.id,{runIds:[unknown.runs[0].id]});
  assert.equal(cancelled?.runs?.[0]?.status,'cancelled');
 }finally{await b.stop();}
});
test('downstream pauses after upstream success, then uses a chosen immutable run and successful ancestors are reused',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store);
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create('canvas-downstream',{});const root=project.tasks[0];
  ({project}=await svc.update('canvas-downstream',project.id,{revision:1,tasks:[{...root,prompt:'山脉背景'},{id:'video',kind:'video',title:'推进镜头',prompt:'平缓推进',params:{duration:6},subject:'concept',position:{x:500,y:0}}],edges:[{id:'dep',source:root.id,target:'video'}]}));
  let p=await svc.preview('canvas-downstream',project.id,{taskIds:['video']});
  await svc.start('canvas-downstream',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  let detail=await svc.detail('canvas-downstream',project.id);assert.equal(detail.runs.length,1);assert.equal(detail.runs[0].taskId,root.id);
  await svc.tick();assert.equal((await svc.detail('canvas-downstream',project.id)).runs.length,1);
  await svc.update('canvas-downstream',project.id,{revision:detail.project.revision,tasks:detail.project.tasks.map(t=>t.id==='video'?{...t,sourceRunId:detail.runs[0].id}:t)});
  p=await svc.preview('canvas-downstream',project.id,{taskIds:['video']});assert.equal(p.scope[0].action,'reuse');
  await svc.start('canvas-downstream',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  detail=await svc.detail('canvas-downstream',project.id);assert.equal(detail.runs.length,2);assert.equal(detail.runs[1].input.sourceRunId,detail.runs[0].id);
  assert.equal(b.requests.filter(r=>r.url==='/generate').length,2);
  const source=b.requests.filter(r=>r.url==='/generate')[1].body.sourceImage;assert.equal(Buffer.from(source.bytes.data).toString(),'fixture-image');
 }finally{await b.stop();}
});
test('failed calls are never automatically retried, retries require explicit consent and create a new version',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store,{status:'failed'});
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create('canvas-fail',{});
  ({project}=await svc.update('canvas-fail',project.id,{revision:1,tasks:[{...project.tasks[0],prompt:'几何图案'}]}));
  let p=await svc.preview('canvas-fail',project.id,{taskIds:[project.tasks[0].id]});
  await svc.start('canvas-fail',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();await svc.tick();
  assert.equal(b.requests.filter(request=>request.url==='/generate').length,1,'ticking a failed run must not submit it again');
  p=await svc.preview('canvas-fail',project.id,{taskIds:[project.tasks[0].id]});assert.equal(p.scope[0].action,'retry-confirm');assert.equal(p.canStart,false);
  b.setStatus('succeeded');p=await svc.preview('canvas-fail',project.id,{taskIds:[project.tasks[0].id],retryTaskIds:[project.tasks[0].id]});
  await svc.start('canvas-fail',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  const done=await svc.detail('canvas-fail',project.id);assert.deepEqual(done.runs.map(r=>r.status),['failed','succeeded']);assert.notEqual(done.runs[0].requestKey,done.runs[1].requestKey);
 }finally{await b.stop();}
});
test('result ZIP is optional and product sync changes only never-started tasks',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store);
 try {
  const product=await store.create('canvas-export','product',{name:'马克杯',facts:{color:'白'},creativeAssetIds:[]});
  const svc=new CreationProjects(store,b);let {project}=await svc.create('canvas-export',{productId:product.id});
  ({project}=await svc.update('canvas-export',project.id,{revision:1,tasks:[{...project.tasks[0],subject:'concept',prompt:'白色背景'}]}));
  const p=await svc.preview('canvas-export',project.id,{taskIds:[project.tasks[0].id]});
  await svc.start('canvas-export',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  let detail=await svc.detail('canvas-export',project.id);
  const zip=await svc.export('canvas-export',project.id,{runIds:[detail.runs[0].id]});
  assert.equal(zip?.bytes?.readUInt32LE(0),0x04034b50);assert.match(zip.name,/\.zip$/);
  assert.ok(zip.bytes.includes(Buffer.from('fixture-image')));
  await store.change('canvas-export',product.id,1,p=>({...p,facts:{color:'绿'}}));
  ({project}=await svc.update('canvas-export',project.id,{revision:detail.project.revision,tasks:[...detail.project.tasks,{...detail.project.tasks[0],id:'new',position:{x:500,y:300}}]}));
  const synced=await svc.syncProduct('canvas-export',project.id,{revision:project.revision});
  assert.equal(synced.project.tasks[0].productSnapshot.facts.color,'白');
  assert.equal(synced.project.tasks[1].productSnapshot.facts.color,'绿');
 }finally{await b.stop();}
});
test('a pinned upstream version remains reusable even when the upstream task later changes',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store);
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create('canvas-pinned',{});const root=project.tasks[0];
  ({project}=await svc.update('canvas-pinned',project.id,{revision:1,tasks:[{...root,prompt:'旧版背景'}]}));
  const p=await svc.preview('canvas-pinned',project.id,{taskIds:[root.id]});await svc.start('canvas-pinned',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  const old=await svc.detail('canvas-pinned',project.id);
  await svc.update('canvas-pinned',project.id,{revision:old.project.revision,tasks:[{...old.project.tasks[0],prompt:'新版背景'},{...old.project.tasks[0],id:'dependent',title:'细节改图',prompt:'局部明亮',sourceRunId:old.runs[0].id}],edges:[{id:'fixed',source:root.id,target:'dependent'}]});
  const fixed=await svc.preview('canvas-pinned',project.id,{taskIds:['dependent']});
  assert.equal(fixed.scope[0].action,'reuse');assert.equal(fixed.scope[0].reuseRunId,old.runs[0].id);
 }finally{await b.stop();}
});

test('a successful upstream result survives media outage and recovers collection without resubmission',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store,{failMediaWrites:1});
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create('canvas-storage-recovery',{});
  ({project}=await svc.update('canvas-storage-recovery',project.id,{revision:1,tasks:[{...project.tasks[0],prompt:'恢复存储背景'}]}));
  const p=await svc.preview('canvas-storage-recovery',project.id,{taskIds:[project.tasks[0].id]});await svc.start('canvas-storage-recovery',project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});
  await svc.tick();const incomplete=await svc.detail('canvas-storage-recovery',project.id);assert.equal(incomplete.runs[0].status,'unknown');
  await new CreationProjects(store,b).recover('canvas-storage-recovery',project.id,{runIds:[incomplete.runs[0].id]});
  const done=await svc.detail('canvas-storage-recovery',project.id);assert.equal(done.runs[0].status,'succeeded');
  assert.equal(b.requests.filter(r=>r.url==='/generate').length,1);
  assert.equal(b.requests.filter(r=>r.url==='/generate/upstream-fixed').length,0);
  assert.equal(done.runs[0].output._pendingResult,undefined);
 }finally{await b.stop();}
});


test('execution freezes nonempty parameters, resolved model and product facts before dispatch',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store);
 const workspace='canvas-frozen-inputs';
 try {
  const product=await store.create(workspace,'product',{name:'Mug',facts:{color:'white'},creativeAssetIds:[]});
  const svc=new CreationProjects(store,b);let {project}=await svc.create(workspace,{productId:product.id});
  const taskId=project.tasks[0].id;
  ({project}=await svc.update(workspace,project.id,{revision:project.revision,tasks:[{...project.tasks[0],subject:'concept',prompt:'Studio background',params:{size:'1024x1024',quality:'high',style:{lighting:'soft'}}}]}));
  const p=await svc.preview(workspace,project.id,{taskIds:[taskId]});
  const started=await svc.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});
  assert.deepEqual(started.runs[0].input.params,{size:'1024x1024',quality:'high',style:{lighting:'soft'}});
  await store.change(workspace,product.id,product.revision,value=>({...value,facts:{color:'green'}}));
  const restarted=new CreationProjects(store,b);await restarted.tick();
  const done=await restarted.detail(workspace,project.id);
  const sent=b.requests.find(request=>request.url==='/generate').body;
  assert.equal(done.runs[0].status,'succeeded');
  assert.deepEqual(sent.params,{size:'1024x1024',quality:'high',style:{lighting:'soft'}});
  assert.equal(sent.model.channelId,'fixture');assert.equal(sent.model.modelId,'image-v1');
  assert.equal(sent.productSnapshot.facts.color,'white');
  assert.equal(sent.graphRevision,project.revision);
  await svc.update(workspace,project.id,{revision:done.project.revision,tasks:[{...done.project.tasks[0],params:{size:'512x512'},prompt:'Changed background'}]});
  const historical=(await restarted.detail(workspace,project.id)).runs[0];
  assert.deepEqual(historical.input.params,{size:'1024x1024',quality:'high',style:{lighting:'soft'}});
  assert.equal(historical.input.productSnapshot.facts.color,'white');
  assert.equal(b.requests.filter(request=>request.url==='/generate').length,1);
 }finally{await b.stop();}
});


test('running task inputs stay locked while layout edits remain available',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store,{status:'running'});
 const workspace='canvas-active-input-lock';
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create(workspace,{});
  ({project}=await svc.update(workspace,project.id,{revision:project.revision,tasks:[{...project.tasks[0],prompt:'Original background',params:{quality:'high'}}]}));
  const p=await svc.preview(workspace,project.id,{taskIds:[project.tasks[0].id]});
  await svc.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  const running=await svc.detail(workspace,project.id);assert.equal(running.runs[0].status,'running');
  await assert.rejects(svc.update(workspace,project.id,{revision:running.project.revision,tasks:[{...running.project.tasks[0],prompt:'Replacement background'}]}),{code:'TASK_RUNNING'});
  const unchanged=await new CreationProjects(store,b).detail(workspace,project.id);
  assert.equal(unchanged.project.tasks[0].prompt,'Original background');
  assert.equal(unchanged.project.revision,running.project.revision);
  const moved=await svc.update(workspace,project.id,{revision:unchanged.project.revision,tasks:[{...unchanged.project.tasks[0],position:{x:900,y:-200}}],viewport:{x:20,y:40,zoom:0.8}});
  assert.deepEqual(moved.project.tasks[0].position,{x:900,y:-200});
  assert.equal(moved.runs[0].input.task.prompt,'Original background');
  assert.equal(b.requests.filter(request=>request.url==='/generate').length,1);
  await svc.cancel(workspace,project.id,{runIds:[running.runs[0].id]});
 }finally{await b.stop();}
});


test('downstream dispatch uses the selected success even after a newer upstream success exists',async()=>{
 const {generationBoundary}=await import('./creation-projects-fixture.mjs');const b=await generationBoundary(store);
 const workspace='canvas-pinned-not-latest';
 try {
  const svc=new CreationProjects(store,b);let {project}=await svc.create(workspace,{});const rootId=project.tasks[0].id;
  ({project}=await svc.update(workspace,project.id,{revision:project.revision,tasks:[{...project.tasks[0],prompt:'First background'}]}));
  let p=await svc.preview(workspace,project.id,{taskIds:[rootId]});
  await svc.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  const first=(await svc.detail(workspace,project.id)).runs[0];
  p=await svc.preview(workspace,project.id,{taskIds:[rootId],regenerateTaskIds:[rootId]});
  await svc.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  let detail=await svc.detail(workspace,project.id);
  assert.equal(detail.runs.length,2);assert.notEqual(detail.runs[1].output.assetId,first.output.assetId);
  ({project}=await svc.update(workspace,project.id,{revision:detail.project.revision,tasks:[...detail.project.tasks,{...detail.project.tasks[0],id:'chosen-child',title:'Selected source edit',prompt:'Brighten selected background',sourceRunId:first.id,position:{x:500,y:0}}],edges:[{id:'chosen-edge',source:rootId,target:'chosen-child'}]}));
  p=await svc.preview(workspace,project.id,{taskIds:['chosen-child']});
  assert.equal(p.scope[0].reuseRunId,first.id);
  await svc.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:crypto.randomUUID()});await svc.tick();
  detail=await new CreationProjects(store,b).detail(workspace,project.id);
  const child=detail.runs.find(run=>run.taskId==='chosen-child');
  assert.equal(child.status,'succeeded');assert.equal(child.input.sourceRunId,first.id);
  assert.equal(child.input.sourceAssetId,first.output.assetId);
  const submissions=b.requests.filter(request=>request.url==='/generate');
  assert.equal(submissions.length,3);assert.equal(submissions[2].body.sourceAssetId,first.output.assetId);
 }finally{await b.stop();}
});
