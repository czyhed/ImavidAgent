// 回归：画布内中文输入法组字时，拼音不能被当成正文写入（含停顿超过自动保存间隔）。
// 全部使用隔离测试库与本地生成边界，不连接共享数据库、不产生付费任务。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startCanvasHarness, typeChinese } from './creation-canvas-qa-harness.mjs';

const body = {
 name: '输入法回归', productSnapshot: null, viewport: { x: 0, y: 0, zoom: 1 },
 tasks: [
  { id: 'p1', kind: 'prompt', title: '提示词', prompt: '', params: {}, subject: 'concept', position: { x: 40, y: 60 }, sourceAssetId: null, sourceRunId: null },
  { id: 'g1', kind: 'generate', title: '主图', prompt: '', params: { size: '1024x1024' }, subject: 'concept', position: { x: 420, y: 60 }, sourceAssetId: null, sourceRunId: null },
 ],
 edges: [{ id: 'e1', source: 'p1', sourceHandle: 'text', target: 'g1', targetHandle: 'prompt' }],
};
const harness = await startCanvasHarness({ projectBody: body });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto(`${harness.origin}?projectId=${harness.projectId}`);
 await page.waitForSelector('.v3-node', { timeout: 20000 });
 for (const [label, pauseMs] of [['正常输入', 120], ['停顿超过自动保存', 2600]]) {
  const prompt = page.locator('.v3-node.kind-prompt textarea[aria-label="提示词"]');
  await prompt.fill(''); await page.waitForTimeout(1200);
  await typeChinese(page, prompt, [{ pinyin: 'nanshi', text: '男士' }, { pinyin: 'jiemian', text: '洁面' }], { pauseMs });
  await page.waitForTimeout(2800);
  assert.equal(await prompt.inputValue(), '男士洁面', `${label}：输入框不应出现拼音`);
  const saved = (await harness.projects.detail('qa', harness.projectId)).project.tasks.find(t => t.id === 'p1').prompt;
  assert.equal(saved, '男士洁面', `${label}：保存内容不应出现拼音`);
 }
 const title = page.locator('.v3-node.kind-generate input[aria-label="节点名称"]');
 await title.fill(''); await page.waitForTimeout(1200);
 await typeChinese(page, title, [{ pinyin: 'changjing', text: '场景' }], { pauseMs: 1500 });
 await page.waitForTimeout(2000);
 assert.equal(await title.inputValue(), '场景');
 assert.deepEqual(errors, []);
 if (harness.calls.some(c => c.includes('/start'))) throw new Error('输入回归不应开始生成');
 console.log('creation-ime-browser passed: pinyin never committed for prompt and node name; no paid requests');
} finally { await browser.close(); await harness.stop(); }
