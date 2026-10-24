// 字幕（V-25）：把火山语音返回的字/词级时间戳整理成字幕条目，再换算成成片时间轴、SRT 与烧录参数。
// 全部是纯函数，不调用模型、不依赖 ffmpeg，便于单元测试。
// 火山 TTSSubtitle 的 startTime / endTime 单位是秒（文档示例 0.205、0.315），这里不做单位猜测。

export const SUBTITLE_MAX_CJK = 18;
export const SUBTITLE_MAX_LATIN = 42;
export const MIN_CUE_SECONDS = 0.2;
export const MAX_SRT_BYTES = 256 * 1024;
export const SUBTITLE_FONT = 'WenQuanYi Micro Hei';

const round3 = value => Math.round(value * 1000) / 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value);

// 把一句台词的文本切成适合单行显示的片段：先按标点分子句，再把相邻子句合并到不超过上限，
// 单个子句仍然过长时：英文在空格处断开，中文按等长切分。返回 [{ start, end }]（原文字符下标，end 不含）。
export function splitPieces(text, language = 'zh', max = null) {
 const limit = max || (language === 'en' ? SUBTITLE_MAX_LATIN : SUBTITLE_MAX_CJK);
 const chars = [...String(text || '')];
 const clauses = [];
 let from = 0;
 for (let i = 0; i < chars.length; i += 1) {
  const char = chars[i];
  const fullWidth = /[，。！？；：、…,.!?;:]/.test(char) && /[，。！？；：、…]/.test(char);
  const ascii = /[,.!?;:]/.test(char) && (i === chars.length - 1 || /\s/.test(chars[i + 1]));
  if (fullWidth || ascii) { clauses.push({ start: from, end: i + 1 }); from = i + 1; }
 }
 if (from < chars.length) clauses.push({ start: from, end: chars.length });
 const length = clause => chars.slice(clause.start, clause.end).join('').trim().length;
 const hardSplit = clause => {
  if (length(clause) <= limit) return [clause];
  const pieces = [];
  if (language === 'en') {
   let start = clause.start;
   while (start < clause.end) {
    if (clause.end - start <= limit) { pieces.push({ start, end: clause.end }); break; }
    let cut = -1;
    for (let i = start + limit; i > start; i -= 1) if (/\s/.test(chars[i])) { cut = i; break; }
    if (cut < 0) cut = start + limit;
    pieces.push({ start, end: cut });
    start = cut;
   }
   return pieces;
  }
  const count = Math.ceil((clause.end - clause.start) / limit), size = Math.ceil((clause.end - clause.start) / count);
  for (let start = clause.start; start < clause.end; start += size) pieces.push({ start, end: Math.min(clause.end, start + size) });
  return pieces;
 };
 const merged = [];
 for (const clause of clauses.flatMap(hardSplit)) {
  const last = merged.at(-1);
  if (last && length({ start: last.start, end: clause.end }) <= limit) last.end = clause.end;
  else merged.push({ ...clause });
 }
 return merged;
}

// 展平 enable_subtitle 返回的 sentence 列表为带时间的词：[{ word, start, end }]。
export function flattenWords(subtitle) {
 const words = [];
 for (const sentence of Array.isArray(subtitle) ? subtitle : []) {
  for (const item of Array.isArray(sentence?.words) ? sentence.words : []) {
   if (typeof item?.word === 'string' && item.word && finite(item.startTime) && finite(item.endTime) && item.endTime >= item.startTime) words.push({ word: item.word, start: item.startTime, end: item.endTime });
  }
 }
 return words;
}

const cleanText = text => String(text).trim().replace(/[，；、,;]+$/u, '').trim();

// 一句台词的字幕：offset 是这一句在整段台词音频里的起点（秒），duration 是这一句实际音频时长。
// 有词级时间戳：每个片段取对应首末字的时间；返回的词是“读音文本”（如 2019 读作“二零一九”），
// 与原文字数可能不同，所以按非空白字符的比例把原文位置映射到词上。没有时间戳：整句显示。
export function lineCues({ text, language = 'zh', subtitle, offset = 0, duration = null }) {
 const original = String(text || '');
 const visible = [...original].map((char, index) => ({ char, index })).filter(item => !/\s/.test(item.char));
 if (!visible.length) return [];
 const words = flattenWords(subtitle);
 const spoken = words.flatMap(w => [...w.word].filter(c => !/\s/.test(c)).map((_, i, arr) => ({ ...w, share: [i / arr.length, (i + 1) / arr.length] })));
 const pieces = splitPieces(original, language);
 if (!spoken.length) {
  if (!finite(duration) || duration <= 0) return [];
  return [{ start: round3(offset), end: round3(offset + duration), text: cleanText(original) }].filter(cue => cue.text);
 }
 const rank = new Map(visible.map((item, i) => [item.index, i]));
 const at = (index, edge) => {
  // 原文第 index 个字符（含）起点或终点在读音字符序列里的位置，按比例映射。
  const position = rank.has(index) ? rank.get(index) : visible.findIndex(item => item.index >= index);
  const ratio = (edge === 'end' ? position + 1 : position) / visible.length;
  const target = Math.min(spoken.length - 1, Math.max(0, Math.floor(ratio * spoken.length - (edge === 'end' ? 1e-9 : 0))));
  const unit = spoken[target], span = unit.end - unit.start;
  return edge === 'end' ? unit.start + span * unit.share[1] : unit.start + span * unit.share[0];
 };
 const cues = [];
 for (const piece of pieces) {
  const body = cleanText([...original].slice(piece.start, piece.end).join(''));
  if (!body) continue;
  let first = piece.start, last = piece.end - 1;
  while (first < last && !rank.has(first)) first += 1;
  while (last > first && !rank.has(last)) last -= 1;
  if (!rank.has(first) || !rank.has(last)) continue;
  let start = offset + at(first, 'start'), end = offset + at(last, 'end');
  if (end - start < MIN_CUE_SECONDS) end = start + MIN_CUE_SECONDS;
  cues.push({ start: round3(start), end: round3(end), text: body });
 }
 // 相邻片段不重叠：后一条的起点不早于前一条的终点。
 for (let i = 1; i < cues.length; i += 1) if (cues[i].start < cues[i - 1].end) cues[i - 1].end = Math.max(cues[i - 1].start, cues[i].start);
 return cues;
}

// 整段台词音频的字幕。lines: [{ text, language, subtitle?, duration? }]；gap 为行间静音（秒）。
// 每句的偏移 = 前面各句实际时长之和 + 行间间隔；没有实际时长的句子用词级时间戳末尾估算。
// total 为拼接后音频总时长，超出的部分截断。
export function dialogueCues(lines, { gap = 0.3, total = null } = {}) {
 const cues = [];
 let offset = 0;
 for (const [index, line] of lines.entries()) {
  const words = flattenWords(line.subtitle);
  const measured = finite(line.duration) && line.duration > 0 ? line.duration : (words.length ? Math.max(...words.map(w => w.end)) : null);
  cues.push(...lineCues({ text: line.text, language: line.language, subtitle: line.subtitle, offset, duration: measured }));
  offset += (measured || 0) + (index < lines.length - 1 ? gap : 0);
 }
 return fitCues(cues, total);
}

// 把条目限制在 [0, limit]：起点超出的丢弃，终点超出的截断；limit 为空时不限制。
export function fitCues(cues, limit = null) {
 const out = [];
 for (const cue of Array.isArray(cues) ? cues : []) {
  if (!cue || typeof cue.text !== 'string' || !finite(cue.start) || !finite(cue.end)) continue;
  const start = Math.max(0, cue.start);
  let end = cue.end;
  if (finite(limit)) { if (start >= limit - 0.05) continue; end = Math.min(end, limit); }
  if (end - start < 0.05) continue;
  out.push({ start: round3(start), end: round3(end), text: cue.text });
 }
 return out;
}

// 成片时间轴：按分镜顺序累加各镜实际时长，把各镜字幕平移；超出该镜时长的条目截断。
// shots: [{ cues, duration }]；duration 读不到时回退为该镜字幕的最晚结束时间。
export function buildFilmCues(shots) {
 const film = [];
 let offset = 0;
 for (const shot of shots) {
  const cues = Array.isArray(shot?.cues) ? shot.cues : [];
  const duration = finite(shot?.duration) && shot.duration > 0 ? shot.duration : (cues.length ? Math.max(...cues.map(c => c.end)) : 0);
  for (const cue of fitCues(cues, duration)) film.push({ start: round3(cue.start + offset), end: round3(cue.end + offset), text: cue.text });
  offset += duration;
 }
 return film;
}

export function srtTime(seconds) {
 const total = Math.max(0, Math.round(seconds * 1000));
 const pad = (value, width) => String(value).padStart(width, '0');
 return `${pad(Math.floor(total / 3600000), 2)}:${pad(Math.floor(total / 60000) % 60, 2)}:${pad(Math.floor(total / 1000) % 60, 2)},${pad(total % 1000, 3)}`;
}

// SRT 文本（UTF-8，序号 + HH:MM:SS,mmm --> HH:MM:SS,mmm + 文本，条目之间空一行）。
export function buildSrt(cues) {
 const blocks = (Array.isArray(cues) ? cues : []).filter(cue => cue?.text).map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${String(cue.text).replace(/\r\n?|\n+/g, ' ').trim()}\n`);
 return blocks.length ? blocks.join('\n') : '';
}

// ---- 烧录 ----
// subtitles 滤镜的文件名需要转义：反斜杠改正斜杠，冒号和单引号按 ffmpeg 过滤器语法转义。
// 调用方只用固定名称（如 subtitles.srt）并在其所在目录之外传绝对路径，不把用户输入拼进路径。
export function escapeFilterPath(path) {
 return String(path).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''");
}

// force_style：白字、黑描边、底部居中。libass 渲染 SRT 时使用 384×288 的脚本坐标，
// 再按输出尺寸放大（纵向 height/288、横向 width/384），所以先按像素算好，再换算成脚本单位。
// 已在服务器 ffmpeg 5.1.9 实测：直接写像素值会放大约 height/288 倍。
const SCRIPT_WIDTH = 384, SCRIPT_HEIGHT = 288;
export function subtitleStyle(width, height) {
 const portrait = height > width;
 const sizePx = Math.max(14, Math.round(portrait ? width * 0.048 : height * 0.052));
 const toY = px => Math.max(1, Math.round(px * SCRIPT_HEIGHT / height));
 const toX = px => Math.max(1, Math.round(px * SCRIPT_WIDTH / width));
 const size = toY(sizePx);
 const outline = Math.max(1, Math.round(size * 0.1));
 const marginV = toY(Math.max(12, Math.round(height * (portrait ? 0.09 : 0.06))));
 const marginH = toX(Math.max(12, Math.round(width * 0.05)));
 return `FontName=${SUBTITLE_FONT},FontSize=${size},PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=${outline},Shadow=0,Alignment=2,MarginV=${marginV},MarginL=${marginH},MarginR=${marginH}`;
}

export function subtitleFilter(file, width, height) {
 return `subtitles='${escapeFilterPath(file)}':force_style='${subtitleStyle(width, height)}'`;
}

// 在已拼接的成片上烧录字幕：视频重新编码，音频直接复制。
export function buildBurnArgs({ input, subtitleFile, output, width, height }) {
 return ['-i', input, '-vf', subtitleFilter(subtitleFile, width, height), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', '-y', output];
}
