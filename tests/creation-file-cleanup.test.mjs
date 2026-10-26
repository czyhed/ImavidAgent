import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from 'minio';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deleteLegacyObjects,backupLegacyObjects,verifyLegacyBackup} from '../server/legacy-files.mjs';
const key='generation/00000000-0000-4000-8000-000000000001/result.png';
let server,client,versions,removed;
test.before(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&u.searchParams.has('versions')){
   res.setHeader('Content-Type','application/xml');
   res.end('<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>shangjing-assets</Name><Prefix>'+key+'</Prefix><IsTruncated>false</IsTruncated>'+versions.map(v=>'<'+(v.marker?'DeleteMarker':'Version')+'><Key>'+v.key+'</Key><VersionId>'+v.id+'</VersionId><IsLatest>false</IsLatest><LastModified>2026-10-22T00:00:00Z</LastModified>'+(v.marker?'':'<ETag>fake</ETag><Size>8</Size><StorageClass>STANDARD</StorageClass>')+'</'+(v.marker?'DeleteMarker':'Version')+'>').join('')+'</ListVersionsResult>');return;
  }
  if(req.method==='GET'&&u.searchParams.has('versionId')){res.end('original-file');return;}
  if(req.method==='DELETE'){const id=u.searchParams.get('versionId');removed.push({key:decodeURIComponent(u.pathname.split('/').slice(2).join('/')),id});versions=versions.filter(v=>v.id!==id);res.writeHead(204);res.end();return;}
  res.writeHead(400);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 client=new Client({endPoint:'127.0.0.1',port:server.address().port,useSSL:false,accessKey:'boundary-test',secretKey:'boundary-test-only',region:'us-east-1'});
});
test.after(async()=>{await new Promise(r=>server.close(r));});
test('permanent legacy cleanup deletes exact object versions and delete markers while preserving prefix neighbours',async()=>{
 versions=[{key,id:'old-version'},{key,id:'deleted-marker',marker:true},{key:key+'.keep',id:'unrelated'}];removed=[];
 assert.equal(await deleteLegacyObjects(client,[{bucket:'shangjing-assets',key}]),2);
 assert.deepEqual(removed,[{key,id:'old-version'},{key,id:'deleted-marker'}]);
 assert.deepEqual(versions,[{key:key+'.keep',id:'unrelated'}]);
});
test('legacy file cleanup rejects keys outside the approved old application prefixes before storage calls',async()=>{
 removed=[];
 await assert.rejects(()=>deleteLegacyObjects(client,[{bucket:'shangjing-assets',key:'creation/new/asset.png'}]),{code:'CLEANUP_OWNERSHIP'});
 assert.equal(removed.length,0);
});

test('backup preserves original bytes and detects tampering or new object versions before deletion',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sj-legacy-backup-test-'));
 try{
  versions=[{key,id:'v-original'},{key,id:'marker',marker:true}];
  const objects=[{bucket:'shangjing-assets',key}];
  assert.deepEqual(await backupLegacyObjects(client,objects,directory),{objects:1,versions:2});
  const manifest=await verifyLegacyBackup(client,objects,directory);
  versions.push({key,id:'v-new'});
  await assert.rejects(()=>verifyLegacyBackup(client,objects,directory),{code:'BACKUP_STALE'});
  versions.pop();
  await writeFile(join(directory,manifest.records[0].file),'tampered');
  await assert.rejects(()=>verifyLegacyBackup(client,objects,directory),{code:'BACKUP_CORRUPTED'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
