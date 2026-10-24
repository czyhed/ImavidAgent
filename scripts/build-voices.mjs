import { readFile, writeFile } from 'node:fs/promises';

// 把火山引擎官方「音色列表」页面文本整理为 config/voices.json。
// 用法：node scripts/build-voices.mjs <voices.txt> [config/voices.json]
// 只收录「豆包语音合成模型2.0」的中文与外语音色（排除 S2S 端到端与 1.0 音色）；官方更新列表后重新运行即可。

const VOICE_TYPE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9-]+){2,}$/;
const MODES = new Set(['QA', 'Context']);
const split = text => String(text).split(/[、,，]\s*/).map(s => s.trim()).filter(Boolean);

function sections(lines) {
 const marks = [];
 lines.forEach((line, index) => { if (/音色列表\s*#$/.test(line)) marks.push(index); });
 return marks.map((start, i) => ({ header: lines[start], start: start + 1, end: i + 1 < marks.length ? marks[i + 1] : lines.length }))
  .filter(section => section.header.includes('豆包语音合成模型2.0'));
}

function parseRecord(scene, name, voiceType, body, group) {
 const languages = [], dialects = [], capabilities = [], tags = [];
 let mode = null, languageSeen = false, autoLanguage = false;
 for (const raw of body) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith('语种：') || line.startsWith('语种:')) { languageSeen = true; languages.push(...split(line.slice(3))); continue; }
  if (line.startsWith('方言：') || line.startsWith('方言:')) { dialects.push(...split(line.slice(3))); continue; }
  if (MODES.has(line)) { mode = line; continue; }
  if (/情感变化|指令遵循|上下文遵循/.test(line)) { capabilities.push(...split(line)); continue; }
  if (line.startsWith('仅限') || line.startsWith('备注')) continue;
  if (!languageSeen) { languageSeen = true; languages.push(...split(line)); continue; }
  tags.push(...split(line));
 }
 const cleaned = languages.filter(item => {
  if (/语种识别/.test(item)) { autoLanguage = true; return false; }
  return true;
 });
 const scenes = split(scene);
 const gender = /(?:^|_)female(?:_|$)/.test(voiceType) ? 'female' : /(?:^|_)male(?:_|$)/.test(voiceType) ? 'male' : null;
 return {
  name: name.trim(), voiceType, scene: scenes.filter(s => s !== '外语音色')[0] || scenes[0] || '', scenes,
  ...(gender ? { gender } : {}), group,
  languages: cleaned, dialects, capabilities, emotion: capabilities.includes('情感变化'),
  ...(mode ? { mode } : {}), ...(autoLanguage ? { autoLanguage: true } : {}), ...(tags.length ? { tags } : {}),
 };
}

// 纯函数：输入页面文本，输出音色列表（便于测试）。
export function parseVoices(text) {
 const lines = String(text).replace(/\r/g, '').split('\n').map(line => line.trim());
 const voices = [], seen = new Set();
 for (const section of sections(lines)) {
  const group = section.header.includes('外语') ? 'foreign' : 'chinese';
  const indexes = [];
  for (let i = section.start; i < section.end; i++) if (VOICE_TYPE.test(lines[i]) && i - 2 >= section.start) indexes.push(i);
  indexes.forEach((index, n) => {
   const next = n + 1 < indexes.length ? indexes[n + 1] - 2 : section.end;
   const voiceType = lines[index];
   if (seen.has(voiceType)) return;
   seen.add(voiceType);
   voices.push(parseRecord(lines[index - 2], lines[index - 1], voiceType, lines.slice(index + 1, next), group));
  });
 }
 return voices;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').at(-1))) {
 const [input, output = 'config/voices.json'] = process.argv.slice(2);
 if (!input) { console.error('用法：node scripts/build-voices.mjs <voices.txt> [config/voices.json]'); process.exit(1); }
 const voices = parseVoices(await readFile(input, 'utf8'));
 if (voices.length < 50) { console.error(`只解析到 ${voices.length} 个音色，页面格式可能已变化，未写入。`); process.exit(1); }
 await writeFile(output, JSON.stringify({ source: '火山引擎豆包语音 音色列表（豆包语音合成模型2.0）', model: 'seed-tts-2.0', count: voices.length, voices }, null, 1) + '\n');
 console.log(`已写入 ${voices.length} 个音色到 ${output}。`);
}
