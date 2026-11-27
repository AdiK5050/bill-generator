// Tiny static file server for local development: node tools/serve.mjs [port]
// Serves the app over http://localhost so the service worker and modules work.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};
const BLOCKED = ['/server/', '/node_modules/', '/.git/', '/.idea/'];

export function startServer(port = 8080, host = '127.0.0.1') {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (file !== ROOT && !file.startsWith(ROOT + sep)) {
        res.writeHead(403).end();
        return;
      }
      // Check the block list on the resolved path, so "..%2f" tricks cannot reach blocked folders.
      const rel = '/' + relative(ROOT, file).split(sep).join('/');
      if (BLOCKED.some((b) => rel.startsWith(b))) {
        res.writeHead(404).end();
        return;
      }
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  startServer(port, host).then(() =>
    console.log(`Bill Generator: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`),
  );
}
