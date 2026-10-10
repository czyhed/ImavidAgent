import { AppError } from '../errors.mjs';
import { requestJson, usageRecord, MAX_IMAGE_BYTES, mediaMime, sourceData, downloadMedia } from './creation-http.mjs';
export async function generateImage(transport,channel,snapshot) {
  const allowed=['size','quality','background','output_format'];
  const params=Object.fromEntries(Object.entries(snapshot.params||{}).filter(([key])=>allowed.includes(key)));
  let body={...params,model:snapshot.model.modelId,prompt:snapshot.prompt,n:1};
  // 多张参考图用 sourceImages（主图在首位）；单张沿用 sourceImage。
  const inputs=snapshot.sourceImages?.length?snapshot.sourceImages:snapshot.sourceImage?[snapshot.sourceImage]:[];
  const path=inputs.length?'/images/edits':'/images/generations';
  if(inputs.length){
    const sources=inputs.map(input=>sourceData(input)),mask=snapshot.mask?sourceData(snapshot.mask):null;
    const json=snapshot.model.executorConfig?.editTransport==='json-data-url';
    if(json){
      body={...body,image:sources.length===1?sources[0].dataUrl:sources.map(source=>source.dataUrl),...(mask?{mask:mask.dataUrl}:{})};
    }else{
      const form=new FormData();
      for(const [key,value] of Object.entries(body))form.set(key,String(value));
      sources.forEach((source,index)=>form.append(sources.length===1?'image':'image[]',new Blob([source.bytes],{type:source.mime}),`source${sources.length===1?'':'-'+(index+1)}.${source.mime.split('/')[1]}`));
      if(mask)form.set('mask',new Blob([mask.bytes],{type:mask.mime}),'mask.png');
      body=form;
    }
  }
  const response=await requestJson(transport,channel,path,{method:'POST',headers:{'Idempotency-Key':snapshot.requestKey},body});
  if(response.data?.[0]?.url) return {status:'succeeded',...await downloadMedia(transport,response.data[0].url,'image'),usage:usageRecord(response.usage)};
  const base64=response.data?.[0]?.b64_json;
  if(typeof base64!=='string')throw new AppError('PROVIDER_RESPONSE_INVALID','供应商未返回有效图片。',502);
  if(base64.length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw new AppError('PROVIDER_RESULT_TOO_LARGE','供应商图片超过体积限制。',502);
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length>MAX_IMAGE_BYTES)throw new AppError('PROVIDER_RESULT_TOO_LARGE','供应商图片超过体积限制。',502);
  return {status:'succeeded',bytes,mime:mediaMime(bytes),usage:usageRecord(response.usage)};
}
