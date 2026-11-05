// Takes the design-review screenshots (design-review/*.png) of the app running on demo-mode.js.
// Run from this folder: node scripts/design-screenshots.mjs
// Serves the folder on a local port, blocks every other website (fonts fall back to system fonts
// unless FONTS=1), and never contacts Supabase. Needs Playwright with Chromium.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'design-review');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const allowFonts = process.env.FONTS === '1';

const srv = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = normalize(join(root, p));
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' }).end(await readFile(f)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
let supabaseCalls = 0;
async function open(path, { width = 1440, height = 900, mobile = false } = {}) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' }
    : { viewport: { width, height }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (/supabase\.(co|in)$/.test(u.hostname)) { supabaseCalls++; return r.abort(); }
    if (u.origin === base) return r.continue();
    if (allowFonts && /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return r.continue();
    return r.fulfill({ status: 200, contentType: /css|googleapis/.test(u.href) ? 'text/css' : 'text/javascript', body: '' });
  });
  await page.goto(base + path);
  await page.waitForTimeout(900);
  return { ctx, page };
}
const shot = (page, name, opts = {}) => page.screenshot({ path: join(out, name), ...opts }).then(() => console.log('saved', name));

// login
{ const { ctx, page } = await open('/?login=1'); await shot(page, 'login.png'); await ctx.close(); }

// desktop tabs
{
  const { ctx, page } = await open('/#today');
  await page.waitForSelector('#plannerTimeline .pl-item');
  await shot(page, 'home-desktop.png');
  await shot(page, 'tab-today-desktop.png', { fullPage: true });
  const go = async (name, wait) => { await page.evaluate((n) => window.obGo(n, { top: true }), name); if (wait) await page.waitForSelector(wait); await page.waitForTimeout(500); };
  await go('jobs', '#jobsList .pl-item'); await shot(page, 'tab-jobs-desktop.png', { fullPage: true });
  await go('voice'); await shot(page, 'tab-capture-desktop.png');
  await go('url'); await shot(page, 'tab-capture-link-desktop.png');
  await go('gaps'); await page.click('#gapsBtn'); await page.waitForSelector('#gapCard'); await shot(page, 'tab-study-gaps-desktop.png');
  await go('quiz'); await page.click('#quizBtn'); await page.waitForSelector('#quizList .gq-card'); await page.waitForTimeout(300); await shot(page, 'tab-study-quiz-desktop.png');
  await go('library', '#libList .lib-item'); await shot(page, 'tab-study-library-desktop.png', { fullPage: true });
  await page.click('[data-lib-id="lib-flag"]'); await page.waitForSelector('#libReader .door-flag'); await page.waitForTimeout(300);
  await shot(page, 'tab-study-library-reader-desktop.png');
  await go('graph', '#graphLegend .legend-chip'); await shot(page, 'tab-brain-desktop.png');
  await go('thoughts', '#recentList .thought-card'); await shot(page, 'tab-brain-thoughts-desktop.png');
  await page.fill('#searchInput', 'cap rate'); await page.click('#askBtn'); await page.waitForSelector('.ask-card'); await page.waitForTimeout(300);
  await shot(page, 'tab-brain-ask-desktop.png');
  await go('review', '#rvList .rv-card'); await shot(page, 'tab-brain-review-desktop.png', { fullPage: true });
  await ctx.close();
}

// the map
{
  const { ctx, page } = await open('/#graph');
  await page.waitForFunction(() => window.obGraph && window.obGraph._state.nodes.length >= 60);
  await page.waitForTimeout(500);
  await shot(page, 'graph-desktop.png');
  const box = await page.locator('#graphCanvas').boundingBox();
  const t = await page.evaluate(() => { const n = window.obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return window.obGraph._screenOf(n.id); });
  await page.mouse.move(box.x + t.x, box.y + t.y);
  await page.waitForSelector('#graphTip:not([hidden])');
  await shot(page, 'graph-hover.png');
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.click('#graphLegend [data-topic="6"]');
  await page.click('#graphLegend [data-topic="5"]');
  await page.locator('#graphMin').fill('3');
  await page.fill('#graphSearch', 'cash'); await page.press('#graphSearch', 'Enter');
  await page.waitForTimeout(600);
  await shot(page, 'graph-filtered.png');
  await page.mouse.click(box.x + 4, box.y + 4);
  await ctx.close();
}
{
  const { ctx, page } = await open('/?nodes=300#graph');
  await page.waitForFunction(() => window.obGraph && window.obGraph._state.nodes.length === 300);
  await page.waitForTimeout(500);
  await shot(page, 'graph-300-desktop.png');
  await ctx.close();
}

// phone
{
  const { ctx, page } = await open('/#today', { mobile: true });
  await page.waitForSelector('#plannerTimeline .pl-item');
  await shot(page, 'home-mobile.png');
  await page.evaluate(() => window.obGo('graph', { top: true }));
  await page.waitForFunction(() => window.obGraph._state.nodes.length >= 60);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, document.querySelector('.graph-toolbar').getBoundingClientRect().top + window.scrollY - 12));
  await page.waitForTimeout(200);
  const box = await page.locator('#graphCanvas').boundingBox();
  const t = await page.evaluate(() => { const n = window.obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return window.obGraph._screenOf(n.id); });
  await page.touchscreen.tap(box.x + t.x, box.y + t.y);
  await page.waitForTimeout(300);
  await shot(page, 'graph-mobile.png');
  await page.evaluate(() => window.obGo('library', { top: true })); await page.waitForTimeout(500);
  await shot(page, 'tab-study-library-mobile.png');
  await ctx.close();
}

await browser.close();
srv.close();
console.log(supabaseCalls ? `WARNING: ${supabaseCalls} Supabase requests were blocked` : 'No Supabase requests.');
