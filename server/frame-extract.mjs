import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';
import { run } from './video-compile.mjs';

// 上一镜尾帧：用 ffmpeg 截取视频最后一帧并保存为 PNG。不调用模型，不产生供应商费用。
// 先定位到结尾前 1 秒，再持续解码覆盖输出，文件里留下的就是最后一帧。

// 纯函数：生成 ffmpeg 参数，便于测试。
export function buildTailFrameArgs(input, output) {
 return ['-sseof', '-1', '-i', input, '-an', '-update', '1', '-f', 'image2', '-vcodec', 'png', '-y', output];
}

// 默认 runner：字节 → 临时目录 → ffmpeg → PNG 字节。spawnFn 可注入，测试不依赖真实 ffmpeg。
export function createFrameExtractRunner({ ffmpegCommand = 'ffmpeg', spawnFn = spawn } = {}) {
 return async function extractLastFrame({ bytes }) {
  const directory = await mkdtemp(join(tmpdir(), 'sj-frame-'));
  try {
   const input = join(directory, 'input.mp4'), output = join(directory, 'tail.png');
   await writeFile(input, bytes);
   try { await run(ffmpegCommand, buildTailFrameArgs(input, output), { timeoutMs: 2 * 60 * 1000, spawnFn }); }
   catch (error) {
    if (error instanceof AppError) throw new AppError('FRAME_EXTRACT_FAILED', '截取上一镜尾帧失败，请稍后重试。', 503);
    throw new AppError('FFMPEG_UNAVAILABLE', '服务器缺少 ffmpeg，无法截取上一镜尾帧；请联系管理员安装。', 503);
   }
   const png = await readFile(output).catch(() => Buffer.alloc(0));
   if (!png.length) throw new AppError('FRAME_EXTRACT_FAILED', '截取上一镜尾帧失败：没有得到画面。', 503);
   return { bytes: png, mime: 'image/png' };
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
 };
}

// 入口：runner 可注入。返回 { bytes, mime }。
export function createFrameExtractor({ runner = createFrameExtractRunner() } = {}) {
 return {
  async extract(input) {
   if (!input?.bytes?.length) throw new AppError('FRAME_EXTRACT_FAILED', '上一镜的视频文件为空，无法截取尾帧。', 422);
   const out = await runner({ bytes: Buffer.from(input.bytes), mime: input.mime });
   return { bytes: Buffer.from(out.bytes), mime: out.mime || 'image/png' };
  },
 };
}
