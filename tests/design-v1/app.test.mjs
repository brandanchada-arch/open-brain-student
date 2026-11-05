// Design v1: the whole app in a headless browser, served from this folder by a tiny local server,
// running on demo-mode.js (invented data, fake Supabase). Checks:
//   - not one request goes to a supabase.co host
//   - every tab opens with no console errors
//   - the map: hover card, zoom (wheel + buttons + reset), search, topic filter, min-links filter
//   - 300 dots still draw quickly
//   - no sideways scroll at 375px, and the phone tab bar buttons are at least 44px tall
// Other websites (fonts, the supabase-js CDN) get an empty answer, so nothing real is contacted.
// Needs Playwright with Chromium (pre-installed in the cloud computer). Skips if missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
const root = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const f = normalize(join(root, p));
      if (!f.startsWith(root) || /[\\/](supabase|node_modules|\.git)[\\/]/.test(f)) { res.writeHead(404).end(); return; }
      try { res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' }).end(await readFile(f)); }
      catch { res.writeHead(404).end('not found'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function openApp(browser, base, { path = '/', viewport = { width: 1280, height: 860 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [], supabase = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (/(^|\.)supabase\.(co|in)$/.test(new URL(r.url()).hostname)) supabase.push(r.url()); });
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.origin === base) return r.continue();
    const type = /\.css|fonts\.googleapis/.test(u.href) ? 'text/css' : 'text/javascript';
    return r.fulfill({ status: 200, contentType: type, body: '' });   // nothing leaves this computer
  });
  await page.goto(base + path);
  return { ctx, page, errors, supabase };
}

test('design v1: every tab, the map and the phone layout work on demo data', { skip: !chromium && 'Playwright not installed', timeout: 90_000 }, async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  try {
    // ---------- login screen (?login=1) ----------
    {
      const { ctx, page, errors, supabase } = await openApp(browser, base, { path: '/?login=1' });
      await page.waitForSelector('#authScreen', { state: 'visible' });
      assert.equal(await page.isVisible('#app'), false, 'the app is hidden until you sign in');
      await page.fill('#authEmail', 'someone@example.com');
      await page.fill('#authPassword', 'made-up');
      await page.click('#authSubmit');
      await page.waitForSelector('#app', { state: 'visible' });
      assert.deepEqual(errors, []); assert.deepEqual(supabase, []);
      await ctx.close();
    }

    // ---------- every tab on a computer ----------
    const { ctx, page, errors, supabase } = await openApp(browser, base);
    await page.waitForSelector('#app', { state: 'visible' });
    await page.waitForSelector('#demoBadge');
    await page.waitForSelector('#plannerTimeline .pl-item');
    const tabs = [
      ['today', '#plannerTimeline .pl-item'], ['jobs', '#jobsList .pl-item'],
      ['voice', '#voiceTranscript'], ['url', '#urlInput'], ['youtube', '#ytUrl'], ['pdf', '#pdfDropZone'],
      ['gaps', '#gapsList .gq-card'], ['quiz', '#quizBtn'], ['library', '#libList .lib-item'],
      ['graph', '#graphLegend .legend-chip'], ['thoughts', '#recentList .thought-card'], ['review', '#rvList .rv-card'],
    ];
    for (const [name, sel] of tabs) {
      await page.evaluate((n) => window.obGo(n), name);
      await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
    }
    // a few real clicks through the tab bar and the sub-tabs
    for (const s of ['jobs', 'capture', 'study', 'brain', 'today']) {
      await page.click(`#tabbar [data-screen="${s}"]`);
      assert.ok(await page.isVisible(`#screen-${s}`), `${s} screen shows`);
    }
    await page.click('#tabbar [data-screen="study"]');
    await page.click('#screen-study .chip[data-sub="gaps"]');
    await page.click('#gapsBtn');
    await page.waitForSelector('#gapCard');
    await page.click('#screen-study .chip[data-sub="quiz"]');
    await page.click('#quizBtn');
    await page.waitForSelector('#quizList .gq-card');
    await page.click('#screen-study .chip[data-sub="library"]');
    await page.click('#libList .lib-item');
    await page.waitForSelector('#libReader .lib-text');
    await page.click('#tabbar [data-screen="brain"]');
    await page.click('#screen-brain .chip[data-sub="thoughts"]');
    await page.fill('#searchInput', 'cap rate');
    await page.click('#searchBtn');
    await page.waitForSelector('#searchResults .thought-card');

    // ---------- the map ----------
    await page.click('#screen-brain .chip[data-sub="graph"]');
    await page.waitForFunction(() => window.obGraph._state.nodes.length >= 60);
    await page.waitForTimeout(400);
    const box = await page.locator('#graphCanvas').boundingBox();
    // hover: the biggest dot shows a preview card with its topic and connection count
    const target = await page.evaluate(() => {
      const G = window.obGraph._state;
      const n = G.nodes.slice().sort((a, b) => b.deg - a.deg)[0];
      return { id: n.id, deg: n.deg, ...window.obGraph._screenOf(n.id) };
    });
    await page.mouse.move(box.x + target.x, box.y + target.y);
    await page.waitForSelector('#graphTip:not([hidden])');
    const tip = await page.textContent('#graphTip');
    assert.match(tip, new RegExp(`${target.deg} connections`));
    assert.match(tip, /Finance|Courses|Job Search|Real Estate|AI Tools|Personal/);
    // click opens the detail panel
    await page.mouse.click(box.x + target.x, box.y + target.y);
    await page.waitForSelector('#graphSheet.open');
    await page.click('[data-gs-close]');
    // zoom: wheel, buttons, reset
    const k0 = await page.evaluate(() => window.obGraph._state.k);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(100);
    const k1 = await page.evaluate(() => window.obGraph._state.k);
    assert.ok(k1 > k0 * 1.5, `wheel zooms in (${k0} -> ${k1})`);
    await page.click('#graphZoomOut'); await page.waitForTimeout(400);
    const k2 = await page.evaluate(() => window.obGraph._state.k);
    assert.ok(k2 < k1, 'zoom-out button works');
    await page.click('#graphZoomIn'); await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => window.obGraph._state.k) > k2, 'zoom-in button works');
    await page.click('#graphFit'); await page.waitForTimeout(450);
    assert.ok(Math.abs(await page.evaluate(() => window.obGraph._state.k) - k0) < 0.01, 'reset goes back to the whole map');
    // drag pans
    const tx0 = await page.evaluate(() => window.obGraph._state.tx);
    await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 130, box.y + 60, { steps: 5 }); await page.mouse.up();
    assert.ok(Math.abs(await page.evaluate(() => window.obGraph._state.tx) - tx0 - 100) < 2, 'drag moves the map');
    // search highlights matches and moves the view to them
    await page.fill('#graphSearch', 'cap rate');
    await page.press('#graphSearch', 'Enter');
    await page.waitForTimeout(450);
    const s = await page.evaluate(() => ({ m: [...window.obGraph._state.matches].map(n => n.label), k: window.obGraph._state.k }));
    assert.ok(s.m.length >= 1 && s.m.every(l => /cap rate/i.test(l)), 'search finds the cap-rate notes');
    assert.ok(s.k > k0, 'search zooms in on the matches');
    assert.match(await page.textContent('#graphSearchCount'), /found/);
    await page.fill('#graphSearch', ''); await page.press('#graphSearch', 'Enter');
    assert.equal(await page.evaluate(() => window.obGraph._state.matches), null);
    // topic filter: hide Finance
    await page.click('#graphLegend [data-topic="1"]');
    assert.equal(await page.getAttribute('#graphLegend [data-topic="1"]', 'aria-pressed'), 'false');
    assert.ok(await page.evaluate(() => window.obGraph._state.hidden.has(1)));
    const hiddenHit = await page.evaluate(() => {           // a Finance dot no longer shows a card
      const n = window.obGraph._state.nodes.find(x => x.c1 === 1);
      return window.obGraph._screenOf(n.id);
    });
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.move(box.x + hiddenHit.x, box.y + hiddenHit.y);
    await page.waitForTimeout(100);
    const tipText = await page.isVisible('#graphTip') ? await page.textContent('#graphTip') : '';
    assert.doesNotMatch(tipText, /Finance/);
    // min connections
    await page.locator('#graphMin').fill('4');
    const visible = await page.evaluate(() => window.obGraph._state.nodes.filter(n => !window.obGraph._state.hidden.has(n.c1) && n.deg >= window.obGraph._state.minDeg).length);
    const total = await page.evaluate(() => window.obGraph._state.nodes.length);
    assert.ok(visible > 0 && visible < total - 10, `filters hide dots (${visible} of ${total} shown)`);
    await page.click('[data-topic-reset]');
    assert.equal(await page.evaluate(() => window.obGraph._state.hidden.size + window.obGraph._state.minDeg), 0, '"Show all" clears the filters');

    assert.deepEqual(errors, [], 'no console errors on any tab');
    assert.deepEqual(supabase, [], 'no requests to Supabase');
    await ctx.close();

    // ---------- 300 dots ----------
    {
      const { ctx: c3, page: p3, errors: e3, supabase: s3 } = await openApp(browser, base, { path: '/?nodes=300#graph' });
      await p3.waitForFunction(() => window.obGraph && window.obGraph._state.nodes.length === 300, null, { timeout: 15000 });
      const ms = await p3.evaluate(() => { const t = performance.now(); for (let i = 0; i < 20; i++) window.obGraph._draw(performance.now()); return (performance.now() - t) / 20; });
      assert.ok(ms < 16, `a frame of 300 dots draws in under 16ms (took ${ms.toFixed(2)}ms)`);
      assert.deepEqual(e3, []); assert.deepEqual(s3, []);
      await c3.close();
    }

    // ---------- phone, 375px ----------
    {
      const { ctx: cm, page: pm, errors: em, supabase: sm } = await openApp(browser, base, { viewport: { width: 375, height: 760 }, mobile: true });
      await pm.waitForSelector('#plannerTimeline .pl-item');
      for (const name of ['today', 'jobs', 'voice', 'url', 'youtube', 'pdf', 'gaps', 'quiz', 'library', 'graph', 'thoughts', 'review']) {
        await pm.evaluate((n) => window.obGo(n), name);
        await pm.waitForTimeout(250);
        const w = await pm.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
        assert.ok(w.doc <= w.vw && w.body <= w.vw, `${name}: no sideways scroll at 375px (${JSON.stringify(w)})`);
      }
      await pm.evaluate(() => window.obGo('graph'));
      await pm.waitForFunction(() => window.obGraph._state.nodes.length >= 60);
      await pm.waitForTimeout(300);
      const small = await pm.evaluate(() => [...document.querySelectorAll('#tabbar [data-screen], #graphZoomIn, #graphZoomOut, #graphFit, #screen-brain .chip')]
        .filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length);
      assert.equal(small, 0, 'phone nav and map buttons are at least 44px');
      // tap a dot: preview card with an Open button
      const cb = await pm.locator('#graphCanvas').boundingBox();
      const t = await pm.evaluate(() => { const n = window.obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; return window.obGraph._screenOf(n.id); });
      await pm.touchscreen.tap(cb.x + t.x, cb.y + t.y);
      await pm.waitForSelector('#graphTip:not([hidden]) .gt-open');
      await pm.click('.gt-open');
      await pm.waitForSelector('#graphSheet.open');
      assert.deepEqual(em, []); assert.deepEqual(sm, []);
      await cm.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
});
