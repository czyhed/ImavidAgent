import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { buildTailFrameArgs, createFrameExtractRunner, createFrameExtractor } from '../server/frame-extract.mjs';

test('buildTailFrameArgs 先定位到结尾再持续覆盖输出，得到最后一帧 PNG', () => {
  const args = buildTailFrameArgs('in.mp4', 'out.png');
  assert.deepEqual(args.slice(0, 4), ['-sseof', '-1', '-i', 'in.mp4']);
  assert.ok(args.includes('-an'));
  assert.ok(args.includes('png'));
  assert.equal(args.at(-1), 'out.png');
  assert.ok(!args.includes('-frames:v'), '不限制帧数，输出文件里留下的是最后一帧');
});

test('默认 runner 通过注入的 spawn 调用 ffmpeg，不依赖真实 ffmpeg', async () => {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    // 假 ffmpeg：把输出路径写成 PNG 字节后正常退出。
    const output = args.at(-1);
    return { stdout: { on() {} }, stderr: { on() {} }, on(event, handler) { if (event === 'close') writeFile(output, Buffer.from('fake-png')).then(() => handler(0)); } };
  };
  const extractor = createFrameExtractor({ runner: createFrameExtractRunner({ spawnFn }) });
  const frame = await extractor.extract({ bytes: Buffer.from('video'), mime: 'video/mp4' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.equal(frame.mime, 'image/png');
  assert.equal(frame.bytes.toString(), 'fake-png');
});

test('ffmpeg 失败或缺失、视频为空时给出中文错误', async () => {
  const failing = (code) => () => ({ stdout: { on() {} }, stderr: { on() {} }, on(event, handler) { if (event === 'close') setImmediate(() => handler(code)); } });
  await assert.rejects(createFrameExtractor({ runner: createFrameExtractRunner({ spawnFn: failing(1) }) }).extract({ bytes: Buffer.from('v') }), { code: 'FRAME_EXTRACT_FAILED' });
  const missing = () => ({ stdout: { on() {} }, stderr: { on() {} }, on(event, handler) { if (event === 'error') setImmediate(() => handler(new Error('ENOENT'))); } });
  await assert.rejects(createFrameExtractor({ runner: createFrameExtractRunner({ spawnFn: missing }) }).extract({ bytes: Buffer.from('v') }), { code: 'FFMPEG_UNAVAILABLE' });
  await assert.rejects(createFrameExtractor({ runner: async () => ({ bytes: Buffer.alloc(0) }) }).extract({ bytes: Buffer.alloc(0) }), { code: 'FRAME_EXTRACT_FAILED' });
});
