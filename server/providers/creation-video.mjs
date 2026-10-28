import { AppError } from '../errors.mjs';
import { normalizeVideoParameters, VIDEO_RESOLUTIONS, VIDEO_RATIOS, MEDIA_BYTE_LIMITS } from '../../shared/creation-video-parameters.mjs';
import { requestJson, usageRecord, sourceData, downloadMedia, VIDEO_SUBMIT_TIMEOUT_MS } from './creation-http.mjs';
function videoChannel(channel,model) {
  if(model.adapter!=='minimax-h3'&&model.executorConfig?.video!=='minimax-h3')throw new AppError('MODEL_INCOMPATIBLE','视频模型没有兼容的执行器。',422);
  return {...channel,adapter:'minimax-h3',baseUrl:model.executorConfig?.videoBaseUrl||channel.baseUrl};
}
// H3 状态：scheduled / moderating 仍在平台内处理，按运行中；blocked 为审核未通过，按失败处理并保留平台原因。
const STATUS_MAP={queued:'queued',running:'running',scheduled:'running',moderating:'running',succeeded:'succeeded',failed:'failed',cancelled:'cancelled',blocked:'failed'};
async function videoResult(transport,response,upstreamId) {
  const task=response.task||response;
  const id=task.id||task.task_id||upstreamId;
  if(!id)throw new AppError('PROVIDER_TRANSPORT_UNKNOWN','供应商未返回任务编号。',502);
  const status=STATUS_MAP[task.status]||'unknown';
  const result={status,upstreamId:id,usage:usageRecord(task.usage),estimatedRemainingSeconds:Number.isFinite(task.estimated_remaining_seconds)?task.estimated_remaining_seconds:null};
  if(status==='succeeded'){
    if(typeof task.content?.url!=='string')throw new AppError('PROVIDER_RESPONSE_INVALID','成功任务缺少结果地址，请恢复原任务。',502);
    Object.assign(result,await downloadMedia(transport,task.content.url,'video'));
  }
  if(task.status==='blocked'){
    const reason=typeof task.error?.message==='string'?task.error.message.trim().slice(0,300):'';
    result.error={code:'CONTENT_BLOCKED',message:reason?`内容审核未通过：${reason}`:'内容审核未通过，请调整提示词或素材后重试。'};
  }else if(status==='failed')result.error={code:'PROVIDER_GENERATION_FAILED',message:'供应商视频任务失败，请核对后手动重试。'};
  return result;
}
const ROLE_KIND={first_frame:'image',last_frame:'image',reference_image:'image',reference_video:'video',reference_audio:'audio'};
const ROLE_ELEMENT={image:'image_url',video:'video_url',audio:'audio_url'};
// 旧运行只有单张首帧图：统一视作 first_frame。
export function videoMediaOf(snapshot) {
  if(Array.isArray(snapshot.media))return snapshot.media;
  return snapshot.sourceImage?[{role:'first_frame',kind:'image',...snapshot.sourceImage}]:[];
}
export function inferVideoMode(snapshot,media=videoMediaOf(snapshot)) {
  if(['text','frames','reference'].includes(snapshot.videoMode))return snapshot.videoMode;
  return media.some(m=>['first_frame','last_frame'].includes(m.role))?'frames':'text';
}
// 按方式与数量校验素材组合；preview 与执行前共用同一套规则，返回中文原因或 null。
export function videoMediaIssue(mode,media) {
  const count=role=>media.filter(m=>m.role===role).length;
  const frames=count('first_frame')+count('last_frame'),refs=count('reference_image')+count('reference_video')+count('reference_audio');
  if(media.some(m=>ROLE_KIND[m.role]!==m.kind))return '素材类型与用途不匹配。';
  if(mode==='text')return media.length?'文生视频不能连接图片、视频或音频，请改用首尾帧或参考素材方式，或移除连线。':null;
  if(mode==='frames'){
    if(!frames)return '首尾帧方式需要连接首帧或尾帧图片。';
    if(refs)return '首尾帧方式不能连接参考图片、参考视频或参考音频。';
    if(count('first_frame')>1||count('last_frame')>1)return '首帧和尾帧各最多一张。';
    return null;
  }
  if(mode==='reference'){
    if(frames)return '参考素材方式不能连接首帧或尾帧。';
    if(count('reference_image')>9)return '参考图片最多 9 张。';
    if(count('reference_video')>3)return '参考视频最多 3 个。';
    if(count('reference_audio')>3)return '参考音频最多 3 个。';
    if(refs>12)return '参考素材合计最多 12 个。';
    if(!count('reference_image')&&!count('reference_video'))return count('reference_audio')?'参考音频不能单独使用，请同时连接参考图片或参考视频。':'参考素材方式需要至少一张参考图片或一个参考视频。';
    return null;
  }
  return '视频方式无效。';
}
export function validateVideoGeneration(snapshot,{hasSource}={}) {
  const {model}=snapshot,params=normalizeVideoParameters(snapshot.params);
  const invalid=message=>{throw new AppError('INVALID_VIDEO_PARAMETERS',message,422);};
  const media=videoMediaOf(snapshot),mode=inferVideoMode(snapshot,media);
  // 有 media 或旧首帧图时以素材为准；否则沿用调用方传入的 hasSource（仅参数预检用）。
  const source=Array.isArray(snapshot.media)||snapshot.sourceImage?media.some(m=>m.kind==='image'):(hasSource??false);
  if(!params||typeof params!=='object'||Array.isArray(params))invalid('视频参数需要有效的 JSON 对象。');
  if(params.duration!==undefined && (!Number.isInteger(params.duration)||params.duration<4||params.duration>30))invalid('视频时长需为 4-30 秒的整数。');
  if(params.resolution!==undefined&&!VIDEO_RESOLUTIONS.includes(params.resolution))invalid('视频分辨率无效。');
  if(params.ratio!==undefined&&!VIDEO_RATIOS.includes(params.ratio))invalid('视频比例无效。');
  if(params.ratio==='adaptive'&&!source)invalid('自适应比例需要来源图片。');
  for(const key of ['mute_audio','aigc_watermark','use_context_ir'])if(params[key]!==undefined&&typeof params[key]!=='boolean')invalid('视频开关参数必须为布尔值。');
  if(params.skill_id!==undefined&&(typeof params.skill_id!=='string'||!params.skill_id.trim()||params.use_context_ir!==true))invalid('Skill 需要有效编号并启用提示词优化。');
  const mediaIssue=Array.isArray(snapshot.media)||snapshot.videoMode?videoMediaIssue(mode,media):null;
  if(mediaIssue)invalid(mediaIssue);
  if(typeof snapshot.prompt!=='string'||snapshot.prompt.length>7000||!snapshot.prompt.trim()&&mode==='text'&&!source)invalid('视频提示词为空或超过 7000 字符。');
  videoChannel({},model);
  for(const item of media)if(item.bytes)checkMedia(item);
}
// 素材检查：图片按字节识别格式，视频 / 音频采用上传时已校验的 MIME。
function checkMedia(item) {
  const limit=MEDIA_BYTE_LIMITS[item.kind];
  if(item.kind==='image')return sourceData(item,limit);
  const bytes=item.bytes&&Buffer.from(item.bytes);
  if(!bytes?.length||bytes.length>limit||typeof item.mime!=='string'||!item.mime.startsWith(item.kind+'/'))throw new AppError('INVALID_SOURCE_MEDIA',`${item.kind==='video'?'视频':'音频'}素材缺失、格式无效或超过体积限制。`,422);
  return {bytes,mime:item.mime,dataUrl:null};
}
function mediaDataUrl(item) {
  const checked=checkMedia(item);
  return checked.dataUrl||'data:'+checked.mime+';base64,'+checked.bytes.toString('base64');
}
export async function submitVideo(transport,channel,snapshot) {
  validateVideoGeneration(snapshot);
  const {model}=snapshot,params=normalizeVideoParameters(snapshot.params);
  const content=[{type:'text',text:snapshot.prompt}];
  for(const item of videoMediaOf(snapshot)){
    const element=ROLE_ELEMENT[item.kind];
    content.push({type:element,[element]:{url:mediaDataUrl(item)},role:item.role});
  }
  const body={model:model.modelId,content,...Object.fromEntries(Object.entries(params).filter(([k])=>['duration','resolution','ratio','mute_audio','aigc_watermark','use_context_ir','skill_id'].includes(k)))};
  const response=await requestJson(transport,videoChannel(channel,model),'/minimax/v2/video_generation',{method:'POST',body,headers:{'Idempotency-Key':snapshot.requestKey},timeoutMs:VIDEO_SUBMIT_TIMEOUT_MS});
  // The documented create response contains only task_id; this confirms acceptance.
  if(response.task_id&&!response.status&&!response.task)response.status='queued';
  return videoResult(transport,response);
}
export async function pollVideo(transport,channel,snapshot,upstreamId,cancel=false) {
  const path=cancel?'/minimax/v2/video_generation/':'/minimax/v2/query/video_generation/';
  const response=await requestJson(transport,videoChannel(channel,snapshot.model),path+encodeURIComponent(upstreamId),{method:cancel?'DELETE':'GET'});
  return videoResult(transport,response,upstreamId);
}
// 积分余额：available_points 才是可用于创建新任务的积分，可能带两位小数。
export async function queryVideoBalance(transport,channel,model) {
  const data=await requestJson(transport,videoChannel(channel,model),'/minimax/v2/query/point_usage_summary');
  const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  const available=num(data?.available_points),reserved=num(data?.reserved_points),total=num(data?.total_points);
  if(available===null)throw new AppError('PROVIDER_RESPONSE_INVALID','积分余额响应无效。',502);
  return {available,reserved:reserved??0,total:total??available+(reserved??0)};
}
export async function queryVideoSkills(transport,channel,model) {
  const items=[];
  for(let page=1;page<=10;page++){
    const data=await requestJson(transport,videoChannel(channel,model),`/minimax/v2/skills?page_num=${page}&page_size=100`);
    if(!Array.isArray(data?.items))throw new AppError('PROVIDER_RESPONSE_INVALID','Skill 列表响应无效。',502);
    for(const item of data.items)if(typeof item?.id==='string'&&item.id)items.push({id:item.id,name:String(item.name||item.id).slice(0,200),description:typeof item.description==='string'?item.description.slice(0,500):'',official:item.official===true});
    if(data.items.length<100||items.length>=(Number.isFinite(data.total)?data.total:Infinity))break;
  }
  return items;
}
