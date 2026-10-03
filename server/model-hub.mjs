import { randomUUID, createHash } from 'node:crypto';
import { submitVideo, pollVideo, validateVideoGeneration, queryVideoBalance, queryVideoSkills } from './providers/creation-video.mjs';
import { generateImage } from './providers/creation-image.mjs';
import { completeText } from './providers/creation-text.mjs';
import { AppError } from './errors.mjs';
import { ChannelStore } from './channels.mjs';
import { discoverModels, secureTransport, sourceData, usageRecord } from './providers/creation-http.mjs';
import { synthesize, designVoice, downloadDemoAudio } from './providers/volc-tts.mjs';
import { VOLC_RESOURCES } from '../shared/creation-voice.mjs';

export class ModelHub {
  constructor(store, channels, { transport = secureTransport } = {}) {
    this.store = store; this.pool = store.pool; this.channels = channels; this.transport = transport;
  }
  async init({channels=[]}={}) {
    for(const config of channels) {
      const marker=await this.pool.query("SELECT 1 FROM sj_creation_audit WHERE workspace_id='system' AND action='model.bootstrap' AND detail->>'channelId'=$1",[config.id]);
      if(marker.rowCount)continue;
      if(!await this.channels.get(config.id))await this.channels.insert(config);
      for(const model of config.models||[]) {
        if(!(await this.catalog()).models.some(m=>m.channelId===config.id&&m.modelId===model.modelId))await this.configure(config.id,model.modelId,model);
      }
      for(const [stage,modelId] of Object.entries(config.defaults||{})) {
        if(!(await this.catalog()).defaults[stage])await this.setDefault(stage,config.id,modelId);
      }
      await this.pool.query("INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,'system','model.bootstrap',$2)",[randomUUID(),{channelId:config.id}]);
    }
    return this.catalog();
  }
  async sync(channelId) {
    const channel = await this.channels.getSecret(channelId);
    if (!channel) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    if (channel.adapter === 'volcengine-tts') throw new AppError('SYNC_NOT_SUPPORTED', '火山引擎语音渠道没有模型目录，不需要同步。', 422);
    const models = await discoverModels(this.transport, channel);
    const save=async hub=>{
      await hub.pool.query('UPDATE sj_channel_models SET available=false WHERE channel_id=$1 AND manual=false', [channelId]);
      for (const model of models) {
        await hub.pool.query(`INSERT INTO sj_channel_models(channel_id,model_id,name) VALUES($1,$2,$3) ON CONFLICT(channel_id,model_id) DO UPDATE SET available=true,name=excluded.name`, [channelId, model.id, model.name || model.id]);
      }
      return hub.catalog();
    };
    return this.transaction ? save(this) : this.inTransaction(save);
  }
  async catalog(client=this.pool) {
    const models = (await client.query('SELECT * FROM sj_channel_models ORDER BY channel_id,model_id')).rows.map(row => ({channelId:row.channel_id,modelId:row.model_id,name:row.name,enabled:row.enabled,capabilities:row.capabilities,available:row.available,manual:row.manual}));
    const channels = await this.channels.list(client);
    for (const model of models) {
      const channel = channels.find(c => c.id === model.channelId);
      model.channelEnabled = channel?.enabled === true;
      model.executorCapabilities = executorCapabilities(channel);
    }
    const defaults = Object.fromEntries((await client.query('SELECT * FROM sj_creation_defaults')).rows.map(r=>[r.stage,{channelId:r.channel_id,modelId:r.model_id}]));
    const result={models,defaults,channels};
    return {...result,etag:'"'+createHash('sha256').update(JSON.stringify(result)).digest('hex')+'"'};
  }
  async mutate(expected,fn) {
    if(!expected)throw new AppError('PRECONDITION_REQUIRED','请刷新模型配置后重试。',428);
    return this.inTransaction(async hub=>{
      if(expected!==(await hub.catalog()).etag)throw new AppError('REVISION_CONFLICT','模型配置已更新，请刷新；输入仍保留。',409);
      return fn(hub);
    });
  }
  async inTransaction(fn) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sj:model-hub:configuration'))");
      const scoped=new ModelHub({pool:client},new ChannelStore(client,this.channels.encryptionKey),{transport:this.transport});
      scoped.transaction=true;
      const result=await fn(scoped);await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async complete({stage,model,messages,system,workspaceId='local'}) {
    if(!['product','planning'].includes(stage))throw new AppError('INVALID_STAGE','文本调用环节无效。',422);
    const selected=await this.resolve(stage,model);
    if(messages?.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image'))&&!selected.capabilities.includes('vision'))throw new AppError('MODEL_INCOMPATIBLE','Vision capability is required for image messages.',422);
    const channel=await this.channels.getSecret(selected.channelId);
    const result=await completeText(this.transport,channel,selected,{messages,system});
    await this.pool.query("INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,$2,'model.complete',$3)",[randomUUID(),workspaceId,{stage,channelId:selected.channelId,modelId:selected.modelId,usage:result.usage}]);
    return result;
  }
  async usage(workspaceId='local') {
    return (await this.pool.query("SELECT id,detail,created_at FROM sj_creation_audit WHERE workspace_id=$1 AND action='model.complete' ORDER BY created_at DESC LIMIT 500",[workspaceId])).rows.map(row=>({id:row.id,...row.detail,createdAt:row.created_at}));
  }
  async validateGeneration(snapshot, client=this.pool,{parametersOnly=false}={}) {
    const model=snapshot.model?.adapter?snapshot.model:await this.resolve(snapshot.kind,snapshot.model,client);
    const channel=await this.executionChannel(model,client);
    if(!channel.enabled)throw new AppError('MODEL_UNAVAILABLE','渠道已停用，不能开始新调用。',422);
    if(snapshot.kind==='video')validateVideoGeneration({...snapshot,model},{hasSource:!!snapshot.sourceImage||(parametersOnly&&!!(snapshot.sourceAssetId||snapshot.sourceRunId))});
    else {
      if(snapshot.sourceImage)sourceData(snapshot.sourceImage);
      for(const image of snapshot.sourceImages||[])sourceData(image);
      if(snapshot.mask)sourceData(snapshot.mask);
    }
  }
  async submitGeneration(snapshot,client=this.pool) {
    const model=snapshot.model?.adapter?snapshot.model:await this.resolve(snapshot.kind,snapshot.model,client);
    const channel=await this.executionChannel(model,client);
    if(!channel.enabled)throw new AppError('MODEL_UNAVAILABLE','渠道已停用，不能开始新调用。',422);
    return snapshot.kind==='video'?submitVideo(this.transport,channel,{...snapshot,model}):generateImage(this.transport,channel,{...snapshot,model});
  }
  // 积分余额与 Skill 列表只对 MiniMax H3 视频渠道有效；错误信息不含密钥。
  async h3Target(channelId,client=this.pool) {
    const channel=await this.channels.getSecret(channelId,client);
    if(!channel)throw new AppError('CHANNEL_NOT_FOUND','渠道不存在。',404);
    if(channel.adapter!=='minimax-h3'&&channel.executorConfig?.video!=='minimax-h3')throw new AppError('MODEL_INCOMPATIBLE','该渠道不是 MiniMax H3 视频渠道。',422);
    return {channel,model:{adapter:'minimax-h3',executorConfig:channel.executorConfig}};
  }
  async videoBalance(channelId,client=this.pool) {
    const {channel,model}=await this.h3Target(channelId,client);
    try{return await queryVideoBalance(this.transport,channel,model);}
    catch(error){throw new AppError('VIDEO_BALANCE_UNAVAILABLE','积分余额查询失败，请稍后重试。',502);}
  }
  async videoSkills(channelId,client=this.pool) {
    const {channel,model}=await this.h3Target(channelId,client);
    try{return await queryVideoSkills(this.transport,channel,model);}
    catch(error){throw new AppError('VIDEO_SKILLS_UNAVAILABLE','Skill 列表查询失败，请稍后重试。',502);}
  }
  async executionChannel(model,client=this.pool) {
    const channel=await this.channels.getSecret(model.channelId,client);
    if(!channel)throw new AppError('CHANNEL_NOT_FOUND','渠道不存在，无法处理原任务。',422);
    if(model.baseUrl && model.baseUrl!==channel.baseUrl)throw new AppError('CHANNEL_CONFIGURATION_CHANGED','渠道地址已改变，请核实原任务；不会向旧地址发送新密钥。',422);
    return {...channel,adapter:model.adapter||channel.adapter,baseUrl:model.baseUrl||channel.baseUrl,executorConfig:model.executorConfig||channel.executorConfig};
  }
  async pollGeneration(snapshot, upstreamId,client=this.pool) {
    if(!upstreamId || snapshot.kind!=='video')return {status:'unknown',usage:{costMicros:null,currency:null}};
    return pollVideo(this.transport,await this.executionChannel(snapshot.model,client),snapshot,upstreamId);
  }
  async cancelGeneration(snapshot, upstreamId,client=this.pool) {
    if(!upstreamId || snapshot.kind!=='video')return {status:'unknown',usage:{costMicros:null,currency:null}};
    return pollVideo(this.transport,await this.executionChannel(snapshot.model,client),snapshot,upstreamId,true);
  }
  async configure(channelId, modelId, patch = {}) {
    validateModelId(modelId);
    if (!await this.channels.get(channelId)) throw new AppError('CHANNEL_NOT_FOUND','渠道不存在。',404);
    const existing = (await this.catalog()).models.find(m=>m.channelId===channelId&&m.modelId===modelId);
    const capabilities = patch.capabilities ?? existing?.capabilities ?? [];
    if (!Array.isArray(capabilities) || capabilities.some(c=>!CAPABILITIES.includes(c))) throw new AppError('INVALID_CAPABILITIES','请选择有效模型能力。',422);
    if (patch.enabled!==undefined && typeof patch.enabled!=='boolean') throw new AppError('INVALID_MODEL_CONFIG','启用状态需为布尔值。',422);
    const result = await this.pool.query(`INSERT INTO sj_channel_models(channel_id,model_id,name,enabled,capabilities,manual) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(channel_id,model_id) DO UPDATE SET enabled=excluded.enabled,capabilities=excluded.capabilities,name=excluded.name RETURNING *`,[channelId,modelId,String(patch.name||existing?.name||modelId).slice(0,300),patch.enabled??existing?.enabled??false,JSON.stringify([...new Set(capabilities)])]);
    return (await this.catalog()).models.find(m=>m.channelId===channelId&&m.modelId===result.rows[0].model_id);
  }
  // 语音环节：默认指向一个火山引擎语音渠道（渠道没有模型目录，model_id 固定为 'voice'）。
  async setVoiceDefault(channelId) {
    const channel=await this.channels.get(channelId);
    if(!channel)throw new AppError('CHANNEL_NOT_FOUND','渠道不存在。',404);
    if(channel.adapter!=='volcengine-tts')throw new AppError('MODEL_INCOMPATIBLE','语音环节只能选择火山引擎语音渠道。',422);
    await this.pool.query(`INSERT INTO sj_creation_defaults(stage,channel_id,model_id) VALUES('voice',$1,'voice') ON CONFLICT(stage) DO UPDATE SET channel_id=excluded.channel_id,model_id=excluded.model_id`,[channelId]);
    return {channelId,modelId:'voice',adapter:channel.adapter,executorConfig:channel.executorConfig};
  }
  // 新增火山语音渠道后，没有默认语音渠道时自动设为默认。
  async ensureVoiceDefault(channelId) {
    const existing=(await this.pool.query("SELECT 1 FROM sj_creation_defaults WHERE stage='voice'")).rowCount;
    if(!existing)await this.setVoiceDefault(channelId);
  }
  // 当前可用的语音渠道（含密钥，仅服务端内部使用）：优先默认环节，其次第一个启用的火山语音渠道。
  async voiceChannel(client=this.pool) {
    const preferred=(await client.query("SELECT channel_id FROM sj_creation_defaults WHERE stage='voice'")).rows[0]?.channel_id;
    let channel=preferred?await this.channels.getSecret(preferred,client):null;
    if(!channel||channel.adapter!=='volcengine-tts'){
      const found=(await this.channels.list(client)).find(c=>c.adapter==='volcengine-tts'&&c.enabled);
      channel=found?await this.channels.getSecret(found.id,client):null;
    }
    if(!channel||channel.adapter!=='volcengine-tts')throw new AppError('VOICE_NOT_CONFIGURED','请先在模型中心配置火山引擎语音渠道。',422);
    if(!channel.enabled)throw new AppError('VOICE_NOT_CONFIGURED','火山引擎语音渠道已停用，请在模型中心启用或新增渠道。',422);
    return channel;
  }
  async voiceConfigured(client=this.pool) {
    try{await this.voiceChannel(client);return true;}catch(error){if(error instanceof AppError)return false;throw error;}
  }
  // 连接测试只校验配置格式，不调用付费合成。
  async testVoiceChannel(channelId) {
    const channel=await this.channels.getSecret(channelId);
    if(!channel)throw new AppError('CHANNEL_NOT_FOUND','渠道不存在。',404);
    if(channel.adapter!=='volcengine-tts')throw new AppError('MODEL_INCOMPATIBLE','只有火山引擎语音渠道支持这项检查。',422);
    const resourceId=channel.executorConfig?.resourceId||'seed-tts-2.0';
    if(!VOLC_RESOURCES.includes(resourceId))throw new AppError('INVALID_EXECUTOR','资源 ID 需为 seed-tts-2.0 或 seed-icl-2.0。',422);
    if(typeof channel.apiKey!=='string'||channel.apiKey.length<8)throw new AppError('INVALID_API_KEY','API Key 格式不正确。',422);
    return {ok:true,resourceId,keyHint:channel.keyHint,message:'配置格式正确。为避免产生费用，这里不调用合成；可在项目的角色面板里试听一句确认。'};
  }
  async recordVoiceUsage(workspaceId,detail) {
    await this.pool.query("INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES($1,$2,'model.complete',$3)",[randomUUID(),workspaceId,detail]);
  }
  async synthesizeSpeech({workspaceId='local',...params}) {
    const channel=await this.voiceChannel();
    const result=await synthesize(this.transport,channel,{...params,resourceId:params.resourceId||channel.executorConfig?.resourceId});
    await this.recordVoiceUsage(workspaceId,{stage:'voice',channelId:channel.id,modelId:params.speaker,usage:usageRecord({text_words:result.textWords??[...String(params.text||'').trim()].length})});
    return result;
  }
  async designSpeech({workspaceId='local',...params}) {
    const channel=await this.voiceChannel();
    const result=await designVoice(this.transport,channel,params);
    await this.recordVoiceUsage(workspaceId,{stage:'voice-design',channelId:channel.id,modelId:params.speakerId,usage:usageRecord({design_calls:1})});
    return result;
  }
  downloadVoiceDemo(url) {return downloadDemoAudio(this.transport,url);}
  async setDefault(stage, channelId, modelId) {
    if(stage==='voice')return this.setVoiceDefault(channelId);
    const model=await this.resolve(stage,{channelId,modelId});
    await this.pool.query(`INSERT INTO sj_creation_defaults(stage,channel_id,model_id) VALUES($1,$2,$3) ON CONFLICT(stage) DO UPDATE SET channel_id=excluded.channel_id,model_id=excluded.model_id`,[stage,channelId,modelId]);
    return model;
  }
  async resolve(stage, selection,client=this.pool) {
    const required = STAGES[stage];
    if(!required) throw new AppError('INVALID_STAGE','模型环节无效。',422);
    const catalog=await this.catalog(client);
    const selected=selection||catalog.defaults[stage];
    if(!selected) throw new AppError('MODEL_NOT_CONFIGURED','请先配置此环节的默认模型。',422);
    const model=catalog.models.find(m=>m.channelId===selected.channelId&&m.modelId===selected.modelId);
    if(!model || !model.available || !model.channelEnabled) throw new AppError('MODEL_UNAVAILABLE','所选模型或渠道已不可用，请手动选择。',422);
    if(!model.enabled) throw new AppError('MODEL_DISABLED','所选模型未启用。',422);
    if(required.some(c=>!model.capabilities.includes(c)||!model.executorCapabilities.includes(c))) throw new AppError('MODEL_INCOMPATIBLE','模型能力或执行器与此环节不兼容。',422);
    const channel=catalog.channels.find(c=>c.id===model.channelId);
    return {channelId:model.channelId,modelId:model.modelId,name:model.name,capabilities:[...model.capabilities],baseUrl:channel.baseUrl,adapter:channel.adapter||'openai-compatible',executorConfig:channel.executorConfig||{}};
  }
}

const CAPABILITIES=['text','vision','image','video'];
const STAGES={product:['text'],planning:['text'],image:['image'],video:['video']};
function validateModelId(value) { if(typeof value!=='string'||!value.trim()||value.length>200||/[\r\n]/.test(value))throw new AppError('INVALID_MODEL_ID','模型 ID 需为 1–200 个字符。',422); }
function executorCapabilities(channel) {
 const adapter=channel?.adapter||'openai-compatible';
 if(adapter==='volcengine-tts')return ['voice'];
 const result=adapter==='anthropic'?['text','vision']:adapter==='minimax-h3'?['video']:['text','vision','image'];
 if(channel?.executorConfig?.video==='minimax-h3'&&!result.includes('video'))result.push('video');
 return result;
}
