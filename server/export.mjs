import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { AppError } from './errors.mjs';
import { createMinioClient } from './store.mjs';

// 打包导出 ZIP 与 manifest（Issue #18 / FLOW-11、BILL-02）。
//
// 规则：
//   - 只导出审核通过（approved）的交付版本。draft / candidate / 待审核 / 已撤销版本
//     一律不写包，对应交付项写入 manifest.missing，绝不用占位图冒充。
//   - ZIP 只进入私有桶 shangjing-exports。manifest 与审计只写逻辑文件名、编号、
//     大小与 sha256，不写对象键、桶名、内部地址、密钥或连接串。
//   - 导出不创建生成任务、不扣生成费；记录里的 charge_cents 恒为 0。
//   - 幂等键重复导出返回原记录，不重新生成或上传；同一键不同项目 / 方案版本返回冲突。
//   - 写操作先预约一行 building，完成后不可修改或删除。

export const EXPORT_BUCKET = 'shangjing-exports';
export const EXPORT_STATUSES = Object.freeze(['building', 'completed', 'failed']);
export const EXPORT_STATUS_LABELS = Object.freeze({
  building: '生成中',
  completed: '已完成',
  failed: '失败',
});
export const MISSING_REASON_LABELS = Object.freeze({
  NO_APPROVED_VERSION: '没有审核通过的版本',
  NO_DELIVERABLE_FILE: '审核通过的版本没有可导出的文件',
  FILE_UNAVAILABLE: '文件在对象存储中不可用',
  FILE_EMPTY: '文件为空',
  UNSUPPORTED_FILE: '文件类型不是可交付图片',
});
export const MAX_EXPORT_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 200 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_FIELDS = ['planVersion', 'idempotencyKey'];
const IMAGE_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

function fail(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label = '请求体') {
  if (!isObject(value)) fail('INVALID_BODY', `${label}必须是 JSON 对象。`);
}

function rejectUnknown(body, allowed, label = '请求') {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function uuidField(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_ID', `${label}不能为空。`);
    return null;
  }
  const id = String(value);
  if (!UUID.test(id)) fail('INVALID_ID', `${label}格式不正确。`);
  return id;
}

function integerField(value, label, { min = 1, max = 2_147_483_647, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_FIELD', `${label}不能为空。`);
    return null;
  }
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('INVALID_FIELD', `${label}必须是 ${min}–${max} 的整数。`);
  }
  return number;
}

function keyField(value) {
  if (value === undefined || value === null) fail('INVALID_FIELD', '幂等键不能为空。');
  if (typeof value !== 'string') fail('INVALID_FIELD', '幂等键必须是文本。');
  const key = value.trim();
  if (!key) fail('INVALID_FIELD', '幂等键不能为空。');
  if (key.length > 200) fail('INVALID_FIELD', '幂等键不能超过 200 个字符。');
  if (/[\u0000-\u001f\u007f]/.test(key)) fail('INVALID_FIELD', '幂等键不能包含控制字符。');
  return key;
}

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicMissing(item) {
  return {
    deliverableId: item.deliverableId,
    title: item.title,
    type: item.type,
    reason: item.reason,
    message: item.message || MISSING_REASON_LABELS[item.reason] || '缺失',
  };
}

function publicItem(item) {
  return {
    deliverableId: item.deliverableId,
    title: item.title,
    type: item.type,
    versionId: item.versionId,
    version: item.version,
    reviewId: item.reviewId,
    reviewedAt: iso(item.reviewedAt),
    file: item.file,
    originalFileName: item.originalFileName ?? null,
    contentType: item.contentType,
    bytes: item.bytes,
    sha256: item.sha256,
  };
}

export function publicExport(row) {
  if (!row) return null;
  const items = Array.isArray(row.items) ? row.items.map(publicItem) : [];
  const missing = Array.isArray(row.missing) ? row.missing.map(publicMissing) : [];
  return {
    id: row.id,
    projectId: row.projectId,
    planVersion: row.planVersion,
    status: row.status,
    statusLabel: EXPORT_STATUS_LABELS[row.status] ?? row.status,
    fileName: row.fileName ?? null,
    contentType: row.contentType ?? 'application/zip',
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    zipSha256: row.zipSha256 ?? null,
    manifestSha256: row.manifestSha256 ?? null,
    items,
    missing,
    itemCount: row.itemCount ?? items.length,
    missingCount: row.missingCount ?? missing.length,
    manifest: clone(row.manifest || {}),
    billing: {
      currency: 'CNY',
      amountCents: 0,
      billingMode: 'none',
      charged: false,
      note: '导出不收取生成费用，不写账本扣费。',
    },
    errorCode: row.errorCode ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: iso(row.createdAt),
    completedAt: iso(row.completedAt),
    updatedAt: iso(row.updatedAt),
    downloadUrl: row.status === 'completed' ? `/api/exports/${row.id}/download` : null,
  };
}

// ---- 最小 ZIP 写入器（store 方法，UTF-8 文件名；标准解压器可打开） ----

function dosDateTime(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date('1980-01-01T00:00:00Z');
  const year = Math.max(1980, value.getFullYear());
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

// entries: [{ name, data }]。默认 store（method 0），不引入第三方依赖；
// 也可用 compress=true 走 node:zlib 的 deflateRaw。返回完整 ZIP Buffer。
export function buildZip(entries, { now = new Date(), compress = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) fail('EXPORT_EMPTY_ZIP', '导出包至少需要一个文件。', 500);
  if (entries.length > 60000) fail('EXPORT_TOO_MANY_ENTRIES', '导出包文件数量过多。', 413);
  const stamp = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8');
    if (!name.length || name.length > 512) fail('EXPORT_INVALID_NAME', '导出文件名长度无效。', 500);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data) >>> 0;
    const method = compress ? 8 : 0;
    const payload = compress ? deflateRawSync(data) : data;
    if (payload.length > 0xffffffff || data.length > 0xffffffff) {
      fail('EXPORT_TOO_LARGE', '单个文件超过 ZIP 32 位大小限制。', 413);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, payload);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
    if (offset > 0xffffffff) fail('EXPORT_TOO_LARGE', '导出包超过 ZIP 32 位大小限制。', 413);
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > 0xffffffff || entries.length > 0xffff) {
    fail('EXPORT_TOO_LARGE', '导出包超过 ZIP 32 位限制。', 413);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ---- 文件名与 manifest ----

function safeSegment(value, fallback = 'item', max = 80) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .trim();
  return (text || fallback).slice(0, max).replace(/[.\s-]+$/g, '') || fallback;
}

function skuSegment(project, plan) {
  const snapshot = isObject(plan.skuSnapshot) ? plan.skuSnapshot : {};
  const raw = snapshot.spec || snapshot.internalSku || project.skuSpec
    || (project.skuId ? String(project.skuId).slice(0, 8) : 'sku');
  return safeSegment(raw, 'sku', 60);
}

function deliverableInfo(raw, index) {
  const item = isObject(raw) ? raw : {};
  const id = item.id === undefined || item.id === null || item.id === ''
    ? `item-${index + 1}` : String(item.id);
  const type = item.type ? String(item.type) : 'extension';
  const title = item.title || item.typeName || type;
  return {
    id,
    type,
    title: String(title).slice(0, 200),
  };
}

function extensionFor(asset) {
  const byType = IMAGE_TYPES[String(asset.contentType || '').toLowerCase()];
  if (byType) return byType;
  const match = String(asset.filename || '').match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : 'bin';
}

function uniqueFilePath(base, extension, used) {
  let candidate = `${base}.${extension}`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}.${extension}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function missingFor(deliverable, reason) {
  return {
    deliverableId: deliverable.id,
    title: deliverable.title,
    type: deliverable.type,
    reason,
  };
}

// ---- 导出服务 ----

export class ExportService {
  constructor(repository, {
    objectStore = null,
    objectStoreFactory = null,
    audit = null,
    now = () => new Date(),
    idFactory = randomUUID,
    maxFileBytes = MAX_EXPORT_FILE_BYTES,
    maxTotalBytes = MAX_EXPORT_TOTAL_BYTES,
  } = {}) {
    if (!repository) throw new AppError('EXPORT_STORE_UNAVAILABLE', '导出存储未配置。', 500);
    this.repository = repository;
    this.objectStore = objectStore;
    this.objectStoreFactory = objectStoreFactory;
    this.audit = audit;
    this.now = now;
    this.idFactory = idFactory;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
  }

  #store() {
    if (!this.objectStore) {
      if (!this.objectStoreFactory) {
        throw new AppError('EXPORT_STORAGE_UNAVAILABLE', '导出对象存储暂不可用。', 503);
      }
      this.objectStore = this.objectStoreFactory();
    }
    return this.objectStore;
  }

  #workspace(workspaceId) {
    return workspaceId || 'local';
  }

  async #record(action, { targetId, result = 'success', detail = {}, context = {} }) {
    if (!this.audit) return null;
    const entry = {
      action,
      targetType: 'project',
      targetId: targetId || null,
      result,
      detail,
      actor: context.actor || null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
      createdAt: this.now(),
    };
    try {
      if (typeof this.audit === 'function') return await this.audit(entry);
      return await this.audit.record(entry);
    } catch {
      return null;
    }
  }

  async #project(projectId, workspaceId, planVersion) {
    const target = await this.repository.getProjectPlan({
      workspaceId,
      projectId,
      planVersion: planVersion ?? null,
    });
    if (!target?.project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    return target;
  }

  async #build(target, exportId) {
    const { project, plan } = target;
    if (!plan) throw new AppError('PLAN_NOT_FOUND', '项目方案不存在。', 409);
    if (plan.status !== 'confirmed') {
      throw new AppError('PLAN_NOT_CONFIRMED', '方案确认后才能打包导出。', 409);
    }
    const deliverables = Array.isArray(plan.deliverables) ? plan.deliverables : [];
    if (!deliverables.length) throw new AppError('EXPORT_EMPTY_PLAN', '方案没有可导出的交付项。', 409);

    const approved = await this.repository.listApprovedVersions({
      workspaceId: project.workspaceId,
      projectId: project.id,
      planVersion: plan.version,
    });
    const byDeliverable = new Map();
    for (const row of approved) {
      if (row.status !== 'approved' || !row.reviewId) continue;
      if (!byDeliverable.has(row.deliverableId)) byDeliverable.set(row.deliverableId, row);
    }

    const sku = skuSegment(project, plan);
    const used = new Set();
    const items = [];
    const missing = [];
    const files = [];
    let totalBytes = 0;

    for (const [index, raw] of deliverables.entries()) {
      const deliverable = deliverableInfo(raw, index);
      const row = byDeliverable.get(deliverable.id);
      if (!row) {
        missing.push(missingFor(deliverable, 'NO_APPROVED_VERSION'));
        continue;
      }
      const asset = row.asset;
      if (!asset || !asset.objectKey || asset.fileAvailable === false) {
        missing.push(missingFor(deliverable, 'NO_DELIVERABLE_FILE'));
        continue;
      }
      let data;
      try {
        data = await this.#store().get(asset.objectKey);
      } catch {
        missing.push(missingFor(deliverable, 'FILE_UNAVAILABLE'));
        continue;
      }
      if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
      if (!data.length) {
        missing.push(missingFor(deliverable, 'FILE_EMPTY'));
        continue;
      }
      if (data.length > this.maxFileBytes) {
        throw new AppError('EXPORT_TOO_LARGE', '单个交付文件超过导出大小限制。', 413);
      }
      const contentType = String(asset.contentType || '');
      if (!contentType.startsWith('image/')) {
        missing.push(missingFor(deliverable, 'UNSUPPORTED_FILE'));
        continue;
      }
      totalBytes += data.length;
      if (totalBytes > this.maxTotalBytes) {
        throw new AppError('EXPORT_TOO_LARGE', '导出包总大小超过限制。', 413);
      }
      const base = `${sku}/${safeSegment(deliverable.type, 'item', 40)}-${safeSegment(deliverable.title, 'deliverable', 70)}-v${row.version}`;
      const file = uniqueFilePath(base, extensionFor(asset), used);
      const digest = sha256Hex(data);
      items.push({
        deliverableId: deliverable.id,
        title: deliverable.title,
        type: deliverable.type,
        versionId: row.id,
        version: row.version,
        reviewId: row.reviewId,
        reviewedAt: row.reviewedAt,
        file,
        originalFileName: asset.filename ?? null,
        contentType,
        bytes: data.length,
        sha256: digest,
      });
      files.push({ name: file, data });
    }

    const generatedAt = this.now();
    const manifest = {
      format: 'shangjing-delivery-manifest',
      formatVersion: 1,
      exportId,
      generatedAt: generatedAt.toISOString(),
      project: {
        id: project.id,
        name: project.name,
        planVersion: plan.version,
        productVersion: plan.productVersion ?? null,
        planConfirmedAt: iso(plan.confirmedAt),
        sku: {
          id: project.skuId ?? null,
          spec: project.skuSpec ?? (isObject(plan.skuSnapshot) ? plan.skuSnapshot.spec ?? null : null),
        },
      },
      items: items.map(publicItem),
      missing: missing.map(publicMissing),
      summary: {
        deliverables: deliverables.length,
        included: items.length,
        missing: missing.length,
        complete: missing.length === 0,
      },
      billing: {
        currency: 'CNY',
        amountCents: 0,
        billingMode: 'none',
        charged: false,
        note: '导出不收取生成费用，不写账本扣费。',
      },
    };
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const zip = buildZip([{ name: 'manifest.json', data: manifestData }, ...files], { now: generatedAt });
    const fileName = `${sku}-${safeSegment(project.name, 'project', 70)}-v${plan.version}.zip`;
    return {
      manifest,
      items,
      missing,
      zip,
      fileName,
      manifestSha256: sha256Hex(manifestData),
      zipSha256: sha256Hex(zip),
    };
  }

  async createExport(projectId, body = {}, {
    workspaceId = null, actorId = null, ...context
  } = {}) {
    const id = uuidField(projectId, '项目编号');
    requireObject(body);
    rejectUnknown(body, CREATE_FIELDS, '导出');
    const idempotencyKey = keyField(body.idempotencyKey);
    const requestedPlanVersion = integerField(body.planVersion, '方案版本', { required: false });
    const scope = this.#workspace(workspaceId);
    const requestHash = sha256Hex(JSON.stringify({
      projectId: id,
      planVersion: requestedPlanVersion ?? null,
    }));

    const existing = await this.repository.findByIdempotency({
      workspaceId: scope,
      idempotencyKey,
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError('REQUEST_CONFLICT', '同一幂等键不能用于不同的导出请求。', 409);
      }
      return { export: publicExport(existing), created: false };
    }

    const target = await this.#project(id, scope, requestedPlanVersion);
    if (!target.plan) throw new AppError('PLAN_NOT_FOUND', '项目方案不存在。', 409);
    if (target.plan.status !== 'confirmed') {
      throw new AppError('PLAN_NOT_CONFIRMED', '方案确认后才能打包导出。', 409);
    }
    const exportId = this.idFactory();
    const now = this.now();
    const reservation = await this.repository.reserve({
      row: {
        id: exportId,
        workspaceId: scope,
        projectId: id,
        planVersion: target.plan.version,
        idempotencyKey,
        requestHash,
        status: 'building',
        contentType: 'application/zip',
        manifest: {},
        items: [],
        missing: [],
        itemCount: 0,
        missingCount: 0,
        chargeCents: 0,
        createdBy: actorId || 'local',
        createdAt: now,
        updatedAt: now,
      },
    });
    if (!reservation.created) {
      if (reservation.export?.requestHash !== requestHash) {
        throw new AppError('REQUEST_CONFLICT', '同一幂等键不能用于不同的导出请求。', 409);
      }
      return { export: publicExport(reservation.export), created: false };
    }

    try {
      const built = await this.#build(target, exportId);
      const objectKey = `exports/${id}/${exportId}/${built.fileName}`;
      await this.#store().put(objectKey, built.zip, 'application/zip');
      const completed = await this.repository.complete({
        id: exportId,
        patch: {
          status: 'completed',
          fileName: built.fileName,
          objectKey,
          contentType: 'application/zip',
          bytes: built.zip.length,
          zipSha256: built.zipSha256,
          manifestSha256: built.manifestSha256,
          manifest: built.manifest,
          items: built.items,
          missing: built.missing,
          itemCount: built.items.length,
          missingCount: built.missing.length,
          completedAt: this.now(),
        },
        now: this.now(),
      });
      await this.#record('project.export.created', {
        targetId: id,
        detail: {
          projectId: id,
          exportId,
          planVersion: target.plan.version,
          itemCount: built.items.length,
          missingCount: built.missing.length,
          bytes: built.zip.length,
          fileName: built.fileName,
          zipSha256: built.zipSha256,
          manifestSha256: built.manifestSha256,
          chargeCents: 0,
        },
        context,
      });
      return { export: publicExport(completed), created: true };
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'EXPORT_FAILED';
      await this.repository.fail({ id: exportId, errorCode: code, now: this.now() }).catch(() => {});
      await this.#record('project.export.failed', {
        targetId: id,
        result: 'failure',
        detail: { projectId: id, exportId, errorCode: code, chargeCents: 0 },
        context,
      });
      if (error instanceof AppError) throw error;
      throw new AppError('EXPORT_FAILED', '导出失败，未生成 ZIP，也未产生生成费用。', 503);
    }
  }

  async listExports(projectId, { workspaceId = null } = {}) {
    const id = uuidField(projectId, '项目编号');
    const scope = this.#workspace(workspaceId);
    const target = await this.#project(id, scope, null);
    const page = await this.repository.listExports({
      workspaceId: scope,
      projectId: id,
      limit: 50,
      offset: 0,
    });
    return {
      project: { id: target.project.id, name: target.project.name },
      exports: page.exports.map(publicExport),
      total: page.total,
    };
  }

  async getExport(exportId, { workspaceId = null } = {}) {
    const id = uuidField(exportId, '导出编号');
    const row = await this.repository.getExport({ workspaceId: this.#workspace(workspaceId), id });
    if (!row) throw new AppError('EXPORT_NOT_FOUND', '导出记录不存在。', 404);
    return { export: publicExport(row) };
  }

  async downloadExport(exportId, {
    workspaceId = null, actorId = null, ...context
  } = {}) {
    const id = uuidField(exportId, '导出编号');
    const row = await this.repository.getExport({ workspaceId: this.#workspace(workspaceId), id });
    if (!row) throw new AppError('EXPORT_NOT_FOUND', '导出记录不存在。', 404);
    if (row.status !== 'completed' || !row.objectKey) {
      throw new AppError('EXPORT_NOT_READY', '导出包尚未生成完成。', 409);
    }
    let content;
    try {
      content = await this.#store().get(row.objectKey);
    } catch {
      throw new AppError('EXPORT_UNAVAILABLE', '导出包在对象存储中不可用。', 410);
    }
    if (!Buffer.isBuffer(content)) content = Buffer.from(content || []);
    await this.#record('project.export.downloaded', {
      targetId: row.projectId,
      detail: {
        projectId: row.projectId,
        exportId: row.id,
        planVersion: row.planVersion,
        fileName: row.fileName,
        bytes: content.length,
      },
      context,
    });
    return { export: publicExport(row), content };
  }
}

// ---- PostgreSQL 仓储 ----

function exportFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planVersion: row.plan_version,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    fileName: row.file_name,
    objectKey: row.object_key,
    contentType: row.content_type,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    zipSha256: row.zip_sha256,
    manifestSha256: row.manifest_sha256,
    manifest: isObject(row.manifest) ? row.manifest : {},
    items: Array.isArray(row.items) ? row.items : [],
    missing: Array.isArray(row.missing) ? row.missing : [],
    itemCount: row.item_count ?? 0,
    missingCount: row.missing_count ?? 0,
    chargeCents: Number(row.charge_cents ?? 0),
    errorCode: row.error_code,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

const INSERT_EXPORT = `
  INSERT INTO sj_project_exports (
    id, workspace_id, project_id, plan_version, idempotency_key, request_hash,
    status, content_type, manifest, items, missing, item_count, missing_count,
    charge_cents, created_by, created_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING *`;

export class PgExportRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async getProjectPlan({ workspaceId, projectId, planVersion = null }) {
    const row = (await this.pool.query(
      `SELECT p.id AS project_id, p.workspace_id, p.name AS project_name, p.product_id,
              p.sku_id, p.sku_spec, NULL::jsonb AS project_sku_snapshot,
              p.current_plan_version, p.status AS project_status,
              pl.id AS plan_id, pl.version AS plan_version, pl.status AS plan_status,
              pl.deliverables, pl.product_version, pl.product_snapshot, pl.sku_snapshot,
              pl.confirmed_at
       FROM sj_projects p
       LEFT JOIN sj_project_plans pl
         ON pl.project_id = p.id
        AND pl.version = COALESCE($3::integer, p.current_plan_version)
       WHERE p.id = $1 AND p.workspace_id = $2`,
      [projectId, workspaceId, planVersion],
    )).rows[0];
    if (!row) return { project: null, plan: null };
    const project = {
      id: row.project_id,
      workspaceId: row.workspace_id,
      name: row.project_name,
      productId: row.product_id,
      skuId: row.sku_id,
      skuSpec: row.sku_spec,
      skuSnapshot: row.project_sku_snapshot,
      currentPlanVersion: row.current_plan_version,
      status: row.project_status,
    };
    if (!row.plan_id) return { project, plan: null };
    return {
      project,
      plan: {
        id: row.plan_id,
        version: row.plan_version,
        status: row.plan_status,
        deliverables: Array.isArray(row.deliverables) ? row.deliverables : [],
        productVersion: row.product_version,
        productSnapshot: row.product_snapshot,
        skuSnapshot: row.sku_snapshot,
        confirmedAt: row.confirmed_at,
      },
    };
  }

  async listApprovedVersions({ workspaceId, projectId, planVersion }) {
    const rows = (await this.pool.query(
      `SELECT v.id, v.workspace_id, v.project_id, v.plan_version, v.deliverable_id,
              v.version, v.asset_id, v.job_id, v.status, v.is_candidate,
              r.id AS review_id, r.reviewed_by, r.reviewed_at,
              a.id AS asset_row_id, a.object_key, a.filename AS asset_filename,
              a.content_type AS asset_content_type, a.bytes AS asset_bytes,
              a.file_available, a.source_type AS asset_source_type
       FROM sj_deliverable_versions v
       JOIN sj_deliverable_reviews r
         ON r.version_id = v.id
        AND r.status = 'approved'
        AND r.workspace_id = v.workspace_id
        AND r.project_id = v.project_id
        AND r.plan_version = v.plan_version
        AND r.deliverable_id = v.deliverable_id
       LEFT JOIN sj_assets a
         ON a.id = v.asset_id AND a.workspace_id = v.workspace_id
       WHERE v.workspace_id = $1 AND v.project_id = $2 AND v.plan_version = $3
         AND v.status = 'approved'
       ORDER BY v.deliverable_id, v.version DESC`,
      [workspaceId, projectId, planVersion],
    )).rows;
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      planVersion: row.plan_version,
      deliverableId: row.deliverable_id,
      version: row.version,
      assetId: row.asset_id,
      jobId: row.job_id,
      status: row.status,
      isCandidate: row.is_candidate,
      reviewId: row.review_id,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      asset: row.asset_row_id ? {
        id: row.asset_row_id,
        objectKey: row.object_key,
        filename: row.asset_filename,
        contentType: row.asset_content_type,
        bytes: row.asset_bytes === null || row.asset_bytes === undefined ? null : Number(row.asset_bytes),
        fileAvailable: row.file_available,
        sourceType: row.asset_source_type,
      } : null,
    }));
  }

  async findByIdempotency({ workspaceId, idempotencyKey }) {
    return exportFromRow((await this.pool.query(
      `SELECT * FROM sj_project_exports
       WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    )).rows[0]);
  }

  async reserve({ row }) {
    const inserted = exportFromRow((await this.pool.query(INSERT_EXPORT, [
      row.id, row.workspaceId, row.projectId, row.planVersion, row.idempotencyKey,
      row.requestHash, row.status, row.contentType, JSON.stringify(row.manifest || {}),
      JSON.stringify(row.items || []), JSON.stringify(row.missing || []),
      row.itemCount || 0, row.missingCount || 0, row.chargeCents || 0,
      row.createdBy, row.createdAt, row.updatedAt,
    ])).rows[0]);
    if (inserted) return { created: true, export: inserted };
    return {
      created: false,
      export: await this.findByIdempotency({
        workspaceId: row.workspaceId,
        idempotencyKey: row.idempotencyKey,
      }),
    };
  }

  async complete({ id, patch }) {
    const result = await this.pool.query(
      `UPDATE sj_project_exports SET
         status='completed', file_name=$2, object_key=$3, content_type=$4, bytes=$5,
         zip_sha256=$6, manifest_sha256=$7, manifest=$8::jsonb, items=$9::jsonb,
         missing=$10::jsonb, item_count=$11, missing_count=$12, completed_at=$13,
         updated_at=$13
       WHERE id=$1 AND status='building'
       RETURNING *`,
      [
        id, patch.fileName, patch.objectKey, patch.contentType, patch.bytes,
        patch.zipSha256, patch.manifestSha256, JSON.stringify(patch.manifest || {}),
        JSON.stringify(patch.items || []), JSON.stringify(patch.missing || []),
        patch.itemCount || 0, patch.missingCount || 0, patch.completedAt,
      ],
    );
    return exportFromRow(result.rows[0]);
  }

  async fail({ id, errorCode, now }) {
    const result = await this.pool.query(
      `UPDATE sj_project_exports
       SET status='failed', error_code=$2, updated_at=$3
       WHERE id=$1 AND status='building'
       RETURNING *`,
      [id, errorCode, now],
    );
    return exportFromRow(result.rows[0]);
  }

  async getExport({ workspaceId, id }) {
    return exportFromRow((await this.pool.query(
      `SELECT * FROM sj_project_exports WHERE id=$1 AND workspace_id=$2`,
      [id, workspaceId],
    )).rows[0]);
  }

  async listExports({ workspaceId, projectId, limit = 50, offset = 0 }) {
    const [rows, total] = await Promise.all([
      this.pool.query(
        `SELECT * FROM sj_project_exports
         WHERE workspace_id=$1 AND project_id=$2
         ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [workspaceId, projectId, limit, offset],
      ),
      this.pool.query(
        `SELECT count(*)::int AS n FROM sj_project_exports
         WHERE workspace_id=$1 AND project_id=$2`,
        [workspaceId, projectId],
      ),
    ]);
    return { exports: rows.rows.map(exportFromRow), total: total.rows[0].n };
  }
}

// ---- 私有导出桶（shangjing-exports） ----

export class MinioExportStore {
  constructor(env = process.env) {
    this.bucket = EXPORT_BUCKET;
    this.client = createMinioClient(env).client;
  }

  async put(key, data, contentType = 'application/zip') {
    await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': contentType });
    return { key, bytes: data.length };
  }

  async get(key) {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_EXPORT_TOTAL_BYTES + 1024) {
        stream.destroy?.();
        throw new AppError('EXPORT_TOO_LARGE', '导出文件超过大小限制。', 413);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
