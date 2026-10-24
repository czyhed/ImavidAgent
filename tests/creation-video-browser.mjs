// 画布视频节点界面：方式与端口、素材标签卡片、台词与配音、参数与积分、执行预览、输入法与 375px 布局。
// 全部使用隔离测试库与本地生成边界，不点击「开始」，不调用付费接口。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCanvasHarness, typeChinese } from './creation-canvas-qa-harness.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=', 'base64');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
const node = (id, kind, title, x, y, extra = {}) => ({ id, kind, title, prompt: '', params: {}, subject: 'concept', position: { x, y }, sourceAssetId: null, sourceRunId: null, ...extra });
const body = {
 name: '视频节点验收', productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 },
 tasks: [
  node('i1', 'image', '人物图', 30, 30), node('i2', 'image', '产品图', 30, 420),
  node('a1', 'audio', '配音', 360, 30), node('f1', 'footage', '动作', 360, 420),
  node('v', 'video', '镜头一', 720, 30, { videoMode: 'text', params: { duration: 5, resolution: '480P' } }),
 ],
 edges: [],
};
const bigDir = mkdtempSync(join(tmpdir(), 'sj-video-'));
const bigVideo = join(bigDir, 'big.mp4');
writeFileSync(bigVideo, Buffer.alloc(51 * 1024 * 1024));
const harness = await startCanvasHarness({ projectBody: body });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const notes = [];
const pass = text => notes.push(text);
try {
 const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
 const serverTask = async id => (await harness.projects.detail('qa', harness.projectId)).project.tasks.find(t => t.id === id);
 const open = async () => { await page.goto(`${harness.origin}?projectId=${harness.projectId}`); await page.waitForSelector('.v3-node.kind-video', { timeout: 20000 }); };
 const settled = async () => { await page.waitForTimeout(1500); await expect(page.locator('.v3-saved.pending')).toHaveCount(0); };
 await open();
 const video = page.locator('.v3-node.kind-video');
 const optionDisabled = locator => locator.evaluate(el => el.disabled);
 const handles = () => video.locator('.react-flow__handle.target').evaluateAll(list => list.map(h => h.dataset.handleid));

 // 1. 三种方式显示不同端口；新节点默认文字方式。
 await expect(video.getByRole('radio', { name: '文字' })).toHaveAttribute('aria-checked', 'true');
 await expect.poll(handles).toEqual(['prompt']);
 assert.equal(await optionDisabled(video.locator('option[value="adaptive"]')), true, '没有图片素材时「跟随首帧」不可选');
 await video.getByRole('radio', { name: '首尾帧' }).click();
 await expect.poll(handles).toEqual(['prompt', 'first', 'last']);
 await video.getByRole('radio', { name: '全能参考' }).click();
 await expect.poll(handles).toEqual(['prompt', 'refImage', 'refVideo', 'refAudio']);
 await expect(video.getByLabel('参考素材数量')).toHaveText('参考素材 0 / 12');
 await expect.poll(async () => (await serverTask('v')).videoMode).toBe('reference');
 pass('PASS 文字 / 首尾帧 / 全能参考 切换端口，方式写入 videoMode');

 // 2. 音频输入、视频输入节点：校验类型与大小，音频可试听，视频可预览。
 const audioNode = page.locator('.v3-node.kind-audio'), footageNode = page.locator('.v3-node.kind-footage');
 await audioNode.getByLabel('上传音频').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
 await expect(audioNode.getByRole('alert')).toContainText('音频仅支持 mp3');
 await audioNode.getByLabel('上传音频').setInputFiles({ name: 'big.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(16 * 1024 * 1024) });
 await expect(audioNode.getByRole('alert')).toContainText('不能超过 15 MiB');
 await footageNode.getByLabel('上传视频').setInputFiles(bigVideo);
 await expect(footageNode.getByRole('alert')).toContainText('不能超过 50 MiB');
 assert.equal(harness.uploads.length, 0, '校验失败的文件不能上传');
 await audioNode.getByLabel('上传音频').setInputFiles({ name: '配音.mp3', mimeType: 'audio/mpeg', buffer: MP3 });
 await expect(audioNode.locator('audio[aria-label="试听音频"]')).toHaveAttribute('controls', '');
 await footageNode.getByLabel('上传视频').setInputFiles({ name: '动作.mp4', mimeType: 'video/mp4', buffer: MP4 });
 await expect(footageNode.locator('video[aria-label="预览视频"]')).toBeVisible();
 await expect.poll(async () => (await serverTask('a1')).sourceAssetId).toBeTruthy();
 await expect.poll(async () => (await serverTask('f1')).sourceAssetId).toBeTruthy();
 assert.deepEqual(harness.uploads.map(u => u.query.mime), ['audio/mpeg', 'video/mp4']);
 pass('PASS 音频 / 视频输入节点校验类型与大小，上传后可试听 / 预览');

 // 3. 通过服务端接入两张参考图和一个音频，刷新后显示 Picture 1 / Picture 2 / Audio 1。
 await settled();
 const img1 = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '人物.png', role: 'creative' });
 const img2 = await harness.boundary.media.put('qa', { bytes: PNG, mime: 'image/png', name: '产品.png', role: 'creative' });
 const wire = async (change, edges) => {
  const detail = await harness.projects.detail('qa', harness.projectId);
  const tasks = change(detail.project.tasks);
  await harness.projects.update('qa', harness.projectId, { revision: detail.project.revision, tasks, edges: edges ?? detail.project.edges });
 };
 const link = (source, handle, port) => ({ id: `${source}-${port}`, source, sourceHandle: handle, target: 'v', targetHandle: port });
 await wire(tasks => tasks.map(t => t.id === 'i1' ? { ...t, sourceAssetId: img1.id } : t.id === 'i2' ? { ...t, sourceAssetId: img2.id } : t), [link('i1', 'image', 'refImage'), link('i2', 'image', 'refImage'), link('a1', 'audio', 'refAudio')]);
 await open();
 const cards = video.getByRole('list', { name: '已接入素材' }).locator('.vn-card');
 await expect(cards).toHaveCount(3);
 await expect(cards.nth(0)).toContainText('Picture 1'); await expect(cards.nth(0)).toContainText('人物图');
 await expect(cards.nth(1)).toContainText('Picture 2'); await expect(cards.nth(1)).toContainText('产品图');
 await expect(cards.nth(2)).toContainText('Audio 1'); await expect(cards.nth(2)).toContainText('配音');
 await expect(video.locator('.vn-card img')).toHaveCount(2);
 await expect(video.getByLabel('参考素材数量')).toHaveText('参考素材 3 / 12');
 assert.equal(await optionDisabled(video.locator('option[value="adaptive"]')), false, '有图片素材后「跟随首帧」可选');
 pass('PASS 两张参考图和一个音频显示 Picture 1 / Picture 2 / Audio 1，参考素材 3 / 12');

 // 4. 当前方式不使用的连线：保留并提示，端口变暗。
 await video.getByRole('radio', { name: '首尾帧' }).click();
 await expect(video.locator('.vn-unused')).toContainText('当前方式不使用 3 条连线，可移除。');
 await expect.poll(handles).toEqual(['prompt', 'first', 'last', 'refImage', 'refAudio']);
 await expect(video.locator('.react-flow__handle.v3-port.unused')).toHaveCount(2);
 await video.getByRole('radio', { name: '全能参考' }).click();
 await expect(video.locator('.vn-unused')).toHaveCount(0);
 await expect(cards).toHaveCount(3);
 pass('PASS 当前方式不使用的连线保留、提示并变暗');

 // 5. 提示词：输入法不出现拼音；点击卡片在光标处插入标签；标签预览换算。
 const prompt = video.getByRole('textbox', { name: '提示词', exact: true });
 await prompt.fill(''); await page.waitForTimeout(1200);
 await typeChinese(page, prompt, [{ pinyin: 'renwu', text: '人物' }, { pinyin: 'waiguan', text: '外观' }], { pauseMs: 900 });
 await page.waitForTimeout(900);
 assert.equal(await prompt.inputValue(), '人物外观', '提示词输入框不应出现拼音');
 await video.getByRole('button', { name: '插入 Picture 1 标签' }).click();
 await expect(prompt).toHaveValue('人物外观{{ref:i1}}');
 await video.getByRole('button', { name: '插入 Picture 2 标签' }).click();
 await expect(prompt).toHaveValue('人物外观{{ref:i1}}{{ref:i2}}');
 await video.getByRole('button', { name: '插入 Audio 1 标签' }).click();
 await expect(prompt).toHaveValue('人物外观{{ref:i1}}{{ref:i2}}{{ref:a1}}');
 await prompt.evaluate(el => { el.focus(); el.setSelectionRange(2, 2); });
 await video.getByRole('button', { name: '插入 Picture 2 标签' }).click();
 await expect(prompt).toHaveValue('人物{{ref:i2}}外观{{ref:i1}}{{ref:i2}}{{ref:a1}}');
 const tagPreview = video.getByLabel('标签预览');
 await expect(tagPreview).toContainText('人物');
 await expect(tagPreview.locator('.vn-tag.ok')).toHaveText(['Picture 2', 'Picture 1', 'Picture 2', 'Audio 1']);
 await prompt.fill('人物外观{{ref:i1}}{{ref:i2}}{{ref:a1}}');
 await settled();
 assert.equal((await serverTask('v')).prompt, '人物外观{{ref:i1}}{{ref:i2}}{{ref:a1}}');
 pass('PASS 输入法无拼音；点击卡片在光标处插入标签；标签预览换算为 Picture / Audio 编号');

 // 6. 台词行、语言切换、输入法；配音方式；后期配音禁用。
 await video.getByRole('button', { name: '＋ 添加台词' }).click();
 const line = video.getByRole('textbox', { name: '台词 1', exact: true });
 await typeChinese(page, line, [{ pinyin: 'zhekuan', text: '这款' }, { pinyin: 'jiemian', text: '洁面' }], { pauseMs: 900 });
 await page.waitForTimeout(900);
 assert.equal(await line.inputValue(), '这款洁面', '台词输入框不应出现拼音');
 await video.getByLabel('台词 1 语言').selectOption('en');
 await video.getByRole('button', { name: '＋ 添加台词' }).click();
 await expect(video.getByRole('textbox', { name: '台词 2', exact: true })).toBeVisible();
 await expect.poll(async () => (await serverTask('v')).dialogue).toEqual([{ text: '这款洁面', language: 'en' }, { text: '', language: 'zh' }]);
 await video.getByLabel('删除台词 2').click();
 await expect(video.getByRole('textbox', { name: '台词 2', exact: true })).toHaveCount(0);
 assert.equal(await optionDisabled(video.locator('select[aria-label="配音方式"] option[value="post"]')), true, '后期配音应禁用');
 await expect(video.locator('.vn-dialogue')).toContainText('先在模型中心配置火山引擎语音渠道');
 await video.getByLabel('配音方式').selectOption('lipsync');
 await expect.poll(async () => (await serverTask('v')).dubMode).toBe('lipsync');
 await video.getByLabel('台词 1 语言').selectOption('zh');
 await line.fill('这款洁面乳温和清洁，每天早晚各用一次，让肌肤保持清爽自然，水润不紧绷');
 await expect(video.locator('.vn-warn')).toContainText(/台词约需 \d+ 秒，超过分镜时长 5 秒/);
 await line.fill('这款洁面');
 await expect(video.locator('.vn-warn')).toHaveCount(0);
 pass('PASS 台词行添加 / 删除 / 语言切换，输入法无拼音，后期配音禁用并提示，超时长给出提醒');

 // 7. 参数、积分预估、开关。
 const points = video.getByLabel('积分预估');
 await expect(points).toContainText('预估 25 积分');
 await video.getByLabel('分辨率', { exact: true }).selectOption('1080P');
 await expect(points).toContainText('预估 95 积分');
 await video.getByLabel('时长（秒）', { exact: true }).fill('10');
 await expect(points).toContainText('预估 190 积分');
 await video.getByLabel('去除音轨').click(); await expect(video.getByLabel('去除音轨')).toBeChecked();
 await video.getByLabel('AIGC 水印').click(); await expect(video.getByLabel('AIGC 水印')).toBeChecked();
 await expect.poll(async () => { const p = (await serverTask('v')).params; return [p.duration, p.resolution, p.mute_audio, p.aigc_watermark]; }).toEqual([10, '1080P', true, true]);
 pass('PASS 预估积分随分辨率与时长变化，去除音轨 / AIGC 水印写入参数');

 // 8. 高级设置：Skill 接口失败不影响其他控件；成功后选择 Skill 自动打开提示词优化。
 await video.getByText('高级参数与模板', { exact: true }).click();
 await expect(video.getByLabel('Skill', { exact: true })).toBeDisabled();
 await expect(video.getByLabel('Skill', { exact: true }).locator('option:checked')).toContainText('Skill 列表加载失败');
 await video.getByLabel('提示词优化').click(); await expect(video.getByLabel('提示词优化')).toBeChecked();
 await video.getByLabel('时长（秒）', { exact: true }).fill('8');
 await expect.poll(async () => { const p = (await serverTask('v')).params; return [p.use_context_ir, p.duration]; }).toEqual([true, 8]);
 await video.getByLabel('提示词优化').click(); await expect(video.getByLabel('提示词优化')).not.toBeChecked();
 await settled();
 await page.route('**/api/model-hub/video/skills*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skills: [{ id: 'official-a', name: '电影叙事', description: '增强连续性', official: true }] }) }));
 await open();
 await video.getByText('高级参数与模板', { exact: true }).click();
 await expect(video.getByLabel('Skill', { exact: true })).toBeEnabled();
 await video.getByLabel('Skill', { exact: true }).selectOption('official-a');
 await expect.poll(async () => { const p = (await serverTask('v')).params; return [p.skill_id, p.use_context_ir]; }).toEqual(['official-a', true]);
 await expect(video.getByLabel('提示词优化')).toBeChecked();
 await video.getByLabel('提示词优化').click(); await expect(video.getByLabel('提示词优化')).not.toBeChecked();
 await expect.poll(async () => (await serverTask('v')).params.skill_id).toBeUndefined();
 await page.unroute('**/api/model-hub/video/skills*');
 pass('PASS Skill 接口失败只禁用下拉并显示原因；成功后选择 Skill 自动打开提示词优化');

 // 9. 删除来源节点后，引用它的标签标红并可删除。
 await settled();
 await wire(tasks => tasks.filter(t => t.id !== 'i2'), (await harness.projects.detail('qa', harness.projectId)).project.edges.filter(e => e.source !== 'i2'));
 await open();
 await expect(video.locator('.vn-tag.removed')).toHaveCount(1);
 await expect(video.locator('.vn-tag.ok')).toHaveText(['Picture 1', 'Audio 1']);
 await video.getByRole('button', { name: '删除标签 已移除的素材' }).click();
 await expect(video.locator('.vn-tag.removed')).toHaveCount(0);
 await expect.poll(async () => (await serverTask('v')).prompt).toBe('人物外观{{ref:i1}}{{ref:a1}}');
 pass('PASS 删除来源节点后标签标红，点击删除移除失效标签');

 // 10. 执行预览：积分、余额与开始按钮；不点击开始。
 await settled();
 const preview = page.getByRole('dialog', { name: '执行范围预览' });
 // 口型同步 / 后期配音现在要求先合成台词配音，这里用「不配音」验证积分与台词时长提醒。
 await video.getByLabel('配音方式').selectOption('none');
 await video.getByRole('textbox', { name: '台词 1', exact: true }).fill('这款洁面乳温和清洁，每天早晚各用一次，让肌肤保持清爽自然，水润不紧绷');
 await settled();
 const hub = harness.boundary.hub;
 hub.videoBalance = async () => ({ available: 10, reserved: 0, total: 10 });
 await video.getByRole('button', { name: '预览运行', exact: true }).click();
 await expect(preview).toBeVisible();
 await expect(preview).toContainText('预估合计'); await expect(preview).toContainText('152 积分');
 await expect(preview).toContainText('可用积分'); await expect(preview).toContainText('10 积分');
 await expect(preview.getByRole('alert')).toContainText('积分不足');
 await expect(preview).toContainText(/台词约需/);
 await expect(preview.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
 await preview.getByRole('button', { name: '关闭' }).click();
 hub.videoBalance = async () => { throw new Error('offline'); };
 await video.getByRole('button', { name: '预览运行', exact: true }).click();
 await expect(preview).toContainText('余额未知');
 await expect(preview.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
 await preview.getByRole('button', { name: '关闭' }).click();
 hub.videoBalance = async () => ({ available: 1000, reserved: 0, total: 1000 });
 await video.getByRole('button', { name: '预览运行', exact: true }).click();
 await expect(preview).toContainText('1000 积分');
 await expect(preview.getByRole('alert')).toHaveCount(0);
 await expect(preview.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
 await preview.getByRole('button', { name: '关闭' }).click();
 assert.ok(!harness.calls.some(c => c.includes('/start')), '预览测试不应开始生成');
 pass('PASS 预览显示每条与合计积分、可用积分；余额不足禁用开始，余额未知放行');

 // 11. 调色板新增节点：音频输入 / 视频输入 / 视频（默认文字方式）。
 await page.getByRole('button', { name: '＋ 添加节点' }).click();
 const palette = page.locator('.v3-palette-list');
 await expect(palette.getByRole('button', { name: '音频输入', exact: true })).toBeVisible();
 await expect(palette.getByRole('button', { name: '视频输入', exact: true })).toBeVisible();
 await palette.getByRole('button', { name: '视频', exact: true }).click();
 await expect.poll(async () => (await harness.projects.detail('qa', harness.projectId)).project.tasks.filter(t => t.kind === 'video').map(t => t.videoMode).sort()).toEqual(['reference', 'text']);
 pass('PASS 调色板含音频输入 / 视频输入，新建视频节点默认文字方式');

 // 12. 375px 无横向溢出。
 await settled();
 await page.setViewportSize({ width: 375, height: 812 });
 await page.waitForTimeout(400);
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth), '375px 不应横向溢出');
 pass('PASS 375px 无横向溢出');

 assert.deepEqual(errors, []);
 assert.ok(!harness.calls.some(c => c.includes('/start')));
 console.log('creation-video-browser passed: ' + notes.length + ' groups; no paid requests\n' + notes.join('\n'));
} finally { await browser.close(); await harness.stop(); rmSync(bigDir, { recursive: true, force: true }); }
