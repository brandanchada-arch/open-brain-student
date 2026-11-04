// Fix 2: the Today tab shows the morning summary from bc-calendar {action: "summary"}.
// Uses the real planner.js function and the page's real `esc` (copied out of planner.js
// by text, so a change to esc is tested too). All data is made up. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PLANNER = new URL('../../planner.js', import.meta.url);
const { plannerSummaryHtml } = require(fileURLToPath(PLANNER));
const src = readFileSync(PLANNER, 'utf8');
const escLine = src.match(/^\s*const esc = (s => .*);$/m);
assert.ok(escLine, 'planner.js still has its esc helper');
const esc = (0, eval)(escLine[1]);

const BAD = ['<script>alert(1)</script>', '<img src=x onerror="alert(2)">'];
const ok = (summary, waiting = []) => ({ data: { ok: true, summary, waiting }, error: null });
const SUM = { text: 'Made-up: 2 meetings today.\nEmail: "Your invoice"', created_at: '2026-11-04T07:00:00Z', delivered: false };

test('shows the summary text and the waiting list', () => {
  const html = plannerSummaryHtml(ok(SUM, [{ kind: 'email', text: 'Made-up: reply to the dean', created_at: '2026-11-04T06:00:00Z' }]), esc);
  assert.match(html, /Morning summary/);
  assert.match(html, /2 meetings today\./);
  assert.match(html, /Still waiting/);
  assert.match(html, /reply to the dean/);
  assert.match(html, /pl-chip">email</);
  assert.doesNotMatch(html, /<details/, 'not delivered yet, so it is shown open');
});

test('delivered and nothing waiting: folded away in a <details>', () => {
  const html = plannerSummaryHtml(ok({ ...SUM, delivered: true }), esc);
  assert.match(html, /^<details class="card"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /2 meetings today/);
});

test('delivered but something waiting: shown open', () => {
  const html = plannerSummaryHtml(ok({ ...SUM, delivered: true }, [{ kind: 'task', text: 'Made-up task' }]), esc);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /Made-up task/);
});

test('no summary but something waiting: shows just the waiting list', () => {
  const html = plannerSummaryHtml(ok(null, [{ kind: 'x', text: 'Made-up waiting item' }]), esc);
  assert.doesNotMatch(html, /Morning summary/);
  assert.match(html, /Made-up waiting item/);
});

test('failures and older bc-calendar versions show nothing (no error)', () => {
  const cases = [
    undefined, null, {}, { data: null, error: null },
    { data: null, error: { message: 'Edge Function returned a non-2xx status code' } },
    { data: { error: 'Unknown action' }, error: null },          // older bc-calendar
    { data: { ok: false, error: 'unknown_action' }, error: null },
    { data: { ok: true }, error: null },                          // nothing yet
    ok(null, []), ok({ text: '   ' }, []), ok({ text: 42 }), ok(null, 'not a list'),
    ok(null, [null, { text: '' }, { kind: 'x' }]),
    { data: 'some text', error: null },
  ];
  for (const c of cases) assert.equal(plannerSummaryHtml(c, esc), '', JSON.stringify(c));
});

test('made-up <script> and <img onerror> stay text, everywhere outside text appears', () => {
  for (const bad of BAD) {
    const html = plannerSummaryHtml(ok({ text: bad, created_at: bad, delivered: false },
      [{ kind: bad, text: bad, created_at: bad }]), esc);
    assert.doesNotMatch(html, /<script|<img/i, 'no real tag made it through');
    assert.ok(html.includes(esc(bad)), 'shown as escaped text');
    const folded = plannerSummaryHtml(ok({ text: bad, delivered: true }), esc);
    assert.doesNotMatch(folded, /<script|<img/i);
  }
});

test('in a real browser the bad text creates no elements and runs nothing', async (t) => {
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
  if (!chromium) return t.skip('Playwright is not installed');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', (r) => r.abort());
    await page.setContent('<!doctype html><div id="plannerSummary"></div>');
    const html = plannerSummaryHtml(ok({ text: BAD.join(' '), delivered: false },
      [{ kind: BAD[1], text: BAD[0] }, { kind: 'email', text: BAD[1] }]), esc);
    const out = await page.evaluate((h) => {
      window.alerted = false; window.alert = () => { window.alerted = true; };
      const box = document.getElementById('plannerSummary');
      box.innerHTML = h;
      return new Promise((done) => setTimeout(() => done({
        scripts: box.querySelectorAll('script').length, imgs: box.querySelectorAll('img').length,
        alerted: window.alerted, text: box.textContent,
      }), 200));
    }, html);
    assert.equal(out.scripts, 0);
    assert.equal(out.imgs, 0);
    assert.equal(out.alerted, false);
    assert.ok(out.text.includes('<script>alert(1)</script>'), 'the words are visible as plain text');
    assert.ok(out.text.includes('<img src=x onerror="alert(2)">'));
  } finally { await browser.close(); }
});

// The real planner.js, loaded in a browser on the real Today markup from index.html, with a FAKE `sb`.
test('the Today tab asks bc-calendar for the summary and shows it; an old bc-calendar shows nothing', async (t) => {
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
  if (!chromium) return t.skip('Playwright is not installed');
  const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const start = index.indexOf('<div class="sub active" id="panel-today">');
  const end = index.indexOf('<div id="plannerGoalMsg"></div>');
  assert.ok(start > 0 && end > start, 'found the Today markup in index.html');
  const markup = index.slice(start, end) + '<div id="plannerGoalMsg"></div>'; // the browser closes the open tags
  const fakeSb = (summaryReply) => `
    window.calls = [];
    function q() { const p = new Proxy(function(){}, { get(_t, k) {
      if (k === 'then') return (res) => res({ data: [], error: null });
      if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
      return () => p; } }); return p; }
    window.sb = {
      from: () => q(),
      rpc: async () => ({ data: [], error: null }),
      functions: { invoke: async (name, { body }) => {
        calls.push({ name, body });
        if (body.action === 'summary') return ${summaryReply};
        return { data: { connected: false, events: [] }, error: null };
      } },
    };
    window.currentUser = { id: 'made-up-user' };`;
  const browser = await chromium.launch();
  try {
    for (const [label, reply, expectShown] of [
      ['new bc-calendar', JSON.stringify(ok({ text: 'Made-up summary. ' + BAD.join(' '), created_at: '2026-11-04T07:00:00Z', delivered: false },
        [{ kind: 'email', text: 'Made-up waiting ' + BAD[1], created_at: '2026-11-04T06:00:00Z' }])), true],
      ['older bc-calendar (error reply)', '{ data: null, error: { message: "Edge Function returned a non-2xx status code" } }', false],
      ['invoke throws', '(() => { throw new Error("network down"); })()', false],
    ]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.route('**/*', (r) => r.abort());
      await page.setContent(`<!doctype html><body>${markup}</body>`);
      // Added as script tags (not inline HTML) so a made-up "</script>" in the data can't end them early.
      await page.addScriptTag({ content: fakeSb(reply) });
      await page.addScriptTag({ content: src });
      await page.evaluate(() => { window.alert = () => { window.alerted = true; }; return window.loadPlanner(); });
      await page.waitForTimeout(300);
      const out = await page.evaluate(() => ({
        asked: calls.some((c) => c.name === 'bc-calendar' && c.body.action === 'summary'),
        html: document.getElementById('plannerSummary').innerHTML,
        text: document.getElementById('plannerSummary').textContent,
        bad: document.querySelectorAll('#plannerSummary script, #plannerSummary img').length,
        notes: document.getElementById('plannerNotes').textContent,
        alerted: !!window.alerted,
      }));
      assert.ok(out.asked, `${label}: asked for {action: "summary"} (notes: ${out.notes}; errors: ${errors})`);
      assert.equal(out.bad, 0, `${label}: no script/img elements`);
      assert.equal(out.alerted, false);
      assert.deepEqual(errors, [], `${label}: no page errors`);
      assert.doesNotMatch(out.notes, /summary/i, `${label}: no error message about the summary`);
      if (expectShown) {
        assert.match(out.text, /Morning summary/);
        assert.ok(out.text.includes('Made-up summary. <script>alert(1)</script>'));
        assert.match(out.text, /Still waiting/);
      } else {
        assert.equal(out.html, '', `${label}: shows nothing`);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
