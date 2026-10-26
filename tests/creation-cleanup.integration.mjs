import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startTestPostgres} from './support/postgres.mjs';
import {previewLegacyCleanup,applyLegacyCleanup} from '../server/legacy-cleanup.mjs';
import {CreationStore} from '../server/creation-store.mjs';
let db;test.before(async()=>{db=await startTestPostgres();});test.after(async()=>{await db?.stop();});
test('explicit legacy cleanup removes only old business tables and preserves current products and templates',async()=>{
 const id=randomUUID();await db.pool.query(`INSERT INTO sj_products(id,name) VALUES($1,'旧测试商品')`,[id]);
 const current=await new CreationStore(db.pool).create('local','product',{name:'新商品'});
 const before=(await db.pool.query('SELECT count(*)::int AS n FROM sj_workflow_templates')).rows[0].n;
 const plan=await previewLegacyCleanup(db.pool);const result=await applyLegacyCleanup(db.pool,plan);
 assert.equal(result.removed,1);
 assert.equal((await new CreationStore(db.pool).get('local',current.id)).name,'新商品');
 assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM sj_workflow_templates')).rows[0].n,before);
 assert.equal((await previewLegacyCleanup(db.pool)).tables.find(t=>t.name==='sj_products').count,0);
});
test('cleanup stops when a saved preview no longer matches records',async()=>{
 const plan=await previewLegacyCleanup(db.pool);
 await db.pool.query(`INSERT INTO sj_products(id,name) VALUES($1,'预览后新增')`,[randomUUID()]);
 await assert.rejects(()=>applyLegacyCleanup(db.pool,plan),{code:'CLEANUP_CHANGED'});
 assert.equal((await previewLegacyCleanup(db.pool)).tables.find(t=>t.name==='sj_products').count,1);
});

test('cleanup rejects edited records even when table counts stay unchanged',async()=>{
 const plan=await previewLegacyCleanup(db.pool);
 await db.pool.query("UPDATE sj_products SET name='预览后修改'");
 await assert.rejects(()=>applyLegacyCleanup(db.pool,plan),{code:'CLEANUP_CHANGED'});
});
