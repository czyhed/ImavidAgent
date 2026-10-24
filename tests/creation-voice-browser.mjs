// 火山语音配音界面（5a）：模型中心语音渠道、角色与音色面板（筛选 / 试听 / 缓存）、视频节点合成配音与过期提示、
// 时长对齐、配音方式、原声 / 配音切换、中文输入法、375px。语音服务与 ffmpeg 全部是假实现，浏览器 API 由隔离夹具提供，不连接真实接口。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCanvasHarness, typeChinese } from './creation-canvas-qa-harness.mjs';
import { dubState } from '../server/creation-voice.mjs';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
const NODE = randomUUID();
const body = {
 name: '配音验收', productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 },
 tasks: [{ id: NODE, kind: 'video', title: '镜头一', prompt: '手持保温杯', videoMode: 'text', params: { duration: 5, resolution: '480P' }, subject: 'concept', position: { x: 40, y: 40 }, sourceAssetId: null, sourceRunId: null, dialogue: [{ text: '这款保温杯保温十二小时', language: 'zh' }] }],
 edges: [],
 storyboard: { script: '脚本', compile: { status: 'idle' }, shots: [{ id: randomUUID(), title: '镜头一', description: '', nodeId: NODE }] },
};
const harness = await startCanvasHarness({ projectBody: body });
// 假语音服务：真实音色库与哈希规则，合成 / 试听 / 设计不联网。
const real = harness.projects.voice, fake = { previewCalls: 0, synthCalls: 0, durationSec: 6.4, remaining: 5, cache: new Map() };
harness.projects.voice = {
 list: query => real.list(query), configured: async () => true,
 async preview(workspace, input) {
  const key = real.previewKey({ speaker: input.speaker, resourceId: input.resourceId || 'seed-tts-2.0', text: input.text || '', params: input.params || {} });
  if (fake.cache.has(key)) return { ...fake.cache.get(key), cached: true };
  fake.previewCalls += 1;
  const value = { assetId: randomUUID(), fileUrl: '', cached: false, textWords: 12, text: input.text || '默认' };
  value.fileUrl = `/api/creation/assets/${value.assetId}/file`; fake.cache.set(key, value); return value;
 },
 async design(workspace, input) {
  if (fake.remaining <= 0) throw Object.assign(new Error('这个音色的设计次数已用尽，请更换音色编号后再试。'), { status: 422, code: 'VOICE_DESIGN_EXHAUSTED' });
  fake.remaining -= 1; return { speakerId: input.speakerId, status: 2, usable: true, remaining: fake.remaining, resourceId: 'seed-icl-2.0', demo: { assetId: randomUUID(), fileUrl: `/api/creation/assets/${randomUUID()}/file` } };
 },
 async synthesizeDialogue(workspace, task, roles) {
  const state = dubState(task, roles); if (state.issue) throw Object.assign(new Error(state.issue), { status: 422, code: 'DUB_NOT_READY' });
  fake.synthCalls += 1; return { bytes: Buffer.from('ID3fake'), durationSec: fake.durationSec, textWords: 11, hash: state.hash, lines: state.lines.length };
 },
 mixDub: async () => ({ bytes: MP4, truncated: false, videoSeconds: 5, audioSeconds: fake.durationSec }),
};
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const notes = [], pass = text => notes.push(text);
let configured = false;
try {
 const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
 await page.route('**/api/model-hub', route => route.fulfill({ json: { models: [], defaults: configured ? { voice: { channelId: 'ch_voice', modelId: 'voice' } } : {}, channels: configured ? [{ id: 'ch_voice', name: '火山语音', adapter: 'volcengine-tts', enabled: true, executorConfig: { resourceId: 'seed-tts-2.0' } }] : [] } }));
 const detail = () => harness.projects.detail('qa', harness.projectId);
 const serverNode = async () => (await detail()).project.tasks.find(t => t.id === NODE);
 const open = async view => { await page.goto(`${harness.origin}?projectId=${harness.projectId}${view ? '&view=' + view : ''}`); await page.waitForSelector(view === 'video' ? '.vs-shot' : '.v3-node.kind-video', { timeout: 20000 }); };
 const video = () => page.locator('.v3-node.kind-video');
 const settled = () => page.waitForTimeout(1500);

 // 1. 未配置语音渠道：后期配音禁用并提示去模型中心；没有角色时提示添加。
 await open();
 assert.equal(await video().locator('select[aria-label="配音方式"] option[value="post"]').evaluate(el => el.disabled), true);
 await expect(video().locator('.vn-dialogue')).toContainText('先在模型中心配置火山引擎语音渠道');
 pass('PASS 未配置语音渠道时后期配音禁用并提示');

 // 2. 配置后：后期配音可选；打开角色面板。
 configured = true; await open();
 assert.equal(await video().locator('select[aria-label="配音方式"] option[value="post"]').evaluate(el => el.disabled), false);
 await video().getByLabel('配音方式').selectOption('post');
 await expect.poll(async () => (await serverNode()).dubMode).toBe('post');
 await page.getByRole('button', { name: '角色与音色', exact: true }).first().click();
 const panel = page.getByRole('dialog', { name: '角色与音色' });
 await expect(panel).toBeVisible();
 await panel.getByRole('button', { name: '＋ 添加角色' }).click();
 const name = panel.getByRole('textbox', { name: '角色名称' });
 await name.fill('');
 await typeChinese(page, name, [{ pinyin: 'pangbai', text: '旁白' }], { pauseMs: 700 });
 await page.waitForTimeout(500);
 assert.equal(await name.inputValue(), '旁白', '角色名称不应出现拼音');
 pass('PASS 角色面板可从画布顶部打开，添加角色，角色名称中文输入法无拼音');

 // 3. 音色筛选：性别、场景、语言与中文搜索。
 const count = async () => Number((await panel.locator('p.vn-note[aria-live]').textContent()).match(/共 (\d+) 个/)?.[1] ?? -1);
 const all = await count();
 await panel.getByLabel('音色性别').selectOption('female');
 await expect.poll(count).toBeLessThan(all);
 const female = await count();
 await panel.getByLabel('音色场景').selectOption('客服场景');
 await expect.poll(count).toBeLessThan(female);
 await panel.getByLabel('音色场景').selectOption('');
 await panel.getByLabel('音色性别').selectOption('');
 await panel.getByLabel('音色语言').selectOption('泰语');
 await expect.poll(count).toBeGreaterThan(0);
 await panel.getByLabel('音色语言').selectOption('');
 await typeChinese(page, panel.getByRole('textbox', { name: '搜索音色' }), [{ pinyin: 'shaonian', text: '少年' }], { pauseMs: 700 });
 await expect.poll(count).toBeGreaterThan(0);
 const first = panel.getByRole('list', { name: '系统音色' }).locator('li').first();
 await expect(first).toContainText('少年');
 pass('PASS 系统音色按性别 / 场景 / 语言 / 中文关键字筛选');

 // 4. 试听：首次合成，再次命中缓存提示不再收费；选用后保存。
 await first.getByRole('button', { name: '试听' }).click();
 await expect(first).toContainText('本次消耗 12 个字符');
 await first.getByRole('button', { name: '试听' }).click();
 await expect(first).toContainText('已缓存，未重复收费');
 assert.equal(fake.previewCalls, 1, '重复试听不再调用接口');
 await first.getByRole('button', { name: /选用/ }).click();
 await expect(panel.locator('.vr-current')).toContainText('shaonian');
 await panel.getByRole('button', { name: '保存角色' }).click();
 await expect(panel).toHaveCount(0);
 await expect.poll(async () => (await detail()).project.voiceRoles?.length).toBe(1);
 const role = (await detail()).project.voiceRoles[0];
 assert.equal(role.name, '旁白'); assert.match(role.speaker, /shaonian/);
 pass('PASS 试听首次合成、重复命中缓存；选用音色并保存到项目');

 // 5. 自有音色编号、音色设计（剩余次数、次数用尽提示）。
 await page.getByRole('button', { name: '角色与音色', exact: true }).first().click();
 await panel.getByRole('button', { name: '＋ 添加角色' }).click();
 await panel.getByRole('tab', { name: '设计音色' }).click();
 await panel.getByRole('textbox', { name: '新音色编号' }).fill('S_shop_host_01');
 await panel.getByRole('textbox', { name: '新音色编号' }).blur();
 await panel.getByRole('textbox', { name: '音色描述' }).fill('温柔亲切的年轻女声');
 await panel.getByRole('textbox', { name: '音色描述' }).blur();
 await panel.getByRole('button', { name: '设计音色', exact: true }).click();
 await expect(panel.getByLabel('设计结果')).toContainText('剩余设计次数：4');
 await panel.getByLabel('设计结果').getByRole('button', { name: /设为/ }).click();
 await expect(panel.locator('.vr-current')).toContainText('S_shop_host_01');
 fake.remaining = 0;
 await panel.getByRole('tab', { name: '设计音色' }).click();
 await panel.getByRole('button', { name: '设计音色', exact: true }).click();
 await expect(panel.getByRole('alert').filter({ hasText: '设计次数已用尽' })).toBeVisible();
 await panel.getByRole('tab', { name: '自有音色' }).click();
 await expect(panel.getByRole('textbox', { name: '自有音色编号' })).toBeVisible();
 await panel.getByRole('button', { name: '保存角色' }).click();
 await expect.poll(async () => (await detail()).project.voiceRoles?.length).toBe(2);
 assert.equal((await detail()).project.voiceRoles[1].resourceId, 'seed-icl-2.0');
 pass('PASS 音色设计显示剩余次数，次数用尽给出中文提示，设计音色使用 seed-icl-2.0');

 // 6. 视频节点：台词行选角色 → 合成配音 → 已合成；改台词 → 过期提示；重新合成。
 await open();
 await expect(video().getByLabel('台词 1 角色')).toBeVisible();
 await video().getByLabel('台词 1 角色').selectOption({ label: '旁白' });
 await expect.poll(async () => (await serverNode()).dialogue[0].roleId).toBe(role.id);
 await settled();
 await video().getByRole('button', { name: '合成配音' }).click();
 await expect(video().locator('.vn-dub-badge')).toContainText('已合成');
 await expect(video().locator('.vn-dub-badge')).toContainText('6.4 秒');
 await expect(video().getByLabel('台词配音试听')).toBeVisible();
 assert.equal(fake.synthCalls, 1);
 pass('PASS 台词选角色后合成配音，节点显示时长与试听');

 // 7. 时长对齐：配音 6.4 秒 > 5 秒 → 加长到 8 秒 / 加快语速；两个按钮真实生效。
 await expect(video().locator('.vn-warn').filter({ hasText: '配音约 6.4 秒' })).toBeVisible();
 await video().getByRole('button', { name: '加快语速' }).click();
 await expect.poll(async () => (await detail()).project.voiceRoles[0].speechRate).toBe(15);
 await expect(video().locator('.vn-dub-badge')).toContainText('过期');
 await video().getByRole('button', { name: '重新合成配音' }).click();
 await expect(video().locator('.vn-dub-badge')).toContainText('已合成');
 await video().getByRole('button', { name: '加长到 8 秒' }).click();
 await expect.poll(async () => (await serverNode()).params.duration).toBe(8);
 await expect(video().getByRole('button', { name: /加长到/ })).toHaveCount(0);
 pass('PASS 配音超出视频时长：加快语速改角色并使配音过期，加长到 8 秒写入时长');

 // 8. 改台词（中文输入法）→ 配音已过期。
 const line = video().getByRole('textbox', { name: '台词 1', exact: true });
 await line.fill('');
 await typeChinese(page, line, [{ pinyin: 'xiadan', text: '下单' }, { pinyin: 'lijian', text: '立减' }], { pauseMs: 700 });
 await page.waitForTimeout(500);
 assert.equal(await line.inputValue(), '下单立减', '台词输入框不应出现拼音');
 await expect(video().locator('.vn-dub-badge')).toContainText('过期');
 await expect(video().getByText('配音已过期，请重新合成', { exact: true }).first()).toBeVisible();
 await video().getByRole('button', { name: '重新合成配音' }).click();
 await expect(video().locator('.vn-dub-badge')).toContainText('已合成');
 pass('PASS 改台词后显示「配音已过期，请重新合成」，台词中文输入法无拼音');

 // 9. 配音方式切换：口型同步 / 后期配音文案。
 await video().getByLabel('配音方式').selectOption('lipsync');
 await expect(video().locator('.vn-dialogue')).toContainText('合成语音作为参考音频');
 await video().getByLabel('配音方式').selectOption('post');
 await expect(video().locator('.vn-dialogue')).toContainText('台词不写入提示词');
 await video().getByLabel('配音方式').selectOption('none');
 await expect(video().locator('.vn-dub')).toHaveCount(0);
 await video().getByLabel('配音方式').selectOption('post');
 await settled();
 pass('PASS 配音方式切换：不配音 / 口型同步 / 后期配音');

 // 10. 原声 / 配音切换：成功运行带有与当前配音一致的混音版本。
 const current = await detail(), task = current.project.tasks.find(t => t.id === NODE);
 const original = await harness.boundary.media.put('qa', { bytes: MP4, mime: 'video/mp4', name: '原视频.mp4', role: 'result', projectId: harness.projectId, taskId: NODE });
 const dubbed = await harness.boundary.media.put('qa', { bytes: MP4, mime: 'video/mp4', name: '配音版.mp4', role: 'result', projectId: harness.projectId, taskId: NODE });
 await harness.pool.query("INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,output) VALUES(gen_random_uuid(),'qa',$1,$2,gen_random_uuid(),$3,'succeeded',$4)", [harness.projectId, NODE, { kind: 'video', dubMode: 'post', task }, { assetId: original.id, dub: { status: 'succeeded', assetId: dubbed.id, dialogueHash: dubState(task, current.project.voiceRoles).hash, truncated: true } }]);
 await open();
 const toggle = video().getByRole('group', { name: '视频声音版本' });
 await expect(toggle).toBeVisible();
 await expect(toggle.getByRole('button', { name: '配音' })).toHaveAttribute('aria-pressed', 'true');
 await expect(video().locator('video')).toHaveAttribute('src', new RegExp(dubbed.id));
 await expect(video()).toContainText('已截断到视频长度');
 await toggle.getByRole('button', { name: '原声' }).click();
 await expect(video().locator('video')).toHaveAttribute('src', new RegExp(original.id));
 await open('video');
 const studio = page.locator('.vs-shot').first();
 await expect(studio.getByRole('group', { name: '视频声音版本' })).toBeVisible();
 await expect(studio.locator('video').first()).toHaveAttribute('src', new RegExp(dubbed.id));
 await studio.getByRole('button', { name: '原声' }).click();
 await expect(studio.locator('video').first()).toHaveAttribute('src', new RegExp(original.id));
 await expect(page.getByText('角色与音色').first()).toBeVisible();
 pass('PASS 画布与工作台视频预览可在原声 / 配音之间切换，截断时提示');

 // 11. 配音过期后预览回退原视频（不再显示切换）：改台词后切换消失。
 await open();
 await video().getByRole('textbox', { name: '台词 1', exact: true }).fill('改动后的台词');
 await settled();
 await expect(video().getByRole('group', { name: '视频声音版本' })).toHaveCount(0);
 pass('PASS 台词改动后配音版本不再显示，回退原视频');

 // 12. 375px 无横向溢出（含角色面板）。
 await page.setViewportSize({ width: 375, height: 812 });
 await open();
 const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
 assert.ok(await fits(), '375px 画布不应横向溢出');
 await page.getByRole('button', { name: '角色与音色', exact: true }).first().click();
 await expect(page.getByRole('dialog', { name: '角色与音色' })).toBeVisible();
 assert.ok(await fits(), '375px 角色面板不应横向溢出');
 const dialogBox = await page.getByRole('dialog', { name: '角色与音色' }).boundingBox();
 assert.ok(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 376, '面板不超出屏幕');
 pass('PASS 375px 画布与角色面板无横向溢出');

 assert.deepEqual(errors, []);
 for (const n of notes) console.log(n);
 console.log('creation-voice-browser passed: voice APIs faked, no real or paid requests');
} finally { await browser.close(); await harness.stop(); }
