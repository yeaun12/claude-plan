// 로컬 확인용 서버: public/ 정적 파일과 api/*.js 를 Vercel 과 같은 경로로 띄운다.
// 사용: TURSO_DATABASE_URL=file:local.db node scripts/dev-server.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.TURSO_DATABASE_URL ||= 'file:' + path.join(root, 'local.db');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const m = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (m) {
      const mod = await import(pathToFileURL(path.join(root, 'api', m[1] + '.js')).href);
      req.query = Object.fromEntries(url.searchParams);
      return await mod.default(req, res);
    }
    const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.join(root, 'public'))) throw new Error('bad path');
    const body = await readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
