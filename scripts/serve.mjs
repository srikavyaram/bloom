// Tiny zero-dependency static server for local development.
// Usage: npm start   (PORT=8080 npm start to change the port)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Map a URL path to a file inside ROOT, refusing path traversal. */
function toFilePath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(ROOT, p));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = toFilePath(pathname);
  if (!file) {
    res.writeHead(400).end('Bad request');
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    const headers = {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // Always revalidate in dev; the service worker must never be HTTP-cached.
      'Cache-Control': file.endsWith(`${sep}sw.js`) ? 'no-cache, no-store, must-revalidate' : 'no-cache',
    };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
  if (process.env.QUIET !== '1') console.log(`${res.statusCode} ${req.method} ${pathname}`);
});

server.listen(PORT, () => {
  console.log(`\n  Bloom is running at http://localhost:${PORT}/\n  (Ctrl+C to stop)\n`);
});
