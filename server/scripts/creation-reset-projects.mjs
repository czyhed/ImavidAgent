// 一次性清理旧创作项目（v3 上线前）：删除项目、运行记录与回收站内容，
// 保留商品、素材、模板、账号、渠道与模型配置。必须先做数据库备份。
import { existsSync } from 'node:fs';
import { createPool, createMinioClient, JobStore } from '../store.mjs';
import { CreationStore } from '../creation-store.mjs';
import { CreationMedia } from '../creation-media.mjs';

if (!process.argv.includes('--yes')) {
 console.error('拒绝执行：请先备份数据库，再追加 --yes。');
 process.exit(1);
}
for (const file of ['.env.middleware.local', '.env.models.local']) if (existsSync(file)) process.loadEnvFile(file);
const pool = createPool();
const store = new CreationStore(pool);
const media = new CreationMedia(store, createMinioClient().client, {});
const client = await pool.connect();
try {
 const count = async table => (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
 const before = { projects: (await client.query("SELECT count(*)::int AS n FROM sj_creation_records WHERE kind='project'")).rows[0].n, runs: await count('sj_creation_runs'), trashed: (await client.query('SELECT count(*)::int AS n FROM sj_creation_records WHERE trashed_at IS NOT NULL')).rows[0].n };
 const trashed = (await client.query('SELECT id,workspace_id,kind,body FROM sj_creation_records WHERE trashed_at IS NOT NULL')).rows;
 for (const row of trashed) {
  if (row.kind !== 'asset') continue;
  try { await media.remove(row.workspace_id, row.id); } catch { /* 记录仍删除；缺失对象不阻断清理 */ }
 }
 await client.query('BEGIN');
 await client.query('DELETE FROM sj_creation_runs');
 await client.query('DELETE FROM sj_creation_records WHERE trashed_at IS NOT NULL');
 await client.query("DELETE FROM sj_creation_records WHERE kind='project'");
 await client.query('COMMIT');
 const after = { projects: (await client.query("SELECT count(*)::int AS n FROM sj_creation_records WHERE kind='project'")).rows[0].n, runs: await count('sj_creation_runs'), products: (await client.query("SELECT count(*)::int AS n FROM sj_creation_records WHERE kind='product'")).rows[0].n, assets: (await client.query("SELECT count(*)::int AS n FROM sj_creation_records WHERE kind='asset'")).rows[0].n, templates: (await client.query("SELECT count(*)::int AS n FROM sj_creation_records WHERE kind='template'")).rows[0].n };
 console.log(JSON.stringify({ before, after }));
} finally { client.release(); await pool.end(); }
