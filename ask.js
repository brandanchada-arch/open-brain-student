// Brain → Search: "Ask" button (Ask mode, Nov 3, 2026).
// Search finds notes; Ask writes a short answer from your notes only (thoughts + library)
// and lists the notes it used. It runs in search-brain with {ask: true}; the server takes
// who you are from your login, and the AI only sees short excerpts of your notes.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const form = $('searchForm');
  if (!form || !$('searchBtn')) return;

  // The Ask button sits next to Search, in the same row.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'askBtn';
  btn.className = 'secondary';
  btn.textContent = 'Ask';
  btn.title = 'Get a short answer written from your notes';
  $('searchBtn').after(btn);

  function renderAnswer(container, data) {
    const when = (d) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const sources = (data.sources || []).map(s => `
      <li><span class="ask-ref">${esc(s.ref)}</span>
        ${s.kind === 'library' ? '<span class="ask-kind">Library</span>' : ''}
        ${s.outdated ? '<span class="ask-kind ask-old">Outdated</span>' : ''}
        <span>${esc(s.title)}</span> <span class="ask-date">${esc(when(s.created_at))}</span></li>`).join('');
    container.innerHTML = `
      <div class="thought-card ask-card${data.covered ? '' : ' ask-uncovered'}">
        <div class="thought-meta">Answer from your notes</div>
        <div class="thought-content">${esc(data.answer)}</div>
        ${sources ? `<div class="thought-meta ask-used">Notes used</div><ul class="ask-sources">${sources}</ul>` : ''}
        <div class="hint">AI-written from the notes above. Check the notes before relying on it.</div>
      </div>`;
  }

  btn.addEventListener('click', async () => {
    const q = $('searchInput').value.trim();
    const out = $('searchResults');
    if (!q) { $('searchInput').focus(); return; }
    document.activeElement && document.activeElement.blur();   // close the phone keyboard
    $('panel-recent')?.classList.remove('active');
    $('searchClearBtn').style.display = 'inline-flex';
    out.innerHTML = '<div class="pl-empty" style="text-align:center; padding:20px;">Reading your notes…</div>';
    btn.disabled = true;
    try {
      const { data, error } = await sb.functions.invoke('search-brain', { body: { query: q, ask: true } });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Ask failed.');
      renderAnswer(out, data);
    } catch (err) {
      out.innerHTML = `<div class="msg err">${esc(navigator.onLine ? (err.message || 'Ask failed.') : 'Ask needs a connection.')}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
})();
