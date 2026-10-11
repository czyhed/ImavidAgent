import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';
import { inspectImage } from './uploads.mjs';
import { MEDIA_BYTE_LIMITS, MAX_REQUEST_BYTES } from '../shared/creation-video-parameters.mjs';

// 视频参考素材预处理（参照 H3 的平台预处理规格，提前在本地完成，避免 Data URL 过大）：
// 图片短边超过 1080 等比缩小；视频转 H.264、24fps、短边最多 720、AAC 保留音轨；音频原样。
const IMAGE_SHORT_EDGE = 1080, VIDEO_SHORT_EDGE = 720;
const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };

const runCommand = (command, args, { timeoutMs = 10 * 60 * 1000, spawnFn = spawn } = {}) => new Promise((resolve, reject) => {
 const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
 let stderr = '';
 const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new AppError('MEDIA_PREP_TIMEOUT', '素材预处理超时，请缩短素材后重试。', 503)); }, timeoutMs);
 child.stdout?.on('data', () => {});
 child.stderr?.on('data', data => { if (stderr.length < 64 * 1024) stderr += data; });
 child.on('error', error => { clearTimeout(timer); reject(error); });
 child.on('close', code => {
  clearTimeout(timer);
  if (code === 0) resolve();
  else reject(new AppError('MEDIA_PREP_FAILED', `素材预处理失败（ffmpeg 退出码 ${code}）：${stderr.slice(-300) || '无错误输出'}`, 503));
 });
});

// 纯函数：生成 ffmpeg 参数，便于测试。
export function buildImagePrepArgs(input, output, { width, height }) {
 const scale = width <= height ? `scale=${IMAGE_SHORT_EDGE}:-2` : `scale=-2:${IMAGE_SHORT_EDGE}`;
 return ['-i', input, '-vf', scale, '-frames:v', '1', '-y', output];
}
export function buildVideoPrepArgs(input, output) {
 // 短边限制到 720 且不放大；偶数边长满足 H.264 要求。
 const filter = `scale='if(gte(iw,ih),-2,min(${VIDEO_SHORT_EDGE},iw))':'if(gte(iw,ih),min(${VIDEO_SHORT_EDGE},ih),-2)',fps=24,format=yuv420p`;
 return ['-i', input, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', output];
}

// 默认 runner：读字节 → 临时目录 → ffmpeg → 返回字节。spawnFn 可注入，测试不依赖真实 ffmpeg。
export function createMediaPrepRunner({ ffmpegCommand = 'ffmpeg', spawnFn = spawn } = {}) {
 return async function runPrep({ kind, bytes, mime, size }) {
  const directory = await mkdtemp(join(tmpdir(), 'sj-prep-'));
  try {
   const input = join(directory, 'input'), ext = kind === 'video' ? 'mp4' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
   const output = join(directory, 'output.' + ext);
   await writeFile(input, bytes);
   const args = kind === 'video' ? buildVideoPrepArgs(input, output) : buildImagePrepArgs(input, output, size);
   try { await runCommand(ffmpegCommand, args, { spawnFn }); }
   catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('FFMPEG_UNAVAILABLE', '服务器缺少 ffmpeg，无法预处理视频素材；请联系管理员安装。', 503);
   }
   const result = await readFile(output);
   if (!result.length) throw new AppError('MEDIA_PREP_FAILED', '素材预处理结果为空。', 503);
   return { bytes: result, mime: kind === 'video' ? 'video/mp4' : mime };
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
 };
}

// 预处理入口：runner 可注入。item = { kind, bytes, mime, name }。
export function createMediaPrep({ runner = createMediaPrepRunner() } = {}) {
 return {
  async prepare(item) {
   const bytes = Buffer.from(item.bytes);
   if (item.kind === 'audio') return { ...item, bytes };
   if (item.kind === 'image') {
    let size;
    try { const info = inspectImage(bytes); size = { width: info.width, height: info.height }; } catch { return { ...item, bytes }; }
    // 无法读取尺寸（损坏图片）时原样放行，由执行前校验给出明确错误。
    if (!size.width || !size.height || Math.min(size.width, size.height) <= IMAGE_SHORT_EDGE) return { ...item, bytes };
    const out = await runner({ kind: 'image', bytes, mime: item.mime, size });
    return { ...item, bytes: Buffer.from(out.bytes), mime: out.mime || item.mime };
   }
   const out = await runner({ kind: 'video', bytes, mime: item.mime });
   return { ...item, bytes: Buffer.from(out.bytes), mime: out.mime || 'video/mp4' };
  },
 };
}

// 单个体积与 Data URL 总体积检查；超限时指出具体素材名称。
export function checkMediaLimits(items) {
 let total = 0, largest = null;
 for (const item of items) {
  const limit = MEDIA_BYTE_LIMITS[item.kind];
  const size = Buffer.byteLength(item.bytes || '');
  if (limit && size > limit) throw new AppError('MEDIA_TOO_LARGE', `${KIND_LABEL[item.kind] || '素材'}「${item.name || '未命名'}」超过 ${limit / 1024 / 1024} MiB 单个文件上限，请更换或压缩后重试。`, 422);
  const encoded = Math.ceil(size / 3) * 4 + 40;
  total += encoded;
  if (!largest || size > largest.size) largest = { size, name: item.name };
 }
 if (total > MAX_REQUEST_BYTES) throw new AppError('MEDIA_TOO_LARGE', `素材合计超过 72 MiB 请求体上限，请减少素材或压缩后重试（体积最大的是「${largest?.name || '未命名'}」）。`, 422);
}
