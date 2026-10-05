import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

// 素材全量索引（Issue #4）。领域逻辑在这里，持久化由仓储负责：
// - PgAssetRepository 用于真实 PostgreSQL；
// - 测试使用同契约的内存仓储，不访问数据库或 MinIO。
// 收录规则：只有 succeeded 且 output.key 存在的任务才是素材；索引失败不能反过来改任务状态。
export const DEFAULT_WORKSPACE_ID = 'local';
export const ASSET_SOURCES = Object.freeze(['generation', 'edit', 'project', 'template']);
export const OUTPUT_SOURCES = Object.freeze(['generation', 'edit', 'project']);
export const TEMPLATE_SOURCE = 'template';
export const MEDIA_TYPES = Object.freeze(['image', 'video']);
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;
const MAX_CHAIN_PASSES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isoOr(value, fallback = new Date()) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  const date = value === undefined || value === null || value === '' ? fallback : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function listParam(value, allowed, label) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw new AppError('INVALID_FILTER', `${label}筛选值不正确。`);
  const values = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
  for (const item of values) {
    if (!allowed.includes(item)) throw new AppError('INVALID_FILTER', `${label}筛选值不受支持。`);
  }
  return values;
}

function intParam(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError('INVALID_PAGINATION', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return number;
}

function dateParam(value, label, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError('INVALID_FILTER', `${label}格式不正确。`);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  let time = Date.parse(value);
  if (!Number.isFinite(time)) throw new AppError('INVALID_FILTER', `${label}格式不正确。`);
  // 只给日期时，结束时间覆盖当天全天；统一转成包含毫秒的 ISO 字符串供仓储比较。
  if (dateOnly && endOfDay) time += 86_400_000 - 1;
  return new Date(time).toISOString();
}

function assertAssetId(value) {
  const id = String(value || '');
  if (!UUID.test(id)) throw new AppError('ASSET_NOT_FOUND', '素材不存在。', 404);
  return id;
}

// 游标只承载排序键（创建时间 + id），不承载偏移量；新增记录不会让后续页重复。
export function encodeCursor(cursor) {
  if (!cursor) return null;
  const payload = { v: 1, t: String(cursor.createdAt), i: String(cursor.id) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw new AppError('INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
  }
  if (!payload || payload.v !== 1 || typeof payload.t !== 'string' || !UUID.test(String(payload.i || ''))
      || !Number.isFinite(Date.parse(payload.t))) {
    throw new AppError('INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
  }
  return { createdAt: payload.t, id: payload.i };
}

export function normalizeAssetQuery(query = {}) {
  const raw = query.q ?? query.search ?? '';
  if (raw !== undefined && typeof raw !== 'string') throw new AppError('INVALID_SEARCH', '搜索词必须是文本。');
  const q = raw.trim();
  if (q.length > 200) throw new AppError('INVALID_SEARCH', '搜索词不能超过 200 个字符。');
  const mediaTypes = listParam(query.type ?? query.mediaType, MEDIA_TYPES, '素材类型');
  const sources = listParam(query.source, ASSET_SOURCES, '素材来源');
  const from = dateParam(query.from, '起始时间');
  const to = dateParam(query.to, '结束时间', { endOfDay: true });
  if (from && to && from > to) throw new AppError('INVALID_FILTER', '起始时间不能晚于结束时间。');
  return {
    q,
    mediaTypes,
    sources,
    from,
    to,
    limit: intParam(query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, '每页数量'),
    cursor: decodeCursor(query.cursor),
  };
}

function mediaTypeFromContentType(contentType) {
  return String(contentType || '').startsWith('video/') ? 'video' : 'image';
}

// 一个成功的生成任务/改图任务对应一条素材。失败、排队、未知、转存中都不是产出。
export function assetFromJob(job, { now = () => new Date() } = {}) {
  if (!job || !job.id || job.status !== 'succeeded') return null;
  const output = job.output;
  if (!output || typeof output.key !== 'string' || !output.key) return null;
  const input = job.input && typeof job.input === 'object' ? job.input : {};
  const operation = input.operation === 'edit' ? 'edit' : 'generation';
  const contentType = output.contentType || 'application/octet-stream';
  const prompt = typeof input.prompt === 'string' ? input.prompt : null;
  const createdAt = isoOr(job.createdAt, now());
  return {
    id: randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    sourceType: operation,
    sourceId: String(job.id),
    // 任务素材的来源版本固定为 1；版本链位置用 chainPosition 表示，不在回调重复时变化。
    version: 1,
    chainPosition: 1,
    mediaType: mediaTypeFromContentType(contentType),
    title: prompt ? prompt.slice(0, 80) : null,
    prompt,
    modelId: input.modelId || null,
    providerId: input.providerId || null,
    operation,
    parameters: {
      size: input.size ?? null,
      quality: input.quality ?? null,
      sourceJobId: input.sourceJobId ?? null,
    },
    contentType,
    objectKey: output.key,
    filename: output.filename || null,
    bytes: Number.isFinite(Number(output.bytes)) ? Number(output.bytes) : null,
    fileAvailable: true,
    missingReason: null,
    rootId: null,
    parentId: null,
    createdAt,
    indexedAt: now(),
    updatedAt: now(),
  };
}

export function publicAsset(row) {
  if (!row) return null;
  const parameters = row.parameters && typeof row.parameters === 'object' ? row.parameters : {};
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    version: row.chainPosition ?? 1,
    sourceVersion: row.version ?? 1,
    mediaType: row.mediaType,
    title: row.title ?? null,
    prompt: row.prompt ?? null,
    modelId: row.modelId ?? null,
    providerId: row.providerId ?? null,
    operation: row.operation ?? null,
    size: parameters.size ?? null,
    quality: parameters.quality ?? null,
    sourceJobId: parameters.sourceJobId ?? null,
    contentType: row.contentType,
    filename: row.filename ?? null,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    available: row.fileAvailable !== false,
    missingReason: row.missingReason ?? null,
    rootId: row.rootId ?? null,
    parentId: row.parentId ?? null,
    createdAt: toIso(row.createdAt),
    indexedAt: toIso(row.indexedAt),
    updatedAt: toIso(row.updatedAt),
    imageUrl: `/api/assets/${row.id}/image`,
    downloadUrl: `/api/assets/${row.id}/download`,
  };
}

function emptySummary() {
  return { total: 0, available: 0, unavailable: 0, bytes: 0 };
}

function summarize(rows) {
  const summary = { outputs: emptySummary(), templates: emptySummary() };
  for (const row of rows) {
    const bucket = row.sourceType === TEMPLATE_SOURCE ? summary.templates : summary.outputs;
    bucket.total += 1;
    if (row.fileAvailable === false) bucket.unavailable += 1;
    else {
      bucket.available += 1;
      bucket.bytes += Number(row.bytes) || 0;
    }
  }
  return summary;
}

export class AssetIndexService {
  constructor(repository, { workspaceId = DEFAULT_WORKSPACE_ID, now = () => new Date() } = {}) {
    this.repository = repository;
    this.workspaceId = workspaceId;
    this.now = now;
    this.scopes = new Map();
  }

  // 生产注入的是默认工作空间的实例；任务成功索引与列表都要按任务 / 会话的工作空间派生，
  // 否则登录后所有工作空间共用一批素材记录。测试用的内存仓储没有 pool，返回自身。
  forWorkspace(workspaceId) {
    if (!workspaceId || workspaceId === this.workspaceId || !this.repository?.pool) return this;
    let scoped = this.scopes.get(workspaceId);
    if (!scoped) {
      scoped = new AssetIndexService(
        new PgAssetRepository(this.repository.pool, { workspaceId }),
        { workspaceId, now: this.now },
      );
      scoped.scopes = this.scopes;
      this.scopes.set(workspaceId, scoped);
    }
    return scoped;
  }

  // 幂等写入；同一任务被供应商回调多次也只保留一行。索引异常由调用方决定是否吞掉，
  // 生图链路永远不能因为索引失败把 succeeded 任务改成 failed。
  async indexSucceededJob(job, { objectAvailable = true } = {}) {
    const asset = assetFromJob(job, { now: this.now });
    if (!asset) return { skipped: true, inserted: false, asset: null };
    asset.workspaceId = this.workspaceId;
    if (objectAvailable === false) {
      asset.fileAvailable = false;
      asset.missingReason = '索引时未在对象存储中找到文件';
    }
    let parent = null;
    if (asset.sourceType === 'edit' && asset.parameters.sourceJobId) {
      parent = await this.repository.findBySource(asset.parameters.sourceJobId);
    }
    if (parent) {
      asset.parentId = parent.id;
      asset.rootId = parent.rootId || parent.id;
      asset.chainPosition = (parent.chainPosition || 1) + 1;
    } else {
      // 根素材引用自身；父素材尚未索引时先作为孤链，回填脚本会再链接。
      asset.rootId = asset.id;
    }
    const saved = await this.repository.insert(asset);
    return { skipped: false, inserted: saved.inserted, asset: publicAsset(saved.asset) };
  }

  async list(query = {}) {
    const filters = normalizeAssetQuery(query);
    const page = await this.repository.list(filters);
    return {
      assets: page.assets.map(publicAsset),
      limit: filters.limit,
      hasMore: page.hasMore,
      nextCursor: page.hasMore && page.next ? encodeCursor(page.next) : null,
      summary: page.summary,
      filters: {
        q: filters.q,
        type: filters.mediaTypes,
        source: filters.sources,
        from: filters.from,
        to: filters.to,
      },
    };
  }

  async load(id) {
    const asset = await this.repository.get(assertAssetId(id));
    if (!asset) throw new AppError('ASSET_NOT_FOUND', '素材不存在。', 404);
    return asset;
  }

  async detail(id) {
    const asset = await this.load(id);
    const rootId = asset.rootId || asset.id;
    const chain = await this.repository.chain(rootId);
    return {
      asset: publicAsset(asset),
      rootId,
      chain: chain.map(publicAsset),
      versions: chain.length,
    };
  }

  async versions(id) {
    const asset = await this.load(id);
    const rootId = asset.rootId || asset.id;
    const chain = await this.repository.chain(rootId);
    return { assetId: asset.id, rootId, versions: chain.map(publicAsset), total: chain.length };
  }

  // 文件缺失只标记记录，不删除；列表仍能看到它并显示不可用。
  async markUnavailable(id, reason = '对象存储中找不到文件') {
    const assetId = assertAssetId(id);
    const updated = await this.repository.markUnavailable(assetId, reason);
    if (!updated) throw new AppError('ASSET_NOT_FOUND', '素材不存在。', 404);
    return publicAsset(updated);
  }

  // 历史回填时父素材可能晚于改图被索引；这里反复解析直到链全部接上。
  async relinkChains() {
    if (typeof this.repository.listUnlinkedEdits !== 'function') return 0;
    let linked = 0;
    for (let pass = 0; pass < MAX_CHAIN_PASSES; pass++) {
      const orphans = await this.repository.listUnlinkedEdits();
      let changed = 0;
      for (const orphan of orphans) {
        const sourceJobId = orphan.parameters?.sourceJobId;
        if (!sourceJobId) continue;
        const parent = await this.repository.findBySource(sourceJobId);
        if (!parent) continue;
        await this.repository.updateChain(orphan.id, {
          rootId: parent.rootId || parent.id,
          parentId: parent.id,
          chainPosition: (parent.chainPosition || 1) + 1,
        });
        linked += 1;
        changed += 1;
      }
      if (!changed) break;
    }
    return linked;
  }
}

function assetFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.version,
    chainPosition: row.chain_position,
    mediaType: row.media_type,
    title: row.title,
    prompt: row.prompt,
    modelId: row.model_id,
    providerId: row.provider_id,
    operation: row.operation,
    parameters: row.parameters && typeof row.parameters === 'object' ? row.parameters : {},
    contentType: row.content_type,
    objectKey: row.object_key,
    filename: row.filename,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    fileAvailable: row.file_available,
    missingReason: row.missing_reason,
    rootId: row.root_id,
    parentId: row.parent_id,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
    updatedAt: row.updated_at,
    cursorAt: row.cursor_at ? String(row.cursor_at) : toIso(row.created_at),
  };
}

function summaryRow(prefix, row) {
  return {
    total: Number(row[`${prefix}_total`] || 0),
    available: Number(row[`${prefix}_available`] || 0),
    unavailable: Number(row[`${prefix}_unavailable`] || 0),
    bytes: Number(row[`${prefix}_bytes`] || 0),
  };
}

export class PgAssetRepository {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  // 列表与统计共用搜索/类型/时间条件，但统计忽略来源筛选和游标，产出与模板分开计数。
  filteredWhere(filters, { sources = true, cursor = true } = {}) {
    const where = ['a.workspace_id = $1'];
    const params = [this.workspaceId];
    if (filters.q) {
      params.push(`%${escapeLike(filters.q)}%`);
      const token = `$${params.length}`;
      where.push(`(a.title ILIKE ${token} ESCAPE '\\' OR a.prompt ILIKE ${token} ESCAPE '\\')`);
    }
    if (filters.mediaTypes?.length) {
      params.push(filters.mediaTypes);
      where.push(`a.media_type = ANY($${params.length}::text[])`);
    }
    if (sources) {
      if (filters.sources?.length) {
        params.push(filters.sources);
        where.push(`a.source_type = ANY($${params.length}::text[])`);
      } else {
        where.push(`a.source_type <> '${TEMPLATE_SOURCE}'`);
      }
    }
    if (filters.from) {
      params.push(filters.from);
      where.push(`a.created_at >= $${params.length}::timestamptz`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`a.created_at <= $${params.length}::timestamptz`);
    }
    if (cursor && filters.cursor) {
      params.push(filters.cursor.createdAt, filters.cursor.id);
      where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    return { where: where.join(' AND '), params };
  }

  async insert(asset) {
    const inserted = await this.pool.query(`
      INSERT INTO sj_assets (
        id, workspace_id, source_type, source_id, version, chain_position, media_type,
        title, prompt, model_id, provider_id, operation, parameters, content_type,
        object_key, filename, bytes, file_available, missing_reason, root_id, parent_id,
        created_at, indexed_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24
      ) ON CONFLICT (source_type, source_id, version) DO NOTHING
      RETURNING *`, [
      asset.id, asset.workspaceId, asset.sourceType, asset.sourceId, asset.version,
      asset.chainPosition, asset.mediaType, asset.title, asset.prompt, asset.modelId,
      asset.providerId, asset.operation, JSON.stringify(asset.parameters || {}),
      asset.contentType, asset.objectKey, asset.filename, asset.bytes,
      asset.fileAvailable !== false, asset.missingReason, asset.rootId, asset.parentId,
      asset.createdAt, asset.indexedAt, asset.updatedAt,
    ]);
    if (inserted.rows[0]) return { inserted: true, asset: assetFromRow(inserted.rows[0]) };
    const existing = await this.pool.query(
      `SELECT * FROM sj_assets WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3 AND version=$4`,
      [this.workspaceId, asset.sourceType, asset.sourceId, asset.version],
    );
    return { inserted: false, asset: existing.rows[0] ? assetFromRow(existing.rows[0]) : null };
  }

  async findBySource(sourceId) {
    const row = (await this.pool.query(
      `SELECT * FROM sj_assets WHERE workspace_id=$1 AND source_id=$2
       ORDER BY created_at, id LIMIT 1`,
      [this.workspaceId, String(sourceId)],
    )).rows[0];
    return row ? assetFromRow(row) : null;
  }

  async get(id) {
    const row = (await this.pool.query(
      'SELECT * FROM sj_assets WHERE id=$1 AND workspace_id=$2',
      [id, this.workspaceId],
    )).rows[0];
    return row ? assetFromRow(row) : null;
  }

  async chain(rootId) {
    return (await this.pool.query(
      `SELECT * FROM sj_assets
       WHERE workspace_id=$1 AND (root_id=$2 OR id=$2)
       ORDER BY chain_position, created_at, id`,
      [this.workspaceId, rootId],
    )).rows.map(assetFromRow);
  }

  async list(filters) {
    const listFilters = this.filteredWhere(filters);
    const listParams = [...listFilters.params, filters.limit + 1];
    const rows = (await this.pool.query(
      `SELECT a.*, a.created_at::text AS cursor_at FROM sj_assets a
       WHERE ${listFilters.where}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $${listParams.length}`,
      listParams,
    )).rows;
    const hasMore = rows.length > filters.limit;
    const page = rows.slice(0, filters.limit).map(assetFromRow);
    const last = page[page.length - 1];

    const summaryFilters = this.filteredWhere(filters, { sources: false, cursor: false });
    const summary = (await this.pool.query(`
      SELECT
        count(*) FILTER (WHERE a.source_type <> '${TEMPLATE_SOURCE}')::int AS outputs_total,
        count(*) FILTER (WHERE a.source_type <> '${TEMPLATE_SOURCE}' AND a.file_available)::int AS outputs_available,
        count(*) FILTER (WHERE a.source_type <> '${TEMPLATE_SOURCE}' AND NOT a.file_available)::int AS outputs_unavailable,
        COALESCE(sum(a.bytes) FILTER (WHERE a.source_type <> '${TEMPLATE_SOURCE}' AND a.file_available), 0)::bigint AS outputs_bytes,
        count(*) FILTER (WHERE a.source_type = '${TEMPLATE_SOURCE}')::int AS templates_total,
        count(*) FILTER (WHERE a.source_type = '${TEMPLATE_SOURCE}' AND a.file_available)::int AS templates_available,
        count(*) FILTER (WHERE a.source_type = '${TEMPLATE_SOURCE}' AND NOT a.file_available)::int AS templates_unavailable,
        COALESCE(sum(a.bytes) FILTER (WHERE a.source_type = '${TEMPLATE_SOURCE}' AND a.file_available), 0)::bigint AS templates_bytes
      FROM sj_assets a WHERE ${summaryFilters.where}`, summaryFilters.params)).rows[0];

    return {
      assets: page,
      hasMore,
      next: hasMore && last ? { createdAt: last.cursorAt, id: last.id } : null,
      summary: { outputs: summaryRow('outputs', summary), templates: summaryRow('templates', summary) },
    };
  }

  async markUnavailable(id, reason) {
    const row = (await this.pool.query(
      `UPDATE sj_assets SET file_available=false, missing_reason=$3, updated_at=now()
       WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [id, this.workspaceId, reason],
    )).rows[0];
    return row ? assetFromRow(row) : null;
  }

  async updateChain(id, { rootId, parentId, chainPosition }) {
    const row = (await this.pool.query(
      `UPDATE sj_assets SET root_id=$3, parent_id=$4, chain_position=$5, updated_at=now()
       WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [id, this.workspaceId, rootId, parentId, chainPosition],
    )).rows[0];
    return row ? assetFromRow(row) : null;
  }

  async listUnlinkedEdits() {
    return (await this.pool.query(
      `SELECT * FROM sj_assets
       WHERE workspace_id=$1 AND source_type='edit' AND parent_id IS NULL
         AND COALESCE(parameters->>'sourceJobId', '') <> ''
       ORDER BY created_at, id`,
      [this.workspaceId],
    )).rows.map(assetFromRow);
  }
}
