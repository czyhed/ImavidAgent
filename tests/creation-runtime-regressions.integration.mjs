import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import http from 'node:http';
import {Client} from 'minio';
import {setTimeout} from 'node:timers/promises';
import {startCreationApp} from './creation-app-fixture.mjs';
import {CreationProjects} from '../server/creation-projects.mjs';
import {CreationStore} from '../server/creation-store.mjs';
import {CreationMedia} from '../server/creation-media.mjs';
import {CreationLifecycle} from '../server/creation-lifecycle.mjs';
import {ChannelStore} from '../server/channels.mjs';
import {ModelHub} from '../server/model-hub.mjs';
let app;
test.before(async()=>{app=await startCreationApp({autoTick:false});});
test.after(async()=>{await app?.stop();});
async function editable(workspace,patch={}) {
 let {project}=await app.projects.create(workspace,{});
 return (await app.projects.update(workspace,project.id,{revision:project.revision,tasks:[{...project.tasks[0],prompt:'Studio background',...patch}]})).project;
}
async function begin(service,workspace,project,selection={}) {
 const p=await service.preview(workspace,project.id,{taskIds:[project.tasks[0].id],...selection});
 return service.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:randomUUID()});
}
const submissions=()=>app.calls.filter(c=>c.method==='POST'&&c.path.includes('video_generation'));
test('typed input images never execute, prompt edits invalidate reuse, and downstream pins one success',async()=>{
 const workspace='runtime-typed-workflows';
 const source=await app.media.put(workspace,{bytes:app.png,name:'reference.png',role:'creative'});
 let {project}=await app.projects.create(workspace,{graphVersion:4});
 const reference=project.tasks.find(t=>t.kind==='image'),prompt=project.tasks.find(t=>t.kind==='prompt'),target=project.tasks.find(t=>t.kind==='generate');
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id===reference.id?{...t,sourceAssetId:source.id}:t.id===prompt.id?{...t,prompt:'Soft daylight'}:t),edges:[...project.edges,{id:'ref-edge',source:reference.id,sourceHandle:'image',target:target.id,targetHandle:'ref'}]}));
 let preview=await app.projects.preview(workspace,project.id,{taskIds:[target.id]});
 assert.equal(preview.canStart,true);assert.deepEqual(preview.scope.map(s=>s.taskId),[target.id]);
 let started=await begin(app.projects,workspace,project,{taskIds:[target.id]});await app.projects.drive(started.runs[0].id);
 let detail=await app.projects.detail(workspace,project.id);const first=detail.runs[0];project=detail.project;
 assert.equal(first.input.sourceAssetId,source.id);assert.equal(first.status,'succeeded');
 assert.equal((await app.projects.preview(workspace,project.id,{taskIds:[target.id]})).scope[0].action,'reuse');
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id===prompt.id?{...t,prompt:'Warm afternoon'}:t)}));
 assert.equal((await app.projects.preview(workspace,project.id,{taskIds:[target.id]})).scope[0].action,'generate');
 started=await begin(app.projects,workspace,project,{taskIds:[target.id]});await app.projects.drive(started.runs.at(-1).id);
 detail=await app.projects.detail(workspace,project.id);project=detail.project;
 const child={...target,id:randomUUID(),kind:'edit',title:'Detail edit',prompt:'Keep the handle',sourceRunId:null,position:{x:850,y:300}};
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:[...project.tasks,child],edges:[...project.edges,{id:'result-edge',source:target.id,sourceHandle:'image',target:child.id,targetHandle:'image'}]}));
 preview=await app.projects.preview(workspace,project.id,{taskIds:[child.id]});assert.equal(preview.canStart,false);assert.equal(preview.scope.at(-1).action,'wait-input');
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id===child.id?{...t,sourceRunId:first.id}:t)}));
 preview=await app.projects.preview(workspace,project.id,{taskIds:[child.id]});assert.equal(preview.canStart,true);
 assert.deepEqual(preview.scope.at(-1).resolved.images,[{assetId:first.output.assetId,runId:first.id}]);
 assert.equal((await app.projects.detail(workspace,project.id)).runs.length,2,'preview never generates');
});
test('legacy queued invalid H3 parameters fail locally and remain editable without a provider POST',async()=>{
 const workspace='runtime-invalid-queued';let project=await editable(workspace,{kind:'video',params:{duration:6}});
 const started=await begin(app.projects,workspace,project);
 // Reproduce an unchanged queued snapshot persisted by an older application.
 await app.db.pool.query(`UPDATE sj_creation_runs SET input=jsonb_set(jsonb_set(input,'{params,duration}','31'),'{task,params,duration}','31') WHERE id=$1`,[started.runs[0].id]);
 const before=submissions().length;await app.projects.drive(started.runs[0].id);
 let detail=await app.projects.detail(workspace,project.id);
 assert.equal(detail.runs[0].status,'failed');
 assert.equal(detail.runs[0].error.code,'INVALID_VIDEO_PARAMETERS');
 assert.equal(submissions().length,before);
 ({project}=await app.projects.update(workspace,project.id,{revision:detail.project.revision,tasks:[{...detail.project.tasks[0],params:{duration:5}}]}));
 assert.equal((await app.projects.preview(workspace,project.id,{taskIds:[project.tasks[0].id]})).scope[0].action,'retry-confirm');
 await begin(app.projects,workspace,project,{retryTaskIds:[project.tasks[0].id]});await app.projects.tick();
 detail=await app.projects.detail(workspace,project.id);
 assert.equal(detail.runs[1].status,'running');assert.equal(submissions().length,before+1);
});
test('four concurrent starts and drives reuse their transaction clients with real ModelHub and pool max five',async()=>{
 const pool=new pg.Pool({...app.db.pool.options,password:app.db.pool.options.password,max:5,connectionTimeoutMillis:400});
 const store=new CreationStore(pool),channels=new ChannelStore(pool,app.hub.channels.encryptionKey);
 const hub=new ModelHub(store,channels,{transport:app.hub.transport});
 const media=new CreationMedia(store,app.media.client);
 const service=new CreationProjects(store,{hub,media});
 let worker;
 try {
  const workspace='runtime-pool',asset=await app.media.put(workspace,{bytes:app.png,name:'creative.png',role:'creative'});
  const starts=[];
  for(let i=0;i<4;i++){
   const project=await editable(workspace,{kind:'video',params:{duration:5},sourceAssetId:asset.id});
   const p=await service.preview(workspace,project.id,{taskIds:[project.tasks[0].id]});
   starts.push({id:project.id,body:{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:randomUUID()}});
  }
  worker=await pool.connect();
  const before=submissions().length;
  const results=await Promise.allSettled(starts.map(s=>service.start(workspace,s.id,s.body)));
  assert.deepEqual(results.filter(r=>r.status==='rejected').map(r=>r.reason.message),[],'all starts complete without borrowing an extra connection');
  assert.ok(results.every(r=>r.value.runs.length===1));
  const ids=results.map(r=>r.value.runs[0].id);
  await Promise.all(ids.map(id=>service.drive(id)));
  assert.equal(submissions().length,before+4);
  await Promise.all(ids.map(id=>service.drive(id)));
  assert.equal(submissions().length,before+4,'recovery queries never submit again');
  const completed=await Promise.all(starts.map(s=>service.detail(workspace,s.id)));
  assert.ok(completed.every(d=>d.runs[0].status==='succeeded'));
  await Promise.all(starts.map(s=>service.start(workspace,s.id,s.body)));
  assert.equal(submissions().length,before+4,'idempotent starts never submit again');
 }finally{worker?.release();await pool.end();}
});
test('adding an unfinished input to a successful task invalidates independent success reuse',async()=>{
 const workspace='runtime-edge-added';let project=await editable(workspace);
 const root=project.tasks[0],b={...root,id:'B',title:'B',prompt:'Independent B'};
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:[root,b]}));
 const started=await begin(app.projects,workspace,project,{taskIds:['B']});await app.projects.drive(started.runs[0].id);
 let detail=await app.projects.detail(workspace,project.id);
 ({project}=await app.projects.update(workspace,project.id,{revision:detail.project.revision,edges:[{id:'A-B',source:root.id,target:'B'}]}));
 const p=await app.projects.preview(workspace,project.id,{taskIds:['B']});
 assert.deepEqual(p.scope.map(s=>[s.taskId,s.action]),[[root.id,'generate'],['B','wait-input']]);
 assert.equal((await app.projects.detail(workspace,project.id)).runs.length,1,'preview never submits new work');
});
test('planning sees only selectable creative image metadata and application revalidates the selected asset',async()=>{
 const workspace='runtime-planning-assets';
 const product=await app.store.create(workspace,'product',{name:'Cup',facts:{},creativeAssetIds:[]});
 let {project}=await app.projects.create(workspace,{productId:product.id});
 const creative=await app.media.put(workspace,{bytes:app.png,name:'cup-front.png',productId:product.id,role:'creative'});
 const independent=await app.media.put(workspace,{bytes:app.png,name:'background.png',role:'creative'});
 const evidence=await app.media.put(workspace,{bytes:app.png,name:'evidence.png',productId:product.id,role:'evidence'});
 const trashed=await app.media.put(workspace,{bytes:app.png,name:'trash.png',role:'creative'});
 await app.store.change(workspace,trashed.id,trashed.revision,a=>({...a,trashedAt:new Date().toISOString()}));
 const pending=await app.media.put(workspace,{bytes:app.png,name:'pending.png',role:'creative'});
 await app.store.change(workspace,pending.id,pending.revision,a=>({...a,deletionPending:true}));
 const result=await app.media.put(workspace,{bytes:app.png,name:'result.png',role:'result'});
 const foreign=await app.media.put('runtime-other-workspace',{bytes:app.png,name:'foreign.png',role:'creative'});
 const video=await app.store.create(workspace,'asset',{name:'clip.mp4',mime:'video/mp4',role:'creative'});
 const before=app.calls.length;
 const proposal=await app.projects.suggest(workspace,project.id,{revision:project.revision,requestKey:randomUUID(),instructions:'Use a creative product image'});
 assert.equal(proposal.suggestion.status,'ready');
 const call=app.calls.slice(before).find(c=>c.path.endsWith('/chat/completions'));
 const context=JSON.parse(call.body.messages.find(m=>m.role==='user').content);
 assert.deepEqual(context.creativeAssets?.map(a=>a.id).sort(),[creative.id,independent.id].sort());
 const image=context.creativeAssets.find(a=>a.id===creative.id);
 assert.equal(image.name,'cup-front.png');assert.equal(image.productId,product.id);assert.equal(image.mime,'image/png');
 assert.equal(image.width,64);assert.equal(image.height,64);
 for(const a of context.creativeAssets)assert.deepEqual(Object.keys(a).sort(),['height','id','mime','name','productId','width']);
 for(const asset of [evidence,trashed,pending,result,foreign,video])assert.ok(!context.creativeAssets.some(a=>a.id===asset.id));
 assert.equal((await app.projects.detail(workspace,project.id)).runs.length,0);
 // Planner output is untrusted: inject the formerly selectable asset into its persisted suggestion.
 await app.store.change(workspace,project.id,null,p=>({...p,suggestions:p.suggestions.map(s=>({...s,plan:{additions:[{kind:'image',title:'Chosen source',prompt:'Use selected image',subject:'product',params:{},sourceAssetId:creative.id}],updates:[]}}))}));
 await app.store.change(workspace,creative.id,creative.revision,a=>({...a,trashedAt:new Date().toISOString()}));
 project=(await app.projects.detail(workspace,project.id)).project;
 await assert.rejects(app.projects.applySuggestion(workspace,project.id,{revision:project.revision,suggestionId:proposal.suggestion.id}),{code:'SOURCE_INVALID'});
 assert.equal((await app.projects.detail(workspace,project.id)).project.tasks.length,1);
});
test('reuse ignores layout and unrelated edges, retains history pins, and invalidates removed or changed upstreams',async()=>{
 const workspace='runtime-edge-semantics';let project=await editable(workspace);
 const a=project.tasks[0];
 let started=await begin(app.projects,workspace,project);await app.projects.drive(started.runs[0].id);
 let detail=await app.projects.detail(workspace,project.id);const pinned=detail.runs[0];
 const b={...a,id:'B',title:'B',sourceRunId:pinned.id,prompt:'Edit pinned A'};
 ({project}=await app.projects.update(workspace,project.id,{revision:detail.project.revision,tasks:[a,b],edges:[{id:'A-B',source:a.id,target:'B'}]}));
 started=await begin(app.projects,workspace,project,{taskIds:['B']});
 await app.projects.drive(started.runs.find(r=>r.taskId==='B').id);
 detail=await app.projects.detail(workspace,project.id);project=detail.project;
 started=await begin(app.projects,workspace,project,{regenerateTaskIds:[a.id]});
 await app.projects.drive(started.runs.at(-1).id);
 detail=await app.projects.detail(workspace,project.id);
 const c={...a,id:'C',title:'C'},d={...a,id:'D',title:'D'};
 ({project}=await app.projects.update(workspace,project.id,{revision:detail.project.revision,tasks:[{...a,prompt:'New A'}, {...b,position:{x:700,y:900}},c,d],edges:[{id:'renamed',source:a.id,target:'B'},{id:'unrelated',source:'C',target:'D'}],viewport:{x:10,y:10,zoom:0.7}}));
 const before=app.calls.filter(c=>c.path.includes('/images/')).length;
 let p=await app.projects.preview(workspace,project.id,{taskIds:['B']});
 assert.deepEqual(p.scope.map(e=>[e.taskId,e.action]),[['B','reuse']]);
 p=await app.projects.preview(workspace,project.id,{taskIds:['B'],regenerateTaskIds:['B']});
 assert.equal(p.scope[0].reuseRunId,pinned.id,'manual regeneration still uses the pinned older A');
 assert.equal(p.scope[1].action,'generate');
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,edges:[{id:'unrelated',source:'C',target:'D'}]}));
 p=await app.projects.preview(workspace,project.id,{taskIds:['B']});
 assert.equal(p.scope.at(-1).action,'generate','removing the edge changes the dependency semantics even with the same sourceRunId');
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,edges:[{id:'again',source:a.id,target:'B'}]}));
 assert.equal((await app.projects.preview(workspace,project.id,{taskIds:['B']})).scope.at(-1).action,'reuse');
 await assert.rejects(app.projects.update(workspace,project.id,{revision:project.revision,edges:[{id:'C-B',source:'C',target:'B'}]}),{code:'SOURCE_RUN_INVALID'});
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:project.tasks.map(t=>t.id==='B'?{...t,sourceRunId:null}:t),edges:[{id:'C-B',source:'C',target:'B'}]}));
 p=await app.projects.preview(workspace,project.id,{taskIds:['B']});
 assert.deepEqual(p.scope.map(e=>[e.taskId,e.action]),[['C','generate'],['B','wait-input']]);
 assert.equal(app.calls.filter(c=>c.path.includes('/images/')).length,before);
});

test('lost submission response fails as SUBMIT_UNCONFIRMED without blocking, logs a sanitized line, and retry creates a new run',async()=>{
 const workspace='runtime-lost-response';const project=await editable(workspace,{kind:'video',params:{duration:5}});
 const hub=new ModelHub(app.store,app.hub.channels,{transport:async(url,options)=>{
  const response=await app.hub.transport(url,options);
  if(options.method==='POST'&&url.includes('video_generation')){await response.body.cancel();throw new Error('fixture lost accepted response');}
  return response;
 }});
 const service=new CreationProjects(app.store,{hub,media:app.media});
 const p=await service.preview(workspace,project.id,{taskIds:[project.tasks[0].id]});
 const body={...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:randomUUID()};
 const started=await service.start(workspace,project.id,body),before=submissions().length;
 const logs=[],originalWarn=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{await service.drive(started.runs[0].id);}finally{console.warn=originalWarn;}
 let detail=await service.detail(workspace,project.id);assert.equal(detail.runs[0].status,'failed');assert.equal(detail.runs[0].upstreamId,null);
 assert.equal(detail.runs[0].error.code,'SUBMIT_UNCONFIRMED');assert.match(detail.runs[0].error.message,/提交未确认/);
 const line=logs.find(l=>l.startsWith('video-submit-error'));assert.ok(line,'a video-submit-error line is logged');
 assert.match(line,new RegExp(`run=${started.runs[0].id}`));assert.match(line,/code=PROVIDER_TRANSPORT_UNKNOWN/);
 assert.ok(!/Bearer|apiKey|api-key|data:|Studio background/i.test(logs.join('\n')),'logs contain no keys, data URLs or prompts');
 const restarted=new CreationProjects(app.store,{hub:app.hub,media:app.media});
 await restarted.tick();
 // 失败不再占用节点：可直接编辑，预览要求一次明确的重试确认，确认后创建新请求。
 const afterFail=await restarted.preview(workspace,project.id,{taskIds:[project.tasks[0].id]});assert.equal(afterFail.scope[0].action,'retry-confirm');
 const retry=await restarted.preview(workspace,project.id,{taskIds:[project.tasks[0].id],retryTaskIds:[project.tasks[0].id]});assert.equal(retry.scope[0].action,'generate');
 const second=await restarted.start(workspace,project.id,{...retry.selection,revision:retry.revision,previewToken:retry.previewToken,requestKey:randomUUID()});
 assert.equal(second.runs.length,2);assert.notEqual(second.runs[1].id,second.runs[0].id);
 await restarted.drive(second.runs[1].id);
 detail=await restarted.detail(workspace,project.id);assert.equal(detail.runs[0].status,'failed');assert.equal(detail.runs[1].status,'running');assert.ok(detail.runs[1].upstreamId);
 assert.equal(submissions().length,before+2,'exactly one explicit retry POST');
});
test('submit timeout (AbortError) is failed SUBMIT_UNCONFIRMED, not active, and carries a cause name in the log',async()=>{
 const workspace='runtime-submit-timeout';const project=await editable(workspace,{kind:'video',params:{duration:5}});
 const hub=new ModelHub(app.store,app.hub.channels,{transport:async(url,options)=>{
  if(options.method==='POST'&&url.includes('video_generation'))throw Object.assign(new Error('The operation was aborted due to timeout'),{name:'TimeoutError'});
  return app.hub.transport(url,options);
 }});
 const service=new CreationProjects(app.store,{hub,media:app.media});
 const started=await begin(service,workspace,project);
 const logs=[],originalWarn=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{await service.drive(started.runs[0].id);}finally{console.warn=originalWarn;}
 const detail=await service.detail(workspace,project.id);
 assert.equal(detail.runs[0].status,'failed');assert.equal(detail.runs[0].error.code,'SUBMIT_UNCONFIRMED');
 assert.match(logs.find(l=>l.startsWith('video-submit-error')),/cause=TimeoutError/);
 assert.equal((await service.preview(workspace,project.id,{taskIds:[project.tasks[0].id],retryTaskIds:[project.tasks[0].id]})).scope[0].action,'generate');
});
test('HTTP 5xx on submit records the upstream status in the log and fails as SUBMIT_UNCONFIRMED',async()=>{
 const workspace='runtime-submit-5xx';const project=await editable(workspace,{kind:'video',params:{duration:5}});
 const hub=new ModelHub(app.store,app.hub.channels,{transport:async(url,options)=>{
  if(options.method==='POST'&&url.includes('video_generation'))return new Response('{"secret":"must-not-be-logged"}',{status:503});
  return app.hub.transport(url,options);
 }});
 const service=new CreationProjects(app.store,{hub,media:app.media});
 const started=await begin(service,workspace,project);
 const logs=[],originalWarn=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{await service.drive(started.runs[0].id);}finally{console.warn=originalWarn;}
 const detail=await service.detail(workspace,project.id);
 assert.equal(detail.runs[0].status,'failed');assert.equal(detail.runs[0].error.code,'SUBMIT_UNCONFIRMED');
 assert.match(logs.find(l=>l.startsWith('video-submit-error')),/upstreamStatus=503/);
 assert.ok(!logs.join('\n').includes('must-not-be-logged'));
});
test('poll errors with an upstream id keep the run running and log poll-error; a stuck run with no upstream id is failed, a stuck cancelling run is cancelled',async()=>{
 const workspace='runtime-poll-errors';const project=await editable(workspace,{kind:'video',params:{duration:5}});
 let breakPoll=false;
 const hub=new ModelHub(app.store,app.hub.channels,{transport:async(url,options)=>{
  if(breakPoll&&options.method==='GET'&&url.includes('query/video_generation'))throw Object.assign(new Error('socket hang up'),{name:'TypeError'});
  return app.hub.transport(url,options);
 }});
 const service=new CreationProjects(app.store,{hub,media:app.media});
 const started=await begin(service,workspace,project);
 await service.drive(started.runs[0].id);
 let run=(await service.detail(workspace,project.id)).runs[0];assert.equal(run.status,'running');assert.ok(run.upstreamId);
 breakPoll=true;
 const logs=[],originalWarn=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{await service.drive(run.id);}finally{console.warn=originalWarn;}
 run=(await service.detail(workspace,project.id)).runs[0];assert.equal(run.status,'running');assert.equal(run.error,null);
 assert.ok(logs.some(l=>l.startsWith('poll-error')&&l.includes(`run=${run.id}`)));
 // 30 分钟内持续失败后才标记 POLL_FAILED。
 await app.db.pool.query(`UPDATE sj_creation_runs SET output=jsonb_set(COALESCE(output,'{}'::jsonb),'{_pollFailSince}',to_jsonb($2::text)) WHERE id=$1`,[run.id,new Date(Date.now()-31*60*1000).toISOString()]);
 console.warn=()=>{};try{await service.drive(run.id);}finally{console.warn=originalWarn;}
 run=(await service.detail(workspace,project.id)).runs[0];assert.equal(run.status,'failed');assert.equal(run.error.code,'POLL_FAILED');
 // 无上游编号的 submitting 残留（提交中崩溃）→ 失败，不查询、不重新提交。
 const before=submissions().length;
 const stuckId=randomUUID(),cancellingId=randomUUID();
 for(const [id,status] of [[stuckId,'submitting'],[cancellingId,'cancelling']])await app.db.pool.query('INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status) SELECT $1,workspace_id,project_id,task_id,gen_random_uuid(),input,$3 FROM sj_creation_runs WHERE id=$2',[id,run.id,status]);
 await service.tick();
 const rows=Object.fromEntries((await service.detail(workspace,project.id)).runs.map(r=>[r.id,r]));
 assert.equal(rows[stuckId].status,'failed');assert.equal(rows[stuckId].error.code,'SUBMIT_UNCONFIRMED');
 assert.equal(rows[cancellingId].status,'cancelled');
 assert.equal(submissions().length,before,'no resubmission');
});
test('queued invalid video parameters and invalid source bytes fail before submission and allow manual correction',async()=>{
 for(const [name,patch,expected] of [
  ['duration',{params:{duration:31}},'INVALID_VIDEO_PARAMETERS'],
  ['adaptive',{params:{ratio:'adaptive'}},'INVALID_VIDEO_PARAMETERS'],
  ['source',{params:{duration:5}},'INVALID_MEDIA'],
 ]) {
  const workspace='runtime-local-'+name;
  let sourceAssetId=null;
  if(name==='source'){
   const source=await app.media.put(workspace,{bytes:app.png,name:'corrupt.png',role:'creative'});sourceAssetId=source.id;
   const asset=await app.store.get(workspace,source.id);await app.media.client.putObject('shangjing-assets',asset.objectKey,Buffer.from('not an image'));
  }
  const project=await editable(workspace,{kind:'video',params:{duration:5},sourceAssetId});
  const started=await begin(app.projects,workspace,project),before=submissions().length;
  await app.db.pool.query("UPDATE sj_creation_runs SET input=jsonb_set(jsonb_set(input,'{params}',$2::jsonb),'{task,params}',$2::jsonb) WHERE id=$1",[started.runs[0].id,JSON.stringify(patch.params)]);
  await app.projects.drive(started.runs[0].id);
  const detail=await app.projects.detail(workspace,project.id);
  assert.equal(detail.runs[0].status,'failed',name);assert.equal(detail.runs[0].error.code,expected,name);
  assert.equal(submissions().length,before,name);
  await app.projects.update(workspace,project.id,{revision:detail.project.revision,tasks:[{...detail.project.tasks[0],params:{duration:5},sourceAssetId:null}]});
 }
});
test('preview blocks invalid H3 parameters before start while valid adaptive first-frame inputs remain startable',async()=>{
 const workspace='runtime-preview-parameters';let project=await editable(workspace,{kind:'video',params:{duration:31}});
 const before=submissions().length;
 let p=await app.projects.preview(workspace,project.id,{taskIds:[project.tasks[0].id]});
 assert.equal(p.scope[0].action,'blocked');assert.equal(p.canStart,false);
 await assert.rejects(app.projects.start(workspace,project.id,{...p.selection,revision:p.revision,previewToken:p.previewToken,requestKey:randomUUID()}),{code:'START_BLOCKED'});
 assert.equal((await app.projects.detail(workspace,project.id)).runs.length,0);
 const source=await app.media.put(workspace,{bytes:app.png,name:'first-frame.png',role:'creative'});
 ({project}=await app.projects.update(workspace,project.id,{revision:project.revision,tasks:[{...project.tasks[0],sourceAssetId:source.id,params:{duration:5,ratio:'adaptive'}}]}));
 p=await app.projects.preview(workspace,project.id,{taskIds:[project.tasks[0].id]});
 assert.equal(p.scope[0].action,'generate');assert.equal(p.canStart,true);assert.equal(submissions().length,before);
});
test('media collection on a held client respects workspace deletion transactions and keeps no dangling output',async()=>{
 const workspace='runtime-media-deletion-lock';
 const product=await app.store.create(workspace,'product',{name:'Being deleted',facts:{}});
 const deletion=await app.db.pool.connect(),writer=await app.db.pool.connect();
 let upload,settled=false;
 try {
  await deletion.query('BEGIN');
  await deletion.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
  await deletion.query("UPDATE sj_creation_records SET body=body || '{\"deletionPending\":true}'::jsonb WHERE id=$1",[product.id]);
  const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  upload=app.media.put(workspace,{bytes:app.png,name:'result.png',productId:product.id,role:'result'},writer).then(value=>({value}),error=>({error})).then(outcome=>{settled=true;return outcome;});
  // Wait until either the write incorrectly completes or PostgreSQL confirms it waits on the deletion lock.
  let waits=false;
  for(let i=0;i<100&&!settled;i++){
   waits=(await app.db.pool.query("SELECT wait_event_type='Lock' AS waits FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waits;
   if(waits)break;await setTimeout(10);
  }
  assert.equal(waits,true,'media must wait on workspace lock before validating its parent');
  await deletion.query('COMMIT');
  const outcome=await upload;
  assert.equal(outcome.value,undefined,'no asset may be saved across an in-progress parent deletion');
  assert.equal(outcome.error?.code,'NOT_FOUND');
  assert.equal((await app.store.list(workspace,'asset')).length,0);
  assert.equal((await writer.query('SELECT 1 AS available')).rows[0].available,1,'caller connection remains usable');
 }finally{await deletion.query('ROLLBACK');await upload;writer.release();deletion.release();}
});

// Hold the first S3 PUT response after its bytes reach the versioned object store.
async function stalledMedia(store) {
 let resume,arrived,first=true;
 const gate=new Promise(resolve=>{resume=resolve;}),uploaded=new Promise(resolve=>{arrived=resolve;});
 const objects=new Map();
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),key=decodeURIComponent(url.pathname).slice('/shangjing-assets/'.length);
  if(req.method==='GET'&&url.searchParams.has('versions')){
   res.setHeader('Content-Type','application/xml');
   res.end('<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'+[...objects].filter(([k])=>k.startsWith(url.searchParams.get('prefix')||'')).flatMap(([k,versions])=>versions.map(v=>{const tag=v.marker?'DeleteMarker':'Version';return `<${tag}><Key>${k}</Key><VersionId>${v.id}</VersionId><IsLatest>false</IsLatest><LastModified>2026-10-22T00:00:00Z</LastModified>${v.marker?'':'<ETag>etag</ETag><Size>'+v.bytes.length+'</Size>'}</${tag}>`;})).join('')+'<IsTruncated>false</IsTruncated></ListVersionsResult>');return;
  }
  if(req.method==='PUT'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const versions=objects.get(key)||[],id=randomUUID();versions.push({id,bytes:Buffer.concat(chunks)});objects.set(key,versions);
   if(first){first=false;arrived(key);await gate;}
   res.setHeader('ETag','"d41d8cd98f00b204e9800998ecf8427e"');res.setHeader('x-amz-version-id',id);res.end();return;
  }
  if(req.method==='DELETE'){
   const id=url.searchParams.get('versionId'),versions=objects.get(key)||[];
   objects.set(key,id?versions.filter(v=>v.id!==id):[...versions,{id:randomUUID(),marker:true}]);
   res.writeHead(204);res.end();return;
  }
  const latest=(objects.get(key)||[]).at(-1);
  if(!latest||latest.marker){res.writeHead(404);res.end('<Error><Code>NoSuchKey</Code></Error>');return;}
  res.setHeader('Content-Length',latest.bytes.length);res.end(req.method==='HEAD'?undefined:latest.bytes);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=new Client({endPoint:'127.0.0.1',port:server.address().port,useSSL:false,region:'us-east-1',accessKey:'stalled-upload-fixture',secretKey:'stalled-upload-fixture-only'});
 return {media:new CreationMedia(store,client),uploaded,resume,stop:async()=>{resume();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function objectVersions(client,key) {
 const entries=[];for await(const entry of client.listObjects('shangjing-assets',key,true,{IncludeVersion:true}))if(entry.name===key)entries.push(entry);
 return entries;
}
test('stalled object uploads leave same-workspace writes unblocked on held and default clients',async()=>{
 for(const held of [true,false]){
  const workspace='runtime-stalled-'+(held?'held':'default');
  const pool=new pg.Pool({...app.db.pool.options,password:app.db.pool.options.password,max:1,connectionTimeoutMillis:400});
  const fixture=await stalledMedia(new CreationStore(pool));
  const parent=await app.store.create(workspace,'product',{name:'Before upload',facts:{}});
  let writer,upload,write;
  try {
   if(held)writer=await pool.connect();
   upload=fixture.media.put(workspace,{bytes:app.png,name:'creative.png',productId:parent.id},writer).then(value=>({value}),error=>({error}));
   const key=await fixture.uploaded;
   write=app.store.change(workspace,parent.id,parent.revision,p=>({...p,name:'Edited during upload'}));
   const completed=await Promise.race([write.then(()=>true),setTimeout(700,false)]);
   assert.equal(completed,true,'an unrelated workspace write must finish before the upload response is released: '+workspace);
   assert.equal((await app.store.list(workspace,'asset')).length,0,'upload is still pending');
   fixture.resume();
   const outcome=await upload;assert.equal(outcome.error,undefined);
   assert.equal(outcome.value.productId,parent.id);assert.equal(outcome.value.objectKey,key);
   assert.deepEqual((await fixture.media.read(workspace,outcome.value.id,writer)).bytes,app.png);
   assert.equal((await app.store.get(workspace,parent.id)).name,'Edited during upload');
   assert.equal((await app.store.list(workspace,'asset')).length,1);
   if(writer)assert.equal((await writer.query('SELECT 1 AS available')).rows[0].available,1);
  }finally{fixture.resume();await upload;await write;writer?.release();await pool.end();await fixture.stop();}
 }
});

test('parent deletion during an upload rejects metadata and compensates every object version',async()=>{
 for(const pending of [true,false]){
  const workspace='runtime-upload-parent-'+(pending?'pending':'missing'),kind=pending?'product':'project';
  const parent=await app.store.create(workspace,kind,{name:'Upload parent',facts:{},tasks:[]});
  const pool=new pg.Pool({...app.db.pool.options,password:app.db.pool.options.password,max:1,connectionTimeoutMillis:400});
  const fixture=await stalledMedia(new CreationStore(pool)),lifecycle=new CreationLifecycle(app.store,{media:fixture.media});
  let writer,upload;
  try {
   if(pending)writer=await pool.connect();
   upload=fixture.media.put(workspace,{bytes:app.png,name:'result.png',[kind+'Id']:parent.id,role:'result'},writer).then(value=>({value}),error=>({error}));
   const key=await fixture.uploaded;
   // Include an older version so ordinary S3 deletion cannot satisfy cleanup.
   await fixture.media.client.putObject('shangjing-assets',key,app.png);
   assert.equal((await objectVersions(fixture.media.client,key)).length,2);
   if(pending)await app.store.change(workspace,parent.id,parent.revision,p=>({...p,deletionPending:true}));
   else {
    const trashed=await lifecycle.trash(workspace,parent.id,parent.revision),plan=await lifecycle.preview(workspace,parent.id);
    await lifecycle.destroy(workspace,parent.id,trashed.revision,plan.token);
    assert.equal(await app.store.get(workspace,parent.id),undefined);
   }
   fixture.resume();
   const outcome=await upload;
   assert.equal(outcome.value,undefined);assert.equal(outcome.error?.code,'NOT_FOUND');
   assert.equal((await app.store.list(workspace,'asset')).length,0);
   assert.deepEqual(await objectVersions(fixture.media.client,key),[],'all object versions must be compensated');
   if(writer)assert.equal((await writer.query('SELECT 1 AS available')).rows[0].available,1);
  }finally{fixture.resume();await upload;writer?.release();await pool.end();await fixture.stop();}
 }
});

test('connection acquisition failure after upload preserves the error and compensates all object versions',async()=>{
 const failure=new Error('fixture connection unavailable');let connections=0,inserts=0;
 const store={pool:{connect:async()=>{connections++;throw failure;}},create:async()=>{inserts++;throw new Error('unexpected metadata insert');}};
 const fixture=await stalledMedia(store);let upload;
 try {
  upload=fixture.media.put('runtime-upload-connect-failed',{bytes:app.png,name:'creative.png'}).then(value=>({value}),error=>({error}));
  const key=await fixture.uploaded;
  await fixture.media.client.putObject('shangjing-assets',key,app.png);
  assert.equal((await objectVersions(fixture.media.client,key)).length,2);
  fixture.resume();const outcome=await upload;
  assert.equal(outcome.value,undefined);assert.equal(outcome.error,failure,'the original acquisition error is preserved');
  assert.equal(connections,1);assert.equal(inserts,0);
  assert.deepEqual(await objectVersions(fixture.media.client,key),[],'all uploaded versions are compensated even without a SQL client');
 }finally{fixture.resume();await upload;await fixture.stop();}
});
