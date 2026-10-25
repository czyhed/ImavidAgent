// 隔离 QA 夹具：临时 PostgreSQL + Vite 渲染真实画布组件，可导入一份真实项目结构。
// 不连接共享数据库，不调用付费模型；生成边界使用本地 fixture。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationProjects } from '../server/creation-projects.mjs';
import { routes as projectRoutes } from '../server/routes/creation-projects.mjs';
import { routes as voiceRoutes } from '../server/routes/creation-voice.mjs';
import { generationBoundary } from './creation-projects-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=', 'base64');

export async function startCanvasHarness({ projectBody, runs = [], image = PNG } = {}) {
 const db = await startTestPostgres();
 const store = new CreationStore(db.pool);
 const boundary = await generationBoundary(store);
 const projects = new CreationProjects(store, boundary), csrf = 'fixture-csrf-token';
 const product = await store.create('qa', 'product', { name: '男士洁面乳', facts: { 净含量: '120g' }, creativeAssetIds: [] });
 let projectId;
 if (projectBody) {
  // 去掉真实环境中的素材 / 运行引用，避免引用校验指向不存在的对象。
  const body = structuredClone(projectBody);
  body.productId = product.id;
  for (const task of body.tasks) { task.sourceAssetId = null; task.sourceRunId = null; }
  projectId = (await store.create('qa', 'project', body)).id;
  for (const run of runs) await db.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES(gen_random_uuid(),'qa',$1,$2,gen_random_uuid(),$3,$4,$5)", [projectId, run.taskId, run.input || {}, run.status || 'succeeded', run.output || null]);
 }
 const calls = [], uploads = [];
 const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
 const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  calls.push(`${req.method} ${url.pathname}`);
  try {
   let body;
   // 蒙版 / 素材上传：原始字节，不是 JSON；落入 fixture 存储并记录查询参数供断言。
   if (req.method === 'POST' && url.pathname === '/api/creation/assets/upload') {
    if (req.headers['x-csrf-token'] !== csrf) { reply(res, 403, { error: { message: 'CSRF rejected' } }); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks), query = Object.fromEntries(url.searchParams);
    uploads.push({ query, bytes });
    const asset = await boundary.media.put('qa', { bytes, mime: query.mime, name: query.name, role: query.role, projectId: query.projectId, taskId: query.taskId, baseAssetId: query.baseAssetId });
    reply(res, 201, { asset: { ...asset, data: undefined, fileUrl: `/api/creation/assets/${asset.id}/file` } }); return;
   }
   if (req.method === 'POST' || req.method === 'PATCH') {
    if (req.headers['x-csrf-token'] !== csrf) { reply(res, 403, { error: { message: 'CSRF rejected' } }); return; }
    const chunks = []; for await (const c of req) chunks.push(c); body = JSON.parse(Buffer.concat(chunks) || '{}');
   }
   const ctx = { creationProjects: projects, auth: {}, user: { id: 'qa-user', workspaceId: 'qa', role: 'operator' } };
   for (const route of [...projectRoutes(), ...voiceRoutes()]) { if (route.method !== req.method) continue; const match = route.pattern.exec(url.pathname); if (match) { await route.handler({ ctx, req, res, url, body, match, reply }); return; } }
   if (url.pathname === '/api/creation/products') { reply(res, 200, { items: [product] }); return; }
   if (url.pathname === '/api/creation/assets') { reply(res, 200, { items: (await store.list('qa', 'asset')).filter(a => a.role !== 'mask') }); return; }
   if (url.pathname === '/api/creation/templates') { reply(res, 200, { items: await store.list('qa', 'template') }); return; }
   if (url.pathname === '/api/model-hub') { reply(res, 200, { models: [{ channelId: 'fixture', modelId: 'image-v1', name: 'Fixture image', enabled: true, available: true, capabilities: ['image', 'video'] }] }); return; }
   if (/^\/api\/creation\/assets\/[\da-f-]+\/file$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); return; }
   reply(res, 404, { error: { message: 'Not found' } });
  } catch (e) { reply(res, e.status || 500, { error: { code: e.code, message: e.message } }); }
 });
 await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
 const entry = '/@creation-qa-entry.js';
 const entryPlugin = {
  name: 'creation-qa-entry',
  resolveId(id) { if (id === entry) return root.replaceAll('\\', '/') + 'creation-qa-entry.js'; },
  load(id) { if (id.endsWith('/creation-qa-entry.js')) return `import React from 'react';import {createRoot} from 'react-dom/client';import Canvas from '/web/src/components/CreationProjectCanvas.jsx';const q=new URLSearchParams(location.search),id=q.get('projectId'),view=q.get('view')||'canvas';createRoot(document.getElementById('root')).render(React.createElement(Canvas,{backend:{csrf:'${csrf}',session:{authenticated:true,user:{role:'operator'}}},notify:()=>{},projectId:id,view,onBack:()=>{}}));`; },
  configureServer(server) {
   server.middlewares.use(async (req, res, next) => {
    if (req.url === '/' || req.url?.startsWith('/?')) { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/', `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`)); return; }
    next();
   });
  },
 };
 const vite = await createViteServer({ configFile: false, root, logLevel: 'error', plugins: [(await import('@vitejs/plugin-react')).default(), entryPlugin], optimizeDeps: { include: ['react', 'react-dom/client', '@xyflow/react'] }, server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } }, appType: 'custom' });
 await vite.listen();
 return {
  origin: vite.resolvedUrls.local[0], projectId, projects, store, calls, uploads, boundary, pool: db.pool,
  async stop() { await vite.close(); await new Promise(resolve => api.close(resolve)); await boundary.stop(); await db.stop(); },
 };
}

// 通过 CDP 模拟中文输入法：先写入若干拼音组字状态，期间停顿超过自动保存间隔，再提交汉字。
export async function typeChinese(page, locator, segments, { pauseMs = 900 } = {}) {
 await locator.click();
 const cdp = await page.context().newCDPSession(page);
 for (const { pinyin, text } of segments) {
  let typed = '';
  for (const letter of pinyin) {
   typed += letter;
   await cdp.send('Input.imeSetComposition', { text: typed, selectionStart: typed.length, selectionEnd: typed.length });
   await page.waitForTimeout(60);
  }
  await page.waitForTimeout(pauseMs);
  await cdp.send('Input.insertText', { text });
  await page.waitForTimeout(80);
 }
 await cdp.detach();
}
