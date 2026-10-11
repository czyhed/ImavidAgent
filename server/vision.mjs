import { AppError } from './errors.mjs';

// Vision capability boundary (Issue #10). The provider and model for
// `vision.analyze` are still undecided (Q-02), so this module only defines the
// adapter contract and a registry. No supplier endpoint, key or SDK lives here.
//
// Adapter contract:
//   {
//     id: string,
//     async analyze({ images, workspaceId, locale }) {
//       return { observations: [observation, ...] };
//     }
//   }
// An observation describes what one screenshot shows:
//   {
//     fields: { name, originalTitle, brand, category, description }, // each
//             // { value, confidence: 0..1, evidence: [{ imageSha256, quote, region }] }
//     sku: {
//       spec: { value, confidence, evidence },
//       price: { amount|min|max, currency, type, condition, confidence, evidence },
//       parameters: [{ name, value, unit, confidence, evidence }]
//     }
//   }
// Everything an adapter returns is untrusted input: intake-screenshot.mjs
// validates the structure, drops fields without evidence and never executes
// text from a screenshot as instructions.
export const VISION_CAPABILITY = 'vision.analyze';
export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

function invalidAdapter(message) {
  throw new AppError('VISION_ADAPTER_INVALID', message, 500);
}

export class VisionAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(id, adapter) {
    if (typeof id !== 'string' || !ADAPTER_ID_PATTERN.test(id)) {
      invalidAdapter('视觉适配器 ID 需为 2–40 位小写字母、数字或连字符，并以字母开头。');
    }
    if (!adapter || typeof adapter.analyze !== 'function') {
      invalidAdapter(`视觉适配器 ${id} 必须实现 analyze()。`);
    }
    if (this.adapters.has(id)) invalidAdapter(`视觉适配器 ${id} 已注册。`);
    this.adapters.set(id, adapter);
    return this;
  }

  list() {
    return [...this.adapters.keys()].sort();
  }

  has(id) {
    return this.adapters.has(id);
  }

  // Resolves the adapter to use without throwing, so preflight can report
  // "not configured" instead of failing the cost disclosure step.
  resolve(preferred) {
    if (preferred !== undefined && preferred !== null) {
      return this.adapters.has(preferred) ? preferred : null;
    }
    const ids = this.list();
    return ids.length === 1 ? ids[0] : null;
  }

  async analyze({ adapter, images, workspaceId, locale }) {
    const id = this.resolve(adapter);
    if (!id) {
      if (!this.adapters.size) {
        throw new AppError(
          'VISION_NOT_CONFIGURED',
          '视觉模型供应商与模型尚未确认（Q-02），截图识别暂不可用。截图未发送给任何供应商，也未产生费用。',
          503,
        );
      }
      throw new AppError('VISION_ADAPTER_REQUIRED', '已注册多个视觉适配器，请明确指定本次使用的适配器。', 409);
    }
    const result = await this.adapters.get(id).analyze({
      images: images.map(image => ({
        sha256: image.sha256,
        objectKey: image.objectKey,
        contentType: image.contentType,
        sizeBytes: image.sizeBytes,
      })),
      workspaceId,
      locale: locale || 'zh-CN',
    });
    return { adapterId: id, result };
  }
}

export function createVisionRegistry(entries = []) {
  const registry = new VisionAdapterRegistry();
  for (const entry of entries) registry.register(entry.id, entry);
  return registry;
}
