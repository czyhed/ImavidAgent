import { AppError } from './errors.mjs';
import {
  normalizeBaseUrl, validateChannelName, validateApiKey, newChannelId,
} from './channels.mjs';
import { OpenAiCompatibleProvider } from './providers/openai.mjs';

function providerConfig(channel) {
  return {
    id: channel.id,
    name: channel.name,
    adapter: 'openai-compatible',
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    keyHint: channel.keyHint,
    source: 'database',
    deletable: true,
    enabled: channel.enabled !== false,
  };
}

export class ChannelManager {
  constructor(store, registry, providerFactory = config => new OpenAiCompatibleProvider(config)) {
    this.store = store;
    this.registry = registry;
    this.providerFactory = providerFactory;
  }

  async load() {
    const channels = await this.store.listSecrets();
    for (const channel of channels) this.registry.addProvider(providerConfig(channel));
  }

  async add(body) {
    const name = validateChannelName(body?.name);
    const baseUrl = normalizeBaseUrl(body?.baseUrl);
    const apiKey = validateApiKey(body?.apiKey);
    const id = newChannelId();
    const probe = this.providerFactory({ id, name, baseUrl, apiKey, adapter: 'openai-compatible' });
    let models;
    try {
      models = await probe.catalog();
    } catch (error) {
      const detail = error instanceof AppError ? error.message : '连接测试未通过。';
      throw new AppError('CHANNEL_TEST_FAILED', `连接测试失败：${detail}`, 422);
    }
    let channel;
    try {
      channel = await this.store.insert({ id, name, baseUrl, apiKey });
    } catch (error) {
      throw error;
    }
    try {
      this.registry.addProvider(providerConfig((await this.store.getSecret(id))));
      await this.registry.refreshProvider(id).catch(() => {});
    } catch (error) {
      await this.store.remove(id).catch(() => {});
      throw error;
    }
    return { channel, models, warning: models.length ? null : '渠道已连接，但没有识别到图像或视频模型。' };
  }

  async remove(id) {
    const channel = await this.store.get(id);
    if (!channel) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    await this.store.remove(id);
    this.registry.removeProvider(id);
    return channel;
  }

  async setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new AppError('INVALID_CHANNEL_STATE', '启用状态必须是布尔值。', 422);
    await this.store.get(id);
    const updated = await this.store.setEnabled(id, enabled);
    const channel = await this.store.getSecret(id);
    if (!channel) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    this.registry.removeProvider(id);
    // Keep disabled channels visible in the system page, but publish no models.
    this.registry.addProvider(providerConfig(channel));
    await this.registry.refreshProvider(id).catch(() => {});
    return updated;
  }
}
