import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { JobStore } from '../../server/store.mjs';
import { runMigrations } from '../../server/migrate.mjs';

const exec = promisify(execFile);
// Deliberately accepts no connection URL: integration tests can only use their own
// disposable loopback container, never a developer's configured/shared database.
export async function startTestPostgres() {
  const name = `sj-test-pg-${randomUUID()}`;
  const password = randomBytes(32).toString('hex');
  let pool;
  let started = false;
  const stop = async () => {
    await pool?.end();
    if (started) await exec('docker', ['rm', '-f', name]);
  };
  try {
    await exec('docker', ['run', '--detach', '--name', name,
      '--label', 'sj.disposable-test=true', '--publish', '127.0.0.1::5432',
      '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_PASSWORD',
      'postgres:17.11-alpine'], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    started = true;
    const { stdout } = await exec('docker', ['port', name, '5432/tcp']);
    const port = Number(stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1]);
    if (!port) throw new Error('Test database did not bind a loopback port.');
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password,
      database: 'postgres', max: 8, connectionTimeoutMillis: 1000,
      options: '-c statement_timeout=10000 -c lock_timeout=5000' });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await pool.query('SELECT 1'); ready = true; break; }
      catch { await setTimeout(250); }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
    await new JobStore(pool).init();
    await runMigrations(pool);
    return { pool, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
