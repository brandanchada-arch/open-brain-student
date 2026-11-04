// Brain → Thoughts: edit a thought, or mark it outdated (Nov 3, 2026).
// Adds an "Edit" button under every thought card in Recent and Search results.
// Saving goes through the edit-thought edge function, which keeps the old text in
// thought_versions, then rebuilds the embedding, links, chunks and tags.
// Outdated notes get a small "Outdated" badge; they rank lower in search and are left
// out of new links, quizzes and gap questions. Nothing is ever deleted.

(function () {
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const when = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Small message at the bottom of the screen (shell.js keeps its own toast private).
  function say(text, ok = true) {
    const el = document.createElement('div');
    el.className = 'et-toast' + (ok ? '' : ' err');
    el.setAttribute('role', 'status');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------- hook into the existing list renderers (index.html) ----------
  ['renderThoughtCards', 'renderSearchResults'].forEach((name) => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function (container, list) {
      original.apply(this, arguments);
      decorate(container, list || []);
    };
  });

  function decorate(container, list) {
    const cards = container.querySelectorAll(':scope > .thought-card');
    const ids = [];
    cards.forEach((card, i) => {
      const t = list[i];
      if (!t || !t.id) return;
      card.dataset.thoughtId = t.id;
      ids.push(t.id);
      const bar = document.createElement('div');
      bar.className = 'et-bar';
      bar.innerHTML = '<button class="linkish et-edit" type="button">Edit</button>';
      card.appendChild(bar);
    });
    if (ids.length) markOutdated(container, ids);
  }

  // Badge the outdated ones. Before the 2026-11-03 SQL runs this query errors: then no badges.
  async function markOutdated(container, ids) {
    try {
      const { data, error } = await sb.from('thoughts').select('id').in('id', ids).not('outdated_at', 'is', null);
      if (error) return;
      for (const row of data || []) {
        const card = container.querySelector(`[data-thought-id="${CSS.escape(row.id)}"]`);
        const meta = card && card.querySelector('.thought-meta');
        if (meta && !meta.querySelector('.et-badge')) meta.insertAdjacentHTML('beforeend', ' <span class="et-badge">Outdated</span>');
      }
    } catch (_) { /* offline: no badges */ }
  }

  // ---------- the editor ----------
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.et-edit');
    if (btn) openEditor(btn.closest('.thought-card'));
  });

  async function openEditor(card) {
    if (!card || card.querySelector('.et-editor')) return;
    if (!navigator.onLine) { say('Editing needs a connection.', false); return; }
    const id = card.dataset.thoughtId;
    const saved = card.innerHTML;
    card.innerHTML = '<div class="hint">Opening…</div>';
    let t;
    try {
      let res = await sb.from('thoughts').select('id, content, created_at, outdated_at, replaced_by').eq('id', id).single();
      if (res.error) res = await sb.from('thoughts').select('id, content, created_at').eq('id', id).single(); // before the new SQL
      if (res.error) throw res.error;
      t = res.data;
    } catch (err) {
      card.innerHTML = saved;
      say(err.message || 'Could not open that thought.', false);
      return;
    }

    const state = { replacedBy: t.replaced_by || null, replacedLabel: '' };
    if (state.replacedBy) {
      const { data } = await sb.from('thoughts').select('content').eq('id', state.replacedBy).maybeSingle();
      state.replacedLabel = data ? short(data.content, 90) : 'another note';
    }

    card.innerHTML = `
      <div class="et-editor">
        <div class="thought-meta">Editing a thought from ${esc(when(t.created_at))}</div>
        <textarea class="et-text" rows="6" aria-label="Thought text"></textarea>
        <label class="et-check"><input type="checkbox" class="et-outdated"> This note is outdated</label>
        <div class="et-replace" hidden>
          <div class="hint" style="margin-top:0;">Replaced by (optional): search for the newer note.</div>
          <div class="search-row">
            <input type="search" class="et-find" placeholder="Find the newer note…" aria-label="Find the note that replaces this one">
            <button type="button" class="secondary et-find-btn">Find</button>
          </div>
          <div class="et-picked"></div>
          <div class="et-results"></div>
        </div>
        <div class="et-actions">
          <button type="button" class="et-save">Save</button>
          <button type="button" class="secondary et-cancel">Cancel</button>
        </div>
        <button type="button" class="linkish et-history-btn">Earlier versions</button>
        <div class="et-history"></div>
        <div class="et-msg"></div>
      </div>`;
    const $ = (sel) => card.querySelector(sel);
    $('.et-text').value = t.content || '';
    $('.et-outdated').checked = !!t.outdated_at;
    $('.et-replace').hidden = !t.outdated_at;

    const showPicked = () => {
      $('.et-picked').innerHTML = state.replacedBy
        ? `<div class="et-pick-row">Replaced by: <b>${esc(state.replacedLabel)}</b> <button type="button" class="linkish et-unpick">remove</button></div>`
        : '';
    };
    showPicked();

    $('.et-outdated').addEventListener('change', () => { $('.et-replace').hidden = !$('.et-outdated').checked; });

    const find = async () => {
      const q = $('.et-find').value.trim();
      if (!q) return;
      $('.et-results').innerHTML = '<div class="hint">Searching…</div>';
      try {
        const { data, error } = await sb.functions.invoke('search-brain', { body: { query: q, limit: 6 } });
        if (error) throw error;
        const rows = (data?.results || []).filter((r) => r.id !== id).slice(0, 5);
        $('.et-results').innerHTML = rows.length
          ? rows.map((r) => `<button type="button" class="secondary et-choice" data-id="${esc(r.id)}" data-label="${esc(short(r.content, 90))}">${esc(short(r.content, 120))}</button>`).join('')
          : '<div class="hint">No matches.</div>';
      } catch (err) {
        $('.et-results').innerHTML = `<div class="msg err">${esc(err.message || 'Search failed.')}</div>`;
      }
    };
    $('.et-find-btn').addEventListener('click', find);
    $('.et-find').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });

    if (card._etBound) card.removeEventListener('click', card._etBound);
    card._etBound = (e) => {
      const choice = e.target.closest('.et-choice');
      if (choice) { state.replacedBy = choice.dataset.id; state.replacedLabel = choice.dataset.label; $('.et-results').innerHTML = ''; showPicked(); }
      if (e.target.closest('.et-unpick')) { state.replacedBy = null; showPicked(); }
      const version = e.target.closest('.et-version');
      if (version) { $('.et-text').value = version._text; $('.et-msg').innerHTML = '<div class="hint">Older text put back in the box. Press Save to keep it.</div>'; }
    };
    card.addEventListener('click', card._etBound);

    $('.et-history-btn').addEventListener('click', async () => {
      const box = $('.et-history');
      box.innerHTML = '<div class="hint">Loading…</div>';
      const { data, error } = await sb.from('thought_versions').select('content, edited_at')
        .eq('thought_id', id).order('edited_at', { ascending: false }).limit(10);
      if (error) { box.innerHTML = '<div class="hint">No history available yet.</div>'; return; }
      if (!data.length) { box.innerHTML = '<div class="hint">No earlier versions. This is the original text.</div>'; return; }
      box.innerHTML = '';
      for (const v of data) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'secondary et-version';
        b.innerHTML = `<span class="thought-meta">Before the edit on ${esc(when(v.edited_at))}</span><span>${esc(short(v.content, 200))}</span>`;
        b._text = v.content;   // kept on the button, not in the page HTML
        box.appendChild(b);
      }
    });

    $('.et-cancel').addEventListener('click', () => { card.innerHTML = saved; });

    $('.et-save').addEventListener('click', async () => {
      const text = $('.et-text').value.trim();
      const outdated = $('.et-outdated').checked;
      if (!text) { $('.et-msg').innerHTML = '<div class="msg err">A thought can’t be empty.</div>'; return; }
      const body = { id };
      if (text !== String(t.content || '').trim()) body.content = text;
      if (outdated !== !!t.outdated_at || (outdated && (state.replacedBy || null) !== (t.replaced_by || null))) {
        body.outdated = outdated;
        if (outdated) body.replaced_by = state.replacedBy;
      }
      if (!('content' in body) && !('outdated' in body)) { card.innerHTML = saved; return; }
      const btn = $('.et-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const { data, error } = await sb.functions.invoke('edit-thought', { body });
        // A 409 (same text as another note) arrives as an error with the reply inside.
        let reply = data;
        if (error && error.context && typeof error.context.json === 'function') reply = await error.context.json().catch(() => null);
        if (!reply?.ok) throw new Error(reply?.error || error?.message || 'Could not save.');
        const meta = `<div class="thought-meta">${esc(when(t.created_at))} · edited${outdated ? ' <span class="et-badge">Outdated</span>' : ''}</div>`;
        card.innerHTML = `${meta}<div class="thought-content">${esc(short(text, 500))}</div><div class="et-bar"><button class="linkish et-edit" type="button">Edit</button></div>`;
        say('Saved. Search and links update in a moment.');
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Save';
        $('.et-msg').innerHTML = `<div class="msg err">${esc(err.message || 'Could not save.')}</div>`;
      }
    });
    $('.et-text').focus();
  }
})();
