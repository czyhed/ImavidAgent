import { AppError } from './errors.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// 解析分页参数：缺 limit 时返回 null（兼容旧调用，返回全部）；limit 须为 1–100 的整数，offset 须为非负整数。
export function pageParams(url) {
 const rawLimit=url.searchParams.get('limit'),rawOffset=url.searchParams.get('offset');
 const q=(url.searchParams.get('q')||'').trim().slice(0,100);
 if(rawLimit===null||rawLimit==='') {
  if(rawOffset) throw new AppError('INVALID_PAGINATION','offset 需要和 limit 一起使用。',400);
  return {limit:null,offset:0,q};
 }
 const limit=Number(rawLimit),offset=rawOffset===null||rawOffset===''?0:Number(rawOffset);
 if(!/^\d+$/.test(rawLimit)||limit<1||limit>100) throw new AppError('INVALID_PAGINATION','limit 须为 1–100 的整数。',400);
 if(!Number.isSafeInteger(offset)||offset<0||!/^\d+$/.test(String(rawOffset??'0'))) throw new AppError('INVALID_PAGINATION','offset 须为非负整数。',400);
 return {limit,offset,q};
}
// 批量按编号取：最多 100 个，非法编号直接忽略。
export function idList(url) {
 const raw=url.searchParams.get('ids');
 if(raw===null) return null;
 return [...new Set(raw.split(',').map(x=>x.trim()).filter(x=>UUID.test(x)))].slice(0,100);
}
// 统一响应：保留原键名，附带 total 与 nextOffset（最后一页为 null）。
export function pageBody(key,items,total,{limit,offset}) {
 const nextOffset=limit&&offset+items.length<total?offset+items.length:null;
 return {[key]:items,total,nextOffset};
}
