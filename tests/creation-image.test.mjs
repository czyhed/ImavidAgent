import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../server/providers/creation-image.mjs';
import { MAX_REFERENCE_IMAGES } from '../server/creation-projects.mjs';

const png=Buffer.from([137,80,78,71,13,10,26,10]),png2=Buffer.from([137,80,78,71,13,10,26,10,1]),maskPng=Buffer.from([137,80,78,71,13,10,26,10,2]);
const dataUrl=bytes=>'data:image/png;base64,'+bytes.toString('base64');
const channel={baseUrl:'https://api.example.org/v1',apiKey:'test-not-real',adapter:'openai-compatible'};
const model=transport=>({modelId:'image-x',executorConfig:transport?{editTransport:transport}:{}});
// 假 transport：捕获请求并返回一张 base64 图片，不访问网络。
function capture(){
 const calls=[];
 const transport=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}),{status:200,headers:{'content-type':'application/json'}});};
 return {calls,transport};
}
const run=(transport,mode,extra)=>generateImage(transport,channel,{model:model(mode),prompt:'换背景',params:{size:'1024x1024'},requestKey:'req-1',...extra});

test('limit constant is 8',()=>{assert.equal(MAX_REFERENCE_IMAGES,8);});
test('no source uses generations',async()=>{const c=capture();await run(c.transport,null,{});assert.ok(c.calls[0].url.endsWith('/images/generations'));});
test('json-data-url: single image stays a string, no mask',async()=>{
 const c=capture();await run(c.transport,'json-data-url',{sourceImage:{bytes:png}});
 const body=JSON.parse(c.calls[0].options.body);assert.ok(c.calls[0].url.endsWith('/images/edits'));assert.equal(body.image,dataUrl(png));assert.equal(body.mask,undefined);
});
test('json-data-url: multiple images become an array with primary first',async()=>{
 const c=capture();await run(c.transport,'json-data-url',{sourceImage:{bytes:png},sourceImages:[{bytes:png},{bytes:png2}]});
 const body=JSON.parse(c.calls[0].options.body);assert.deepEqual(body.image,[dataUrl(png),dataUrl(png2)]);
});
test('json-data-url: mask is a data URL string',async()=>{
 const c=capture();await run(c.transport,'json-data-url',{sourceImage:{bytes:png},mask:{bytes:maskPng}});
 const body=JSON.parse(c.calls[0].options.body);assert.equal(body.image,dataUrl(png));assert.equal(body.mask,dataUrl(maskPng));
});
test('multipart: single image uses field "image"',async()=>{
 const c=capture();await run(c.transport,null,{sourceImage:{bytes:png}});
 const form=c.calls[0].options.body;assert.ok(form instanceof FormData);
 assert.equal(form.getAll('image').length,1);assert.equal(form.getAll('image[]').length,0);assert.equal(form.get('mask'),null);assert.equal(form.get('model'),'image-x');
});
test('multipart: multiple images use repeated "image[]" fields in order',async()=>{
 const c=capture();await run(c.transport,null,{sourceImage:{bytes:png},sourceImages:[{bytes:png},{bytes:png2}]});
 const form=c.calls[0].options.body,files=form.getAll('image[]');
 assert.equal(files.length,2);assert.equal(form.getAll('image').length,0);
 assert.deepEqual(Buffer.from(await files[0].arrayBuffer()),png);assert.deepEqual(Buffer.from(await files[1].arrayBuffer()),png2);
});
test('multipart: mask is sent as a file field',async()=>{
 const c=capture();await run(c.transport,null,{sourceImage:{bytes:png},mask:{bytes:maskPng}});
 const form=c.calls[0].options.body;assert.deepEqual(Buffer.from(await form.get('mask').arrayBuffer()),maskPng);assert.equal(form.getAll('image').length,1);
});
test('invalid mask bytes are rejected before any request',async()=>{
 const c=capture();await assert.rejects(run(c.transport,null,{sourceImage:{bytes:png},mask:{bytes:Buffer.from('not-an-image')}}),{code:'INVALID_MEDIA'});assert.equal(c.calls.length,0);
});
