import { AppError } from '../errors.mjs';
import { requestJson, sourceData, usageRecord } from './creation-http.mjs';

export function normalizeMessages(messages, anthropic=false) {
  if(!Array.isArray(messages)||!messages.length||messages.length>200)throw new AppError('INVALID_MESSAGES','请提供有效的会话消息。',422);
  return messages.map(message=>{
    if(!['user','assistant'].includes(message.role))throw new AppError('INVALID_MESSAGES','会话角色无效。',422);
    if(typeof message.content==='string')return {role:message.role,content:message.content};
    if(!Array.isArray(message.content))throw new AppError('INVALID_MESSAGES','会话内容无效。',422);
    const content=message.content.map(part=>{
      if(part.type==='text'&&typeof part.text==='string')return {type:'text',text:part.text};
      if(part.type==='image'){const image=sourceData(part);return anthropic?{type:'image',source:{type:'base64',media_type:image.mime,data:image.bytes.toString('base64')}}:{type:'image_url',image_url:{url:image.dataUrl}};}
      // Never let browser URLs instruct the provider to fetch arbitrary resources.
      throw new AppError('INVALID_MESSAGES','图片消息需由服务端读取字节。',422);
    });
    return {role:message.role,content};
  });
}
export async function completeText(transport,channel,model,{messages,system}) {
  const anthropic=channel.adapter==='anthropic';
  const normalized=normalizeMessages(messages,anthropic);
  const body=anthropic?{model:model.modelId,max_tokens:4096,messages:normalized,...(system?{system}:{} )}:{model:model.modelId,messages:[...(system?[{role:'system',content:system}]:[]),...normalized],stream:false};
  const response=await requestJson(transport,channel,anthropic?'/messages':'/chat/completions',{method:'POST',body});
  const content=anthropic?response.content?.filter(p=>p.type==='text').map(p=>p.text).join(''):response.choices?.[0]?.message?.content;
  if(typeof content!=='string')throw new AppError('PROVIDER_RESPONSE_INVALID','Text model returned no valid content.',502);
  return {text:content,usage:usageRecord(response.usage)};
}
