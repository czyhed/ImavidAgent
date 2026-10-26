import {AppError} from './errors.mjs';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export function assertLegacyObject(object){
 const pattern=object.bucket==='shangjing-assets'?/^(generation\/[0-9a-f-]{36}\/|products\/[0-9a-f-]{36}\/|screenshots\/[0-9a-f-]{36}[.])/:object.bucket==='shangjing-exports'?/^exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//:null;
 if(!pattern||typeof object.key!=='string'||!pattern.test(object.key)||object.key.includes('..'))throw new AppError('CLEANUP_OWNERSHIP','无法确认旧文件归属，已停止清理。',409);
}
export async function deleteLegacyObjects(client,objects){
 for(const object of objects)assertLegacyObject(object);
 let count=0;
 for(const object of objects){
  const versions=await legacyVersions(client,object);
  for(const version of versions){
   await client.removeObject(object.bucket,object.key,{versionId:version.id});count++;
  }
  if((await legacyVersions(client,object)).length)throw new AppError('CLEANUP_INCOMPLETE','旧文件仍存在对象版本，请保留维护窗口并重新检查。',409);
 }
 return count;
}

export async function legacyVersions(client,object){
 assertLegacyObject(object);
 const result=[];
 for await(const entry of client.listObjects(object.bucket,object.key,true,{IncludeVersion:true})){
  if(entry.name!==object.key)continue;
  result.push({id:entry.versionId||'null',marker:entry.isDeleteMarker===true});
 }
 return result;
}

export async function backupLegacyObjects(client,objects,directory){
 for(const object of objects)assertLegacyObject(object);
 await mkdir(directory,{recursive:true,mode:0o700});
 const records=[];
 for(const object of objects){
  const versions=await legacyVersions(client,object);
  for(const version of versions){
   const record={...object,...version};
   if(!version.marker){
    const chunks=[];
    for await(const chunk of await client.getObject(object.bucket,object.key,{versionId:version.id}))chunks.push(chunk);
    const bytes=Buffer.concat(chunks);
    record.file=createHash('sha256').update(JSON.stringify([object.bucket,object.key,version.id])).digest('hex')+'.bin';
    record.sha256=createHash('sha256').update(bytes).digest('hex');record.bytes=bytes.length;
    await writeFile(join(directory,record.file),bytes,{flag:'wx',mode:0o600});
   }
   records.push(record);
  }
 }
 const manifest={objects,records};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
 await verifyLegacyBackup(client,objects,directory);
 return {objects:objects.length,versions:records.length};
}

export async function verifyLegacyBackup(client,objects,directory,{allowMissing=false}={}){
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 if(JSON.stringify(manifest.objects)!==JSON.stringify(objects))throw new AppError('BACKUP_MISMATCH','对象备份与清理清单不一致。',409);
 for(const object of objects){
  assertLegacyObject(object);
  const expected=manifest.records.filter(r=>r.bucket===object.bucket&&r.key===object.key);
  const actual=await legacyVersions(client,object);
  const ids=items=>items.map(v=>JSON.stringify([v.id,v.marker])).sort();
  if(allowMissing?!ids(actual).every(id=>ids(expected).includes(id)):JSON.stringify(ids(expected))!==JSON.stringify(ids(actual)))throw new AppError('BACKUP_STALE','备份后对象版本已变化，停止删除。',409);
  for(const record of expected){
   if(record.marker)continue;
   if(!/^[a-f0-9]{64}\.bin$/.test(record.file))throw new AppError('BACKUP_MISMATCH','备份文件索引无效。',409);
   const bytes=await readFile(join(directory,record.file));
   if(bytes.length!==record.bytes||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new AppError('BACKUP_CORRUPTED','对象备份校验失败，停止删除。',409);
  }
 }
 return manifest;
}
