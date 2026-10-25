import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// The hub port crosses an HTTP boundary in this fixture; production hub protocol
// integration is separately exercised with the real ModelHub after integration.
export async function generationBoundary(store,{status='succeeded',failMediaWrites=0}={}) {
 const requests=[];let currentStatus=status;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
  requests.push({method:req.method,url:req.url,body});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/catalog')res.end(JSON.stringify({channelId:'fixture',modelId:'image-v1',capabilities:['image','video']}));
  else if(req.url==='/plan')res.end(JSON.stringify({text:JSON.stringify({additions:[{kind:'image',title:'推荐背景',prompt:'森林光影',subject:'concept',params:{}}],updates:[]}),usage:{tokens:30}}));
  else res.end(JSON.stringify({status:req.url.endsWith('/cancel')?'cancelled':currentStatus,upstreamId:'upstream-fixed',bytes:Buffer.from('fixture-image').toString('base64'),mime:'image/png',usage:{inputTokens:12,actualCost:null,currency:'USD'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,body)=>{const result=await(await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})).json();if(result.bytes)result.bytes=Buffer.from(result.bytes,'base64');return result;};
 const hub={resolve:()=>call('/catalog'),complete:body=>call('/plan',body),submitGeneration:body=>call('/generate',body),pollGeneration:(body,id)=>call(`/generate/${id}`,body),cancelGeneration:(body,id)=>call(`/generate/${id}/cancel`,body)};
 const media={
  async put(workspace,body){if(failMediaWrites-->0)throw new Error('simulated object storage outage');return store.create(workspace,'asset',{...body,bytes:undefined,data:body.bytes.toString('base64'),objectKey:randomUUID()});},
  async read(workspace,id){const asset=await store.get(workspace,id);return {bytes:Buffer.from(asset.data,'base64'),mime:asset.mime,name:asset.name};},
  async source(workspace,id){return this.read(workspace,id);},
 };
 return {hub,media,requests,setStatus:value=>{currentStatus=value;},stop:()=>new Promise(resolve=>server.close(resolve))};
}
