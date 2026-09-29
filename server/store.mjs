import pg from 'pg';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { Client } from 'minio';
import { AppError } from './errors.mjs';

export function createPool(env = process.env) {
  return new pg.Pool({
    host: env.PGHOST, port: Number(env.PGPORT || 5432), database: env.PGDATABASE,
    user: env.PGUSER, password: env.PGPASSWORD,
    ssl: { ca: readFileSync(env.MIDDLEWARE_CA_CERT), rejectUnauthorized: true },
    max: 5, connectionTimeoutMillis: 10_000,
    keepAlive: true, keepAliveInitialDelayMillis: 10_000,
  });
}

export class JobStore {
  constructor(pool, { audit = null } = {}) {
    this.pool = pool;
    this.audit = audit;
  }

  // 任务状态时间线只追加；写入失败不能反过来改变任务的真实状态。
  async recordJobEvent(job, event, detail = {}) {
    if (!this.audit || !job) return;
    try {
      await this.audit.jobEvent({
        jobId: job.id,
        event,
        upstreamId: job.upstreamId || null,
        detail: {
          modelId: job.input?.modelId ?? null,
          operation: job.input?.operation ?? null,
          errorCode: job.error?.code ?? null,
          ...detail,
        },
      });
    } catch {
      console.error('任务时间线写入失败，任务状态未受影响。');
    }
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sj_generation_jobs (
        id uuid PRIMARY KEY,
        input_hash text NOT NULL,
        input jsonb NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        upstream_id text,
        output jsonb,
        error jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sj_generation_jobs_status_created
      ON sj_generation_jobs (status, created_at);
    `);
  }

  row(row) {
    if (!row) return null;
    return {
      id: row.id, inputHash: row.input_hash, input: row.input, status: row.status,
      upstreamId: row.upstream_id, output: row.output, error: row.error,
      // 归属保存在 input JSONB 中；历史任务没有该字段时视为本地单工作空间。
      workspaceId: row.input?.workspaceId ?? 'local',
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async get(id) {
    return this.row((await this.pool.query('SELECT * FROM sj_generation_jobs WHERE id=$1', [id])).rows[0]);
  }

  async list(workspaceId = null) {
    const result = workspaceId
      ? await this.pool.query(
        `SELECT * FROM sj_generation_jobs
         WHERE COALESCE(input->>'workspaceId', 'local')=$1
         ORDER BY created_at DESC LIMIT 50`,
        [workspaceId],
      )
      : await this.pool.query('SELECT * FROM sj_generation_jobs ORDER BY created_at DESC LIMIT 50');
    return result.rows.map(r => this.row(r));
  }

  async insert(job) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize admission across processes; same request UUID returns the same stored job.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sj:generation-admission'))");
      const existing = this.row((await client.query('SELECT * FROM sj_generation_jobs WHERE id=$1', [job.id])).rows[0]);
      if (existing) {
        if (existing.inputHash !== job.inputHash) throw new AppError('REQUEST_CONFLICT', '同一请求编号不能用于不同参数。', 409);
        await client.query('COMMIT');
        return existing;
      }
      const pending = await client.query("SELECT count(*)::int AS n FROM sj_generation_jobs WHERE status IN ('queued','submitting','running','storing')");
      if (pending.rows[0].n >= 10) throw new AppError('QUEUE_FULL', '队列已满，请等待现有任务完成。', 429);
      const row = await client.query(
        'INSERT INTO sj_generation_jobs (id,input_hash,input) VALUES ($1,$2,$3) RETURNING *',
        [job.id, job.inputHash, job.input],
      );
      await client.query('COMMIT');
      const created = this.row(row.rows[0]);
      await this.recordJobEvent(created, 'queued');
      return created;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async update(id, patch) {
    const columns = { status: 'status', upstreamId: 'upstream_id', output: 'output', error: 'error' };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    const set = entries.map(([key], index) => `${columns[key]}=$${index + 2}`).join(',');
    const result = await this.pool.query(
      `UPDATE sj_generation_jobs SET ${set},updated_at=now() WHERE id=$1 RETURNING *`,
      [id, ...entries.map(([, value]) => value)],
    );
    const updated = this.row(result.rows[0]);
    if (updated && patch.status) await this.recordJobEvent(updated, patch.status);
    return updated;
  }

  async claim() {
    const result = await this.pool.query(`
      UPDATE sj_generation_jobs SET status='submitting',updated_at=now()
      WHERE id=(SELECT id FROM sj_generation_jobs WHERE status='queued'
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *
    `);
    const claimed = this.row(result.rows[0]);
    await this.recordJobEvent(claimed, 'submitting');
    return claimed;
  }

  async recover() {
    // A crash between the upstream accepting a request and saving its ID is ambiguous.
    // Never turn it into a fresh generation automatically.
    const result = await this.pool.query(`
      UPDATE sj_generation_jobs SET status='unknown',
      error='{"code":"SERVER_RESTART","message":"服务已重启，请查询原任务；不会自动重新生成。"}',
      updated_at=now() WHERE status IN ('submitting','running','storing') RETURNING *
    `);
    for (const row of result.rows) {
      await this.recordJobEvent(this.row(row), 'unknown', { reason: 'SERVER_RESTART' });
    }
  }

  async lockWorker() {
    const client = await this.pool.connect();
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext('sj:generation-worker')) AS locked");
    if (!result.rows[0].locked) {
      client.release();
      throw new AppError('WORKER_EXISTS', '已有生图服务正在使用此数据库，请复用现有服务。', 503);
    }
    this.workerLock = client;
  }
}

export function imageType(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', 'png'];
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return ['image/jpeg', 'jpg'];
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  throw new AppError('INVALID_IMAGE', '供应商返回的文件不是受支持的图片。', 502);
}

// MinIO 客户端统一从此处创建：地址必须是 TLS，并使用项目 CA 做校验。
// 资产桶与导出桶复用同一份连接配置，凭据只来自环境变量，不写入代码或日志。
export function createMinioClient(env = process.env) {
  const endpoint = new URL(env.MINIO_ENDPOINT);
  if (endpoint.protocol !== 'https:') throw new AppError('TLS_REQUIRED', 'MinIO 必须使用 TLS。', 500);
  return {
    endpoint,
    client: new Client({
      endPoint: endpoint.hostname, port: Number(endpoint.port || 443), useSSL: true,
      accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY,
      region: env.MINIO_REGION || 'us-east-1',
      transportAgent: new https.Agent({
        ca: readFileSync(env.MIDDLEWARE_CA_CERT), rejectUnauthorized: true,
      }),
    }),
  };
}

export class AssetStore {
  constructor(env = process.env) {
    this.bucket = env.MINIO_BUCKET_ASSETS;
    if (this.bucket !== 'shangjing-assets') throw new AppError('BUCKET_CONFIG', '图片仅允许存入 shangjing-assets。', 500);
    this.client = createMinioClient(env).client;
  }

  async put(id, data) {
    const [contentType, extension] = imageType(data);
    const key = `generation/${id}/result.${extension}`;
    await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': contentType });
    return { key, contentType, bytes: data.length, filename: `${id}.${extension}` };
  }

  get(output) { return this.client.getObject(this.bucket, output.key); }
}
