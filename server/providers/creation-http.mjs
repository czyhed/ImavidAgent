import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from '../errors.mjs';
import { assertSafeHttpUrl, createSafeLookup } from '../link-parse.mjs';

const agent = new Agent({ connect: { lookup: createSafeLookup() } });
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export function validateUrl(value, { local = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('PROVIDER_URL_BLOCKED','供应商地址无效。',422); }
  if (local && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && !url.username && !url.password) return url;
  try { assertSafeHttpUrl(url.href); } catch { throw new AppError('PROVIDER_URL_BLOCKED','已阻止非公网供应商地址。',422); }
  if (url.protocol !== 'https:') throw new AppError('PROVIDER_URL_BLOCKED','外链必须使用 HTTPS。',422);
  return url;
}
export async function secureTransport(url, options = {}) {
  const target = validateUrl(String(url), {local:options.providerLocal === true});
  // Only explicitly configured loopback API endpoints may bypass public-address DNS.
  return undiciFetch(target, {...options, dispatcher: target.protocol === 'http:' ? undefined : agent});
}
export async function boundedBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new AppError('PROVIDER_RESULT_TOO_LARGE','供应商响应超过体积限制。',502); }
  const chunks=[]; let size=0;
  if (response.body) for await (const chunk of response.body) { size+=chunk.length; if (size>maximum) { throw new AppError('PROVIDER_RESULT_TOO_LARGE','供应商响应超过体积限制。',502); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export async function requestJson(transport, channel, path, {method='GET', body, headers={}} = {}) {
  const url = validateUrl(channel.baseUrl.replace(/\/$/,'') + path,{local:true});
  const anthropic = channel.adapter === 'anthropic';
  const auth = anthropic ? {'x-api-key':channel.apiKey,'anthropic-version':'2023-06-01'} : {Authorization:'Bearer '+channel.apiKey};
  let response;
  try { response=await transport(url.href, {method,headers:{...auth,Accept:'application/json',...(body===undefined || body instanceof FormData ? {} : {'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(120000),providerLocal:true}); }
  catch { throw new AppError('PROVIDER_TRANSPORT_UNKNOWN','供应商响应未确认；请恢复原任务，不会自动重新提交。',502); }
  if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status>=500?'PROVIDER_TRANSPORT_UNKNOWN':'PROVIDER_REJECTED','供应商请求未成功，请检查渠道或原任务状态。',502); }
  try { return JSON.parse((await boundedBytes(response,32*1024*1024)).toString('utf8')); } catch(error) { if(error instanceof AppError) throw error; throw new AppError('PROVIDER_RESPONSE_INVALID','供应商响应无效。',502); }
}
export async function discoverModels(transport, channel) {
  const models=new Map(); const cursors=new Set(); let cursor;
  for(let page=0;page<1000;page++) {
    const suffix=cursor?'?'+(channel.adapter==='anthropic'?'after_id':'after')+'='+encodeURIComponent(cursor):'';
    const data=await requestJson(transport,channel,'/models'+suffix);
    if(!Array.isArray(data.data) || data.data.some(m=>typeof m.id!=='string'||!m.id.trim()||m.id.length>200)) throw new AppError('CATALOG_INVALID','模型目录格式无效，保留原配置。',502);
    for(const model of data.data) models.set(model.id,{id:model.id,name:String(model.display_name||model.name||model.id).slice(0,300)});
    if(!data.has_more) return [...models.values()];
    cursor=data.last_id||data.data.at(-1)?.id;
    if(!cursor||cursors.has(cursor)) throw new AppError('CATALOG_INVALID','模型目录分页没有推进，保留原配置。',502);
    cursors.add(cursor);
  }
  throw new AppError('CATALOG_LIMIT','模型目录页数超过限制，保留原配置。',502);
}
export async function downloadMedia(transport,url,kind) {
  for(let hops=0;hops<=3;hops++) {
    const target=validateUrl(url);
    let response;
    try { response=await transport(target.href,{redirect:'manual',signal:AbortSignal.timeout(120000)}); } catch { throw new AppError('RESULT_DOWNLOAD_FAILED','结果下载失败，请恢复原任务。',502); }
    if([301,302,303,307,308].includes(response.status)) {const location=response.headers.get('location');await response.body?.cancel();if(!location)break;url=new URL(location,target).href;continue;}
    if(!response.ok) {await response.body?.cancel();throw new AppError('RESULT_DOWNLOAD_FAILED','结果下载失败，请恢复原任务。',502);}
    const bytes=await boundedBytes(response,kind==='video'?MAX_VIDEO_BYTES:MAX_IMAGE_BYTES);
    const mime=mediaMime(bytes,kind);
    return {bytes,mime};
  }
  throw new AppError('RESULT_REDIRECT_LIMIT','结果下载跳转过多。',502);
}
export function mediaMime(bytes,kind='image') {
  let mime;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
  else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')mime='image/webp';
  else if(bytes.toString('ascii',4,8)==='ftyp')mime='video/mp4';
  if(!mime || !mime.startsWith(kind+'/')) throw new AppError('INVALID_MEDIA','供应商未返回有效的图片或 MP4 字节。',502);
  return mime;
}
export function sourceData(source, maximum=MAX_IMAGE_BYTES) {
  const bytes=source?.bytes && Buffer.from(source.bytes);
  if(!bytes?.length || bytes.length>maximum) throw new AppError('INVALID_SOURCE_IMAGE','来源图片缺失或超过体积限制。',422);
  const mime=mediaMime(bytes);
  return {bytes,mime,dataUrl:'data:'+mime+';base64,'+bytes.toString('base64')};
}
export function usageRecord(raw) {
  // Provider points/tokens are usage, never a monetary amount.
  const metrics={};
  if(raw&&typeof raw==='object') for(const [key,value] of Object.entries(raw)) if(/^[a-z_]+$/.test(key)&&(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))) metrics[key]=value;
  // Optional normalized monetary extension: both fields must be explicit.
  const known=Number.isSafeInteger(raw?.costMicros)&&raw.costMicros>=0&&typeof raw.currency==='string'&&/^[A-Z]{3}$/.test(raw.currency);
  return {...metrics,costMicros:known?raw.costMicros:null,currency:known?raw.currency:null};
}
