import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';
import { inspectImage } from './uploads.mjs';

export const MAX_CREATION_UPLOAD = 100 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD = 15 * 1024 * 1024;
export function publicAsset(asset) {
 if(!asset) return asset;
 const {objectKey,workspaceId,...safe}=asset;
 return {...safe,fileUrl:`/api/creation/assets/${asset.id}/file`};
}
export function inspectAudio(bytes) {
 if(bytes.length>=12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WAVE') return {mime:'audio/wav',extension:'wav'};
 if(bytes.length>=12 && bytes.toString('ascii',4,8)==='ftyp' && bytes.toString('ascii',8,12)==='M4A ') return {mime:'audio/mp4',extension:'m4a'};
 if(bytes.length>=3 && bytes.toString('ascii',0,3)==='ID3') return {mime:'audio/mpeg',extension:'mp3'};
 // 无 ID3 头的 MP3：11 位帧同步，且版本 / 层 / 码率 / 采样率字段不是保留值。
 if(bytes.length>=4 && bytes[0]===0xff && (bytes[1]&0xe0)===0xe0 && ((bytes[1]>>3)&3)!==1 && ((bytes[1]>>1)&3)!==0 && (bytes[2]>>4)!==0xf && ((bytes[2]>>2)&3)!==3) return {mime:'audio/mpeg',extension:'mp3'};
 return null;
}
function inspect(bytes,mime) {
 if(!Buffer.isBuffer(bytes)||!bytes.length) throw new AppError('EMPTY_MEDIA','请选择图片、视频或音频文件。',422);
 if(bytes.length>MAX_CREATION_UPLOAD) throw new AppError('MEDIA_TOO_LARGE','文件不能超过 100 MB。',413);
 // 音频：m4a 与 mp4 同为 ftyp 容器，先按品牌识别，避免把 m4a 当成视频。
 const audio=inspectAudio(bytes);
 if(audio){
  if(bytes.length>MAX_AUDIO_UPLOAD) throw new AppError('MEDIA_TOO_LARGE','音频不能超过 15 MB。',413);
  return audio;
 }
 if(bytes.length>=12 && bytes.toString('ascii',4,8)==='ftyp') return {mime:'video/mp4',extension:'mp4'};
 if(bytes.length>=4 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return {mime:'video/webm',extension:'webm'};
 const image=inspectImage(bytes);
 return {mime:image.contentType,extension:image.extension,width:image.width,height:image.height};
}
export class CreationMedia {
 constructor(store,client,{bucket='shangjing-assets',publicOrigin,signingKey}={}) {
  if(bucket!=='shangjing-assets') throw new AppError('PRIVATE_BUCKET_REQUIRED','创作媒体必须使用项目私有素材桶。');
  this.store=store;this.client=client;this.bucket=bucket;this.publicOrigin=publicOrigin;this.signingKey=signingKey;
 }
 async put(workspace,{bytes,mime,name,productId,projectId,taskId,runId,role='creative',baseAssetId,derivedFrom},client) {
  const type=inspect(bytes,mime);
  if(!['evidence','creative','result','mask','voice'].includes(role))throw new AppError('INVALID_ROLE','请选择资料、创作素材、生成结果或蒙版用途。',422);
  if(role==='mask'&&type.mime!=='image/png')throw new AppError('INVALID_MASK','蒙版必须是 PNG 图片。',422);
  if(role==='evidence'&&!type.mime.startsWith('image/'))throw new AppError('INVALID_ATTACHMENT','商品聊天资料只支持图片。',422);
  // Upload without holding the workspace lock or borrowing a pool connection.
  // The caller (drive) holds only a run lock; reuse its client for metadata.
  const id=randomUUID(),objectKey=`creation/${createHash('sha256').update(workspace).digest('hex').slice(0,20)}/${id}.${type.extension}`;
  try {await this.client.putObject(this.bucket,objectKey,bytes,bytes.length,{'Content-Type':type.mime});}
  catch {throw new AppError('MEDIA_WRITE_FAILED','文件保存失败，请重试上传。',503);}
  let c;
  try {
   c=client||await this.store.pool.connect();
   await c.query('BEGIN');
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
   for(const [id,kind] of [[productId,'product'],[projectId,'project']]) if(id){const parent=await this.store.get(workspace,id,c);if(!parent||parent.kind!==kind||(parent.trashedAt&&role!=='result')||parent.deletionPending)throw new AppError('NOT_FOUND','关联记录不存在或已移入回收站。',404);}
   const asset=await this.store.create(workspace,'asset',{name:String(name||`素材.${type.extension}`).split('').filter(char=>char.charCodeAt(0)>31).join('').slice(0,180),mime:type.mime,objectKey,role,productId,projectId,taskId,runId,...(role==='mask'&&baseAssetId?{baseAssetId}:{}),...(derivedFrom&&typeof derivedFrom==='object'?{derivedFrom}:{}),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(type.width?{width:type.width,height:type.height}:{})},c,id);
   await c.query('COMMIT');return asset;
  }catch(error){
   if(c)await c.query('ROLLBACK');
   await this.removeObject(objectKey).catch(()=>{});
   throw error;
  }finally{if(!client)c?.release();}
 }
 async read(workspace,id,client=this.store.pool) {
  const asset=await this.store.get(workspace,id,client);
  if(!asset||asset.kind!=='asset'||asset.deletionPending)throw new AppError('NOT_FOUND','素材不存在。',404);
  try {
   const stream=await this.client.getObject(this.bucket,asset.objectKey);const chunks=[];let length=0;
   for await(const chunk of stream){length+=chunk.length;if(length>MAX_CREATION_UPLOAD)throw new Error('size');chunks.push(chunk);}
   return {bytes:Buffer.concat(chunks),mime:asset.mime,name:asset.name};
  } catch {throw new AppError('MEDIA_READ_FAILED','素材文件暂不可用，记录仍保留。',503);}
 }
 source(workspace,id,client=this.store.pool){return this.read(workspace,id,client);}
 async removeObject(key) {
  const stream=this.client.listObjects(this.bucket,key,true,{IncludeVersion:true});
  const versions=[];for await(const entry of stream)if(entry.name===key)versions.push(entry);
  if(versions.length) for(const entry of versions)await this.client.removeObject(this.bucket,key,entry.versionId?{versionId:entry.versionId}:undefined);
  else await this.client.removeObject(this.bucket,key);
 }
 async remove(workspace,id) {
  const asset=await this.store.get(workspace,id);if(!asset||asset.kind!=='asset')throw new AppError('NOT_FOUND','素材不存在。',404);
  try {await this.removeObject(asset.objectKey);}catch{throw new AppError('MEDIA_DELETE_FAILED','对象版本清理失败，请核对存储权限后重试；记录尚未永久删除。',503);}
 }
 publicUrl(workspace,id) {
  let origin;try {origin=new URL(this.publicOrigin);}catch{throw new AppError('PUBLIC_MEDIA_UNAVAILABLE','首帧外传需要配置可信公开 TLS 媒体地址。',503);}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!this.signingKey||Buffer.byteLength(this.signingKey)<32)throw new AppError('PUBLIC_MEDIA_UNAVAILABLE','首帧外传需要可信公开 TLS 地址和独立签名密钥。',503);
  const expires=Math.floor(Date.now()/1000)+300,signature=this.signature(workspace,id,expires);
  return `${origin.origin}/api/creation/media/${encodeURIComponent(id)}/public?${new URLSearchParams({workspace,expires:String(expires),signature})}`;
 }
 signature(workspace,id,expires){return createHmac('sha256',this.signingKey).update(JSON.stringify([workspace,id,Number(expires)])).digest('hex');}
 verifyPublic(workspace,id,expires,signature) {
  const timestamp=Number(expires),now=Math.floor(Date.now()/1000);
  if(!this.signingKey||!Number.isInteger(timestamp)||timestamp<now||timestamp>now+300||!/^[a-f0-9]{64}$/.test(String(signature)))throw new AppError('INVALID_MEDIA_SIGNATURE','媒体链接无效或已过期。',403);
  const expected=this.signature(workspace,id,timestamp);if(!timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))throw new AppError('INVALID_MEDIA_SIGNATURE','媒体链接无效或已过期。',403);
 }
}
