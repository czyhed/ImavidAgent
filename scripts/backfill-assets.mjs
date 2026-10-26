import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPool } from '../server/store.mjs';
import { runMigrations } from '../server/migrate.mjs';
import { AssetIndexService, PgAssetRepository } from '../server/assets-index.mjs';

// 历史素材回填（Issue #4）。只读 sj_generation_jobs，把 succeeded 任务索引为素材：
// - 保留任务原始创建时间（created_at），不把回填时间当生产时间；
// - 幂等：重复运行会命中 (source_type, source_id, version) 唯一约束，不产生重复素材；
// - 单条失败只计数并继续，绝不更新任务状态，更不会把成功任务改成失败。
export async function backfillAssets({ service, fetchPage, batchSize = 100, objectExists } = {}) {
  if (!service || typeof service.indexSucceededJob !== 'function') {
    throw new Error('backfillAssets 需要素材索引服务。');
  }
  if (typeof fetchPage !== 'function') throw new Error('backfillAssets 需要任务分页读取函数。');
  const stats = { scanned: 0, inserted: 0, existing: 0, skipped: 0, failed: 0, unavailable: 0, linked: 0 };
  let after = null;
  for (let page = 0; page < 1_000_000; page++) {
    const jobs = await fetchPage(after, batchSize);
    if (!Array.isArray(jobs) || jobs.length === 0) break;
    for (const job of jobs) {
      stats.scanned += 1;
      try {
        let available = true;
        if (typeof objectExists === 'function') {
          try {
            available = (await objectExists(job)) !== false;
          } catch {
            // 无法确认时保留记录为可用；下载失败仍会再次标记不可用。
            available = true;
          }
        }
        const result = await service.indexSucceededJob(job, { objectAvailable: available });
        if (result.skipped) stats.skipped += 1;
        else if (result.inserted) {
          stats.inserted += 1;
          if (result.asset && result.asset.available === false) stats.unavailable += 1;
        } else stats.existing += 1;
      } catch {
        stats.failed += 1;
      }
    }
    const last = jobs[jobs.length - 1];
    const next = { createdAt: last.createdAt, id: last.id };
    if (after && String(next.createdAt) === String(after.createdAt) && next.id === after.id) break;
    after = next;
    if (jobs.length < batchSize) break;
  }
  stats.linked = await service.relinkChains();
  return stats;
}

async function main() {
  if (existsSync('.env.middleware.local')) process.loadEnvFile('.env.middleware.local');
  const pool = createPool();
  try {
    await runMigrations(pool);
    const service = new AssetIndexService(new PgAssetRepository(pool));
    const fetchPage = async (after, limit) => {
      const params = [];
      let where = "status='succeeded'";
      if (after?.createdAt) {
        params.push(after.createdAt, after.id);
        where += ' AND (created_at, id) > ($1::timestamptz, $2::uuid)';
      }
      params.push(limit);
      const rows = await pool.query(
        `SELECT id, status, input, output, created_at, updated_at
         FROM sj_generation_jobs WHERE ${where}
         ORDER BY created_at, id LIMIT $${params.length}`,
        params,
      );
      return rows.rows.map(row => ({
        id: row.id,
        status: row.status,
        input: row.input,
        output: row.output,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    };
    const stats = await backfillAssets({ service, fetchPage });
    console.log('素材回填完成：'
      + `扫描 ${stats.scanned}，新增 ${stats.inserted}，已存在 ${stats.existing}，`
      + `跳过 ${stats.skipped}，失败 ${stats.failed}，不可用 ${stats.unavailable}，`
      + `链接改图 ${stats.linked}。任务状态未被修改。`);
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  main().catch(error => {
    console.error('素材回填失败：' + (error?.message || '未知错误'));
    process.exit(1);
  });
}
