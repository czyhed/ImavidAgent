import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  splitPieces, lineCues, dialogueCues, fitCues, buildFilmCues, srtTime, buildSrt, escapeFilterPath, subtitleStyle, subtitleFilter, buildBurnArgs, SUBTITLE_FONT,
} from '../server/subtitles.mjs';
import { compileShotVideos } from '../server/video-compile.mjs';

// 火山文档示例的结构：sentence.words[].{word,startTime,endTime}，单位为秒。
const sentenceOf = (text, start = 0.205, step = 0.2, spoken = text) => ({ text, words: [...spoken].map((word, i) => ({ confidence: 0.9, word, startTime: Math.round((start + i * step) * 1000) / 1000, endTime: Math.round((start + (i + 1) * step) * 1000) / 1000 })) });

test('文档示例的单位：startTime / endTime 是秒，直接作为字幕时间，不做毫秒换算', () => {
  const doc = { text: '其他人。', words: [{ confidence: 0.85, endTime: 0.315, startTime: 0.205, word: '其' }, { confidence: 0.97, endTime: 0.515, startTime: 0.315, word: '他' }, { confidence: 0.92, endTime: 0.815, startTime: 0.515, word: '人。' }] };
  assert.deepEqual(lineCues({ text: '其他人。', subtitle: [doc] }), [{ start: 0.205, end: 0.815, text: '其他人。' }]);
});

test('多句偏移：每句偏移 = 前面各句实际时长 + 0.3 秒间隔，并以每句实际时长为准', () => {
  const cues = dialogueCues([
    { text: '第一句', subtitle: [sentenceOf('第一句')], duration: 1.0 },
    { text: '第二句', subtitle: [sentenceOf('第二句')], duration: 1.5 },
    { text: '第三句', subtitle: [sentenceOf('第三句')], duration: 1.0 },
  ], { gap: 0.3 });
  assert.deepEqual(cues.map(c => [c.start, c.text]), [[0.205, '第一句'], [1.505, '第二句'], [3.305, '第三句']]);
  assert.equal(cues[0].end, 0.805); assert.equal(cues[1].end, 2.105); assert.equal(cues[2].end, 3.905);
  // 没有读到某句的实际时长时，用该句最后一个词的结束时间估算。
  const estimated = dialogueCues([{ text: '甲乙', subtitle: [sentenceOf('甲乙', 0, 0.5)] }, { text: '丙丁', subtitle: [sentenceOf('丙丁', 0, 0.5)] }], { gap: 0.3 });
  assert.deepEqual(estimated.map(c => c.start), [0, 1.3]);
  // 超过整段音频总时长的条目被截断。
  assert.deepEqual(dialogueCues([{ text: '甲乙丙丁', subtitle: [sentenceOf('甲乙丙丁', 0, 1)] }], { total: 2.5 }).map(c => [c.start, c.end]), [[0, 2.5]]);
});

test('长句拆条：中文约 18 字、英文约 42 字符，在标点或词边界处拆开，首末字取时间戳', () => {
  const zh = '这款保温杯保温十二小时，现在下单立减二十元，还送杯刷一支！';
  const cues = lineCues({ text: zh, language: 'zh', subtitle: [sentenceOf(zh, 0.1)] });
  assert.deepEqual(cues.map(c => c.text), ['这款保温杯保温十二小时', '现在下单立减二十元，还送杯刷一支！']);
  assert.ok(cues.every(c => [...c.text].length <= 18));
  assert.equal(cues[0].start, 0.1); assert.equal(cues[0].end, 2.5); assert.equal(cues[1].start, 2.5);
  // 没有标点的超长句按等长切开。
  const flat = '一二三四五六七八九十一二三四五六七八九十一二三四五';
  assert.deepEqual(splitPieces(flat, 'zh').map(p => p.end - p.start), [13, 12]);
  // 英文在空格处断开，不拆单词。
  const en = 'This insulated cup keeps your drinks hot for twelve hours and cold for a full day';
  const pieces = splitPieces(en, 'en').map(p => en.slice(p.start, p.end).trim());
  assert.ok(pieces.length >= 2 && pieces.every(p => p.length <= 42) && pieces.join(' ') === en);
  // 句末的逗号被去掉，问号 / 感叹号保留。
  assert.deepEqual(lineCues({ text: '好的，', subtitle: [sentenceOf('好的，')] }).map(c => c.text), ['好的']);
});

test('读音文本与原文字数不同（2019 读作“二零一九”）时按比例映射，不丢字幕', () => {
  const cues = lineCues({ text: '2019年上市', subtitle: [sentenceOf('2019年上市', 1, 0.5, '二零一九年上市')], offset: 0 });
  assert.equal(cues.length, 1); assert.equal(cues[0].text, '2019年上市');
  assert.equal(cues[0].start, 1); assert.equal(cues[0].end, 4.5);
});

test('没有时间戳时回退为整句显示（起止取该句起止时间），没有时长也没有时间戳则不生成', () => {
  assert.deepEqual(lineCues({ text: '没有时间戳的一句', duration: 2, offset: 3 }), [{ start: 3, end: 5, text: '没有时间戳的一句' }]);
  assert.deepEqual(lineCues({ text: '没有时间戳的一句', subtitle: [], duration: 2 }), [{ start: 0, end: 2, text: '没有时间戳的一句' }]);
  assert.deepEqual(lineCues({ text: '没有时间戳的一句', subtitle: null }), []);
  assert.deepEqual(lineCues({ text: '   ', duration: 2 }), []);
  // 无时间戳的整段对话：偏移仍按实际时长累加。
  const joined = dialogueCues([{ text: '甲', duration: 1 }, { text: '乙', duration: 2 }], { gap: 0.3 });
  assert.deepEqual(joined.map(c => [c.start, c.end]), [[0, 1], [1.3, 3.3]]);
});

test('SRT 格式：序号、HH:MM:SS,mmm、UTF-8 文本，条目之间空一行', () => {
  assert.equal(srtTime(0), '00:00:00,000'); assert.equal(srtTime(3661.5), '01:01:01,500'); assert.equal(srtTime(59.9996), '00:01:00,000');
  const srt = buildSrt([{ start: 0.1, end: 1.25, text: '你好，世界' }, { start: 2, end: 3.5, text: '第二条\n换行被合并' }]);
  assert.equal(srt, '1\n00:00:00,100 --> 00:00:01,250\n你好，世界\n\n2\n00:00:02,000 --> 00:00:03,500\n第二条 换行被合并\n');
  assert.equal(buildSrt([]), '');
});

test('成片时间轴：按分镜顺序累加实际时长平移，超出该镜时长的条目截断，读不到时长时用字幕末尾', () => {
  const film = buildFilmCues([
    { cues: [{ start: 0.5, end: 2, text: 'A1' }, { start: 3.8, end: 5.5, text: 'A2' }, { start: 6, end: 7, text: 'A3 超出' }], duration: 5 },
    { cues: [], duration: 4 },
    { cues: [{ start: 0.2, end: 1.2, text: 'C1' }], duration: 3 },
    { cues: [{ start: 0, end: 1.5, text: 'D1' }], duration: null },
  ]);
  assert.deepEqual(film, [{ start: 0.5, end: 2, text: 'A1' }, { start: 3.8, end: 5, text: 'A2' }, { start: 9.2, end: 10.2, text: 'C1' }, { start: 12, end: 13.5, text: 'D1' }]);
  assert.deepEqual(fitCues([{ start: 1, end: 1.01, text: '太短' }, { start: -1, end: 1, text: '负起点' }]), [{ start: 0, end: 1, text: '负起点' }]);
});

test('subtitles 滤镜路径转义：反斜杠、冒号、单引号', () => {
  assert.equal(escapeFilterPath('/tmp/sj-compile-ab12/subtitles.srt'), '/tmp/sj-compile-ab12/subtitles.srt');
  assert.equal(escapeFilterPath(String.raw`C:\Users\x\subtitles.srt`), String.raw`C\:/Users/x/subtitles.srt`);
  assert.equal(escapeFilterPath("/tmp/a'b/subtitles.srt"), String.raw`/tmp/a'\\\''b/subtitles.srt`);
  assert.ok(!escapeFilterPath(String.raw`C:\a\b`).includes('\\\\'), '反斜杠已全部改为正斜杠');
});

test('force_style：字体、白字黑描边、底部居中，字号与边距随竖屏 / 横屏缩放', () => {
  const portrait = subtitleStyle(720, 1280), landscape = subtitleStyle(1920, 1080);
  for (const style of [portrait, landscape]) {
    assert.match(style, new RegExp(`FontName=${SUBTITLE_FONT}`));
    assert.match(style, /PrimaryColour=&H00FFFFFF&/); assert.match(style, /OutlineColour=&H00000000&/);
    assert.match(style, /BorderStyle=1/); assert.match(style, /Alignment=2/); assert.match(style, /Shadow=0/);
  }
  // libass 用 384×288 脚本坐标渲染 SRT，force_style 必须写脚本单位；换算回像素后应接近设计值。
  const size = style => Number(style.match(/FontSize=(\d+)/)[1]);
  const px = (value, height) => value * height / 288;
  assert.equal(size(portrait), 8); assert.equal(size(landscape), 15);
  assert.ok(Math.abs(px(size(portrait), 1280) - 35) < 4, '竖屏实际字号约 35 像素');
  assert.ok(Math.abs(px(size(landscape), 1080) - 56) < 4, '横屏实际字号约 56 像素');
  assert.ok(px(size(portrait), 1280) * 18 < 720 - 2 * 36, '竖屏 18 个汉字放得进画面宽度');
  assert.match(portrait, /MarginV=26,MarginL=19,MarginR=19/);
  const filter = subtitleFilter('/tmp/x/subtitles.srt', 720, 1280);
  assert.equal(filter, `subtitles='/tmp/x/subtitles.srt':force_style='${portrait}'`);
  const args = buildBurnArgs({ input: 'a.mp4', subtitleFile: '/tmp/x/subtitles.srt', output: 'b.mp4', width: 720, height: 1280 });
  assert.deepEqual(args.slice(0, 4), ['-i', 'a.mp4', '-vf', filter]);
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy'], '烧录只重编码视频，音频直接复制');
  assert.ok(args.includes('0:a?') && args.at(-1) === 'b.mp4');
});

// ---- 成片：假进程 ----
const probeOf = ({ width = 720, height = 1280, duration = '4.000000' } = {}) => ({ streams: [{ codec_type: 'video', width, height, r_frame_rate: '24/1', duration }, { codec_type: 'audio', duration }], format: { duration } });
function fakeProcess({ probes, fonts = 'WenQuanYi Micro Hei,文泉驿微米黑:style=Regular', failBurn = false } = {}) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    const burn = command === 'ffmpeg' && args.some(a => String(a).startsWith('subtitles='));
    const encode = command === 'ffmpeg' && args[0] !== '-version';
    const out = command === 'ffprobe' ? JSON.stringify(probes[args.at(-1).match(/clip(\d+)\.mp4$/)[1]]) : command === 'fc-list' ? fonts : '';
    return {
      stdout: { on(event, handler) { if (event === 'data' && out) handler(Buffer.from(out)); } },
      stderr: { on(event, handler) { if (event === 'data' && burn && failBurn) handler(Buffer.from('Error opening filters!')); } },
      on(event, handler) {
        if (event !== 'close') return;
        if (burn && failBurn) setImmediate(() => handler(1));
        else if (encode) writeFile(args.at(-1), Buffer.from(burn ? 'BURNED' : 'PLAIN')).then(() => handler(0));
        else setImmediate(() => handler(0));
      },
    };
  };
  return { spawnFn, calls };
}
const files = [
  { bytes: Buffer.from('a'), cues: [{ start: 0.5, end: 2, text: '第一镜字幕' }, { start: 3.5, end: 6, text: '超出本镜' }], fallbackDuration: 5 },
  { bytes: Buffer.from('b'), cues: [], fallbackDuration: null },
  { bytes: Buffer.from('c'), cues: [{ start: 0.2, end: 1, text: '第三镜字幕' }], fallbackDuration: 5 },
];
const probes = { 0: probeOf({ duration: '4.000000' }), 1: probeOf({ duration: '3.000000' }), 2: probeOf({ duration: '4.000000' }) };

test('compileShotVideos 烧录：拼接后再用 subtitles 滤镜处理，SRT 写入固定名称文件，report 记录条数', async () => {
  const process = fakeProcess({ probes }), report = {};
  const bytes = await compileShotVideos({ files, spawnFn: process.spawnFn, burnSubtitles: true, report });
  assert.equal(bytes.toString(), 'BURNED');
  const burn = process.calls.find(c => c.command === 'ffmpeg' && c.args.some(a => String(a).startsWith('subtitles=')));
  assert.ok(burn, '执行了烧录步骤');
  const filter = burn.args[burn.args.indexOf('-vf') + 1];
  assert.match(filter, /^subtitles='[^']*subtitles\.srt':force_style='FontName=WenQuanYi Micro Hei,/);
  assert.equal(report.burned, true); assert.equal(report.cueCount, 3);
  assert.deepEqual(report.durations, [4, 3, 4]);
  // 第一镜第二条字幕 3.5–6 秒按该镜 4 秒截断为 3.5–4；第三镜平移 4 + 3 = 7 秒。
  assert.equal(report.srt, '1\n00:00:00,500 --> 00:00:02,000\n第一镜字幕\n\n2\n00:00:03,500 --> 00:00:04,000\n超出本镜\n\n3\n00:00:07,200 --> 00:00:08,000\n第三镜字幕\n');
  assert.ok(process.calls.some(c => c.command === 'fc-list'), '烧录前检查字体');
});

test('compileShotVideos 不烧录：不执行滤镜，仍生成 SRT 并记录条数', async () => {
  const process = fakeProcess({ probes }), report = {};
  const bytes = await compileShotVideos({ files, spawnFn: process.spawnFn, burnSubtitles: false, report });
  assert.equal(bytes.toString(), 'PLAIN'); assert.equal(report.burned, false); assert.equal(report.cueCount, 3);
  assert.ok(!process.calls.some(c => c.command === 'ffmpeg' && c.args.some(a => String(a).startsWith('subtitles='))));
  // 没有任何字幕时，即使要求烧录也不执行。
  const none = fakeProcess({ probes }), noneReport = {};
  await compileShotVideos({ files: files.map(f => ({ ...f, cues: [] })), spawnFn: none.spawnFn, burnSubtitles: true, report: noneReport });
  assert.equal(noneReport.burned, false); assert.equal(noneReport.cueCount, 0); assert.equal(noneReport.srt, '');
});

test('烧录失败：给中文原因并整体失败，不返回半成品，临时目录被清理', async () => {
  const process = fakeProcess({ probes, failBurn: true });
  await assert.rejects(compileShotVideos({ files, spawnFn: process.spawnFn, burnSubtitles: true }), error => error.code === 'SUBTITLE_BURN_FAILED' && /字幕烧录失败，没有生成成片/.test(error.message) && /Error opening filters/.test(error.message));
  const missing = fakeProcess({ probes, fonts: 'DejaVu Sans:style=Book' });
  await assert.rejects(compileShotVideos({ files, spawnFn: missing.spawnFn, burnSubtitles: true }), error => error.code === 'SUBTITLE_FONT_MISSING' && /WenQuanYi Micro Hei/.test(error.message) && /SRT/.test(error.message));
  assert.ok(!missing.calls.some(c => c.command === 'ffmpeg' && c.args.some(a => String(a).startsWith('subtitles='))), '字体缺失时不执行 ffmpeg 烧录');
});
