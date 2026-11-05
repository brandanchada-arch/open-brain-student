// Takes the design-review screenshots from a local copy of the app running on DEMO DATA.
// Run from the repo folder:  node design-review/take-screenshots.mjs
// Needs Playwright with Chromium. Never contacts Supabase (see tests/design-v4/harness.mjs).
import { createRequire } from 'node:module';
import { startServer, openApp } from '../tests/design-v4/harness.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = new URL('./', import.meta.url).pathname;
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const server = await startServer();
const browser = await chromium.launch();
const shot = (page, name, full = false) => page.screenshot({ path: OUT + name + '.png', fullPage: full });
const settle = (page, ms = 900) => page.waitForTimeout(ms);
try {
  // Sign-in screen
  let { page, context, log } = await openApp(browser, server.url, { path: '/index.html?login=1', ...DESKTOP });
  await page.waitForSelector('#authScreen', { state: 'visible' }); await settle(page, 500);
  await shot(page, 'login'); await context.close();

  ({ page, context, log } = await openApp(browser, server.url, DESKTOP));
  await settle(page);
  await shot(page, 'home-desktop');
  const tabs = [
    ['today', 'today'], ['jobs', 'jobs'], ['capture', 'voice'], ['link', 'url'], ['youtube', 'youtube'], ['pdf', 'pdf'],
    ['gaps', 'gaps'], ['quiz', 'quiz'], ['library', 'library'], ['thoughts', 'thoughts'], ['review', 'review'],
  ];
  for (const [name, hash] of tabs) {
    await page.evaluate((h) => window.obGo(h, { top: true }), hash);
    await settle(page);
    if (name === 'gaps') { await page.click('#gapsBtn'); await settle(page, 700); }
    if (name === 'quiz') { await page.click('#quizBtn'); await settle(page, 700); await page.click('[data-quiz-show="0"]'); await settle(page, 400); }
    if (name === 'library') { await page.click('[data-lib-id="lib-1"]'); await settle(page, 800); await page.evaluate(() => window.scrollTo(0, 0)); }
    if (name === 'youtube') { await page.fill('#ytUrl', 'https://www.youtube.com/watch?v=demo0000001'); }
    await shot(page, `tab-${name}-desktop`);
  }
  await page.evaluate(() => window.obGo('graph', { top: true }));
  await settle(page, 1200);
  await shot(page, 'graph-desktop');
  const hub = await page.evaluate(() => { const G = obGraph._state; const n = G.nodes.slice().sort((a, b) => b.deg - a.deg)[0]; const p = obGraph._toScreen(n); const r = document.getElementById('graphCanvas').getBoundingClientRect(); return { x: r.left + p.sx, y: r.top + p.sy }; });
  await page.mouse.move(hub.x, hub.y); await settle(page, 600);
  await shot(page, 'graph-hover');
  await page.mouse.move(5, 5);
  await page.click('[data-topic="5"]'); await page.click('[data-topic="6"]');
  await page.fill('#graphMinLinks', '3'); await page.dispatchEvent('#graphMinLinks', 'input');
  await page.fill('#graphSearch', 'interview'); await settle(page, 1300);
  await shot(page, 'graph-filtered');
  if (log.supabase.length) throw new Error('Supabase was contacted: ' + log.supabase.join(', '));
  await context.close();

  ({ page, context, log } = await openApp(browser, server.url, PHONE));
  await settle(page);
  await shot(page, 'home-mobile');
  await page.evaluate(() => window.obGo('graph', { top: true }));
  await settle(page, 1200);
  await shot(page, 'graph-mobile');
  await context.close();
  console.log('Screenshots saved in design-review/');
} finally {
  await browser.close();
  await server.close();
}
