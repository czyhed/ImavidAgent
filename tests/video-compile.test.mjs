import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { buildCompileArgs, createCompileRunner, compileShotVideos, ffmpegAvailable, probeClip, MAX_COMPILE_BYTES } from '../server/video-compile.mjs';

const filterOf = args => args[args.indexOf('-filter_complex') + 1];

test('buildCompileArgs scales every clip to the first clip size and concatenates video and audio', () => {
  const args = buildCompileArgs([{ width: 1920, height: 1080, fps: 30, duration: 4, hasAudio: true }, { width: 1080, height: 1920, fps: 24, duration: 5, hasAudio: true }], 'out.mp4');
  const filter = filterOf(args);
  assert.match(filter, /\[0:v\]scale=1920:1080:force_original_aspect_ratio=decrease/);
  assert.match(filter, /pad=1920:1080/);
  assert.match(filter, /concat=n=2:v=1:a=1\[vout\]\[aout\]/);
  assert.deepEqual(args.filter((value, index) => args[index - 1] === '-i'), ['clip0.mp4', 'clip1.mp4']);
  assert.equal(args.includes('-an'), false, '成片保留声音，不再使用 -an');
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'aac']);
  assert.ok(args.includes('[aout]') && args.includes('[vout]'));
  assert.equal(args.at(-1), 'out.mp4');
  assert.throws(() => buildCompileArgs([], 'out.mp4'), { code: 'COMPILE_EMPTY' });
});

test('mixed clips: audio clips resample to 48 kHz stereo and silent clips get an anullsrc track of the same duration', () => {
  const args = buildCompileArgs([
    { width: 1280, height: 720, fps: 25, duration: 4.04, hasAudio: true },
    { width: 1280, height: 720, fps: 25, duration: 6.5, hasAudio: false },
    { width: 1280, height: 720, fps: 25, duration: 5, hasAudio: true },
  ], 'out.mp4');
  const filter = filterOf(args);
  assert.match(filter, /\[0:a\]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo\[a0\]/);
  assert.match(filter, /anullsrc=r=48000:cl=stereo,atrim=duration=6\.500,asetpts=PTS-STARTPTS\[a1\]/);
  assert.doesNotMatch(filter, /\[1:a\]/, '没有音轨的镜头不能引用不存在的音频流');
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[vout\]\[aout\]/);
  assert.equal(args.includes('-an'), false);
  assert.deepEqual(args.slice(args.indexOf('-ar'), args.indexOf('-ar') + 4), ['-ar', '48000', '-ac', '2']);
  assert.equal(filter.includes('xfade'), false, '镜头之间不加转场');
});

test('frame rate follows the first clip and falls back to 24', () => {
  const first = filterOf(buildCompileArgs([{ width: 640, height: 360, fps: 29.97, duration: 3, hasAudio: true }, { width: 640, height: 360, fps: 60, duration: 3, hasAudio: true }], 'o.mp4'));
  assert.equal((first.match(/fps=29\.97/g) || []).length, 2, '所有镜头统一为第一个镜头的帧率');
  assert.doesNotMatch(first, /fps=60/);
  const fallback = filterOf(buildCompileArgs([{ width: 640, height: 360, fps: null, duration: 3, hasAudio: true }], 'o.mp4'));
  assert.match(fallback, /fps=24\[v0\]/);
});

test('a silent clip without a readable duration is rejected instead of guessing', () => {
  assert.throws(() => buildCompileArgs([{ width: 640, height: 360, fps: 24, duration: null, hasAudio: false }], 'o.mp4'), { code: 'FFMPEG_PROBE_FAILED' });
});

// 假进程：ffprobe 按文件名返回探测结果，ffmpeg 记录参数并（可选）写出指定大小的输出文件。
function fakeSpawn(probes, { onFfmpeg } = {}) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    let out = '';
    if (command === 'ffprobe') {
      const file = args.at(-1);
      out = JSON.stringify(probes[file.match(/clip(\d+)\.mp4$/)?.[1] ?? file] ?? probes.default);
    } else if (command !== 'ffmpeg' || args[0] !== '-version') onFfmpeg?.(args);
    return {
      stdout: { on(event, handler) { if (event === 'data' && out) handler(Buffer.from(out)); } },
      stderr: { on() {} },
      on(event, handler) { if (event === 'close') setImmediate(() => handler(0)); },
    };
  };
  return { spawnFn, calls };
}

const probeOf = ({ width = 1280, height = 720, rate = '30/1', duration = '4.000000', audio = true } = {}) => ({
  streams: [{ codec_type: 'video', width, height, r_frame_rate: rate, avg_frame_rate: rate, duration }, ...(audio ? [{ codec_type: 'audio', duration }] : [])],
  format: { duration },
});

test('probeClip reads size, frame rate, duration and the audio flag', async () => {
  const { spawnFn } = fakeSpawn({ default: probeOf({ rate: '30000/1001', duration: '5.5', audio: false }) });
  assert.deepEqual(await probeClip('ffprobe', 'a.mp4', { spawnFn }), { width: 1280, height: 720, fps: 29.97, duration: 5.5, hasAudio: false });
  const noRate = fakeSpawn({ default: { streams: [{ codec_type: 'video', width: 10, height: 10, r_frame_rate: '0/0' }], format: { duration: '2' } } });
  assert.deepEqual(await probeClip('ffprobe', 'a.mp4', { spawnFn: noRate.spawnFn }), { width: 10, height: 10, fps: null, duration: 2, hasAudio: false });
});

test('createCompileRunner probes every clip with ffprobe and invokes ffmpeg with the concat plan', async () => {
  const { spawnFn, calls } = fakeSpawn({ default: probeOf({ width: 1280, height: 720 }) });
  const compile = createCompileRunner({ spawnFn });
  await compile({ files: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'], output: '/tmp/out.mp4' });
  assert.deepEqual(calls.slice(0, 2).map(call => call.command), ['ffprobe', 'ffprobe'], '每个分镜先探测');
  assert.equal(calls[2].command, 'ffmpeg');
  assert.match(filterOf(calls[2].args), /scale=1280:720/);
  assert.match(filterOf(calls[2].args), /a=1/);
});

// 假进程：ffprobe 返回探测结果；ffmpeg 转码时把指定大小的输出写入 -y 后的文件再结束。
function fakeEncoder(probes, outputSize) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    const encode = command === 'ffmpeg' && args[0] !== '-version';
    const out = command === 'ffprobe' ? JSON.stringify(probes[args.at(-1).match(/clip(\d+)\.mp4$/)[1]]) : '';
    return {
      stdout: { on(event, handler) { if (event === 'data' && out) handler(Buffer.from(out)); } },
      stderr: { on() {} },
      on(event, handler) {
        if (event !== 'close') return;
        if (encode) writeFile(args.at(-1), Buffer.alloc(outputSize, 1)).then(() => handler(0));
        else setImmediate(() => handler(0));
      },
    };
  };
  return { spawnFn, calls };
}

test('compileShotVideos writes one selected video per shot and rejects output above the library file limit', async () => {
  assert.equal(MAX_COMPILE_BYTES, 100 * 1024 * 1024, '与 media.put 的 100 MiB 上限一致');
  const probes = { 0: probeOf({ audio: true }), 1: probeOf({ audio: false, duration: '3.000000' }) };
  const files = [{ bytes: Buffer.from('a'), name: 'a.mp4' }, { bytes: Buffer.from('b'), name: 'b.mp4' }];
  const fine = fakeEncoder(probes, 10);
  const bytes = await compileShotVideos({ files, spawnFn: fine.spawnFn, maxBytes: 1024 * 1024 });
  assert.equal(bytes.length, 10);
  const encode = fine.calls.find(call => call.command === 'ffmpeg' && call.args[0] !== '-version');
  assert.match(filterOf(encode.args), /anullsrc=r=48000:cl=stereo,atrim=duration=3\.000/, '第二个镜头无声，补静音');
  assert.equal(fine.calls.filter(call => call.command === 'ffprobe').length, 2, '每镜探测一次');
  const big = fakeEncoder(probes, 2 * 1024 * 1024);
  await assert.rejects(compileShotVideos({ files, spawnFn: big.spawnFn, maxBytes: 1024 * 1024 }), error => error.code === 'COMPILE_TOO_LARGE' && error.status === 413 && /1 MB/.test(error.message) && /缩短分镜时长/.test(error.message));
  await assert.rejects(compileShotVideos({ files: [] }), { code: 'COMPILE_EMPTY' });
});

test('ffmpegAvailable reports missing binary as FFMPEG_UNAVAILABLE', async () => {
  await assert.rejects(ffmpegAvailable('sj-definitely-not-a-binary-xyz'), { code: 'FFMPEG_UNAVAILABLE' });
});
