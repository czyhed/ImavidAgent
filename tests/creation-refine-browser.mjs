// 局部精修：结果图 -> 蒙版编辑器 -> 自动新建连好线的改图节点 -> 弹出执行预览（不开始生成）。
// 全部使用隔离测试库与本地生成边界，不连接共享数据库、不产生付费任务。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { startCanvasHarness } from './creation-canvas-qa-harness.mjs';

// 生成一张浏览器可解码的纯色 RGB PNG（64x48，扫描线过滤字节为 0）。
function solidPng(width = 64, height = 48) {
 const chunk = (type, data) => { const t = Buffer.from(type), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, c]); };
 const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
 const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 160)]);
 return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

// 解码 8-bit RGBA PNG（仅用于断言导出的蒙版像素，不引入依赖）。
function decodeRgba(png) {
 let offset = 8, width = 0, height = 0, type = 0; const parts = [];
 while (offset < png.length) {
  const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
  if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; }
  if (name === 'IDAT') parts.push(data);
  offset += 12 + length;
 }
 assert.equal(type, 6, '蒙版应为 RGBA PNG');
 const raw = inflateSync(Buffer.concat(parts)), stride = width * 4, out = Buffer.alloc(height * stride);
 for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  for (let x = 0; x < stride; x++) {
   const left = x >= 4 ? out[y * stride + x - 4] : 0, up = y ? out[(y - 1) * stride + x] : 0, upLeft = y && x >= 4 ? out[(y - 1) * stride + x - 4] : 0;
   const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : (() => { const p = left + up - upLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft); return a <= b && a <= c ? left : b <= c ? up : upLeft; })();
   out[y * stride + x] = (line[x] + predictor) & 255;
  }
 }
 return { width, height, pixels: out };
}

const body = {
 name: '局部精修验收', productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 },
 tasks: [
  { id: 'p1', kind: 'prompt', title: '提示词', prompt: '白色背景下的洁面乳', params: {}, subject: 'concept', position: { x: 40, y: 60 }, sourceAssetId: null, sourceRunId: null },
  { id: 'g1', kind: 'generate', title: '主图', prompt: '', params: { size: '1024x1024' }, subject: 'concept', position: { x: 420, y: 60 }, sourceAssetId: null, sourceRunId: null },
 ],
 edges: [{ id: 'e1', source: 'p1', sourceHandle: 'text', target: 'g1', targetHandle: 'prompt' }],
};
const png = solidPng();
const harness = await startCanvasHarness({ projectBody: body, image: png });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
 // 构造一个已成功的生成版本及其结果素材。
 const result = await harness.boundary.media.put('qa', { bytes: png, mime: 'image/png', name: '主图.png', projectId: harness.projectId, taskId: 'g1', role: 'result' });
 await harness.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES($1,'qa',$2,'g1',$3,$4,'succeeded',$5)", [randomUUID(), harness.projectId, randomUUID(), { kind: 'image', nodeKind: 'generate', task: { title: '主图' } }, { assetId: result.id, fileUrl: `/api/creation/assets/${result.id}/file` }]);

 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
 await page.goto(`${harness.origin}?projectId=${harness.projectId}`);
 const source = page.locator('.v3-node.kind-generate');
 await source.waitFor({ timeout: 20000 });
 await source.locator('.canvas-result img').waitFor({ timeout: 20000 });
 await source.getByText('参考图 0 / 8').waitFor();

 // 1. 打开局部精修，未涂抹时不能确认。
 await source.getByRole('button', { name: '局部精修', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: '局部精修', exact: true });
 await dialog.waitFor();
 const canvas = dialog.locator('canvas[aria-label="蒙版绘制区"]');
 await canvas.waitFor();
 assert.equal(await canvas.evaluate(el => getComputedStyle(el).touchAction), 'none', '绘制层需禁用浏览器触摸手势');
 const confirm = dialog.getByRole('button', { name: '确认并预览', exact: true });
 assert.equal(await confirm.isDisabled(), true, '未涂抹时禁止确认');

 // 2. Esc 关闭；再次打开。
 await page.keyboard.press('Escape');
 await dialog.waitFor({ state: 'detached' });
 await source.getByRole('button', { name: '局部精修', exact: true }).click();
 await canvas.waitFor();

 // 3. 涂抹一个区域，撤销 / 清空可用，再涂抹。
 const box = await canvas.boundingBox();
 const stroke = async (fx, fy, tx, ty) => { await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy); await page.mouse.down(); await page.mouse.move(box.x + box.width * tx, box.y + box.height * ty, { steps: 8 }); await page.mouse.up(); };
 await stroke(0.1, 0.1, 0.4, 0.1);
 assert.equal(await confirm.isDisabled(), false);
 await dialog.getByRole('button', { name: '清空', exact: true }).click();
 assert.equal(await confirm.isDisabled(), true, '清空后重新禁止确认');
 await stroke(0.1, 0.1, 0.5, 0.1);
 await stroke(0.1, 0.3, 0.5, 0.3);
 await dialog.getByRole('button', { name: '撤销', exact: true }).click();
 await dialog.getByLabel('修改要求', { exact: true }).fill('把左上角背景换成木纹桌面');
 await dialog.getByLabel('修改要求', { exact: true }).blur();

 // 4. 确认：上传蒙版、新建改图节点与连线、弹出执行预览，但不调用 /start。
 await confirm.click();
 await page.getByRole('dialog', { name: '执行范围预览' }).waitFor({ timeout: 15000 });
 assert.equal(harness.calls.some(c => c.includes('/start')), false, '确认局部精修不得直接开始生成');
 assert.equal(harness.boundary.requests.some(r => r.url === '/generate'), false, '不得产生生成请求');
 assert.equal(harness.uploads.length, 1);
 const upload = harness.uploads[0];
 assert.equal(upload.query.role, 'mask');
 assert.equal(upload.query.baseAssetId, result.id);
 assert.equal(upload.query.mime, 'image/png');
 assert.equal(upload.query.projectId, harness.projectId);

 // 蒙版 PNG：与原图同尺寸；涂抹处 alpha=0，其余不透明黑色。
 const mask = decodeRgba(upload.bytes);
 assert.equal(mask.width, 64); assert.equal(mask.height, 48);
 const at = (fx, fy) => { const x = Math.floor(mask.width * fx), y = Math.floor(mask.height * fy), i = (y * mask.width + x) * 4; return [...mask.pixels.subarray(i, i + 4)]; };
 assert.deepEqual(at(0.3, 0.1), [0, 0, 0, 0], '涂抹区域应透明');
 assert.deepEqual(at(0.8, 0.8), [0, 0, 0, 255], '未涂抹区域应为不透明黑色');
 assert.deepEqual(at(0.3, 0.3), [0, 0, 0, 255], '被撤销的笔画不应出现在蒙版中');

 const preview = page.getByRole('dialog', { name: '执行范围预览' });
 await preview.getByText('局部精修', { exact: true }).waitFor();
 await preview.getByRole('button', { name: '取消', exact: true }).click();

 // 5. 画布与服务端：新增改图节点、连线、蒙版与来源版本。
 await page.waitForTimeout(1500);
 const saved = (await harness.projects.detail('qa', harness.projectId)).project;
 const edit = saved.tasks.find(t => t.kind === 'edit');
 assert.ok(edit, '应新增改图节点');
 assert.equal(edit.title, '局部精修'); assert.equal(edit.prompt, '把左上角背景换成木纹桌面');
 assert.equal(edit.params.size, '1024x1024');
 assert.equal(edit.workflowId, saved.tasks.find(t => t.id === 'g1').workflowId);
 assert.ok(edit.position.x > saved.tasks.find(t => t.id === 'g1').position.x);
 const detail = await harness.projects.detail('qa', harness.projectId);
 assert.equal(edit.sourceRunId, detail.runs[0].id);
 const link = saved.edges.find(e => e.target === edit.id);
 assert.deepEqual([link.source, link.sourceHandle, link.targetHandle], ['g1', 'image', 'image']);
 const maskAsset = await harness.store.get('qa', edit.maskAssetId);
 assert.equal(maskAsset.role, 'mask'); assert.equal(maskAsset.baseAssetId, result.id);

 // 6. 改图节点显示蒙版缩略图；移除蒙版后字段清空，重新绘制可再次打开编辑器。
 const editNode = page.locator('.v3-node.kind-edit');
 await editNode.locator('.canvas-mask img').waitFor();
 await editNode.getByRole('button', { name: '重新绘制', exact: true }).click();
 const redraw = page.getByRole('dialog', { name: '重新绘制蒙版', exact: true });
 await redraw.waitFor();
 await page.keyboard.press('Escape');
 await redraw.waitFor({ state: 'detached' });
 await editNode.getByRole('button', { name: '移除蒙版', exact: true }).click();
 await page.waitForTimeout(1500);
 assert.equal((await harness.projects.detail('qa', harness.projectId)).project.tasks.find(t => t.id === edit.id).maskAssetId ?? null, null);

 // 7. 手机宽度下编辑器不产生横向溢出。
 await page.setViewportSize({ width: 375, height: 812 });
 await page.locator('.v3-node.kind-generate').getByRole('button', { name: '局部精修', exact: true }).click();
 await page.getByRole('dialog', { name: '局部精修', exact: true }).waitFor();
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '手机宽度不应横向溢出');
 await page.keyboard.press('Escape');

 assert.deepEqual(errors, []);
 assert.equal(harness.calls.some(c => c.includes('/start')), false);
 console.log('creation-refine-browser passed: mask editor, mask PNG semantics, edit node + edge created, preview shown, no generation started');
} finally { await browser.close(); await harness.stop(); }
