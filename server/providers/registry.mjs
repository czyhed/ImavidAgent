import { OmyaiProvider } from './omyai.mjs';
import { OpenAiCompatibleProvider } from './openai.mjs';
import { AppError } from '../errors.mjs';

// New protocols register a separate adapter. Frontend and task storage keep one contract.
export const adapterFactories = {
  'omyai-mcp': config => new OmyaiProvider(config),
  'openai-compatible': config => new OpenAiCompatibleProvider(config),
};

export class ProviderRegistry {
  constructor(config, factories = adapterFactories) {
    this.factories = factories;
    this.providers = new Map();
    this.models = [];
    this.statuses = [];
    this.checkedAt = null;
    for (const provider of config.providers || []) this.addProvider(provider);
  }

  addProvider(config) {
    if (!config?.id || this.providers.has(config.id)) {
      throw new AppError('PROVIDER_CONFIG', '渠道配置包含重复 ID。', 500);
    }
    const factory = this.factories[config.adapter];
    if (!factory) throw new AppError('PROVIDER_CONFIG', '渠道配置包含未知适配器。', 500);
    this.providers.set(config.id, factory(config));
  }

  removeProvider(id) {
    this.providers.delete(id);
    this.models = this.models.filter(model => model.providerId !== id);
    this.statuses = this.statuses.filter(status => status.id !== id);
    this.checkedAt = Date.now();
  }

  status(provider, connected, modelCount) {
    const config = provider.config;
    return {
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl || config.endpoint || '',
      keyHint: config.keyHint || '服务端配置',
      source: config.source || 'config',
      deletable: Boolean(config.deletable),
      enabled: config.enabled !== false,
      connected,
      modelCount,
    };
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async load() {
    const results = await Promise.all([...this.providers].map(async ([id, provider]) => {
      if (provider.config.enabled === false) {
        return { models: [], status: this.status(provider, false, 0) };
      }
      try {
        const models = await provider.catalog();
        return { models, status: this.status(provider, true, models.length) };
      } catch {
        return { models: [], status: this.status(provider, false, 0) };
      }
    }));
    this.models = results.flatMap(result => result.models);
    this.statuses = results.map(result => result.status);
    this.checkedAt = Date.now();
    return this.publicCatalog();
  }

  async refreshProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    this.models = this.models.filter(model => model.providerId !== id);
    this.statuses = this.statuses.filter(status => status.id !== id);
    if (provider.config.enabled === false) {
      this.statuses.push(this.status(provider, false, 0));
      this.checkedAt = Date.now();
      return this.publicCatalog();
    }
    try {
      const models = await provider.catalog();
      this.models.push(...models);
      this.statuses.push(this.status(provider, true, models.length));
      return this.publicCatalog();
    } catch (error) {
      this.statuses.push(this.status(provider, false, 0));
      throw error;
    } finally {
      this.checkedAt = Date.now();
    }
  }

  publicCatalog() {
    return { models: this.models, providers: this.statuses, checkedAt: this.checkedAt };
  }

  async resolve(id) {
    if (!this.checkedAt || Date.now() - this.checkedAt > 60_000) await this.refresh();
    const model = this.models.find(item => item.id === id);
    if (!model) throw new AppError('MODEL_UNAVAILABLE', '模型不可用，请刷新模型列表后重新选择。', 422);
    if (model.executable === false || !model.operations.length) {
      throw new AppError('MODEL_NOT_EXECUTABLE', '该模型只同步了目录，执行器尚未接入。', 422);
    }
    return model;
  }
}
