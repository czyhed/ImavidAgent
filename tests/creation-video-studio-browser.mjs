// 视频工作台（生视频第 3 步）：分镜卡片与画布节点双向一致、上一镜尾帧选项与「上一镜已更新」、
// 批量生成预览对话框与进度、失败重试、AI 分镜建议预览 / 应用 / 放弃（第 4 步）。全部使用隔离测试库和本地生成边界，不调用真实生成或付费接口。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCanvasHarness } from './creation-canvas-qa-harness.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=', 'base64');
const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), sa: randomUUID(), sb: randomUUID(), sc: randomUUID() };
const node = (id, title, x, extra = {}) => ({ id, kind: 'video', title, prompt: `${title}的画面`, params: { duration: 4, resolution: '480P', ratio: '9:16' }, subject: 'concept', position: { x, y: 60 }, sourceAssetId: null, sourceRunId: null, videoMode: 'text', dimension: '视频分镜', ...extra });
const body = {
 name: '视频工作台验收', productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 },
 tasks: [node(ids.a, '镜头甲', 40), node(ids.b, '镜头乙', 400), node(ids.c, '镜头丙', 760)], edges: [],
 storyboard: { script: '【开场】展示杯子', compile: { status: 'idle' }, shots: [
  { id: ids.sa, title: '镜头甲', description: '开场特写', nodeId: ids.a },
  { id: ids.sb, title: '镜头乙', description: '使用场景', nodeId: ids.b },
  { id: ids.sc, title: '镜头丙', description: '收尾', nodeId: ids.c },
 ] },
};
const harness = await startCanvasHarness({ projectBody: body });
const frameCalls = [];
harness.projects.frameExtractor = { extract: async input => { frameCalls.push(input.bytes.length); return { bytes: PNG, mime: 'image/png' }; } };
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const notes = [];
const pass = text => notes.push(text);
try {
 const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
 const detail = () => harness.projects.detail('qa', harness.projectId);
 const serverNode = async id => (await detail()).project.tasks.find(t => t.id === id);
 const open = async (view = 'video', projectId = harness.projectId) => { await page.goto(`${harness.origin}?projectId=${projectId}&view=${view}`); await page.waitForSelector(view === 'video' ? '.vs-tile' : '.creative-task-item', { timeout: 20000 }); };
 const settled = async () => { await page.waitForTimeout(1500); };
 // 单镜编辑区一次只显示选中的分镜：先点时间线缩略图，再返回该分镜的编辑卡。
 const tile = id => page.locator(`.vs-tile[data-tile="${id}"]`);
 const card = id => page.locator(`.vs-shot[data-shot="${id}"]`);
 const pick = async id => { await tile(id).locator('.vs-tile-main').click(); await expect(card(id)).toBeVisible(); return card(id); };
 const section = (c, id) => c.locator(`#vs-sec-${id}`);
 const openSection = async (c, id) => { const sec = section(c, id); if (!(await sec.evaluate(el => el.open))) await sec.locator(':scope > summary').click(); await expect(sec).toHaveJSProperty('open', true); return sec; };
 const advance = async (times = 1) => { for (let index = 0; index < times; index += 1) await harness.projects.tick(); };
 const batchPanel = () => page.getByRole('region', { name: '批量生成进度' });
 const batchRow = title => batchPanel().locator('li').filter({ has: page.locator('.vs-batch-title', { hasText: title }) });
 await open();

 // 1. 分镜卡片直接编辑画布节点：提示词、时长、标题、方式、描述。
  const first = await pick(ids.sa);
 await first.getByRole('textbox', { name: '视频提示词' }).fill('缓慢推进杯身特写');
 await openSection(first, 'params');
 await first.getByLabel('时长（秒）', { exact: true }).fill('6');
 await first.getByLabel('标题', { exact: true }).fill('开场特写');
 await expect.poll(async () => { const n = await serverNode(ids.a); return [n.prompt, n.params.duration, n.title]; }).toEqual(['缓慢推进杯身特写', 6, '开场特写']);
 await expect.poll(async () => (await detail()).project.storyboard.shots[0].title).toBe('开场特写');
 await first.getByLabel('画面描述').fill('杯子在桌面上缓缓旋转');
 assert.equal(await page.getByRole('button', { name: '保存分镜', exact: true }).count(), 0, '没有「保存分镜」按钮，改动自动保存');
 await expect.poll(async () => (await detail()).project.storyboard.shots[0].description).toBe('杯子在桌面上缓缓旋转');
 const stored = (await detail()).project.storyboard.shots[0];
 assert.deepEqual(Object.keys(stored).sort(), ['description', 'id', 'nodeId', 'title'], '分镜只保存顺序、标题、描述与节点编号');
 assert.equal((await serverNode(ids.a)).prompt, '缓慢推进杯身特写', '分镜保存不回写提示词');
 pass('PASS 分镜卡片编辑提示词 / 时长 / 标题直接写入画布节点，分镜表只保存标题、描述与节点编号');

 // 2. 画布 ⇄ 工作台双向即时一致。
 await open('canvas');
 await page.locator('.creative-task-item').filter({ hasText: '视频分镜' }).click();
 await expect(page.locator('.v3-node.kind-video')).toHaveCount(3);
 const canvasA = page.locator('.v3-node.kind-video').nth(0);
 await expect(canvasA.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue('缓慢推进杯身特写');
 await expect(canvasA.getByLabel('时长（秒）', { exact: true })).toHaveValue('6');
 await canvasA.getByRole('textbox', { name: '提示词', exact: true }).fill('画布里改过的提示词');
 await canvasA.getByLabel('节点名称', { exact: true }).fill('开场特写（画布改名）');
 await expect.poll(async () => (await serverNode(ids.a)).prompt).toBe('画布里改过的提示词');
 await expect.poll(async () => (await detail()).project.storyboard.shots[0].title).toBe('开场特写（画布改名）');
 await settled();
  await open();
 await expect(card(ids.sa).getByRole('textbox', { name: '视频提示词' })).toHaveValue('画布里改过的提示词');
 await expect(card(ids.sa).getByLabel('标题', { exact: true })).toHaveValue('开场特写（画布改名）');
 pass('PASS 画布修改提示词与节点名称后，工作台卡片同步显示；工作台修改后画布节点同步显示');

 // 3. 顺序：上移 / 下移只改分镜表顺序，节点配置不变。
 await page.getByRole('button', { name: '下移开场特写（画布改名）' }).click();
 await expect.poll(async () => (await detail()).project.storyboard.shots.map(s => s.nodeId)).toEqual([ids.b, ids.a, ids.c]);
 await page.getByRole('button', { name: '上移开场特写（画布改名）' }).click();
 await expect.poll(async () => (await detail()).project.storyboard.shots.map(s => s.nodeId)).toEqual([ids.a, ids.b, ids.c]);
 assert.equal((await serverNode(ids.a)).prompt, '画布里改过的提示词');
 pass('PASS 上移 / 下移调整分镜顺序，自动保存后顺序与节点配置正确');

 // 4. 上一镜尾帧选项：只在首尾帧方式且有上一镜时出现；选择后写入节点；上一镜未成功时提示等待。
  await expect(first.getByLabel('首帧来源', { exact: true })).toHaveCount(0);
 const second = await pick(ids.sb);
 await expect(second.getByLabel('首帧来源', { exact: true })).toHaveCount(0);
 await second.getByRole('radio', { name: '首尾帧' }).click();
  await expect(second.getByLabel('首帧来源', { exact: true })).toBeVisible();
 await second.getByLabel('首帧来源', { exact: true }).selectOption('tail');
 await expect(second.getByText('等待上一镜生成成功')).toBeVisible();
 await expect(tile(ids.sb).getByRole('button', { name: /等待上一镜/ })).toBeVisible();
 await expect.poll(async () => { const n = await serverNode(ids.b); return [n.videoMode, n.tailFrame?.fromNodeId, n.tailFrame?.assetId ?? null]; }).toEqual(['frames', ids.a, null]);
 await settled();
 pass('PASS 首尾帧方式下出现「上一镜尾帧」选项，选择后写入节点并提示等待上一镜');

 // 5. 批量生成预览：每镜预估、等待上一镜、合计、余额；积分不足禁用开始。
 const dialog = page.getByRole('dialog', { name: '批量生成预览' });
 await page.getByRole('button', { name: '生成全部分镜', exact: true }).click();
 await expect(dialog).toBeVisible();
 await expect(dialog.locator('li')).toHaveCount(3);
 await expect(dialog.locator('li').nth(0)).toContainText('新生成');
 await expect(dialog.locator('li').nth(1)).toContainText('等待上一镜');
 await expect(dialog.locator('li').nth(2)).toContainText('新生成');
 await expect(dialog.locator('li .pv-points')).toHaveText(['预估 30 积分', '预估 20 积分', '预估 20 积分']);
 await expect(dialog.getByLabel('积分预估')).toContainText('70 积分');
 await expect(dialog.getByLabel('积分预估')).toContainText('余额未知');
 await expect(dialog.getByRole('button', { name: '开始生成', exact: true })).toBeEnabled();
 await dialog.getByRole('button', { name: '取消', exact: true }).click();
 harness.boundary.hub.videoBalance = async () => ({ available: 10, reserved: 0, total: 10 });
 await page.getByRole('button', { name: '生成全部分镜', exact: true }).click();
 await expect(dialog.getByRole('alert')).toContainText('积分不足');
 await expect(dialog).toContainText('10 积分');
 await expect(dialog.getByRole('button', { name: '开始生成', exact: true })).toBeDisabled();
 await dialog.getByRole('button', { name: '关闭' }).click();
 pass('PASS 批量预览显示每镜预估积分、合计、余额与「等待上一镜」；余额不足禁用开始');

 // 6. 开始批量生成：进度、状态徽标；失败后依赖分镜暂停，其余继续；失败可重试。
 harness.boundary.hub.videoBalance = async () => ({ available: 1000, reserved: 0, total: 1000 });
 await page.getByRole('button', { name: '生成全部分镜', exact: true }).click();
 await expect(dialog.getByRole('alert')).toHaveCount(0);
 await dialog.getByRole('button', { name: '开始生成', exact: true }).click();
 await expect(batchPanel()).toBeVisible();
 await expect(batchPanel()).toContainText('进行中');
 await expect(batchPanel()).toContainText('已完成 0 / 3');
 // 只派发，不驱动：甲与丙并发提交，乙等待上一镜。
 await harness.projects.advanceBatches();
 const runsNow = (await detail()).runs;
 assert.equal(runsNow.length, 2);
 await expect(batchRow('镜头乙')).toContainText('待派发', { timeout: 15000 });
 await expect(batchRow('画布改名')).toContainText('生成中', { timeout: 15000 });
 await pick(ids.sa);
 await expect(card(ids.sa).getByLabel('批量状态')).toContainText('生成中');
 // 甲被供应商确认失败：乙被暂停（held），丙继续并成功。
 const runA = runsNow.find(r => r.taskId === ids.a);
 await harness.pool.query("UPDATE sj_creation_runs SET status='failed',error=$2 WHERE id=$1", [runA.id, { code: 'PROVIDER_GENERATION_FAILED', message: '供应商视频任务失败，请核对后手动重试。' }]);
 await advance(3);
 await expect(batchPanel()).toContainText('已结束', { timeout: 15000 });
 await expect(batchPanel()).toContainText('已完成 1 / 3');
 await expect(batchRow('画布改名')).toContainText('失败');
 await expect(batchRow('镜头乙')).toContainText('等待上一镜（已暂停）');
 await expect(batchRow('镜头丙')).toContainText('已完成');
 await expect(batchPanel()).toContainText('供应商视频任务失败');
 pass('PASS 批量进度显示总进度与每镜徽标；失败只暂停依赖它的分镜，其余继续');

 // 7. 失败分镜的「重试」：显式重试后失败镜与被暂停的依赖镜重新派发，不自动重试。
 const before = (await detail()).runs.length;
 await advance(3);
 assert.equal((await detail()).runs.length, before, '不自动重试');
 await batchPanel().getByRole('button', { name: /重试批次分镜/ }).click();
 await expect(batchPanel()).toContainText('进行中', { timeout: 15000 });
 await advance(6);
 await expect(batchPanel()).toContainText('已完成 3 / 3', { timeout: 15000 });
 await expect(batchPanel()).toContainText('已结束');
 assert.equal(frameCalls.length, 1, '乙在甲成功后截帧一次');
 const finalNode = await serverNode(ids.b);
 assert.ok(finalNode.tailFrame.assetId && finalNode.tailFrame.fromNodeId === ids.a);
 pass('PASS 失败分镜点击「重试」后与依赖分镜一起重新生成，乙在甲成功后自动截取尾帧');

  // 8. 上一镜已更新：独立项目，上一镜出现更新的成功运行后提示，点击换用新尾帧。
 const s1 = randomUUID(), s2 = randomUUID(), n1 = randomUUID(), n2 = randomUUID(), r1 = randomUUID(), r2 = randomUUID();
 const media = harness.boundary.media;
 const out1 = await media.put('qa', { bytes: PNG, mime: 'image/png', name: '甲-1.mp4', role: 'result' });
 const out2 = await media.put('qa', { bytes: PNG, mime: 'image/png', name: '甲-2.mp4', role: 'result' });
 const tail = await media.put('qa', { bytes: PNG, mime: 'image/png', name: '尾帧.png', role: 'result' });
 const staleProject = await harness.store.create('qa', 'project', {
  name: '尾帧过期验收', productId: null, productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 },
  tasks: [node(n1, '上一镜', 40), node(n2, '下一镜', 400, { videoMode: 'frames', tailFrame: { fromNodeId: n1, runId: r1, assetId: tail.id } })], edges: [],
  storyboard: { script: '', compile: { status: 'idle' }, shots: [{ id: s1, title: '上一镜', description: '', nodeId: n1 }, { id: s2, title: '下一镜', description: '', nodeId: n2 }] },
 });
 const insertRun = (id, output) => harness.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES($1,'qa',$2,$3,gen_random_uuid(),$4,'succeeded',$5)", [id, staleProject.id, n1, { kind: 'video', task: { title: '上一镜' } }, { assetId: output.id }]);
 await insertRun(r1, out1);
 await open('video', staleProject.id);
 const next = await pick(s2);
 await expect(next.getByLabel('首帧来源', { exact: true })).toHaveValue('tail');
 await expect(next.getByText('已使用「上一镜」的尾帧作为首帧。')).toBeVisible();
 await expect(next.getByText('上一镜已更新')).toHaveCount(0);
 await settled();
 await insertRun(r2, out2);
 // 没有运行中的任务时不再轮询：他处产生的新结果在标签页切回（visibilitychange）时刷新。
 await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
 await expect(next.getByText('上一镜已更新')).toBeVisible({ timeout: 15000 });
 const staleDetail = await harness.projects.detail('qa', staleProject.id);
 assert.equal(staleDetail.project.tasks.find(t => t.id === n2).tailFrame.runId, r1, '不自动替换');
 const renew = next.getByRole('button', { name: '换用新尾帧', exact: true });
 await renew.click();
 await expect(next.getByText('上一镜已更新')).toHaveCount(0, { timeout: 15000 });
 const renewed = await harness.projects.detail('qa', staleProject.id);
 assert.equal(renewed.project.tasks.find(t => t.id === n2).tailFrame.runId, r2);
 assert.equal(frameCalls.length, 2);
 pass('PASS 上一镜出现更新的成功运行后显示「上一镜已更新」，点击「换用新尾帧」才替换');

 // 9. AI 分镜建议（V-16）：生成后只显示预览；应用后创建分镜与画布节点并连线素材；放弃只作废建议。模型调用由本地替身返回。
 const upload = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '杯身正面.png', role: 'creative', projectId: harness.projectId });
 const modelRequests = [];
 const realHub = harness.projects.hub;
 harness.projects.hub = { ...realHub, complete: async request => {
  const payload = JSON.parse(request.messages[0].content);
  modelRequests.push(payload);
  const key = payload.materials.find(m => m.name === '杯身正面.png')?.key;
  return { text: JSON.stringify({ shots: [
   { title: '开场推进', description: '杯身特写', videoMode: 'frames', duration: 6, prompt: '镜头缓慢推进', materials: [{ key, slot: 'first' }] },
   { title: '违规镜', description: '', videoMode: 'frames', duration: 99, prompt: '混用素材 {{M99}}', materials: [{ key: 'M99', slot: 'refImage' }, { key, slot: 'first' }, { key, slot: 'refImage' }], dialogue: [{ text: '保温十二小时', language: 'zh' }] },
  ] }), usage: null };
 } };
 const suggestPanel = page.getByRole('region', { name: 'AI 分镜建议' });
 const shotCount = async () => (await detail()).project.storyboard.shots.length;
 const nodeCount = async () => (await detail()).project.tasks.length;
 await open();
 const shotsBefore = await shotCount(), nodesBefore = await nodeCount();
 await page.getByRole('button', { name: '脚本', exact: true }).click();
 await expect(page.getByRole('dialog', { name: '脚本' })).toBeVisible();
 await page.getByRole('button', { name: 'AI 生成分镜', exact: true }).click();
 await expect(suggestPanel).toBeVisible({ timeout: 15000 });
 const listed = modelRequests[0].materials;
 assert.deepEqual(listed[0], { key: 'M1', type: 'image', name: '杯身正面.png', source: '项目上传素材' }, '素材库上传排在前面，编号 M1');
 assert.ok(listed.slice(1).every(m => /^M\d+$/.test(m.key) && /（版本 \d+）$/.test(m.name) && m.source.startsWith('项目生成结果：')), '其余是项目内成功的生成结果，带任务标题与版本');
 await expect(suggestPanel.locator('[data-suggest-shot]')).toHaveCount(2);
 const firstSuggest = suggestPanel.locator('[data-suggest-shot="0"]');
 await expect(firstSuggest).toContainText('开场推进');
 await expect(firstSuggest).toContainText('首尾帧');
 await expect(firstSuggest.getByRole('img', { name: '杯身正面.png' })).toBeVisible();
 await expect(firstSuggest).toContainText('首帧（M1）');
 await expect(firstSuggest).toContainText('镜头缓慢推进');
 const badSuggest = suggestPanel.locator('[data-suggest-shot="1"]');
 await expect(badSuggest).toContainText('文生视频');
 await expect(badSuggest).toContainText('30 秒');
 await expect(badSuggest).toContainText('台词');
 await expect(badSuggest).toContainText('保温十二小时');
 await expect(badSuggest.getByLabel('已修正')).toContainText('不在可用素材清单');
 await expect(badSuggest.getByLabel('已修正')).toContainText('不能混用参考素材');
 assert.equal(await shotCount(), shotsBefore, '预览阶段不写分镜');
 assert.equal(await nodeCount(), nodesBefore, '预览阶段不写画布');
 // 放弃：建议标记 discarded，预览消失，画布不变。
 await suggestPanel.getByRole('button', { name: '放弃', exact: true }).click();
 await expect(suggestPanel).toHaveCount(0);
 await expect.poll(async () => (await detail()).project.storyboard.shotsRequest.status).toBe('discarded');
 assert.equal(await shotCount(), shotsBefore);
 assert.equal(await nodeCount(), nodesBefore);
 // 再次生成并应用：分镜表出现 2 个新分镜，画布出现 2 个视频节点 + 1 个图片输入节点，首帧连线。
 await page.getByRole('button', { name: 'AI 生成分镜', exact: true }).click();
 await expect(suggestPanel).toBeVisible({ timeout: 15000 });
 await suggestPanel.getByRole('button', { name: '应用', exact: true }).click();
 await expect(suggestPanel).toHaveCount(0);
 await expect(page.locator('.vs-tile')).toHaveCount(shotsBefore + 2);
 const applied = await detail();
 assert.equal(applied.project.storyboard.shotsRequest.status, 'applied');
 assert.equal(applied.project.tasks.length, nodesBefore + 3);
 const appliedNodes = applied.project.storyboard.shots.slice(-2).map(s => applied.project.tasks.find(t => t.id === s.nodeId));
 assert.deepEqual(appliedNodes.map(n => [n.title, n.videoMode, n.params.duration, n.prompt]), [['开场推进', 'frames', 6, '镜头缓慢推进'], ['违规镜', 'text', 30, '混用素材']]);
 const firstEdge = applied.project.edges.find(e => e.target === appliedNodes[0].id);
 assert.equal(firstEdge.targetHandle, 'first');
 assert.equal(applied.project.tasks.find(t => t.id === firstEdge.source).kind, 'image');
 await open('canvas');
 await page.locator('.creative-task-item').filter({ hasText: '视频分镜' }).click();
 await expect(page.locator('.v3-node.kind-video')).toHaveCount(3 + 2);
 await open();
 pass('PASS AI 分镜建议先预览（方式、素材缩略图、提示词、台词、修正说明），放弃只作废建议；应用后分镜表与画布出现新节点并连线素材');


 // ---------- 以下为视频工作台界面重做（W1–W8）新增检查 ----------
 const shotRow = (title, x, extra = {}) => ({ node: node(randomUUID(), title, x, extra), shot: randomUUID() });
 const makeProject = async (name, rows, extra = {}) => {
  const created = await harness.store.create('qa', 'project', {
   name, productId: null, productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 }, ...(extra.voiceRoles ? { voiceRoles: extra.voiceRoles } : {}),
   tasks: [...rows.map(r => r.node), ...(extra.tasks || [])], edges: extra.edges || [],
   storyboard: { script: '', compile: { status: 'idle' }, shots: rows.map(r => ({ id: r.shot, title: r.node.title, description: '', nodeId: r.node.id })) },
  });
  return created.id;
 };
 const insertRunFor = (projectId, taskId, output, kind = 'video') => harness.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES(gen_random_uuid(),'qa',$1,$2,gen_random_uuid(),$3,'succeeded',$4)", [projectId, taskId, { kind, task: { title: '结果' } }, output]);
 const detailOf = id => harness.projects.detail('qa', id);
 const tileOrder = () => page.locator('.vs-tile').evaluateAll(els => els.map(el => el.dataset.tile));
 const activeIn = sectionId => page.evaluate(id => document.activeElement?.closest('#vs-sec-' + id) !== null, sectionId);

 // 11. 时间线：点击选中并切换单镜编辑；拖动缩略图排序后写入分镜表，选中项不变；「＋」新增并选中。
 const rowsA = [shotRow('甲', 40), shotRow('乙', 400), shotRow('丙', 760)];
 const timelineId = await makeProject('时间线验收', rowsA);
 await open('video', timelineId);
 await expect(page.locator('.vs-tile')).toHaveCount(3);
 await expect(tile(rowsA[0].shot)).toHaveClass(/on/);
 await tile(rowsA[2].shot).locator('.vs-tile-main').click();
 await expect(tile(rowsA[2].shot)).toHaveClass(/on/);
 await expect(page.locator('.vs-shot')).toHaveCount(1);
 await expect(card(rowsA[2].shot).getByLabel('标题', { exact: true })).toHaveValue('丙');
 await tile(rowsA[2].shot).dragTo(tile(rowsA[0].shot));
 await expect.poll(async () => (await detailOf(timelineId)).project.storyboard.shots.map(s => s.id)).toEqual([rowsA[2].shot, rowsA[0].shot, rowsA[1].shot]);
 assert.deepEqual(await tileOrder(), [rowsA[2].shot, rowsA[0].shot, rowsA[1].shot]);
 await expect(tile(rowsA[2].shot)).toHaveClass(/on/);
 await expect(card(rowsA[2].shot)).toBeVisible();
 await page.getByRole('button', { name: '＋ 添加分镜' }).click();
 await expect(page.locator('.vs-tile')).toHaveCount(4);
 await expect.poll(async () => (await detailOf(timelineId)).project.storyboard.shots.length).toBe(4);
 await expect(page.locator('.vs-tile').last()).toHaveClass(/on/);
 await expect(page.locator('.vs-shot').getByRole('textbox', { name: '视频提示词' })).toBeVisible({ timeout: 15000 });
 pass('PASS 时间线：点击选中切换单镜编辑，拖动缩略图排序写入分镜表且选中不变，「＋」新增并选中');

 // 12. 工作台选素材：商品素材 → 创建图片输入节点 + 连线（服务端状态可见、画布可见），再移除时一并清理。
 const materialRows = [shotRow('素材镜', 40, { videoMode: 'reference', params: {} })];
 const materialId = await makeProject('素材验收', materialRows);
 const cup = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '杯身正面.png', role: 'creative', projectId: materialId });
 await open('video', materialId);
 const mCard = card(materialRows[0].shot);
 await expect(tile(materialRows[0].shot).getByRole('button', { name: /缺少参考图或参考视频/ })).toBeVisible();
 await mCard.getByRole('button', { name: '参考图：选择素材' }).click();
 const pickerDialog = page.getByRole('dialog', { name: '选择参考图素材' });
 await expect(pickerDialog).toBeVisible();
 await pickerDialog.getByRole('button', { name: '选择素材 杯身正面.png' }).click();
 await expect(pickerDialog).toHaveCount(0);
 await expect.poll(async () => (await detailOf(materialId)).project.edges.length).toBe(1);
 {
  const project = (await detailOf(materialId)).project, edge = project.edges[0], source = project.tasks.find(t => t.id === edge.source);
  assert.deepEqual([source.kind, source.sourceAssetId, source.studioMade, source.workflowId], ['image', cup.id, true, project.tasks.find(t => t.id === materialRows[0].node.id).workflowId]);
  assert.deepEqual([edge.target, edge.targetHandle, edge.sourceHandle], [materialRows[0].node.id, 'refImage', 'image']);
 }
 await expect(mCard.getByRole('list', { name: '参考图素材' }).locator('.vn-card')).toHaveCount(1);
 await expect(tile(materialRows[0].shot).getByRole('button', { name: /缺少参考图/ })).toHaveCount(0);
 await settled();
 await open('canvas', materialId);
 await page.locator('.creative-task-item').filter({ hasText: '视频分镜' }).click();
 await expect(page.locator('.v3-node.kind-image')).toHaveCount(1);
 await expect(page.locator('.v3-node.kind-image').getByLabel('节点名称')).toHaveValue('杯身正面.png');
 await open('video', materialId);
 await card(materialRows[0].shot).getByRole('button', { name: /^移除 Picture 1$/ }).click();
 await expect.poll(async () => { const p = (await detailOf(materialId)).project; return [p.edges.length, p.tasks.filter(t => t.kind === 'image').length]; }).toEqual([0, 0]);
 pass('PASS 工作台选择商品素材：创建图片输入节点并连入参考图端口，服务端与画布可见；移除时同时删除连线和自动创建的节点');

 // 13. 画布结果：选择另一节点的具体成功版本 → 连线并固定该版本（不新建节点）；上传：校验后创建输入节点。
 const genId = randomUUID(), resultRows = [shotRow('结果镜', 400, { videoMode: 'reference', params: {} })];
 const resultProject = await makeProject('结果素材验收', resultRows, { tasks: [{ id: genId, kind: 'generate', title: '主图', prompt: '杯子', params: {}, subject: 'concept', position: { x: 40, y: 40 }, sourceAssetId: null, sourceRunId: null }] });
 const resA = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '主图1.png', role: 'result', projectId: resultProject, taskId: genId });
 const resB = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '主图2.png', role: 'result', projectId: resultProject, taskId: genId });
 await insertRunFor(resultProject, genId, { assetId: resA.id }, 'image');
 await insertRunFor(resultProject, genId, { assetId: resB.id }, 'image');
 await open('video', resultProject);
 const rCard = card(resultRows[0].shot);
 const rPicker = page.getByRole('dialog', { name: '选择参考图素材' });
 await rCard.getByRole('button', { name: '参考图：选择素材' }).click();
 await rPicker.getByRole('tab', { name: '画布结果' }).click();
 await rPicker.getByRole('button', { name: '选择画布结果 主图 版本 1' }).click();
 await expect.poll(async () => { const p = (await detailOf(resultProject)).project; return [p.edges.length, p.tasks.length, p.tasks.find(t => t.id === resultRows[0].node.id).sourceRunIds?.length]; }).toEqual([1, 2, 1]);
 {
  const d = await detailOf(resultProject), edge = d.project.edges[0], pinned = d.project.tasks.find(t => t.id === resultRows[0].node.id).sourceRunIds[0];
  assert.deepEqual([edge.source, edge.targetHandle], [genId, 'refImage']);
  assert.equal(d.runs.find(r => r.id === pinned).output.assetId, resA.id, '固定的是版本 1 的具体运行');
 }
 await rCard.getByRole('button', { name: '参考图：选择素材' }).click();
 await rPicker.getByRole('tab', { name: '画布结果' }).click();
 await rPicker.getByRole('button', { name: '选择画布结果 主图 版本 2' }).click();
 await expect.poll(async () => { const d = await detailOf(resultProject); const pin = d.project.tasks.find(t => t.id === resultRows[0].node.id).sourceRunIds; return [d.project.edges.length, pin.length, d.runs.find(r => r.id === pin[0])?.output.assetId === resB.id]; }).toEqual([1, 1, true]);
 // 直接上传：错误类型被拒绝并提示；合法图片上传后成为项目创作素材并连入。
 await rCard.getByRole('button', { name: '参考图：选择素材' }).click();
 await rPicker.getByRole('tab', { name: '上传' }).click();
 await rPicker.getByLabel('上传图片').setInputFiles({ name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
 await expect(rPicker.getByRole('alert')).toContainText('仅支持');
 const uploadsBefore = harness.uploads.length;
 await rPicker.getByLabel('上传图片').setInputFiles({ name: '现场图.png', mimeType: 'image/png', buffer: PNG });
 await expect(rPicker).toHaveCount(0);
 assert.equal(harness.uploads.length, uploadsBefore + 1);
 assert.deepEqual([harness.uploads.at(-1).query.role, harness.uploads.at(-1).query.projectId], ['creative', resultProject]);
 await expect.poll(async () => (await detailOf(resultProject)).project.tasks.filter(t => t.kind === 'image' && t.studioMade).length).toBe(1);
 pass('PASS 选择画布结果会连线并固定具体成功版本（换版本只替换固定）；上传校验类型后保存为创作素材并连入');

 // 14. 项目级参数：改项目分辨率 / 时长 → 写入 storyboard.settings，跟随的分镜预估随之变化；改过的分镜显示「自定义」，可恢复跟随。
 const settingRows = [shotRow('跟随镜', 40, { params: {} }), shotRow('自定义镜', 400, { params: { resolution: '1080P' } })];
 const settingProject = await makeProject('项目参数验收', settingRows);
 await open('video', settingProject);
 await expect(page.getByLabel('项目分辨率')).toHaveValue('768P');
 await expect(tile(settingRows[0].shot).getByText('自定义', { exact: true })).toHaveCount(0);
 await expect(tile(settingRows[1].shot).getByText('自定义', { exact: true })).toBeVisible();
 await page.getByLabel('项目分辨率').selectOption('480P');
 await page.getByLabel('项目默认时长（秒）').fill('4');
 await expect.poll(async () => (await detailOf(settingProject)).project.storyboard.settings).toEqual({ resolution: '480P', ratio: '9:16', duration: 4 });
 {
  const p = await harness.projects.preview('qa', settingProject, { taskIds: settingRows.map(r => r.node.id) });
  assert.deepEqual(p.scope.map(e => e.estimatedPoints), [20, 76], '跟随镜 480P×4 秒；自定义镜保持 1080P×4 秒');
 }
 await expect(page.getByLabel('整片合计')).toContainText('2 镜 · 总时长 0:08');
 await expect(tile(settingRows[1].shot).locator('.vs-tile-meta')).toContainText('4 秒');
 // 自定义镜的参数区：本镜自定义说明，恢复跟随后徽标消失、服务端节点参数清空。
 const customCard = await pick(settingRows[1].shot);
 await openSection(customCard, 'params');
 await expect(customCard.getByRole('status').filter({ hasText: '本镜自定义了分辨率' })).toBeVisible();
 await customCard.getByRole('button', { name: '恢复跟随项目' }).click();
 await expect.poll(async () => (await detailOf(settingProject)).project.tasks.find(t => t.id === settingRows[1].node.id).params).toEqual({});
 await expect(tile(settingRows[1].shot).getByText('自定义', { exact: true })).toHaveCount(0);
 // 跟随镜自己改时长 → 成为「自定义」。
 const followCard = await pick(settingRows[0].shot);
 await openSection(followCard, 'params');
 await expect(followCard.getByLabel('分辨率', { exact: true })).toHaveValue('');
 await followCard.getByLabel('时长（秒）', { exact: true }).fill('9');
 await expect(tile(settingRows[0].shot).getByText('自定义', { exact: true })).toBeVisible();
 await expect.poll(async () => (await detailOf(settingProject)).project.tasks.find(t => t.id === settingRows[0].node.id).params).toEqual({ duration: 9 });
 // 无效默认时长就地提示，不写入。
 await page.getByLabel('项目默认时长（秒）').fill('99');
 await expect(page.getByRole('alert').filter({ hasText: '4–30' })).toBeVisible();
 await settled();
 assert.equal((await detailOf(settingProject)).project.storyboard.settings.duration, 4);
 pass('PASS 项目级参数写入 storyboard.settings 并被分镜继承（预估随之变化）；单镜改过显示「自定义」，可恢复跟随；无效时长被拒绝');

 // 15. 问题标记：缺素材 / 等待上一镜 / 配音未合成 / 素材已删除 / 上次失败；点击标记选中该镜并展开、聚焦对应分区。
 const issueRows = [shotRow('问题甲', 40, { videoMode: 'frames', params: {} }), shotRow('问题乙', 400, { videoMode: 'frames', params: {} }), shotRow('问题丙', 760, { videoMode: 'text', params: {}, dubMode: 'post', dialogue: [{ text: '保温十二小时', language: 'zh' }] }), shotRow('问题丁', 1120, { videoMode: 'text', params: {} })];
 issueRows[1].node.tailFrame = { fromNodeId: issueRows[0].node.id, runId: null, assetId: null };
 const issueProject = await makeProject('问题标记验收', issueRows);
 await insertRunFor(issueProject, issueRows[3].node.id, { assetId: cup.id });
 await harness.pool.query("UPDATE sj_creation_runs SET status='failed',output=NULL,error=$2 WHERE project_id=$1 AND task_id=$3", [issueProject, { code: 'PROVIDER_GENERATION_FAILED', message: '供应商拒绝' }, issueRows[3].node.id]);
 await open('video', issueProject);
 const flagOf = (id, re) => tile(id).getByRole('button', { name: re });
 await expect(flagOf(issueRows[0].shot, /缺少首帧或尾帧/)).toBeVisible();
 await expect(flagOf(issueRows[1].shot, /等待上一镜/)).toBeVisible();
 await expect(flagOf(issueRows[2].shot, /配音未合成/)).toBeVisible();
 await expect(flagOf(issueRows[3].shot, /上次失败/)).toBeVisible();
 await flagOf(issueRows[2].shot, /配音未合成/).click();
 await expect(tile(issueRows[2].shot)).toHaveClass(/on/);
 await expect(section(card(issueRows[2].shot), 'dialogue')).toHaveJSProperty('open', true);
 await expect.poll(() => activeIn('dialogue')).toBe(true);
 await flagOf(issueRows[3].shot, /上次失败/).click();
 await expect(tile(issueRows[3].shot)).toHaveClass(/on/);
 await expect(section(card(issueRows[3].shot), 'preview')).toHaveJSProperty('open', true);
 await expect(card(issueRows[3].shot)).toContainText('上次失败：供应商拒绝');
 await flagOf(issueRows[0].shot, /缺少首帧或尾帧/).click();
 await expect.poll(() => activeIn('materials')).toBe(true);
 // 引用的素材已删除：给分镜接上素材后把素材移入回收站（素材库列表不再返回它），刷新后出现标记。
 const deletedRows = [shotRow('删除镜', 40, { videoMode: 'reference', params: {} })];
 const deletedProject = await makeProject('素材已删除验收', deletedRows);
 const doomed = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '将被删除.png', role: 'creative', projectId: deletedProject });
 await open('video', deletedProject);
 await card(deletedRows[0].shot).getByRole('button', { name: '参考图：选择素材' }).click();
 await page.getByRole('dialog', { name: '选择参考图素材' }).getByRole('button', { name: '选择素材 将被删除.png' }).click();
 await expect.poll(async () => (await detailOf(deletedProject)).project.edges.length).toBe(1);
 await expect(flagOf(deletedRows[0].shot, /引用的素材已删除/)).toHaveCount(0);
 await settled();
 await harness.pool.query('UPDATE sj_creation_records SET trashed_at=now() WHERE id=$1', [doomed.id]);
 await open('video', deletedProject);
 await expect(flagOf(deletedRows[0].shot, /引用的素材已删除/)).toBeVisible();
 await flagOf(deletedRows[0].shot, /引用的素材已删除/).click();
 await expect.poll(() => activeIn('materials')).toBe(true);
 pass('PASS 问题标记：缺素材、等待上一镜、配音未合成、上次失败、素材已删除；点击标记选中该镜并展开 / 聚焦对应分区');

 // 16. 整片连播：按分镜顺序播放各镜当前展示的成功版本（有新鲜配音版时用配音版），未生成的镜显示占位后继续；不产生任何生成请求。
 const dubRoles = [{ id: 'r1', name: '旁白', speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0' }];
 const playRows = [shotRow('连播一', 40, { params: {}, dubMode: 'post', dialogue: [{ text: '保温十二小时', language: 'zh', roleId: 'r1' }] }), shotRow('连播二', 400, { params: { duration: 4 } }), shotRow('连播三', 760, { params: {} })];
 const { dubState } = await import('../server/creation-voice.mjs');
 playRows[0].node.dialogueAudio = { assetId: randomUUID(), hash: dubState(playRows[0].node, dubRoles).hash, durationSec: 3, textWords: 6, lines: 1, cues: [], createdAt: new Date().toISOString() };
 const playProject = await makeProject('连播验收', playRows, { voiceRoles: dubRoles });
 const clips = {};
 for (const [index, name] of ['一', '三'].entries()) clips[name] = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'video/mp4', name: `连播${name}.mp4`, role: 'result', projectId: playProject, taskId: playRows[index * 2].node.id });
 const dubClip = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'video/mp4', name: '连播一配音.mp4', role: 'result', projectId: playProject, taskId: playRows[0].node.id });
 const dubHash = dubState(playRows[0].node, dubRoles).hash;
 await insertRunFor(playProject, playRows[0].node.id, { assetId: clips['一'].id, dub: { status: 'succeeded', assetId: dubClip.id, dialogueHash: dubHash } });
 await insertRunFor(playProject, playRows[2].node.id, { assetId: clips['三'].id });
 const playPage = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
 await playPage.addInitScript(() => {
  // 替身播放：记录每次 play() 的视频地址，随后触发 ended，让连播立即进入下一镜（不依赖真实解码）。
  window.__plays = [];
  HTMLMediaElement.prototype.play = function () { window.__plays.push(this.currentSrc || this.src); setTimeout(() => this.dispatchEvent(new Event('ended')), 40); return Promise.resolve(); };
 });
 const callsBefore = harness.calls.length;
 await playPage.goto(`${harness.origin}?projectId=${playProject}&view=video`);
 await playPage.waitForSelector('.vs-tile');
 await playPage.getByRole('button', { name: '连播预览', exact: true }).click();
 const player = playPage.getByRole('dialog', { name: '整片连播预览' });
 await expect(player).toBeVisible();
 await expect(player.locator('.vs-player-list button')).toHaveCount(3);
 await expect.poll(() => playPage.evaluate(() => window.__plays.length), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
 const plays = await playPage.evaluate(() => window.__plays.map(src => src.replace(/^.*\/assets\//, '').replace(/\/file.*$/, '')));
 assert.deepEqual(plays, [dubClip.id, clips['三'].id], '第一镜用新鲜配音版，第二镜（未生成）显示占位后跳过，第三镜用原视频');
 await expect(player).toContainText('播放结束', { timeout: 15000 });
 assert.ok(harness.calls.slice(callsBefore).every(call => !call.startsWith('POST /api/creation/projects/' + playProject + '/start') && !call.includes('/voice/')), '连播不发出生成或配音请求');
 // 占位镜头：展示占位与剩余秒数。
 await player.getByRole('button', { name: /跳到第 2 镜/ }).click();
 await expect(player.getByRole('status')).toContainText('第 2 镜还没有生成');
 await expect(player.getByRole('status')).toContainText('占位 4 秒');
 await player.getByRole('button', { name: '关闭', exact: true }).last().click();
 await playPage.close();
 pass('PASS 连播预览：按顺序播放各镜展示版本（新鲜配音版优先），未生成镜显示占位，不产生生成请求');

 // 17. 手机端 375px：时间线在自己的容器里横向滑动，编辑区纵向排列、分区可折叠，页面无横向溢出；抽屉与素材弹层不超出屏幕。
 const narrow = await browser.newPage({ viewport: { width: 375, height: 812 } });
 const narrowErrors = [];
 narrow.on('pageerror', e => narrowErrors.push(e.message));
 await narrow.goto(`${harness.origin}?projectId=${timelineId}&view=video`);
 await narrow.waitForSelector('.vs-tile');
 const fits = () => narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
 assert.ok(await fits(), '375px 页面不应横向溢出');
 const track = await narrow.locator('.vs-track').evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
 assert.ok(track.scroll > track.client && /auto|scroll/.test(track.overflowX), '时间线在自己的容器里横向滚动');
 const stacked = await narrow.locator('.vs-editor').evaluate(el => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
 assert.equal(stacked, 1, '单镜编辑区纵向排列');
 const prompt = narrow.locator('#vs-sec-prompt');
 await expect(prompt.getByRole('textbox', { name: '视频提示词' })).toBeVisible();
 await prompt.locator(':scope > summary').click();
 await expect(prompt.getByRole('textbox', { name: '视频提示词' })).toBeHidden();
 await prompt.locator(':scope > summary').click();
 await expect(prompt.getByRole('textbox', { name: '视频提示词' })).toBeVisible();
 await narrow.getByRole('button', { name: '脚本', exact: true }).click();
 const drawerBox = await narrow.getByRole('dialog', { name: '脚本' }).boundingBox();
 assert.ok(drawerBox.x >= 0 && drawerBox.x + drawerBox.width <= 376, '抽屉不超出屏幕');
 assert.ok(await fits(), '375px 抽屉打开后页面不应横向溢出');
 await narrow.getByRole('button', { name: '关闭脚本' }).click();
 await narrow.goto(`${harness.origin}?projectId=${materialId}&view=video`);
 await narrow.waitForSelector('.vs-tile');
 await narrow.getByRole('button', { name: '参考图：选择素材' }).click();
 const narrowPicker = await narrow.getByRole('dialog', { name: '选择参考图素材' }).boundingBox();
 assert.ok(narrowPicker.x >= 0 && narrowPicker.x + narrowPicker.width <= 376, '素材弹层不超出屏幕');
 assert.ok(await fits(), '375px 素材弹层打开后页面不应横向溢出');
 assert.deepEqual(narrowErrors, []);
 await narrow.close();
 pass('PASS 375px：时间线横向滑动、编辑区纵向排列且分区可折叠、抽屉与素材弹层不超出屏幕、页面无横向溢出');

 assert.deepEqual(errors, []);
 console.log('creation-video-studio-browser passed: ' + notes.length + ' groups; no paid requests\n' + notes.join('\n'));
} finally { await browser.close(); await harness.stop(); }
