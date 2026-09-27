import { readdir } from 'node:fs/promises';

// Route modules are discovered from this directory, so a feature adds one file without
// editing shared routing code. A module exports `routes()` returning entries shaped
// { method, pattern: RegExp, handler({ match, ctx, req, res, url, body, reply }) }.
// A handler returns true (handled) or false (fall through); throwing AppError reports an error.
let cached;

async function loadRoutes() {
  if (cached) return cached;
  const dir = new URL('.', import.meta.url);
  const names = (await readdir(dir)).filter(name => name.endsWith('.mjs') && name !== 'index.mjs').sort();
  const modules = await Promise.all(names.map(name => import(new URL(name, dir))));
  cached = modules.flatMap(module => (typeof module.routes === 'function' ? module.routes() : []));
  return cached;
}

export async function dispatchRoute(request) {
  const { method, path } = request;
  for (const route of await loadRoutes()) {
    if (route.method && route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    if (await route.handler({ ...request, match }) !== false) return true;
  }
  return false;
}

export function parseCookies(header) {
  const jar = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}
