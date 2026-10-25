import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from 'minio';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationMedia } from '../server/creation-media.mjs';
import { CreationProducts } from '../server/creation-products.mjs';
import { CreationLifecycle } from '../server/creation-lifecycle.mjs';
import { routes as productRoutes } from '../server/routes/creation-products.mjs';
import { routes as assetRoutes } from '../server/routes/creation-assets.mjs';
import { safeError } from '../server/errors.mjs';

export async function startCreationFixture() {
 const db=await startTestPostgres(),store=new CreationStore(db.pool),objects=new Map();
 let providerFails=false;
 const external=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/complete'){
   for await(const chunk of req){};
   if(providerFails){res.writeHead(503);res.end('{}');return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:JSON.stringify({reply:'已整理明确资料。',name:'茶杯',facts:{材质:'陶瓷',容量:'300ml'}}),usage:{costMicros:null,inputTokens:20,outputTokens:15}}));return;
  }
  const key=decodeURIComponent(url.pathname).slice('/shangjing-assets/'.length);
  if(url.searchParams.has('versions')){res.setHeader('Content-Type','application/xml');res.end('<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'+[...objects.keys()].filter(k=>k.startsWith(url.searchParams.get('prefix')||'')).map(k=>`<Version><Key>${k}</Key><VersionId>one</VersionId><IsLatest>true</IsLatest><LastModified>2026-10-22T00:00:00.000Z</LastModified><ETag>etag</ETag><Size>99</Size></Version>`).join('')+'<IsTruncated>false</IsTruncated></ListVersionsResult>');return;}
  if(req.method==='PUT'){const chunks=[];for await(const c of req)chunks.push(c);objects.set(key,Buffer.concat(chunks));res.setHeader('ETag','"d41d8cd98f00b204e9800998ecf8427e"');res.end();return;}
  if(req.method==='DELETE'){objects.delete(key);res.writeHead(204);res.end();return;}
  const data=objects.get(key);if(!data){res.writeHead(404);res.end('<Error><Code>NoSuchKey</Code></Error>');return;}
  res.setHeader('Content-Length',data.length);res.end(req.method==='HEAD'?undefined:data);
 });
 external.listen(0,'127.0.0.1');await once(external,'listening');
 const client=new Client({endPoint:'127.0.0.1',port:external.address().port,useSSL:false,region:'us-east-1',accessKey:'test-external-only',secretKey:'test-external-only'});
 const media=new CreationMedia(store,client,{publicOrigin:'https://media.example.test',signingKey:Buffer.alloc(32,4)});
 const hub={complete:async payload=>{const response=await fetch(`http://127.0.0.1:${external.address().port}/complete`,{method:'POST',body:JSON.stringify(payload)});if(!response.ok)throw new Error('External unavailable');return response.json();}};
 const products=new CreationProducts(store,{hub,media}),lifecycle=new CreationLifecycle(store,{media});
 const routes=[...productRoutes(),...assetRoutes()],csrf=randomUUID();
 const handler=async(req,res)=>{
  const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/api/'))return false;
  const role=/role=(admin|operator|viewer)/.exec(req.headers.cookie||'')?.[1]||'admin';
  const ctx={auth:{},user:{id:'test-'+role,role,workspaceId:'test-shop'},creationProducts:products,creationMedia:media,creationLifecycle:lifecycle};
  const reply=(response,status,result)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(result));};
  try{
   if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==csrf){reply(res,403,{error:{code:'TOKEN_REQUIRED',message:'需要会话令牌。'}});return true;}
   let body;if(['POST','PATCH'].includes(req.method)){const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);body=url.pathname.endsWith('/upload')?bytes:JSON.parse(bytes.toString()||'{}');}
   for(const route of routes){const match=route.pattern.exec(url.pathname);if(route.method===req.method&&match){await route.handler({ctx,req,res,url,match,body,reply});return true;}}
   reply(res,404,{error:{code:'NOT_FOUND',message:'接口不存在。'}});
  }catch(error){reply(res,error.status||500,{error:safeError(error)});}
  return true;
 };
 return {db,store,media,products,lifecycle,csrf,handler,objects,setProviderFailure:value=>{providerFails=value;},stop:async()=>{external.closeAllConnections();await new Promise(resolve=>external.close(resolve));await db.stop();}};
}
