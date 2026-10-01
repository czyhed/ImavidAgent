import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from './errors.mjs';
import { VOLC_BASE_URL, VOLC_RESOURCES } from '../shared/creation-voice.mjs';

const ALGORITHM = 'aes-256-gcm';
const CHANNEL_ID = /^ch_[0-9a-f]{16}$/;

export function normalizeBaseUrl(value, adapter = 'openai-compatible') {
  // 火山引擎语音渠道的地址固定，不接受自定义地址，避免密钥被发往别处。
  if (adapter === 'volcengine-tts') return VOLC_BASE_URL;
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new AppError('INVALID_BASE_URL', 'Base URL 格式不正确，请填写完整的 https 地址。', 422); }
  if (url.username || url.password) {
    throw new AppError('INVALID_BASE_URL', 'Base URL 不能包含用户名或密码。', 422);
  }
  if (url.search || url.hash) {
    throw new AppError('INVALID_BASE_URL', 'Base URL 不能包含查询参数或锚点。', 422);
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new AppError('INVALID_BASE_URL', '模型渠道必须使用 https；本机服务可使用 http://localhost。', 422);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (adapter !== 'minimax-h3' && !/\/v1$/.test(path)) path += '/v1';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function validateChannelName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 40) throw new AppError('INVALID_CHANNEL_NAME', '渠道名称需为 1–40 个字符。', 422);
  return name;
}

export function validateApiKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 500 || /[\r\n]/.test(key)) {
    throw new AppError('INVALID_API_KEY', 'API Key 格式不正确。', 422);
  }
  return key;
}

export function newChannelId() {
  return 'ch_' + randomBytes(8).toString('hex');
}

export function loadEncryptionKey(root = process.cwd(), env = process.env) {
  if (env.CHANNEL_ENCRYPTION_KEY) {
    const key = Buffer.from(env.CHANNEL_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) {
      throw new AppError('CHANNEL_KEY_INVALID', 'CHANNEL_ENCRYPTION_KEY 必须是 32 字节的 base64。', 500);
    }
    return key;
  }
  const file = join(root, '.secrets', 'channel-encryption.key');
  if (existsSync(file)) {
    const key = readFileSync(file);
    if (key.length !== 32) {
      throw new AppError('CHANNEL_KEY_INVALID', '渠道加密密钥文件长度不正确，请恢复备份，不要直接覆盖。', 500);
    }
    return key;
  }
  const key = randomBytes(32);
  // The private directory is Git-ignored. Never expose this key through HTTP.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function encryptSecret(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(key, row) {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError('CHANNEL_KEY_UNREADABLE', '渠道密钥无法解密，请恢复 .secrets/channel-encryption.key 备份后重试。', 500);
  }
}

export class ChannelStore {
  constructor(pool, encryptionKey) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sj_model_channels (
        id text PRIMARY KEY,
        name text NOT NULL,
        adapter text NOT NULL DEFAULT 'openai-compatible',
        base_url text NOT NULL,
        key_ciphertext text NOT NULL,
        key_iv text NOT NULL,
        key_tag text NOT NULL,
        key_hint text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE sj_model_channels ADD COLUMN IF NOT EXISTS executor_config jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE sj_model_channels ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS sj_model_channels_created
      ON sj_model_channels (created_at);
    `);
  }

  publicRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      adapter: row.adapter,
      executorConfig: row.executor_config || {},
      revision: row.revision || 1,
      baseUrl: row.base_url,
      keyHint: row.key_hint,
      enabled: row.enabled,
      source: 'database',
      deletable: true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  secretRow(row) {
    return {
      ...this.publicRow(row),
      apiKey: decryptSecret(this.encryptionKey, {
        ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag,
      }),
    };
  }

  async list(client=this.pool) {
    return (await client.query('SELECT * FROM sj_model_channels ORDER BY created_at ASC')).rows.map(row => this.publicRow(row));
  }

  async listSecrets() {
    return (await this.pool.query('SELECT * FROM sj_model_channels ORDER BY created_at ASC')).rows.map(row => this.secretRow(row));
  }

  async get(id) {
    if (!CHANNEL_ID.test(String(id || ''))) return null;
    return this.publicRow((await this.pool.query('SELECT * FROM sj_model_channels WHERE id=$1', [id])).rows[0]);
  }

  async getSecret(id,client=this.pool) {
    if (!CHANNEL_ID.test(String(id || ''))) return null;
    const row = (await client.query('SELECT * FROM sj_model_channels WHERE id=$1', [id])).rows[0];
    return row ? this.secretRow(row) : null;
  }

  async insert({ id, name, baseUrl, apiKey, adapter = 'openai-compatible', executorConfig = {} }) {
    if (!CHANNEL_ID.test(id)) throw new AppError('INVALID_CHANNEL_ID', '渠道编号格式不正确。', 500);
    validateProtocol(adapter, executorConfig);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, adapter);
    const secret = encryptSecret(this.encryptionKey, apiKey);
    const result = await this.pool.query(`
      INSERT INTO sj_model_channels (id,name,base_url,key_ciphertext,key_iv,key_tag,key_hint,adapter,executor_config)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [id, name, normalizedBaseUrl, secret.ciphertext, secret.iv, secret.tag, '••••' + apiKey.slice(-4),adapter,JSON.stringify(executorConfig)]);
    return this.publicRow(result.rows[0]);
  }

  async update(id, patch = {}) {
    const current=await this.getSecret(id);
    if(!current)throw new AppError('CHANNEL_NOT_FOUND','渠道不存在。',404);
    const adapter=patch.adapter??current.adapter;
    const config=patch.executorConfig??current.executorConfig;validateProtocol(adapter,config);
    if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw new AppError('INVALID_CHANNEL','启用状态需为布尔值。',422);
    const name=validateChannelName(patch.name??current.name);
    const baseUrl=normalizeBaseUrl(patch.baseUrl??current.baseUrl,adapter);
    const apiKey=patch.apiKey===undefined?current.apiKey:validateApiKey(patch.apiKey);
    const secret=encryptSecret(this.encryptionKey,apiKey);
    const result=await this.pool.query(`UPDATE sj_model_channels SET name=$2,adapter=$3,base_url=$4,key_ciphertext=$5,key_iv=$6,key_tag=$7,key_hint=$8,executor_config=$9,enabled=$10,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,name,adapter,baseUrl,secret.ciphertext,secret.iv,secret.tag,'••••'+apiKey.slice(-4),JSON.stringify(config),patch.enabled??current.enabled]);
    return this.publicRow(result.rows[0]);
  }
  async setEnabled(id, enabled) {
    const result = await this.pool.query(
      'UPDATE sj_model_channels SET enabled=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
      [id, enabled],
    );
    if (!result.rows[0]) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    return this.publicRow(result.rows[0]);
  }

  async remove(id) {
    const result = await this.pool.query('DELETE FROM sj_model_channels WHERE id=$1 RETURNING *', [id]);
    if (!result.rows[0]) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    return this.publicRow(result.rows[0]);
  }
}

export function validateProtocol(adapter, config = {}) {
  if(!['openai-compatible','anthropic','minimax-h3','volcengine-tts'].includes(adapter)) throw new AppError('INVALID_PROTOCOL','请选择 OpenAI、Anthropic、MiniMax H3 或火山引擎语音协议。',422);
  if(adapter==='volcengine-tts'){
    if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>k!=='resourceId')) throw new AppError('INVALID_EXECUTOR','火山引擎语音渠道只能配置资源 ID。',422);
    if(config.resourceId!==undefined&&!VOLC_RESOURCES.includes(config.resourceId)) throw new AppError('INVALID_EXECUTOR','资源 ID 需为 seed-tts-2.0 或 seed-icl-2.0。',422);
    return config;
  }
  if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>!['video','editTransport','videoBaseUrl','pointPrices'].includes(k))) throw new AppError('INVALID_EXECUTOR','执行器配置无效。',422);
  if(config.video && config.video!=='minimax-h3')throw new AppError('INVALID_EXECUTOR','视频执行器仅支持 MiniMax H3。',422);
  if(config.editTransport && !['multipart','json-data-url'].includes(config.editTransport))throw new AppError('INVALID_EXECUTOR','改图传输方式无效。',422);
  if(config.videoBaseUrl)normalizeBaseUrl(config.videoBaseUrl,'minimax-h3');
  if(config.pointPrices!==undefined){const prices=config.pointPrices;if(!prices||typeof prices!=='object'||Array.isArray(prices)||Object.entries(prices).some(([k,v])=>!['480P','768P','1080P','2K','4K'].includes(k)||typeof v!=='number'||!Number.isFinite(v)||v<0))throw new AppError('INVALID_EXECUTOR','积分单价需为分辨率到非负数字的映射。',422);}
  return config;
}
