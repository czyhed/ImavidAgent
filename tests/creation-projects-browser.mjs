import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';
import { routes } from '../server/routes/creation-projects.mjs';
import { routes as assetRoutes } from '../server/routes/creation-assets.mjs';
import { routes as productRoutes } from '../server/routes/creation-products.mjs';
import { CreationLifecycle } from '../server/creation-lifecycle.mjs';
import { CreationProducts } from '../server/creation-products.mjs';
import { generationBoundary } from './creation-projects-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=await mkdtemp(join(tmpdir(),'sj-creation-canvas-qa-'));
const failures=[],observations=[];let skillsMissing=0;
let db,boundary,api,vite,browser,ticker,pageRef;
try {
 db=await startTestPostgres();const store=new CreationStore(db.pool);boundary=await generationBoundary(store);
 const projects=new CreationProjects(store,boundary),csrf='fixture-csrf-token';
 const product=await store.create('qa','product',{name:'青瓷杯',facts:{material:'陶瓷'},creativeAssetIds:[]});
 await store.create('qa','template',{name:'森林背景模板',mediaKind:'image',prompt:'青绿色森林中柔和阳光',params:{size:'1024x1024'}});
 const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 api=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try {
   let body;if(req.method==='POST'||req.method==='PATCH'){
    if(req.headers['x-csrf-token']!==csrf){reply(res,403,{error:{message:'CSRF rejected'}});return;}
    const chunks=[];for await(const c of req)chunks.push(c);body=JSON.parse(Buffer.concat(chunks));
   }
   const role=url.searchParams.get('role')||req.headers['x-test-role']||'operator';
   const ctx={creationProjects:projects,creationProducts:new CreationProducts(store,boundary),creationLifecycle:new CreationLifecycle(store,boundary),auth:{},user:{id:'qa-user',workspaceId:'qa',role}};
   // 列表接口走真实路由（limit / offset / q / ids 在 SQL 里完成）。
   const listPaths=new Set(['/api/creation/assets','/api/creation/templates','/api/creation/products']);
   for(const route of [...routes(),...(req.method==='GET'&&listPaths.has(url.pathname)?[...assetRoutes(),...productRoutes()]:[])]){if(route.method!==req.method)continue;const match=route.pattern.exec(url.pathname);if(match){await route.handler({ctx,req,res,url,body,match,reply});return;}}
   if(url.pathname==='/api/model-hub'){reply(res,200,{models:[{channelId:'fixture',modelId:'image-v1',name:'Fixture image',enabled:true,available:true,capabilities:['image','video']}]});return;}
   const media=url.pathname.match(/^\/api\/creation\/assets\/([\da-f-]+)\/file$/);
   if(media){const file=await boundary.media.read('qa',media[1]);res.writeHead(200,{'Content-Type':'image/png'});res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=','base64'));return;}
   reply(res,404,{error:{message:'Not found'}});
  }catch(e){reply(res,e.status||500,{error:{code:e.code,message:e.message}});}
 });await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 ticker=setInterval(()=>projects.tick().catch(()=>{}),100);
 const entry='/@creation-qa-entry.js';
 const entryPlugin={name:'creation-qa-entry',
  resolveId(id){if(id===entry)return root.replaceAll('\\','/')+'creation-qa-entry.js';},
  load(id){if(id.endsWith('/creation-qa-entry.js'))return `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Projects from '/web/src/components/CreationProjects.jsx';const role=new URLSearchParams(location.search).get('role')||'operator';function Shell(){const [view,setView]=useState('canvas');return React.createElement(Projects,{backend:{csrf:'${csrf}',session:{authenticated:true,user:{role}}},notify:()=>{},routeView:view,onOpenProject:(id,extra)=>{if(extra&&extra.view)setView(extra.view);}});}createRoot(document.getElementById('root')).render(React.createElement(Shell));`;},
  configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if(req.url==='/'||req.url?.startsWith('/?')){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/',`<!doctype html><html lang="zh"><head><meta charset="UTF-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#fafcfa"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));return;}next();
  });}
 };
 vite=await createViteServer({configFile:false,root,plugins:[(await import('@vitejs/plugin-react')).default(),entryPlugin],optimizeDeps:{include:['react','react-dom/client','@xyflow/react']},server:{host:'127.0.0.1',port:0,proxy:{'/api':`http://127.0.0.1:${api.address().port}`}},appType:'custom'});
 await vite.listen();const origin=vite.resolvedUrls.local[0];
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1000}});pageRef=page;
 page.on('response',r=>{if(r.status()===404&&r.url().includes('/api/model-hub/video/skills'))skillsMissing+=1;});page.on('pageerror',e=>failures.push(e.message));page.on('console',m=>{if(m.type()==='error')failures.push(m.text());});
 await page.goto(origin);await expect(page.getByRole('heading',{name:'项目',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'新建项目',exact:true}).first().click();await page.getByLabel('项目名称',{exact:true}).fill('画布验收项目');await page.getByLabel('商品',{exact:true}).selectOption(product.id);await page.getByRole('button',{name:'创建项目',exact:true}).click();
 await expect(page.locator('.v3-node')).toHaveCount(4);observations.push('PASS create opens v3 canvas with product and prompt inputs');
 const project=(await projects.list('qa')).projects[0],node=page.locator('.v3-node.kind-generate').first();await node.click();
 await node.getByText('高级参数与模板',{exact:true}).click();await node.getByRole('combobox',{name:'创作对象'}).selectOption('concept');await node.getByRole('textbox',{name:'提示词',exact:true}).fill('青绿色森林背景');const saved=page.locator('.v3-saved',{hasText:'已保存'});await page.getByRole('combobox',{name:'创作对象'}).first().focus();await expect(saved).toBeVisible();
 await expect(saved).toBeVisible();
 // 增量保存走 POST /ops。4xx（校验类）：显示原因，丢弃该批改动，不弹冲突、编辑不锁定。
 const opsApi='**/api/creation/projects/'+project.id+'/ops';
 let opsRequests=0;
 await page.route(opsApi,route=>{opsRequests+=1;route.fulfill({status:413,contentType:'application/json',body:JSON.stringify({error:{code:'TOO_LARGE',message:'请求体过大。'}})});});
 await node.getByRole('textbox',{name:'提示词',exact:true}).fill('会被服务端拒绝的提示词');
 await page.getByRole('combobox',{name:'创作对象'}).first().focus();
 await expect(page.getByRole('alert').filter({hasText:'请求体过大。'})).toBeVisible();
 await expect(saved).toBeVisible({timeout:15000});
 if(opsRequests!==1)throw new Error('A rejected 4xx batch must not be retried, saw '+opsRequests);
 if((await projects.detail('qa',project.id)).project.tasks.find(t=>t.kind==='generate').prompt!=='青绿色森林背景')throw new Error('Rejected batch reached the server');
 await page.getByRole('button',{name:'关闭',exact:true}).first().click();
 await page.unroute(opsApi);
 // 网络 / 5xx：保留本地改动，自动重试 3 次（约 1/3/9 秒）后显示「保存失败 · 重试」，点重试成功保存。
 let outage=true;opsRequests=0;
 await page.route(opsApi,route=>{if(outage){opsRequests+=1;route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'服务暂时不可用。'}})});}else route.continue();});
 await node.getByRole('textbox',{name:'提示词',exact:true}).fill('保存失败也要保留这段提示词');
 await page.getByRole('combobox',{name:'创作对象'}).first().focus();
 await expect(page.locator('.v3-saved.failed')).toHaveText('保存失败',{timeout:25000});
 if(opsRequests!==4)throw new Error('Expected 1 attempt + 3 retries, saw '+opsRequests);
 await expect(node.getByRole('textbox',{name:'提示词',exact:true})).toHaveValue('保存失败也要保留这段提示词');
 outage=false;
 await page.locator('.v3-crumb').getByRole('button',{name:'重试',exact:true}).click();
 await expect(saved).toBeVisible();
 await page.unroute(opsApi);
 if((await projects.detail('qa',project.id)).project.tasks.find(t=>t.kind==='generate').prompt!=='保存失败也要保留这段提示词')throw new Error('Save retry lost the pending draft');
 // 被故意拒绝的 413 与重试期间的 503 会在控制台留下资源加载错误，属预期。
 for(let index=failures.length-1;index>=0;index-=1)if(/status of (413|503)/.test(failures[index]))failures.splice(index,1);
 observations.push('PASS 4xx rejects the batch with a reason; network/5xx keep edits, retry 3 times, then retry button saves');
 // 平移 / 缩放只存本机浏览器，不产生任何保存请求，也不写入服务器。
 const revisionBeforePan=(await projects.detail('qa',project.id)).project.revision;
 let panWrites=0;page.on('request',r=>{if(['POST','PATCH'].includes(r.method())&&r.url().includes('/api/creation/projects/'))panWrites+=1;});
 const pane=await page.locator('.react-flow__pane').boundingBox();
 await page.mouse.move(pane.x+pane.width-260,pane.y+pane.height-40);await page.mouse.down();await page.mouse.move(pane.x+pane.width-330,pane.y+pane.height-90,{steps:8});await page.mouse.up();await page.waitForTimeout(1500);
 if(panWrites!==0)throw new Error('Pan/zoom must not send project writes, saw '+panWrites);
 if((await projects.detail('qa',project.id)).project.revision!==revisionBeforePan)throw new Error('Pan/zoom changed the project revision');
 if(!(await page.evaluate(id=>Object.keys(localStorage).some(k=>k.startsWith('sj:canvas-view:'+id)),project.id)))throw new Error('Canvas view was not stored locally');
 observations.push('PASS pan and zoom are stored locally only');
 const before=(await projects.detail('qa',project.id)).project.tasks.find(t=>t.kind==='generate').position;
 // xyflow 偶发在重渲染窗口把按下交给画布平移：确认起点命中节点本体后再拖，未命中则稍候重试。
 let grabbed=false;
 for(let attempt=0;attempt<10&&!grabbed;attempt+=1){
  const box=await node.boundingBox();
  grabbed=await page.evaluate(([x,y])=>Boolean(document.elementFromPoint(x,y)?.closest('.react-flow__node')),[Math.round(box.x+100),Math.round(box.y+18)]);
  if(!grabbed){await page.waitForTimeout(250);continue;}
  await page.mouse.move(box.x+100,box.y+18);await page.mouse.down();
  await page.mouse.move(box.x+300,box.y+138,{steps:20});await page.mouse.up();
 }
 if(!grabbed)throw new Error('Node drag never grabbed the node');await page.waitForTimeout(1600);
 const moved=(await projects.detail('qa',project.id)).project.tasks.find(t=>t.kind==='generate').position;if(moved.x===before.x&&moved.y===before.y)throw new Error('Node drag did not persist');observations.push('PASS dragging persists node position');
 await page.getByRole('button',{name:'预览运行',exact:true}).click();await expect(page.getByRole('dialog',{name:'执行范围预览'})).toBeVisible();
 if(boundary.requests.some(r=>r.url==='/generate'))throw new Error('Preview generated a paid task');
 await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.locator('.v3-queue td.status span.succeeded').first()).toHaveText('成功',{timeout:15000});observations.push('PASS explicit preview then start succeeds');
 await page.getByRole('button',{name:'再生成一版',exact:true}).click();await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.locator('.v3-queue td.status span.succeeded')).toHaveCount(2,{timeout:15000});observations.push('PASS regenerate creates a second succeeded version');
 await page.getByRole('button',{name:'AI 安排',exact:true}).click();await page.locator('.v3-dialog textarea').fill('增加森林背景');await page.getByRole('button',{name:'生成安排',exact:true}).click();await expect(page.getByText('待确认的 AI 安排')).toBeVisible();await expect(page.locator('.creative-task-item')).toHaveCount(1);await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect(page.locator('.creative-task-item')).toHaveCount(2);observations.push('PASS AI proposal adds an independent creative task only after confirmation');
 await page.locator('.creative-task-item').filter({hasText:'推荐背景'}).click();await expect(page.locator('.v3-node')).toHaveCount(4);await expect(page.locator('.v3-queue tbody tr[data-run]')).toHaveCount(0);
 await page.locator('.v3-node.kind-prompt').getByLabel('提示词',{exact:true}).fill('独立任务的提示词');await page.waitForTimeout(1200);
 await page.getByLabel('创作任务名称',{exact:true}).fill('独立背景任务');await page.waitForTimeout(1200);
 await page.locator('.creative-task-item').first().click();await expect(page.locator('.v3-queue tbody tr[data-run]')).toHaveCount(2);
 await page.locator('.creative-task-item').filter({hasText:'独立背景任务'}).click();await expect(page.locator('.v3-node.kind-prompt').getByLabel('提示词',{exact:true})).toHaveValue('独立任务的提示词');observations.push('PASS workflow selection isolates the canvas, prompt edits and run history');
 await page.getByRole('button',{name:'＋ 添加节点',exact:true}).click();await page.locator('.v3-palette-list').getByRole('button',{name:'改图',exact:true}).click();await expect(page.locator('.v3-node.kind-edit')).toHaveCount(1);
 await page.getByRole('button',{name:'适应视图',exact:true}).click();await page.waitForTimeout(500);
 const original=page.locator('.v3-node.kind-generate'),child=page.locator('.v3-node.kind-edit');
 const edgeCount=(await projects.detail('qa',project.id)).project.edges.length;
 await original.locator('.react-flow__handle.source').first().dragTo(child.locator('.react-flow__handle.target[data-handleid="image"]'));
 await page.waitForTimeout(1600);if((await projects.detail('qa',project.id)).project.edges.length!==edgeCount+1)throw new Error('Typed edge did not persist');observations.push('PASS typed handles connect and autosave within the task');
 await page.getByRole('button',{name:'预览并运行当前任务',exact:true}).click();await expect(page.getByRole('dialog',{name:'执行范围预览'})).toBeVisible();await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.locator('.v3-queue td.status span.succeeded')).toHaveCount(1,{timeout:15000});
 const afterParent=await projects.detail('qa',project.id),workflow=afterParent.project.workflows.find(w=>w.title==='独立背景任务');
 const parentTask=afterParent.project.tasks.find(t=>t.workflowId===workflow.id&&t.kind==='generate'),parentRun=afterParent.runs.find(r=>r.taskId===parentTask.id);
 await child.getByLabel('提示词',{exact:true}).fill('保持杯身细节');await child.getByLabel('来源版本',{exact:true}).selectOption(parentRun.id);await page.waitForTimeout(1200);
 await child.getByRole('button',{name:'预览运行',exact:true}).click();await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.locator('.v3-queue td.status span.succeeded')).toHaveCount(2,{timeout:15000});
 observations.push('PASS task execution preserves the preview scope, waits for a pinned upstream version, then runs downstream');
 await page.getByRole('button',{name:'＋ 新增任务',exact:true}).click();await page.getByRole('dialog').getByLabel('任务名称').fill('手动新任务');await page.getByRole('button',{name:'创建任务',exact:true}).click();await expect(page.locator('.creative-task-item')).toHaveCount(3);await expect(page.locator('.v3-node')).toHaveCount(4);await page.waitForTimeout(1000);
 await page.getByLabel('项目名称',{exact:true}).fill('重命名画布');await page.waitForTimeout(1200);if((await projects.detail('qa',project.id)).project.name!=='重命名画布')throw new Error('Project rename did not persist');
 observations.push('PASS manually created workflow and project name persist');
 // 视频工作台冒烟：脚本 → 添加分镜 → 保存 → 画布出现「视频分镜」节点。
 await page.getByRole('button',{name:'视频工作台',exact:true}).click();
 await page.getByLabel('视频脚本').fill('【开场】展示青瓷杯【特写】釉色细节');
 await page.getByRole('button',{name:'＋ 添加分镜',exact:true}).click();
 await page.getByRole('textbox',{name:'视频提示词'}).fill('缓慢推进青瓷杯特写，柔和自然光');
 // 没有「保存分镜」按钮：分镜与画布共用保存队列，等状态变为已保存再切到画布。
 if(await page.getByRole('button',{name:'保存分镜',exact:true}).count())throw new Error('The 保存分镜 button must be gone');
 await expect(saved).toBeVisible({timeout:15000});
 await page.getByRole('button',{name:'画布',exact:true}).click();
 await page.locator('.creative-task-item').filter({hasText:'视频分镜'}).click();await expect(page.locator('.v3-node.kind-video')).toHaveCount(1);
 await expect(page.locator('.v3-node.kind-video .v3-dim-tag')).toHaveText('视频分镜');
 observations.push('PASS video studio auto-saves shots and syncs them as dimensioned canvas nodes');
 const videoNode=page.locator('.v3-node.kind-video');
 await videoNode.getByText('高级参数与模板',{exact:true}).click();
 await videoNode.getByLabel('高级参数',{exact:true}).fill(JSON.stringify({duration:15,resolution:'1080x1920',aspectRatio:'9:16'}));
 await videoNode.getByLabel('时长（秒）',{exact:true}).click();
 await expect(videoNode.getByLabel('分辨率',{exact:true})).toHaveValue('1080P');
 await expect(videoNode.getByLabel('画面比例',{exact:true})).toHaveValue('9:16');
 await videoNode.getByLabel('高级参数',{exact:true}).fill(JSON.stringify({duration:0,resolution:'720P',ratio:'2:7'}));
 await videoNode.getByLabel('时长（秒）',{exact:true}).click();
 await expect(videoNode.getByLabel('时长（秒）',{exact:true})).toHaveValue('0');
 await expect(videoNode.getByLabel('分辨率',{exact:true})).toHaveValue('invalid');
 await expect(videoNode.getByLabel('分辨率',{exact:true}).locator('option:checked')).toHaveText('720P（无效，请选择）');
 await expect(videoNode.getByLabel('画面比例',{exact:true}).locator('option:checked')).toHaveText('2:7（无效，请选择）');
 for(const duration of ['15s',null]){
  await videoNode.getByLabel('高级参数',{exact:true}).fill(JSON.stringify({duration,resolution:'720P',ratio:'2:7'}));
  await videoNode.getByLabel('时长（秒）',{exact:true}).click();
  await expect(videoNode.getByRole('alert')).toContainText(JSON.stringify(duration));
  await expect(videoNode.getByLabel('时长（秒）',{exact:true})).toHaveAttribute('aria-invalid','true');
 }
 await videoNode.getByLabel('高级参数',{exact:true}).fill(JSON.stringify({duration:15,resolution:'',ratio:''}));
 await videoNode.getByLabel('时长（秒）',{exact:true}).click();
 await expect(videoNode.getByLabel('分辨率',{exact:true}).locator('option:checked')).toContainText('无效，请选择');
 await expect(videoNode.getByLabel('画面比例',{exact:true}).locator('option:checked')).toContainText('无效，请选择');
 await page.waitForTimeout(1200);
 await page.reload();
 await page.getByRole('button',{name:'打开画布',exact:true}).click();
 await page.locator('.creative-task-item').filter({hasText:'视频分镜'}).click();
 await expect(videoNode.getByLabel('分辨率',{exact:true}).locator('option:checked')).toContainText('无效，请选择');
 await expect(videoNode.getByLabel('画面比例',{exact:true}).locator('option:checked')).toContainText('无效，请选择');
 await videoNode.getByLabel('时长（秒）',{exact:true}).fill('15');
 await videoNode.getByLabel('分辨率',{exact:true}).selectOption('1080P');
 await videoNode.getByLabel('画面比例',{exact:true}).selectOption('9:16');
 await page.waitForTimeout(1200);
 const savedVideo=(await projects.detail('qa',project.id)).project.tasks.find(t=>t.kind==='video');
 if(savedVideo.params.resolution!=='1080P'||savedVideo.params.ratio!=='9:16'||savedVideo.params.duration!==15)throw new Error('Video parameter correction did not persist');
 observations.push('PASS video aliases show canonical settings, invalid values remain explicit, and manual correction persists');
 await page.screenshot({path:join(evidence,'desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'返回项目',exact:true}).click();await page.reload();await page.getByRole('button',{name:'打开画布',exact:true}).click();await page.locator('.creative-task-item').filter({hasText:'独立背景任务'}).click();await expect(page.locator('.v3-node.kind-prompt').getByLabel('提示词',{exact:true})).toHaveValue('独立任务的提示词');if((await projects.detail('qa',project.id)).project.edges.length!==edgeCount+3)throw new Error('Reload lost edges');observations.push('PASS reload preserves graph and edges');
 await page.setViewportSize({width:375,height:812});await page.screenshot({path:join(evidence,'mobile.png'),fullPage:true});if(await page.locator('body').evaluate(el=>el.scrollWidth>375))throw new Error('Mobile page horizontal overflow');observations.push('PASS 375px layout has no horizontal overflow');
 const viewer=await browser.newPage({viewport:{width:1280,height:900}});await viewer.goto(origin+'?role=viewer');await expect(viewer.getByRole('button',{name:'新建项目',exact:true}).first()).toBeDisabled();await viewer.getByRole('button',{name:'打开画布',exact:true}).click();await expect(viewer.getByRole('button',{name:'AI 安排',exact:true})).toBeDisabled();observations.push('PASS viewer cannot create or arrange');
 await writeFile(join(evidence,'observations.txt'),observations.join('\n'));
 // 本测试的假接口没有 Skill 列表：打开视频节点高级设置时的 404 是预期的失败路径（界面只在下拉中显示原因）。
 for(let i=0;i<skillsMissing;i+=1){const index=failures.findIndex(message=>message.includes('404'));if(index!==-1)failures.splice(index,1);}
 if(failures.length)throw new Error('Browser console errors: '+failures.join('\n'));
 await writeFile(join(evidence,'report.txt'),observations.join('\n')+'\n');console.log('QA evidence: '+evidence+'\n'+observations.join('\n'));
}catch(e){await writeFile(join(evidence,'failure.txt'),String(e.stack));if(pageRef){try{await pageRef.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure-body.txt'),await pageRef.locator('body').innerText()+String.fromCharCode(10)+'OVERLAYS: '+await pageRef.locator('.v3-overlay').count()+String.fromCharCode(10)+await pageRef.locator('.v3-overlay').evaluateAll(els=>els.map(e=>e.outerHTML.slice(0,300)).join(String.fromCharCode(10)))+String.fromCharCode(10)+'NODES: '+await pageRef.locator('.react-flow__node').count())}catch{}}console.error('QA evidence: '+evidence);throw e;}
finally {clearInterval(ticker);await browser?.close();await vite?.close();if(api)await new Promise(resolve=>api.close(resolve));await boundary?.stop();await db?.stop();}
