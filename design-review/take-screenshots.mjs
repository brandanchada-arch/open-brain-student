// Screenshots of the neural redesign on demo data (design review only).
// Run from the repo folder: node design-review/take-screenshots.mjs
// Serves the app on 127.0.0.1; only Google Fonts may load from outside, everything else
// outside is answered with an empty reply. Nothing reaches Supabase.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = fileURLToPath(new URL('./', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(await readFile(join(ROOT, path || 'index.html'))); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const supabase = [];

async function page(opts, query = '') {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  p.on('request', (r) => { if (/supabase\.co/.test(new URL(r.url()).hostname)) supabase.push(r.url()); });
  p.on('pageerror', (e) => console.error('page error:', e));
  await p.route('**/*', (route) => {
    const h = new URL(route.request().url()).hostname;
    if (h === '127.0.0.1' || h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com') return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  await p.goto(`${base}/index.html${query}`);
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await p.waitForTimeout(900);
  return { ctx, p };
}
const shot = (p, name, full = false) => p.screenshot({ path: OUT + name, fullPage: full }).then(() => console.log('saved', name));
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const phone = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

{ const { ctx, p } = await page(desktop, '?login=1'); await shot(p, 'login.png'); await ctx.close(); }

{
  const { ctx, p } = await page(desktop);
  await shot(p, 'home-desktop.png');
  for (const [name, screen, sub] of [['today', 'today'], ['jobs', 'jobs'], ['capture', 'capture'], ['study', 'study'], ['library', 'study', 'library'],
    ['brain', 'brain'], ['thoughts', 'brain', 'thoughts'], ['review', 'brain', 'review']]) {
    await p.click(`#tabbar [data-screen="${screen}"]`);
    await p.click(`#screen-${screen} .chip[data-sub="${sub || (screen === 'study' ? 'gaps' : screen === 'capture' ? 'voice' : 'graph')}"]`).catch(() => {});
    if (name === 'jobs') { await p.waitForTimeout(500); await p.click('[data-job-open]').catch(() => {}); }
    if (name === 'library') { await p.waitForTimeout(400); await p.click('[data-lib-id]').catch(() => {}); }
    await p.waitForTimeout(1200);
    await p.evaluate(() => window.scrollTo(0, 0));
    await shot(p, `tab-${name}-desktop.png`, name !== 'brain');
  }
  // the map
  await p.click('#screen-brain .chip[data-sub="graph"]'); await p.waitForTimeout(800);
  await p.evaluate(() => { obGraph._state.alpha = 0; });
  await shot(p, 'graph-desktop.png');
  const n = await p.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[1]; return obGraph._screenOf(n.id); });
  await p.mouse.move(n.x, n.y); await p.waitForTimeout(700);
  await shot(p, 'graph-hover.png');
  await p.mouse.move(5, 5);
  await p.click('#graphLegend [data-topic]:nth-child(6)');
  await p.click('#graphLegend [data-topic]:nth-child(5)');
  await p.evaluate(() => { const r = document.getElementById('graphMinDeg'); r.value = '2'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.fill('#graphSearch', 'rate');
  await p.waitForTimeout(1300);
  await shot(p, 'graph-filtered.png');
  await ctx.close();
}

{
  const { ctx, p } = await page(phone);
  await shot(p, 'home-mobile.png');
  await p.tap('#tabbar [data-screen="brain"]');
  await p.waitForTimeout(1500);
  await p.evaluate(() => { obGraph._state.alpha = 0; });
  const n = await p.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return obGraph._screenOf(n.id); });
  await p.touchscreen.tap(n.x, n.y); await p.waitForTimeout(600);
  await shot(p, 'graph-mobile.png');
  await ctx.close();
}

await browser.close();
server.close();
console.log(supabase.length ? `REQUESTS TO SUPABASE: ${supabase.length}` : 'No requests to supabase.co');
