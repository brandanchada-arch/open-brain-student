// design-v3: the whole app in a headless browser, on demo data (demo-mode.js), from a local server.
// Checks: no request ever goes to a supabase.co host, every tab opens without console errors,
// the thought map's hover card / zoom / search / filters work, it stays fast with 300 notes,
// and nothing scrolls sideways at 375px wide.
// Requests that leave 127.0.0.1 are answered with an empty reply and recorded, never sent.
// Needs Playwright with Chromium (pre-installed in the cloud computer). Skips if missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './static-server.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }

const TABS = ['today', 'jobs', 'voice', 'url', 'youtube', 'pdf', 'gaps', 'quiz', 'library', 'graph', 'thoughts', 'review'];

async function openApp(browser, srv, { query = '', viewport = { width: 1280, height: 860 }, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errors = [];
  const outside = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (r) => {
    const url = r.request().url();
    if (url.startsWith(srv.url)) return r.continue();
    outside.push(url);
    return r.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  await page.goto(srv.url + 'index.html' + query);
  await page.waitForSelector('#app', { state: 'visible' });
  return { ctx, page, errors, outside };
}

test('design-v3: every tab works on demo data, nothing reaches Supabase', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors, outside } = await openApp(browser, srv);
    assert.equal(await page.textContent('#demoBadge'), 'Demo data');
    await page.waitForSelector('#plannerTimeline .pl-item');
    for (const tab of TABS) {
      await page.evaluate((t) => obGo(t), tab);
      await page.waitForTimeout(350);
    }
    // Some real content showed up on the data-driven tabs.
    await page.evaluate(() => obGo('jobs')); await page.waitForSelector('#jobsList .pl-item');
    await page.evaluate(() => obGo('library')); await page.waitForSelector('#libList .lib-item');
    await page.click('#libList .lib-item');
    await page.waitForSelector('#libReader .lib-text');
    await page.evaluate(() => obGo('review')); await page.waitForSelector('#rvList .rv-card');
    await page.evaluate(() => obGo('thoughts')); await page.waitForSelector('#recentList .thought-card .et-edit');
    // Search + Ask on the Thoughts tab go to the fake too.
    await page.fill('#searchInput', 'cap rate');
    await page.click('#searchBtn');
    await page.waitForSelector('#searchResults .thought-card');
    await page.click('#askBtn');
    await page.waitForSelector('.ask-card');
    // Saving a thought stays in memory.
    await page.evaluate(() => obGo('today'));
    await page.fill('#quickText', 'Made-up test thought about rental cash flow');
    await page.click('#quickSave');
    await page.waitForFunction(() => OB_DEMO.tables.thoughts.some(t => /Made-up test thought/.test(t.content)));
    // Sign out shows the login screen; signing in again brings the app back.
    await page.evaluate(() => obGo('graph'));
    await page.click('#signOutBtn');
    await page.waitForSelector('#authScreen', { state: 'visible' });
    await page.fill('#authEmail', 'someone@example.com');
    await page.fill('#authPassword', 'not-a-real-password');
    await page.click('#authSubmit');
    await page.waitForSelector('#app', { state: 'visible' });

    assert.deepEqual(errors, [], 'no console errors');
    assert.deepEqual(outside.filter((u) => /supabase\.(co|in)/.test(new URL(u).host)), [], 'no requests to Supabase');
    // A direct fetch to the project URL is answered locally.
    const blocked = await page.evaluate(async () => (await fetch(SUPABASE_URL + '/rest/v1/thoughts')).status);
    assert.equal(blocked, 503);
    assert.deepEqual(outside.filter((u) => /supabase\.(co|in)/.test(new URL(u).host)), []);
    await ctx.close();

    // ?login=1 opens on the sign-in screen.
    const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
    await p2.route('**/*', (r) => r.request().url().startsWith(srv.url) ? r.continue() : r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await p2.goto(srv.url + 'index.html?login=1');
    await p2.waitForSelector('#authScreen', { state: 'visible' });
    assert.equal(await p2.isVisible('#app'), false);
    await ctx2.close();
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('design-v3: thought map hover, zoom, search and filters', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await openApp(browser, srv, { query: '#graph' });
    await page.waitForFunction(() => window.obGraph && obGraph._state.nodes.length > 50);
    await page.waitForTimeout(300);
    const G = () => page.evaluate(() => ({ k: obGraph._state.view.k, hidden: obGraph._state.hidden.size, matches: obGraph._state.matches ? obGraph._state.matches.size : null }));

    // Legend: one chip per topic.
    assert.equal(await page.locator('#graphLegend .legend-chip').count(), 6);

    // Hover a well-connected seed: the preview card shows its topic and connection count.
    const box = await page.locator('#graphCanvas').boundingBox();
    const pos = await page.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return { ...obGraph.screenPos(n.id), deg: n.deg }; });
    await page.mouse.move(box.x + pos.x, box.y + pos.y);
    await page.waitForSelector('#graphCard:not([hidden])');
    assert.match(await page.textContent('#graphCard'), new RegExp(`${pos.deg} connections`));
    // Click opens the full thought sheet.
    await page.mouse.click(box.x + pos.x, box.y + pos.y);
    await page.waitForSelector('#graphSheet.open');
    await page.click('[data-gs-open]');
    await page.waitForSelector('#gsText.full');
    await page.click('[data-gs-close]');

    // Zoom: buttons and the mouse wheel.
    const k0 = (await G()).k;
    await page.click('#graphZoomIn'); await page.waitForTimeout(400);
    const k1 = (await G()).k;
    assert.ok(k1 > k0 * 1.2, `zoom in button (${k0} -> ${k1})`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400); await page.waitForTimeout(100);
    assert.ok((await G()).k < k1, 'wheel zooms out');
    // Drag pans.
    const v0 = await page.evaluate(() => ({ ...obGraph._state.view }));
    await page.mouse.move(box.x + 20, box.y + 140);
    await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 90, { steps: 5 }); await page.mouse.up();
    const v1 = await page.evaluate(() => ({ ...obGraph._state.view }));
    assert.ok(Math.abs(v1.x - v0.x - 100) < 2 && Math.abs(v1.y - v0.y + 50) < 2, 'drag pans the map');
    await page.click('#graphFit'); await page.waitForTimeout(450);

    // Search highlights and focuses matches.
    await page.fill('#graphSearch', 'cap rate');
    await page.press('#graphSearch', 'Enter');
    await page.waitForTimeout(450);
    const s = await G();
    assert.ok(s.matches >= 1, 'search found seeds');
    assert.match(await page.textContent('#graphSearchCount'), /match/);
    assert.ok(s.k > k0, 'search zoomed in on the matches');
    await page.fill('#graphSearch', '');
    assert.equal((await G()).matches, null);

    // Topic filter and minimum connections.
    await page.click('#graphLegend .legend-chip >> nth=0');
    assert.equal((await G()).hidden, 1);
    assert.equal(await page.locator('#graphLegend .legend-chip.off').count(), 1);
    await page.click('[data-topic-all]');
    assert.equal((await G()).hidden, 0);
    const before = await page.evaluate(() => obGraph._state.nodes.filter(n => n.deg >= obGraph._state.minDeg).length);
    await page.fill('#graphMinLinks', '3');
    const after = await page.evaluate(() => ({ min: obGraph._state.minDeg, shown: obGraph._state.nodes.filter(n => n.deg >= obGraph._state.minDeg).length }));
    assert.equal(after.min, 3);
    assert.ok(after.shown < before, 'fewer seeds after raising the minimum');
    assert.equal(await page.textContent('#graphMinOut'), '3');

    assert.deepEqual(errors, []);
    await ctx.close();

    // 300 notes: drawing a frame stays well under one 60 fps frame.
    const big = await openApp(browser, srv, { query: '?nodes=300#graph' });
    await big.page.waitForFunction(() => window.obGraph && obGraph._state.nodes.length >= 300);
    const ms = await big.page.evaluate(() => { obGraph._draw(); const t = performance.now(); for (let i = 0; i < 30; i++) obGraph._draw(); return (performance.now() - t) / 30; });
    assert.ok(ms < 16, `one frame with 300 notes took ${ms.toFixed(1)}ms`);
    assert.deepEqual(big.errors, []);
    await big.ctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('design-v3: no sideways scroll at 375px, 44px tap targets, map works by touch', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await openApp(browser, srv, { viewport: { width: 375, height: 812 }, touch: true });
    await page.waitForSelector('#plannerTimeline .pl-item');
    for (const tab of TABS) {
      await page.evaluate((t) => obGo(t), tab);
      await page.waitForTimeout(300);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(w <= 375, `${tab}: page is ${w}px wide`);
    }
    const small = await page.evaluate(() => [...document.querySelectorAll('#tabbar button, .graph-tool, #graphLegend .chip, .screen.active .chip')]
      .filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length);
    assert.equal(small, 0, 'nav and map buttons are at least 44px');
    // Tap a seed: the preview card shows, with an Open button.
    await page.evaluate(() => obGo('graph'));
    await page.waitForFunction(() => obGraph._state.nodes.length > 50);
    await page.locator('#graphCanvas').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await page.locator('#graphCanvas').boundingBox();
    const pos = await page.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return obGraph.screenPos(n.id); });
    await page.touchscreen.tap(box.x + pos.x, box.y + pos.y);
    await page.waitForSelector('#graphCard:not([hidden]) .gc-open');
    await page.click('#graphCard .gc-open');
    await page.waitForSelector('#graphSheet.open');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
});
