import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

async function check(path) {
  for (const file of await readdir(path, { withFileTypes: true })) {
    const name = `${path}/${file.name}`;
    if (file.isDirectory()) await check(name);
    else if (/\.(mjs|js)$/.test(name)) {
      const result = spawnSync(process.execPath, ['--check', name], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
  }
}
await check('server');
await check('shared');
await check('prototype');
const html = await readFile('prototype/prototype.html', 'utf8');
for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
// JSX 不能由 node --check 解析；用一次完整 Vite 构建覆盖 web/src 的语法与导入。
const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], { encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr || build.stdout);
console.log('Server, legacy prototype and React/JSX frontend syntax passed.');
