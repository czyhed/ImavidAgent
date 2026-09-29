import { readdir, readFile } from 'node:fs/promises';

// Each migration is a numbered .sql file applied once, in filename order, inside a transaction.
const LOCK = 727_272;

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS sj_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = new URL('./migrations/', import.meta.url);
    let files = [];
    try { files = (await readdir(dir)).filter(f => /^\d+.*\.sql$/.test(f)).sort(); } catch { return; }
    for (const name of files) {
      const { rowCount } = await client.query('SELECT 1 FROM sj_schema_migrations WHERE name = $1', [name]);
      if (rowCount) continue;
      const sql = await readFile(new URL(name, dir), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO sj_schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`迁移已应用：${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
}
