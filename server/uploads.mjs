import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { crc32, inflateSync } from 'node:zlib';
import { Client } from 'minio';
import { AppError } from './errors.mjs';

// Product original images and source screenshots are separate inputs:
// originals may become model input after a verified handoff protocol exists;
// screenshots are recognition evidence only (see GLOSSARY.md).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 8192;
export const MAX_PIXELS = 16_000_000;
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
export const IMAGE_KINDS = ['original', 'screenshot'];
export const DEFAULT_WORKSPACE_ID = 'local';
export const PRODUCT_IMAGE_BUCKET = 'shangjing-assets';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PROTOCOL = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Non-paid capability evidence gathered on 2026-10-21:
// - https://docs.omyai.vip/docs/guide/image-mcp/ documents generate_image, edit_image,
//   get_image_result, list_image_models and list_image_versions only.
// - edit_image requires source_job_id from a successful OMYAI MCP job; the docs state
//   "本地图片上传暂未开放" (local image upload is not open yet).
// - tools/list for the configured key exposes no image/file/base64/multipart input.
// - The public gateway documentation lists https://omyai.vip/v1 but no /images/edits.
// Therefore no arbitrary product image can be handed to OMYAI yet. The gate below stays
// closed until a real, evidence-backed verification row exists.
export const PROVIDER_INPUT_CAPABILITIES = Object.freeze({
  omyai: Object.freeze({
    adapter: 'omyai-mcp',
    arbitraryImageInput: false,
    documentedImageInput: 'source_job_id',
    localUploadDocumented: false,
    verified: false,
    reason: 'OMYAI MCP 只接受已成功任务的 source_job_id；本地图片上传暂未开放，MCP 渠道保持禁用。',
    checkedAt: '2026-10-21',
  }),
  'omyai-openai': Object.freeze({
    adapter: 'openai-compatible',
    arbitraryImageInput: true,
    documentedImageInput: 'multipart_image',
    localUploadDocumented: true,
    verified: true,
    protocol: 'openai-images-edits-v1',
    reason: '官方 OpenAI 标准 /images/edits 支持上传图片；OMYAI 网关要求 JSON base64 data URL，适配器已按该传输实现。',
    checkedAt: '2026-10-21',
  }),
});

function invalid(code, message, status = 422) {
  throw new AppError(code, message, status);
}

function assertDimension(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    invalid('INVALID_IMAGE', '图片尺寸无效。');
  }
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    invalid('IMAGE_DIMENSIONS', `商品图片至少为 ${MIN_DIMENSION}×${MIN_DIMENSION} 像素。`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    invalid('IMAGE_DIMENSIONS', `商品图片单边不能超过 ${MAX_DIMENSION} 像素。`);
  }
  if (width * height > MAX_PIXELS) {
    invalid('IMAGE_DIMENSIONS', '商品图片像素总量过大，请先压缩。');
  }
}

function pngChannels(colorType) {
  return { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 0;
}

function pngBitDepthValid(colorType, bitDepth) {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2) return [8, 16].includes(bitDepth);
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  if (colorType === 4 || colorType === 6) return [8, 16].includes(bitDepth);
  return false;
}

function inspectPng(data) {
  if (data.length < 8 + 25 + 12 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    invalid('INVALID_IMAGE', 'PNG 文件头无效。');
  }
  let offset = 8;
  let header = null;
  let sawEnd = false;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > MAX_UPLOAD_BYTES) invalid('INVALID_IMAGE', 'PNG 数据块长度异常。');
    const end = offset + 12 + length;
    if (end > data.length) invalid('INVALID_IMAGE', 'PNG 数据块被截断。');
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    const expected = crc32(data.subarray(offset + 4, offset + 8 + length)) >>> 0;
    const actual = data.readUInt32BE(offset + 8 + length);
    if (expected !== actual) invalid('INVALID_IMAGE', 'PNG 数据块校验失败。');
    if (!header) {
      if (type !== 'IHDR' || length !== 13) invalid('INVALID_IMAGE', 'PNG 缺少有效的 IHDR。');
      header = {
        width: chunk.readUInt32BE(0),
        height: chunk.readUInt32BE(4),
        bitDepth: chunk[8],
        colorType: chunk[9],
        compression: chunk[10],
        filter: chunk[11],
        interlace: chunk[12],
      };
    } else if (type === 'IHDR') {
      invalid('INVALID_IMAGE', 'PNG 包含重复的 IHDR。');
    }
    if (type === 'IDAT') compressed.push(chunk);
    if (type === 'IEND') {
      if (length !== 0) invalid('INVALID_IMAGE', 'PNG IEND 数据块无效。');
      sawEnd = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (!header || !compressed.length || !sawEnd) invalid('INVALID_IMAGE', 'PNG 结构不完整。');
  const channels = pngChannels(header.colorType);
  if (!channels || !pngBitDepthValid(header.colorType, header.bitDepth) ||
      header.compression !== 0 || header.filter !== 0 || ![0, 1].includes(header.interlace)) {
    invalid('INVALID_IMAGE', 'PNG 颜色或压缩参数不受支持。');
  }
  assertDimension(header.width, header.height);
  const rowBytes = Math.ceil(header.width * channels * header.bitDepth / 8);
  const expectedBytes = header.height * (rowBytes + 1);
  if (expectedBytes > MAX_INFLATED_BYTES) invalid('IMAGE_DIMENSIONS', 'PNG 解码后数据过大，请先压缩。');
  let raw;
  try {
    raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: MAX_INFLATED_BYTES });
  } catch {
    invalid('INVALID_IMAGE', 'PNG 压缩数据无法解码。');
  }
  if (header.interlace === 0 && raw.length !== expectedBytes) {
    invalid('INVALID_IMAGE', 'PNG 像素数据长度不正确。');
  }
  return { width: header.width, height: header.height };
}

function isStartOfFrame(marker) {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function inspectJpeg(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) invalid('INVALID_IMAGE', 'JPEG 文件头无效。');
  let offset = 2;
  let frame = null;
  let sawScan = false;
  let sawEnd = false;
  while (offset < data.length) {
    if (data[offset] !== 0xff) invalid('INVALID_IMAGE', 'JPEG 标记结构不正确。');
    while (data[offset] === 0xff) offset += 1;
    if (offset >= data.length) break;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0x00) {
      if (!sawScan) invalid('INVALID_IMAGE', 'JPEG 出现意外的零字节标记。');
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!sawScan) invalid('INVALID_IMAGE', 'JPEG 出现意外的重启标记。');
      continue;
    }
    if (marker === 0x01) continue;
    if (offset + 2 > data.length) invalid('INVALID_IMAGE', 'JPEG 段长度被截断。');
    const length = data.readUInt16BE(offset);
    if (length < 2) invalid('INVALID_IMAGE', 'JPEG 段长度无效。');
    const end = offset + length;
    if (end > data.length) invalid('INVALID_IMAGE', 'JPEG 数据段被截断。');
    if (isStartOfFrame(marker)) {
      if (length < 8) invalid('INVALID_IMAGE', 'JPEG 帧头无效。');
      const precision = data[offset + 2];
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      const components = data[offset + 7];
      if (![8, 12, 16].includes(precision) || components < 1 || components > 4) {
        invalid('INVALID_IMAGE', 'JPEG 帧参数不受支持。');
      }
      frame = { width, height };
    }
    if (marker === 0xda) {
      sawScan = true;
      offset = end;
      // Entropy data escapes 0xFF as 0xFF00 and uses RSTn markers; any other marker
      // ends the scan. This validates the container without claiming a pixel decode.
      while (offset + 1 < data.length) {
        if (data[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = data[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (next === 0xff) {
          offset += 1;
          continue;
        }
        break;
      }
      continue;
    }
    offset = end;
  }
  if (!frame || !sawScan || !sawEnd) invalid('INVALID_IMAGE', 'JPEG 结构不完整或已截断。');
  assertDimension(frame.width, frame.height);
  return frame;
}

function inspectWebp(data) {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WEBP') {
    invalid('INVALID_IMAGE', 'WebP 文件头无效。');
  }
  const riffSize = data.readUInt32LE(4);
  if (riffSize + 8 > data.length) invalid('INVALID_IMAGE', 'WebP 数据被截断。');
  let offset = 12;
  let dimensions = null;
  let sawBitstream = false;
  while (offset + 8 <= data.length) {
    const fourcc = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size + (size % 2);
    if (start + size > data.length) invalid('INVALID_IMAGE', 'WebP 数据块被截断。');
    if (fourcc === 'VP8X') {
      if (size < 10) invalid('INVALID_IMAGE', 'WebP VP8X 块无效。');
      dimensions = {
        width: 1 + data.readUIntLE(start + 4, 3),
        height: 1 + data.readUIntLE(start + 7, 3),
      };
    } else if (fourcc === 'VP8 ') {
      if (size < 10 || data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) {
        invalid('INVALID_IMAGE', 'WebP VP8 图像数据无效。');
      }
      const width = data.readUInt16LE(start + 6) & 0x3fff;
      const height = data.readUInt16LE(start + 8) & 0x3fff;
      if (!dimensions) dimensions = { width, height };
      sawBitstream = true;
    } else if (fourcc === 'VP8L') {
      if (size < 5 || data[start] !== 0x2f) invalid('INVALID_IMAGE', 'WebP VP8L 图像数据无效。');
      const bits = data.readUInt32LE(start + 1);
      const width = 1 + (bits & 0x3fff);
      const height = 1 + ((bits >>> 14) & 0x3fff);
      if (!dimensions) dimensions = { width, height };
      sawBitstream = true;
    } else if (fourcc === 'ANMF') {
      sawBitstream = true;
    }
    offset = end;
  }
  if (!dimensions || !sawBitstream) invalid('INVALID_IMAGE', 'WebP 缺少可识别的主图数据。');
  assertDimension(dimensions.width, dimensions.height);
  return dimensions;
}

// Format is decided by the bytes, never by the client Content-Type header.
export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) invalid('INVALID_IMAGE', '请上传图片文件。');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AppError('IMAGE_TOO_LARGE', `商品图片不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB。`, 413);
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { contentType: 'image/png', extension: 'png', bytes: buffer.length, ...inspectPng(buffer) };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { contentType: 'image/jpeg', extension: 'jpg', bytes: buffer.length, ...inspectJpeg(buffer) };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp', bytes: buffer.length, ...inspectWebp(buffer) };
  }
  throw new AppError('UNSUPPORTED_IMAGE_TYPE', '仅支持 PNG、JPEG 和 WebP 图片。', 415);
}

function requireObject(value, label = '请求体') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_BODY', `${label}必须是 JSON 对象。`);
  }
}

function rejectUnknown(body, allowed, label) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new AppError('INVALID_FIELD', `${label}包含不支持的字段：${key}。`);
  }
}

function uuid(value, code, message) {
  const text = String(value || '');
  if (!UUID.test(text)) throw new AppError(code, message, 404);
  return text;
}

export function assertImageId(value) {
  return uuid(value, 'IMAGE_NOT_FOUND', '商品图片不存在。');
}

export function assertProductId(value) {
  return uuid(value, 'PRODUCT_NOT_FOUND', '商品不存在。');
}

export function normalizeUploadQuery(query = {}) {
  requireObject(query, '上传参数');
  rejectUnknown(query, ['productId', 'kind'], '上传参数');
  if (!IMAGE_KINDS.includes(query.kind)) {
    throw new AppError('INVALID_IMAGE_KIND', '图片类型只能是原图或来源截图。');
  }
  const kind = query.kind;
  const hasProduct = query.productId !== undefined && query.productId !== null && query.productId !== '';
  // Screenshots may be uploaded before a product exists; originals always belong to one.
  if (kind === 'original' && !hasProduct) {
    throw new AppError('PRODUCT_REQUIRED', '商品原图必须绑定商品。');
  }
  return {
    productId: hasProduct ? assertProductId(query.productId) : null,
    kind,
  };
}

export function normalizeListQuery(query = {}) {
  requireObject(query, '查询参数');
  rejectUnknown(query, ['productId', 'kind', 'limit', 'offset'], '查询参数');
  if (query.kind !== undefined && !IMAGE_KINDS.includes(query.kind)) {
    throw new AppError('INVALID_IMAGE_KIND', '图片类型只能是原图或来源截图。');
  }
  const integer = (value, fallback, min, max, label) => {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new AppError('INVALID_PAGINATION', `${label}必须是 ${min}–${max} 的整数。`);
    }
    return number;
  };
  return {
    productId: query.productId === undefined || query.productId === ''
      ? null : assertProductId(query.productId),
    kind: query.kind || null,
    limit: integer(query.limit, 20, 1, 100, '每页数量'),
    offset: integer(query.offset, 0, 0, 1_000_000, '分页偏移'),
  };
}

function imageFromRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    kind: row.kind,
    objectKey: row.object_key,
    contentType: row.content_type,
    extension: row.extension,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export function publicImage(image) {
  return {
    id: image.id,
    productId: image.productId,
    kind: image.kind,
    contentType: image.contentType,
    extension: image.extension,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    createdAt: image.createdAt,
    // Private object storage keys never leave the server.
    url: `/api/product-images/${image.id}/file`,
  };
}

export class ProductImageService {
  constructor(repository, assets, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.repository = repository;
    this.assets = assets;
    this.workspaceId = workspaceId;
  }

  async upload(raw) {
    requireObject(raw);
    rejectUnknown(raw, ['productId', 'kind', 'data'], '上传请求');
    const { productId, kind } = normalizeUploadQuery({ productId: raw.productId, kind: raw.kind });
    if (!Buffer.isBuffer(raw.data)) {
      throw new AppError('BINARY_REQUIRED', '商品图片需以原始二进制上传。', 415);
    }
    const inspected = inspectImage(raw.data);
    if (productId && !(await this.repository.productExists(productId))) {
      throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。', 404);
    }
    const id = randomUUID();
    const folder = kind === 'original' ? 'originals' : 'screenshots';
    // The server alone derives the object key. Client paths, buckets and keys are never accepted.
    // An unbound screenshot has no product directory yet; it still lands under `screenshots/`
    // and is bound to the product only after intake succeeds (Issue #23).
    const objectKey = kind === 'original' || productId
      ? `products/${productId}/${folder}/${id}.${inspected.extension}`
      : `screenshots/${id}.${inspected.extension}`;
    const image = {
      id,
      workspaceId: this.workspaceId,
      productId,
      kind,
      objectKey,
      contentType: inspected.contentType,
      extension: inspected.extension,
      bytes: inspected.bytes,
      width: inspected.width,
      height: inspected.height,
      sha256: createHash('sha256').update(raw.data).digest('hex'),
      createdAt: new Date(),
    };
    let stored = false;
    try {
      await this.assets.put(objectKey, raw.data, inspected.contentType);
      stored = true;
      return await this.repository.insert(image);
    } catch (error) {
      // Do not leave an unreferenced private object behind when metadata insertion fails.
      if (stored && typeof this.assets.remove === 'function') {
        await this.assets.remove(objectKey).catch(() => {});
      }
      throw error;
    }
  }

  async get(id) {
    const image = await this.repository.get(assertImageId(id));
    if (!image) throw new AppError('IMAGE_NOT_FOUND', '商品图片不存在。', 404);
    return image;
  }

  async list(query = {}) {
    const filters = normalizeListQuery(query);
    const { images, total } = await this.repository.list(filters);
    return {
      images: images.map(publicImage),
      total,
      limit: filters.limit,
      offset: filters.offset,
      nextOffset: filters.offset + images.length < total ? filters.offset + images.length : null,
    };
  }

  async open(id) {
    const image = await this.get(id);
    const stream = await this.assets.get(image.objectKey);
    return { image, stream };
  }
}

function providerCapability(providerId) {
  return PROVIDER_INPUT_CAPABILITIES[providerId] || {
    adapter: null,
    arbitraryImageInput: false,
    documentedImageInput: null,
    localUploadDocumented: false,
    verified: false,
    reason: '该供应商没有已登记的原图接收能力证据。',
  };
}

export class ProductImageInputService {
  constructor(repository, assets) {
    this.repository = repository;
    this.assets = assets;
  }

  async status({ providerId } = {}) {
    if (providerId !== undefined && providerId !== null && !PROVIDER_ID.test(String(providerId))) {
      throw new AppError('INVALID_PROVIDER', '渠道编号格式不正确。');
    }
    const settings = await this.repository.getSettings();
    const target = providerId || settings?.providerId || null;
    const verification = target
      ? await this.repository.findVerification(target, settings?.protocol || null)
      : null;
    return {
      enabled: Boolean(settings?.enabled),
      verified: Boolean(verification),
      providerId: target,
      modelId: settings?.modelId || null,
      protocol: verification?.protocol || settings?.protocol || null,
      verification: verification ? {
        id: verification.id,
        providerId: verification.providerId,
        modelId: verification.modelId || null,
        protocol: verification.protocol,
        transport: verification.transport || null,
        verifiedAt: verification.verifiedAt || null,
        evidence: verification.evidence || {},
      } : null,
      providers: PROVIDER_INPUT_CAPABILITIES,
    };
  }

  async setEnabled(body = {}) {
    requireObject(body);
    rejectUnknown(body, ['enabled', 'providerId', 'modelId', 'protocol'], '原图输入设置');
    if (typeof body.enabled !== 'boolean') {
      throw new AppError('INVALID_FIELD', 'enabled 必须是布尔值。');
    }
    if (!body.enabled) {
      if (body.providerId !== undefined && body.providerId !== null &&
          !PROVIDER_ID.test(String(body.providerId))) {
        throw new AppError('INVALID_PROVIDER', '渠道编号格式不正确。');
      }
      await this.repository.saveSettings({
        enabled: false,
        providerId: body.providerId || null,
        modelId: body.modelId || null,
        protocol: body.protocol || null,
        verificationId: null,
      });
      return this.status(body.providerId ? { providerId: body.providerId } : {});
    }
    const providerId = String(body.providerId || '');
    if (!PROVIDER_ID.test(providerId)) throw new AppError('INVALID_PROVIDER', '启用原图输入需提供有效渠道编号。');
    if (body.modelId !== undefined && body.modelId !== null &&
        (typeof body.modelId !== 'string' || body.modelId.length > 150)) {
      throw new AppError('INVALID_MODEL', '模型编号格式不正确。');
    }
    const protocol = body.protocol === undefined || body.protocol === null ? null : String(body.protocol);
    if (protocol !== null && !PROTOCOL.test(protocol)) {
      throw new AppError('INVALID_PROTOCOL', '上传协议编号格式不正确。');
    }
    const verification = await this.repository.findVerification(providerId, protocol);
    if (!verification) {
      const capability = providerCapability(providerId);
      throw new AppError(
        'PRODUCT_IMAGE_INPUT_UNVERIFIED',
        `商品原图输入尚未验证，不能启用。${capability.reason}`,
        409,
      );
    }
    await this.repository.saveSettings({
      enabled: true,
      providerId,
      modelId: body.modelId || null,
      protocol: verification.protocol,
      verificationId: verification.id,
    });
    return this.status({ providerId });
  }

  async preflight(body = {}) {
    requireObject(body);
    rejectUnknown(body, ['imageId', 'providerId', 'modelId', 'operation', 'protocol'], '预检请求');
    const imageId = assertImageId(body.imageId);
    const providerId = String(body.providerId || '');
    if (!PROVIDER_ID.test(providerId)) throw new AppError('INVALID_PROVIDER', '请提供有效的渠道编号。');
    const operation = body.operation || 'edit';
    if (!['generate', 'edit'].includes(operation)) {
      throw new AppError('INVALID_OPERATION', '预检操作只能是生图或改图。');
    }
    if (body.modelId !== undefined && body.modelId !== null &&
        (typeof body.modelId !== 'string' || body.modelId.length > 150)) {
      throw new AppError('INVALID_MODEL', '模型编号格式不正确。');
    }
    const protocol = body.protocol === undefined || body.protocol === null ? null : String(body.protocol);
    if (protocol !== null && !PROTOCOL.test(protocol)) {
      throw new AppError('INVALID_PROTOCOL', '上传协议编号格式不正确。');
    }
    const image = await this.repository.get(imageId);
    if (!image) throw new AppError('IMAGE_NOT_FOUND', '商品图片不存在。', 404);
    if (image.kind !== 'original') {
      throw new AppError('SCREENSHOT_NOT_INPUT', '来源截图只作为识别证据，不能作为生成输入。', 422);
    }
    const verification = await this.repository.findVerification(providerId, protocol);
    if (!verification) {
      const capability = providerCapability(providerId);
      throw new AppError(
        'PRODUCT_IMAGE_INPUT_UNVERIFIED',
        `商品原图输入尚未通过真实验收，已拒绝提交。${capability.reason}`,
        409,
      );
    }
    const settings = await this.repository.getSettings();
    if (!settings?.enabled || settings.providerId !== providerId) {
      throw new AppError('PRODUCT_IMAGE_INPUT_DISABLED', '该渠道的商品原图输入未启用。', 409);
    }
    if (settings.verificationId && settings.verificationId !== verification.id) {
      throw new AppError('INPUT_VERIFICATION_MISMATCH', '当前启用记录与验证证据不一致，请重新核验。', 409);
    }
    if (settings.modelId && body.modelId && settings.modelId !== body.modelId) {
      throw new AppError('INPUT_MODEL_MISMATCH', '该渠道只对已验证的模型开放原图输入。', 409);
    }
    if (typeof this.assets.exists === 'function' && !(await this.assets.exists(image.objectKey))) {
      throw new AppError('IMAGE_MISSING', '商品图片文件已丢失，请重新上传。', 410);
    }
    return {
      allowed: true,
      image: publicImage(image),
      providerId,
      modelId: body.modelId || settings.modelId || null,
      operation,
      protocol: verification.protocol,
      transport: verification.transport || null,
      // Deliberately no MinIO URL or object key: the handoff, if ever enabled, is server-side.
      handoff: 'server-side',
    };
  }
}

export class ProductImageApi {
  constructor(repository, assets, { workspaceId } = {}) {
    this.repository = repository;
    this.assets = assets;
    this.images = new ProductImageService(repository, assets, {
      workspaceId: workspaceId || repository.workspaceId,
    });
    this.input = new ProductImageInputService(repository, assets);
    this.scopes = new Map();
  }

  // 登录启用后，任务、商品与图片都以会话工作空间为准；任务执行器读取原图时
  // 传入任务自身的工作空间，避免单工作空间实例把图片读成“不存在”。
  forWorkspace(workspaceId) {
    if (!workspaceId || workspaceId === this.images.workspaceId || !this.repository?.pool) return this;
    let scoped = this.scopes.get(workspaceId);
    if (!scoped) {
      const repository = new PgProductImageRepository(this.repository.pool, { workspaceId });
      scoped = new ProductImageApi(repository, this.assets, { workspaceId });
      scoped.scopes = this.scopes;
      this.scopes.set(workspaceId, scoped);
    }
    return scoped;
  }

  upload(args) { return this.images.upload(args); }
  get(id, workspaceId) { return this.forWorkspace(workspaceId).images.get(id); }
  list(query) { return this.images.list(query); }
  open(id, workspaceId) { return this.forWorkspace(workspaceId).images.open(id); }
  preflight(body) { return this.input.preflight(body); }
  status(query) { return this.input.status(query); }
  setEnabled(body) { return this.input.setEnabled(body); }
}

const INSERT_IMAGE = `
  INSERT INTO sj_product_images (
    id, workspace_id, product_id, kind, object_key, content_type, extension,
    bytes, width, height, sha256, created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  RETURNING *`;

export class PgProductImageRepository {
  constructor(pool, { workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async productExists(productId) {
    const row = (await this.pool.query(
      'SELECT 1 FROM sj_products WHERE id=$1 AND workspace_id=$2',
      [productId, this.workspaceId],
    )).rows[0];
    return Boolean(row);
  }

  async insert(image) {
    const row = (await this.pool.query(INSERT_IMAGE, [
      image.id, this.workspaceId, image.productId, image.kind, image.objectKey,
      image.contentType, image.extension, image.bytes, image.width, image.height,
      image.sha256, image.createdAt,
    ])).rows[0];
    return imageFromRow(row);
  }

  async get(id) {
    const row = (await this.pool.query(
      'SELECT * FROM sj_product_images WHERE id=$1 AND workspace_id=$2',
      [id, this.workspaceId],
    )).rows[0];
    return row ? imageFromRow(row) : null;
  }

  async list({ productId, kind, limit, offset }) {
    const where = ['workspace_id = $1'];
    const params = [this.workspaceId];
    if (productId) {
      params.push(productId);
      where.push(`product_id = $${params.length}`);
    }
    if (kind) {
      params.push(kind);
      where.push(`kind = $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const total = (await this.pool.query(
      `SELECT count(*)::int AS total FROM sj_product_images WHERE ${whereSql}`,
      params,
    )).rows[0].total;
    const rows = (await this.pool.query(
      `SELECT * FROM sj_product_images WHERE ${whereSql}
       ORDER BY created_at DESC, id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    )).rows;
    return { images: rows.map(imageFromRow), total };
  }

  async findVerification(providerId, protocol = null) {
    const read = workspaceId => this.pool.query(
      `SELECT * FROM sj_model_input_verifications
       WHERE workspace_id=$1 AND provider_id=$2 AND status='verified'
         AND ($3::text IS NULL OR protocol=$3)
       ORDER BY verified_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [workspaceId, providerId, protocol],
    );
    let row = (await read(this.workspaceId)).rows[0];
    // 协议登记是应用级证据（迁移 0017 落在 'local'），而不是每个工作空间的私有数据。
    // 登录开启后，新工作空间读不到登记会让原图输入永远无法启用；这里回退读取应用级登记。
    // 是否启用仍按工作空间保存在 sj_product_image_input_settings，互不影响。
    if (!row && this.workspaceId !== 'local') {
      row = (await read('local')).rows[0];
    }
    return row ? {
      id: row.id,
      providerId: row.provider_id,
      modelId: row.model_id,
      protocol: row.protocol,
      transport: row.transport,
      status: row.status,
      evidence: row.evidence,
      verifiedAt: row.verified_at,
    } : null;
  }

  async getSettings() {
    const row = (await this.pool.query(
      'SELECT * FROM sj_product_image_input_settings WHERE workspace_id=$1',
      [this.workspaceId],
    )).rows[0];
    return row ? {
      enabled: row.enabled,
      providerId: row.provider_id,
      modelId: row.model_id,
      protocol: row.protocol,
      verificationId: row.verification_id,
    } : null;
  }

  async saveSettings({ enabled, providerId, modelId, protocol, verificationId }) {
    await this.pool.query(
      `INSERT INTO sj_product_image_input_settings (
         workspace_id, enabled, provider_id, model_id, protocol, verification_id, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         enabled=EXCLUDED.enabled, provider_id=EXCLUDED.provider_id,
         model_id=EXCLUDED.model_id, protocol=EXCLUDED.protocol,
         verification_id=EXCLUDED.verification_id, updated_at=now()`,
      [this.workspaceId, enabled, providerId || null, modelId || null,
        protocol || null, verificationId || null],
    );
  }
}

export class MinioProductImageStore {
  constructor(env = process.env) {
    const endpoint = new URL(env.MINIO_ENDPOINT);
    if (endpoint.protocol !== 'https:') throw new AppError('TLS_REQUIRED', 'MinIO 必须使用 TLS。', 500);
    this.bucket = env.MINIO_BUCKET_ASSETS;
    if (this.bucket !== PRODUCT_IMAGE_BUCKET) {
      throw new AppError('BUCKET_CONFIG', `商品图片仅允许存入 ${PRODUCT_IMAGE_BUCKET}。`, 500);
    }
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: Number(endpoint.port || 443),
      useSSL: true,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      region: env.MINIO_REGION || 'us-east-1',
      transportAgent: new https.Agent({
        ca: readFileSync(env.MIDDLEWARE_CA_CERT), rejectUnauthorized: true,
      }),
    });
  }

  async put(key, data, contentType) {
    await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': contentType });
  }

  get(key) {
    return this.client.getObject(this.bucket, key);
  }

  async exists(key) {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch (error) {
      if (['NotFound', 'NoSuchKey', 'NoSuchObject'].includes(error?.code)) return false;
      throw error;
    }
  }

  async remove(key) {
    await this.client.removeObject(this.bucket, key);
  }
}
