// Screenshots of the design-v3 redesign, on demo data only, from a local server.
// Run: node scripts/design-review/shoot.mjs   → PNGs in design-review/
// Requests that leave 127.0.0.1 get an empty reply (nothing is sent anywhere).
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../../tests/design-v3/static-server.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = ROOT + 'design-review/';
const srv = await startServer();
const browser = await chromium.launch();

async function open(viewport, query = '', mobile = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => r.request().url().startsWith(srv.url) ? r.continue() : r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.goto(srv.url + 'index.html' + query);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page };
}
const go = async (page, name, wait = 700) => { await page.evaluate((n) => obGo(n), name); await page.waitForTimeout(wait); };
const shot = (page, name, full = true) => page.screenshot({ path: OUT + name, fullPage: full });

// Login
{ const { ctx, page } = await open({ width: 1280, height: 860 }, '?login=1'); await page.waitForTimeout(500); await shot(page, 'login.png', false); await ctx.close(); }

// Desktop
{
  const { ctx, page } = await open({ width: 1280, height: 860 });
  await page.waitForSelector('#plannerTimeline .pl-item'); await page.waitForTimeout(600);
  await shot(page, 'home-desktop.png', false);
  await shot(page, 'tab-today-desktop.png');
  await go(page, 'jobs'); await shot(page, 'tab-jobs-desktop.png');
  await go(page, 'voice'); await shot(page, 'tab-capture-desktop.png');
  await go(page, 'gaps'); await page.click('#gapsBtn'); await page.waitForSelector('#gapCard'); await shot(page, 'tab-study-desktop.png');
  await go(page, 'quiz'); await page.click('#quizBtn'); await page.waitForTimeout(700); await shot(page, 'tab-quiz-desktop.png');
  await go(page, 'library'); await page.click('#libList .lib-item >> nth=3'); await page.waitForSelector('#libReader .door-flag'); await page.evaluate(() => scrollTo(0, 0)); await shot(page, 'tab-library-desktop.png');
  await go(page, 'thoughts'); await page.fill('#searchInput', 'cash flow'); await page.click('#askBtn'); await page.waitForSelector('.ask-card'); await shot(page, 'tab-thoughts-desktop.png');
  await go(page, 'review'); await page.waitForSelector('.rv-card'); await shot(page, 'tab-review-desktop.png');
  await go(page, 'graph', 900); await page.evaluate(() => scrollTo(0, 0)); await shot(page, 'tab-brain-desktop.png', false);
  await page.locator('.graph-wrap').scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  await shot(page, 'graph-desktop.png', false);
  const box = await page.locator('#graphCanvas').boundingBox();
  const pos = await page.evaluate(() => { const n = obGraph._state.nodes.slice().sort((a, b) => b.deg - a.deg)[1]; return obGraph.screenPos(n.id); });
  await page.mouse.move(box.x + pos.x, box.y + pos.y); await page.waitForTimeout(300);
  await shot(page, 'graph-hover.png', false);
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.click('#graphLegend .legend-chip >> nth=4'); await page.click('#graphLegend .legend-chip >> nth=5');
  await page.fill('#graphMinLinks', '2');
  await page.fill('#graphSearch', 'interview'); await page.press('#graphSearch', 'Enter'); await page.waitForTimeout(600);
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(200);
  await shot(page, 'graph-filtered.png', false);
  await ctx.close();
}

// Phone (375 wide)
{
  const { ctx, page } = await open({ width: 375, height: 812 }, '', true);
  await page.waitForSelector('#plannerTimeline .pl-item'); await page.waitForTimeout(600);
  await shot(page, 'home-mobile.png', false);
  await go(page, 'graph', 900);
  await page.evaluate(() => scrollTo(0, 230)); await page.waitForTimeout(300);
  await shot(page, 'graph-mobile.png', false);
  await ctx.close();
}
// 300-note map
{ const { ctx, page } = await open({ width: 1280, height: 860 }, '?nodes=300#graph'); await page.waitForTimeout(1200); await page.locator('.graph-wrap').scrollIntoViewIfNeeded(); await shot(page, 'graph-300-desktop.png', false); await ctx.close(); }

await browser.close(); await srv.close();
console.log('saved to', OUT);
