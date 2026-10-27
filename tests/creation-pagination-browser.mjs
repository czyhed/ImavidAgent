// 分页浏览器验收：项目翻页 / 搜索、商品「加载更多」、素材与模板翻页、回收站翻页、工作台用量翻页、
// 新建项目对话框的分页下拉、画布素材选择器的搜索 + 加载更多、375px 无横向溢出。
// 使用隔离测试库与本地生成边界，不调用真实付费接口。
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startCreationApp } from './creation-app-fixture.mjs';

const app = await startCreationApp({ autoTick: false });
let browser;
const failures = [];
const check = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { failures.push(name + ': ' + e.message); console.log('FAIL ' + name + ': ' + e.message); } };
const pad = n => String(n).padStart(2, '0');
const W = 'local';
try {
  // ---- 种子数据（直接写库，速度快）：每类都超过一页 ----
  const proj = [];
  for (let i = 1; i <= 45; i++) proj.push(await app.store.create(W, 'project', { name: `分页项目${pad(i)}`, tasks: [], edges: [], graphVersion: 4 }));
  for (let i = 1; i <= 65; i++) await app.store.create(W, 'product', { name: `分页商品${pad(i)}`, facts: { 价格: String(i) }, creativeAssetIds: [] });
  for (let i = 1; i <= 55; i++) await app.store.create(W, 'asset', { name: `分页素材${pad(i)}.png`, mime: 'image/png', role: 'creative', bytes: 10, objectKey: randomUUID() });
  for (let i = 1; i <= 25; i++) await app.store.create(W, 'template', { name: `分页模板${pad(i)}`, mediaKind: i % 2 ? 'image' : 'video', prompt: '提示词', params: {} });
  const trashed = [];
  for (let i = 1; i <= 25; i++) {
    const p = await app.store.create(W, 'product', { name: `回收分页${pad(i)}`, facts: {}, creativeAssetIds: [] });
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    await app.db.pool.query("UPDATE sj_creation_records SET trashed_at=$2::timestamptz, body=body||jsonb_build_object('trashedAt',$3::text) WHERE id=$1", [p.id, at, at]);
    trashed.push(p);
  }
  for (let i = 0; i < 45; i++) await app.db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail,created_at) VALUES(gen_random_uuid(),$1,'model.complete',$2,$3)`, [W, { stage: 'product', modelId: `m-${pad(i)}`, usage: { costMicros: 1000 + i, currency: 'CNY' } }, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()]);

  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const pager = label => page.getByRole('navigation', { name: label });
  const status = label => pager(label).locator('[data-pager-status]');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const listCalls = [];
  page.on('request', r => { if (/\/api\/creation\/(projects|products|assets|templates|trash|usage)\?/.test(r.url())) listCalls.push(r.url()); });

  await check('projects: page size 20, pager moves to page 2 and 3, previous returns', async () => {
    await page.goto(app.origin + '/?screen=projects');
    await expect(page.locator('.cp-project-row')).toHaveCount(20);
    await expect(page.getByText('45 个创作项目')).toBeVisible();
    await expect(status('项目分页')).toHaveText('第 1 页 · 共 3 页');
    await expect(pager('项目分页').getByRole('button', { name: '上一页' })).toBeDisabled();
    await pager('项目分页').getByRole('button', { name: '下一页' }).click();
    await expect(status('项目分页')).toHaveText('第 2 页 · 共 3 页');
    await expect(page.locator('.cp-project-row')).toHaveCount(20);
    await pager('项目分页').getByRole('button', { name: '下一页' }).click();
    await expect(status('项目分页')).toHaveText('第 3 页 · 共 3 页');
    await expect(page.locator('.cp-project-row')).toHaveCount(5);
    await expect(pager('项目分页').getByRole('button', { name: '下一页' })).toBeDisabled();
    await pager('项目分页').getByRole('button', { name: '上一页' }).click();
    await expect(status('项目分页')).toHaveText('第 2 页 · 共 3 页');
    if (!listCalls.some(u => u.includes('/projects?') && u.includes('limit=20') && u.includes('offset=20'))) throw new Error('page 2 was not requested with limit=20&offset=20');
  });

  await check('projects: debounced server search resets to page 1 and shows the match count', async () => {
    const before = listCalls.filter(u => u.includes('/projects?')).length;
    await page.getByLabel('搜索项目').fill('分页项目07');
    await expect(page.locator('.cp-project-row')).toHaveCount(1);
    await expect(page.getByText('1 个匹配项目')).toBeVisible();
    await expect(pager('项目分页')).toHaveCount(0);
    if (!listCalls.some(u => u.includes('q=%E5%88%86%E9%A1%B5%E9%A1%B9%E7%9B%AE07') && u.includes('offset=0'))) throw new Error('search did not go to the server from offset 0');
    await page.getByLabel('搜索项目').fill('');
    await expect(page.locator('.cp-project-row')).toHaveCount(20);
    if (listCalls.filter(u => u.includes('/projects?')).length - before > 4) throw new Error('search should be debounced, saw too many requests');
  });

  await check('products: sidebar loads 30 at a time with 加载更多 and server search', async () => {
    await page.goto(app.origin + '/?screen=products');
    const items = page.locator('.cp-product-list > button');
    await expect(items).toHaveCount(30);
    await expect(page.getByText('已显示 30 / 65')).toBeVisible();
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(items).toHaveCount(60);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(items).toHaveCount(65);
    await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
    await page.getByLabel('搜索商品').fill('分页商品64');
    await expect(items).toHaveCount(1);
    await expect(page.locator('.cp-heading').first()).toContainText('1 件匹配商品');
  });

  await check('assets: page size 24, pager reaches page 3, search keeps the filter and resets the page', async () => {
    await page.goto(app.origin + '/?screen=assets');
    await expect(page.locator('.cp-asset')).toHaveCount(24);
    await expect(status('素材分页')).toHaveText('第 1 页 · 共 3 页');
    await pager('素材分页').getByRole('button', { name: '下一页' }).click();
    await expect(status('素材分页')).toHaveText('第 2 页 · 共 3 页');
    await pager('素材分页').getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.cp-asset')).toHaveCount(7);
    await page.getByLabel('搜索素材').fill('分页素材5');
    await expect(page.locator('.cp-asset')).toHaveCount(6);
    await expect(pager('素材分页')).toHaveCount(0);
    await page.getByLabel('搜索素材').fill('');
    await page.getByLabel('媒体类型').selectOption('video');
    await expect(page.getByText('暂无素材')).toBeVisible();
  });

  await check('templates tab pages too (24 per page) and filters by type on the server', async () => {
    await page.goto(app.origin + '/?screen=assets');
    await page.getByRole('button', { name: '提示词与参数模板', exact: true }).click();
    await expect(page.locator('.cp-template-list article')).toHaveCount(24);
    await expect(status('模板分页')).toHaveText('第 1 页 · 共 2 页');
    await pager('模板分页').getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.cp-template-list article').first()).toBeVisible();
    await page.getByLabel('媒体类型').selectOption('video');
    await expect(page.locator('.cp-template-list article .cp-type').first()).toHaveText('视频模板');
    const kinds = await page.locator('.cp-template-list article .cp-type').allTextContents();
    if (kinds.some(k => k !== '视频模板')) throw new Error('video filter leaked other kinds: ' + [...new Set(kinds)]);
  });

  await check('trash: page size 20, newest trashed first, pager moves to page 2', async () => {
    await page.goto(app.origin + '/?screen=trash');
    await expect(page.locator('.cp-data-table tbody tr')).toHaveCount(20);
    await expect(page.locator('.cp-data-table tbody tr').first()).toContainText('回收分页25');
    await expect(status('回收站分页')).toHaveText('第 1 页 · 共 2 页');
    await pager('回收站分页').getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.cp-data-table tbody tr')).toHaveCount(5);
    await expect(page.locator('.cp-data-table tbody tr').first()).toContainText('回收分页05');
    await page.getByLabel('搜索回收站').fill('回收分页10');
    await expect(page.locator('.cp-data-table tbody tr')).toHaveCount(1);
  });

  await check('workspace usage table: 20 per page, pager moves to page 2 with older records, totals line from overview', async () => {
    await page.goto(app.origin + '/?screen=dashboard');
    const panel = page.locator('section.rv-panel').filter({ has: page.getByRole('heading', { name: '实际用量与成本' }) });
    await expect(panel.locator('tbody tr')).toHaveCount(20);
    await expect(panel.locator('tbody tr').first()).toContainText('m-44');
    await expect(panel.getByText('CNY').first()).toBeVisible();
    await expect(panel.getByRole('navigation', { name: '用量分页' }).locator('[data-pager-status]')).toHaveText('第 1 页 · 共 3 页');
    await panel.getByRole('button', { name: '下一页' }).click();
    await expect(panel.getByRole('navigation', { name: '用量分页' }).locator('[data-pager-status]')).toHaveText('第 2 页 · 共 3 页');
    await expect(panel.locator('tbody tr').first()).toContainText('m-24');
    await expect(panel.locator('tbody tr')).toHaveCount(20);
    await panel.getByRole('button', { name: '刷新' }).click();
    await expect(panel.locator('tbody tr').first()).toBeVisible();
  });

  await check('create-project dialog: product and template selects search and load more instead of loading all', async () => {
    await page.goto(app.origin + '/?screen=projects');
    await page.getByRole('button', { name: '新建项目' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新建项目' });
    await expect(dialog.getByLabel('商品', { exact: true }).locator('option')).toHaveCount(31);
    await dialog.getByRole('button', { name: '加载更多' }).first().click();
    await expect(dialog.getByLabel('商品', { exact: true }).locator('option')).toHaveCount(61);
    await dialog.getByLabel('搜索商品').fill('分页商品65');
    await expect(dialog.getByLabel('商品', { exact: true }).locator('option')).toHaveCount(2);
    await dialog.getByLabel('商品', { exact: true }).selectOption({ label: '分页商品65' });
    await dialog.getByLabel('搜索商品').fill('分页商品01');
    await expect(dialog.getByLabel('商品', { exact: true }).locator('option')).toHaveCount(3);
    await expect(dialog.getByLabel('商品', { exact: true }).locator('option:checked')).toHaveText('分页商品65');
    await dialog.getByRole('button', { name: '取消' }).click();
  });

  await check('canvas image picker: 30 per load, 加载更多, server search; referenced asset name resolves by id', async () => {
    const png = app.png;
    const up = async name => { const r = await fetch(app.origin + '/api/creation/assets/upload?role=creative&name=' + encodeURIComponent(name), { method: 'POST', headers: { 'X-CSRF-Token': app.csrf, 'Content-Type': 'image/png' }, body: png }); return (await r.json()).asset; };
    const first = await up('画布引用图.png');
    for (let i = 1; i <= 34; i++) await app.store.create(W, 'asset', { name: `画布选图${pad(i)}.png`, mime: 'image/png', role: 'creative', bytes: 10, objectKey: randomUUID() });
    // 真实 v4 项目自带「参考图」图片输入节点；把来源图指向 first，验证名称 / 已删除检测经 ?ids= 解析。
    const created = (await app.api('/api/creation/projects', { name: '选择器项目', graphVersion: 4 })).project;
    const project = (await app.api('/api/creation/projects/' + created.id, { revision: created.revision, tasks: created.tasks.map(t => t.kind === 'image' ? { ...t, sourceAssetId: first.id } : t) }, 'PATCH')).project;
    const lookups = [];
    page.on('request', r => { if (r.url().includes('/api/creation/assets?')) lookups.push(r.url()); });
    await page.goto(`${app.origin}/?screen=project&projectId=${project.id}`);
    await page.locator('.v3-node.kind-image').first().click();
    await page.getByRole('button', { name: '更换参考图' }).click();
    const options = page.locator('.canvas-asset-options button');
    await expect(options).toHaveCount(30);
    // 前面各页的种子素材同为创作素材：55 + 引用图 1 + 本用例 34 = 90。
    await expect(page.getByText('已显示 30 / 90')).toBeVisible();
    const more = page.locator('[data-picker-feed]').getByRole('button', { name: '加载更多' });
    await more.click();
    await expect(options).toHaveCount(60);
    await more.click();
    await expect(options).toHaveCount(90);
    await more.waitFor({ state: 'detached' });
    if (!lookups.some(u => u.includes('ids=' + first.id))) throw new Error('referenced asset was not resolved through ?ids=');
    if (lookups.some(u => !u.includes('limit=') && !u.includes('ids='))) throw new Error('an unbounded asset list request was made: ' + lookups.find(u => !u.includes('limit=') && !u.includes('ids=')));
  });

  await check('375px: every pager stays inside the viewport', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    for (const [url, label] of [['projects', '项目分页'], ['assets', '素材分页'], ['trash', '回收站分页']]) {
      await page.goto(`${app.origin}/?screen=${url}`);
      await expect(pager(label)).toBeVisible();
      const box = await pager(label).boundingBox();
      if (!box || box.x < 0 || box.x + box.width > 376) throw new Error(`${label} outside the viewport: ${JSON.stringify(box)}`);
      if (await overflow() > 1) throw new Error(`${url} overflows horizontally by ${await overflow()}px`);
    }
  });

  if (errors.length) failures.push('page errors: ' + errors.slice(0, 3).join(' | '));
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('Pagination browser QA passed');
} finally {
  await browser?.close();
  await app.stop();
}
