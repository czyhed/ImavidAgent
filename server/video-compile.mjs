import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';
import { buildFilmCues, buildSrt, buildBurnArgs, SUBTITLE_FONT, MAX_SRT_BYTES } from './subtitles.mjs';

// 成片拼接：把分镜视频按顺序转码拼接为一个 MP4（服务端 ffmpeg，保留每镜音轨，无声镜头补静音）。
// 拼接为派生素材，不调用模型、不产生供应商费用；失败保留原分镜。

export const run = (command, args, { timeoutMs = 10 * 60 * 1000, spawnFn = spawn } = {}) => new Promise((resolve, reject) => {
 const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
 let stdout = '', stderr = '';
 const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new AppError('FFMPEG_TIMEOUT', '视频拼接超时，请减少分镜数量或时长后重试。', 503)); }, timeoutMs);
 child.stdout?.on('data', data => { stdout += data; });
 child.stderr?.on('data', data => { if (stderr.length < 64 * 1024) stderr += data; });
 child.on('error', error => { clearTimeout(timer); reject(error); });
 child.on('close', code => {
  clearTimeout(timer);
  if (code === 0) resolve({ stdout, stderr });
  else reject(new AppError('FFMPEG_FAILED', `视频拼接失败（ffmpeg 退出码 ${code}）：${stderr.slice(-400) || '无错误输出'}`, 503));
 });
});

export async function ffmpegAvailable(command = 'ffmpeg', options = {}) {
 try { await run(command, ['-version'], { timeoutMs: 15 * 1000, ...options }); return true; }
 catch (error) { if (error instanceof AppError) throw error; throw new AppError('FFMPEG_UNAVAILABLE', '服务器缺少 ffmpeg，无法拼接成片；请联系管理员安装。', 503); }
}

// 纯函数：给定每个分镜的探测结果，生成 ffmpeg 参数（便于测试）。
// clips[i]={width,height,fps?,duration?,hasAudio?}；尺寸与帧率取第一个镜头（帧率读不到时 24）。
// 有音轨的镜头统一为 48 kHz 立体声；没有音轨的镜头用 anullsrc 补一段同样时长的静音；镜头之间不加转场。
export const COMPILE_SAMPLE_RATE = 48000;
export const DEFAULT_COMPILE_FPS = 24;
export function buildCompileArgs(clips, output, { crf = 20 } = {}) {
 if (!Array.isArray(clips) || !clips.length) throw new AppError('COMPILE_EMPTY', '没有可拼接的分镜视频。', 422);
 const width = clips[0].width, height = clips[0].height;
 const fps = Number.isFinite(clips[0].fps) && clips[0].fps > 0 ? clips[0].fps : DEFAULT_COMPILE_FPS;
 const chains = [];
 clips.forEach((clip, index) => {
  chains.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`);
  if (clip.hasAudio) chains.push(`[${index}:a]aresample=${COMPILE_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
  else {
   const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : 0;
   if (!duration) throw new AppError('FFMPEG_PROBE_FAILED', '无法读取无声分镜的时长，不能补静音。', 503);
   chains.push(`anullsrc=r=${COMPILE_SAMPLE_RATE}:cl=stereo,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`);
  }
 });
 const inputs = clips.flatMap((_, index) => ['-i', `clip${index}.mp4`]);
 const joined = clips.map((_, index) => `[v${index}][a${index}]`).join('');
 return [
  ...inputs,
  '-filter_complex', `${chains.join(';')};${joined}concat=n=${clips.length}:v=1:a=1[vout][aout]`,
  '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ar', String(COMPILE_SAMPLE_RATE), '-ac', '2', '-movflags', '+faststart', '-y', output,
 ];
}

const parseRate = value => {
 const [numerator, denominator] = String(value || '').split('/').map(Number);
 const rate = denominator ? numerator / denominator : numerator;
 return Number.isFinite(rate) && rate >= 1 && rate <= 120 ? Math.round(rate * 1000) / 1000 : null;
};
const parseSeconds = value => { const seconds = Number(value); return Number.isFinite(seconds) && seconds > 0 ? seconds : null; };

// ffprobe 读取尺寸、帧率、时长与是否有音轨。
export async function probeClip(command, file, options = {}) {
 const { stdout } = await run(command, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration:format=duration', '-of', 'json', file], { timeoutMs: 30 * 1000, ...options });
 const parsed = JSON.parse(stdout || '{}');
 const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
 const video = streams.find(stream => stream.codec_type === 'video' || (!stream.codec_type && stream.width && stream.height));
 if (!video?.width || !video?.height) throw new AppError('FFMPEG_PROBE_FAILED', '无法读取分镜视频尺寸。', 503);
 return {
  width: video.width, height: video.height,
  fps: parseRate(video.r_frame_rate) || parseRate(video.avg_frame_rate),
  duration: parseSeconds(video.duration) || parseSeconds(parsed.format?.duration),
  hasAudio: streams.some(stream => stream.codec_type === 'audio'),
 };
}

// runner 工厂：spawnFn 可注入，测试不依赖真实 ffmpeg。
export function createCompileRunner({ ffmpegCommand = 'ffmpeg', ffprobeCommand = 'ffprobe', spawnFn = spawn } = {}) {
 return async function compileVideos({ files, output }) {
  if (!Array.isArray(files) || !files.length) throw new AppError('COMPILE_EMPTY', '没有可拼接的分镜视频。', 422);
  const clips = [];
  for (const file of files) clips.push(await probeClip(ffprobeCommand, file, { spawnFn }));
  await run(ffmpegCommand, buildCompileArgs(clips, output), { timeoutMs: 15 * 60 * 1000, spawnFn });
  return { width: clips[0].width, height: clips[0].height };
 };
}

// 成片上限与素材库单文件上限（media.put，100 MiB）一致，否则拼好的成片无法保存。
export const MAX_COMPILE_BYTES = 100 * 1024 * 1024;

// 字体检查：烧录中文字幕前确认服务器装了字体，否则 libass 会回退到无中文字形的字体，字幕变成方块。
// fc-list 不存在时跳过检查（交给 ffmpeg 自己的报错）。
export async function fontAvailable(spawnFn = spawn, name = SUBTITLE_FONT) {
 try { const { stdout } = await run('fc-list', [], { timeoutMs: 15 * 1000, spawnFn }); return stdout.toLowerCase().includes(name.toLowerCase()); }
 catch (error) { if (error instanceof AppError) return true; return true; }
}

// 默认执行：files 为每镜一个已选定的视频 {bytes,name?,cues?,fallbackDuration?}；写入临时目录 → ffmpeg 拼接 → 返回 MP4 字节。
// report（可选对象）会被填入 { durations, cueCount, burned, srt }：durations 是 ffprobe 读到的各镜时长，
// srt 是按成片时间轴生成的字幕文本；burnSubtitles 为 true 且有字幕时再烧录一遍，烧录失败整体失败，不返回半成品。
export async function compileShotVideos({ files, ffmpegCommand = 'ffmpeg', ffprobeCommand = 'ffprobe', spawnFn = spawn, maxBytes = MAX_COMPILE_BYTES, burnSubtitles = false, report = {} } = {}) {
 if (!Array.isArray(files) || !files.length) throw new AppError('COMPILE_EMPTY', '没有可拼接的分镜视频。', 422);
 await ffmpegAvailable(ffmpegCommand, { spawnFn });
 const directory = await mkdtemp(join(tmpdir(), 'sj-compile-'));
 try {
  for (const [index, file] of files.entries()) await writeFile(join(directory, `clip${index}.mp4`), file.bytes);
  const output = join(directory, 'compiled.mp4');
  const clips = [];
  for (let index = 0; index < files.length; index++) clips.push(await probeClip(ffprobeCommand, join(directory, `clip${index}.mp4`), { spawnFn }));
  // 输入文件名是相对路径，在临时目录内执行，避免把路径写进滤镜。
  const args = buildCompileArgs(clips, output).map(arg => /^clip\d+\.mp4$/.test(arg) ? join(directory, arg) : arg);
  await run(ffmpegCommand, args, { timeoutMs: 15 * 60 * 1000, spawnFn });
  // 字幕：各镜字幕按实际时长平移到成片时间轴，并记录到 report。
  const filmCues = buildFilmCues(files.map((file, index) => ({ cues: file.cues, duration: clips[index].duration || file.fallbackDuration })));
  const srt = buildSrt(filmCues);
  Object.assign(report, { durations: clips.map(clip => clip.duration || null), cueCount: filmCues.length, burned: false, srt: Buffer.byteLength(srt) <= MAX_SRT_BYTES ? srt : '' });
  let finalFile = output;
  if (burnSubtitles && filmCues.length) {
   try {
    if (!await fontAvailable(spawnFn)) throw new AppError('SUBTITLE_FONT_MISSING', `服务器没有安装字幕字体「${SUBTITLE_FONT}」，无法烧录字幕；请联系管理员，或取消「烧录字幕」后只导出 SRT。`, 503);
    // 固定文件名写入临时目录，路径里没有任何用户输入。
    const subtitleFile = join(directory, 'subtitles.srt'), burned = join(directory, 'burned.mp4');
    await writeFile(subtitleFile, srt, 'utf8');
    await run(ffmpegCommand, buildBurnArgs({ input: output, subtitleFile, output: burned, width: clips[0].width, height: clips[0].height }), { timeoutMs: 15 * 60 * 1000, spawnFn });
    finalFile = burned; report.burned = true;
   } catch (error) {
    if (error instanceof AppError && error.code === 'SUBTITLE_FONT_MISSING') throw error;
    throw new AppError('SUBTITLE_BURN_FAILED', `字幕烧录失败，没有生成成片：${error instanceof AppError ? error.message.replace(/^视频拼接失败/, 'ffmpeg 报错') : '请重试，或取消「烧录字幕」后只导出 SRT'}`.slice(0, 400), 503);
   }
  }
  const bytes = await readFile(finalFile);
  if (!bytes.length) throw new AppError('FFMPEG_FAILED', '拼接结果为空。', 503);
  if (bytes.length > maxBytes) throw new AppError('COMPILE_TOO_LARGE', `成片约 ${Math.ceil(bytes.length / 1024 / 1024)} MB，超过素材库单个文件 ${Math.round(maxBytes / 1024 / 1024)} MB 的上限，无法保存；请缩短分镜时长或降低分辨率后重试。`, 413);
  return bytes;
 } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
