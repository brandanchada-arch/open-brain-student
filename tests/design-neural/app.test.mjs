// The whole app in a headless browser, on the demo data from demo-mode.js.
// Serves this folder on 127.0.0.1 and answers every outside request (fonts, CDN) with an
// empty reply, so nothing real is contacted. Checks:
//   - zero requests to any supabase.co host
//   - every tab and sub-tab opens with no console errors
//   - the brain map: hover preview, zoom (wheel + buttons), search, topic filter, min. connections
//   - no sideways scroll at 375px wide, and 44px+ tap targets for the main controls
//   - a 300-node map still draws a frame quickly
// Needs Playwright with Chromium (pre-installed in the cloud computer). Skips if missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const skip = !chromium && 'Playwright not installed';

let server, base, browser;
before(async () => {
  if (!chromium) return;
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.includes('..')) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(join(ROOT, path || 'index.html'));
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(opts = {}, query = '') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  const page = await ctx.newPage();
  const requests = [], errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    const ct = /\.js($|\?)|jsdelivr/.test(u.href) ? 'text/javascript' : /fonts\.googleapis/.test(u.href) ? 'text/css' : 'text/plain';
    return route.fulfill({ status: 200, contentType: ct, body: '' });   // nothing leaves this computer
  });
  await page.goto(`${base}/index.html${query}`);
  return { ctx, page, requests, errors };
}
const supabaseHits = (reqs) => reqs.filter((u) => { try { return /(^|\.)supabase\.co$/.test(new URL(u).hostname); } catch { return false; } });

const TABS = [
  ['today', null], ['jobs', null],
  ['capture', 'voice'], ['capture', 'url'], ['capture', 'youtube'], ['capture', 'pdf'],
  ['study', 'gaps'], ['study', 'quiz'], ['study', 'library'],
  ['brain', 'graph'], ['brain', 'thoughts'], ['brain', 'review'],
];

test('opens signed in on demo data, every tab works, nothing goes to Supabase', { skip }, async () => {
  const { ctx, page, requests, errors } = await open();
  await page.waitForSelector('#app', { state: 'visible' });
  await page.waitForSelector('#obDemoBadge');
  for (const [screen, sub] of TABS) {
    await page.click(`#tabbar [data-screen="${screen}"]`);
    if (sub) await page.click(`#screen-${screen} .chip[data-sub="${sub}"]`);
    await page.waitForTimeout(350);
    assert.ok(await page.isVisible(`#screen-${screen}`), `${screen} screen is shown`);
    if (sub) assert.ok(await page.isVisible(`#panel-${sub}`), `${sub} panel is shown`);
  }
  // a few screens have real content from the demo data
  await page.click('#tabbar [data-screen="jobs"]');
  await page.waitForSelector('#jobsList :text("Financial Analyst I")');
  await page.click('#tabbar [data-screen="study"]'); await page.click('.chip[data-sub="library"]');
  await page.waitForSelector('#libList :text("Capital Budgeting")');
  await page.click('#tabbar [data-screen="brain"]'); await page.click('.chip[data-sub="review"]');
  await page.waitForSelector('#panel-review :text("learning SQL")');
  await page.click('.chip[data-sub="thoughts"]');
  await page.waitForSelector('#recentList .thought-card');
  // a write stays in memory and shows up
  await page.click('#tabbar [data-screen="today"]');
  await page.fill('#quickText', 'Made-up test thought about duration risk');
  await page.click('#quickSave');
  await page.waitForFunction(() => window.obDemoDb.thoughts.some((t) => /duration risk/.test(t.content)));
  assert.deepEqual(errors, [], 'no console errors');
  assert.deepEqual(supabaseHits(requests), [], 'no requests to supabase.co');
  await ctx.close();
});

test('?login=1 shows the sign-in screen, and signing in opens the app', { skip }, async () => {
  const { ctx, page, requests, errors } = await open({}, '?login=1');
  await page.waitForSelector('#authScreen', { state: 'visible' });
  assert.equal(await page.isVisible('#app'), false);
  await page.fill('#authEmail', 'someone@example.com');
  await page.fill('#authPassword', 'not-a-real-password');
  await page.click('#authSubmit');
  await page.waitForSelector('#app', { state: 'visible' });
  assert.deepEqual(errors, []);
  assert.deepEqual(supabaseHits(requests), []);
  await ctx.close();
});

test('brain map: hover preview, zoom, search, topic filter and min. connections', { skip }, async () => {
  const { ctx, page, requests, errors } = await open({}, '#graph');
  await page.waitForFunction(() => window.obGraph && obGraph._state.nodes.length >= 50);
  await page.waitForTimeout(600);
  const G = () => page.evaluate(() => {
    const s = obGraph._state;
    return { k: s.view.k, shown: s.nodes.filter((n) => !s.hidden.has(n.c1) && n.deg >= s.minDeg).length, matches: s.matches ? s.matches.size : null, hover: s.hover && s.hover.id };
  });

  // hover: the biggest dot (settled, so it doesn't move away)
  await page.evaluate(() => { obGraph._state.alpha = 0; });
  const target = await page.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return { id: n.id, ...obGraph._screenOf(n.id), deg: n.deg }; });
  await page.mouse.move(target.x, target.y);
  await page.waitForSelector('#graphPreview:not([hidden])');
  const card = await page.textContent('#graphPreview');
  assert.match(card, new RegExp(`${target.deg} connections`), 'preview shows the connection count');
  assert.equal((await G()).hover, target.id);
  await page.mouse.click(target.x, target.y);
  await page.waitForSelector('#graphSheet.open');
  await page.click('[data-gs-close]');
  await page.waitForTimeout(450);   // the side sheet slides away

  // zoom: wheel, buttons, reset
  const k0 = (await G()).k;
  await page.mouse.move(640, 500);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);
  const k1 = (await G()).k;
  assert.ok(k1 > k0 * 1.3, `wheel zooms in (${k0} -> ${k1})`);
  await page.click('#graphZoomOut'); await page.waitForTimeout(400);
  assert.ok((await G()).k < k1, 'zoom-out button');
  await page.click('#graphZoomIn'); await page.waitForTimeout(400);
  await page.click('#graphFit'); await page.waitForTimeout(700);
  assert.ok(Math.abs((await G()).k - k0) / k0 < 0.25, 'reset goes back to the whole map');

  // search highlights matches and focuses them
  await page.fill('#graphSearch', 'cap rate');
  await page.waitForTimeout(500);
  const s = await G();
  assert.ok(s.matches >= 1 && s.matches < 10, `search finds a few thoughts (${s.matches})`);
  assert.match(await page.textContent('#graphSearchCount'), /match/);
  await page.click('#graphSearchClear');
  assert.equal((await G()).matches, null);

  // topic filter
  const all = (await G()).shown;
  await page.click('#graphLegend [data-topic]');
  await page.waitForTimeout(150);
  assert.ok((await G()).shown < all, 'hiding a topic removes its dots');
  assert.equal(await page.getAttribute('#graphLegend [data-topic]', 'aria-pressed'), 'false');
  await page.click('#graphLegend [data-topic]');
  assert.equal((await G()).shown, all);

  // minimum connections
  await page.evaluate(() => { const r = document.getElementById('graphMinDeg'); r.value = '4'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(150);
  assert.ok((await G()).shown < all, 'min. connections hides loosely linked thoughts');
  assert.equal(await page.textContent('#graphMinDegValue'), '4');

  assert.deepEqual(errors, []);
  assert.deepEqual(supabaseHits(requests), []);
  await ctx.close();
});

test('375px phone: no sideways scroll on any tab, big tap targets, map controls usable', { skip }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  await page.waitForSelector('#app', { state: 'visible' });
  for (const [screen, sub] of TABS) {
    await page.tap(`#tabbar [data-screen="${screen}"]`);
    if (sub) await page.tap(`#screen-${screen} .chip[data-sub="${sub}"]`);
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    assert.ok(w <= 375, `${screen}/${sub || '-'}: page is ${w}px wide`);
  }
  const small = await page.evaluate(() => [...document.querySelectorAll('#tabbar button, .graph-tool, #screen-brain .chip, #graphLegend .chip')]
    .map((b) => b.getBoundingClientRect()).filter((r) => r.width && r.height && (r.width < 44 || r.height < 44)).length);
  assert.equal(small, 0, 'tab bar, chips and map buttons are at least 44px');
  // tap a dot: preview card with an Open button
  await page.tap('#screen-brain .chip[data-sub="graph"]');
  await page.waitForFunction(() => obGraph._state.nodes.length > 0);
  await page.evaluate(() => document.getElementById('graphCanvas').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await page.evaluate(() => { obGraph._state.alpha = 0; });
  const p = await page.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return obGraph._screenOf(n.id); });
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForSelector('#graphPreview:not([hidden]) .gp-open');
  await page.tap('#graphPreview .gp-open');
  await page.waitForSelector('#graphSheet.open');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a 300-node map stays smooth', { skip }, async () => {
  const { ctx, page, errors } = await open({}, '?graph=300#graph');
  await page.waitForFunction(() => window.obGraph && obGraph._state.nodes.length === 300, null, { timeout: 15000 });
  const ms = await page.evaluate(() => {
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) obGraph._draw(performance.now());
    return (performance.now() - t0) / 40;
  });
  assert.ok(ms < 16, `one frame takes ${ms.toFixed(2)} ms (needs < 16 ms)`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
