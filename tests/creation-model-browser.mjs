import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import { startTestPostgres } from './support/postgres.mjs';
import { ChannelStore } from '../server/channels.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { ModelHub } from '../server/model-hub.mjs';
import { routes } from '../server/routes/model-hub.mjs';
const db=await startTestPostgres();const channels=new ChannelStore(db.pool,randomBytes(32));await channels.init();
const id='ch_0000000000000001';await channels.insert({id,name:'Browser Test',baseUrl:'https://mock.example.org/v1',apiKey:'browser-fake-key'});
let balanceMode='fail';
const hub=new ModelHub(new CreationStore(db.pool),channels,{transport:async url=>String(url).includes('point_usage_summary')?(balanceMode==='ok'?new Response(JSON.stringify({total_points:100.5,reserved_points:20,available_points:80.5})):new Response(JSON.stringify({error:{message:'offline'}}),{status:404})):new Response(JSON.stringify({data:[{id:'explicit-image'}]}))});await hub.sync(id);
let role='admin';const calls=[];
const server=await createServer({configFile:false,root:'web',plugins:[react(),{name:'model-test',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url==='/__models-test.html'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,`<html><body style="margin:20px;background:#f7f8fa;font:14px system-ui"><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import Models from '/src/components/CreationModels.jsx';createRoot(document.getElementById('root')).render(React.createElement(Models,{backend:{csrf:'test-csrf',session:{authenticated:true,user:{role:'${role}'}}},notify:()=>{}}));</script></body></html>`));return;}
 const pathname=req.url.split('?')[0],route=routes().find(r=>r.method===req.method&&r.pattern.test(pathname));if(!route)return next();
 try{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;calls.push(req.method+' '+req.url);await route.handler({ctx:{modelHub:hub,auth:{},user:{role,workspaceId:'test'}},req,res,url:new URL(req.url,'http://localhost'),body,match:route.pattern.exec(pathname),reply(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));}});}catch(error){res.statusCode=error.status||500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{code:error.code,message:error.message}}));}
 });}}],server:{host:'127.0.0.1',port:0}});
let browser;
try{await server.listen();const base=server.resolvedUrls.local[0];browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1360,height:950}});const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.log('Browser runtime:',error.message);});
 await page.goto(base+'__models-test.html');await expect(page.getByRole('heading',{name:'模型中心',exact:true})).toBeVisible();
 await expect(page.getByText('explicit-image',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'配置 explicit-image'}).click();await page.getByLabel('启用此模型').check();await page.getByLabel('生图',{exact:true}).check();await page.getByRole('button',{name:'保存模型'}).click();
 await expect(page.getByRole('button',{name:'保存模型'})).toHaveCount(0);
 await page.getByRole('button',{name:'环节默认',exact:true}).click();await page.getByLabel('生图默认模型').selectOption(id+'::explicit-image');await expect.poll(async()=> (await hub.catalog()).defaults.image?.modelId).toBe('explicit-image');
 await page.reload();await page.getByRole('button',{name:'环节默认',exact:true}).click();await expect(page.getByLabel('生图默认模型')).toHaveValue(id+'::explicit-image');
 await expect(page.getByRole('button',{name:'新增渠道',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'模型目录',exact:true}).click();await page.getByRole('button',{name:'配置 explicit-image'}).click();await page.getByLabel('显示名称').fill('Retained local name');
 await hub.configure(id,'explicit-image',{name:'Concurrent remote name'});await page.getByRole('button',{name:'保存模型'}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();await expect(page.getByLabel('显示名称')).toHaveValue('Retained local name');
 await page.getByRole('button',{name:'保存模型'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'新增渠道',exact:true}).click();await page.getByLabel('渠道名称').fill('Manual H3');await page.getByLabel('接口协议').selectOption('minimax-h3');await page.getByLabel('Base URL').fill('https://cp.compshare.cn');await page.getByLabel('API Key').fill('h3-fake-browser-key');await page.getByRole('button',{name:'保存渠道'}).click();await page.getByRole('button',{name:'渠道管理',exact:true}).click();await expect(page.locator('strong').filter({hasText:'Manual H3'})).toBeVisible();
 // H3 渠道详情：积分余额（失败显示原因，可刷新）与分辨率单价表（保存到 executorConfig.pointPrices）。
 const panel=page.getByLabel('视频渠道详情 Manual H3');await expect(panel).toBeVisible();
 await expect(panel).toContainText('积分余额不可用');
 balanceMode='ok';await page.getByRole('button',{name:'刷新积分 Manual H3'}).click();
 await expect(panel).toContainText('可用 80.5');await expect(panel).toContainText('预占 20');await expect(panel).toContainText('总积分 100.5');
 for(const [resolution,price] of [['480P','5'],['768P','10'],['1080P','19'],['2K','20'],['4K','22']])await expect(panel.getByLabel(resolution+' 单价')).toHaveValue(price);
 await panel.getByLabel('1080P 单价').fill('30');await panel.getByRole('button',{name:'保存单价'}).click();
 await expect.poll(async()=> (await hub.catalog()).channels.find(c=>c.name==='Manual H3')?.executorConfig?.pointPrices?.['1080P']).toBe(30);
 await expect(page.getByRole('button',{name:'保存单价'})).toBeDisabled();
 await panel.getByLabel('2K 单价').fill('-1');await expect(page.getByRole('button',{name:'保存单价'})).toBeEnabled();await page.getByRole('button',{name:'保存单价'}).click();await expect(panel.getByRole('alert')).toContainText('2K 单价');
 await page.reload();await page.getByRole('button',{name:'渠道管理',exact:true}).click();await expect(page.getByLabel('视频渠道详情 Manual H3').getByLabel('1080P 单价')).toHaveValue('30');
 // 火山引擎语音渠道：地址固定无 Base URL、资源 ID、密钥只显示末四位、自动成为语音默认、检查配置不合成。
 await page.getByRole('button',{name:'新增渠道',exact:true}).click();await page.getByLabel('渠道名称').fill('火山语音');await page.getByLabel('接口协议').selectOption('volcengine-tts');
 await expect(page.getByLabel('Base URL')).toHaveCount(0);await expect(page.getByLabel('资源 ID')).toHaveValue('seed-tts-2.0');
 await page.getByLabel('API Key').fill('volc-browser-fake-key-9876');await page.getByRole('button',{name:'保存渠道'}).click();await expect(page.getByRole('button',{name:'保存渠道'})).toHaveCount(0);
 const volc=(await hub.catalog()).channels.find(c=>c.adapter==='volcengine-tts');
 if(!volc||volc.keyHint!=='••••9876'||volc.baseUrl!=='https://openspeech.bytedance.com')throw new Error('volc channel not stored as expected');
 await expect(page.locator('body')).not.toContainText('volc-browser-fake-key');
 await expect(page.getByRole('button',{name:'同步目录'})).toHaveCount(2);
 await page.getByRole('button',{name:'检查配置 火山语音'}).click();
 await page.getByRole('button',{name:'环节默认',exact:true}).click();await expect(page.getByLabel('语音配音默认渠道')).toHaveValue(volc.id);
 await expect(page.getByLabel('语音配音默认渠道').locator('option')).toHaveCount(2);
 await page.getByRole('button',{name:'渠道管理',exact:true}).click();
 await page.getByRole('button',{name:'编辑渠道 火山语音'}).click();await page.getByLabel('资源 ID').selectOption('seed-icl-2.0');await page.getByRole('button',{name:'保存渠道'}).click();
 await expect.poll(async()=> (await hub.catalog()).channels.find(c=>c.id===volc.id)?.executorConfig?.resourceId).toBe('seed-icl-2.0');
 await page.getByRole('button',{name:'停用',exact:true}).last().click();await expect.poll(async()=> (await hub.catalog()).channels.find(c=>c.id===volc.id)?.enabled).toBe(false);
 await expect(page.locator('body')).not.toContainText('h3-fake-browser-key');
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 role='viewer';await page.reload();await expect(page.getByRole('heading',{name:'模型中心',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'新增渠道',exact:true})).toHaveCount(0);
 if(errors.length)throw new Error(errors.join('\n'));console.log('creation-model-browser passed: persisted model/default/channel + H3 points/prices + volc voice channel + viewer + mobile; no paid requests');
}finally{await browser?.close();await server.close();await db.stop();}
