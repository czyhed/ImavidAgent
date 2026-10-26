import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startCreationApp} from './creation-app-fixture.mjs';
import {createWorkflow} from '../shared/creation-workflows.mjs';
let app;
test.before(async()=>{app=await startCreationApp({autoTick:false});});
test.after(async()=>{await app?.stop();});
test('a 13-workflow graph over 100 KB saves and previews through the real HTTP boundary',async()=>{
 const {project}=await app.api('/api/creation/projects',{name:'多任务保存回归',graphVersion:4});
 const groups=Array.from({length:13},(_,i)=>createWorkflow(project,{title:`任务 ${i+1}`,prompt:'保留商品细节与自然光影。'.repeat(400)},randomUUID));
 const payload={revision:project.revision,name:project.name,workflows:groups.map(g=>g.workflow),tasks:groups.flatMap(g=>g.tasks),edges:groups.flatMap(g=>g.edges),viewport:{x:30,y:20,zoom:0.8}};
 assert.ok(Buffer.byteLength(JSON.stringify(payload))>100_000);
 const response=await fetch(app.origin+'/api/creation/projects/'+project.id,{method:'PATCH',headers:{'X-CSRF-Token':app.csrf,'Content-Type':'application/json'},body:JSON.stringify(payload)});
 assert.equal(response.status,200,'A valid multi-task project must not hit the ordinary JSON limit');
 const saved=await app.api('/api/creation/projects/'+project.id);
 assert.equal(saved.project.tasks.length,52);
 assert.deepEqual(saved.project.workflows,payload.workflows);
 assert.equal(saved.project.tasks[1].prompt,payload.tasks[1].prompt);
 const before=app.calls.length;
 const preview=await app.api('/api/creation/projects/'+project.id+'/preview',{taskIds:[groups[2].tasks[2].id]});
 assert.ok(preview.previewToken);
 assert.equal(app.calls.length,before,'Preview must not call a provider');
});
test('larger graph budget stays bounded and does not enlarge ordinary JSON endpoints',async()=>{
 const {project}=await app.api('/api/creation/projects',{name:'限制回归',graphVersion:4});
 for(const [path,method,body] of [
  ['/api/creation/projects/'+project.id,'PATCH',{revision:project.revision,name:'x'.repeat(9*1024*1024)}],
  ['/api/creation/projects','POST',{name:'x'.repeat(110_000)}],
  ['/api/creation/projects/'+project.id+'/preview','POST',{padding:'x'.repeat(110_000)}],
 ]){
  const response=await fetch(app.origin+path,{method,headers:{'X-CSRF-Token':app.csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,413,path);
  assert.equal((await response.json()).error.code,'TOO_LARGE');
 }
 assert.equal((await app.api('/api/creation/projects/'+project.id)).project.revision,project.revision);
});
test('chunked oversized JSON returns a readable 413 response instead of resetting the socket',async()=>{
 async function* body(){yield '{"padding":"';for(let i=0;i<4;i++)yield 'x'.repeat(40_000);yield '"}';}
 const response=await fetch(app.origin+'/api/creation/projects',{method:'POST',headers:{'X-CSRF-Token':app.csrf,'Content-Type':'application/json'},body:body(),duplex:'half'});
 assert.equal(response.status,413);
 assert.equal((await response.json()).error.code,'TOO_LARGE');
});
test('real ModelHub, SQL and S3 integrate chat, image snapshots, exact source versions, H3 and ZIP over HTTP',async()=>{
 const {product}=await app.api('/api/creation/products/chat',{text:'陶瓷茶杯，容量300ml',requestKey:randomUUID()});
 assert.equal(product.name,'茶杯');assert.equal(product.facts.容量,'300ml');
 const upload=await fetch(app.origin+'/api/creation/assets/upload?role=creative&productId='+product.id+'&name=original.png',{method:'POST',headers:{'X-CSRF-Token':app.csrf,'Content-Type':'image/png'},body:app.png});
 assert.equal(upload.status,201);const {asset}=await upload.json();
 let detail=await app.api('/api/creation/projects',{productId:product.id,name:'整站联调'});
 const id=detail.project.id,firstId=detail.project.tasks[0].id;
 detail=await app.api('/api/creation/projects/'+id,{revision:detail.project.revision,tasks:detail.project.tasks.map(t=>({...t,prompt:'白色背景商品摄影',sourceAssetId:asset.id}))},'PATCH');
 async function start(taskId){const preview=await app.api('/api/creation/projects/'+id+'/preview',{taskIds:[taskId]});return app.api('/api/creation/projects/'+id+'/start',{...preview.selection,revision:preview.revision,previewToken:preview.previewToken,requestKey:randomUUID()});}
 const firstStart=await start(firstId);await app.projects.tick();
 detail=await app.api('/api/creation/projects/'+id);const image=detail.runs.find(r=>r.taskId===firstId);
 assert.equal(image.status,'succeeded');assert.equal(image.input.sourceAssetId,asset.id);
 const edit=app.calls.find(c=>c.path.endsWith('/images/edits'));assert.ok(edit);
 const imageFile=await fetch(app.origin+image.output.fileUrl);assert.deepEqual(Buffer.from(await imageFile.arrayBuffer()),app.png);
 const videoTask={...detail.project.tasks[0],id:randomUUID(),kind:'video',title:'商品短视频',prompt:'镜头缓慢环绕茶杯',params:{duration:5,resolution:'768P',ratio:'16:9'},sourceAssetId:null,sourceRunId:image.id,position:{x:480,y:120}};
 detail=await app.api('/api/creation/projects/'+id,{revision:detail.project.revision,tasks:[...detail.project.tasks,videoTask],edges:[{id:randomUUID(),source:firstId,target:videoTask.id}]},'PATCH');
 await start(videoTask.id);await app.projects.tick();await app.projects.tick();
 detail=await app.api('/api/creation/projects/'+id);const video=detail.runs.find(r=>r.taskId===videoTask.id);
 assert.equal(video.status,'succeeded');assert.equal(video.input.sourceRunId,image.id);
 const submitted=app.calls.find(c=>c.path.endsWith('/minimax/v2/video_generation'));
 assert.equal(submitted.body.content[1].role,'first_frame');assert.equal(submitted.body.content[1].image_url.url,'data:image/png;base64,'+app.png.toString('base64'));
 assert.equal(app.calls.filter(c=>c.path.endsWith('/images/edits')).length,1);
 assert.equal(detail.runs.filter(r=>r.taskId===firstId).length,1);
 const assets=await app.api('/api/creation/assets');assert.equal(assets.items.filter(a=>a.role==='result').length,2);
 const range=await fetch(app.origin+video.output.fileUrl,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
 const exported=await fetch(app.origin+'/api/creation/projects/'+id+'/export',{method:'POST',headers:{'X-CSRF-Token':app.csrf,'Content-Type':'application/json'},body:JSON.stringify({runIds:[image.id,video.id]})});
 assert.equal(exported.status,200);assert.equal(Buffer.from(await exported.arrayBuffer()).readUInt32LE(),0x04034b50);
 const overview=await app.api('/api/creation/overview');assert.equal(overview.metrics.succeeded,2);assert.equal(overview.costs.unknown,3);assert.equal(overview.modelUsage[0].stage,'product');
 assert.equal(firstStart.runs.length,1);
});

test('AI-style video dimensions preview and freeze the same canonical H3 parameters submitted over HTTP',async()=>{
 const {project}=await app.api('/api/creation/projects',{name:'视频参数回归',graphVersion:4});
 const workflow=createWorkflow(project,{kind:'video',title:'15秒竖屏视频',prompt:'镜头缓慢推进',params:{duration:15,resolution:'1080x1920',aspectRatio:'9:16'}},randomUUID);
 await app.api('/api/creation/projects/'+project.id,{revision:project.revision,tasks:workflow.tasks,edges:workflow.edges,workflows:[workflow.workflow]},'PATCH');
 const taskId=workflow.tasks.find(t=>t.kind==='video').id;
 const before=app.calls.length;
 const preview=await app.api('/api/creation/projects/'+project.id+'/preview',{taskIds:[taskId]});
 assert.equal(preview.canStart,true,JSON.stringify(preview.scope));
 assert.equal(app.calls.slice(before).filter(c=>!c.path.endsWith('/point_usage_summary')).length,0,'preview must not submit a model request');
 const started=await app.api('/api/creation/projects/'+project.id+'/start',{...preview.selection,revision:preview.revision,previewToken:preview.previewToken,requestKey:randomUUID()});
 assert.deepEqual(started.runs[0].input.params,{duration:15,resolution:'1080P',ratio:'9:16'});
 assert.equal(started.runs[0].input.task.params.resolution,'1080x1920','retain the original task snapshot for matching and history');
 await app.projects.tick();
 const submitted=app.calls.slice(before).find(c=>c.path.endsWith('/minimax/v2/video_generation'));
 assert.equal(submitted.body.resolution,'1080P');assert.equal(submitted.body.ratio,'9:16');assert.equal(submitted.body.duration,15);
 assert.equal(submitted.body.aspectRatio,undefined);
 await app.projects.tick();
 assert.equal((await app.api('/api/creation/projects/'+project.id)).runs[0].status,'succeeded');
});
