import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';
import { run, probeClip } from './video-compile.mjs';

// 台词配音的音频处理（服务端 ffmpeg，可注入 spawnFn；不调用任何付费接口）：
// 1. join：把逐句合成的 mp3 按顺序拼成一段，行间留静音间隔。
// 2. mix：后期配音，原视频音轨压低到约 30%，叠加配音，输出 H.264 + AAC 的派生视频。

export const JOIN_GAP_SECONDS = 0.3;
export const JOIN_SAMPLE_RATE = 24000;
export const MIX_SAMPLE_RATE = 48000;
export const ORIGINAL_VOLUME = 0.3;
export const MAX_DUB_BYTES = 100 * 1024 * 1024;

// 纯函数：拼接参数。inputs 为 clip0.mp3 … clipN.mp3，行间插入 gap 秒静音。
export function buildJoinArgs(count, output, { gap = JOIN_GAP_SECONDS } = {}) {
 if (!Number.isInteger(count) || count < 1) throw new AppError('DUB_EMPTY', '没有可拼接的台词音频。', 422);
 const chains = [], order = [];
 for (let i = 0; i < count; i++) {
  chains.push(`[${i}:a]aresample=${JOIN_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=mono[a${i}]`);
  order.push(`[a${i}]`);
  if (i < count - 1) { chains.push(`anullsrc=r=${JOIN_SAMPLE_RATE}:cl=mono,atrim=duration=${gap.toFixed(3)},asetpts=PTS-STARTPTS[g${i}]`); order.push(`[g${i}]`); }
 }
 return [
  ...Array.from({ length: count }, (_, i) => ['-i', `line${i}.mp3`]).flat(),
  '-filter_complex', `${chains.join(';')};${order.join('')}concat=n=${order.length}:v=0:a=1[out]`,
  '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', String(JOIN_SAMPLE_RATE), '-ac', '1', '-y', output,
 ];
}

// 纯函数：混音参数。hasAudio 表示原视频有音轨；配音比视频长时 -shortest 截断到视频长度。
export function buildMixArgs({ hasAudio }, video, audio, output, { volume = ORIGINAL_VOLUME } = {}) {
 const dub = `[1:a]aresample=${MIX_SAMPLE_RATE},aformat=channel_layouts=stereo,apad[d]`;
 const filter = hasAudio
  ? `[0:a]volume=${volume},aresample=${MIX_SAMPLE_RATE},aformat=channel_layouts=stereo,apad[o];${dub};[o][d]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0[m]`
  : dub.replace('[d]', '[m]');
 return [
  '-i', video, '-i', audio, '-filter_complex', filter, '-map', '0:v:0', '-map', '[m]', '-shortest',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ar', String(MIX_SAMPLE_RATE), '-ac', '2', '-movflags', '+faststart', '-y', output,
 ];
}

export async function probeAudioDuration(command, file, options = {}) {
 const { stdout } = await run(command, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { timeoutMs: 30 * 1000, ...options });
 const seconds = Number(JSON.parse(stdout || '{}').format?.duration);
 if (!Number.isFinite(seconds) || seconds <= 0) throw new AppError('FFMPEG_PROBE_FAILED', '无法读取配音音频的时长。', 503);
 return Math.round(seconds * 1000) / 1000;
}

async function exec(command, args, options) {
 try { return await run(command, args, options); }
 catch (error) {
  if (error instanceof AppError) throw error;
  throw new AppError('FFMPEG_UNAVAILABLE', '服务器缺少 ffmpeg，无法处理配音；请联系管理员安装。', 503);
 }
}

// runner 工厂：join / mix 都在临时目录内完成。
export function createAudioRunner({ ffmpegCommand = 'ffmpeg', ffprobeCommand = 'ffprobe', spawnFn = spawn } = {}) {
 const options = { spawnFn };
 const withDirectory = async fn => {
  const directory = await mkdtemp(join(tmpdir(), 'sj-dub-'));
  try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
 };
 return {
  // lines: [Buffer]；返回 { bytes(mp3), durationSec, lineDurations }。
  async join(lines) {
   if (!Array.isArray(lines) || !lines.length) throw new AppError('DUB_EMPTY', '没有可拼接的台词音频。', 422);
   return withDirectory(async directory => {
    for (const [index, bytes] of lines.entries()) await writeFile(join(directory, `line${index}.mp3`), bytes);
    const output = join(directory, 'dialogue.mp3');
    // 每句的实际时长用于换算字幕偏移；读不到时留空，由调用方按时间戳估算。
    const lineDurations = [];
    for (let index = 0; index < lines.length; index++) lineDurations.push(await probeAudioDuration(ffprobeCommand, join(directory, `line${index}.mp3`), options).catch(() => null));
    const args = buildJoinArgs(lines.length, output).map(arg => /^line\d+\.mp3$/.test(arg) ? join(directory, arg) : arg);
    await exec(ffmpegCommand, args, { ...options, timeoutMs: 5 * 60 * 1000 });
    const bytes = await readFile(output);
    if (!bytes.length) throw new AppError('FFMPEG_FAILED', '台词音频拼接结果为空。', 503);
    return { bytes, durationSec: await probeAudioDuration(ffprobeCommand, output, options), lineDurations };
   });
  },
  // 返回 { bytes(mp4), truncated, videoSeconds, audioSeconds }。
  async mix({ video, audio }) {
   return withDirectory(async directory => {
    const videoFile = join(directory, 'video.mp4'), audioFile = join(directory, 'dialogue.mp3'), output = join(directory, 'dubbed.mp4');
    await writeFile(videoFile, video); await writeFile(audioFile, audio);
    let clip;
    try { clip = await probeClip(ffprobeCommand, videoFile, options); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError('FFMPEG_UNAVAILABLE', '服务器缺少 ffmpeg，无法处理配音；请联系管理员安装。', 503); }
    const audioSeconds = await probeAudioDuration(ffprobeCommand, audioFile, options);
    await exec(ffmpegCommand, buildMixArgs({ hasAudio: clip.hasAudio }, videoFile, audioFile, output), { ...options, timeoutMs: 15 * 60 * 1000 });
    const bytes = await readFile(output);
    if (!bytes.length) throw new AppError('FFMPEG_FAILED', '配音混音结果为空。', 503);
    if (bytes.length > MAX_DUB_BYTES) throw new AppError('DUB_TOO_LARGE', '配音后的视频超过素材库单个文件 100 MB 的上限。', 413);
    const videoSeconds = clip.duration || null;
    return { bytes, truncated: Boolean(videoSeconds) && audioSeconds > videoSeconds + 0.05, videoSeconds, audioSeconds };
   });
  },
 };
}
