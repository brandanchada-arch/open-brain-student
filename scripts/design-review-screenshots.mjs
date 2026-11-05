// Takes the design-review screenshots (demo data only) into design-review/.
// Usage: node scripts/design-review-screenshots.mjs   (needs Playwright + Chromium)
// Requests to Supabase are blocked; fonts load if the network allows, other outside files are stubbed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './design-review-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('../design-review/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();

async function open(opts) {
  const page = await browser.newPage(opts);
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (/supabase\.(co|in)/.test(u)) return r.abort();
    if (u.startsWith(base) || /fonts\.(googleapis|gstatic)\.com/.test(u)) return r.continue();
    return r.fulfill({ status: 200, body: '', contentType: 'text/javascript' });
  });
  return page;
}
const go = async (page, hash, wait = 900) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(wait); };
const shot = (page, name, full = false) => page.screenshot({ path: OUT + name, fullPage: full });

const desk = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
let page = await open(desk);
await page.goto(base + '?login=1');
await page.waitForSelector('#authScreen', { state: 'visible' });
await page.waitForTimeout(600);
await shot(page, 'login.png');
await page.close();

page = await open(desk);
await page.goto(base + '#today');
await page.waitForSelector('#app', { state: 'visible' });
await page.waitForTimeout(1500);
await shot(page, 'home-desktop.png');
await shot(page, 'tab-today-desktop.png', true);
for (const [hash, name] of [['jobs', 'jobs'], ['voice', 'capture'], ['url', 'capture-link'], ['gaps', 'study-gaps'], ['quiz', 'study-quiz'],
  ['library', 'study-library'], ['thoughts', 'brain-thoughts'], ['review', 'brain-review'], ['graph', 'brain-map']]) {
  await go(page, hash, 1100);
  await shot(page, `tab-${name}-desktop.png`);
}
// Graph
await go(page, 'graph', 900);
await shot(page, 'graph-desktop.png');
const n = await page.evaluate(() => { const G = window.obGraph._state; const x = G.nodes.slice().sort((a, b) => b.deg - a.deg)[1]; return window.obGraph._screenPos(x.id); });
await page.mouse.move(n.x, n.y);
await page.waitForTimeout(400);
await shot(page, 'graph-hover.png');
await page.mouse.move(5, 5);
await page.click('#graphLegend [data-topic="3"]');
await page.click('#graphLegend [data-topic="6"]');
await page.fill('#graphSearch', 'interest');
await page.press('#graphSearch', 'Enter');
await page.waitForTimeout(700);
await shot(page, 'graph-filtered.png');
await page.close();

const phone = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
page = await open(phone);
await page.goto(base + '#today');
await page.waitForSelector('#app', { state: 'visible' });
await page.waitForTimeout(1500);
await shot(page, 'home-mobile.png');
await go(page, 'graph', 1200);
await shot(page, 'graph-mobile.png');
await page.close();

await browser.close();
server.close();
console.log('Screenshots saved in design-review/');
