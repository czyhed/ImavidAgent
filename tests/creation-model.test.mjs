import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { ChannelStore } from '../server/channels.mjs';
import { ModelHub } from '../server/model-hub.mjs';
const channelId = 'ch_0000000000000001';
let db, channels, store;
test.before(async () => { db = await startTestPostgres(); channels = new ChannelStore(db.pool, randomBytes(32)); await channels.init(); store = new CreationStore(db.pool); });
test.beforeEach(async () => {
 // Only the disposable fixture is reset; every test must declare its own models.
 await db.pool.query('TRUNCATE sj_channel_models, sj_creation_defaults, sj_model_channels, sj_creation_audit');
 await channels.insert({id:channelId,name:'Test',baseUrl:'https://provider.example/v1',apiKey:'test-key-not-real'});
});
test.after(async () => { await db?.stop(); });
const json = body => new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json'}});
const insertAnthropicChannel = () => channels.insert({id:'ch_0000000000000003',name:'Anthropic',baseUrl:'https://api.anthropic.com/v1',apiKey:'fake-anthropic-key',adapter:'anthropic'});
const insertH3Channel = () => channels.insert({id:'ch_0000000000000002',name:'H3',baseUrl:'https://cp.compshare.cn',apiKey:'only-fake-test-key',adapter:'minimax-h3',executorConfig:{video:'minimax-h3'}});
test('catalog follows cursor pages and atomically preserves configuration on a failed later page', async () => {
 let fail = false; const seen = [];
 const hub = new ModelHub(store, channels, {transport:async url => { seen.push(String(url)); if (String(url).includes('after=')) { if (fail) throw new Error('network'); return json({data:[{id:'second'}],has_more:false}); } return json({data:[{id:'first'}],has_more:true,last_id:'first'}); }});
 await hub.sync(channelId);
 assert.deepEqual((await hub.catalog()).models.map(m=>m.modelId), ['first','second']);
 assert.equal(seen.length,2);
 fail=true; await assert.rejects(hub.sync(channelId));
 assert.equal((await hub.catalog()).models.filter(m=>m.available).length,2);
});
test('manual capability selections enable compatible defaults and disappearance does not switch them', async () => {
 let rows=[{id:'chat-image-name'}];
 const hub=new ModelHub(store,channels,{transport:async()=>json({data:rows})});
 await hub.sync(channelId);
 await hub.configure(channelId,'chat-image-name',{enabled:true,capabilities:['text','vision']});
 await hub.setDefault('product',channelId,'chat-image-name');
 assert.equal((await hub.resolve('product'))?.modelId,'chat-image-name');
 await assert.rejects(hub.setDefault('image',channelId,'chat-image-name'),{code:'MODEL_INCOMPATIBLE'});
 rows=[];await hub.sync(channelId);
 const result=await hub.catalog();
 assert.equal(result.defaults.product.modelId,'chat-image-name');
 assert.deepEqual(result.models.find(m=>m.modelId==='chat-image-name').capabilities,['text','vision']);
 await assert.rejects(hub.resolve('product'),{code:'MODEL_UNAVAILABLE'});
});
test('encrypted channels retain protocol and executor configuration without exposing secrets', async () => {
 const saved=await insertH3Channel();
 assert.equal(saved.adapter,'minimax-h3');
 assert.deepEqual(saved.executorConfig,{video:'minimax-h3'});
 assert.equal(saved.keyHint,'••••-key');
 assert.equal(JSON.stringify(await channels.list()).includes('only-fake-test-key'),false);
});
test('manual IDs remain available across complete sync and can be reconfigured without inventing capabilities', async () => {
 const hub=new ModelHub(store,channels,{transport:async()=>json({data:[]})});
 await hub.configure(channelId,'manual-hidden',{enabled:true,capabilities:['image']});
 await hub.sync(channelId);
 await hub.setDefault('image',channelId,'manual-hidden');
 assert.equal((await hub.resolve('image')).modelId,'manual-hidden');
 assert.equal((await hub.catalog()).models.find(m=>m.modelId==='manual-hidden').manual,true);
 await hub.configure(channelId,'manual-hidden',{enabled:false});
 await assert.rejects(hub.resolve('image'),{code:'MODEL_DISABLED'});
});
test('Anthropic models retain protocol, key header and every cursor page',async()=>{
 const id='ch_0000000000000003';
 await insertAnthropicChannel();
 const requests=[];const hub=new ModelHub(store,channels,{transport:async(url,options)=>{requests.push({url,options});return json(String(url).includes('after')?{data:[{id:'claude-second',display_name:'Second'}],has_more:false}:{data:[{id:'claude-first'}],has_more:true,last_id:'claude-first'});}});
 await hub.sync(id);
 assert.equal((await hub.catalog()).models.filter(m=>m.channelId===id).length,2);
 assert.equal(requests[0].options.headers['x-api-key'],'fake-anthropic-key');
 assert.equal(requests[0].options.headers.Authorization,undefined);
 assert.equal(requests[1].url.endsWith('after_id=claude-first'),true);
});
test('OpenAI complete sends vision bytes once and returns text with unknown money',async()=>{
 let count=0,request;const hub=new ModelHub(store,channels,{transport:async(url,options)=>{count++;request={url,body:JSON.parse(options.body)};return json({choices:[{message:{content:'商品为蓝色。'}}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}});}});
 await hub.configure(channelId,'vision-explicit',{enabled:true,capabilities:['text','vision']});
 const result=await hub.complete({stage:'product',model:{channelId,modelId:'vision-explicit'},system:'只整理事实',messages:[{role:'user',content:[{type:'text',text:'识别'}, {type:'image',bytes:Buffer.from([137,80,78,71,13,10,26,10]),mime:'image/png'}]}]});
 assert.equal(result.text,'商品为蓝色。');assert.equal(count,1);
 assert.equal(request.body.messages[1].content[1].image_url.url,'data:image/png;base64,iVBORw0KGgo=');
 assert.equal(result.usage.total_tokens,16);assert.equal(result.usage.costMicros,null);
});
test('Anthropic complete sends native content and system and does not retry an interrupted response',async()=>{
 const id='ch_0000000000000003';let request,count=0,broken=false;
 await insertAnthropicChannel();
 const hub=new ModelHub(store,channels,{transport:async(url,options)=>{count++;request={url,body:JSON.parse(options.body)};if(broken)throw new Error('fake-anthropic-key');return json({content:[{type:'text',text:'只有明确事实'}],usage:{input_tokens:20,output_tokens:6}});}});
 await hub.configure(id,'claude-first',{enabled:true,capabilities:['text','vision']});
 const input={stage:'product',model:{channelId:id,modelId:'claude-first'},system:'保留手工字段',messages:[{role:'user',content:[{type:'image',bytes:Buffer.from([137,80,78,71,13,10,26,10])}]}]};
 const result=await hub.complete(input);assert.equal(result.text,'只有明确事实');
 assert.equal(request.url.endsWith('/messages'),true);assert.equal(request.body.system,'保留手工字段');
 assert.equal(request.body.messages[0].content[0].source.media_type,'image/png');
 assert.equal(result.usage.input_tokens,20);
 broken=true;const before=count;await assert.rejects(hub.complete(input),error=>error.code==='PROVIDER_TRANSPORT_UNKNOWN'&&!error.message.includes('fake-anthropic-key'));assert.equal(count,before+1);
});
const png=Buffer.from([137,80,78,71,13,10,26,10]);
test('image generation uses frozen selection and returns server bytes with unknown cost',async()=>{
 let request;const hub=new ModelHub(store,channels,{transport:async(url,options)=>{request={url,body:JSON.parse(options.body)};return json({data:[{b64_json:png.toString('base64')}],usage:{total_tokens:8}});}});
 await hub.configure(channelId,'image-selected',{enabled:true,capabilities:['image']});
 const model=await hub.resolve('image',{channelId,modelId:'image-selected'});
 const result=await hub.submitGeneration({kind:'image',model,prompt:'蓝色背景',params:{size:'1024x1024',quality:'low'},requestKey:'image-request-1'});
 assert.equal(result.status,'succeeded');assert.deepEqual(result.bytes,png);assert.equal(result.mime,'image/png');
 assert.equal(request.url.endsWith('/images/generations'),true);assert.equal(request.body.model,'image-selected');assert.equal(request.body.n,1);assert.equal(result.usage.costMicros,null);
});
test('image edit uploads server bytes through multipart and cannot override frozen model using params',async()=>{
 let request;const hub=new ModelHub(store,channels,{transport:async(url,options)=>{request={url,body:options.body};return json({data:[{b64_json:png.toString('base64')}]});}});
 await hub.configure(channelId,'image-selected',{enabled:true,capabilities:['image']});
 const model=await hub.resolve('image',{channelId,modelId:'image-selected'});
 const result=await hub.submitGeneration({kind:'image',model,prompt:'保留商品',params:{size:'1024x1024',model:'attacker-model'},sourceImage:{bytes:png,mime:'image/png'},requestKey:'edit-request-1'});
 assert.equal(result.status,'succeeded');assert.equal(request.url.endsWith('/images/edits'),true);
 assert.equal(request.body instanceof FormData,true);assert.equal(request.body.get('model'),'image-selected');
 assert.deepEqual(Buffer.from(await request.body.get('image').arrayBuffer()),png);
});
test('OMYAI configured JSON edit uses data URL and result URLs download without provider credentials',async()=>{
 const id='ch_0000000000000004';await channels.insert({id,name:'OMYAI',baseUrl:'https://omyai.vip/v1',apiKey:'test-omyai-not-real',executorConfig:{editTransport:'json-data-url'}});
 const requests=[];const hub=new ModelHub(store,channels,{transport:async(url,options)=>{requests.push({url,options});return String(url).includes('/images/edits')?json({data:[{url:'https://cdn.example.org/result.png'}]}):new Response(png);}});
 await hub.configure(id,'manual-image',{enabled:true,capabilities:['image']});
 const model=await hub.resolve('image',{channelId:id,modelId:'manual-image'});
 const result=await hub.submitGeneration({kind:'image',model,prompt:'换背景',params:{},sourceImage:{bytes:png},requestKey:'json-edit-1'});
 assert.equal(JSON.parse(requests[0].options.body).image,'data:image/png;base64,iVBORw0KGgo=');
 assert.deepEqual(result.bytes,png);assert.equal(requests[1].options.headers,undefined);
});
test('H3 text and first-frame tasks submit poll download and cancel the original upstream ID',async()=>{
 const id='ch_0000000000000002',requests=[];await insertH3Channel();const mp4=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109]);
 const hub=new ModelHub(store,channels,{transport:async(url,options)=>{requests.push({url,options});if(url.includes('cdn.example'))return new Response(mp4);if(options.method==='POST')return json({task_id:'original-task',status:'queued'});if(options.method==='DELETE')return json({task_id:'original-task',status:'running',action:'delete'});return json({task:{id:'original-task',status:'succeeded',content:{url:'https://cdn.example.org/result.mp4'},usage:{total_seconds:5},estimated_remaining_seconds:0}});}});
 await hub.configure(id,'MiniMax-H3',{enabled:true,capabilities:['video']});
 const model=await hub.resolve('video',{channelId:id,modelId:'MiniMax-H3'});
 const snapshot={kind:'video',model,prompt:'商品缓慢旋转',params:{duration:5,resolution:'768P',ratio:'16:9'},sourceImage:{bytes:png,mime:'image/png'},requestKey:'h3-first-frame-1'};
 const submitted=await hub.submitGeneration(snapshot);assert.equal(submitted.upstreamId,'original-task');assert.equal(submitted.status,'queued');
 const body=JSON.parse(requests[0].options.body);assert.equal(body.content[1].role,'first_frame');assert.equal(body.content[1].image_url.url,'data:image/png;base64,iVBORw0KGgo=');assert.equal(requests[0].options.headers['Idempotency-Key'],'h3-first-frame-1');
 const result=await hub.pollGeneration(snapshot,'original-task');assert.equal(result.status,'succeeded');assert.deepEqual(result.bytes,mp4);assert.equal(result.usage.total_seconds,5);assert.equal(result.usage.costMicros,null);assert.equal(requests[1].url,'https://cp.compshare.cn/minimax/v2/query/video_generation/original-task');assert.equal(requests[2].options.headers,undefined);
 const cancelled=await hub.cancelGeneration(snapshot,'original-task');assert.equal(cancelled.status,'running');assert.equal(requests.at(-1).options.method,'DELETE');assert.equal(requests.at(-1).url,'https://cp.compshare.cn/minimax/v2/video_generation/original-task');
 const count=requests.length;assert.equal((await hub.pollGeneration(snapshot,null)).status,'unknown');assert.equal(requests.length,count);
});
test('text-only product default works but image content rejects before any provider call',async()=>{
 let count=0;const hub=new ModelHub(store,channels,{transport:async()=>{count++;return json({choices:[{message:{content:'保存文字事实'}}]});}});
 await hub.configure(channelId,'text-only',{enabled:true,capabilities:['text']});
 await hub.setDefault('product',channelId,'text-only');
 assert.equal((await hub.complete({stage:'product',messages:[{role:'user',content:'蓝色'}]})).text,'保存文字事实');
 const before=count;await assert.rejects(hub.complete({stage:'product',messages:[{role:'user',content:[{type:'image',bytes:png}]}]}),{code:'MODEL_INCOMPATIBLE'});assert.equal(count,before);
});
test('explicit bootstrap persists encrypted channels and preserves later user settings',async()=>{
 const id='ch_0000000000000005';const hub=new ModelHub(store,channels);
 const config={channels:[{id,name:'Bootstrap',baseUrl:'https://bootstrap.example/v1',apiKey:'bootstrap-fake-key',models:[{modelId:'known-model',capabilities:['text'],enabled:true}],defaults:{planning:'known-model'}}]};
 await hub.init(config);assert.equal((await hub.resolve('planning')).modelId,'known-model');
 await hub.configure(id,'known-model',{enabled:false});await hub.init(config);
 assert.equal((await hub.catalog()).models.find(m=>m.channelId===id).enabled,false);
});
test('complete persists successful usage by workspace without retaining prompts or key material',async()=>{
 const hub=new ModelHub(store,channels,{transport:async()=>json({choices:[{message:{content:'done'}}],usage:{prompt_tokens:42,completion_tokens:7}})});
 await hub.configure(channelId,'text-only',{enabled:true,capabilities:['text']});
 const model={channelId,modelId:'text-only'};
 await hub.complete({workspaceId:'workspace-usage',stage:'product',model,messages:[{role:'user',content:'private prompt not in usage'}]});
 const history=await new ModelHub(store,channels).usage('workspace-usage');
 assert.equal(history.length,1);assert.equal(history[0].usage.prompt_tokens,42);assert.equal(history[0].usage.costMicros,null);
 assert.equal(JSON.stringify(history).includes('private prompt not in usage'),false);
 assert.deepEqual(await hub.usage('other-workspace'),[]);
});
import { routes as modelRoutes } from '../server/routes/model-hub.mjs';
async function routeCall(hub,method,path,body,user={role:'admin',workspaceId:'local'},headers) {
 const route=modelRoutes().find(r=>r.method===method&&r.pattern.test(path));
 if(!route)return {status:404};
 let result;await route.handler({ctx:{modelHub:hub,auth:{},user},req:{headers:headers||{'if-match':(await hub.catalog()).etag}},body,match:route.pattern.exec(path),res:{setHeader(){}},reply(_res,status,data){result={status,data};}});return result;
}
test('model-hub public read exposes mask and denies operator configuration writes',async()=>{
 const hub=new ModelHub(store,channels);const read=await routeCall(hub,'GET','/api/model-hub',undefined,{role:'viewer',workspaceId:'local'});
 assert.equal(read.status,200);assert.equal(read.data.channels[0].keyHint.startsWith('••••'),true);
 await assert.rejects(routeCall(hub,'POST','/api/model-hub/defaults',{stage:'image',channelId,modelId:'image-selected'},{role:'operator',workspaceId:'local'}),{code:'FORBIDDEN'});
});
test('admin can save a channel before directory sync and recover a missing model manually',async()=>{
 const hub=new ModelHub(store,channels,{transport:async()=>new Response('unavailable',{status:503})});
 const created=await routeCall(hub,'POST','/api/model-hub/channels',{name:'Saved offline',baseUrl:'https://offline.example.org',apiKey:'offline-fake-key',adapter:'openai-compatible'});
 assert.equal(created.status,201);assert.equal(created.data.channel.keyHint,'••••-key');const id=created.data.channel.id;
 await assert.rejects(routeCall(hub,'POST',`/api/model-hub/channels/${id}/sync`,{}));
 assert.equal((await channels.get(id)).name,'Saved offline');
 const configured=await routeCall(hub,'POST',`/api/model-hub/channels/${id}/models`,{modelId:'manual-private',enabled:true,capabilities:['text']});
 assert.equal(configured.data.model.manual,true);assert.equal(configured.data.model.enabled,true);
});
test('catalog revision prevents stale model configuration and stale channel edits',async()=>{
 const hub=new ModelHub(store,channels);
 const initial=await routeCall(hub,'GET','/api/model-hub');
 await assert.rejects(routeCall(hub,'POST',`/api/model-hub/channels/${channelId}/models`,{modelId:'stale',enabled:true,capabilities:['text']},{role:'admin'},{}),{code:'PRECONDITION_REQUIRED'});
 const headers={'if-match':initial.data.etag};
 await routeCall(hub,'POST',`/api/model-hub/channels/${channelId}/models`,{modelId:'new-revision',enabled:true,capabilities:['text']},{role:'admin'},headers);
 await assert.rejects(routeCall(hub,'POST',`/api/model-hub/channels/${channelId}/models`,{modelId:'stale',enabled:true,capabilities:['text']},{role:'admin'},headers),{code:'REVISION_CONFLICT'});
});
test('channel edits rotate encrypted keys, disable selection and remove without erasing catalog history',async()=>{
 const id='ch_0000000000000006';await channels.insert({id,name:'Editable',baseUrl:'https://edit.example.org/v1',apiKey:'old-fake-key'});
 const hub=new ModelHub(store,channels);await hub.configure(id,'original-model',{enabled:true,capabilities:['image']});
 const edited=await routeCall(hub,'PATCH',`/api/model-hub/channels/${id}`,{name:'Edited',apiKey:'new-fake-key',executorConfig:{editTransport:'json-data-url'},enabled:false});
 assert.equal(edited.status,200);assert.equal(edited.data.channel.name,'Edited');assert.equal(edited.data.channel.enabled,false);
 assert.equal((await channels.getSecret(id)).apiKey,'new-fake-key');
 await assert.rejects(hub.resolve('image',{channelId:id,modelId:'original-model'}),{code:'MODEL_UNAVAILABLE'});
 await routeCall(hub,'DELETE',`/api/model-hub/channels/${id}`);
 assert.equal(await channels.get(id),null);assert.equal((await hub.catalog()).models.find(m=>m.channelId===id).available,true);
});
test('frozen generation protocol and endpoint survive later channel configuration edits',async()=>{
 const id='ch_0000000000000007';await channels.insert({id,name:'Freeze',baseUrl:'https://frozen.example.org/v1',apiKey:'freeze-test-key',executorConfig:{editTransport:'json-data-url'}});
 let request;const hub=new ModelHub(store,channels,{transport:async(url,options)=>{request={url,body:JSON.parse(options.body),headers:options.headers};return json({data:[{b64_json:png.toString('base64')}]});}});
 await hub.configure(id,'frozen-image',{enabled:true,capabilities:['image']});const model=await hub.resolve('image',{channelId:id,modelId:'frozen-image'});
 await channels.update(id,{adapter:'anthropic',executorConfig:{}});
 const result=await hub.submitGeneration({kind:'image',model,prompt:'固定输入',sourceImage:{bytes:png},params:{},requestKey:'frozen-generation'});
 assert.equal(result.status,'succeeded');assert.equal(request.url,'https://frozen.example.org/v1/images/edits');assert.equal(request.headers.Authorization,'Bearer freeze-test-key');assert.equal(request.headers['x-api-key'],undefined);
 assert.equal(request.body.image,'data:image/png;base64,iVBORw0KGgo=');
});
test('concurrent stale configuration writes finish without pool starvation and accept exactly one revision',async()=>{
 const hub=new ModelHub(store,channels),headers={'if-match':(await hub.catalog()).etag};
 const results=await Promise.allSettled(Array.from({length:12},(_,i)=>routeCall(hub,'POST',`/api/model-hub/channels/${channelId}/models`,{modelId:'concurrent-'+i,capabilities:['text']},{role:'admin'},headers)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='REVISION_CONFLICT').length,11);
});
test('invalid H3 duration is rejected locally before a potentially paid request',async()=>{
 let count=0;const hub=new ModelHub(store,channels,{transport:async()=>{count++;return json({task_id:'bad-task',status:'queued'});}});
 await insertH3Channel();
 await hub.configure('ch_0000000000000002','MiniMax-H3',{enabled:true,capabilities:['video']});
 const model=await hub.resolve('video',{channelId:'ch_0000000000000002',modelId:'MiniMax-H3'});
 await assert.rejects(hub.submitGeneration({kind:'video',model,prompt:'text',params:{duration:31},requestKey:'invalid-video'}),{code:'INVALID_VIDEO_PARAMETERS'});
 assert.equal(count,0);
});

test('H3 documented task-id-only creation response becomes queued and strict parameters reject locally',async()=>{
 let count=0;const hub=new ModelHub(store,channels,{transport:async()=>{count++;return json({task_id:'documented-task'});}});
 await insertH3Channel();
 await hub.configure('ch_0000000000000002','MiniMax-H3',{enabled:true,capabilities:['video']});
 const model=await hub.resolve('video',{channelId:'ch_0000000000000002',modelId:'MiniMax-H3'});
 const snapshot={kind:'video',model,prompt:'video',params:{},requestKey:'documented-create'};
 assert.equal((await hub.submitGeneration(snapshot)).status,'queued');
 for(const params of [{resolution:'wrong'},{ratio:'wrong'},{ratio:'adaptive'},{mute_audio:'true'},{skill_id:'skill-123'},{duration:4.5}]) await assert.rejects(hub.submitGeneration({...snapshot,params}),{code:'INVALID_VIDEO_PARAMETERS'});
 assert.equal(count,1);
});

test('explicit monetary usage requires both a safe amount and currency and does not convert provider points',async()=>{
 let usage;const hub=new ModelHub(store,channels,{transport:async()=>json({choices:[{message:{content:'ok'}}],usage})});
 await hub.configure(channelId,'text-only',{enabled:true,capabilities:['text']});
 const input={stage:'product',model:{channelId,modelId:'text-only'},messages:[{role:'user',content:'text'}]};
 usage={costMicros:123,currency:'USD',total_tokens:8};assert.equal((await hub.complete(input)).usage.costMicros,123);
 for(const data of [{costMicros:123},{costMicros:-1,currency:'USD'},{costMicros:0.1,currency:'USD'},{points:200,total_seconds:5}]){usage=data;const result=await hub.complete(input);assert.equal(result.usage.costMicros,null);assert.equal(result.usage.currency,null);}
});

test('oversized video downloads and redirects to private networks reject without resubmitting upstream task',async()=>{
 let mode='size',posts=0,downloads=0;const hub=new ModelHub(store,channels,{transport:async(url,options)=>{
  if(options.method==='POST')posts++;
  if(url.includes('cdn.example')){downloads++;return mode==='size'?new Response('',{headers:{'Content-Length':String(101*1024*1024)}}):new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}
  return json({task:{id:'original-task',status:'succeeded',content:{url:'https://cdn.example.org/output.mp4'}}});
 }});
 await insertH3Channel();
 await hub.configure('ch_0000000000000002','MiniMax-H3',{enabled:true,capabilities:['video']});
 const model=await hub.resolve('video',{channelId:'ch_0000000000000002',modelId:'MiniMax-H3'}),snapshot={kind:'video',model};
 await assert.rejects(hub.pollGeneration(snapshot,'original-task'),{code:'PROVIDER_RESULT_TOO_LARGE'});mode='redirect';
 await assert.rejects(hub.pollGeneration(snapshot,'original-task'),{code:'PROVIDER_URL_BLOCKED'});assert.equal(posts,0);assert.equal(downloads,2);
});

test('oversized inline image rejects before accepting unusable output and paid transport errors never retry',async()=>{
 let count=0,broken=false;const encoded=Buffer.concat([png,Buffer.alloc(10*1024*1024)]).toString('base64');
 const hub=new ModelHub(store,channels,{transport:async()=>{count++;if(broken)throw new Error('private-api-key');return json({data:[{b64_json:encoded}]});}});
 await hub.configure(channelId,'image-selected',{enabled:true,capabilities:['image']});
 const model=await hub.resolve('image',{channelId,modelId:'image-selected'}),snapshot={kind:'image',model,prompt:'image',params:{},requestKey:'single-submit'};
 await assert.rejects(hub.submitGeneration(snapshot),{code:'PROVIDER_RESULT_TOO_LARGE'});broken=true;
 await assert.rejects(hub.submitGeneration({...snapshot,requestKey:'second-manual-request'}),error=>error.code==='PROVIDER_TRANSPORT_UNKNOWN'&&!error.message.includes('private-api-key'));assert.equal(count,2);
 assert.equal((await hub.pollGeneration(snapshot,null)).status,'unknown');assert.equal(count,2);
});
