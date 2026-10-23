// Study screen: Library tab (Reference Library, Oct 22, 2026).
// Class notes, transcripts, articles, PDFs and weekly digests live in the `library` table,
// not in your thoughts. This tab lists them (filter by course, type, topic), searches them
// (search-brain with library: true), opens one in a reader, and "Quiz me" asks daily-quiz
// for 3 questions from random notes for the chosen course/topic.
// Reads use your own login (row-level security keeps it to your rows).

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const READER_PAGE = 6000;   // characters shown at a time in the reader
  const TYPE_NAMES = {
    'class-notes': 'Class notes', transcript: 'Transcript', digest: 'Digest', reference: 'Reference',
    'sim-data': 'Sim data', 'personal-doc': 'Personal doc', article: 'Article',
  };
  const typeName = (t) => TYPE_NAMES[t] || t || 'Other';

  let entries = [];        // everything in the library (no full text)
  let loadedAt = 0;
  let searchResults = null; // null = not searching

  const filters = () => ({ course: $('libCourse').value, doc_type: $('libType').value, topic: $('libTopic').value });

  function fillSelect(sel, values, allLabel, nameOf = (v) => v) {
    const keep = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map(v => `<option value="${esc(v)}">${esc(nameOf(v))}</option>`).join('');
    sel.value = values.includes(keep) ? keep : '';
  }
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));

  function refreshFilters() {
    const f = filters();
    fillSelect($('libCourse'), uniq(entries.map(e => e.course)), 'All courses');
    fillSelect($('libType'), uniq(entries.filter(e => !f.course || e.course === f.course).map(e => e.doc_type)), 'All types', typeName);
    // Topics follow the chosen course and type, so the list stays short.
    fillSelect($('libTopic'), uniq(entries.filter(e => (!f.course || e.course === f.course) && (!f.doc_type || e.doc_type === f.doc_type)).map(e => e.topic)), 'All topics');
  }

  function matches(e) {
    const f = filters();
    return (!f.course || e.course === f.course) && (!f.doc_type || e.doc_type === f.doc_type) && (!f.topic || e.topic === f.topic);
  }

  function card(e, extra = '') {
    const when = new Date(e.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const bits = [typeName(e.doc_type), e.course, e.topic].filter(Boolean).map(esc).join(' · ');
    return `<div class="thought-card lib-item" role="button" tabindex="0" data-lib-id="${esc(e.id)}">
      <div class="thought-meta">${bits} · ${esc(when)}</div>
      <div class="lib-title">${esc(e.title || 'Untitled')}</div>${extra}</div>`;
  }

  function render() {
    const list = $('libList');
    const meta = $('libMeta');
    if (searchResults) {
      meta.textContent = `${searchResults.length} ${searchResults.length === 1 ? 'match' : 'matches'} for “${$('libSearchInput').value.trim()}”`;
      list.innerHTML = searchResults.length
        ? searchResults.map(r => card(r, r.matched_chunk
            ? `<div class="thought-content" style="border-left:3px solid var(--line-2); padding-left:10px; margin-top:8px; color:var(--muted);">${esc(r.matched_chunk.slice(0, 400))}${r.matched_chunk.length > 400 ? '…' : ''}</div>`
            : '')).join('') + '<button class="linkish" id="libClearSearch" type="button">Clear search</button>'
        : '<div class="pl-empty">No matches.</div><button class="linkish" id="libClearSearch" type="button">Clear search</button>';
      return;
    }
    const shown = entries.filter(matches);
    meta.textContent = entries.length ? `${shown.length} of ${entries.length} entries` : '';
    list.innerHTML = shown.length ? shown.map(e => card(e)).join('')
      : `<div class="pl-empty">${entries.length ? 'Nothing matches these filters.' : 'Your library is empty. PDFs, links and YouTube videos you capture land here.'}</div>`;
  }

  async function loadLibrary(force) {
    if (!force && entries.length && Date.now() - loadedAt < 60_000) { refreshFilters(); render(); return; }
    try {
      const { data, error } = await sb.from('library')
        .select('id, title, doc_type, course, topic, created_at')
        .order('created_at', { ascending: false }).limit(1000);
      if (error) throw error;
      entries = data || [];
      loadedAt = Date.now();
      obCache.put('library', entries);   // titles only, never the text
    } catch (err) {
      const saved = obCache.get('library');
      if (saved) entries = saved.value || [];
      else showMsg($('libMsg'), esc(navigator.onLine ? (err.message || 'Could not load the library.') : 'The library needs a connection.'), false);
    }
    refreshFilters();
    render();
  }
  window.loadLibrary = loadLibrary;

  // ---------- reader ----------
  async function openEntry(id) {
    const reader = $('libReader');
    reader.hidden = false;
    reader.innerHTML = '<div class="hint">Opening…</div>';
    reader.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const { data, error } = await sb.from('library')
        .select('id, title, content, doc_type, course, topic, source_url, created_at').eq('id', id).single();
      if (error) throw error;
      showPage(data, 1);
    } catch (err) {
      reader.innerHTML = `<div class="msg err">${esc(navigator.onLine ? (err.message || 'Could not open it.') : 'Opening needs a connection.')}</div>`;
    }
  }

  function showPage(e, page) {
    const reader = $('libReader');
    const text = String(e.content || '');
    const pages = Math.max(1, Math.ceil(text.length / READER_PAGE));
    const bits = [typeName(e.doc_type), e.course, e.topic].filter(Boolean).map(esc).join(' · ');
    reader.innerHTML = `
      <div class="section-title" style="margin:0;"><span class="lib-title">${esc(e.title || 'Untitled')}</span>
        <button class="linkish" type="button" data-lib-close>Close</button></div>
      <div class="thought-meta">${bits}${/^https?:\/\//i.test(e.source_url || '') ? ` · <a href="${esc(e.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</div>
      <div class="lib-text">${esc(text.slice(0, page * READER_PAGE))}</div>
      ${page < pages ? `<button class="secondary" type="button" data-lib-more style="width:100%; margin-top:12px;">Show more (${page} of ${pages})</button>` : ''}`;
    reader._entry = e; reader._page = page;
  }

  $('libReader').addEventListener('click', (ev) => {
    const reader = $('libReader');
    if (ev.target.closest('[data-lib-close]')) { reader.hidden = true; reader.innerHTML = ''; return; }
    if (ev.target.closest('[data-lib-more]') && reader._entry) showPage(reader._entry, reader._page + 1);
  });

  $('libList').addEventListener('click', (ev) => {
    if (ev.target.closest('#libClearSearch')) { searchResults = null; $('libSearchInput').value = ''; render(); return; }
    const item = ev.target.closest('[data-lib-id]');
    if (item) openEntry(item.dataset.libId);
  });
  $('libList').addEventListener('keydown', (ev) => {
    const item = ev.target.closest('[data-lib-id]');
    if (item && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openEntry(item.dataset.libId); }
  });

  // ---------- filters + search ----------
  ['libCourse', 'libType', 'libTopic'].forEach(id => $(id).addEventListener('change', () => {
    refreshFilters();
    if (searchResults) runSearch(); else render();
  }));

  async function runSearch() {
    const q = $('libSearchInput').value.trim();
    if (!q) { searchResults = null; render(); return; }
    document.activeElement && document.activeElement.blur();   // close the phone keyboard
    $('libList').innerHTML = '<div class="pl-empty">Searching…</div>';
    try {
      const f = filters();
      const { data, error } = await sb.functions.invoke('search-brain', { body: {
        query: q, library: true, limit: 20,
        course: f.course || null, doc_type: f.doc_type || null, topic: f.topic || null,
      } });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Search failed.');
      searchResults = data.results || [];
      render();
    } catch (err) {
      searchResults = null;
      render();
      showMsg($('libMsg'), esc(navigator.onLine ? (err.message || 'Search failed.') : 'Search needs a connection.'), false);
    }
  }
  $('libSearchForm').addEventListener('submit', (ev) => { ev.preventDefault(); runSearch(); });

  // ---------- Quiz me ----------
  $('libQuizBtn').addEventListener('click', async () => {
    const f = filters();
    const btn = $('libQuizBtn');
    if (!f.course && !f.topic) { showMsg($('libMsg'), 'Pick a course or a topic first.', false); return; }
    btn.disabled = true; btn.textContent = 'Writing your quiz…';
    try {
      await window.obQuizFor(f.course, f.topic);
    } catch (err) {
      showMsg($('libMsg'), esc(err.message || 'Could not get a quiz.'), false);
    } finally {
      btn.disabled = false; btn.textContent = 'Quiz me';
    }
  });
})();
