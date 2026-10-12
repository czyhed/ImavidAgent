import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import { ExportService, publicExport } from '../server/export.mjs';

// 全部使用内存仓储、假对象存储与假审计：不连接 PostgreSQL / MinIO，
// 不创建生成任务，不产生任何付费调用。ZIP 由测试独立解析中央目录验证。

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const NOW = new Date('2026-10-21T12:00:00.000Z');

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

class MemoryAudit {
  entries = [];

  async record(entry) {
    this.entries.push(clone(entry));
    return clone(entry);
  }

  actions() {
    return this.entries.map(entry => entry.action);
  }
}

class MemoryObjectStore {
  objects = new Map();
  puts = [];
  failReads = new Set();
  failPut = false;

  async put(key, data, contentType) {
    if (this.failPut) throw new Error('simulated object storage failure');
    const buffer = Buffer.from(data);
    this.puts.push({ key, bytes: buffer.length, contentType });
    this.objects.set(key, buffer);
    return { key, bytes: buffer.length };
  }

  async get(key) {
    if (this.failReads.has(key)) throw new Error('simulated missing object');
    const data = this.objects.get(key);
    if (!data) throw new Error('simulated missing object');
    return Buffer.from(data);
  }

  zipBuffer() {
    const put = this.puts.find(item => item.contentType === 'application/zip');
    return put ? this.objects.get(put.key) : null;
  }
}

class MemoryExportRepository {
  exports = new Map();
  idempotency = new Map();

  constructor({ project, plans, assets = [], versions = [], reviews = [] }) {
    this.project = project;
    this.plans = new Map(plans.map(plan => [plan.version, plan]));
    this.assets = new Map(assets.map(asset => [asset.id, asset]));
    this.versions = new Map(versions.map(version => [version.id, version]));
    this.reviews = new Map(reviews.map(review => [review.versionId, review]));
  }

  addVersion({
    deliverableId, version, assetId = null, status = 'approved',
    reviewStatus = 'approved', reviewedAt = NOW,
  }) {
    const row = {
      id: randomUUID(),
      workspaceId: this.project.workspaceId,
      projectId: this.project.id,
      planVersion: this.project.currentPlanVersion,
      deliverableId,
      version,
      assetId,
      status,
      isCandidate: status === 'approved',
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.versions.set(row.id, row);
    this.reviews.set(row.id, {
      id: randomUUID(),
      versionId: row.id,
      status: reviewStatus,
      reviewedAt,
    });
    return row;
  }

  #key(workspaceId, idempotencyKey) {
    return `${workspaceId}:${idempotencyKey}`;
  }

  async getProjectPlan({ workspaceId, projectId, planVersion = null }) {
    if (projectId !== this.project.id || workspaceId !== this.project.workspaceId) {
      return { project: null, plan: null };
    }
    const version = planVersion ?? this.project.currentPlanVersion;
    return {
      project: clone(this.project),
      plan: clone(this.plans.get(Number(version)) || null),
    };
  }

  async listApprovedVersions({ workspaceId, projectId, planVersion }) {
    const rows = [];
    for (const version of this.versions.values()) {
      if (version.workspaceId !== workspaceId || version.projectId !== projectId
        || version.planVersion !== planVersion || version.status !== 'approved') continue;
      const review = this.reviews.get(version.id);
      if (!review || review.status !== 'approved') continue;
      rows.push({
        ...clone(version),
        reviewId: review.id,
        reviewedAt: review.reviewedAt,
        asset: version.assetId ? clone(this.assets.get(version.assetId) || null) : null,
      });
    }
    return rows;
  }

  async findByIdempotency({ workspaceId, idempotencyKey }) {
    return clone(this.idempotency.get(this.#key(workspaceId, idempotencyKey)) || null);
  }

  async reserve({ row }) {
    const key = this.#key(row.workspaceId, row.idempotencyKey);
    if (this.idempotency.has(key)) {
      return { created: false, export: clone(this.idempotency.get(key)) };
    }
    const saved = clone(row);
    this.exports.set(saved.id, saved);
    this.idempotency.set(key, saved);
    return { created: true, export: clone(saved) };
  }

  async complete({ id, patch }) {
    const row = this.exports.get(id);
    if (!row || row.status !== 'building') return null;
    Object.assign(row, clone(patch), { updatedAt: patch.completedAt ?? NOW });
    return clone(row);
  }

  async fail({ id, errorCode, now }) {
    const row = this.exports.get(id);
    if (!row || row.status !== 'building') return null;
    Object.assign(row, { status: 'failed', errorCode, updatedAt: now });
    return clone(row);
  }

  async getExport({ workspaceId, id }) {
    const row = this.exports.get(id);
    return row && row.workspaceId === workspaceId ? clone(row) : null;
  }

  async listExports({ workspaceId, projectId }) {
    const rows = [...this.exports.values()]
      .filter(row => row.workspaceId === workspaceId && row.projectId === projectId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { exports: rows.map(clone), total: rows.length };
  }
}

function fixture({
  planStatus = 'confirmed',
  deliverables,
  planVersion = 1,
  skuSpec = '燕麦色-350ml',
  projectName = '燕麦杯交付项目',
} = {}) {
  const projectId = randomUUID();
  const ids = {
    white: randomUUID(),
    scene: randomUUID(),
    selling: randomUUID(),
    detail: randomUUID(),
  };
  const planDeliverables = deliverables ?? [
    { id: ids.white, type: 'white', title: '白底主图', typeName: '白底主图 / 多角度' },
    { id: ids.scene, type: 'scene', title: '场景图', typeName: '场景图' },
    { id: ids.selling, type: 'selling', title: '卖点图', typeName: '卖点 / 促销图' },
    { id: ids.detail, type: 'detail', title: '细节图', typeName: '细节 / 尺寸 / 包装清单' },
  ];
  const project = {
    id: projectId,
    workspaceId: 'local',
    name: projectName,
    skuId: randomUUID(),
    skuSpec,
    currentPlanVersion: planVersion,
    status: 'active',
  };
  const plan = {
    id: randomUUID(),
    version: planVersion,
    status: planStatus,
    deliverables: planDeliverables,
    productVersion: 3,
    skuSnapshot: { spec: skuSpec },
    confirmedAt: NOW,
  };
  const assets = [
    {
      id: randomUUID(),
      objectKey: 'generation/white/result.png',
      filename: 'white-result.png',
      contentType: 'image/png',
      bytes: PNG.length,
      fileAvailable: true,
    },
    {
      id: randomUUID(),
      objectKey: 'generation/scene/result.jpg',
      filename: 'scene-result.jpg',
      contentType: 'image/jpeg',
      bytes: JPEG.length,
      fileAvailable: true,
    },
    {
      id: randomUUID(),
      objectKey: 'generation/detail/result.png',
      filename: 'detail-result.png',
      contentType: 'image/png',
      bytes: PNG.length,
      fileAvailable: false,
    },
  ];
  const repository = new MemoryExportRepository({
    project,
    plans: [plan],
    assets,
  });
  const white = repository.addVersion({
    deliverableId: ids.white, version: 1, assetId: assets[0].id,
  });
  // 未通过：候选版本（待审核）与已通过但审核被撤销的版本都不能进包。
  const sceneDraft = repository.addVersion({
    deliverableId: ids.scene, version: 1, assetId: assets[1].id,
    status: 'candidate', reviewStatus: 'in_review',
  });
  const sellingRevoked = repository.addVersion({
    deliverableId: ids.selling, version: 2, assetId: assets[1].id,
    status: 'approved', reviewStatus: 'revoked',
  });
  const detailUnavailable = repository.addVersion({
    deliverableId: ids.detail, version: 1, assetId: assets[2].id,
  });
  const objectStore = new MemoryObjectStore();
  objectStore.objects.set(assets[0].objectKey, Buffer.from(PNG));
  objectStore.objects.set(assets[1].objectKey, Buffer.from(JPEG));
  objectStore.objects.set(assets[2].objectKey, Buffer.from(PNG));
  const audit = new MemoryAudit();
  const service = new ExportService(repository, {
    objectStore,
    audit,
    now: () => new Date(NOW),
  });
  return {
    service, repository, objectStore, audit, project, plan, assets, ids,
    versions: { white, sceneDraft, sellingRevoked, detailUnavailable },
  };
}

// 独立解析中央目录并校验 CRC；不依赖被测代码的写入器。
function parseZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66_000); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  assert.notEqual(eocd, -1, '找不到 ZIP 中央目录结束记录');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd);
  const entries = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(method === 8 || method === 0, true, `不支持的压缩方法 ${method}`);
    assert.equal(data.length, uncompressedSize);
    assert.equal(crc32(data) >>> 0, expectedCrc, `CRC 不匹配：${name}`);
    assert.equal(buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength), name);
    entries.push({ name, data, method, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entriesByName(buffer) {
  return new Map(parseZip(buffer).map(entry => [entry.name, entry]));
}

// ---- 未通过版本不能进包 ----

test('未通过版本不能进包：候选 / 待审核 / 已撤销版本只进入 missing，不写文件', async () => {
  const f = fixture();
  const result = await f.service.createExport(f.project.id, {
    idempotencyKey: 'export-not-approved-1',
  }, { actorId: 'operator-1' });
  assert.equal(result.created, true);
  assert.equal(result.export.status, 'completed');
  assert.equal(result.export.itemCount, 1);
  assert.equal(result.export.missingCount, 3);

  const zipBuffer = f.objectStore.zipBuffer();
  const manifestEntry = entriesByName(zipBuffer).get('manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].deliverableId, f.ids.white);
  assert.equal(manifest.items[0].version, 1);
  assert.equal(manifest.summary.complete, false);
  assert.deepEqual(
    manifest.missing.map(item => item.reason),
    ['NO_APPROVED_VERSION', 'NO_APPROVED_VERSION', 'NO_DELIVERABLE_FILE'],
  );
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(f.versions.sceneDraft.id), false, '候选版本不能进包');
  assert.equal(serialized.includes(f.versions.sellingRevoked.id), false, '撤销版本不能进包');
  assert.equal(result.export.manifest.missing.length, 3);
  assert.equal(result.export.billing.amountCents, 0);
  assert.equal(result.export.billing.charged, false);
});

// ---- 缺项与文件名 / SKU ----

test('部分交付缺项在 manifest 明示；文件名按 SKU / 交付项 / 版本对应', async () => {
  const f = fixture();
  const result = await f.service.createExport(f.project.id, {
    idempotencyKey: 'export-partial-1',
  });
  const zipBuffer = f.objectStore.zipBuffer();
  const entries = entriesByName(zipBuffer);
  const manifest = JSON.parse(entries.get('manifest.json').data.toString('utf8'));
  const item = manifest.items[0];

  assert.equal(item.file, '燕麦色-350ml/white-白底主图-v1.png');
  assert.equal(item.originalFileName, 'white-result.png');
  assert.equal(item.bytes, PNG.length);
  assert.equal(item.sha256, sha256(PNG));
  assert.equal(entries.has(item.file), true, 'manifest 文件名必须与 ZIP 条目一致');
  assert.deepEqual(entries.get(item.file).data, PNG);

  for (const name of entries.keys()) {
    if (name === 'manifest.json') continue;
    assert.match(name, /^燕麦色-350ml\//, '所有交付文件都在 SKU 目录下');
  }
  assert.match(result.export.fileName, /^燕麦色-350ml-燕麦杯交付项目-v1\.zip$/);
  assert.equal(manifest.project.planVersion, 1);
  assert.equal(manifest.project.productVersion, 3);
  assert.deepEqual(manifest.project.sku, { id: f.project.skuId, spec: '燕麦色-350ml' });
  assert.equal(manifest.missing[0].deliverableId, f.ids.scene);
  assert.equal(manifest.missing[0].message, '没有审核通过的版本');
});

// ---- ZIP 可打开、校验值 ----

test('ZIP 可解析：中央目录条目、CRC、manifest 摘要与下载内容一致', async () => {
  const f = fixture();
  const result = await f.service.createExport(f.project.id, {
    idempotencyKey: 'export-zip-1',
  });
  const zipBuffer = f.objectStore.zipBuffer();
  assert.equal(result.export.zipSha256, sha256(zipBuffer));
  const entries = parseZip(zipBuffer);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.name).sort(), [
    'manifest.json',
    '燕麦色-350ml/white-白底主图-v1.png',
  ]);
  for (const entry of entries) {
    assert.equal(entry.method, 0, '使用 store 方法，标准解压器可直接打开');
    assert.equal((entry.flags & 0x0800) !== 0, true, 'UTF-8 文件名标记');
  }
  const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  assert.equal(result.export.manifestSha256, sha256(manifestEntry.data));
  assert.deepEqual(JSON.parse(manifestEntry.data.toString('utf8')), result.export.manifest);

  const downloaded = await f.service.downloadExport(result.export.id, { actorId: 'viewer-1' });
  assert.deepEqual(downloaded.content, zipBuffer);
  assert.equal(downloaded.export.fileName, result.export.fileName);
  assert.equal(f.audit.actions().includes('project.export.downloaded'), true);
});

// ---- 幂等 ----

test('幂等键重复导出返回原记录，只上传一次；同键不同请求返回冲突', async () => {
  const f = fixture();
  const first = await f.service.createExport(f.project.id, {
    idempotencyKey: 'export-idempotent-1',
  });
  const second = await f.service.createExport(f.project.id, {
    idempotencyKey: 'export-idempotent-1',
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.export.id, first.export.id);
  assert.deepEqual(second.export.manifest, first.export.manifest);
  assert.equal(f.objectStore.puts.length, 1, '重复请求不能再次上传');

  await assert.rejects(
    f.service.createExport(f.project.id, {
      planVersion: 9, idempotencyKey: 'export-idempotent-1',
    }),
    error => error instanceof AppError && error.code === 'REQUEST_CONFLICT' && error.status === 409,
  );
  await assert.rejects(
    f.service.createExport(f.project.id, {}),
    error => error.code === 'INVALID_FIELD' && error.status === 422,
  );
});

// ---- 方案门禁与失败记录 ----

test('未确认方案与空方案被拒绝；上传失败记录 failed 且不重复上传', async () => {
  const draft = fixture({ planStatus: 'draft' });
  await assert.rejects(
    draft.service.createExport(draft.project.id, { idempotencyKey: 'export-draft-1' }),
    error => error.code === 'PLAN_NOT_CONFIRMED' && error.status === 409,
  );

  const empty = fixture({ deliverables: [] });
  await assert.rejects(
    empty.service.createExport(empty.project.id, { idempotencyKey: 'export-empty-1' }),
    error => error.code === 'EXPORT_EMPTY_PLAN' && error.status === 409,
  );

  const f = fixture();
  f.objectStore.failPut = true;
  await assert.rejects(
    f.service.createExport(f.project.id, { idempotencyKey: 'export-fail-1' }),
    error => error.code === 'EXPORT_FAILED' && error.status === 503,
  );
  const failed = await f.repository.findByIdempotency({
    workspaceId: 'local', idempotencyKey: 'export-fail-1',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'EXPORT_FAILED');
  assert.equal(f.audit.actions().includes('project.export.failed'), true);

  f.objectStore.failPut = false;
  const repeat = await f.service.createExport(f.project.id, { idempotencyKey: 'export-fail-1' });
  assert.equal(repeat.created, false);
  assert.equal(repeat.export.status, 'failed');
  assert.equal(f.objectStore.puts.length, 0);
});

// ---- 文件不可用 ----

test('文件在对象存储中不可用进入 missing，不写占位文件', async () => {
  const f = fixture();
  f.objectStore.failReads.add('generation/white/result.png');
  const result = await f.service.createExport(f.project.id, { idempotencyKey: 'export-missing-file-1' });
  assert.equal(result.export.status, 'completed');
  assert.equal(result.export.itemCount, 0);
  assert.equal(result.export.missing.length, 4);
  assert.equal(result.export.missing[0].reason, 'FILE_UNAVAILABLE');
  const entries = parseZip(f.objectStore.zipBuffer());
  assert.deepEqual(entries.map(entry => entry.name), ['manifest.json']);
  assert.equal(result.export.manifest.summary.included, 0);
});

// ---- 不含内部地址 / 密钥 ----

test('manifest、响应与审计不含桶名、对象键、内部地址或密钥', async () => {
  const f = fixture();
  const result = await f.service.createExport(f.project.id, {
    idempotencyKey: 'export-secret-1',
  }, { actorId: 'operator-1' });
  const manifestText = JSON.stringify(result.export.manifest);
  const responseText = JSON.stringify(result.export);
  for (const text of [manifestText, responseText]) {
    assert.doesNotMatch(text, /shangjing-exports|MINIO|https?:\/\//i);
    assert.doesNotMatch(text, /objectKey|object_key|accessKey|secretKey|generation\//i);
  }
  assert.equal(Object.hasOwn(result.export, 'objectKey'), false);
  const zipBuffer = f.objectStore.zipBuffer();
  assert.equal(zipBuffer.includes(Buffer.from('shangjing-exports')), false);
  const auditText = JSON.stringify(f.audit.entries);
  assert.doesNotMatch(auditText, /shangjing-exports|MINIO|https?:\/\/|objectKey|accessKey|secretKey/i);
  const created = f.audit.entries.find(entry => entry.action === 'project.export.created');
  assert.equal(created.detail.chargeCents, 0);
  assert.equal(created.detail.itemCount, 1);
});

// ---- HTTP：角色 / 幂等 / 下载 / 审计 ----

async function startServer(options) {
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    port: 0, root: new URL('../', import.meta.url), ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP：查看者只读、运营可导出、重复键 200、下载 ZIP 与审计动作', async t => {
  const f = fixture();
  const users = {
    'viewer-token': { id: randomUUID(), role: 'viewer', active: true, workspaceId: 'local' },
    'operator-token': { id: randomUUID(), role: 'operator', active: true, workspaceId: 'local' },
  };
  const auth = {
    async authenticate(token) {
      return users[token] ? { session: { tokenHash: token }, user: users[token] } : null;
    },
  };
  const { server, base } = await startServer({ auth, export: f.service, audit: f.audit });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const operatorCookie = { Cookie: 'sj_session=operator-token' };
  const viewerCookie = { Cookie: 'sj_session=viewer-token' };
  const operatorSession = await (await fetch(`${base}/api/session`, { headers: operatorCookie })).json();
  const viewerSession = await (await fetch(`${base}/api/session`, { headers: viewerCookie })).json();
  const headers = (session, extra = {}) => ({
    ...operatorCookie,
    'Content-Type': 'application/json',
    'x-csrf-token': session.csrfToken,
    ...extra,
  });
  const viewerHeaders = extra => ({
    ...viewerCookie,
    'Content-Type': 'application/json',
    'x-csrf-token': viewerSession.csrfToken,
    ...extra,
  });

  const viewerCreate = await fetch(`${base}/api/projects/${f.project.id}/exports`, {
    method: 'POST',
    headers: viewerHeaders(),
    body: JSON.stringify({ idempotencyKey: 'http-viewer-1' }),
  });
  assert.equal(viewerCreate.status, 403);

  const created = await fetch(`${base}/api/projects/${f.project.id}/exports`, {
    method: 'POST',
    headers: headers(operatorSession),
    body: JSON.stringify({ idempotencyKey: 'http-export-1' }),
  });
  assert.equal(created.status, 201);
  assert.match(created.headers.get('location'), /^\/api\/exports\//);
  const createdBody = await created.json();
  assert.equal(createdBody.created, true);
  assert.equal(createdBody.export.status, 'completed');
  assert.equal(JSON.stringify(createdBody).includes('objectKey'), false);

  const repeated = await fetch(`${base}/api/projects/${f.project.id}/exports`, {
    method: 'POST',
    headers: headers(operatorSession),
    body: JSON.stringify({ idempotencyKey: 'http-export-1' }),
  });
  assert.equal(repeated.status, 200);
  const repeatedBody = await repeated.json();
  assert.equal(repeatedBody.created, false);
  assert.equal(repeatedBody.export.id, createdBody.export.id);

  const viewerList = await fetch(`${base}/api/projects/${f.project.id}/exports`, { headers: viewerCookie });
  assert.equal(viewerList.status, 200);
  assert.equal((await viewerList.json()).total, 1);

  const viewerDetail = await fetch(`${base}/api/exports/${createdBody.export.id}`, { headers: viewerCookie });
  assert.equal(viewerDetail.status, 200);
  assert.equal((await viewerDetail.json()).export.id, createdBody.export.id);

  const download = await fetch(`${base}/api/exports/${createdBody.export.id}/download`, {
    headers: viewerCookie,
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  const zipBuffer = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(zipBuffer, f.objectStore.zipBuffer());

  const viewerDownload = await fetch(`${base}/api/exports/${createdBody.export.id}/download`);
  assert.equal(viewerDownload.status, 401);

  const actions = f.audit.actions();
  assert.equal(actions.includes('project.export.created'), true);
  assert.equal(actions.includes('project.export.downloaded'), true);
});

// ---- 迁移静态检查 ----

test('迁移 0016 定义幂等唯一约束、完成态字段与不可变触发器', async () => {
  const sql = await readFile(new URL('../server/migrations/0016-export.sql', import.meta.url), 'utf8');
  assert.match(sql, /sj_project_exports_idempotency_unique UNIQUE \(workspace_id, idempotency_key\)/);
  assert.match(sql, /sj_project_exports_charge_zero CHECK \(charge_cents = 0\)/);
  assert.match(sql, /sj_project_exports_completed_fields/);
  assert.match(sql, /CREATE TRIGGER sj_project_exports_guard/);
  assert.match(sql, /已完成或失败的导出记录不可修改/);
  assert.match(sql, /导出记录不可删除/);
  // 导出行不保存任何生成任务或账本扣费字段。
  assert.doesNotMatch(sql, /job_id|ledger|reserved_cents/);
  assert.equal(publicExport(null), null);
});
