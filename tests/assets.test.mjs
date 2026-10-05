import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  AssetIndexService,
  PgAssetRepository,
  decodeCursor,
  encodeCursor,
  normalizeAssetQuery,
} from '../server/assets-index.mjs';
import { GenerationService } from '../server/jobs.mjs';
import { routes } from '../server/routes/assets.mjs';
import { backfillAssets } from '../scripts/backfill-assets.mjs';

// 与 PgAssetRepository 同契约的内存仓储；测试不连接 PostgreSQL、MinIO，也不产生付费任务。
class MemoryAssetRepository {
  constructor() { this.rows = new Map(); }

  clone(row) { return row ? structuredClone(row) : null; }

  uniqueKey(asset) { return `${asset.sourceType}|${asset.sourceId}|${asset.version}`; }

  async insert(asset) {
    const key = this.uniqueKey(asset);
    for (const row of this.rows.values()) {
      if (this.uniqueKey(row) === key) return { inserted: false, asset: this.clone(row) };
    }
    this.rows.set(asset.id, this.clone(asset));
    return { inserted: true, asset: this.clone(asset) };
  }

  async findBySource(sourceId) {
    const matches = [...this.rows.values()]
      .filter(row => row.sourceId === sourceId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return this.clone(matches[0] || null);
  }

  async get(id) { return this.clone(this.rows.get(id)); }

  async chain(rootId) {
    return [...this.rows.values()]
      .filter(row => row.rootId === rootId || row.id === rootId)
      .sort((a, b) => (a.chainPosition - b.chainPosition)
        || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(row => this.clone(row));
  }

  async list(filters) {
    const text = String(filters.q || '').toLowerCase();
    const from = filters.from ? new Date(filters.from) : null;
    const to = filters.to ? new Date(filters.to) : null;
    const base = [...this.rows.values()].filter(row => {
      if (filters.mediaTypes?.length && !filters.mediaTypes.includes(row.mediaType)) return false;
      if (from && row.createdAt < from) return false;
      if (to && row.createdAt > to) return false;
      if (!text) return true;
      return [row.title, row.prompt].some(value => String(value || '').toLowerCase().includes(text));
    });
    const summary = { outputs: emptyStats(), templates: emptyStats() };
    for (const row of base) {
      const bucket = row.sourceType === 'template' ? summary.templates : summary.outputs;
      bucket.total += 1;
      if (row.fileAvailable === false) bucket.unavailable += 1;
      else {
        bucket.available += 1;
        bucket.bytes += Number(row.bytes) || 0;
      }
    }
    let visible = base.filter(row => (filters.sources?.length
      ? filters.sources.includes(row.sourceType)
      : row.sourceType !== 'template'));
    if (filters.cursor) {
      const cursorAt = new Date(filters.cursor.createdAt);
      const cursorId = filters.cursor.id;
      visible = visible.filter(row => row.createdAt < cursorAt
        || (row.createdAt.getTime() === cursorAt.getTime() && row.id < cursorId));
    }
    visible.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const hasMore = visible.length > filters.limit;
    const page = visible.slice(0, filters.limit);
    const last = page[page.length - 1];
    return {
      assets: page.map(row => this.clone(row)),
      hasMore,
      next: hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      summary,
    };
  }

  async markUnavailable(id, reason) {
    const row = this.rows.get(id);
    if (!row) return null;
    row.fileAvailable = false;
    row.missingReason = reason;
    row.updatedAt = new Date();
    return this.clone(row);
  }

  async updateChain(id, { rootId, parentId, chainPosition }) {
    const row = this.rows.get(id);
    if (!row) return null;
    Object.assign(row, { rootId, parentId, chainPosition, updatedAt: new Date() });
    return this.clone(row);
  }

  async listUnlinkedEdits() {
    return [...this.rows.values()]
      .filter(row => row.sourceType === 'edit' && !row.parentId && row.parameters?.sourceJobId)
      .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
      .map(row => this.clone(row));
  }
}

function emptyStats() { return { total: 0, available: 0, unavailable: 0, bytes: 0 }; }

function makeService() {
  const repository = new MemoryAssetRepository();
  return { repository, service: new AssetIndexService(repository) };
}

let sequence = 0;
function job({
  id = randomUUID(), status = 'succeeded', operation = 'generate', prompt = '白色收纳盒',
  createdAt = new Date('2026-10-01T00:00:00.000Z'), sourceJobId, withOutput = true, bytes = 1024,
} = {}) {
  sequence += 1;
  return {
    id,
    status,
    input: {
      modelId: 'test:image', providerId: 'test', operation, prompt,
      size: '1024x1024', quality: 'low', sourceJobId: sourceJobId || null,
    },
    output: withOutput
      ? { key: `generation/${id}/result.png`, contentType: 'image/png', bytes, filename: `${id}.png` }
      : null,
    createdAt,
    updatedAt: createdAt,
    sequence,
  };
}

function templateAsset(overrides = {}) {
  const id = randomUUID();
  return {
    id,
    workspaceId: 'local',
    sourceType: 'template',
    sourceId: `template:${id}`,
    version: 1,
    chainPosition: 1,
    mediaType: 'image',
    title: '白底示意图',
    prompt: null,
    modelId: null,
    providerId: null,
    operation: null,
    parameters: {},
    contentType: 'image/png',
    objectKey: `templates/${id}.png`,
    filename: `${id}.png`,
    bytes: 64,
    fileAvailable: true,
    missingReason: null,
    rootId: id,
    parentId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    indexedAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.status = null;
    this.headers = null;
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

function routeFor(method, path) {
  const route = routes().find(item => item.method === method && item.pattern.test(path));
  assert.ok(route, `未注册路由 ${method} ${path}`);
  return route;
}

test('stable cursor walks 65 records without gaps or duplicates, including tied timestamps', async () => {
  const { repository, service } = makeService();
  const jobs = [];
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  for (let index = 0; index < 65; index += 1) {
    // 每 5 条共享同一时间戳，专门验证 id 作为决胜键。
    const createdAt = new Date(base + Math.floor(index / 5) * 60_000);
    const item = job({ prompt: `批量素材 ${index}`, createdAt });
    jobs.push(item);
    const result = await service.indexSucceededJob(item);
    assert.equal(result.inserted, true);
  }
  const byId = new Map(jobs.map(item => [item.id, item]));
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await service.list({ limit: 7, cursor });
    pages += 1;
    assert.ok(page.assets.length <= 7);
    seen.push(...page.assets.map(asset => asset.id));
    cursor = page.nextCursor;
    assert.equal(page.summary.outputs.total, 65);
  } while (cursor && pages < 20);
  assert.equal(cursor, null);
  assert.equal(pages, 10);
  assert.equal(seen.length, 65);
  assert.equal(new Set(seen).size, 65);
  assert.deepEqual([...seen].sort(), [...repository.rows.keys()].sort());
  for (const asset of repository.rows.values()) {
    assert.ok(byId.has(asset.sourceId), '素材来源必须对应一个成功任务');
  }

  // 顺序必须是 created_at DESC, id DESC；同一时间戳按 id 降序。
  const rowsById = new Map([...repository.rows.values()].map(row => [row.id, row]));
  for (let index = 1; index < seen.length; index += 1) {
    const previous = rowsById.get(seen[index - 1]);
    const current = rowsById.get(seen[index]);
    assert.ok(previous.createdAt >= current.createdAt);
    if (previous.createdAt.getTime() === current.createdAt.getTime()) {
      assert.ok(previous.id > current.id);
    }
  }

  assert.equal(repository.rows.size, 65);
  assert.throws(() => decodeCursor('not-a-cursor'), { code: 'INVALID_CURSOR' });
  assert.deepEqual(Object.keys(decodeCursor(encodeCursor({ createdAt: new Date().toISOString(), id: randomUUID() }))).sort(),
    ['createdAt', 'id']);
});

test('filters by source, media type, time and prompt; templates stay out of outputs', async () => {
  const { repository, service } = makeService();
  const early = job({ prompt: '太阳能户外灯', createdAt: new Date('2026-09-10T10:00:00.000Z') });
  const late = job({ prompt: '厨房收纳盒', createdAt: new Date('2026-10-10T10:00:00.000Z') });
  const edit = job({
    operation: 'edit', prompt: '厨房收纳盒 改背景', sourceJobId: early.id,
    createdAt: new Date('2026-10-11T10:00:00.000Z'),
  });
  for (const item of [early, late, edit]) await service.indexSucceededJob(item);
  await repository.insert(templateAsset());

  const byPrompt = await service.list({ q: '太阳能' });
  assert.deepEqual(byPrompt.assets.map(asset => asset.sourceId), [early.id]);
  assert.equal(byPrompt.summary.outputs.total, 1, '统计同样应用搜索词');
  assert.equal(byPrompt.summary.templates.total, 0);

  const edits = await service.list({ source: 'edit' });
  assert.deepEqual(edits.assets.map(asset => asset.sourceId), [edit.id]);

  const projects = await service.list({ source: 'project' });
  assert.equal(projects.assets.length, 0);

  const inRange = await service.list({
    from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z',
  });
  assert.deepEqual(inRange.assets.map(asset => asset.sourceId).sort(), [late.id, edit.id].sort());
  assert.equal(inRange.summary.outputs.total, 2);

  const templates = await service.list({ source: 'template' });
  assert.equal(templates.assets.length, 1);
  assert.equal(templates.assets[0].sourceType, 'template');
  assert.equal(templates.summary.outputs.total, 3);

  const images = await service.list({ type: 'image' });
  assert.equal(images.assets.length, 3);
  assert.equal((await service.list({ type: 'video' })).assets.length, 0);

  // 默认列表不含模板示意图；模板只出现在模板统计或显式 source=template 时。
  const defaultList = await service.list({});
  assert.equal(defaultList.assets.length, 3);
  assert.equal(defaultList.assets.some(asset => asset.sourceType === 'template'), false);
  assert.equal(defaultList.summary.templates.total, 1);
  assert.equal(defaultList.summary.templates.available, 1);

  assert.throws(() => normalizeAssetQuery({ type: 'audio' }), { code: 'INVALID_FILTER' });
  assert.throws(() => normalizeAssetQuery({ source: 'unknown' }), { code: 'INVALID_FILTER' });
  assert.throws(() => normalizeAssetQuery({ from: '2026-10-10', to: '2026-10-01' }), { code: 'INVALID_FILTER' });
});

test('only succeeded jobs with stored output are indexed; duplicate callbacks stay one row', async () => {
  const { repository, service } = makeService();
  const success = job();
  const first = await service.indexSucceededJob(success);
  const second = await service.indexSucceededJob(success);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(repository.rows.size, 1);

  const failed = job({ status: 'failed' });
  const queued = job({ status: 'queued' });
  const noOutput = job({ withOutput: false });
  assert.equal((await service.indexSucceededJob(failed)).skipped, true);
  assert.equal((await service.indexSucceededJob(queued)).skipped, true);
  assert.equal((await service.indexSucceededJob(noOutput)).skipped, true);
  assert.equal(repository.rows.size, 1);

  const publicRow = (await service.list({})).assets[0];
  assert.equal(publicRow.available, true);
  assert.equal(publicRow.bytes, 1024);
  assert.equal(publicRow.imageUrl, `/api/assets/${first.asset.id}/image`);
  assert.equal('objectKey' in publicRow, false, '下载用的对象键不暴露在列表响应中');
});

test('edit versions form a chain with parent and root links', async () => {
  const { service } = makeService();
  const root = job({ prompt: '原图', createdAt: new Date('2026-10-01T00:00:00.000Z') });
  const firstEdit = job({
    operation: 'edit', prompt: '第一次改图', sourceJobId: root.id,
    createdAt: new Date('2026-10-01T01:00:00.000Z'),
  });
  const secondEdit = job({
    operation: 'edit', prompt: '第二次改图', sourceJobId: firstEdit.id,
    createdAt: new Date('2026-10-01T02:00:00.000Z'),
  });
  const a = await service.indexSucceededJob(root);
  const b = await service.indexSucceededJob(firstEdit);
  const c = await service.indexSucceededJob(secondEdit);

  const detail = await service.detail(a.asset.id);
  assert.equal(detail.versions, 3);
  assert.deepEqual(detail.chain.map(asset => asset.version), [1, 2, 3]);
  assert.deepEqual(detail.chain.map(asset => asset.id), [a.asset.id, b.asset.id, c.asset.id]);
  assert.equal(detail.asset.rootId, a.asset.id);
  assert.equal(detail.chain[1].parentId, a.asset.id);
  assert.equal(detail.chain[2].parentId, b.asset.id);
  assert.equal(detail.chain[1].sourceJobId, root.id);
  assert.equal(detail.chain[2].sourceJobId, firstEdit.id);
  assert.equal(detail.chain[1].sourceVersion, 1);

  const fromMiddle = await service.detail(b.asset.id);
  assert.equal(fromMiddle.rootId, a.asset.id);
  assert.equal(fromMiddle.versions, 3);

  const versions = await service.versions(a.asset.id);
  assert.equal(versions.total, 3);
  assert.equal(versions.rootId, a.asset.id);

  await assert.rejects(service.detail(randomUUID()), { code: 'ASSET_NOT_FOUND', status: 404 });
  await assert.rejects(service.detail('not-a-uuid'), { code: 'ASSET_NOT_FOUND', status: 404 });
});

test('missing objects keep their record and are marked unavailable', async () => {
  const { repository, service } = makeService();
  const missing = job({ prompt: '文件丢失' });
  const saved = await service.indexSucceededJob(missing, { objectAvailable: false });
  assert.equal(saved.inserted, true);
  assert.equal(saved.asset.available, false);
  assert.match(saved.asset.missingReason, /未在对象存储中找到/);

  const list = await service.list({});
  assert.equal(list.assets.length, 1);
  assert.equal(list.assets[0].available, false);
  assert.equal(list.summary.outputs.total, 1);
  assert.equal(list.summary.outputs.available, 0);
  assert.equal(list.summary.outputs.unavailable, 1);
  assert.equal(list.summary.outputs.bytes, 0);
  assert.ok(repository.rows.has(saved.asset.id), '缺文件时记录必须保留');

  const other = job({ prompt: '下载时丢失' });
  const savedOther = await service.indexSucceededJob(other);
  const marked = await service.markUnavailable(savedOther.asset.id, '下载读取失败');
  assert.equal(marked.available, false);
  assert.equal(marked.id, savedOther.asset.id);
  assert.ok(repository.rows.has(savedOther.asset.id));
  await assert.rejects(service.markUnavailable(randomUUID()), { code: 'ASSET_NOT_FOUND' });
});

test('asset routes require a session, stream authenticated downloads and mark missing files', async () => {
  const { service } = makeService();
  const item = job({ prompt: '可下载素材' });
  const saved = await service.indexSucceededJob(item);
  const listHandler = routeFor('GET', '/api/assets').handler;
  const downloadHandler = routeFor('GET', '/api/assets/x/download').handler;
  const imageHandler = routeFor('GET', '/api/assets/x/image').handler;
  const detailHandler = routeFor('GET', '/api/assets/x').handler;

  await assert.rejects(listHandler({
    ctx: { auth: {}, session: null, assetsIndex: service },
    url: new URL('http://localhost/api/assets'), res: new CaptureResponse(),
    reply() {},
  }), { code: 'UNAUTHENTICATED', status: 401 });
  await assert.rejects(downloadHandler({
    ctx: { auth: {}, session: null, assetsIndex: service, assets: { get: async () => Readable.from([]) } },
    match: [null, saved.asset.id, 'download'], res: new CaptureResponse(),
  }), { code: 'UNAUTHENTICATED', status: 401 });

  const storage = { get: async () => Readable.from([Buffer.from('image-bytes')]) };
  const downloadRes = new CaptureResponse();
  await downloadHandler({
    ctx: { auth: {}, session: { user: { id: 'u1' } }, assetsIndex: service, assets: storage },
    match: [null, saved.asset.id, 'download'], res: downloadRes,
  });
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers['Content-Type'], 'image/png');
  assert.match(downloadRes.headers['Content-Disposition'], /^attachment;/);
  assert.equal(downloadRes.headers['Content-Length'], '1024');
  assert.equal(downloadRes.body(), 'image-bytes');

  const imageRes = new CaptureResponse();
  await imageHandler({
    ctx: { session: {} , assetsIndex: service, assets: storage },
    match: [null, saved.asset.id, 'image'], res: imageRes,
  });
  assert.match(imageRes.headers['Content-Disposition'], /^inline;/);

  const detailRes = new CaptureResponse();
  let detailBody;
  await detailHandler({
    ctx: { session: {}, assetsIndex: service },
    match: [null, saved.asset.id], res: detailRes,
    reply(res, status, body) { detailBody = { status, body }; },
  });
  assert.equal(detailBody.status, 200);
  assert.equal(detailBody.body.asset.id, saved.asset.id);
  assert.equal(detailBody.body.chain.length, 1);

  const broken = job({ prompt: '对象丢失' });
  const brokenAsset = await service.indexSucceededJob(broken);
  const brokenStorage = { get: async () => { throw new Error('NoSuchKey'); } };
  await assert.rejects(downloadHandler({
    ctx: { session: {}, assetsIndex: service, assets: brokenStorage },
    match: [null, brokenAsset.asset.id, 'download'], res: new CaptureResponse(),
  }), { code: 'ASSET_UNAVAILABLE', status: 410 });
  const reloaded = await service.load(brokenAsset.asset.id);
  assert.equal(reloaded.fileAvailable, false);
  assert.equal((await service.list({})).assets.length, 2, '缺文件记录不会消失');
});

class FlakyRepository extends MemoryAssetRepository {
  constructor(failSourceId) {
    super();
    this.failSourceId = failSourceId;
  }

  async insert(asset) {
    if (asset.sourceId === this.failSourceId) throw new Error('temporary index failure');
    return super.insert(asset);
  }
}

test('backfill is idempotent, keeps original creation time, links edits and never touches jobs', async () => {
  const parent = job({ prompt: '父素材', createdAt: new Date('2026-10-02T00:00:00.000Z') });
  const orphanEdit = job({
    operation: 'edit', prompt: '先被索引的改图', sourceJobId: parent.id,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  const failed = job({ status: 'failed', createdAt: new Date('2026-10-03T00:00:00.000Z') });
  const noOutput = job({ withOutput: false, createdAt: new Date('2026-10-04T00:00:00.000Z') });
  const later = job({ prompt: '后补素材', createdAt: new Date('2026-10-05T00:00:00.000Z') });
  const flaky = job({ prompt: '首次索引失败', createdAt: new Date('2026-10-06T00:00:00.000Z') });
  const jobs = [orphanEdit, parent, failed, noOutput, later, flaky];
  const snapshot = structuredClone(jobs);
  const repository = new FlakyRepository(flaky.id);
  const service = new AssetIndexService(repository);

  const fetchPage = async (after, limit) => {
    const start = after ? jobs.findIndex(item => item.id === after.id) + 1 : 0;
    return jobs.slice(start, start + limit);
  };

  const first = await backfillAssets({
    service, fetchPage, batchSize: 2,
    objectExists: async item => item.id !== later.id,
  });
  assert.equal(first.scanned, 6);
  assert.equal(first.inserted, 3);
  assert.equal(first.existing, 0);
  assert.equal(first.skipped, 2);
  assert.equal(first.failed, 1);
  assert.equal(first.unavailable, 1);
  assert.ok(first.linked >= 1, '父素材晚于改图索引时仍要接上版本链');

  const storedParent = await repository.findBySource(parent.id);
  assert.equal(storedParent.createdAt.getTime(), parent.createdAt.getTime(), '回填保留原始创建时间');
  const storedLater = await repository.findBySource(later.id);
  assert.equal(storedLater.fileAvailable, false);

  const chain = await service.detail(storedParent.id);
  assert.equal(chain.versions, 2);
  assert.equal(chain.chain[1].sourceJobId, parent.id);
  assert.equal(chain.chain[1].version, 2);

  // 第二次运行：幂等，只有上次失败的那条会补上。
  repository.failSourceId = null;
  const second = await backfillAssets({ service, fetchPage, batchSize: 2 });
  assert.equal(second.inserted, 1);
  assert.equal(second.existing, 3);
  assert.equal(second.failed, 0);
  assert.equal(repository.rows.size, 4);

  // 回填只读任务：状态、时间和内容完全未变。
  assert.deepEqual(jobs.map(item => ({ id: item.id, status: item.status, createdAt: item.createdAt })),
    snapshot.map(item => ({ id: item.id, status: item.status, createdAt: item.createdAt })));
  assert.equal(jobs.every(item => !('indexed' in item)), true);
});

test('asset index derives a scoped instance per workspace', async () => {
  // 内存仓储没有 pool：保持单实例，供测试与回填脚本使用。
  const memory = new AssetIndexService({ list: async () => ({ assets: [], hasMore: false }) });
  assert.equal(memory.forWorkspace('ws-a'), memory);

  // 生产注入实例基于连接池；不同工作空间得到不同实例，同一工作空间复用。
  const pool = { query: async () => ({ rows: [] }) };
  const service = new AssetIndexService(new PgAssetRepository(pool));
  const a = service.forWorkspace('ws-a');
  const b = service.forWorkspace('ws-b');
  assert.notEqual(a, service);
  assert.equal(a.workspaceId, 'ws-a');
  assert.equal(b.workspaceId, 'ws-b');
  assert.equal(service.forWorkspace('ws-a'), a);
  assert.notEqual(a, b);
  // 关闭登录时仍使用默认历史工作空间。
  assert.equal(service.forWorkspace(null), service);
});

test('succeeded jobs are indexed into the job workspace, not the injected default', async () => {
  const calls = [];
  const assetsIndex = {
    forWorkspace(workspaceId) { calls.push(['scope', workspaceId]); return this; },
    async indexSucceededJob(job) { calls.push(['index', job.workspaceId]); },
  };
  const service = new GenerationService({}, {}, {}, { assetsIndex });
  await service.indexAsset({ id: randomUUID(), workspaceId: 'ws-b', input: { workspaceId: 'ws-b' } });
  assert.deepEqual(calls, [['scope', 'ws-b'], ['index', 'ws-b']]);
});
