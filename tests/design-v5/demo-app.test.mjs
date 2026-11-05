// The whole app in a headless browser, on demo data (demo-mode.js), served from a local static server.
// Checks: nothing goes to Supabase, every tab opens without console errors, the map's hover / zoom /
// search / filter work, it stays fast with 300 notes, and nothing scrolls sideways at 375px.
// Every outside request (fonts, CDN) is answered with an empty file, so it runs offline.
// Needs Playwright with Chromium (pre-installed in the cloud computer). Skips if missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from '../../scripts/design-review-server.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }

const TABS = ['today', 'jobs', 'voice', 'url', 'youtube', 'pdf', 'gaps', 'quiz', 'library', 'graph', 'thoughts', 'review'];

async function openPage(browser, base, opts = {}) {
  const page = await browser.newPage(opts);
  const problems = [];
  const supabase = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (/supabase\.(co|in)/.test(new URL(u).host)) { supabase.push(u); return r.abort(); }
    if (u.startsWith(base)) return r.continue();
    return r.fulfill({ status: 200, body: '', contentType: /css/.test(u) ? 'text/css' : 'text/javascript' });
  });
  page.on('request', (req) => { try { if (/supabase\.(co|in)$/.test(new URL(req.url()).host)) supabase.push(req.url()); } catch { /* data: urls */ } });
  return { page, problems, supabase };
}

test('demo app: no Supabase traffic, every tab clean, map works, fits 375px', { skip: !chromium && 'Playwright not installed', timeout: 90_000 }, async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    // ---- desktop: every tab ----
    const { page, problems, supabase } = await openPage(browser, base, { viewport: { width: 1440, height: 900 } });
    await page.goto(base + '#today');
    await page.waitForSelector('#app', { state: 'visible' });
    await page.waitForSelector('#demoBadge');
    for (const t of TABS) {
      await page.evaluate((h) => { location.hash = h; }, t);
      await page.waitForTimeout(350);
      const panel = ['today', 'jobs'].includes(t) ? `#screen-${t}` : `#panel-${t}`;
      assert.ok(await page.isVisible(panel), `${t}: ${panel} is shown`);
    }
    // stat tiles are filled from the data
    await page.evaluate(() => { location.hash = 'today'; });
    await page.waitForFunction(() => /\d/.test(document.getElementById('kpiTopicsValue').textContent));
    assert.equal(await page.textContent('#kpiTopicsValue'), '6');

    // ---- map ----
    await page.evaluate(() => { location.hash = 'graph'; });
    await page.waitForFunction(() => window.obGraph._state.nodes.length > 0);
    await page.waitForTimeout(500);
    const S = () => page.evaluate(() => { const G = window.obGraph._state; return { k: G.k, matches: G.matches.size, hover: G.hover && G.hover.id, hidden: G.hidden.size, visible: G.nodes.filter(n => !G.hidden.has(n.c1) && n.deg >= G.minDeg).length, total: G.nodes.length }; });
    // hover: move the mouse onto the best-connected note
    const target = await page.evaluate(() => { const G = window.obGraph._state; const n = G.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return { id: n.id, ...window.obGraph._screenPos(n.id) }; });
    await page.mouse.move(target.x, target.y);
    await page.waitForSelector('#graphHover:not([hidden])');
    assert.equal((await S()).hover, target.id);
    assert.match(await page.textContent('#graphHover'), /links?/);
    // zoom: button and wheel
    const k0 = (await S()).k;
    await page.click('#graphZoomIn');
    const k1 = (await S()).k;
    assert.ok(k1 > k0, 'zoom-in button zooms in');
    await page.mouse.move(target.x, target.y);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
    assert.ok((await S()).k < k1, 'wheel zooms out');
    await page.click('#graphFit');
    // search
    await page.fill('#graphSearch', 'interview');
    await page.press('#graphSearch', 'Enter');
    await page.waitForTimeout(200);
    const m = (await S()).matches;
    assert.ok(m > 0, 'search finds notes');
    assert.match(await page.textContent('#graphSearchCount'), new RegExp(`${m} match`));
    await page.fill('#graphSearch', '');
    await page.press('#graphSearch', 'Escape');
    // topic filter + min links
    const before = (await S()).visible;
    await page.click('#graphLegend [data-topic]');
    const after = await S();
    assert.equal(after.hidden, 1);
    assert.ok(after.visible < before, 'hiding a topic hides its notes');
    await page.click('#graphLegend [data-topic-all]');
    await page.$eval('#graphMin', (el) => { el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.ok((await S()).visible < before, 'min links hides loosely connected notes');
    // click opens the detail sheet
    await page.$eval('#graphMin', (el) => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#graphRank [data-rank]');
    await page.waitForSelector('#graphSheet.open');
    await page.click('[data-gs-open]');
    await page.waitForFunction(() => document.getElementById('gsText').classList.contains('full'));

    assert.deepEqual(problems, [], 'no console errors on any tab');
    assert.deepEqual(supabase, [], 'no requests to Supabase');
    await page.close();

    // ---- 300 notes: still fast ----
    const big = await openPage(browser, base, { viewport: { width: 1440, height: 900 } });
    await big.page.goto(base + '?nodes=300#graph');
    await big.page.waitForFunction(() => window.obGraph._state.nodes.length >= 300, null, { timeout: 15000 });
    const ms = await big.page.evaluate(() => { const t = performance.now(); for (let i = 0; i < 30; i++) window.obGraph._draw(); return (performance.now() - t) / 30; });
    assert.ok(ms < 16, `one frame with 300 notes takes ${ms.toFixed(1)} ms (needs < 16)`);
    assert.deepEqual(big.problems, []);
    await big.page.close();

    // ---- phone: 375px, no sideways scroll on any tab ----
    const phone = await openPage(browser, base, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await phone.page.goto(base + '#today');
    await phone.page.waitForSelector('#app', { state: 'visible' });
    for (const t of TABS) {
      await phone.page.evaluate((h) => { location.hash = h; }, t);
      await phone.page.waitForTimeout(300);
      const w = await phone.page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(w <= 375, `${t}: page is ${w}px wide at 375px`);
    }
    // nav buttons are big enough to tap
    const small = await phone.page.$$eval('#tabbar [data-screen]', (bs) => bs.filter(b => { const r = b.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).length);
    assert.equal(small, 0, 'bottom nav buttons are at least 44px');
    // tap on the map shows the preview card
    await phone.page.evaluate(() => { location.hash = 'graph'; });
    await phone.page.waitForFunction(() => window.obGraph._state.nodes.length > 0);
    await phone.page.waitForTimeout(400);
    const p = await phone.page.evaluate(() => { const G = window.obGraph._state; const n = G.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return window.obGraph._screenPos(n.id); });
    await phone.page.touchscreen.tap(p.x, p.y);
    await phone.page.waitForSelector('#graphHover:not([hidden]) .gh-open');
    assert.deepEqual(phone.problems, []);
    assert.deepEqual(phone.supabase, []);

    // ---- ?login=1 shows the sign-in screen ----
    await phone.page.goto(base + '?login=1');
    await phone.page.waitForSelector('#authScreen', { state: 'visible' });
    assert.equal(await phone.page.isVisible('#app'), false);
  } finally {
    await browser.close();
    server.close();
  }
});
