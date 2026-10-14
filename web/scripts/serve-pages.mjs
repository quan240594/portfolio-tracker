#!/usr/bin/env node
// Minimal static server that mimics GitHub Pages for a project site, used by the `test:e2e:pages` Playwright config:
//   /<base>            → 301 to /<base>/
//   /<base>/dir/       → dir/index.html
//   /<base>/missing    → 404.html with status 404 (how Pages serves SPA deep links)
//   outside the base   → plain 404
// Usage: node scripts/serve-pages.mjs [--port 4180] [--base /portfolio-tracker/] [--dir dist]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4180' },
    base: { type: 'string', default: '/portfolio-tracker/' },
    dir: { type: 'string', default: 'dist' },
  },
});
const base = `/${values.base.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
const root = resolve(values.dir);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

async function fileAt(path) {
  try {
    const s = await stat(path);
    if (s.isFile()) return path;
    if (s.isDirectory()) return fileAt(join(path, 'index.html'));
  } catch {
    // not found
  }
  return undefined;
}

async function send(res, status, file) {
  const body = await readFile(file);
  res.writeHead(status, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

for (const required of ['index.html', '404.html', '.nojekyll']) {
  if (!(await fileAt(join(root, required)))) {
    console.error(`serve-pages: ${join(root, required)} is missing — run \`pnpm build:pages\` first.`);
    process.exit(1);
  }
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (`${pathname}/` === base) {
      res.writeHead(301, { Location: base });
      return res.end();
    }
    if (!pathname.startsWith(base)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found (outside the Pages base path)');
    }
    const rel = normalize(decodeURIComponent(pathname.slice(base.length)));
    const target = resolve(root, rel);
    const file = target === root || target.startsWith(root + sep) ? await fileAt(target) : undefined;
    if (file) return await send(res, 200, file);
    return await send(res, 404, join(root, '404.html'));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(err));
  }
}).listen(Number(values.port), () => {
  console.log(`serve-pages: http://localhost:${values.port}${base} (from ${root})`);
});
