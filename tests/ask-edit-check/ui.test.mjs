// The three app files (ask.js, edit-thought.js, door-flag.js) in a headless browser, on a
// small copy of the Search / Recent / Library markup, with a FAKE `sb` Supabase client.
// No network: every page request except our local files is blocked.
// Needs Playwright with Chromium (pre-installed in the cloud computer). Skips if missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
const root = fileURLToPath(new URL('../../', import.meta.url));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <form class="search-row" id="searchForm"><input id="searchInput"><button id="searchBtn" type="submit">Search</button></form>
  <button id="searchClearBtn" style="display:none">Clear</button>
  <div id="searchResults"></div>
  <div class="sub active" id="panel-recent"><div id="recentList"></div></div>
  <div id="libReader" hidden></div>
  <script>
    // Same renderers as index.html (trimmed).
    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function renderThoughtCards(container, thoughts) {
      container.innerHTML = thoughts.map(t => '<div class="thought-card"><div class="thought-meta">date</div><div class="thought-content">' + escapeHtml(t.content) + '</div></div>').join('');
    }
    function renderSearchResults(container, results) { renderThoughtCards(container, results); }
    window.calls = [];
    const thoughts = {
      't-1': { id: 't-1', content: 'Made-up: meeting is Monday', created_at: '2026-10-01T09:00:00Z', outdated_at: null, replaced_by: null },
      't-2': { id: 't-2', content: 'Made-up: meeting moved to Tuesday', created_at: '2026-10-05T09:00:00Z', outdated_at: '2026-10-06T09:00:00Z', replaced_by: null },
    };
    function q(table) {
      const st = { table, filters: {} };
      const api = {
        select: (cols) => { st.cols = cols; return api; },
        eq: (c, v) => { st.filters[c] = v; return api; },
        in: (c, v) => { st.in = v; return api; },
        not: () => { st.notNull = true; return api; },
        order: () => api, limit: () => api,
        single: () => api.maybeSingle(),
        maybeSingle: () => Promise.resolve(run(st, true)),
        then: (ok, bad) => Promise.resolve(run(st, false)).then(ok, bad),
      };
      return api;
    }
    function run(st, one) {
      if (st.table === 'thoughts' && st.in) return { data: st.in.filter(id => thoughts[id]?.outdated_at).map(id => ({ id })), error: null };
      if (st.table === 'thoughts') return { data: thoughts[st.filters.id] || null, error: null };
      if (st.table === 'thought_versions') return { data: [{ content: 'Made-up original text', edited_at: '2026-10-02T09:00:00Z' }], error: null };
      if (st.table === 'library') return { data: { door_check: st.filters.id === 'lib-bad'
        ? { flagged: true, reasons: ['asks to ignore earlier instructions'], checked_at: 'x' }
        : { flagged: false, reasons: [], checked_at: 'x' } }, error: null };
      return { data: null, error: { message: 'unknown' } };
    }
    window.sb = {
      from: q,
      functions: { invoke: async (name, { body }) => {
        calls.push({ name, body });
        if (name === 'search-brain' && body.ask) return { data: { ok: true, ask: true, covered: true, answer: 'It moved to Tuesday [T1]. <b>not bold</b>',
          sources: [{ ref: 'T1', kind: 'thought', id: 't-2', title: 'Made-up: meeting moved', created_at: '2026-10-05', outdated: true }] }, error: null };
        if (name === 'search-brain') return { data: { ok: true, results: [thoughts['t-2']] }, error: null };
        if (name === 'edit-thought') return { data: { ok: true, status: 'saved' }, error: null };
        return { data: null, error: { message: 'unknown' } };
      } },
    };
  </script>
</body></html>`;

test('Ask button, Edit flow and door flag work in a browser (fake backend)', { skip: !chromium && 'Playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/*', (r) => r.abort());   // nothing leaves the browser
    await page.setContent(PAGE);
    for (const f of ['ask.js', 'edit-thought.js', 'door-flag.js']) await page.addScriptTag({ path: root + f });
    await page.addStyleTag({ path: root + 'ask-edit-check.css' });

    // --- Ask ---
    await page.fill('#searchInput', 'when is the meeting?');
    await page.click('#askBtn');
    await page.waitForSelector('.ask-card');
    const answer = await page.textContent('.ask-card .thought-content');
    assert.match(answer, /Tuesday \[T1\]/);
    assert.equal(await page.locator('.ask-card b').count(), 0, 'answer text is escaped, not HTML');
    assert.match(await page.textContent('.ask-sources'), /Outdated/);
    const askCall = await page.evaluate(() => calls.find((c) => c.body.ask));
    assert.deepEqual(askCall.body, { query: 'when is the meeting?', ask: true });

    // --- Edit: cards get Edit buttons and outdated badges ---
    await page.evaluate(() => renderThoughtCards(document.getElementById('recentList'), [
      { id: 't-1', content: 'Made-up: meeting is Monday', created_at: '2026-10-01' },
      { id: 't-2', content: 'Made-up: meeting moved to Tuesday', created_at: '2026-10-05' },
    ]));
    assert.equal(await page.locator('#recentList .et-edit').count(), 2);
    await page.waitForSelector('#recentList [data-thought-id="t-2"] .et-badge');
    assert.equal(await page.locator('#recentList [data-thought-id="t-1"] .et-badge').count(), 0);

    // Open the editor on t-1, change the text, mark outdated, pick t-2 as the replacement.
    await page.click('#recentList [data-thought-id="t-1"] .et-edit');
    await page.waitForSelector('.et-editor textarea');
    assert.equal(await page.inputValue('.et-editor textarea'), 'Made-up: meeting is Monday');
    await page.click('.et-history-btn');
    await page.waitForSelector('.et-version');
    await page.fill('.et-editor textarea', 'Made-up: meeting is Monday (old plan)');
    await page.check('.et-outdated');
    await page.fill('.et-find', 'tuesday');
    await page.click('.et-find-btn');
    await page.click('.et-choice');
    assert.match(await page.textContent('.et-picked'), /Replaced by/);
    await page.click('.et-save');
    await page.waitForSelector('.et-toast');
    const editCall = await page.evaluate(() => calls.find((c) => c.name === 'edit-thought'));
    assert.deepEqual(editCall.body, { id: 't-1', content: 'Made-up: meeting is Monday (old plan)', outdated: true, replaced_by: 't-2' });
    assert.match(await page.textContent('#recentList [data-thought-id="t-1"]'), /old plan/);

    // --- Door flag ---
    await page.evaluate(() => {
      const r = document.getElementById('libReader');
      r.hidden = false;
      r.innerHTML = '<div class="section-title">Title</div><div class="thought-meta">Article</div><div class="lib-text">text</div>';
      r._entry = { id: 'lib-bad' };
    });
    await page.waitForSelector('#libReader .door-flag');
    assert.match(await page.textContent('.door-flag'), /instructions to an AI/);
    await page.evaluate(() => {
      const r = document.getElementById('libReader');
      r.innerHTML = '<div class="thought-meta">Article</div>';
      r._entry = { id: 'lib-ok' };
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#libReader .door-flag').count(), 0, 'no flag on a clean entry');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
