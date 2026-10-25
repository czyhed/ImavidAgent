import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { deflateSync, crc32 } from 'node:zlib';
import { startCreationFixture } from './creation-products-support.mjs';

function png(){const chunk=(type,data)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);};const h=Buffer.alloc(13);h.writeUInt32BE(64,0);h.writeUInt32BE(64,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(64*(64*3+1)))),chunk('IEND',Buffer.alloc(0))]);}
const evidence=await mkdtemp(path.join(os.tmpdir(),'creation-products-qa-'));
await writeFile(path.join(evidence,'scenarios.md'),'商品首消息、刷新、手工资料、冲突采纳、资料图转素材、创作图上传、素材预览重命名下载、模板创建编辑删除、回收站恢复与管理员预览永久删除、查看者只读、桌面和375px布局、识别失败保留输入。数据库与S3/模型HTTP全为临时测试环境。\n');
let fixture,vite,server,browser;
const events=[];
try{
 fixture=await startCreationFixture();
 let entry;vite=await createViteServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'qa-entry',resolveId(id){if(id==='/qa-entry.jsx')return '/qa-entry.jsx';},load(id){if(id==='/qa-entry.jsx')return entry;}}],optimizeDeps:{include:['react','react-dom/client']},server:{middlewareMode:true},appType:'custom'});
 const html=`<!doctype html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>`;
 entry=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Products from '/web/src/components/CreationProducts.jsx';import Assets from '/web/src/components/CreationAssets.jsx';import Trash from '/web/src/components/CreationTrash.jsx';import '/web/src/styles/theme.css';globalThis.qa={selection:null,editing:false};const csrf=${JSON.stringify(fixture.csrf)};const backend={csrf,session:new URLSearchParams(location.search).has('viewer')?{authenticated:true,user:{role:'viewer'}}:null,apiCall:async(path,body,method)=>{const response=await fetch(path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'请求失败');return result;}};function App(){const[tab,setTab]=useState('商品');return <div style={{padding:24,maxWidth:1440,margin:'auto'}}><nav style={{display:'flex',gap:20,marginBottom:25}}>{['商品','素材','回收站'].map(t=><button key={t} onClick={()=>setTab(t)}>{t}</button>)}</nav>{tab==='商品'?<Products backend={backend} onSelectionChange={id=>globalThis.qa.selection=id} onWorkflowEditingChange={value=>globalThis.qa.editing=value}/>:tab==='素材'?<Assets backend={backend}/>:<Trash backend={backend}/>}</div>}createRoot(document.getElementById('root')).render(<App/>);`;
 server=http.createServer(async(req,res)=>{
  if(await fixture.handler(req,res))return;
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(req.url==='/'||req.url?.startsWith('/?')){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,html));return;}
  vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:1000}});
 page.on('pageerror',e=>events.push('PAGEERROR '+e.message));page.on('console',m=>{if(m.type()==='error')events.push('CONSOLE '+m.text());});
 await page.goto(base);await expect(page.getByLabel('商品聊天')).toBeVisible();
 await page.getByLabel('商品聊天').fill('茶杯是陶瓷，容量300ml');await expect.poll(()=>page.evaluate(()=>globalThis.qa.editing)).toBe(true);await page.getByRole('button',{name:'发送资料',exact:true}).click();await expect(page.getByRole('heading',{name:'茶杯',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>Boolean(globalThis.qa.selection))).toBe(true);await expect.poll(()=>page.evaluate(()=>globalThis.qa.editing)).toBe(false);
 await page.getByRole('button',{name:'商品资料',exact:true}).click();await page.getByRole('textbox',{name:'商品名称',exact:true}).fill('手工茶杯');await page.getByRole('button',{name:'保存资料',exact:true}).click();await expect(page.getByRole('heading',{name:'手工茶杯',exact:true})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:/手工茶杯/}).click();await expect(page.getByRole('heading',{name:'手工茶杯',exact:true})).toBeVisible();
 await page.locator('input[type=file]').first().setInputFiles({name:'资料.png',mimeType:'image/png',buffer:png()});await expect(page.getByRole('button',{name:'移除 资料.png'})).toBeVisible();await page.getByRole('button',{name:'发送资料',exact:true}).click();await expect(page.getByRole('button',{name:'加入商品素材'})).toBeVisible();await page.getByRole('button',{name:'加入商品素材'}).click();
 await page.getByRole('button',{name:/创作素材/}).click();await expect(page.getByRole('img',{name:'资料.png'})).toBeVisible();await page.screenshot({path:path.join(evidence,'products-desktop.png'),fullPage:true});
 const desktopColumns=await page.locator('.cp-workspace').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);if(desktopColumns!==2)throw new Error('Desktop product workspace must show list and detail side by side');
 await page.getByRole('button',{name:'素材',exact:true}).click();await expect(page.getByRole('button',{name:'预览 资料.png'})).toBeVisible();await page.getByRole('button',{name:'预览 资料.png'}).click();await page.getByRole('textbox',{name:'素材名称'}).fill('茶杯原图');await page.getByRole('button',{name:'保存名称'}).click();await expect(page.getByRole('heading',{name:'茶杯原图'})).toBeVisible();const previewWidth=await page.locator('.cp-preview-media').evaluate(el=>el.getBoundingClientRect().width);if(previewWidth>700)throw new Error('Asset preview must stay inside its modal');await page.getByRole('button',{name:'关闭预览'}).click();
 await page.getByRole('button',{name:'提示词与参数模板'}).click();await page.getByRole('button',{name:'新建模板',exact:true}).click();await page.getByLabel('模板名称').fill('六秒视频');await page.getByLabel('模板类型').selectOption('video');await page.getByLabel('提示词', {exact:true}).fill('缓慢环绕茶杯');await page.getByLabel('参数 JSON').fill('{"duration":6}');await page.getByRole('button',{name:'保存模板'}).click();await expect(page.getByRole('heading',{name:'六秒视频'})).toBeVisible();
 await page.screenshot({path:path.join(evidence,'templates-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'商品',exact:true}).click();await page.getByRole('button',{name:/手工茶杯/}).click();await page.getByRole('button',{name:'移入回收站',exact:true}).click();await expect.poll(()=>page.evaluate(()=>globalThis.qa.selection)).toBe(null);await page.getByRole('button',{name:'回收站',exact:true}).click();await expect(page.getByRole('cell',{name:'手工茶杯'})).toBeVisible();await page.getByRole('button',{name:'恢复',exact:true}).click();await expect(page.getByText('回收站为空')).toBeVisible();
 await page.getByRole('button',{name:'商品',exact:true}).click();await page.getByRole('button',{name:/手工茶杯/}).click();await page.getByRole('button',{name:'移入回收站',exact:true}).click();await expect.poll(()=>page.evaluate(()=>globalThis.qa.selection)).toBe(null);await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'预览永久删除'}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'确认永久删除'}).click();await expect(page.getByText('回收站为空')).toBeVisible();
 fixture.setProviderFailure(true);await page.getByRole('button',{name:'商品',exact:true}).click();await page.getByLabel('商品聊天').fill('保留失败输入');await page.getByRole('button',{name:'发送资料',exact:true}).click();await expect(page.getByRole('alert')).toContainText('识别未完成');await expect(page.getByLabel('商品聊天')).toHaveValue('保留失败输入');fixture.setProviderFailure(false);
 await page.setViewportSize({width:375,height:900});await page.screenshot({path:path.join(evidence,'products-mobile.png'),fullPage:true});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw new Error('Mobile content overflows viewport');
 await expect.poll(()=>page.evaluate(()=>globalThis.qa.editing)).toBe(true);await page.getByRole('button',{name:'素材',exact:true}).click();await expect.poll(()=>page.evaluate(()=>globalThis.qa.editing)).toBe(false);await page.goto(base+'/?viewer=1');await expect(page.getByRole('button',{name:'新商品',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'素材',exact:true}).click();await expect(page.locator('input[type=file]')).toHaveCount(0);await page.screenshot({path:path.join(evidence,'assets-mobile-viewer.png'),fullPage:true});
 if(events.length)throw new Error(events.join('\n'));
 await writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:true,base,events},null,2));console.log('Browser QA passed: '+evidence);
}catch(error){await writeFile(path.join(evidence,'failure.txt'),String(error.stack)+'\n'+events.join('\n'));throw error;}
finally{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await vite?.close();await fixture?.stop();}
