import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {startCreationFixture} from './creation-products-support.mjs';
import {ChannelStore} from '../server/channels.mjs';
import {ModelHub} from '../server/model-hub.mjs';
import {CreationProducts} from '../server/creation-products.mjs';
import {CreationProjects} from '../server/creation-projects.mjs';
import {createServer} from '../server/http.mjs';
export function fixturePng(){
 const chunk=(type,data)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);};
 const h=Buffer.alloc(13);h.writeUInt32BE(64,0);h.writeUInt32BE(64,4);h[8]=8;h[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(64*(64*3+1),160))),chunk('IEND',Buffer.alloc(0))]);
}
// 假语音服务与假 ffmpeg：测试不依赖真实火山接口，也不依赖本机 ffmpeg。
export const VOICE_ORIGIN='https://openspeech.bytedance.com';
export function fakeAudioRunner(){
 const state={joins:[],mixes:[],durationSec:3.2,failMix:false,truncated:false,lineDurations:null};
 return {state,async join(lines){state.joins.push(lines.length);return {bytes:Buffer.concat([Buffer.from('ID3'),...lines]),durationSec:state.durationSec,lineDurations:state.lineDurations?state.lineDurations.slice(0,lines.length):undefined};},async mix({video,audio}){state.mixes.push({video:video.length,audio:audio.length});if(state.failMix)throw new Error('mix failed');return {bytes:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypmp42'),Buffer.from('dub'),Buffer.alloc(12)]),truncated:state.truncated,videoSeconds:5,audioSeconds:state.durationSec};}};
}
export async function startCreationApp({autoTick=true}={}){
 const storage=await startCreationFixture();
 let provider,server,timer;
 const calls=[],audioRunner=fakeAudioRunner(),voiceCalls=[],state={skills:null,balance:null,taskStatus:'succeeded',taskError:null,voiceFail:null,designRemaining:12,designStatus:2,subtitles:true},png=fixturePng(),video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypmp42'),Buffer.alloc(12)]);
 const reply=(res,body)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
 try{
  provider=http.createServer(async(req,res)=>{
   const chunks=[];for await(const c of req)chunks.push(c);
   const raw=Buffer.concat(chunks),body=String(req.headers['content-type']).includes('application/json')?JSON.parse(raw.toString()||'{}'):null;
   calls.push({path:req.url,method:req.method,body});
   if(req.url.endsWith('/models'))return reply(res,{data:[{id:'explicit-text'},{id:'explicit-image'}]});
   if(req.url.endsWith('/chat/completions')){
    const planning=body.messages[0]?.content?.includes('规划助手');
    const text=planning?JSON.stringify({additions:[{kind:'image',title:'背景补图',prompt:'绿色森林光影',subject:'concept',params:{}}],updates:[]}):JSON.stringify({reply:'已整理商品明确资料。',name:'茶杯',facts:{材质:'陶瓷',容量:'300ml'}});
    return reply(res,{choices:[{message:{content:text}}],usage:{prompt_tokens:25,completion_tokens:20}});
   }
   if(req.url.includes('/images/'))return reply(res,{data:[{b64_json:png.toString('base64')}],usage:{images:1}});
   if(req.url.includes('/minimax/v2/skills')&&state.skills)return reply(res,{items:state.skills,total:state.skills.length});
   if(req.url.endsWith('/point_usage_summary')&&state.balance)return reply(res,state.balance);
   if(req.url.endsWith('/minimax/v2/video_generation'))return reply(res,{task_id:'fixture-h3-'+calls.length,status:'queued'});
   if(req.method==='DELETE')return reply(res,{task:{id:req.url.split('/').at(-1),status:'cancelled'}});
   if(req.url.includes('/minimax/v2/query/'))return reply(res,{task:{id:req.url.split('/').at(-1),status:state.taskStatus,...(state.taskError?{error:{message:state.taskError}}:{}),content:{url:'https://creation-result.example/result.mp4'},usage:{total_seconds:5}}});
   if(req.url==='/result.mp4'){res.setHeader('Content-Type','video/mp4');res.end(video);return;}
   res.writeHead(404);res.end();
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const providerOrigin='http://127.0.0.1:'+provider.address().port;
  const channels=new ChannelStore(storage.db.pool,randomBytes(32));await channels.init();
  const voiceTransport=async(url,options)=>{
   const u=new URL(url);
   if(u.origin===VOICE_ORIGIN&&u.pathname==='/api/v3/tts/unidirectional'){
    const body=JSON.parse(options.body);voiceCalls.push({path:u.pathname,headers:options.headers,body});
    if(state.voiceFail)return new Response(JSON.stringify({code:state.voiceFail,message:'x'}),{status:200});
    const text=body.req_params.text,half=Math.ceil(text.length/2);
    const piece=(s)=>JSON.stringify({code:0,message:'',data:Buffer.from('ID3'+s).toString('base64')});
    // enable_subtitle 开启时按字返回时间戳（每字 0.2 秒，从 0.1 秒开始），单位为秒，与火山文档示例一致。
    const subtitle=body.req_params.audio_params.enable_subtitle&&state.subtitles?JSON.stringify({code:0,message:'',data:null,sentence:{text,words:[...text].map((word,i)=>({confidence:0.9,startTime:Math.round((0.1+i*0.2)*1000)/1000,endTime:Math.round((0.3+i*0.2)*1000)/1000,word}))}}):'';
    return new Response(piece(text.slice(0,half))+'\n'+subtitle+'\n'+piece(text.slice(half))+JSON.stringify({code:20000000,message:'ok',data:null,usage:{text_words:[...text].length}}),{status:200,headers:{'x-tt-logid':'fixture-log'}});
   }
   if(u.origin===VOICE_ORIGIN&&u.pathname==='/api/v3/tts/voice_design'){
    const body=JSON.parse(options.body);voiceCalls.push({path:u.pathname,headers:options.headers,body});
    if(state.designRemaining<=0)return new Response(JSON.stringify({code:45001123,message:'exhausted'}),{status:200});
    state.designRemaining-=1;
    return new Response(JSON.stringify({status:state.designStatus,demo_audio:'https://demo.voice.example/demo.mp3',available_training_times:state.designRemaining,speaker_id:body.speaker_id,language:0}),{status:200});
   }
   if(url==='https://demo.voice.example/demo.mp3')return new Response(Buffer.from('ID3demo'),{status:200});
   return fetch(url==='https://creation-result.example/result.mp4'?providerOrigin+'/result.mp4':url,options);
  };
  const hub=new ModelHub(storage.store,channels,{transport:voiceTransport});
  await hub.init({channels:[{id:'ch_0000000000000001',name:'HTTP protocol fixture',baseUrl:providerOrigin,apiKey:'fixture-not-a-live-key',models:[{modelId:'explicit-text',capabilities:['text','vision'],enabled:true},{modelId:'explicit-image',capabilities:['image'],enabled:true}],defaults:{product:'explicit-text',planning:'explicit-text',image:'explicit-image'}},{id:'ch_0000000000000002',name:'H3 HTTP fixture',adapter:'minimax-h3',baseUrl:providerOrigin+'/video',apiKey:'fixture-not-live-h3',models:[{modelId:'MiniMax-H3',capabilities:['video'],enabled:true}],defaults:{video:'MiniMax-H3'}}]});
  const products=new CreationProducts(storage.store,{hub,media:storage.media}),projects=new CreationProjects(storage.store,{hub,media:storage.media,audioRunner});
  await storage.lifecycle.initSeed('local');
  server=createServer({pool:storage.db.pool,creationStore:storage.store,creationProducts:products,creationProjects:projects,creationLifecycle:storage.lifecycle,creationMedia:storage.media,modelHub:hub,root:new URL('../',import.meta.url)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const session=await(await fetch(origin+'/api/session')).json();
  const api=async(path,body,method)=>{
   const response=await fetch(origin+path,{method:method||(body===undefined?'GET':'POST'),headers:body===undefined?{'X-CSRF-Token':session.csrfToken}:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:body===undefined?undefined:JSON.stringify(body)});
   const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message),{code:result.error?.code,status:response.status});return result;
  };
  if(autoTick)timer=setInterval(()=>projects.tick().catch(()=>{}),100);
  return {state,voiceCalls,audioRunner,origin,api,store:storage.store,db:storage.db,hub,projects,products,media:storage.media,calls,png,csrf:session.csrfToken,stop:async()=>{clearInterval(timer);server.closeAllConnections();await new Promise(r=>server.close(r));provider.closeAllConnections();await new Promise(r=>provider.close(r));await storage.stop();}};
 }catch(error){clearInterval(timer);server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));provider?.closeAllConnections();if(provider)await new Promise(r=>provider.close(r));await storage.stop();throw error;}
}
