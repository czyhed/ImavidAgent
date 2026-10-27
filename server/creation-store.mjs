import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

const protectedFields = ['id','workspaceId','kind','revision','trashedAt','createdAt','updatedAt'];
const dataOnly = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !protectedFields.includes(key)));
const row = r => r && ({ ...dataOnly(r.body), id:r.id, workspaceId:r.workspace_id, kind:r.kind, revision:r.revision, trashedAt:r.trashed_at, createdAt:r.created_at, updatedAt:r.updated_at });
const referenceFields=new Set(['productId','sourceAssetId','assetId','sourceRunId','runId','evidenceIds','creativeAssetIds','sourceRunIds','maskAssetId','baseAssetId']);
function references(value,key='',result=new Set()) {
 if(referenceFields.has(key))for(const id of Array.isArray(value)?value:[value])if(typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id))result.add(id);
 if(value&&typeof value==='object')for(const [field,child] of Object.entries(value))references(child,field,result);
 return result;
}
// 名称模糊匹配（大小写不敏感，不使用 LIKE，避免通配符转义问题）。
export const nameHas=(expr,add,q)=>`position(lower(${add(q)}) in lower(coalesce(${expr},'')))>0`;
export class CreationStore {
 constructor(pool) { this.pool=pool; }
 async get(workspace,id,client=this.pool) { return row((await client.query('SELECT * FROM sj_creation_records WHERE workspace_id=$1 AND id=$2',[workspace,id])).rows[0]); }
 async list(workspace,kind,trash=false,client=this.pool) { return (await client.query('SELECT * FROM sj_creation_records WHERE workspace_id=$1 AND kind=$2 AND (trashed_at IS NOT NULL)=$3 ORDER BY updated_at DESC,id',[workspace,kind,trash])).rows.map(row); }
 // 列表页只需要少量字段：在 SQL 里投影 JSONB，避免把整份正文（任务、边、聊天记录）读出并传给浏览器。
 async listProjected(workspace,kind,projection,client=this.pool) {
  return (await client.query(`SELECT id,revision,trashed_at,created_at,updated_at,${projection} FROM sj_creation_records WHERE workspace_id=$1 AND kind=$2 AND trashed_at IS NULL ORDER BY updated_at DESC,id`,[workspace,kind])).rows;
 }
 // 分页列表：SQL 里过滤、排序、计数；kinds 可多种（回收站），where(add) 追加条件并登记参数，limit 为 null 时返回全部。
 async page(workspace,{kinds,trash=false,projection='',where=null,order='updated_at DESC,id',limit=null,offset=0},client=this.pool) {
  const params=[workspace,kinds,trash],add=value=>{params.push(value);return '$'+params.length;};
  const conditions=['workspace_id=$1','kind=ANY($2::text[])','(trashed_at IS NOT NULL)=$3'];
  if(where)for(const c of where(add))conditions.push(c);
  const clause=conditions.join(' AND ');
  const total=(await client.query(`SELECT count(*)::int AS n FROM sj_creation_records WHERE ${clause}`,params)).rows[0].n;
  const tail=limit?` LIMIT ${Number(limit)} OFFSET ${Number(offset)}`:'';
  const rows=(await client.query(`SELECT id,workspace_id,kind,revision,body,trashed_at,created_at,updated_at${projection?','+projection:''} FROM sj_creation_records WHERE ${clause} ORDER BY ${order}${tail}`,params)).rows;
  return {rows,total,records:rows.map(row)};
 }
 async create(workspace,kind,body,client=this.pool,id=randomUUID()) {
  if(client!==this.pool){await this.checkReferences(workspace,body,client);return row((await client.query('INSERT INTO sj_creation_records(id,workspace_id,kind,body) VALUES($1,$2,$3,$4) RETURNING *',[id,workspace,kind,dataOnly(body)])).rows[0]);}
  const c=await this.pool.connect();
  try {await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);const record=await this.create(workspace,kind,body,c,id);await c.query('COMMIT');return record;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async checkReferences(workspace,body,c) {
  const ids=[...references(body)];if(!ids.length)return;
  const records=(await c.query('SELECT body FROM sj_creation_records WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspace,ids])).rows;
  if(records.some(record=>record.body.deletionPending))throw new AppError('DELETION_PENDING','引用的资料正在永久删除，请刷新后重新选择。',409);
 }
 // keepRevision：只更新批量生成进度这类记账数据时不递增修订号，避免打断画布的自动保存。
 async change(workspace,id,expected,fn,{keepRevision=false}={}) {
  const c=await this.pool.connect();
  try {
   await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
   const current=await this.get(workspace,id,c);
   if(!current) throw new AppError('NOT_FOUND','记录不存在。',404);
   if(expected!==null && expected!==undefined && Number(expected)!==current.revision) throw new AppError('REVISION_CONFLICT','内容已被更新，请重新加载；当前输入仍保留。',409);
   const body=await fn(current,c);
   if(body===null) { await c.query('COMMIT');return current; }
   if(current.deletionPending&&!body.deletionPending)throw new AppError('DELETION_PENDING','永久删除已开始，不能取消文件清理。',409);
   if(!body.deletionPending)await this.checkReferences(workspace,body,c);
   const next=row((await c.query('UPDATE sj_creation_records SET body=$3,revision=revision+$5,trashed_at=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *',[workspace,id,dataOnly(body),body.trashedAt||null,keepRevision?0:1])).rows[0]);
   await c.query('COMMIT');return next;
  } catch(e) { await c.query('ROLLBACK');throw e; } finally {c.release();}
 }
}
