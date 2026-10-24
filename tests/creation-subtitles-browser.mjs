// 字幕（生视频第 5 步 5b，V-25）：视频节点的字幕条目预览与「本镜显示字幕」开关、工作台成片区域的「烧录字幕」开关与
// 「下载字幕 SRT」按钮、没有字幕时禁用并说明原因、375px 无横向溢出。
// 浏览器 API 由隔离夹具提供；语音与 ffmpeg 全部是假实现（成片编码替身只记录参数），不连接真实接口，不产生付费请求。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startCanvasHarness } from './creation-canvas-qa-harness.mjs';
import { dubState } from '../server/creation-voice.mjs';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
const ids = { a: randomUUID(), b: randomUUID(), sa: randomUUID(), sb: randomUUID(), audio: randomUUID() };
const ROLES = [{ id: 'r1', name: '旁白', speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0' }];
const LINES = [{ text: '这款保温杯保温十二小时', language: 'zh', roleId: 'r1' }, { text: '现在下单立减二十元', language: 'zh', roleId: 'r1' }];
const CUES = [{ start: 0.1, end: 2.3, text: '这款保温杯保温十二小时' }, { start: 2.8, end: 4.6, text: '现在下单立减二十元' }];
const node = (id, title, x, extra = {}) => ({ id, kind: 'video', title, prompt: `${title}的画面`, params: { duration: 5, resolution: '480P', ratio: '9:16' }, subject: 'concept', position: { x, y: 60 }, sourceAssetId: null, sourceRunId: null, videoMode: 'text', dimension: '视频分镜', ...extra });
const dubbed = node(ids.a, '镜头甲', 40, { dialogue: LINES, dubMode: 'post' });
const hash = dubState(dubbed, ROLES).hash;
dubbed.dialogueAudio = { assetId: ids.audio, hash, durationSec: 5.2, textWords: 20, lines: 2, cues: CUES, createdAt: new Date().toISOString() };
const body = {
 name: '字幕验收', productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 }, voiceRoles: ROLES,
 tasks: [dubbed, node(ids.b, '镜头乙', 400)], edges: [],
 storyboard: { script: '脚本', compile: { status: 'idle' }, shots: [{ id: ids.sa, title: '镜头甲', description: '', nodeId: ids.a }, { id: ids.sb, title: '镜头乙', description: '', nodeId: ids.b }] },
};
const harness = await startCanvasHarness({ projectBody: body });
const media = harness.boundary.media;
const clip = await media.put('qa', { bytes: MP4, mime: 'video/mp4', name: '分镜.mp4', role: 'result', projectId: harness.projectId });
for (const taskId of [ids.a, ids.b]) await harness.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES(gen_random_uuid(),'qa',$1,$2,gen_random_uuid(),$3,'succeeded',$4)", [harness.projectId, taskId, { kind: 'video', task: { title: '镜头' } }, { assetId: clip.id }]);
// 没有任何台词的项目：用来检查“没有字幕”的禁用状态。
const bare = await harness.store.create('qa', 'project', { name: '无字幕项目', productId: null, productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 }, voiceRoles: [], tasks: [node(randomUUID(), '镜头丙', 40)], edges: [], storyboard: { script: '', compile: { status: 'idle' }, shots: [] } });
await harness.projects.saveStoryboard('qa', bare.id, { revision: bare.revision, script: '', shots: [{ id: randomUUID(), title: '镜头丙', description: '', nodeId: bare.tasks[0].id }] });
const bareNode = (await harness.projects.detail('qa', bare.id)).project.tasks[0].id;
const bareAsset = await media.put('qa', { bytes: MP4, mime: 'video/mp4', name: '丙.mp4', role: 'result', projectId: bare.id });
await harness.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES(gen_random_uuid(),'qa',$1,$2,gen_random_uuid(),$3,'succeeded',$4)", [bare.id, bareNode, { kind: 'video', task: { title: '镜头丙' } }, { assetId: bareAsset.id }]);

// 成片编码替身：只记录参数并回填 report，不运行 ffmpeg。
const compileCalls = [];
harness.projects.compileBytes = async ({ files, burnSubtitles, report }) => {
 compileCalls.push({ burnSubtitles, cues: files.map(f => f.cues.length) });
 Object.assign(report, { cueCount: 2, burned: burnSubtitles, srt: '1\n00:00:00,100 --> 00:00:02,300\n这款保温杯保温十二小时\n\n2\n00:00:02,800 --> 00:00:04,600\n现在下单立减二十元\n', durations: [5, 5] });
 return MP4;
};

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const notes = [], pass = text => notes.push(text);
try {
 const page = await browser.newPage({ viewport: { width: 1600, height: 2400 }, acceptDownloads: true });
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
 const detail = (projectId = harness.projectId) => harness.projects.detail('qa', projectId);
 const open = async (view, projectId = harness.projectId) => {
  await page.goto(`${harness.origin}?projectId=${projectId}${view === 'video' ? '&view=video' : ''}`);
  if (view === 'video') { await page.waitForSelector('.vs-shot', { timeout: 20000 }); return; }
  await page.locator('.creative-task-item').filter({ hasText: '视频分镜' }).click();
  await page.waitForSelector('.v3-node.kind-video', { timeout: 20000 });
 };
 // 画布自动保存有防抖：点击后等待“已保存”再继续，避免与上一次保存的回写交错。
 const flip = async (box, checked) => { await box.click(); await expect(box).toBeChecked({ checked }); await page.waitForTimeout(1800); };
 const shotCard = id => page.locator(`.vs-shot[data-shot="${id}"]`);
 // 成片区域在顶部「成片」抽屉里；单镜的台词与配音分区默认折叠。
 const openFilm = async (target = page) => { await target.getByRole('button', { name: '成片', exact: true }).click(); await expect(target.getByRole('dialog', { name: '成片' })).toBeVisible(); };
 const openDialogue = async card => { const sec = card.locator('#vs-sec-dialogue'); if (!(await sec.evaluate(el => el.open))) await sec.locator(':scope > summary').click(); };

 // 1. 视频节点（画布）：字幕条目预览显示时间与文本，开关默认开启，关闭后写入节点并划掉条目。
 await open('canvas');
 const canvasNode = page.locator('.v3-node.kind-video').first();
 const subs = canvasNode.getByLabel('分镜字幕');
 await expect(subs).toBeVisible();
 const items = subs.getByRole('list', { name: '字幕条目预览' }).locator('li');
 await expect(items).toHaveCount(2);
 await expect(items.nth(0)).toContainText('00:00.1 – 00:02.3');
 await expect(items.nth(0)).toContainText('这款保温杯保温十二小时');
 await expect(items.nth(1)).toContainText('00:02.8 – 00:04.6');
 const toggle = subs.getByRole('checkbox', { name: '本镜显示字幕' });
 await expect(toggle).toBeChecked();
 await flip(toggle, false);
 await expect.poll(async () => (await detail()).project.tasks.find(t => t.id === ids.a).subtitles).toBe(false);
 await expect(items.nth(0)).toHaveClass(/off/);
 await expect.poll(async () => (await detail()).dubStates[ids.a].subtitles.active).toBe(false);
 await flip(toggle, true);
 await expect.poll(async () => (await detail()).project.tasks.find(t => t.id === ids.a).subtitles).toBe(true);
 await expect(items.nth(0)).not.toHaveClass(/off/);
 pass('PASS 视频节点显示字幕条目（时间 + 文本），「本镜显示字幕」开关写入节点并划掉条目');

 // 2. 配音方式为“不配音”时没有字幕面板；切回后恢复。
 await canvasNode.getByLabel('配音方式').selectOption('none');
 await expect(canvasNode.getByLabel('分镜字幕')).toHaveCount(0);
 await canvasNode.getByLabel('配音方式').selectOption('post');
 await expect(canvasNode.getByLabel('分镜字幕')).toBeVisible();
 await page.waitForTimeout(1500);
 pass('PASS 不配音时没有字幕，切回后恢复');

 // 3. 工作台成片区域：有字幕时「烧录字幕」可用、「下载字幕 SRT」可点；下载内容是 UTF-8 SRT 且文件名为中文。
 await open('video');
 await openFilm();
 const filmCard = page.locator('.vs-compile');
 const burn = filmCard.getByRole('checkbox', { name: '烧录字幕' });
 await expect(burn).toBeEnabled();
 await expect(filmCard).toContainText('1 个分镜有字幕');
 const [download] = await Promise.all([page.waitForEvent('download'), filmCard.getByRole('link', { name: '下载字幕 SRT' }).click()]);
 assert.equal(download.suggestedFilename(), '字幕验收-字幕.srt');
 const srt = await readFile(await download.path(), 'utf8');
 assert.match(srt, /^1\n00:00:00,100 --> 00:00:02,300\n这款保温杯保温十二小时\n\n2\n00:00:02,800 --> 00:00:04,600\n现在下单立减二十元\n$/);
 pass('PASS 成片区域可下载字幕 SRT（UTF-8，中文文件名）');

 // 4. 勾选「烧录字幕」后拼接成片：请求带 burnSubtitles，完成后显示字幕已烧录及条数。
 await flip(burn, true);
 await filmCard.getByRole('button', { name: '拼接成片', exact: true }).click();
 await expect(filmCard).toContainText('字幕已烧录到画面，共 2 条', { timeout: 20000 });
 assert.equal(compileCalls.length, 1); assert.equal(compileCalls[0].burnSubtitles, true); assert.deepEqual(compileCalls[0].cues, [2, 0]);
 assert.deepEqual((await detail()).project.storyboard.compile.subtitles, { burned: true, cueCount: 2 });
 await flip(burn, false);
 await filmCard.getByRole('button', { name: '拼接成片', exact: true }).click();
 await expect(filmCard).toContainText('未烧录字幕（共 2 条，可下载 SRT）', { timeout: 20000 });
 assert.equal(compileCalls[1].burnSubtitles, false);
 pass('PASS 烧录开关随成片请求提交，完成后显示烧录结果与条数；不烧录时仍可下载 SRT');

 // 5. 工作台分镜卡片内同样显示字幕条目与开关。
 await openDialogue(shotCard(ids.sa));
 await expect(shotCard(ids.sa).getByLabel('分镜字幕')).toBeVisible();
 await flip(shotCard(ids.sa).getByRole('checkbox', { name: '本镜显示字幕' }), false);
 await expect.poll(async () => (await detail()).dubStates[ids.a].subtitles.active).toBe(false);
 // 唯一有字幕的分镜被关闭后：烧录与下载禁用并说明原因。
 await expect(burn).toBeDisabled();
 await expect(filmCard.getByRole('button', { name: '下载字幕 SRT' })).toBeDisabled();
 await expect(filmCard).toContainText('还没有字幕：需要先为分镜合成台词配音');
 pass('PASS 分镜卡片内同样显示字幕并可开关；没有可用字幕时禁用烧录与下载并说明原因');

 // 6. 没有任何台词的项目：禁用并说明原因。
 await open('video', bare.id);
 await openFilm();
 const bareCard = page.locator('.vs-compile');
 await expect(bareCard.getByRole('checkbox', { name: '烧录字幕' })).toBeDisabled();
 await expect(bareCard.getByRole('button', { name: '下载字幕 SRT' })).toBeDisabled();
 await expect(bareCard).toContainText('还没有字幕：需要先为分镜合成台词配音');
 assert.equal(await bareCard.getByRole('link', { name: '下载字幕 SRT' }).count(), 0, '没有字幕时不提供下载链接');
 pass('PASS 没有字幕时「烧录字幕」与「下载字幕 SRT」禁用，并提示先合成台词配音');

 // 7. 375px 无横向溢出（画布节点与工作台）。
 await page.setViewportSize({ width: 375, height: 812 });
 const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
 await open('video');
 await openFilm();
 await expect(page.locator('.vs-compile').getByRole('checkbox', { name: '烧录字幕' })).toBeVisible();
 assert.ok(await fits(), '375px 工作台不应横向溢出');
 await open('canvas');
 await expect(page.locator('.v3-node.kind-video').first().getByLabel('分镜字幕')).toBeVisible();
 assert.ok(await fits(), '375px 画布不应横向溢出');
 pass('PASS 375px 工作台与画布无横向溢出');

 assert.deepEqual(errors, []);
 for (const n of notes) console.log(n);
 console.log('creation-subtitles-browser passed: voice and ffmpeg faked, no real or paid requests');
} finally { await browser.close(); await harness.stop(); }
