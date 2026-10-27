import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
import { buildZip } from './export.mjs';
import { compileShotVideos } from './video-compile.mjs';
import { buildFilmCues, buildSrt, MAX_SRT_BYTES } from './subtitles.mjs';
import { withWorkflows, createWorkflow } from '../shared/creation-workflows.mjs';
import { normalizeVideoParameters, VIDEO_MODES, DUB_MODES, DIALOGUE_LANGUAGES, pointPricesFor, estimateDialogueSeconds, dialoguePromptSuffix } from '../shared/creation-video-parameters.mjs';
import { createMediaPrep, checkMediaLimits } from './media-prep.mjs';
import { videoMediaIssue, inferVideoMode } from './providers/creation-video.mjs';
import { createFrameExtractor } from './frame-extract.mjs';
import { CreationVoice, dubState, dialogueAudioStatus, dubSuggestion } from './creation-voice.mjs';
import { validateVoiceRoles } from '../shared/creation-voice.mjs';
import { checkVideoSettings, normalizeVideoSettings, effectiveVideoParams, SETTING_DEFAULTS } from '../shared/creation-video-settings.mjs';
import { SHOT_PLANNING_SYSTEM, MAX_PLAN_MATERIALS, materialsForModel, sanitizeShotPlan, previewShot } from './video-shot-plan.mjs';
const fail=(code,message,status=400)=>{throw new AppError(code,message,status);};
const clone=value=>JSON.parse(JSON.stringify(value));
const snapshot=product=>({id:product.id,revision:product.revision,name:product.name,facts:product.facts||{}});
const active=new Set(['queued','submitting','running','unknown','cancelling']);
const VIDEO_PLANNING_PARAMETERS='视频 params 使用 duration（4—30整数秒）、resolution（480P、768P、1080P、2K、4K）、ratio（16:9、9:16、1:1、4:3、3:4、21:9，或有首帧时 adaptive）。不要用像素尺寸或 aspectRatio 字段。视频节点另有 videoMode（text 文生视频、frames 首尾帧、reference 参考素材）：frames 只能连接首帧 first 与尾帧 last 图片，不能混用参考素材；reference 的参考图 refImage 最多 9 张、参考视频 refVideo 最多 3 个、参考音频 refAudio 最多 3 个，合计最多 12 个，参考音频不能单独使用，且不能连接首帧或尾帧；text 不连接任何素材。只有明确要求口型同步时才安排台词 dialogue。';
const editableKeys=['kind','title','prompt','params','model','productSnapshot','sourceAssetId','sourceRunId','sourceRunIds','maskAssetId','subject','templateSnapshot','videoMode','dialogue','dubMode','tailFrame'];
// 批量生成：同时处于活跃状态的视频运行最多 3 个。
export const BATCH_CONCURRENCY=3;
// 每个生图 / 改图节点最多连接的参考图数量（含主图）。
export const MAX_REFERENCE_IMAGES=8;
const pinList=task=>Array.isArray(task?.sourceRunIds)?task.sourceRunIds:[];
const generationPrompt=input=>input.prompt+(input.productSnapshot?`\n商品事实（仅使用已知信息，不推测缺失事实）：${JSON.stringify(input.productSnapshot)}`:'');
const validTailFrame=tf=>Boolean(tf)&&typeof tf==='object'&&!Array.isArray(tf)&&typeof tf.fromNodeId==='string'&&tf.fromNodeId.length>0&&tf.fromNodeId.length<=100&&[tf.runId,tf.assetId].every(v=>v===null||v===undefined||(typeof v==='string'&&uuid.test(v)))&&((tf.runId||null)===null)===((tf.assetId||null)===null);
const BATCH_STATES=['running','paused','done','cancelled'];
// 增量保存：一次 ops 请求最多 500 个操作。
const MAX_OPS=500;
const OP_TYPES=new Set(['task.add','task.patch','task.remove','edge.add','edge.remove','workflow.put','workflow.remove','project.patch','storyboard.patch']);
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function checkOp(op) {
 if(!isObject(op)||!OP_TYPES.has(op.type))fail('OPS_INVALID','操作类型无效。');
 const bad=()=>fail('OPS_INVALID',`操作 ${op.type} 的参数无效。`);
 if(op.type==='task.add'&&!(isObject(op.task)&&typeof op.task.id==='string'))bad();
 if(op.type==='task.patch'&&(typeof op.id!=='string'||(op.fields!==undefined&&!isObject(op.fields))||(op.unset!==undefined&&!(Array.isArray(op.unset)&&op.unset.every(k=>typeof k==='string')))))bad();
 if(['task.remove','edge.remove','workflow.remove'].includes(op.type)&&typeof op.id!=='string')bad();
 if(op.type==='edge.add'&&!(isObject(op.edge)&&typeof op.edge.id==='string'))bad();
 if(op.type==='workflow.put'&&!(isObject(op.workflow)&&typeof op.workflow.id==='string'))bad();
 if(op.type==='storyboard.patch'&&((op.script!==undefined&&typeof op.script!=='string')||(op.shots!==undefined&&!Array.isArray(op.shots))||(op.settings!==undefined&&op.settings!==null&&!isObject(op.settings))))bad();
}
const graphOps=ops=>ops.some(op=>op.type!=='project.patch');
// 旧画布（无创作任务容器）升级：image→generate、补连线端口、补 workflowId；与前端 normalizeProject + withWorkflows 一致。
function upgradeLegacy(project) {
 let next=project;
 if(isLegacyGraph(project)) {
  const tasks=project.tasks.map(t=>t.kind==='image'?{...t,kind:'generate'}:t);
  const edges=(project.edges||[]).map(edge=>{
   if(edge.sourceHandle||edge.targetHandle)return edge;
   const source=tasks.find(t=>t.id===edge.source),target=tasks.find(t=>t.id===edge.target);
   const out=PORTS[source?.kind]?.out?.[0],input=PORTS[target?.kind]?.in?.find(p=>p.type===out?.type);
   return out&&input?{...edge,sourceHandle:out.id,targetHandle:input.id}:edge;
  });
  next={...project,tasks,edges};
 }
 return withWorkflows(next);
}
const BATCH_ITEM_STATES=['pending','running','succeeded','failed','held'];
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1e7;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// v3 node graph: nodes are typed operations, edges carry one of text/image/video.
export const NODE_KINDS=new Set(['product','image','audio','footage','prompt','generate','edit','composite','video','output']);
const isLegacyGraph=project=>!project?.workflows?.length&&Array.isArray(project?.tasks)&&project.tasks.length>0&&project.tasks.every(t=>!t.workflowId&&['image','video'].includes(t.kind))&&(project.edges||[]).every(e=>!e.sourceHandle&&!e.targetHandle);
export const EXECUTABLE_KINDS=new Set(['generate','edit','composite','video']);
const LEGACY_KIND=kind=>kind==='image'?'generate':kind;
const PORTS={
 product:{in:[],out:[{id:'text',type:'text'},{id:'image',type:'image'}]},
 image:{in:[],out:[{id:'image',type:'image'}]},
 audio:{in:[],out:[{id:'audio',type:'audio'}]},
 footage:{in:[],out:[{id:'video',type:'video'}]},
 prompt:{in:[],out:[{id:'text',type:'text'}]},
 generate:{in:[{id:'prompt',type:'text'},{id:'ref',type:'image',multi:true}],out:[{id:'image',type:'image'}]},
 edit:{in:[{id:'image',type:'image',multi:true},{id:'prompt',type:'text'}],out:[{id:'image',type:'image'}]},
 composite:{in:[{id:'images',type:'image',multi:true},{id:'template',type:'text'}],out:[{id:'image',type:'image'}]},
 video:{in:[{id:'prompt',type:'text'},{id:'first',type:'image'},{id:'last',type:'image'},{id:'refImage',type:'image',multi:true,max:9},{id:'refVideo',type:'video',multi:true,max:3},{id:'refAudio',type:'audio',multi:true,max:3}],out:[{id:'video',type:'video'}]},
 output:{in:[{id:'asset',type:'image',multi:true},{id:'video',type:'video',multi:true}],out:[]},
};
// 视频节点端口 → H3 素材用途 / 类型。
const VIDEO_ROLES={first:{role:'first_frame',kind:'image'},last:{role:'last_frame',kind:'image'},refImage:{role:'reference_image',kind:'image'},refVideo:{role:'reference_video',kind:'video'},refAudio:{role:'reference_audio',kind:'audio'}};
const VIDEO_PORT_ORDER=['first','last','refImage','refVideo','refAudio'];
const SOURCE_MIME={audio:'audio/',footage:'video/'};
function nodeKind(task,legacy=false){return legacy?LEGACY_KIND(task?.kind):task?.kind;}
function port(kind,dir,id){return (PORTS[kind]?.[dir]||[]).find(port=>port.id===id)||null;}
function edgeHandles(task,edge,dir){
 if(dir==='source')return edge.sourceHandle||PORTS[nodeKind(task)]?.out?.[0]?.id||null;
 return edge.targetHandle||PORTS[nodeKind(task)]?.in?.[0]?.id||null;
}
function graph(tasks,edges) {
 if(!Array.isArray(tasks)||!tasks.length||tasks.length>200||!Array.isArray(edges)||edges.length>600) fail('GRAPH_INVALID','项目需要1至200个节点，最多600条连线。');
 const legacy=isLegacyGraph({tasks,edges});
 const kind=task=>nodeKind(task,legacy);
 const ids=new Set();
 for(const t of tasks) {
  if(!t.id||typeof t.id!=='string'||t.id.length>100||ids.has(t.id)) fail('TASK_INVALID','节点编号重复或无效。');
  ids.add(t.id);
  if(t.videoMode!==undefined&&t.videoMode!==null&&t.videoMode!==''&&!VIDEO_MODES.includes(t.videoMode)) fail('TASK_INVALID','视频方式需为文生视频、首尾帧或参考素材。');
  if(t.tailFrame!==undefined&&t.tailFrame!==null&&!validTailFrame(t.tailFrame)) fail('TASK_INVALID','上一镜尾帧需要包含来源分镜节点，截取后附带结果版本与素材。');
  if(t.dubMode!==undefined&&t.dubMode!==null&&t.dubMode!==''&&!DUB_MODES.includes(t.dubMode)) fail('TASK_INVALID','配音方式需为后期配音、口型同步或不配音。');
  if(t.subtitles!==undefined&&t.subtitles!==null&&typeof t.subtitles!=='boolean') fail('TASK_INVALID','「本镜显示字幕」需为开或关。');
  if(t.dialogue!==undefined&&t.dialogue!==null&&(!Array.isArray(t.dialogue)||t.dialogue.length>50||t.dialogue.some(d=>!d||typeof d.text!=='string'||d.text.length>2000||!DIALOGUE_LANGUAGES.includes(d.language)||(d.roleId!==undefined&&d.roleId!==null&&(typeof d.roleId!=='string'||!/^[\w-]{1,100}$/.test(d.roleId)))))) fail('TASK_INVALID','台词需为文本、语言（中文或英文）和角色的列表。');
  if(!NODE_KINDS.has(kind(t))||!['product','concept'].includes(t.subject||'concept')||typeof (t.prompt??'')!=='string'||(t.prompt??'').length>20000||typeof t.title!=='string'||!t.title.trim()||t.title.length>200||!t.params||Array.isArray(t.params)||typeof t.params!=='object'||!finite(t.position?.x)||!finite(t.position?.y)) fail('TASK_INVALID','检查节点类型、标题、提示词、参数与位置。');
 }
 const edgeIds=new Set(),pairs=new Set(),inbound=new Set(),refCounts=new Map();
 for(const e of edges) {
  if(!e.id||edgeIds.has(e.id)||!ids.has(e.source)||!ids.has(e.target)||e.source===e.target) fail('EDGE_INVALID','连线必须连接两个不同的现有节点。');
  const source=tasks.find(t=>t.id===e.source),target=tasks.find(t=>t.id===e.target);
  const sourcePorts=PORTS[kind(source)]?.out||[],targetPorts=PORTS[kind(target)]?.in||[];
  const sourceHandle=e.sourceHandle||sourcePorts[0]?.id||null;
  let targetHandle=e.targetHandle||null;
  if(!targetHandle){const outType=port(kind(source),'out',sourceHandle)?.type;targetHandle=targetPorts.find(port=>port.type===outType)?.id||null;}
  const outPort=port(kind(source),'out',sourceHandle),inPort=port(kind(target),'in',targetHandle);
  if(!outPort||!inPort) fail('EDGE_INCOMPATIBLE','连线端口不存在或节点类型不支持该连接。');
  if(outPort.type!==inPort.type) fail('EDGE_INCOMPATIBLE','连线类型不匹配：文本、图片、视频、音频不能混连。');
  const pair=`${e.source}:${sourceHandle}->${e.target}:${targetHandle}`;
  if(pairs.has(pair)) fail('EDGE_INVALID','同一对端口不能重复连线。');
  if(kind(target)==='video'&&inPort.max){
   const key=`${e.target}:${targetHandle}`;refCounts.set(key,(refCounts.get(key)||0)+1);
   if(refCounts.get(key)>inPort.max) fail('TOO_MANY_VIDEO_REFERENCES',`视频节点的${{refImage:'参考图片',refVideo:'参考视频',refAudio:'参考音频'}[targetHandle]}最多连接 ${inPort.max} 个。`);
  }
  if(inbound.has(`${e.target}:${targetHandle}`)&&!inPort.multi) fail('EDGE_INCOMPATIBLE','该输入端口只能连接一条连线。');
  if(inPort.multi&&['generate','edit'].includes(kind(target))){
   const key=`${e.target}:${targetHandle}`;refCounts.set(key,(refCounts.get(key)||0)+1);
   if(refCounts.get(key)>MAX_REFERENCE_IMAGES) fail('TOO_MANY_REFERENCES',`每个生图 / 改图节点最多连接 ${MAX_REFERENCE_IMAGES} 张参考图。`);
  }
  edgeIds.add(e.id);pairs.add(pair);inbound.add(`${e.target}:${targetHandle}`);
 }
 for(const t of tasks.filter(t=>kind(t)==='video')){
  const total=['refImage','refVideo','refAudio'].reduce((sum,h)=>sum+(refCounts.get(`${t.id}:${h}`)||0),0);
  if(total>12) fail('TOO_MANY_VIDEO_REFERENCES','视频节点的参考素材合计最多 12 个。');
 }
 const visited=new Set(),visiting=new Set();
 function visit(id) {if(visiting.has(id)) fail('GRAPH_CYCLE','画布不能形成循环依赖。');if(visited.has(id))return;visiting.add(id);for(const e of edges.filter(e=>e.source===id))visit(e.target);visiting.delete(id);visited.add(id);}
 for(const id of ids)visit(id);
 if(tasks.some(t=>t.dimension!==undefined&&(typeof t.dimension!=='string'||t.dimension.length>24))) fail('TASK_INVALID','维度标签需为不超过24字的文本。');
}
function revision(body) {if(!Number.isSafeInteger(Number(body?.revision))||Number(body.revision)<1)fail('REVISION_REQUIRED','请提供当前项目修订号。',428);return Number(body.revision);}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
// 空数组与缺失字段等价，保证没有 sourceRunIds / maskAssetId 的旧任务指纹不变。
// videoMode 空值 / dubMode 'none' 等价于缺省，保证旧任务指纹不变。
const fingerprintValue=(task,k)=>Array.isArray(task?.[k])&&!task[k].length?null:(k==='videoMode'&&!task?.[k])||(k==='dubMode'&&(!task?.[k]||task[k]==='none'))?null:(task?.[k]??null);
const fingerprint=task=>hash(Object.fromEntries(editableKeys.map(k=>[k,fingerprintValue(task,k)])));
// Only incoming node identities affect the selected input; edge IDs and layout do not.
const inputFingerprint=(task,edges=[])=>hash({task:fingerprint(task),sources:edges.filter(e=>e.target===task.id).map(e=>e.source).sort()});
const runView=r=>({id:r.id,projectId:r.project_id,taskId:r.task_id,requestKey:r.request_key,input:r.input,status:r.status,upstreamId:r.upstream_id,output:r.output?Object.fromEntries(Object.entries(r.output).filter(([key])=>key!=='_pendingResult')):null,error:r.error,usage:r.usage,createdAt:r.created_at,updatedAt:r.updated_at});
const succeededHistory=(taskId,runs)=>runs.filter(r=>r.taskId===taskId&&r.status==='succeeded');
const latestSuccess=(taskId,runs)=>succeededHistory(taskId,runs).at(-1)||null;
// 复用判断：旧运行没有 media，仅有首帧 sourceAssetId，等价于单张 first_frame。
const mediaKey=input=>(Array.isArray(input.media)?input.media:input.sourceAssetId?[{assetId:input.sourceAssetId,role:'first_frame'}]:[]).map(m=>[m.assetId,m.role]);
const modeOf=input=>input.videoMode||(mediaKey(input).some(([,role])=>role==='first_frame')?'frames':'text');
function upstreamEdges(taskId,edges,dir='in'){return dir==='in'?edges.filter(e=>e.target===taskId):edges.filter(e=>e.source===taskId);}
function handleOf(edge,dir,fallback){return (dir==='source'?edge.sourceHandle:edge.targetHandle)||fallback;}

export class CreationProjects {
 constructor(store,{hub,media,compileBytes,mediaPrep,frameExtractor,voice,audioRunner}={}) {this.store=store;this.pool=store.pool;this.hub=hub;this.media=media;this.compileBytes=compileBytes||compileShotVideos;this.mediaPrep=mediaPrep||createMediaPrep();this.frameExtractor=frameExtractor||createFrameExtractor();this.voice=voice||new CreationVoice({hub,media,store,audioRunner});}
 resolveImage(node,runs,legacy=false){
  if(!node) return null;
  if(['product','image','audio','footage'].includes(nodeKind(node,legacy))){
   if(node.sourceRunId){const run=runs.find(r=>r.id===node.sourceRunId&&r.status==='succeeded');return run?.output?.assetId?{assetId:run.output.assetId,runId:run.id}:null;}
   return node.sourceAssetId?{assetId:node.sourceAssetId,runId:null}:null;
  }
  if(EXECUTABLE_KINDS.has(nodeKind(node,legacy))){
   const run=latestSuccess(node.id,runs);return run?.output?.assetId?{assetId:run.output.assetId,runId:run.id}:null;
  }
  return null;
 }
 resolveInputs(task,project,runs){
  const legacy=isLegacyGraph(project);
  const incoming=upstreamEdges(task.id,project.edges);
  const sourceNode=edge=>project.tasks.find(t=>t.id===edge.source);
  const promptEdges=incoming.filter(edge=>handleOf(edge,'target','prompt')==='prompt'||handleOf(edge,'target','template')==='template');
  const prompts=[];
  if((task.prompt||'').trim()) prompts.push(task.prompt.trim());
  for(const edge of promptEdges){
   const source=sourceNode(edge);
   if(!source) continue;
   if(nodeKind(source,legacy)==='product'&&source.productSnapshot?.facts&&Object.keys(source.productSnapshot.facts).length) prompts.push(`商品事实：${JSON.stringify(source.productSnapshot.facts)}`);
   else if((source.prompt||'').trim()) prompts.push(source.prompt.trim());
  }
  if(nodeKind(task,legacy)==='video'&&(!legacy||task.videoMode||task.dubMode||task.dialogue?.length)) return this.resolveVideoInputs(task,project,runs);
  const imagePorts=PORTS[nodeKind(task,legacy)]?.in?.filter(port=>port.type==='image').map(port=>port.id)||[];
  const imageEdges=incoming.filter(edge=>imagePorts.includes(handleOf(edge,'target',imagePorts[0])));
  const images=[];
  // 主图固定 sourceRunId，其余上游可执行来源各自固定在 sourceRunIds 中。
  const pins=[task.sourceRunId,...pinList(task)].map(id=>id?runs.find(r=>r.id===id&&r.status==='succeeded'&&r.output?.assetId):null).filter(Boolean);
  const primaryPin=task.sourceRunId?pins.find(r=>r.id===task.sourceRunId)||null:null;
  for(const edge of imageEdges){const source=sourceNode(edge);const pin=pins.find(r=>r.taskId===source?.id);const image=pin?{assetId:pin.output.assetId,runId:pin.id}:this.resolveImage(source,runs,legacy);if(image)images.push(image);}
  const pinnedAsset=primaryPin?{assetId:primaryPin.output.assetId,runId:primaryPin.id}:task.sourceAssetId?{assetId:task.sourceAssetId,runId:null}:null;
  const primary=pinnedAsset||images[0]||null;
  const missingVersions=!legacy&&task.kind!=='composite'&&imageEdges.some(edge=>{const source=sourceNode(edge);return source&&EXECUTABLE_KINDS.has(nodeKind(source,legacy))&&!pins.some(r=>r.taskId===source.id);});
  const missingPrompts=!prompts.length;
  const needsImage=['edit','composite'].includes(nodeKind(task,legacy));
  const missingImages=needsImage&&!images.length&&!pinnedAsset;
  // 按资产去重且主图在首位；生图 / 改图最多 8 张，超出时由预览阻塞而不是静默截断。
  const unique=[...new Map([...(primary?[primary]:[]),...images].map(image=>[image.assetId,image])).values()];
  const capped=nodeKind(task,legacy)!=='composite';
  const tooManyImages=capped&&unique.length>MAX_REFERENCE_IMAGES;
  return {prompt:prompts.join('\n\n'),images:capped?unique.slice(0,MAX_REFERENCE_IMAGES):unique,sourceAssetId:primary?.assetId||null,sourceRunId:primary?.runId||null,maskAssetId:nodeKind(task,legacy)==='edit'&&task.maskAssetId?task.maskAssetId:null,missingPrompts,missingImages,missingVersions,tooManyImages};
 }
 // 视频节点：按端口与连线顺序产出 media，并换算提示词标签与台词。
 resolveVideoInputs(task,project,runs) {
  const incoming=upstreamEdges(task.id,project.edges);
  const sourceNode=edge=>project.tasks.find(t=>t.id===edge.source);
  // 连线未写目标端口时按来源输出类型推断（与 graph() 一致）。
  const targetOf=edge=>{
   if(edge.targetHandle) return edge.targetHandle;
   const source=sourceNode(edge),outType=port(nodeKind(source),'out',edge.sourceHandle||PORTS[nodeKind(source)]?.out?.[0]?.id)?.type;
   return PORTS.video.in.find(p=>p.type===outType)?.id||null;
  };
  const promptEdges=incoming.filter(edge=>targetOf(edge)==='prompt');
  // 提示词基础文本：resolveInputs 已按旧规则收集；此处用推断端口重新收集，避免图片连线被当成提示词。
  const prompts=[];
  if((task.prompt||'').trim()) prompts.push(task.prompt.trim());
  for(const edge of promptEdges){
   const source=sourceNode(edge);if(!source) continue;
   if(nodeKind(source)==='product'&&source.productSnapshot?.facts&&Object.keys(source.productSnapshot.facts).length) prompts.push(`商品事实：${JSON.stringify(source.productSnapshot.facts)}`);
   else if((source.prompt||'').trim()) prompts.push(source.prompt.trim());
  }
  const pins=[task.sourceRunId,...pinList(task)].map(id=>id?runs.find(r=>r.id===id&&r.status==='succeeded'&&r.output?.assetId):null).filter(Boolean);
  const mode=['text','frames','reference'].includes(task.videoMode)?task.videoMode:null;
  const media=[];let missingVersions=false;
  // 上一镜尾帧只在显式选择的首尾帧方式下生效：优先级低于首帧连线、高于任务自带的 sourceAssetId。
  const tail=task.tailFrame&&typeof task.tailFrame==='object'&&task.tailFrame.fromNodeId?task.tailFrame:null;
  const tailActive=mode==='frames'&&Boolean(tail);
  const taskFirst=task.sourceRunId&&pins.find(r=>r.id===task.sourceRunId)?{assetId:pins.find(r=>r.id===task.sourceRunId).output.assetId,runId:task.sourceRunId}:task.sourceAssetId?{assetId:task.sourceAssetId,runId:null}:null;
  for(const portId of VIDEO_PORT_ORDER){
   const {role,kind}=VIDEO_ROLES[portId];
   // 任务自身选定的首帧只在首尾帧方式（或旧任务推断为首尾帧）下生效，且优先于连线。
   const edges=incoming.filter(edge=>targetOf(edge)===portId);
   let usedTask=false;
   if(portId==='first'&&taskFirst&&!tailActive&&mode!=='text'&&mode!=='reference'){media.push({assetId:taskFirst.assetId,runId:taskFirst.runId,role,kind,sourceTaskId:null});usedTask=true;}
   for(const edge of edges){
    const source=sourceNode(edge);if(!source) continue;
    let resolved;
    if(EXECUTABLE_KINDS.has(nodeKind(source))){
     const pin=pins.find(r=>r.taskId===source.id);
     if(!pin){missingVersions=true;continue;}
     resolved={assetId:pin.output.assetId,runId:pin.id};
    }else resolved=this.resolveImage(source,runs);
    if(!resolved||usedTask) continue;
    media.push({assetId:resolved.assetId,runId:resolved.runId,role,kind,sourceTaskId:source.id});
   }
  }
  let tailWait=null;
  if(tailActive&&!media.some(m=>m.role==='first_frame')){
   if(tail.assetId)media.unshift({assetId:tail.assetId,runId:null,role:'first_frame',kind:'image',sourceTaskId:null,tailFrame:true});
   else tailWait=this.latestVideoSuccess(tail.fromNodeId,pins,runs)?'extract':'prev';
  }
  const videoMode=mode||(media.some(m=>m.role==='first_frame')?'frames':'text');
  // 配音：后期配音与口型同步都需要已合成且与当前台词、角色一致的 dialogueAudio。
  const dubMode=DUB_MODES.includes(task.dubMode)?task.dubMode:'none';
  const dialogue=Array.isArray(task.dialogue)?task.dialogue.filter(d=>d&&typeof d.text==='string'&&d.text.trim()):[];
  const audioStatus=dialogueAudioStatus(task,project.voiceRoles);
  const dubbing=['post','lipsync'].includes(dubMode)&&dialogue.length>0;
  let dubIssue=null,dubIssueKind=null,dialogueAudio=null;
  if(dubbing){
   if(dubMode==='lipsync'&&videoMode!=='reference'){dubIssue='口型同步需要使用「全能参考」方式，请切换视频方式，或改用后期配音。';dubIssueKind='mode';}
   else if(audioStatus==='none'){dubIssue='请先合成台词配音。';dubIssueKind='missing';}
   else if(audioStatus==='stale'){dubIssue='配音已过期，请重新合成台词配音。';dubIssueKind='stale';}
   else dialogueAudio={assetId:task.dialogueAudio.assetId,hash:task.dialogueAudio.hash,durationSec:task.dialogueAudio.durationSec,textWords:task.dialogueAudio.textWords??null};
  }
  // 口型同步：合成语音作为最后一条参考音频（计入音频 ≤3、合计 ≤12），提示词里引用它的编号。
  let dubAudioIndex=null;
  if(dialogueAudio&&dubMode==='lipsync'){
   media.push({assetId:dialogueAudio.assetId,runId:null,role:'reference_audio',kind:'audio',sourceTaskId:null,dialogueAudio:true});
   dubAudioIndex=media.filter(m=>m.kind==='audio').length;
  }
  const connected=media.length>0;
  const issue=missingVersions?null:videoMediaIssue(videoMode,media);
  // 标签换算：{{ref:<节点编号>}} → <Picture N> / <Video N> / <Audio N>。
  let tagIssue=null;
  const counters={image:0,video:0,audio:0};
  const labelOf=new Map();
  for(const item of media){if(item.role==='first_frame'||item.role==='last_frame') continue;counters[item.kind]+=1;if(item.dialogueAudio) continue;if(!labelOf.has(item.sourceTaskId)||item.kind!==labelOf.get(item.sourceTaskId).kind)labelOf.set(item.sourceTaskId,{kind:item.kind,index:counters[item.kind]});}
  const basePromptText=prompts.join('\n\n').replace(/\{\{ref:([^}]*)\}\}/g,(_,ref)=>{
   const item=media.find(m=>m.sourceTaskId===ref&&ref);
   if(!item){tagIssue=tagIssue||'removed';return '';}
   if(item.role==='first_frame'||item.role==='last_frame'){tagIssue=tagIssue==='removed'?tagIssue:'frame';return '';}
   const label=labelOf.get(ref);
   return `<${{image:'Picture',video:'Video',audio:'Audio'}[label.kind]} ${label.index}>`;
  });
  // 后期配音时台词不进入提示词；口型同步追加台词与「参考 <Audio N>」。
  const suffix=dubMode==='post'?'':[dialoguePromptSuffix(dialogue),dubAudioIndex?`说话人的音色与表达方式参考 <Audio ${dubAudioIndex}>`:''].filter(Boolean).join('\n');
  const duration=Number.isInteger(task.params?.duration)?task.params.duration:5;
  const needed=estimateDialogueSeconds(dialogue);
  // 有真实配音时长就按真实时长提醒，否则按字数估算。
  const dubWarning=dialogueAudio?dubSuggestion(task,dialogueAudio.durationSec):null;
  const dialogueWarning=!dialogueAudio&&dialogue.length&&needed>duration?`台词约需 ${Math.ceil(needed)} 秒，超过分镜时长 ${duration} 秒，建议加长时长或精简台词。`:null;
  const images=media.filter(m=>m.kind==='image').map(m=>({assetId:m.assetId,runId:m.runId}));
  const first=media.find(m=>m.role==='first_frame')||null;
  return {prompt:[basePromptText,suffix].filter(Boolean).join('\n'),promptText:basePromptText,images,media,videoMode,dubMode,dialogue,dialogueWarning,sourceAssetId:first?.assetId||null,sourceRunId:first?.runId||null,maskAssetId:null,missingPrompts:videoMode==='text'&&!basePromptText.trim()&&!suffix,missingImages:false,missingVersions,tooManyImages:false,videoIssue:tailWait?null:issue,tagIssue,connected,tailWait,dialogueAudio,dubIssue,dubIssueKind,dubWarning};
 }
 // 上一镜被固定或最新的成功视频运行（需有结果素材）。
 latestVideoSuccess(nodeId,pins,runs) {
  const pinned=(pins||[]).find(r=>r.taskId===nodeId&&r.output?.assetId);
  if(pinned)return pinned;
  return runs.filter(r=>r.taskId===nodeId&&r.status==='succeeded'&&r.output?.assetId&&r.input?.kind==='video').at(-1)||null;
 }
 async preview(workspace,id,body={},client=this.pool,{checkBalance=true}={}) {
  const detail=await this.detail(workspace,id,client),{runs}=detail,project=this.effective(detail.project);this.assertProject(project);
  graph(project.tasks,project.edges);
  const selected=[...new Set(Array.isArray(body.taskIds)?body.taskIds:[])];
  if(!selected.length||selected.some(id=>!project.tasks.some(t=>t.id===id)))fail('SELECTION_INVALID','请至少选择一个画布节点。');
  const scope=[],seen=new Set(),regenerate=new Set(body.regenerateTaskIds||[]);
  const visit=async taskId=>{
   if(seen.has(taskId))return;seen.add(taskId);
   const task=project.tasks.find(t=>t.id===taskId);const history=runs.filter(r=>r.taskId===taskId),last=history.at(-1);
   const kind=nodeKind(task,isLegacyGraph(project));
   if(!EXECUTABLE_KINDS.has(kind)){scope.push({taskId,title:task.title,kind,action:'skip',reason:'输入节点本身不执行生成。',model:null});return;}
   for(const edge of upstreamEdges(taskId,project.edges)){
    const source=project.tasks.find(t=>t.id===edge.source);
    if(source&&EXECUTABLE_KINDS.has(nodeKind(source,isLegacyGraph(project)))&&!latestSuccess(source.id,runs))await visit(source.id);
   }
   const resolved=this.resolveInputs(task,project,runs);
   const legacy=isLegacyGraph(project);
   const matching=history.filter(r=>r.status==='succeeded').findLast(r=>inputFingerprint(r.input.task,r.input.edges)===inputFingerprint(task,project.edges)&&(legacy||(r.input.prompt===resolved.prompt&&hash(r.input.images||[])===hash(resolved.images)&&(kind!=='video'||resolved.media===undefined||(hash(mediaKey(r.input))===hash(resolved.media.map(m=>[m.assetId,m.role]))&&modeOf(r.input)===resolved.videoMode)))));
   const reuseAction=Boolean(matching)&&!regenerate.has(taskId)&&last?.status!=='failed';
   if(legacy&&task.sourceRunId&&!reuseAction&&!(last&&active.has(last.status))){
    for(const edge of project.edges.filter(e=>e.target===taskId)){
     const pinned=runs.find(r=>r.id===task.sourceRunId&&r.taskId===edge.source&&r.status==='succeeded');
     if(pinned&&!seen.has(edge.source)){seen.add(edge.source);scope.push({taskId:edge.source,title:pinned.input.task.title,kind:pinned.input.kind,action:'reuse',reason:'复用手动选定的历史版本。',model:null,reuseRunId:pinned.id});}
    }
   }
   let action='generate',reason='',model=null,reuseRunId=null;
   if(last&&active.has(last.status)){action='recover';reason='原请求尚未结束，只查询原请求。';}
   else if(kind==='composite'){
    action=resolved.images.length?'composite':'blocked';
    reason=resolved.images.length?'在浏览器中按模板拼合上游图片，不调用模型。':'请先连接至少一张成功的图片。';
   }
   else if(reuseAction){action='reuse';reuseRunId=matching.id;reason='复用相同输入的成功记录。';}
   else if(legacy&&project.edges.some(e=>e.target===taskId)&&!task.sourceRunId){action='wait-input';reason='前置完成后手选具体版本，再次开始。';}
   else if(last?.status==='failed'&&!(body.retryTaskIds||[]).includes(taskId)){action='retry-confirm';reason='上次明确失败，确认重试后才创建新请求。';}
   else if(resolved.tailWait){action='wait-input';reason=resolved.tailWait==='prev'?'等待上一镜生成成功':'请先截取上一镜尾帧，再次预览运行。';}
   else if(resolved.missingVersions){action='wait-input';reason='请先选择上游的具体成功版本，再次预览运行。';}
   else if(resolved.missingPrompts){action='blocked';reason='请填写提示词，或连接一个提示词 / 商品节点。';}
   else if(resolved.tagIssue==='removed'){action='blocked';reason='提示词引用了已移除的素材，请删除标红的标签。';}
   else if(resolved.tagIssue==='frame'){action='blocked';reason='首尾帧素材不使用标签，请删除提示词中对应的素材标签。';}
   else if(resolved.videoIssue){action='blocked';reason=resolved.videoIssue;}
   else if(resolved.dubIssue){
    action='blocked';reason=resolved.dubIssue;
    // 还没有可用配音时，先确认语音渠道已配置，避免用户点了「合成」才发现不可用。
    if(['missing','stale'].includes(resolved.dubIssueKind)&&!(await this.hub?.voiceConfigured?.(client)))reason='语音渠道未配置：请先到模型中心添加火山引擎语音渠道，再合成台词配音。';
   }
   else if(resolved.missingImages){action='blocked';reason='请连接一张上游图片。';}
   else if(resolved.tooManyImages){action='blocked';reason=`每个生图 / 改图节点最多连接 ${MAX_REFERENCE_IMAGES} 张参考图。`;}
   else if(resolved.maskAssetId&&(await this.store.get(workspace,resolved.maskAssetId,client))?.baseAssetId!==resolved.sourceAssetId){action='blocked';reason='原图已更换，蒙版不再对应，请重新绘制局部精修区域。';}
   else if(kind==='generate'&&task.subject==='product'&&!resolved.sourceAssetId){action='blocked';reason='生成商品外观需要连接商品创作素材。';}
   else {
    try {
     await this.validateReferences(workspace,{...project,tasks:[task]},client);
     model=await this.hub.resolve(kind==='video'?'video':'image',task.model||undefined,client);
     await this.hub.validateGeneration?.({...task,kind:kind==='video'?'video':'image',model,prompt:generationPrompt({...task,prompt:resolved.prompt,productSnapshot:task.productSnapshot||project.productSnapshot}),...(resolved.media?{media:resolved.media,videoMode:resolved.videoMode}:{})},client,{parametersOnly:true});
    }catch(e){action='blocked';reason=e instanceof AppError?e.message:'请先配置可用的环节默认模型。';}
   }
   const entry={taskId,title:task.title,kind,action,reason,model,reuseRunId,resolved,inputHash:inputFingerprint(task,project.edges)};
   if(kind==='video'){
    if(resolved.dialogueWarning) entry.dialogueWarning=resolved.dialogueWarning;
    if(resolved.dubWarning) entry.dubWarning=resolved.dubWarning;
    if(action==='generate'){
     const points=this.estimatePoints(task,model);
     if(points!==null) entry.estimatedPoints=points;
    }
   }
   scope.push(entry);
  };
  for(const taskId of selected)await visit(taskId);
  const selection={taskIds:selected,regenerateTaskIds:[...regenerate],retryTaskIds:[...new Set(body.retryTaskIds||[])]};
  // 令牌只取决于所选节点的冻结输入（scope 内含各节点输入哈希、解析后的提示词 / 素材 / 模型）与运行状态；不含整项目修订号，无关节点的编辑不会让预览失效。
  const previewToken=hash({scope,selection,states:runs.map(r=>[r.id,r.status])});
  let canStart=scope.some(t=>['generate','recover','reuse','composite'].includes(t.action))&&!scope.some(t=>t.action==='blocked');
  // 积分预估与余额：余额只在查询成功时才参与拦截；查询失败不阻塞，balance 为 null。
  const estimatedPoints=Math.round(scope.reduce((sum,e)=>sum+(e.estimatedPoints||0),0)*100)/100;
  let balance=null,balanceShortfall=0,balanceReason=null;
  const priced=scope.filter(e=>e.estimatedPoints>0&&e.model?.channelId);
  if(checkBalance&&priced.length&&typeof this.hub?.videoBalance==='function'){
   const channelId=priced[0].model.channelId;
   try{
    const result=await this.hub.videoBalance(channelId);
    if(result&&Number.isFinite(result.available)){
     balance={available:result.available};
     const needed=Math.round(priced.filter(e=>e.model.channelId===channelId).reduce((sum,e)=>sum+e.estimatedPoints,0)*100)/100;
     if(result.available<needed){balanceShortfall=Math.round((needed-result.available)*100)/100;canStart=false;balanceReason=`积分不足：预计需要 ${needed} 积分，当前可用 ${result.available} 积分，还差 ${balanceShortfall} 积分。`;}
    }
   }catch{balance=null;}
  }
  return {revision:project.revision,previewToken,selection,scope,canStart,cost:detail.cost,estimatedPoints,balance,...(balanceShortfall?{balanceShortfall,balanceReason}:{})};
 }
 // 单价 × 时长；未填写时按 768P、5 秒。
 estimatePoints(task,model) {
  const params=normalizeVideoParameters(task.params)||{},price=pointPricesFor(model?.executorConfig)[params.resolution||'768P'];
  return Number.isFinite(price)?Math.round(price*(Number.isInteger(params.duration)?params.duration:5)*100)/100:null;
 }
 async start(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','开始任务需要唯一请求编号。');
  // 余额检查放在事务之外（外部请求不能占着数据库事务）；与 preview 同一套规则，查询失败或未知时放行。
  // 重复提交的同一请求编号直接走事务内的幂等分支，不再按最新余额拦截。
  if(typeof this.hub?.videoBalance==='function'&&!(await this.pool.query("SELECT 1 FROM sj_creation_runs WHERE workspace_id=$1 AND input->'start'->>'requestKey'=$2 LIMIT 1",[workspace,body.requestKey])).rows.length){
   let ahead=null;
   try{ahead=await this.preview(workspace,id,body);}catch{ahead=null;}
   if(ahead&&ahead.balanceReason)fail('INSUFFICIENT_POINTS',ahead.balanceReason,409);
  }
  let outcome;
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const duplicates=(await client.query("SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND input->'start'->>'requestKey'=$2",[workspace,body.requestKey])).rows;
   if(duplicates.length) {
    const previous=duplicates[0];
    if(previous.project_id!==id||previous.input.start.previewToken!==body.previewToken||hash(previous.input.start.selection)!==hash({taskIds:[...new Set(body.taskIds||[])],regenerateTaskIds:[...new Set(body.regenerateTaskIds||[])],retryTaskIds:[...new Set(body.retryTaskIds||[])]}))fail('REQUEST_KEY_CONFLICT','同一请求编号不能用于不同的执行范围。',409);
    outcome={replayed:true};return null;
   }
   const preview=await this.preview(workspace,id,body,client,{checkBalance:false});
   if(body.previewToken!==preview.previewToken)fail('PREVIEW_CHANGED','执行范围或模型状态已变化，请重新预览。',409);
   if(!preview.canStart)fail('START_BLOCKED','执行范围尚不能开始，请处理提示后重新预览。',409);
   await this.validateReferences(workspace,project,client);
   if(project.productId) {const product=await this.store.get(workspace,project.productId,client);if(!product||product.deletionPending)fail('PRODUCT_UNAVAILABLE','商品正在删除，请重新选择。',409);}
   const start={requestKey:body.requestKey,previewToken:body.previewToken,revision:project.revision,selection:preview.selection};
   const effectiveProject=this.effective(project);
   for(const entry of preview.scope.filter(e=>e.action==='generate')) {
    const task=effectiveProject.tasks.find(t=>t.id===entry.taskId);
    await this.insertRun(client,workspace,project,task,entry,{start,requestKey:this.derivedRequestKey(body.requestKey,task.id)});
   }
   outcome={replayed:false,scope:preview.scope};
   return project;
  },{keepRevision:true});
  return {...await this.detail(workspace,id),...outcome};
 }
 // 由批次 / 开始请求编号派生的单任务请求编号（UUID 形态，工作空间内唯一）。
 derivedRequestKey(...parts) {
  const key=hash(parts.join(':')).slice(0,32);
  return `${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20)}`;
 }
 // 单个任务：冻结输入并插入运行记录（start 与批次派发共用）；校验已由调用方的预览完成。
 async insertRun(client,workspace,project,task,entry,{start,requestKey}) {
  const input={kind:nodeKind(task,isLegacyGraph(project))==='video'?'video':'image',nodeKind:nodeKind(task,isLegacyGraph(project)),task:clone(task),prompt:entry.resolved.prompt,params:task.kind==='video'?normalizeVideoParameters(task.params):clone(task.params),model:clone(entry.model),productId:project.productId,productSnapshot:clone(task.productSnapshot||project.productSnapshot),sourceAssetId:entry.resolved.sourceAssetId,sourceRunId:entry.resolved.sourceRunId,maskAssetId:entry.resolved.maskAssetId||null,images:clone(entry.resolved.images),graphRevision:project.revision,edges:clone(project.edges),requestKey,start};
  // 视频节点：冻结素材清单、方式与台词；换算后的提示词已在 input.prompt。
  if(input.kind==='video'&&entry.resolved.media) Object.assign(input,{media:clone(entry.resolved.media),videoMode:entry.resolved.videoMode,dubMode:entry.resolved.dubMode,dialogue:clone(entry.resolved.dialogue),...(entry.resolved.dialogueAudio?{dialogueAudio:clone(entry.resolved.dialogueAudio)}:{})});
  const runId=randomUUID();
  await client.query('INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input) VALUES($1,$2,$3,$4,$5,$6)',[runId,workspace,project.id,task.id,requestKey,input]);
  return runId;
 }
 // Composite runs are rendered in the browser and uploaded as an asset; no model call is involved.
 async composite(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','合成需要唯一请求编号。');
  if(!uuid.test(body.assetId||''))fail('COMPOSITE_ASSET_REQUIRED','请先上传合成结果。');
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const task=project.tasks.find(t=>t.id===body.taskId);
   if(!task||nodeKind(task)!=='composite')fail('TASK_INVALID','请选择一个合成节点。');
   const asset=await this.store.get(workspace,body.assetId,client);
   if(!asset||asset.kind!=='asset'||asset.deletionPending||!asset.mime?.startsWith('image/'))fail('COMPOSITE_ASSET_REQUIRED','合成结果必须是当前工作空间的图片。',422);
   const existing=(await client.query("SELECT id FROM sj_creation_runs WHERE workspace_id=$1 AND request_key=$2",[workspace,body.requestKey])).rows[0];
   if(existing)return null;
   const runs=(await client.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at,id',[workspace,id])).rows.map(runView);
   const resolved=this.resolveInputs(task,project,runs);
   const input={kind:'image',nodeKind:'composite',task:clone(task),prompt:resolved.prompt,params:clone(task.params),model:null,productId:project.productId,productSnapshot:clone(task.productSnapshot||project.productSnapshot),sourceAssetId:null,sourceRunId:null,images:clone(resolved.images),graphRevision:project.revision,edges:clone(project.edges),requestKey:body.requestKey,start:{requestKey:body.requestKey}};
   await client.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES($1,$2,$3,$4,$5,$6,'succeeded',$7)",[randomUUID(),workspace,id,task.id,body.requestKey,input,{assetId:asset.id,fileUrl:`/api/creation/assets/${asset.id}/file`}]);
   return project;
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 async tick() {
  const batchResult=await this.advanceBatches().catch(()=>({batches:0,errors:1}));
  await this.mixPending().catch(()=>{});
  const rows=(await this.pool.query("SELECT id FROM sj_creation_runs WHERE status IN ('queued','submitting','running','unknown','cancelling') ORDER BY updated_at LIMIT 20")).rows;
  const outcomes=[];
  for(const row of rows) {try{outcomes.push({status:'fulfilled',value:await this.drive(row.id)});}catch{outcomes.push({status:'rejected'});}}
  return {processed:outcomes.filter(r=>r.status==='fulfilled'&&r.value).length,errors:outcomes.filter(r=>r.status==='rejected').length+batchResult.errors};
 }
 async recoverPending() {return this.tick();}
 async recover(workspace,id,body={}) {
  const detail=await this.detail(workspace,id);
  const ids=body.runIds||detail.runs.filter(r=>active.has(r.status)).map(r=>r.id);
  if(!Array.isArray(ids)||ids.some(id=>!detail.runs.some(r=>r.id===id)))fail('RUN_SELECTION_INVALID','请选择本项目的生成记录。');
  for(const runId of ids.filter(id=>detail.runs.some(r=>r.id===id&&r.status!=='queued')))await this.drive(runId);
  return this.detail(workspace,id);
 }
 async cancel(workspace,id,body={}) {
  const detail=await this.detail(workspace,id);this.assertProject(detail.project);
  const ids=body.runIds||[];
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!detail.runs.some(r=>r.id===id)))fail('RUN_SELECTION_INVALID','请选择本项目的生成记录。');
  for(const runId of ids) {
   await this.pool.query("UPDATE sj_creation_runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,updated_at=now() WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status IN ('queued','submitting','running','unknown','cancelling')",[workspace,id,runId]);
   await this.drive(runId);
  }
  return this.detail(workspace,id);
 }
 async drive(id,{cancel=false}={}) {
  const client=await this.pool.connect();let locked=false;
  try {
   locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[`sj:creation:run:${id}`])).rows[0].locked;
   if(!locked)return false;
   let run=(await client.query('SELECT * FROM sj_creation_runs WHERE id=$1',[id])).rows[0];
   if(!run||!active.has(run.status))return false;
   if(cancel&&run.status==='queued') {await client.query("UPDATE sj_creation_runs SET status='cancelled',updated_at=now() WHERE id=$1",[id]);return true;}
   const generation=clone(run.input);
   generation.prompt=generationPrompt(generation);
   const newVideo=run.input.kind==='video'&&Array.isArray(run.input.media);
   if(run.input.sourceAssetId&&!newVideo) {
    try {generation.sourceImage=await this.media.source(run.workspace_id,run.input.sourceAssetId,client);}
    catch {
     if(run.status==='queued') {await client.query("UPDATE sj_creation_runs SET status='failed',error=$2,updated_at=now() WHERE id=$1",[id,{code:'SOURCE_UNAVAILABLE',message:'创作素材无法读取，修复后手动重试。'}]);return true;}
     // Polling an accepted request must not depend on rereading its original media.
    }
   }
   // 多参考图与蒙版仅在首次提交前读取（主图之外最多 7 张）；轮询阶段不再重新读取。
   if(run.status==='queued'&&run.input.kind!=='video'&&generation.sourceImage) {
    try {
     const extra=(run.input.images||[]).map(image=>image.assetId).filter(assetId=>assetId&&assetId!==run.input.sourceAssetId).slice(0,MAX_REFERENCE_IMAGES-1);
     const sources=[generation.sourceImage];
     for(const assetId of extra)sources.push(await this.media.source(run.workspace_id,assetId,client));
     if(sources.length>1)generation.sourceImages=sources;
     if(run.input.maskAssetId)generation.mask=await this.media.source(run.workspace_id,run.input.maskAssetId,client);
    }catch {
     await client.query("UPDATE sj_creation_runs SET status='failed',error=$2,updated_at=now() WHERE id=$1",[id,{code:'SOURCE_UNAVAILABLE',message:'创作素材无法读取，修复后手动重试。'}]);return true;
    }
   }
   // 视频素材：首次提交前读取并预处理 input.media（旧运行仅有首帧，按单张 first_frame 处理）。
   if(run.status==='queued'&&run.input.kind==='video'&&(newVideo||generation.sourceImage)) {
    const frozen=newVideo?run.input.media:[{assetId:run.input.sourceAssetId,runId:run.input.sourceRunId||null,role:'first_frame',kind:'image'}];
    const fail=async(code,message)=>{await client.query("UPDATE sj_creation_runs SET status='failed',error=$2,updated_at=now() WHERE id=$1",[id,{code,message}]);return true;};
    const loaded=[];
    try {
     for(const item of frozen) {
      const source=newVideo?await this.media.source(run.workspace_id,item.assetId,client):generation.sourceImage;
      loaded.push({...item,bytes:Buffer.from(source.bytes),mime:source.mime,name:source.name||'素材'});
     }
    }catch {return fail('SOURCE_UNAVAILABLE','创作素材无法读取，修复后手动重试。');}
    try {
     const prepared=[];
     for(const item of loaded) prepared.push(await this.mediaPrep.prepare(item));
     checkMediaLimits(prepared);
     // 旧运行（仅首帧）仍以 sourceImage 传给执行器，执行器视作单张 first_frame。
     if(newVideo)generation.media=prepared;else generation.sourceImage=prepared[0];
    }catch(e) {
     if(e instanceof AppError)return fail(e.code,e.message);
     return fail('MEDIA_PREP_FAILED','素材预处理失败，请更换素材后手动重试。');
    }
   }
   let result,mixAfter=false;
   if(run.output?._pendingResult) {
    const pending=run.output._pendingResult;
    result={status:'succeeded',bytes:Buffer.from(pending.base64,'base64'),mime:pending.mime,upstreamId:run.upstream_id,usage:run.usage};
   } else if(cancel||run.status==='cancelling') {
    await client.query("UPDATE sj_creation_runs SET status='cancelling',updated_at=now() WHERE id=$1",[id]);
    try {result=await this.hub.cancelGeneration(generation,run.upstream_id,client);}catch {result={status:'unknown'};}
   } else if(run.status==='queued') {
    // Deterministic local validation is still editable; no request has been sent.
    try {await this.hub.validateGeneration?.(generation,client);}
    catch(e) {
     if(!(e instanceof AppError))throw e;
     await client.query("UPDATE sj_creation_runs SET status='failed',error=$2,updated_at=now() WHERE id=$1",[id,{code:e.code,message:e.message}]);
     return true;
    }
    // Persist before the network call. A crash at this boundary can only poll, never resubmit.
    const claimed=await client.query("UPDATE sj_creation_runs SET status='submitting',updated_at=now() WHERE id=$1 AND status='queued' RETURNING id",[id]);
    if(!claimed.rowCount)return false;
    try {result=await this.hub.submitGeneration(generation,client);}catch(e) {result={status:e.code==='PROVIDER_REJECTED'?'failed':'unknown'};}
   } else {
    try {result=await this.hub.pollGeneration(generation,run.upstream_id,client);}catch {result={status:'unknown'};}
   }
   let status=['queued','submitting','running','unknown','succeeded','failed','cancelled'].includes(result?.status)?result.status:'unknown';
   // queued/submitting returned by the provider are accepted upstream work, not local queue entries.
   if(['queued','submitting'].includes(status))status='running';
   let output=run.output||null;
   if(status==='succeeded'&&result.bytes&&result.mime&&!run.output?._pendingResult) {
    output={_pendingResult:{base64:Buffer.from(result.bytes).toString('base64'),mime:result.mime}};
    await client.query("UPDATE sj_creation_runs SET status='unknown',upstream_id=COALESCE($2,upstream_id),output=$3,usage=COALESCE($4,usage),updated_at=now() WHERE id=$1",[id,result.upstreamId||null,output,result.usage||null]);
   }
   if(status==='succeeded') {
    mixAfter=run.input.kind==='video'&&run.input.dubMode==='post'&&Boolean(run.input.dialogueAudio?.assetId);
    let asset=(await client.query("SELECT id FROM sj_creation_records WHERE workspace_id=$1 AND kind='asset' AND body->>'runId'=$2 ORDER BY created_at LIMIT 1",[run.workspace_id,id])).rows[0];
    if(!asset&&result.bytes&&result.mime) {
     try {asset=await this.media.put(run.workspace_id,{bytes:Buffer.from(result.bytes),mime:result.mime,name:`${run.input.task.title}-${id.slice(0,8)}.${result.mime==='video/mp4'?'mp4':result.mime==='image/jpeg'?'jpg':result.mime==='image/webp'?'webp':'png'}`,productId:run.input.productId,projectId:run.project_id,taskId:run.task_id,runId:id,role:'result'},client);}catch {status='unknown';}
    }
    if(asset) output={assetId:asset.id,mime:result.mime||run.output?.mime,fileUrl:`/api/creation/assets/${asset.id}/file`};
    else status='unknown';
   }else if(result?.progress!==undefined)output={...output,progress:result.progress};
   if(['running','unknown'].includes(status)) {const pending=(await client.query('SELECT status FROM sj_creation_runs WHERE id=$1',[id])).rows[0];if(pending?.status==='cancelling')status='cancelling';}
   const error=status==='failed'?{code:typeof result.error?.code==='string'?result.error.code.slice(0,80):'GENERATION_FAILED',message:result.error?.code==='CONTENT_BLOCKED'&&typeof result.error.message==='string'?result.error.message.slice(0,400):'供应商已确认失败，请查看输入后手动重试。'}:status==='unknown'?{code:'UPSTREAM_UNKNOWN',message:'原请求状态待核实，不会重新生成或切换模型。'}:null;
   await client.query('UPDATE sj_creation_runs SET status=$2,upstream_id=COALESCE($3,upstream_id),output=$4,error=$5,usage=COALESCE($6,usage),updated_at=now() WHERE id=$1',[id,status,result?.upstreamId||null,output,error,result?.usage||null]);
   // 后期配音：视频成功后混音为派生视频；混音失败不影响原视频的成功状态。
   if(mixAfter&&status==='succeeded')await this.mixRun(run.workspace_id,id).catch(()=>{});
   return true;
  }finally {if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`sj:creation:run:${id}`]);client.release();}
 }
 async suggest(workspace,id,body={}) {
  if(typeof body.instructions!=='string'||!body.instructions.trim()||body.instructions.length>8000)fail('PLANNING_INPUT','请填写不超过8000字的创作要求。');
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','AI安排需要唯一请求编号。');
  let suggestion,invoke=false,context;
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const existing=(project.suggestions||[]).find(s=>s.requestKey===body.requestKey);
   if(existing){if(existing.instructions!==body.instructions)fail('REQUEST_KEY_CONFLICT','请求编号已用于不同的创作要求。',409);suggestion=existing;return null;}
   suggestion={id:randomUUID(),requestKey:body.requestKey,instructions:body.instructions,allowVideo:body.allowVideo===true,status:'pending',baseRevision:project.revision,baseGraphHash:hash({tasks:project.tasks,edges:project.edges}),createdAt:new Date().toISOString()};
   const creativeAssets=(await this.store.list(workspace,'asset',false,client))
    .filter(a=>a.role==='creative'&&a.mime?.startsWith('image/')&&!a.deletionPending)
    .map(a=>({id:a.id,name:a.name,mime:a.mime,productId:a.productId||null,width:a.width||null,height:a.height||null}));
   context={...clone(project),creativeAssets};invoke=true;
   return {...project,suggestions:[...(project.suggestions||[]).slice(-49),suggestion]};
  },{keepRevision:true});
  if(invoke) {
   let response,plan,status='ready';
   try {
    response=await this.hub.complete({workspaceId:workspace,stage:'planning',messages:[{role:'user',content:JSON.stringify({instructions:body.instructions,product:context.productSnapshot,tasks:context.tasks,edges:context.edges,creativeAssets:context.creativeAssets})}],system:VIDEO_PLANNING_PARAMETERS+`你是电商创作规划助手。商品事实不得猜测，输出纯JSON {additions:[{id?,kind,title,prompt,params,subject,sourceAssetId?,dimension?}],updates:[{id,changes:{title?,prompt?,params?,sourceAssetId?,dimension?}}],edges?:[{id,source,target,sourceHandle,targetHandle}]}。kind 只能是 generate、edit、video；dimension 是可选维度标签（如 商品白底图、多卖点组合图、多卖点实拍说明、详情参数图、使用场景图、视频分镜），不超过24字，用于画布自动布局。不执行任务。${body.allowVideo===true?'允许图片与视频。':'只允许图片，不安排视频。'}只建议修改未开始任务。creativeAssets 是当前可选创作图片元数据，可按 id 选择 sourceAssetId，并核对 productId 与商品关系；不需要图片 URL。资料图片不是创作素材，禁止将识别资料作为生成来源。`});
    const text=String(response.text||'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    plan=JSON.parse(text);
    if(!Array.isArray(plan.additions)||!Array.isArray(plan.updates))throw new Error('invalid plan');
    if(plan.additions.length>50||plan.updates.length>200||(!body.allowVideo&&plan.additions.some(t=>t.kind==='video')))throw new Error('invalid plan');
   }catch{status='failed';}
   await this.store.change(workspace,id,null,project=>{
    const suggestions=(project.suggestions||[]).map(s=>s.id===suggestion.id?{...s,status,plan:status==='ready'?plan:null,usage:response?.usage||null,error:status==='failed'?'安排失败或返回内容无效，原任务与要求已保留。':null}:s);
    suggestion=suggestions.find(s=>s.id===suggestion.id);return {...project,suggestions};
   },{keepRevision:true});
  }
  return {...await this.detail(workspace,id),suggestion};
 }
 async applySuggestion(workspace,id,body={}) {
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const suggestion=(project.suggestions||[]).find(s=>s.id===body.suggestionId);
   if(!suggestion||suggestion.status!=='ready')fail('SUGGESTION_INVALID','请选择待确认的AI安排。');
   if(suggestion.baseGraphHash!==hash({tasks:project.tasks,edges:project.edges}))fail('SUGGESTION_STALE','画布已变化，请重新安排。',409);
   const history=(await client.query('SELECT DISTINCT task_id FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id])).rows;
   const tasks=clone(project.tasks);
   for(const update of suggestion.plan.updates) {
    const task=tasks.find(t=>t.id===update.id);
    if(!task||history.some(r=>r.task_id===update.id))fail('SUGGESTION_STARTED','AI只能修改未开始的任务；已有结果保持原样。',409);
    for(const key of ['title','prompt','params','sourceAssetId','dimension'])if(update.changes?.[key]!==undefined)task[key]=clone(update.changes[key]);
    if(task.kind==='video'&&update.changes?.params!==undefined)task.params=normalizeVideoParameters(task.params);
   }
   for(const addition of suggestion.plan.additions) {
    if(addition.kind==='video'&&!suggestion.allowVideo)fail('VIDEO_NOT_REQUESTED','未明确要求视频，不能新增视频任务。');
    if(addition.params!==undefined&&(!addition.params||Array.isArray(addition.params)||typeof addition.params!=='object'))fail('TASK_INVALID','任务参数需要有效的 JSON 对象。');
    const added={id:addition.id&&/^[\w-]{1,100}$/.test(addition.id)?addition.id:randomUUID(),kind:LEGACY_KIND(addition.kind||'generate'),title:addition.title,prompt:addition.prompt,params:addition.params||{},subject:addition.subject||'concept',sourceAssetId:addition.sourceAssetId||null,sourceRunId:null,position:addition.position||{x:100+(tasks.length%4)*340,y:120+Math.floor(tasks.length/4)*260},productSnapshot:project.productSnapshot};
    if(typeof addition.dimension==='string'&&addition.dimension.trim())added.dimension=addition.dimension.trim().slice(0,24);
    if(added.kind==='video')added.params=normalizeVideoParameters(added.params);
    tasks.push(added);
   }
   const planEdges=suggestion.plan.edges===undefined?[...project.edges]:[...project.edges,...suggestion.plan.edges];
   // AI 新增的生成节点自动接上商品素材与提示词，让来源一眼可见。
   const productNode=tasks.find(t=>t.kind==='product'||(t.kind==='image'&&t.sourceAssetId));
   const promptNode=tasks.find(t=>t.kind==='prompt'&&(t.prompt||'').trim());
   const addedIds=new Set(suggestion.plan.additions.map((_,index)=>tasks.at(-suggestion.plan.additions.length+index)?.id).filter(Boolean));
   for(const task of tasks.filter(t=>addedIds.has(t.id))){
    const kind=nodeKind(task);
    const hasInbound=edge=>planEdges.some(e=>e.target===task.id&&(edge===undefined||e.targetHandle===edge));
    if(productNode?.sourceAssetId&&['generate','edit','video'].includes(kind)&&!hasInbound(kind==='video'?'first':kind==='edit'?'image':'ref')){
     planEdges.push({id:randomUUID(),source:productNode.id,sourceHandle:'image',target:task.id,targetHandle:kind==='video'?'first':kind==='edit'?'image':'ref'});
    }
    if(promptNode&&kind==='generate'&&!(task.prompt||'').trim()&&!hasInbound('prompt')){
     planEdges.push({id:randomUUID(),source:promptNode.id,sourceHandle:'text',target:task.id,targetHandle:'prompt'});
    }
   }
   let next={...project,tasks,edges:planEdges,suggestions:(project.suggestions||[]).map(s=>s.id===suggestion.id?{...s,status:'applied'}:s)};
   if(project.workflows?.length) {
    const workflows=clone(project.workflows), extraTasks=[], extraEdges=[];
    for(const task of tasks.filter(t=>addedIds.has(t.id))) {
     const created=createWorkflow(project,{...task,nodeId:task.id,id:undefined,sourceAssetId:task.sourceAssetId||productNode?.sourceAssetId||null,prompt:task.prompt||promptNode?.prompt||''},randomUUID);
     workflows.push(created.workflow);
     // Explicit AI dependencies take precedence; generated helper inputs fill only empty ports.
     const explicit=suggestion.plan.edges||[];
     extraTasks.push(...created.tasks);
     extraEdges.push(...created.edges.filter(e=>!explicit.some(p=>p.target===e.target&&p.targetHandle===e.targetHandle)));
    }
    next={...next,workflows,tasks:[...tasks.filter(t=>!addedIds.has(t.id)),...extraTasks],edges:[...project.edges,...(suggestion.plan.edges||[]),...extraEdges]};
   }
   graph(next.tasks,next.edges);
   for(const task of project.tasks) {
    if(history.some(r=>r.task_id===task.id)&&hash(project.edges.filter(e=>e.target===task.id))!==hash(next.edges.filter(e=>e.target===task.id)))fail('SUGGESTION_STARTED','AI不能更改已有生成记录任务的输入连线。',409);
   }
   await this.validateReferences(workspace,next,client,project);return next;
  });
  return this.detail(workspace,id);
 }
 // 列表摘要：卡片只渲染名称、商品名、封面图、任务/工作流数量与更新时间；画布详情走 GET /projects/:id。
 // page：{limit,offset,q}，q 匹配项目名或商品名；limit 缺省返回全部。
 async list(workspace,page={}) {
  const {rows,total}=await this.store.page(workspace,{kinds:['project'],limit:page.limit,offset:page.offset,where:page.q?add=>{const q=add(page.q);return [`(position(lower(${q}) in lower(coalesce(body->>'name','')))>0 OR position(lower(${q}) in lower(coalesce(body->'productSnapshot'->>'name','')))>0)`];}:null,projection:`body->>'name' AS name,body->>'productId' AS product_id,body->'productSnapshot'->>'name' AS product_name,
   CASE WHEN jsonb_typeof(body->'tasks')='array' THEN jsonb_array_length(body->'tasks') ELSE 0 END AS task_count,
   CASE WHEN jsonb_typeof(body->'workflows')='array' THEN jsonb_array_length(body->'workflows') ELSE 0 END AS workflow_count,
   (SELECT t->>'sourceAssetId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(body->'tasks')='array' THEN body->'tasks' ELSE '[]'::jsonb END) t WHERE t->>'sourceAssetId' IS NOT NULL AND t->>'sourceAssetId'<>'' LIMIT 1) AS cover_asset_id`});
  return {total,projects:rows.map(r=>({id:r.id,name:r.name,revision:r.revision,productId:r.product_id||null,productSnapshot:r.product_name?{name:r.product_name}:null,taskCount:r.task_count,workflowCount:r.workflow_count||1,coverAssetId:r.cover_asset_id||null,trashedAt:r.trashed_at,createdAt:r.created_at,updatedAt:r.updated_at}))};
 }

 // ---------- 视频工作室（脚本 → 分镜 → 逐镜生成 → 拼接成片） ----------
 // 分镜即画布节点：每个分镜对应一个 video 节点，任务队列 / 费用 / 素材归集完全复用现有体系。
 // 入参可以是项目记录（读 project.storyboard）或分镜对象本身。
 normalizeStoryboard(project) {
  const source=project&&typeof project==='object'&&project.storyboard&&typeof project.storyboard==='object'&&!Array.isArray(project.storyboard)?project.storyboard:(project&&typeof project==='object'?project:{});
  const input=source&&typeof source==='object'&&!Array.isArray(source)?source:{};
  const script=typeof input.script==='string'?input.script.slice(0,40000):'';
  const shots=Array.isArray(input.shots)?input.shots:[];
  if(shots.length>30) fail('STORYBOARD_INVALID','分镜最多 30 个。');
  const seen=new Set();
  // 分镜只保存顺序、标题、描述与节点编号；提示词、时长、方式、首帧等配置只存在画布视频节点上（V-08）。
  // 旧数据里的 prompt / duration / mode / sourceAssetId / sourceRunId 副本在读取时丢弃，节点保持不变。
  const clean=shots.map((shot,index)=>{
   if(!shot||typeof shot!=='object'||Array.isArray(shot)) fail('STORYBOARD_INVALID','分镜格式无效。');
   const id=uuid.test(shot.id||'')?shot.id:randomUUID();
   if(seen.has(id)) fail('STORYBOARD_INVALID','分镜编号重复。');seen.add(id);
   return {
    id,
    title:String(shot.title||`分镜 ${index+1}`).trim().slice(0,100)||`分镜 ${index+1}`,
    description:typeof shot.description==='string'?shot.description.slice(0,4000):'',
    nodeId:uuid.test(shot.nodeId||'')?shot.nodeId:null,
   };
  });
  const compile=input.compile&&typeof input.compile==='object'?input.compile:{};
  const settings=normalizeVideoSettings(input.settings);
  return {script,shots:clean,...(settings?{settings}:{}),scriptRequest:this.normRequest(input.scriptRequest),shotsRequest:this.normRequest(input.shotsRequest),batch:this.normBatch(input.batch),
   compile:{status:['running','succeeded','failed'].includes(compile.status)?compile.status:'idle',assetId:uuid.test(compile.assetId||'')?compile.assetId:null,error:typeof compile.error==='string'?compile.error.slice(0,400):null,startedAt:compile.startedAt||null,finishedAt:compile.finishedAt||null,requestKey:typeof compile.requestKey==='string'?compile.requestKey:null,
    // 字幕：burnSubtitles 是本次成片请求的选择；subtitles 记录结果（srt 只在服务端保存，详情接口不下发）。
    ...(typeof compile.burnSubtitles==='boolean'?{burnSubtitles:compile.burnSubtitles}:{}),...(this.normSubtitles(compile.subtitles)?{subtitles:this.normSubtitles(compile.subtitles)}:{})}};
 }
 normSubtitles(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  return {burned:input.burned===true,cueCount:Number.isSafeInteger(input.cueCount)&&input.cueCount>=0?input.cueCount:0,...(typeof input.srt==='string'&&input.srt?{srt:input.srt.slice(0,MAX_SRT_BYTES)}:{}),...(Array.isArray(input.durations)?{durations:input.durations.slice(0,200).map(d=>Number.isFinite(d)&&d>0?d:null)}:{})};
 }
 normRequest(input) {
  if(!input||typeof input!=='object')return null;
  return {id:typeof input.id==='string'?input.id:null,requestKey:typeof input.requestKey==='string'?input.requestKey:null,instructions:typeof input.instructions==='string'?input.instructions.slice(0,4000):'',status:['pending','ready','failed','applied','discarded'].includes(input.status)?input.status:null,error:typeof input.error==='string'?input.error.slice(0,400):null,baseGraphHash:typeof input.baseGraphHash==='string'?input.baseGraphHash:null,usage:input.usage||null,...(input.suggestion&&typeof input.suggestion==='object'&&!Array.isArray(input.suggestion)?{suggestion:input.suggestion}:{})};
 }
 // 批量生成：items 以分镜编号为键，记录状态、运行编号与第几次尝试。
 normBatch(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||!BATCH_STATES.includes(input.state))return null;
  const items={};
  for(const [shotId,item] of Object.entries(input.items&&typeof input.items==='object'?input.items:{})) {
   if(!uuid.test(shotId)||!item||typeof item!=='object')continue;
   items[shotId]={status:BATCH_ITEM_STATES.includes(item.status)?item.status:'pending',runId:uuid.test(item.runId||'')?item.runId:null,attempt:Number.isSafeInteger(item.attempt)&&item.attempt>=1?item.attempt:1,reason:typeof item.reason==='string'?item.reason.slice(0,400):null};
  }
  return {id:typeof input.id==='string'?input.id:randomUUID(),requestKey:typeof input.requestKey==='string'?input.requestKey:null,state:input.state,reason:typeof input.reason==='string'?input.reason.slice(0,400):null,
   shotIds:(Array.isArray(input.shotIds)?input.shotIds:[]).filter(id=>typeof id==='string'&&uuid.test(id)).slice(0,30),items,
   retryKeys:(Array.isArray(input.retryKeys)?input.retryKeys:[]).filter(key=>typeof key==='string').slice(-20),createdAt:typeof input.createdAt==='string'?input.createdAt:null};
 }
 // 项目级视频参数（W4）：把设置并入分镜节点的有效 params。预览、批量、开始、配音时长都读这份有效项目，
 // 冻结进运行记录的 task 也是有效版本，所以项目参数变化会让「相同输入」的复用判断失效。没有设置时原样返回，旧项目行为不变。
 effective(project) {
  const settings=normalizeVideoSettings(project?.storyboard?.settings);
  if(!settings||!Array.isArray(project?.tasks))return project;
  const nodes=new Set((Array.isArray(project.storyboard?.shots)?project.storyboard.shots:[]).map(shot=>shot?.nodeId).filter(Boolean));
  return {...project,tasks:project.tasks.map(task=>task.kind==='video'&&nodes.has(task.id)?{...task,params:effectiveVideoParams(settings,task.params)}:task)};
 }
 // 新建分镜节点的 params：项目有设置时只写与项目时长不同的时长，分辨率与比例留空跟随项目；没有设置时沿用原默认值。
 newShotParams(settingsLike,duration) {
  const settings=normalizeVideoSettings(settingsLike);
  if(!settings)return {duration,resolution:'768P',ratio:'9:16'};
  return duration===(settings.duration??SETTING_DEFAULTS.duration)?{}:{duration};
 }
 // 将分镜同步到画布：只同步标题、补建缺失节点、删除没有运行记录的孤儿节点；提示词与时长不再回写（V-08）。
 // seeds[shotId]={prompt,duration} 仅在新建节点时作为初始值（AI 生成分镜、旧客户端）；返回 {tasks,edges,storyboard}（shot.nodeId 已回写）。
 async applyStoryboardToProject(workspace,project,storyboard,client,seeds={}) {
  const history=(await client.query('SELECT task_id,status FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,project.id])).rows;
  const stateOf=taskId=>{const rows=history.filter(r=>r.task_id===taskId);return {count:rows.length,active:rows.some(r=>['queued','submitting','running','unknown','cancelling'].includes(r.status))};};
  const tasks=clone(project.tasks),edges=clone(project.edges||[]);
  const existingVideoCount=tasks.filter(t=>t.kind==='video').length;
  let created=0;
  for(const shot of storyboard.shots) {
   let node=shot.nodeId?tasks.find(t=>t.id===shot.nodeId&&t.kind==='video'):null;
   if(!node) {
    const seed=seeds[shot.id]||{};
    const duration=Number.isSafeInteger(seed.duration)?Math.min(30,Math.max(4,seed.duration)):5;
    node={id:randomUUID(),kind:'video',title:shot.title,prompt:typeof seed.prompt==='string'?seed.prompt.slice(0,7000):'',videoMode:'text',params:this.newShotParams(storyboard.settings,duration),subject:project.productId?'product':'concept',productSnapshot:project.productSnapshot,position:{x:80+(existingVideoCount+created)*340,y:860},sourceAssetId:null,sourceRunId:null,dimension:'视频分镜'};
    tasks.push(node);created+=1;
   }
   shot.nodeId=node.id;
   const state=stateOf(node.id);
   if(state.active&&node.title!==shot.title)fail('SHOT_LOCKED',`分镜「${shot.title}」正在生成，不能修改标题；请等待结束或取消。`,409);
   node.title=shot.title;
  }
  // 移除已删除分镜的节点：已有生成记录的节点保留（历史记录不可删）。
  const removed=new Set();
  for(const node of tasks.filter(t=>t.kind==='video')) {
   if(storyboard.shots.some(shot=>shot.nodeId===node.id))continue;
   if(stateOf(node.id).count)continue;
   const index=tasks.findIndex(t=>t.id===node.id);
   if(index>=0)tasks.splice(index,1);
   removed.add(node.id);
   for(let i=edges.length-1;i>=0;i--)if(edges[i].source===node.id||edges[i].target===node.id)edges.splice(i,1);
  }
  // 引用了已移除节点、尚未截取的上一镜尾帧选择一并清除。
  if(removed.size)for(const task of tasks)if(task.tailFrame&&removed.has(task.tailFrame.fromNodeId))task.tailFrame=null;
  // 批次只保留仍存在的分镜。
  const batch=storyboard.batch;
  if(batch) {
   const alive=new Set(storyboard.shots.map(s=>s.id));
   batch.items=Object.fromEntries(Object.entries(batch.items).filter(([shotId])=>alive.has(shotId)));
   batch.shotIds=batch.shotIds.filter(shotId=>alive.has(shotId));
  }
  return {tasks,edges,storyboard};
 }
 // 旧客户端 / AI 分镜：按下标把原始入参里的 prompt / duration 取作新节点的初始值。
 seedsFrom(raw,clean) {
  const seeds={};
  (Array.isArray(raw)?raw:[]).forEach((shot,index)=>{
   const id=clean[index]?.id;if(!id||!shot||typeof shot!=='object')return;
   const duration=Number(shot.duration);
   seeds[id]={...(typeof shot.prompt==='string'?{prompt:shot.prompt}:{}),...(Number.isSafeInteger(duration)?{duration}:{})};
  });
  return seeds;
 }
 async saveStoryboard(workspace,id,body) {
  await this.store.change(workspace,id,revision(body),async(project,client)=>{
   this.assertProject(project);
   const applied=await this.patchStoryboard(workspace,project,body,client);
   return {...project,storyboard:applied.storyboard,tasks:applied.tasks,edges:applied.edges};
  });
  return this.detail(workspace,id);
 }
 // 分镜编辑（saveStoryboard 与 ops 的 storyboard.patch 共用）：规范化脚本与分镜，补建缺失节点、清理孤儿节点。
 // shots 里没有 nodeId 的分镜若与服务端同编号分镜匹配，沿用其节点（重复提交不会重复建节点）。
 async patchStoryboard(workspace,project,{script,shots,settings:settingsIn},client) {
  const current=this.normalizeStoryboard(project);
  // 项目级视频参数（W4）：undefined 保持不变，null 清除，对象需通过严格校验。
  let settings=current.settings??null;
  if(settingsIn!==undefined){const checked=checkVideoSettings(settingsIn);if(checked.error)fail('STORYBOARD_SETTINGS_INVALID',checked.error,422);settings=checked.settings;}
  const known=new Map(current.shots.map(s=>[s.id,s]));
  const merged=Array.isArray(shots)?shots.map(shot=>shot&&typeof shot==='object'&&!shot.nodeId&&known.get(shot.id)?.nodeId?{...shot,nodeId:known.get(shot.id).nodeId}:shot):shots;
  const next=this.normalizeStoryboard({script:script!==undefined?script:current.script,shots:merged!==undefined?merged:current.shots,...(settings?{settings}:{}),compile:current.compile,batch:current.batch,scriptRequest:current.scriptRequest,shotsRequest:current.shotsRequest});
  const seeds=merged!==undefined?this.seedsFrom(merged,next.shots):{};
  return this.applyStoryboardToProject(workspace,project,next,client,seeds);
 }
 async generateScript(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','生成脚本需要唯一请求编号。');
  const instructions=typeof body.instructions==='string'?body.instructions.slice(0,4000):'';
  let invoke=false,context;
  await this.store.change(workspace,id,null,async(project)=>{
   this.assertProject(project);
   const current=this.normalizeStoryboard(project);
   const existing=current.scriptRequest;
   if(existing&&existing.requestKey===body.requestKey) {
    if(existing.instructions!==instructions)fail('REQUEST_KEY_CONFLICT','请求编号已用于不同的脚本要求。',409);
    return null;
   }
   current.scriptRequest={id:randomUUID(),requestKey:body.requestKey,instructions,status:'pending',createdAt:new Date().toISOString()};
   context={productSnapshot:project.productSnapshot,projectName:project.name,script:current.script};
   invoke=true;
   return {...project,storyboard:current};
  },{keepRevision:true});
  if(invoke) {
   let script,status='ready',error=null,usage=null;
   try {
    const response=await this.hub.complete({workspaceId:workspace,stage:'planning',messages:[{role:'user',content:JSON.stringify({task:'video-script',instructions,projectName:context.projectName,product:context.productSnapshot,existingScript:context.script})}],system:'你是电商短视频脚本作者。根据商品事实与创作要求写一条带货短视频口播脚本，输出纯 JSON {"script":"脚本全文"}。脚本包含镜头节奏提示（如【开场】【卖点】【特写】【收尾】），事实不得猜测，缺失信息留白；全文不超过1200字。'});
    usage=response.usage||null;
    const text=String(response.text||'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    try {const parsed=JSON.parse(text);script=String(parsed.script||'').trim();}
    catch {script=text;}
    if(!script)throw new Error('empty script');
   }catch{status='failed';error='脚本生成失败或返回内容无效，可重试或手动填写。';}
   await this.store.change(workspace,id,null,project=>{
    const current=this.normalizeStoryboard(project);
    const request=current.scriptRequest?.requestKey===body.requestKey?{...current.scriptRequest,status,error}:current.scriptRequest;
    return {...project,storyboard:{...current,script:status==='ready'?script.slice(0,40000):current.script,scriptRequest:request}};
   },{keepRevision:true});
  }
  return this.detail(workspace,id);
 }
 async generateShots(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','生成分镜需要唯一请求编号。');
  let invoke=false,context;
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const current=this.normalizeStoryboard(project);
   if(!(current.script||'').trim())fail('SCRIPT_REQUIRED','请先生成或填写视频脚本。');
   const existing=current.shotsRequest;
   if(existing&&existing.requestKey===body.requestKey)return null;
   current.shotsRequest={id:randomUUID(),requestKey:body.requestKey,status:'pending',baseGraphHash:hash({tasks:project.tasks,edges:project.edges}),createdAt:new Date().toISOString()};
   const catalog=await this.materialCatalog(workspace,project,client);
   context={script:current.script,productSnapshot:project.productSnapshot,catalog};
   invoke=true;
   return {...project,storyboard:current};
  },{keepRevision:true});
  if(invoke) {
   let suggestion=null,status='ready',error=null,usage=null;
   try {
    const {items,blocked}=context.catalog;
    const response=await this.hub.complete({workspaceId:workspace,stage:'planning',messages:[{role:'user',content:JSON.stringify({task:'video-storyboard',script:context.script,product:context.productSnapshot,materials:materialsForModel(items)})}],system:SHOT_PLANNING_SYSTEM});
    usage=response.usage||null;
    const text=String(response.text||'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    const parsed=JSON.parse(text);
    if(!Array.isArray(parsed.shots)||!parsed.shots.length||parsed.shots.length>30)throw new Error('invalid shots');
    const byKey=new Map(items.map(item=>[item.key,item]));
    const plans=parsed.shots.map((raw,index)=>sanitizeShotPlan(raw,index,byKey));
    const used=new Set(plans.flatMap(plan=>plan.materials.map(m=>m.key)));
    suggestion={shots:plans.map(plan=>previewShot(plan,byKey)),plans,materials:items.filter(item=>used.has(item.key)),...(blocked?{notice:blocked}:{})};
   }catch{status='failed';error='分镜生成失败或返回内容无效，可重试或手动添加分镜。';}
   // 结果只作为待确认的建议保存，不写入分镜和画布；确认接口才创建节点。
   await this.store.change(workspace,id,null,project=>{
    const current=this.normalizeStoryboard(project);
    if(current.shotsRequest?.requestKey!==body.requestKey)return null;
    let request={...current.shotsRequest,status,error,usage};
    if(status==='ready'&&request.baseGraphHash&&request.baseGraphHash!==hash({tasks:project.tasks,edges:project.edges}))request={...request,status:'failed',error:'画布在生成分镜期间发生了变化，请重试。'};
    else if(status==='ready')request={...request,suggestion};
    return {...project,storyboard:{...current,shotsRequest:request}};
   },{keepRevision:true});
  }
  return this.detail(workspace,id);
 }
 // ---------- AI 分镜：素材清单与确认（V-16） ----------
 // 可用素材：商品创作图片、项目内成功的生成结果（图片与视频）、项目或商品下上传的音频与视频；每项一个短编号 M1、M2…。
 async materialCatalog(workspace,project,client=this.pool) {
  // 旧版画布里 image 是可执行任务；加入素材连线会改变节点语义，这类画布暂不提供素材。
  if(isLegacyGraph(project)&&project.tasks.some(t=>t.kind==='image'))return {items:[],blocked:'这个项目仍是旧版画布，AI 暂不能为分镜安排素材；分镜会使用文生视频。'};
  const assets=await this.store.list(workspace,'asset',false,client);
  const usable=a=>!a.deletionPending&&!a.trashedAt&&!['mask','evidence','voice'].includes(a.role)&&typeof a.mime==='string';
  const kindOf=mime=>mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':null;
  const items=[],seen=new Set();
  const product=project.productId?await this.store.get(workspace,project.productId,client):null;
  const productCreative=new Set(product?.kind==='product'?(product.creativeAssetIds||[]):[]);
  const add=(asset,origin)=>{
   const kind=kindOf(asset.mime);if(!kind||seen.has(asset.id))return;
   seen.add(asset.id);items.push({kind,assetId:asset.id,runId:null,nodeId:null,name:String(asset.name||'素材').slice(0,80),origin});
  };
  for(const asset of assets.filter(a=>usable(a)&&a.role==='creative')) {
   const kind=kindOf(asset.mime);
   if(productCreative.has(asset.id)&&kind==='image')add(asset,'商品创作素材');
   else if(asset.projectId===project.id)add(asset,'项目上传素材');
   else if(project.productId&&asset.productId===project.productId&&!asset.projectId&&['audio','video'].includes(kind))add(asset,'商品下上传的素材');
  }
  // 画布节点已有的成功结果：每个节点取最近 3 个版本，连线时固定该版本。
  const runs=(await client.query("SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 AND status='succeeded' ORDER BY created_at,id",[workspace,project.id])).rows.map(runView).filter(r=>r.output?.assetId);
  const assetMap=new Map(assets.map(a=>[a.id,a]));
  const results=[];
  for(const node of project.tasks.filter(t=>EXECUTABLE_KINDS.has(t.kind))) {
   const nodeRuns=runs.filter(r=>r.taskId===node.id);
   nodeRuns.slice(-3).forEach((run,index,list)=>{
    const asset=assetMap.get(run.output.assetId);if(!asset||!usable(asset))return;
    const kind=kindOf(asset.mime);if(!['image','video'].includes(kind))return;
    const version=nodeRuns.length-list.length+index+1;
    results.push({createdAt:run.createdAt,item:{kind,assetId:asset.id,runId:run.id,nodeId:node.id,name:`${node.title}（版本 ${version}）`.slice(0,80),origin:`项目生成结果：${node.title}，版本 ${version}`}});
   });
  }
  results.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  for(const {item} of results){if(seen.has(item.assetId))continue;seen.add(item.assetId);items.push(item);}
  const capped=items.slice(0,MAX_PLAN_MATERIALS);
  return {items:capped.map((item,index)=>({...item,key:`M${index+1}`})),blocked:items.length>capped.length?`素材较多，只向 AI 提供了前 ${MAX_PLAN_MATERIALS} 项。`:null};
 }
 // 确认 AI 分镜建议：创建分镜与视频节点，素材连线（已有结果固定版本，素材库资产新建输入节点），{{M1}} 改写为 {{ref:节点编号}}。
 async applyShotsRequest(workspace,id,body={}) {
  if(typeof body.requestId!=='string'||!body.requestId)fail('SUGGESTION_INVALID','请选择待确认的分镜建议。');
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const current=this.normalizeStoryboard(project),request=current.shotsRequest;
   if(!request||request.id!==body.requestId)fail('SUGGESTION_INVALID','没有找到这条分镜建议，请重新生成。',404);
   if(request.status==='applied')return null;
   if(request.status==='discarded')fail('SUGGESTION_INVALID','这条分镜建议已放弃，请重新生成。',409);
   if(request.status!=='ready'||!request.suggestion?.plans?.length)fail('SUGGESTION_INVALID','分镜建议还没有生成完成。',409);
   if(request.baseGraphHash!==hash({tasks:project.tasks,edges:project.edges}))fail('SUGGESTION_STALE','画布在建议生成后已变化，请重新生成分镜。',409);
   const {plans,materials}=request.suggestion;
   if(current.shots.length+plans.length>30)fail('STORYBOARD_INVALID','应用后分镜会超过 30 个，请先删除部分分镜。');
   if(materials.length&&isLegacyGraph(project)&&project.tasks.some(t=>t.kind==='image'))fail('SUGGESTION_STALE','项目仍是旧版画布，不能自动连线素材；请重新生成分镜。',409);
   // 素材仍然存在且不在回收站；已有结果仍是该节点的成功版本。
   const byKey=new Map();
   for(const item of materials) {
    const asset=await this.store.get(workspace,item.assetId,client);
    if(!asset||asset.kind!=='asset'||asset.deletionPending||asset.trashedAt)fail('SUGGESTION_STALE',`素材「${item.name}」已不可用，请重新生成分镜。`,409);
    if(item.runId) {
     const run=(await client.query('SELECT status,output FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND task_id=$4',[workspace,id,item.runId,item.nodeId])).rows[0];
     if(!run||run.status!=='succeeded'||run.output?.assetId!==item.assetId)fail('SUGGESTION_STALE',`素材「${item.name}」对应的生成结果已变化，请重新生成分镜。`,409);
    }
    byKey.set(item.key,item);
   }
   const laid=this.layoutShotNodes(project,plans,byKey);
   graph(laid.tasks,laid.edges);
   await this.validateReferences(workspace,{...project,tasks:laid.tasks,edges:laid.edges},client,project);
   const nextRequest={...request,status:'applied',appliedAt:new Date().toISOString()};
   delete nextRequest.suggestion;
   return {...project,tasks:laid.tasks,edges:laid.edges,storyboard:{...current,shots:[...current.shots,...laid.shots],shotsRequest:nextRequest}};
  });
  return this.detail(workspace,id);
 }
 // 为每个建议分镜创建视频节点与素材连线，位置排在现有节点下方（每镜一列，输入节点在上、视频节点在下）。
 layoutShotNodes(project,plans,byKey) {
  const tasks=clone(project.tasks),edges=clone(project.edges||[]);
  const subject=project.productId?'product':'concept';
  const makeNode=extra=>({id:randomUUID(),prompt:'',params:{},subject,productSnapshot:project.productSnapshot,sourceAssetId:null,sourceRunId:null,...extra});
  const NODE_W=340,NODE_H=260;
  const baseY=tasks.length?Math.max(...tasks.map(t=>t.position.y))+NODE_H+80:80;
  const baseX=tasks.length?Math.min(...tasks.map(t=>t.position.x)):80;
  const videoY=baseY+Math.max(0,...plans.map(plan=>plan.materials.length))*NODE_H;
  const assetNodes=new Map(),shots=[];
  plans.forEach((plan,column)=>{
   const x=baseX+column*(NODE_W+40);
   let row=0;
   const video=makeNode({kind:'video',title:plan.title,params:this.newShotParams(project.storyboard?.settings,plan.duration),position:{x,y:videoY},videoMode:plan.videoMode,dimension:'视频分镜'});
   const nodeOfKey=new Map(),pins=[];
   for(const {key,slot} of plan.materials) {
    const item=byKey.get(key);
    if(!item)fail('SUGGESTION_STALE','分镜建议引用的素材不完整，请重新生成分镜。',409);
    let source;
    // 已有画布结果：连线到该节点并固定版本（同一节点只能固定一个版本；固定上限 8 个，超出的改用素材节点）。
    if(item.runId&&pins.length<MAX_REFERENCE_IMAGES&&!pins.includes(item.runId)&&!nodeOfKey.has(`node:${item.nodeId}`)) {
     source=tasks.find(t=>t.id===item.nodeId);
     pins.push(item.runId);nodeOfKey.set(`node:${item.nodeId}`,source.id);
     edges.push({id:randomUUID(),source:source.id,target:video.id,sourceHandle:item.kind==='video'?'video':'image',targetHandle:slot});
    }else{
     const kind=item.kind==='audio'?'audio':item.kind==='video'?'footage':'image';
     source=assetNodes.get(item.assetId);
     if(!source){source=makeNode({kind,title:item.name.slice(0,100),sourceAssetId:item.assetId,position:{x,y:baseY+row*NODE_H}});row+=1;tasks.push(source);assetNodes.set(item.assetId,source);}
     edges.push({id:randomUUID(),source:source.id,target:video.id,sourceHandle:kind==='footage'?'video':kind,targetHandle:slot});
    }
    nodeOfKey.set(key,source.id);
   }
   if(pins.length)video.sourceRunIds=pins;
   video.prompt=plan.prompt.replace(/\{\{([^{}]+)\}\}/g,(_,key)=>nodeOfKey.has(key)?`{{ref:${nodeOfKey.get(key)}}}`:'').trim();
   if(plan.dialogue.length){video.dialogue=plan.dialogue;video.dubMode=plan.videoMode==='reference'?'lipsync':'post';}
   tasks.push(video);
   shots.push({id:randomUUID(),title:plan.title,description:plan.description,nodeId:video.id});
  });
  return {tasks,edges,shots};
 }
 // 放弃分镜建议：只标记 discarded，不改画布；已应用的建议不能放弃。
 async discardShotsRequest(workspace,id,body={}) {
  if(typeof body.requestId!=='string'||!body.requestId)fail('SUGGESTION_INVALID','请选择要放弃的分镜建议。');
  await this.store.change(workspace,id,null,project=>{
   this.assertProject(project);
   const current=this.normalizeStoryboard(project),request=current.shotsRequest;
   if(!request||request.id!==body.requestId)fail('SUGGESTION_INVALID','没有找到这条分镜建议。',404);
   if(request.status==='discarded')return null;
   if(request.status==='applied')fail('SUGGESTION_INVALID','这条分镜建议已应用，不能放弃。',409);
   const next={...request,status:'discarded'};
   delete next.suggestion;
   return {...project,storyboard:{...current,shotsRequest:next}};
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 // ---------- 上一镜尾帧（V-12） ----------
 // 节点上被固定的成功运行集合（sourceRunId / sourceRunIds）。
 pinsOf(node,runs) {
  return [node?.sourceRunId,...pinList(node)].map(id=>id?runs.find(r=>r.id===id&&r.status==='succeeded'&&r.output?.assetId):null).filter(Boolean);
 }
 // 尾帧已过期的分镜：上一镜已不是截取来源，或上一镜之后有了更新的成功运行。
 staleTailShots(sb,project,runs) {
  const stale=new Set();
  sb.shots.forEach((shot,index)=>{
   const node=project.tasks.find(t=>t.id===shot.nodeId),tf=node?.tailFrame;
   if(!tf?.assetId)return;
   const prev=sb.shots[index-1];
   if(!prev?.nodeId||tf.fromNodeId!==prev.nodeId){stale.add(shot.id);return;}
   const target=this.latestVideoSuccess(prev.nodeId,this.pinsOf(node,runs),runs);
   if(!target||target.id!==tf.runId)stale.add(shot.id);
  });
  return stale;
 }
 // 取上一镜被固定或最新的成功视频运行，截取最后一帧并写入该分镜节点（首帧来源）。
 // runId 指定时从该运行截取（批次派发）；截帧与存储在事务之外完成，只有写节点时才持有工作空间锁。
 async extractTailFrame(workspace,id,{shotId,runId=null}={}) {
  const detail=await this.detail(workspace,id);this.assertProject(detail.project);
  const {project,runs}=detail,sb=this.normalizeStoryboard(project);
  const index=sb.shots.findIndex(s=>s.id===shotId);
  if(index<0)fail('SHOT_NOT_FOUND','分镜不存在。',404);
  const shot=sb.shots[index],node=project.tasks.find(t=>t.id===shot.nodeId&&t.kind==='video');
  if(!node)fail('SHOT_NOT_SYNCED','请先保存分镜，同步到画布后再截取尾帧。',409);
  const prev=sb.shots[index-1],prevNode=prev?.nodeId?project.tasks.find(t=>t.id===prev.nodeId&&t.kind==='video'):null;
  if(!prevNode)fail('NO_PREVIOUS_SHOT','这是第一个分镜，没有上一镜。',409);
  if(node.videoMode!=='frames')fail('TAIL_FRAME_MODE','请先把本镜的视频方式设为首尾帧。',409);
  const source=runId?runs.find(r=>r.id===runId&&r.taskId===prevNode.id&&r.status==='succeeded'&&r.output?.assetId&&r.input?.kind==='video'):this.latestVideoSuccess(prevNode.id,this.pinsOf(node,runs),runs);
  if(!source)fail('PREVIOUS_SHOT_PENDING','等待上一镜生成成功',409);
  const same=node.tailFrame?.runId===source.id&&node.tailFrame?.assetId&&node.tailFrame?.fromNodeId===prevNode.id;
  if(!same) {
   const file=await this.media.read(workspace,source.output.assetId);
   const frame=await this.frameExtractor.extract({bytes:file.bytes,mime:file.mime});
   const asset=await this.media.put(workspace,{bytes:frame.bytes,mime:frame.mime,name:`${shot.title}-上一镜尾帧.png`.slice(0,180),projectId:id,taskId:node.id,role:'result',derivedFrom:{runId:source.id,kind:'tail-frame'}});
   await this.store.change(workspace,id,null,async(current,client)=>{
    this.assertProject(current);
    const target=current.tasks.find(t=>t.id===node.id);
    if(!target)fail('SHOT_NOT_FOUND','分镜节点已不存在。',409);
    const busy=(await client.query("SELECT 1 FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3 AND status IN ('queued','submitting','running','unknown','cancelling') LIMIT 1",[workspace,id,node.id])).rows.length;
    if(busy)fail('SHOT_LOCKED',`分镜「${shot.title}」正在生成，不能更换首帧。`,409);
    return {...current,tasks:current.tasks.map(t=>t.id===node.id?{...t,tailFrame:{fromNodeId:prevNode.id,runId:source.id,assetId:asset.id}}:t)};
   },{keepRevision:true});
  }
  return this.detail(workspace,id);
 }

 // 路由入口：POST /storyboard/tail-frame {shotId}；上一镜之后有更新的成功运行时，同一入口用于「换用新尾帧」。
 async tailFrame(workspace,id,body={}) {
  return this.extractTailFrame(workspace,id,{shotId:body.shotId});
 }

 // ---------- 批量生成（V-17） ----------
 // 分镜 → 它所依赖的上一镜（首尾帧方式、选了「上一镜尾帧」且没有首帧连线）。
 shotDeps(sb,project) {
  const deps={};
  sb.shots.forEach((shot,index)=>{
   const node=project.tasks.find(t=>t.id===shot.nodeId);
   if(!node?.tailFrame||node.videoMode!=='frames')return;
   if((project.edges||[]).some(e=>e.target===node.id&&e.targetHandle==='first'))return;
   // 「上一镜」始终指分镜顺序中的前一个分镜。
   const prev=sb.shots[index-1];
   if(prev?.nodeId)deps[shot.id]=prev.id;
  });
  return deps;
 }
 // 批次预览：逐镜给出可执行性（含「等待上一镜」）、预估积分与余额。不写任何数据。
 async batchPlan(workspace,id,body={},client=this.pool,{checkBalance=true}={}) {
  const detail=await this.detail(workspace,id,client),{runs}=detail,project=this.effective(detail.project);this.assertProject(project);
  const sb=this.normalizeStoryboard(project);
  const requested=[...new Set(Array.isArray(body.shotIds)?body.shotIds:[])];
  if(!requested.length||requested.length>30||requested.some(shotId=>!sb.shots.some(s=>s.id===shotId&&s.nodeId)))fail('BATCH_SELECTION_INVALID','请选择已同步到画布的分镜。');
  const picked=sb.shots.filter(s=>requested.includes(s.id)),inBatch=new Set(picked.map(s=>s.id)),deps=this.shotDeps(sb,project);
  const entries=[];
  for(const shot of picked) {
   const node=project.tasks.find(t=>t.id===shot.nodeId),dependsOn=deps[shot.id]||null;
   // 用户把分镜放进批次即确认「失败后重试」，所以预览按重试处理。
   const p=await this.preview(workspace,id,{taskIds:[shot.nodeId],retryTaskIds:[shot.nodeId]},client,{checkBalance:false});
   const own=p.scope.find(e=>e.taskId===shot.nodeId)||{action:'blocked',reason:'分镜节点不可用。'};
   let action=['generate','reuse','recover'].includes(own.action)?own.action:'blocked',reason=action==='blocked'?own.reason||'':'',autoTail=false,model=own.model||null;
   if(dependsOn&&inBatch.has(dependsOn)) {action='wait-prev';reason='等待上一镜生成成功后，自动截取尾帧并生成。';}
   else if(own.action==='wait-input'&&own.resolved?.tailWait==='extract') {action='generate';autoTail=true;reason='将先截取上一镜尾帧，再生成。';}
   else if(own.action==='wait-input'&&own.resolved?.tailWait==='prev') {action='blocked';reason='上一镜尚无成功视频：请先生成上一镜，或把上一镜加入本批。';}
   let estimatedPoints=null;
   if(['generate','wait-prev'].includes(action)||autoTail) {
    if(!model){try{model=await this.hub.resolve('video',node.model||undefined,client);}catch{model=null;}}
    estimatedPoints=model?this.estimatePoints(node,model):null;
   }
   entries.push({shotId:shot.id,nodeId:shot.nodeId,title:shot.title,action,reason,estimatedPoints,channelId:model?.channelId||null,dependsOn,autoTail,inputHash:hash([inputFingerprint(node,project.edges),own.resolved??null]),reuseRunId:own.reuseRunId||null,recoverRunId:own.action==='recover'?runs.filter(r=>r.taskId===shot.nodeId).at(-1)?.id||null:null});
  }
  const estimatedTotal=Math.round(entries.reduce((sum,e)=>sum+(e.estimatedPoints||0),0)*100)/100;
  let canStart=entries.some(e=>['generate','wait-prev','recover'].includes(e.action))&&!entries.some(e=>e.action==='blocked');
  let balance=null,balanceShortfall=0,balanceReason=null;
  const priced=entries.filter(e=>e.estimatedPoints>0&&e.channelId);
  if(checkBalance&&priced.length&&typeof this.hub?.videoBalance==='function') {
   const channelId=priced[0].channelId;
   try {
    const result=await this.hub.videoBalance(channelId);
    if(result&&Number.isFinite(result.available)) {
     balance={available:result.available};
     const needed=Math.round(priced.filter(e=>e.channelId===channelId).reduce((sum,e)=>sum+e.estimatedPoints,0)*100)/100;
     if(result.available<needed){balanceShortfall=Math.round((needed-result.available)*100)/100;canStart=false;balanceReason=`积分不足：预计需要 ${needed} 积分，当前可用 ${result.available} 积分，还差 ${balanceShortfall} 积分。`;}
    }
   }catch{balance=null;}
  }
  const previewToken=hash({entries:entries.map(e=>[e.shotId,e.action,e.reason,e.estimatedPoints,e.dependsOn,e.inputHash]),states:runs.map(r=>[r.id,r.status])});
  return {revision:project.revision,previewToken,shotIds:picked.map(s=>s.id),entries,canStart,estimatedPoints:estimatedTotal,balance,...(balanceShortfall?{balanceShortfall,balanceReason}:{})};
 }
 async batchPreview(workspace,id,body={}) {return this.batchPlan(workspace,id,body);}
 async batchStart(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','批量生成需要唯一请求编号。');
  const shotKey=ids=>hash([...new Set(ids||[])].sort());
  // 同一请求编号：直接返回已有批次（幂等）；范围不同则冲突。
  const existing=this.normalizeStoryboard((await this.detail(workspace,id)).project).batch;
  if(existing?.requestKey===body.requestKey) {
   if(shotKey(existing.shotIds)!==shotKey(body.shotIds))fail('REQUEST_KEY_CONFLICT','同一请求编号不能用于不同的分镜范围。',409);
   return this.detail(workspace,id);
  }
  // 余额检查放在事务之外（外部请求不能占着数据库事务）；与预览同一套规则，查询失败或未知时放行。
  const ahead=await this.batchPlan(workspace,id,body);
  if(ahead.balanceReason)fail('INSUFFICIENT_POINTS',ahead.balanceReason,409);
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const sb=this.normalizeStoryboard(project);
   if(sb.batch?.requestKey===body.requestKey)return null;
   if(sb.batch&&['running','paused'].includes(sb.batch.state))fail('BATCH_ACTIVE','已有批量生成正在进行，请等待结束或先停止。',409);
   const plan=await this.batchPlan(workspace,id,body,client,{checkBalance:false});
   if(body.previewToken!==plan.previewToken)fail('PREVIEW_CHANGED','分镜或模型状态已变化，请重新预览。',409);
   if(!plan.canStart)fail('START_BLOCKED','批量范围尚不能开始，请处理提示后重新预览。',409);
   const items={};
   for(const entry of plan.entries)items[entry.shotId]=entry.action==='reuse'?{status:'succeeded',runId:entry.reuseRunId,attempt:1,reason:null}:entry.action==='recover'?{status:'running',runId:entry.recoverRunId,attempt:1,reason:null}:{status:'pending',runId:null,attempt:1,reason:null};
   const batch={id:randomUUID(),requestKey:body.requestKey,state:'running',reason:null,shotIds:plan.shotIds,items,retryKeys:[],createdAt:new Date().toISOString()};
   return {...project,storyboard:{...sb,batch}};
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 // 用户显式重试：该分镜与依赖它的 held 分镜回到 pending（尝试次数 +1），批次恢复运行。
 async batchRetry(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','重试需要唯一请求编号。');
  await this.store.change(workspace,id,null,async project=>{
   this.assertProject(project);
   const sb=this.normalizeStoryboard(project),batch=sb.batch;
   if(!batch)fail('BATCH_NOT_FOUND','没有批量生成任务。',404);
   if(batch.retryKeys.includes(body.requestKey))return null;
   if(batch.state==='cancelled')fail('BATCH_CANCELLED','批量生成已停止，请重新选择分镜开始。',409);
   const item=batch.items[body.shotId];
   if(!item)fail('BATCH_ITEM_NOT_FOUND','该分镜不在批量生成中。',404);
   if(item.status!=='failed')fail('BATCH_ITEM_NOT_FAILED','只有失败的分镜可以重试。',409);
   const deps=this.shotDeps(sb,project),reset=new Set([body.shotId]);
   for(let changed=true;changed;) {
    changed=false;
    for(const [shotId,other] of Object.entries(batch.items))if(!reset.has(shotId)&&other.status==='held'&&reset.has(deps[shotId])){reset.add(shotId);changed=true;}
   }
   for(const shotId of reset)batch.items[shotId]={status:'pending',runId:null,attempt:batch.items[shotId].attempt+1,reason:null};
   batch.state='running';batch.reason=null;batch.retryKeys=[...batch.retryKeys,body.requestKey].slice(-20);
   return {...project,storyboard:{...sb,batch}};
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 // 停止派发新的分镜；已提交的运行不受影响。
 async batchCancel(workspace,id) {
  await this.store.change(workspace,id,null,async project=>{
   this.assertProject(project);
   const sb=this.normalizeStoryboard(project),batch=sb.batch;
   if(!batch)fail('BATCH_NOT_FOUND','没有批量生成任务。',404);
   if(!['running','paused'].includes(batch.state))return null;
   batch.state='cancelled';batch.reason='已停止批量生成；已经提交的分镜会继续完成。';
   return {...project,storyboard:{...sb,batch}};
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 // 因积分不足暂停的批次：用户补足积分后继续派发。
 async batchResume(workspace,id) {
  await this.store.change(workspace,id,null,async project=>{
   this.assertProject(project);
   const sb=this.normalizeStoryboard(project),batch=sb.batch;
   if(!batch)fail('BATCH_NOT_FOUND','没有批量生成任务。',404);
   if(batch.state==='running')return null;
   if(batch.state!=='paused')fail('BATCH_NOT_PAUSED','只有已暂停的批量生成可以继续。',409);
   batch.state='running';batch.reason=null;
   return {...project,storyboard:{...sb,batch}};
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 // tick：推进所有进行中的批次。每个批次用独立的会话级咨询锁，截帧与余额查询都不持有工作空间锁。
 async advanceBatches() {
  const rows=(await this.pool.query(`SELECT workspace_id,id FROM sj_creation_records WHERE kind='project' AND trashed_at IS NULL AND NOT COALESCE((body->>'deletionPending')::boolean,false) AND (body->'storyboard'->'batch'->>'state'='running' OR (body->'storyboard'->'batch'->>'state' IN ('paused','cancelled') AND jsonb_path_exists(body,'$.storyboard.batch.items.* ? (@.status=="running")'))) ORDER BY updated_at LIMIT 20`)).rows;
  let errors=0;
  for(const row of rows) {try{await this.advanceBatch(row.workspace_id,row.id);}catch{errors+=1;}}
  return {batches:rows.length,errors};
 }
 async advanceBatch(workspace,id) {
  const client=await this.pool.connect();let locked=false;
  try {
   locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[`sj:creation:batch:${id}`])).rows[0].locked;
   if(!locked)return false;
   await this.syncBatch(workspace,id);
   for(let step=0;step<30;step+=1)if(!await this.dispatchNext(workspace,id))break;
   return true;
  }finally {if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`sj:creation:batch:${id}`]);client.release();}
 }
 // 把运行结果同步到批次分镜状态；失败时其后依赖它的分镜标 held，其余继续；全部结束为 done。无变化不写入。
 async syncBatch(workspace,id) {
  await this.store.change(workspace,id,null,async(project,client)=>{
   const sb=this.normalizeStoryboard(project),batch=sb.batch;
   if(!batch)return null;
   const before=hash(batch);
   const runs=(await client.query('SELECT id,status,error FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id])).rows;
   for(const item of Object.values(batch.items)) {
    if(item.status!=='running'||!item.runId)continue;
    const run=runs.find(r=>r.id===item.runId);if(!run)continue;
    if(run.status==='succeeded')item.status='succeeded';
    else if(run.status==='failed'){item.status='failed';item.reason=run.error?.message||'生成失败。';}
    else if(run.status==='cancelled'){item.status='failed';item.reason='生成已取消。';}
   }
   const deps=this.shotDeps(sb,project),titleOf=shotId=>sb.shots.find(s=>s.id===shotId)?.title||'上一镜';
   for(let changed=true;changed;) {
    changed=false;
    for(const [shotId,item] of Object.entries(batch.items)) {
     const dep=deps[shotId];
     if(item.status==='pending'&&dep&&['failed','held'].includes(batch.items[dep]?.status)){item.status='held';item.reason=`上一镜「${titleOf(dep)}」未成功，本镜暂停；重试上一镜后会继续。`;changed=true;}
    }
   }
   if(['running','paused'].includes(batch.state)&&Object.values(batch.items).every(item=>['succeeded','failed','held'].includes(item.status))){batch.state='done';batch.reason=null;}
   if(hash(batch)===before)return null;
   return {...project,storyboard:{...sb,batch}};
  },{keepRevision:true});
 }
 // 派发一个分镜：活跃视频运行最多 3 个；依赖上一镜的分镜等其成功后先截帧再派发；派发前复查余额。返回是否有进展。
 async dispatchNext(workspace,id) {
  const {project,runs}=await this.detail(workspace,id);
  if(project.kind!=='project'||project.trashedAt||project.deletionPending)return false;
  const sb=this.normalizeStoryboard(project),batch=sb.batch;
  if(!batch||batch.state!=='running')return false;
  if(runs.filter(r=>r.input?.kind==='video'&&active.has(r.status)).length>=BATCH_CONCURRENCY)return false;
  const deps=this.shotDeps(sb,project);
  const next=sb.shots.find(shot=>{const item=batch.items[shot.id];if(!item||item.status!=='pending')return false;const dep=deps[shot.id];return !(dep&&batch.items[dep])||batch.items[dep].status==='succeeded';});
  if(!next)return false;
  const item=batch.items[next.id],attempt=item.attempt,node=project.tasks.find(t=>t.id===next.nodeId);
  const failItem=async reason=>{
   await this.store.change(workspace,id,null,current=>{
    const cs=this.normalizeStoryboard(current),b=cs.batch,it=b?.items[next.id];
    if(!b||!it||it.status!=='pending'||it.attempt!==attempt)return null;
    it.status='failed';it.reason=String(reason).slice(0,400);
    return {...current,storyboard:{...cs,batch:b}};
   },{keepRevision:true});
   return true;
  };
  if(!node)return failItem('分镜节点已不存在。');
  // 派发前复查余额：已知且不足则暂停批次；未知（查询失败）放行。
  let model=null;
  try{model=await this.hub.resolve('video',node.model||undefined);}catch{model=null;}
  const points=model?this.estimatePoints(node,model):null;
  if(points>0&&model?.channelId&&typeof this.hub?.videoBalance==='function') {
   let available=null;
   try{const result=await this.hub.videoBalance(model.channelId);if(result&&Number.isFinite(result.available))available=result.available;}catch{available=null;}
   if(available!==null) {
    // 已入队但尚未提交的运行还没占用平台积分，先从可用余额里扣除。
    const queued=runs.filter(r=>r.input?.kind==='video'&&r.status==='queued').reduce((sum,r)=>sum+(this.estimatePoints(r.input.task||{},r.input.model)||0),0);
    if(available-queued<points) {
     const reason=`积分不足：下一镜「${next.title}」预计需要 ${points} 积分，当前可用 ${Math.round((available-queued)*100)/100} 积分，批量生成已暂停；补足积分后点击「继续」。`;
     await this.store.change(workspace,id,null,current=>{
      const cs=this.normalizeStoryboard(current),b=cs.batch;
      if(!b||b.state!=='running')return null;
      b.state='paused';b.reason=reason;
      return {...current,storyboard:{...cs,batch:b}};
     },{keepRevision:true});
     return false;
    }
   }
  }
  // 需要尾帧：先截帧写入节点（ffmpeg 在事务之外），再派发。
  const dep=deps[next.id];
  if(dep) {
   const depRun=batch.items[dep]?runs.find(r=>r.id===batch.items[dep].runId):null;
   const source=batch.items[dep]?depRun:(node.tailFrame?.assetId?null:this.latestVideoSuccess(sb.shots.find(s=>s.id===dep)?.nodeId,this.pinsOf(node,runs),runs));
   if(batch.items[dep]&&!depRun?.output?.assetId)return failItem('上一镜没有可用的成功视频，无法截取尾帧。');
   if(!batch.items[dep]&&!node.tailFrame?.assetId&&!source)return failItem('上一镜尚无成功视频，无法截取尾帧。');
   if(source&&node.tailFrame?.runId!==source.id) {
    try{await this.extractTailFrame(workspace,id,{shotId:next.id,runId:source.id});}
    catch(e){return failItem(e instanceof AppError?e.message:'截取上一镜尾帧失败，请重试。');}
   }
  }
  await this.store.change(workspace,id,null,async(current,client)=>{
   this.assertProject(current);
   const cs=this.normalizeStoryboard(current),b=cs.batch,it=b?.items[next.id];
   if(!b||b.state!=='running'||!it||it.status!=='pending'||it.attempt!==attempt)return null;
   const target=this.effective(current).tasks.find(t=>t.id===next.nodeId);
   const p=await this.preview(workspace,id,{taskIds:[next.nodeId],retryTaskIds:[next.nodeId]},client,{checkBalance:false});
   const entry=p.scope.find(e=>e.taskId===next.nodeId);
   if(entry?.action==='generate') {
    const requestKey=this.derivedRequestKey(b.requestKey,next.id,attempt);
    it.runId=await this.insertRun(client,workspace,current,target,entry,{requestKey,start:{requestKey,batchId:b.id,shotId:next.id,attempt}});
    it.status='running';it.reason=null;
   }else if(entry?.action==='reuse'){it.status='succeeded';it.runId=entry.reuseRunId;it.reason=null;}
   else if(entry?.action==='recover'){
    it.runId=(await client.query('SELECT id FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 AND task_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[workspace,id,next.nodeId])).rows[0]?.id||null;
    it.status='running';it.reason=null;
   }
   else {it.status='failed';it.reason=String(entry?.reason||'分镜暂时不能生成。').slice(0,400);}
   return {...current,storyboard:{...cs,batch:b}};
  },{keepRevision:true});
  return true;
 }
 async compileStoryboard(workspace,id,body={}) {
  if(!uuid.test(body.requestKey||''))fail('REQUEST_KEY_REQUIRED','拼接成片需要唯一请求编号。');
  if(body.burnSubtitles!==undefined&&typeof body.burnSubtitles!=='boolean')fail('COMPILE_OPTION_INVALID','「烧录字幕」需为开或关。');
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const current=this.normalizeStoryboard(project);
   if(!current.shots.length)fail('COMPILE_EMPTY','请先生成分镜。');
   if(current.compile.status==='running'&&current.compile.startedAt&&Date.now()-new Date(current.compile.startedAt).getTime()<30*60*1000)fail('COMPILE_RUNNING','成片正在拼接中，请稍候。',409);
   const runs=(await client.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at,id',[workspace,id])).rows.map(runView);
   for(const shot of current.shots) {
    if(!this.shotVideoFor(shot,runs,project))fail('COMPILE_INCOMPLETE',`分镜「${shot.title}」还没有生成成功的视频，先完成全部分镜。`,409);
   }
   return {...project,storyboard:{...current,compile:{status:'running',requestKey:body.requestKey,startedAt:new Date().toISOString(),finishedAt:null,assetId:null,error:null,burnSubtitles:body.burnSubtitles===true}}};
  },{keepRevision:true});
  this.scheduleCompile(workspace,id,body.requestKey);
  return this.detail(workspace,id);
 }
 // 每镜用于拼接的视频：当前取该分镜节点最新成功运行的视频。
 // 第 5 步（火山语音配音）接入后，有后期配音的分镜应优先返回混音后的派生视频，其余仍用 H3 原始视频；调用方只依赖 {assetId,runId}。
 shotVideoFor(shot,runs,project=null) {
  const run=(runs||[]).filter(r=>r.taskId===shot.nodeId&&r.status==='succeeded'&&r.output?.assetId&&r.input?.kind==='video').at(-1);
  if(!run)return null;
  // 后期配音：最新成功运行有与当前台词、角色一致的混音成片时，优先使用派生视频；否则回退 H3 原视频。
  const dub=this.freshDub(run,project?.tasks?.find(t=>t.id===shot.nodeId),project);
  return dub?{assetId:dub.assetId,runId:run.id,dub:true}:{assetId:run.output.assetId,runId:run.id};
 }
 // 运行的混音结果是否仍与节点当前配音一致。
 freshDub(run,task,project) {
  const dub=run?.output?.dub;
  if(!dub||dub.status!=='succeeded'||!dub.assetId||!task||task.dubMode!=='post')return null;
  const state=dubState(task,project?.voiceRoles);
  return state.hash&&state.hash===dub.dialogueHash&&task.dialogueAudio?.hash===dub.dialogueHash?dub:null;
 }
 // 分镜字幕（V-25）：只有后期配音或口型同步、配音与当前台词一致、且「本镜显示字幕」未关闭时才有。
 shotCues(task,voiceRoles) {
  if(!task||task.subtitles===false||!['post','lipsync'].includes(task.dubMode))return [];
  if(dialogueAudioStatus(task,voiceRoles)!=='fresh')return [];
  return Array.isArray(task.dialogueAudio.cues)?task.dialogueAudio.cues:[];
 }
 // 成片拼接用：该镜字幕，以及读不到视频时长时的预估时长（配音版视频时长 → 生成用量秒数 → 节点设置的时长）。
 shotSubtitles(shot,runs,project) {
  const task=this.effective(project)?.tasks?.find(t=>t.id===shot.nodeId),cues=this.shotCues(task,project?.voiceRoles);
  if(!cues.length)return {cues:[],fallbackDuration:null};
  const run=(runs||[]).filter(r=>r.taskId===shot.nodeId&&r.status==='succeeded'&&r.output?.assetId&&r.input?.kind==='video').at(-1);
  const dub=this.freshDub(run,task,project),used=Number(run?.usage?.total_seconds);
  const seconds=[dub?.videoSeconds,used,task?.params?.duration].find(v=>Number.isFinite(v)&&v>0);
  return {cues,fallbackDuration:seconds||5};
 }
 // 下载字幕 SRT：最近一次成功成片对应的字幕；还没有成片时，用当前分镜按最新成功视频时长生成。
 async subtitlesSrt(workspace,id) {
  // 详情接口不下发 SRT 全文，这里直接读取项目记录。
  const project=await this.store.get(workspace,id);
  if(!project||project.kind!=='project')fail('NOT_FOUND','项目不存在。',404);
  this.assertProject(project);
  const runs=(await this.pool.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at,id',[workspace,id])).rows.map(runView);
  const storyboard=this.normalizeStoryboard(project),compile=storyboard.compile;
  let srt='';
  if(compile.status==='succeeded'&&compile.subtitles?.srt)srt=compile.subtitles.srt;
  else {
   const durations=compile.status==='succeeded'?compile.subtitles?.durations||[]:[];
   srt=buildSrt(buildFilmCues(storyboard.shots.map((shot,index)=>{const info=this.shotSubtitles(shot,runs,project);return {cues:info.cues,duration:durations[index]||info.fallbackDuration};})));
  }
  if(!srt)fail('SUBTITLES_EMPTY','还没有可导出的字幕：请先为分镜合成台词配音，并保持「本镜显示字幕」开启。',409);
  return {bytes:Buffer.from(srt,'utf8'),name:`${project.name}-字幕.srt`.slice(0,150)};
 }
 scheduleCompile(workspace,id,requestKey) {
  // 后台拼接：不阻塞请求；结束或失败都回写 compile 状态，成片归集为项目结果素材。
  void (async()=>{
   try {
    const detail=await this.detail(workspace,id);
    const storyboard=this.normalizeStoryboard(detail.project);
    if(storyboard.compile.status!=='running'||storyboard.compile.requestKey!==requestKey)return;
    const files=[];
    for(const shot of storyboard.shots) {
     const video=this.shotVideoFor(shot,detail.runs,detail.project);
     if(!video)throw new AppError('COMPILE_INCOMPLETE',`分镜「${shot.title}」还没有生成成功的视频，先完成全部分镜。`,409);
     const file=await this.media.read(workspace,video.assetId);
     files.push({bytes:file.bytes,name:file.name||`${shot.title}.mp4`,mime:file.mime,...this.shotSubtitles(shot,detail.runs,detail.project)});
    }
    const burnSubtitles=storyboard.compile.burnSubtitles===true,report={};
    const bytes=Buffer.from(await this.compileBytes({files,burnSubtitles,report}));
    // 真实 ffmpeg 会填 report；测试替身没填时，按各镜字幕与预估时长补算，保证记录一致。
    if(report.cueCount===undefined){const cues=buildFilmCues(files.map(f=>({cues:f.cues,duration:f.fallbackDuration})));Object.assign(report,{cueCount:cues.length,burned:false,srt:buildSrt(cues)});}
    const asset=await this.media.put(workspace,{bytes,mime:'video/mp4',name:`${detail.project.name}-成片.mp4`.slice(0,180),projectId:id,role:'result'});
    const subtitles={burned:report.burned===true,cueCount:report.cueCount,srt:report.srt||'',durations:report.durations||[]};
    await this.store.change(workspace,id,null,project=>({ ...project,storyboard:{...this.normalizeStoryboard(project),compile:{status:'succeeded',assetId:asset.id,requestKey,startedAt:null,finishedAt:new Date().toISOString(),error:null,burnSubtitles,subtitles}} }),{keepRevision:true});
   }catch(e) {
    await this.store.change(workspace,id,null,project=>({ ...project,storyboard:{...this.normalizeStoryboard(project),compile:{status:'failed',requestKey,error:e instanceof AppError?e.message:'拼接失败，请重试。',startedAt:null,finishedAt:new Date().toISOString(),assetId:null,burnSubtitles:this.normalizeStoryboard(project).compile.burnSubtitles}} }),{keepRevision:true}).catch(()=>{});
   }
  })();
 }



 async export(workspace,id,body={}) {
  const {project,runs}=await this.detail(workspace,id);
  const ids=body.runIds||runs.filter(r=>r.status==='succeeded'&&r.output?.assetId).map(r=>r.id);
  if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!runs.some(r=>r.id===id&&r.status==='succeeded')))fail('EXPORT_SELECTION','请选择1至100个本项目成功版本。');
  const selected=[...new Set(ids)].map(id=>runs.find(r=>r.id===id)),files=[];let total=0;
  for(const run of selected){
   const file=await this.media.read(workspace,run.output.assetId);total+=file.bytes.length;
   if(total>256*1024*1024)fail('EXPORT_TOO_LARGE','单次打包不能超过256 MB，请分批下载。',413);
   const ext=file.mime==='video/mp4'?'mp4':file.mime==='image/jpeg'?'jpg':file.mime==='image/webp'?'webp':'png';
   files.push({name:`${String(run.input.task.title).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,60)}-${run.id}.${ext}`,data:file.bytes});
  }
  files.unshift({name:'manifest.json',data:Buffer.from(JSON.stringify({projectId:id,name:project.name,versions:selected},null,2))});
  return {bytes:buildZip(files),mime:'application/zip',name:`${project.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,60)}.zip`};
 }
 async syncProduct(workspace,id,body={}) {
  await this.store.change(workspace,id,null,async(project,client)=>{
   this.assertProject(project);
   const product=await this.store.get(workspace,project.productId,client);
   if(!product||product.kind!=='product')fail('PRODUCT_NOT_FOUND','原商品已不存在。',404);
   const history=(await client.query('SELECT DISTINCT task_id FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id])).rows;
   const productSnapshot=snapshot(product);
   return {...project,productSnapshot,tasks:project.tasks.map(t=>history.some(r=>r.task_id===t.id)?t:{...t,productSnapshot})};
  });
  return this.detail(workspace,id);
 }
 async create(workspace,body={}) {
  const client=await this.pool.connect();let project;
  try {
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sj:creation:'+workspace]);
   let product;
   if(body.productId) {product=await this.store.get(workspace,body.productId,client);if(!product||product.kind!=='product'||product.trashedAt||product.deletionPending)fail('PRODUCT_NOT_FOUND','商品不存在或已在回收站。',404);}
   const productSnapshot=product?snapshot(product):null;
   if(![3,4].includes(body.graphVersion)){
    const tasks=[{id:randomUUID(),kind:'image',title:product?'商品主图':'场景概念图',prompt:'',params:{},position:{x:100,y:120},subject:product?'product':'concept',productSnapshot,sourceAssetId:null,sourceRunId:null}];
    if(body.template){const template=await this.store.get(workspace,body.template.id,client);if(!template||template.kind!=='template'||template.trashedAt||template.deletionPending)fail('TEMPLATE_UNAVAILABLE','模板不可用，请重新选择。',409);const frozen={id:template.id,revision:template.revision,name:template.name,mediaKind:template.mediaKind,prompt:template.prompt,params:template.params};tasks[0]={...tasks[0],kind:template.mediaKind||'image',title:template.name,prompt:template.prompt,params:clone(template.params),templateSnapshot:frozen};}
    project=await this.store.create(workspace,'project',{name:String(body.name||`${product?.name||'新建'}创作`).trim().slice(0,200),productId:product?.id||null,productSnapshot,tasks,edges:[],viewport:{x:0,y:0,zoom:1}},client);
    await client.query('COMMIT');
    return this.detail(workspace,project.id);
   }
   const creativeAssetId=(product?.creativeAssetIds||[])[0]||null;
   const productId=randomUUID();
   const promptId=randomUUID();
   const generateId=randomUUID();
   const tasks=[
    {id:productId,kind:'product',title:product?.name||'商品输入',prompt:'',params:{},position:{x:60,y:140},subject:'product',productSnapshot,sourceAssetId:creativeAssetId,sourceRunId:null},
    {id:promptId,kind:'prompt',title:'提示词',prompt:'',params:{},position:{x:60,y:540},subject:product?'product':'concept',productSnapshot,sourceAssetId:null,sourceRunId:null},
    {id:generateId,kind:'generate',title:product?'商品主图':'场景概念图',prompt:'',params:{},position:{x:450,y:240},subject:product?'product':'concept',productSnapshot,sourceAssetId:null,sourceRunId:null},
   ];
   const edges=[
    {id:randomUUID(),source:promptId,target:generateId,sourceHandle:'text',targetHandle:'prompt'},
    ...(creativeAssetId?[{id:randomUUID(),source:productId,target:generateId,sourceHandle:'image',targetHandle:'ref'}]:[]),
   ];
   if(body.template) {
    const template=await this.store.get(workspace,body.template.id,client);
    if(!template||template.kind!=='template'||template.trashedAt||template.deletionPending)fail('TEMPLATE_UNAVAILABLE','模板不可用，请重新选择。',409);
    const frozen={id:template.id,revision:template.revision,name:template.name,mediaKind:template.mediaKind,prompt:template.prompt,params:template.params};
    const target=tasks.find(t=>t.id===generateId);target.kind=LEGACY_KIND(template.mediaKind||'generate');target.title=template.name;target.prompt=template.prompt;target.params=clone(template.params);target.templateSnapshot=frozen;
    if(target.kind==='video'){const edge=edges.find(e=>e.targetHandle==='ref');if(edge)edge.targetHandle='first';}
   }
   let initial={name:String(body.name||`${product?.name||'新建'}创作`).trim().slice(0,200),productId:product?.id||null,productSnapshot,tasks,edges,viewport:{x:0,y:0,zoom:1}};
   if(body.graphVersion===4) {
    const target=tasks.find(t=>t.id===generateId);
    const created=createWorkflow(initial,{...target,nodeId:target.id,id:undefined,sourceAssetId:creativeAssetId},randomUUID);
    initial={...initial,graphVersion:4,workflows:[created.workflow],tasks:created.tasks,edges:created.edges};
   }
   project=await this.store.create(workspace,'project',initial,client);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return this.detail(workspace,project.id);
 }
 async detail(workspace,id,client=this.pool) {
  const project=await this.store.get(workspace,id,client);if(!project||project.kind!=='project')fail('NOT_FOUND','项目不存在。',404);
  const runs=(await client.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at,id',[workspace,id])).rows.map(runView);
  const usages=[...runs.map(r=>r.usage),...(project.suggestions||[]).filter(s=>s.status!=='pending').map(s=>s.usage)];
  const known=usages.filter(u=>Number.isSafeInteger(u?.costMicros)&&u.costMicros>=0);
  const currencies=[...new Set(known.map(u=>u.currency).filter(Boolean))];
  const unknownRuns=usages.length-known.length;
  const knownAmount=known.reduce((sum,u)=>sum+u.costMicros/1e6,0);
  const out=clone(project);
  if(out.storyboard&&typeof out.storyboard==='object'&&!Array.isArray(out.storyboard)) {
   try {
    const sb=this.normalizeStoryboard(project),stale=this.staleTailShots(sb,project,runs);
    out.storyboard={...out.storyboard,shots:sb.shots.map(shot=>stale.has(shot.id)?{...shot,tailFrameStale:true}:shot),...(sb.batch?{batch:sb.batch}:{})};
    // SRT 全文与各镜时长只在服务端保存，不随项目详情下发；界面只需要是否烧录与条目数。
    if(out.storyboard.compile?.subtitles){const {srt:_srt,durations:_durations,...visible}=out.storyboard.compile.subtitles;out.storyboard.compile={...out.storyboard.compile,subtitles:visible};}
   }catch{/* 旧数据异常时保持原样 */}
  }
  const dubStates=this.dubStates(project,runs);
  return {project:out,runs,dubStates,cost:{amount:usages.length&&!unknownRuns&&currencies.length===1?knownAmount:null,currency:currencies.length===1?currencies[0]:null,knownAmount,unknownRuns}};
 }
 async update(workspace,id,body) {
  await this.store.change(workspace,id,revision(body),async(current,client)=>{
   this.assertProject(current);
   const next=clone(current);
   if(body.name!==undefined) {if(typeof body.name!=='string'||!body.name.trim()||body.name.length>200) fail('NAME_INVALID','项目名称需要1至200个字符。');next.name=body.name.trim();}
   if(body.tasks!==undefined) {
    // dialogueAudio 只由服务端「合成配音」写入：客户端传来的值一律忽略，保留当前节点上已有的。
    next.tasks=clone(body.tasks).map(t=>{const {dialogueAudio:_ignored,...rest}=t;const existing=current.tasks.find(c=>c.id===t.id)?.dialogueAudio;return existing?{...rest,dialogueAudio:existing}:rest;});
   }
   if(body.voiceRoles!==undefined) {
    next.voiceRoles=this.checkedVoiceRoles(body.voiceRoles);
   }
   if(body.edges!==undefined) next.edges=clone(body.edges);
   graph(next.tasks,next.edges);
   if(body.workflows!==undefined)next.workflows=clone(body.workflows);
   if(body.viewport!==undefined) {if(!finite(body.viewport?.x)||!finite(body.viewport?.y)||!finite(body.viewport?.zoom)||body.viewport.zoom<0.05||body.viewport.zoom>4)fail('VIEWPORT_INVALID','画布视角无效。');next.viewport=clone(body.viewport);}
   await this.finalizeEdit(workspace,id,current,next,client);
   return next;
  });
  return this.detail(workspace,id);
 }
 // 用户编辑（整项目 PATCH 与增量 ops 共用）的收尾校验：工作流、分镜标题同步、运行中 / 历史节点保护、引用校验。
 async finalizeEdit(workspace,id,current,next,client) {
  graph(next.tasks,next.edges);
  if(next.workflows!==undefined) {
   if(!Array.isArray(next.workflows)||!next.workflows.length||next.workflows.length>100||next.workflows.some(w=>!w||typeof w.id!=='string'||!/^[\w-]{1,100}$/.test(w.id)||typeof w.title!=='string'||!w.title.trim()||w.title.length>100)||new Set(next.workflows.map(w=>w.id)).size!==next.workflows.length)fail('WORKFLOW_INVALID','创作任务需要唯一编号和1至100字的名称。');
   next.workflows=next.workflows.map(w=>({id:w.id,title:w.title.trim()}));
   if(next.tasks.some(t=>t.workflowId&&!next.workflows.some(w=>w.id===t.workflowId)))fail('WORKFLOW_INVALID','节点引用了不存在的创作任务。');
   Object.assign(next,withWorkflows(next));
  }
  // 节点标题是分镜标题的唯一来源：画布改名后，分镜表同步显示。
  if(Array.isArray(next.storyboard?.shots)) {
   let renamed=false;
   const shots=next.storyboard.shots.map(shot=>{const node=next.tasks.find(t=>t.id===shot.nodeId);const title=typeof node?.title==='string'?node.title.trim().slice(0,100):'';if(title&&title!==shot.title){renamed=true;return {...shot,title};}return shot;});
   if(renamed)next.storyboard={...next.storyboard,shots};
  }
  const rows=(await client.query('SELECT task_id,status FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2',[workspace,id])).rows;
  for(const prior of current.tasks) {
   const replacement=next.tasks.find(t=>t.id===prior.id),history=rows.filter(r=>r.task_id===prior.id);
   if(!replacement&&history.length)fail('TASK_HAS_HISTORY','已有生成记录的节点不能移除；请新增节点继续创作。',409);
   if(history.some(r=>active.has(r.status))) {
    if(editableKeys.some(k=>hash(fingerprintValue(prior,k))!==hash(fingerprintValue(replacement,k)))||hash(current.edges.filter(e=>e.target===prior.id))!==hash(next.edges.filter(e=>e.target===prior.id)))fail('TASK_RUNNING','节点尚未结束，不能修改执行输入。',409);
   }
  }
  await this.validateReferences(workspace,next,client,current);
  return next;
 }
 // ---------- 增量保存（POST /ops） ----------
 // 一批操作在同一事务里按顺序应用，不比较整项目修订号：不同节点互不影响，同一字段后写为准。
 // 引用了已被其他窗口删除的节点 / 连线的操作跳过并写入 skipped；校验失败则整批拒绝（沿用原有错误码）。
 async applyOps(workspace,id,body={}) {
  const ops=body?.ops;
  if(!Array.isArray(ops)||!ops.length||ops.length>MAX_OPS)fail('OPS_INVALID',`一次最多提交 1 至 ${MAX_OPS} 个操作。`);
  ops.forEach(checkOp);
  const skipped=[];
  await this.store.change(workspace,id,null,async(current,client)=>{
   this.assertProject(current);
   // 先过一遍 JSON，使日期等字段与 clone 后的 next 同形，再比较哈希。
   const before=hash(clone(current));
   // 旧项目没有创作任务容器时，先补齐（与前端 withWorkflows 一致），保证新增节点带 workflowId 后仍是合法图。
   const base=graphOps(ops)&&!current.workflows?.length?upgradeLegacy(current):current;
   const next=clone(base);
   let graphTouched=false;
   for(const [index,op] of ops.entries()) {
    const skip=reason=>skipped.push({index,type:op.type,...(op.id!==undefined?{id:op.id}:op.task?.id!==undefined?{id:op.task.id}:op.edge?.id!==undefined?{id:op.edge.id}:op.workflow?.id!==undefined?{id:op.workflow.id}:{}),reason});
    if(op.type==='project.patch') {
     if(op.name!==undefined) {if(typeof op.name!=='string'||!op.name.trim()||op.name.length>200)fail('NAME_INVALID','项目名称需要1至200个字符。');next.name=op.name.trim();}
     if(op.voiceRoles!==undefined) next.voiceRoles=this.checkedVoiceRoles(op.voiceRoles);
     continue;
    }
    graphTouched=true;
    if(op.type==='storyboard.patch') {
     const patched=await this.patchStoryboard(workspace,next,{script:op.script,shots:op.shots,settings:op.settings},client);
     next.storyboard=patched.storyboard;next.tasks=patched.tasks;next.edges=patched.edges;
    }else if(op.type==='task.add') {
     const {dialogueAudio:_ignored,...task}=clone(op.task);
     if(next.tasks.some(t=>t.id===task.id)) {skip('exists');continue;}
     if(task.workflowId&&next.workflows&&!next.workflows.some(w=>w.id===task.workflowId)) {skip('workflow-missing');continue;}
     next.tasks.push(task);
    }else if(op.type==='task.patch') {
     const index2=next.tasks.findIndex(t=>t.id===op.id);
     if(index2<0) {skip('missing');continue;}
     const {id:_id,dialogueAudio:_audio,...fields}=clone(op.fields||{});
     const merged={...next.tasks[index2],...fields};
     for(const key of op.unset||[])if(key!=='id'&&key!=='dialogueAudio')delete merged[key];
     next.tasks[index2]=merged;
    }else if(op.type==='task.remove') {
     if(!next.tasks.some(t=>t.id===op.id)) {skip('missing');continue;}
     next.tasks=next.tasks.filter(t=>t.id!==op.id);
     next.edges=next.edges.filter(e=>e.source!==op.id&&e.target!==op.id);
     // 引用了已移除节点的上一镜尾帧选择一并清除（与分镜同步一致）。
     next.tasks=next.tasks.map(t=>t.tailFrame&&t.tailFrame.fromNodeId===op.id?{...t,tailFrame:null}:t);
    }else if(op.type==='edge.add') {
     const edge=clone(op.edge);
     if(next.edges.some(e=>e.id===edge.id)) {skip('exists');continue;}
     if(!next.tasks.some(t=>t.id===edge.source)||!next.tasks.some(t=>t.id===edge.target)) {skip('missing-node');continue;}
     const same=e=>e.source===edge.source&&e.target===edge.target&&(e.sourceHandle||null)===(edge.sourceHandle||null)&&(e.targetHandle||null)===(edge.targetHandle||null);
     if(next.edges.some(same)) {skip('duplicate');continue;}
     next.edges.push(edge);
    }else if(op.type==='edge.remove') {
     if(!next.edges.some(e=>e.id===op.id)) {skip('missing');continue;}
     next.edges=next.edges.filter(e=>e.id!==op.id);
    }else if(op.type==='workflow.put') {
     const workflow=clone(op.workflow);
     next.workflows=Array.isArray(next.workflows)?next.workflows:[];
     const at=next.workflows.findIndex(w=>w.id===workflow.id);
     if(at>=0)next.workflows[at]={...next.workflows[at],...workflow};else next.workflows.push(workflow);
    }else if(op.type==='workflow.remove') {
     if(!next.workflows?.some(w=>w.id===op.id)) {skip('missing');continue;}
     next.workflows=next.workflows.filter(w=>w.id!==op.id);
    }
   }
   if(graphTouched)await this.finalizeEdit(workspace,id,base,next,client);
   // 没有任何实际变化（重复提交 / 全部跳过）时不写入，也不递增修订号。
   return hash(clone(next))===before?null:next;
  });
  return {...await this.detail(workspace,id),skipped};
 }
 checkedVoiceRoles(value) {
  const checked=validateVoiceRoles(value);
  if(checked.error)fail('VOICE_ROLES_INVALID',checked.error);
  return checked.roles;
 }
 // 轻量状态：运行记录（不含冻结输入与结果大字段）、配音状态、分镜批次 / 成片状态。revision 只随用户内容编辑变化。
 async status(workspace,id) {
  const project=await this.store.get(workspace,id);if(!project||project.kind!=='project')fail('NOT_FOUND','项目不存在。',404);
  const runs=(await this.pool.query("SELECT id,project_id,task_id,request_key,status,upstream_id,CASE WHEN output IS NULL THEN NULL ELSE output-'_pendingResult' END AS output,error,usage,created_at,updated_at,jsonb_build_object('kind',input->>'kind') AS input FROM sj_creation_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at,id",[workspace,id])).rows.map(runView);
  let batch=null,compile={status:'idle'};
  try {
   const sb=this.normalizeStoryboard(project);
   batch=sb.batch||null;
   const {subtitles,...rest}=sb.compile;
   compile={...rest,...(subtitles?{subtitles:{burned:subtitles.burned,cueCount:subtitles.cueCount}}:{})};
  }catch{/* 旧数据异常时保持默认 */}
  return {revision:project.revision,runs,dubStates:this.dubStates(project,runs),storyboard:{batch,compile}};
 }
 // 每个有台词的视频节点的配音状态：给界面显示「已合成 / 已过期」「原声 / 配音」，哈希只在服务端计算。
 dubStates(project,runs) {
  const result={};
  for(const task of this.effective(project).tasks||[]){
   if(nodeKind(task)!=='video'||(!task.dialogueAudio&&!(task.dialogue||[]).some(d=>d?.text?.trim())))continue;
   const state=dubState(task,project.voiceRoles),status=dialogueAudioStatus(task,project.voiceRoles);
   const run=runs.filter(r=>r.taskId===task.id&&r.status==='succeeded'&&r.output?.assetId&&r.input?.kind==='video').at(-1)||null;
   const dub=run?.output?.dub||null;
   const fresh=run?this.freshDub(run,task,project):null;
   result[task.id]={status,issue:state.issue,lines:state.lines.length,audio:task.dialogueAudio?{assetId:task.dialogueAudio.assetId,durationSec:task.dialogueAudio.durationSec,textWords:task.dialogueAudio.textWords??null,cues:Array.isArray(task.dialogueAudio.cues)?task.dialogueAudio.cues:null}:null,subtitles:{enabled:task.subtitles!==false,available:this.shotCues({...task,subtitles:true},project.voiceRoles).length>0,active:this.shotCues(task,project.voiceRoles).length>0},suggestion:status==='fresh'?dubSuggestion(task,task.dialogueAudio.durationSec):null,
    dub:dub?{runId:run.id,status:dub.status,error:dub.error||null,truncated:Boolean(dub.truncated),assetId:fresh?dub.assetId:null,outdated:dub.status==='succeeded'&&!fresh}:null,
    needsMix:Boolean(run)&&task.dubMode==='post'&&status==='fresh'&&!fresh&&dub?.status!=='running'};
  }
  return result;
 }
 // 台词配音：逐行合成并拼接为一段 mp3，写入节点 dialogueAudio（付费小额；只在用户点击「合成配音」时调用）。
 async voiceDialogue(workspace,id,body={}) {
  const {project}=await this.detail(workspace,id);this.assertProject(project);
  const task=project.tasks.find(t=>t.id===body.taskId);
  if(!task||nodeKind(task)!=='video')fail('TASK_INVALID','请选择一个视频节点。');
  const result=await this.voice.synthesizeDialogue(workspace,task,project.voiceRoles);
  const asset=await this.media.put(workspace,{bytes:result.bytes,mime:'audio/mpeg',name:`${task.title}-台词配音.mp3`.slice(0,180),projectId:id,taskId:task.id,role:'voice',derivedFrom:{kind:'dialogue-audio',hash:result.hash}});
  await this.store.change(workspace,id,null,current=>{
   this.assertProject(current);
   const node=current.tasks.find(t=>t.id===task.id);
   if(!node)fail('TASK_INVALID','分镜节点已被删除。',409);
   if(dubState(node,current.voiceRoles).hash!==result.hash)fail('DUB_CHANGED','合成期间台词或角色已改动，请重新合成。',409);
   return {...current,tasks:current.tasks.map(t=>t.id===task.id?{...t,dialogueAudio:{assetId:asset.id,hash:result.hash,durationSec:result.durationSec,textWords:result.textWords,lines:result.lines,cues:result.cues||[],createdAt:new Date().toISOString()}}:t)};
  },{keepRevision:true});
  return this.detail(workspace,id);
 }
 // 重新混音：用节点当前的配音对最新成功运行重做混音（不调用付费接口）。
 async voiceRemix(workspace,id,body={}) {
  const {project,runs}=await this.detail(workspace,id);this.assertProject(project);
  const task=project.tasks.find(t=>t.id===body.taskId);
  if(!task||nodeKind(task)!=='video')fail('TASK_INVALID','请选择一个视频节点。');
  if(task.dubMode!=='post')fail('DUB_MODE','只有「后期配音」方式需要混音。');
  const status=dialogueAudioStatus(task,project.voiceRoles);
  if(status==='none')fail('DUB_NOT_READY','请先合成台词配音。');
  if(status==='stale')fail('DUB_STALE','配音已过期，请重新合成台词配音。');
  const run=runs.filter(r=>r.taskId===task.id&&r.status==='succeeded'&&r.output?.assetId&&r.input?.kind==='video').at(-1);
  if(!run)fail('DUB_NO_VIDEO','这个分镜还没有生成成功的视频。',409);
  const outcome=await this.mixRun(workspace,run.id,{force:true,dialogueAudio:task.dialogueAudio});
  if(outcome==='busy')fail('DUB_IN_PROGRESS','正在混音，请稍候。',409);
  return this.detail(workspace,id);
 }
 async setDub(runId,dub) {
  await this.pool.query("UPDATE sj_creation_runs SET output=COALESCE(output,'{}'::jsonb)||jsonb_build_object('dub',$2::jsonb) WHERE id=$1",[runId,JSON.stringify(dub)]);
 }
 // 混音：原视频音轨压低到约 30%，叠加配音，存为派生结果素材。失败只记录在 output.dub，原视频保持成功。
 async mixRun(workspace,runId,{force=false,dialogueAudio=null}={}) {
  const client=await this.pool.connect();let locked=false;
  try {
   locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[`sj:creation:dub:${runId}`])).rows[0].locked;
   if(!locked)return 'busy';
   const run=(await client.query("SELECT * FROM sj_creation_runs WHERE id=$1 AND workspace_id=$2",[runId,workspace])).rows[0];
   if(!run||run.status!=='succeeded'||run.input?.kind!=='video'||!run.output?.assetId)return 'skipped';
   const audio=dialogueAudio||run.input.dialogueAudio;
   if(!audio?.assetId)return 'skipped';
   const dub=run.output.dub;
   if(!force&&dub&&(dub.status==='succeeded'||dub.status==='failed'||(dub.status==='running'&&Date.now()-new Date(dub.startedAt||0).getTime()<30*60*1000)))return 'skipped';
   const base={dialogueHash:audio.hash,audioAssetId:audio.assetId};
   await this.setDub(runId,{...base,status:'running',startedAt:new Date().toISOString()});
   try {
    const video=await this.media.read(workspace,run.output.assetId),voiceAudio=await this.media.read(workspace,audio.assetId);
    const mixed=await this.voice.mixDub({video:video.bytes,audio:voiceAudio.bytes});
    const asset=await this.media.put(workspace,{bytes:mixed.bytes,mime:'video/mp4',name:`${run.input.task?.title||'分镜'}-配音版.mp4`.slice(0,180),projectId:run.project_id,taskId:run.task_id,role:'result',derivedFrom:{runId,kind:'dub',dialogueHash:audio.hash}});
    await this.setDub(runId,{...base,status:'succeeded',assetId:asset.id,fileUrl:`/api/creation/assets/${asset.id}/file`,truncated:mixed.truncated,videoSeconds:mixed.videoSeconds,audioSeconds:mixed.audioSeconds,finishedAt:new Date().toISOString()});
    return 'done';
   }catch(error){
    await this.setDub(runId,{...base,status:'failed',error:error instanceof AppError?error.message.slice(0,300):'混音失败，原视频不受影响，可点击「重新混音」。',finishedAt:new Date().toISOString()}).catch(()=>{});
    return 'failed';
   }
  }finally {if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`sj:creation:dub:${runId}`]);client.release();}
 }
 // 兜底：服务重启等原因让成功的后期配音运行没来得及混音时，补做一次（只做本地 ffmpeg，不产生费用）。
 async mixPending() {
  const rows=(await this.pool.query("SELECT id,workspace_id FROM sj_creation_runs WHERE status='succeeded' AND input->>'dubMode'='post' AND input->'dialogueAudio'->>'assetId' IS NOT NULL AND (output->'dub') IS NULL ORDER BY updated_at LIMIT 3")).rows;
  for(const row of rows)await this.mixRun(row.workspace_id,row.id).catch(()=>{});
  return rows.length;
 }
 assertProject(project) {if(project.kind!=='project'||project.trashedAt||project.deletionPending)fail('PROJECT_UNAVAILABLE','项目不存在或已在回收站。',409);}
 async validateReferences(workspace,project,client=this.pool,previous=project) {
  for(const task of project.tasks) {
   if(task.sourceAssetId) {const asset=await this.store.get(workspace,task.sourceAssetId,client);const retained=previous.tasks?.some(t=>t.id===task.id&&t.sourceAssetId===task.sourceAssetId);if(!asset||asset.kind!=='asset'||asset.deletionPending||(!retained&&asset.trashedAt)||!['creative','result'].includes(asset.role)||!asset.mime?.startsWith(SOURCE_MIME[nodeKind(task)]||'image/'))fail('SOURCE_INVALID',{audio:'音频节点只能选择当前工作空间的音频素材。',footage:'视频素材节点只能选择当前工作空间的视频素材。'}[nodeKind(task)]||'只能选择当前工作空间的创作图片或生成图片；回收站仅保留已有引用。');}
   if(task.sourceRunId) {
    const run=(await client.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND id=$2',[workspace,task.sourceRunId])).rows[0];
    const retained=previous.tasks?.some(t=>t.id===task.id&&t.sourceRunId===task.sourceRunId);
    const asset=run?.output?.assetId?await this.store.get(workspace,run.output.assetId,client):null;
    const inbound=project.edges.filter(e=>e.target===task.id);
    if(!run||run.status!=='succeeded'||!asset||asset.deletionPending||(!retained&&asset.trashedAt)||(inbound.length>0&&!inbound.some(e=>e.source===run.task_id)))fail('SOURCE_RUN_INVALID','请选择一个成功的结果版本。');
   }
   if(task.sourceRunIds!==undefined&&task.sourceRunIds!==null) {
    const ids=task.sourceRunIds;
    if(!Array.isArray(ids)||ids.length>MAX_REFERENCE_IMAGES||ids.some(id=>typeof id!=='string'||!uuid.test(id))||new Set(ids).size!==ids.length||(task.sourceRunId&&ids.includes(task.sourceRunId)))fail('SOURCE_RUN_INVALID','附加来源版本需要是不重复的成功结果版本，最多 8 个。');
    const before=previous.tasks?.find(t=>t.id===task.id)?.sourceRunIds;
    const inbound=project.edges.filter(e=>e.target===task.id);
    for(const runId of ids) {
     const run=(await client.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND id=$2',[workspace,runId])).rows[0];
     const retained=Array.isArray(before)&&before.includes(runId);
     const asset=run?.output?.assetId?await this.store.get(workspace,run.output.assetId,client):null;
     if(!run||run.status!=='succeeded'||!asset||asset.deletionPending||(!retained&&asset.trashedAt)||!inbound.some(e=>e.source===run.task_id))fail('SOURCE_RUN_INVALID','请选择一个成功的结果版本。');
    }
   }
   if(task.maskAssetId!==undefined&&task.maskAssetId!==null) {
    const mask=typeof task.maskAssetId==='string'?await this.store.get(workspace,task.maskAssetId,client):null;
    const retained=previous.tasks?.some(t=>t.id===task.id&&t.maskAssetId===task.maskAssetId);
    if(nodeKind(task)!=='edit'||!mask||mask.kind!=='asset'||mask.role!=='mask'||mask.mime!=='image/png'||mask.deletionPending||(!retained&&mask.trashedAt))fail('MASK_INVALID','蒙版只能用于改图节点，且必须是本工作空间已上传的蒙版图片。');
   }
   if(task.tailFrame&&task.tailFrame.assetId) {
    const tf=task.tailFrame,before=previous.tasks?.find(t=>t.id===task.id)?.tailFrame;
    const retained=Boolean(before)&&before.assetId===tf.assetId;
    const asset=await this.store.get(workspace,tf.assetId,client);
    const run=(await client.query('SELECT * FROM sj_creation_runs WHERE workspace_id=$1 AND id=$2',[workspace,tf.runId])).rows[0];
    if(nodeKind(task)!=='video'||!asset||asset.kind!=='asset'||asset.deletionPending||(!retained&&asset.trashedAt)||!asset.mime?.startsWith('image/')||!run||run.status!=='succeeded'||run.task_id!==tf.fromNodeId)fail('TAIL_FRAME_INVALID','上一镜尾帧无效，请重新截取。');
   } else if(task.tailFrame&&nodeKind(task)!=='video')fail('TAIL_FRAME_INVALID','只有视频节点可以使用上一镜尾帧。');
   if(task.sourceAssetId&&task.sourceRunId)fail('SOURCE_AMBIGUOUS','请选择一张素材或一个具体生成版本。');
  }
 }
}
