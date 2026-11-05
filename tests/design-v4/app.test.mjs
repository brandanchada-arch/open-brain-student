// Design v4 ("glass"): the whole app in a headless browser, on DEMO DATA only.
// Loads index.html from a local static server with demo-mode.js and checks that:
//   - nothing ever reaches a supabase.co address
//   - every tab and sub-tab opens with no console errors
//   - the thought map's hover card, zoom, search and filters work, and it stays fast with 300 dots
//   - nothing scrolls sideways on a 375px-wide phone, and the tab bar buttons are big enough to tap
// Needs Playwright with Chromium (pre-installed in the cloud computer). Skips if missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, openApp } from './harness.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }

const TABS = ['today', 'jobs', 'voice', 'url', 'youtube', 'pdf', 'gaps', 'quiz', 'library', 'graph', 'thoughts', 'review'];

async function dotOnScreen(page, pick = 'hub') {
  return page.evaluate((which) => {
    const G = window.obGraph._state;
    const shown = G.nodes.filter((n) => !G.hiddenTopics.has(n.c1) && n.deg >= G.minLinks);
    const n = which === 'hub' ? shown.slice().sort((a, b) => b.deg - a.deg)[0] : shown[0];
    const p = window.obGraph._toScreen(n);
    const r = document.getElementById('graphCanvas').getBoundingClientRect();
    return { id: n.id, x: r.left + p.sx, y: r.top + p.sy, deg: n.deg };
  }, pick);
}

test('design v4: every tab works on demo data, the map works, phone width fits', { skip: !chromium && 'Playwright not installed' }, async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    // ---------- computer ----------
    const { page, context, log } = await openApp(browser, server.url);
    await page.waitForFunction(() => document.getElementById('greeting').textContent.includes('Riley'));
    assert.ok(await page.isVisible('#demoBadge'), 'the "Demo data" badge shows');

    for (const tab of TABS) {
      await page.evaluate((t) => window.obGo(t, { top: true }), tab);
      await page.waitForTimeout(350);
      const visible = await page.evaluate(() => [...document.querySelectorAll('.screen.active')].length);
      assert.equal(visible, 1, `${tab}: one screen is showing`);
    }
    // a few real clicks through the navigation, so the buttons themselves are tested too
    for (const s of ['jobs', 'capture', 'study', 'brain', 'today']) {
      await page.click(`#tabbar [data-screen="${s}"]`);
      await page.waitForSelector(`#screen-${s}.active`);
    }
    await page.click('#tabbar [data-screen="study"]');
    await page.click('.chip[data-sub="library"]');
    await page.waitForSelector('[data-lib-id="lib-4"]');
    await page.click('[data-lib-id="lib-4"]');
    await page.waitForSelector('#libReader .door-flag');       // the door-check warning on a flagged demo entry
    await page.click('#tabbar [data-screen="brain"]');
    await page.click('.chip[data-sub="thoughts"]');
    await page.waitForSelector('#recentList .thought-card');
    await page.fill('#searchInput', 'budget');
    await page.click('#searchBtn');
    await page.waitForSelector('#searchResults .thought-card');
    await page.click('.chip[data-sub="review"]');
    await page.waitForSelector('[data-rv-id="bp-1"]');

    // ---------- the map ----------
    await page.click('.chip[data-sub="graph"]');
    await page.waitForFunction(() => window.obGraph._state.nodes.length === 60);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#graphLegend [data-topic]').count(), 6, 'legend has the 6 demo topics');

    // hover shows the preview card with topic and connection count
    const hub = await dotOnScreen(page);
    await page.mouse.move(hub.x, hub.y);
    await page.waitForSelector('#graphHover.show');
    const card = await page.textContent('#graphHover');
    assert.match(card, new RegExp(`${hub.deg} connections`));
    assert.match(card, /Finance|Courses|Job Search|Real Estate|AI Tools|Personal/);
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => document.getElementById('graphHover').hidden);

    // click opens the full note sheet
    const again = await dotOnScreen(page);
    await page.mouse.click(again.x, again.y);
    await page.waitForSelector('#graphSheet.open');
    await page.click('[data-gs-open]');
    await page.waitForSelector('#gsText.full');
    await page.click('[data-gs-close]');

    // zoom: buttons, wheel, reset
    const k = () => page.evaluate(() => window.obGraph._state.target.k);
    const k0 = await k();
    await page.click('#graphZoomIn');
    assert.ok(await k() > k0 * 1.3, 'zoom in button');
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => window.obGraph._state.cam.k) > k0 * 1.2, 'the camera glides to the new zoom');
    await page.click('#graphZoomOut');
    const box = await page.locator('#graphCanvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const kw = await k();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(100);
    assert.ok(await k() > kw, 'wheel zooms in');
    // drag pans
    const before = await page.evaluate(() => ({ ...window.obGraph._state.cam }));
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 260, { steps: 6 }); await page.mouse.up();
    const after = await page.evaluate(() => ({ ...window.obGraph._state.cam }));
    assert.ok(Math.abs(after.x - before.x) > 1, 'drag moves the map');
    await page.click('#graphFit');

    // search highlights and focuses
    await page.fill('#graphSearch', 'interview');
    await page.waitForFunction(() => window.obGraph._state.matches && window.obGraph._state.matches.size > 0);
    assert.match(await page.textContent('#graphSearchCount'), /match/);
    const matchIds = await page.evaluate(() => [...window.obGraph._state.matches]);
    const labels = await page.evaluate((ids) => ids.map((id) => window.obGraph._state.byId.get(id).label.toLowerCase()), matchIds);
    assert.ok(labels.every((l) => l.includes('interview')), 'only matching notes are highlighted');
    await page.waitForTimeout(700);
    const inView = await page.evaluate((ids) => {
      const G = window.obGraph._state;
      return ids.every((id) => { const p = window.obGraph._toScreen(G.byId.get(id)); return p.sx > 0 && p.sy > 0 && p.sx < G.W && p.sy < G.H; });
    }, matchIds);
    assert.ok(inView, 'the map moved so every match is on screen');
    await page.fill('#graphSearch', '');
    await page.waitForFunction(() => window.obGraph._state.matches === null);

    // filters: topic toggle and minimum connections
    await page.click('#graphLegend [data-topic="1"]');
    assert.equal(await page.getAttribute('#graphLegend [data-topic="1"]', 'aria-pressed'), 'false');
    let shown = await page.evaluate(() => { const G = window.obGraph._state; return G.nodes.filter((n) => !G.hiddenTopics.has(n.c1) && n.deg >= G.minLinks).length; });
    assert.equal(shown, 50, 'hiding Finance hides its 10 notes');
    assert.match(await page.textContent('#graphCount'), /50 of 60/);
    await page.locator('#graphMinLinks').fill('4');
    await page.dispatchEvent('#graphMinLinks', 'input');
    shown = await page.evaluate(() => { const G = window.obGraph._state; return G.nodes.filter((n) => !G.hiddenTopics.has(n.c1) && n.deg >= G.minLinks).every((n) => n.deg >= 4 && n.c1 !== 1); });
    assert.ok(shown, 'min links keeps only well-connected notes');
    await page.click('#graphFit');
    assert.equal(await page.evaluate(() => window.obGraph._state.hiddenTopics.size), 0, 'reset clears the filters');

    // sign out shows the sign-in screen, signing in again works (demo auth)
    await page.click('#signOutBtn');
    await page.waitForSelector('#authScreen', { state: 'visible' });
    await page.fill('#authEmail', 'someone@example.com'); await page.fill('#authPassword', 'anything');
    await page.click('#authSubmit');
    await page.waitForSelector('#app', { state: 'visible' });

    // writes stay in memory: save a thought, it shows in Recent
    await page.evaluate(() => window.obGo('today', { top: true }));
    await page.fill('#quickText', 'Made-up test note from the design test');
    await page.click('#quickSave');
    await page.waitForSelector('#obToast');
    await page.evaluate(() => window.obGo('thoughts', { top: true }));
    await page.click('#searchClearBtn');                 // back from the earlier search to Recent
    await page.evaluate(() => loadRecent());
    await page.waitForFunction(() => document.getElementById('recentList').textContent.includes('Made-up test note'));

    assert.deepEqual(log.errors, [], 'no console errors on any tab');
    assert.deepEqual(log.supabase, [], 'no request ever went to supabase.co');
    await context.close();

    // ---------- 300 dots stay smooth ----------
    {
      const { page, context, log } = await openApp(browser, server.url, { path: '/index.html?nodes=300#graph' });
      await page.waitForFunction(() => window.obGraph._state.nodes.length === 300, null, { timeout: 30000 });
      const ms = await page.evaluate(() => {
        const t0 = performance.now();
        for (let i = 0; i < 30; i++) window.obGraph._draw();
        return (performance.now() - t0) / 30;
      });
      assert.ok(ms < 20, `one frame of the 300-dot map takes ${ms.toFixed(1)} ms (should be under 20)`);
      const big = await dotOnScreen(page);
      await page.mouse.move(big.x, big.y);
      await page.waitForSelector('#graphHover.show');
      assert.deepEqual(log.errors, []);
      assert.deepEqual(log.supabase, []);
      await context.close();
    }

    // ---------- phone, 375px wide ----------
    {
      const { page, context, log } = await openApp(browser, server.url, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
      await page.waitForFunction(() => document.getElementById('greeting').textContent.includes('Riley'));
      for (const tab of TABS) {
        await page.evaluate((t) => window.obGo(t, { top: true }), tab);
        await page.waitForTimeout(250);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(over <= 0, `${tab}: no sideways scroll at 375px (overflow ${over}px)`);
      }
      const small = await page.evaluate(() => [...document.querySelectorAll('#tabbar button, .graph-zoom button, #graphLinks, .chip, #graphLegend button')]
        .filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
      assert.equal(small, 0, 'navigation and map controls are at least 44px');
      // tap a dot: preview card; tap it again: the note opens
      await page.evaluate(() => window.obGo('graph', { top: true }));
      await page.waitForFunction(() => window.obGraph._state.nodes.length === 60);
      await page.waitForTimeout(300);
      const d = await dotOnScreen(page);
      await page.touchscreen.tap(d.x, d.y);
      await page.waitForSelector('#graphHover.show.pinned');
      await page.click('[data-gh-open]');
      await page.waitForSelector('#graphSheet.open');
      assert.deepEqual(log.errors, []);
      assert.deepEqual(log.supabase, []);
      await context.close();
    }

    // ---------- sign-in screen ----------
    {
      const { page, context, log } = await openApp(browser, server.url, { path: '/index.html?login=1' });
      await page.waitForSelector('#authScreen', { state: 'visible' });
      assert.equal(await page.isVisible('#app'), false);
      assert.deepEqual(log.errors, []);
      assert.deepEqual(log.supabase, []);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
