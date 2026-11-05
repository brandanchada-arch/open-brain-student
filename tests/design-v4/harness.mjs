// Shared by the design-v4 browser test and design-review/take-screenshots.mjs.
// A tiny static file server for this folder, plus a page that can only reach that server:
// every other request is blocked, and the supabase-js CDN script is answered with an empty
// stub (demo-mode.js replaces the client anyway). Requests to supabase.co are recorded.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export async function startServer() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(join(ROOT, path || 'index.html'));
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function openApp(browser, base, { path = '/index.html', viewport = { width: 1440, height: 900 }, ...ctx } = {}) {
  const context = await browser.newContext({ viewport, ...ctx });
  const page = await context.newPage();
  const log = { errors: [], supabase: [], blocked: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('request', (r) => { if (/(^|\.)supabase\.(co|in)$/i.test(new URL(r.url()).hostname)) log.supabase.push(r.url()); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    if (u.startsWith('https://cdn.jsdelivr.net/npm/@supabase/')) return route.fulfill({ body: '/* stub: demo-mode.js supplies the client */', contentType: 'text/javascript' });
    log.blocked.push(u);
    return route.abort();
  });
  await page.goto(base + path);
  await page.waitForSelector('#app', { state: 'visible' }).catch(() => {});
  return { context, page, log };
}
