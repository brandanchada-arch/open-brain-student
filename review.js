// Brain screen: Review tab (core memory, Nov 3, 2026).
// Every Sunday weekly-condenser updates your brain pages (core, job-search, courses, mega).
// Most changes apply on their own; only big personal ones wait for Approve here. Undo puts
// back the page from before the last change (press again to go further back).
// Reads use your own login (row-level security keeps it to your rows). Approve / Reject /
// Undo go through the review-proposal function, which checks who you are from your login.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const PAGE_ORDER = ['core', 'job-search', 'courses', 'mega'];
  const PAGE_NAMES = { core: 'Core', 'job-search': 'Job search', courses: 'Courses', mega: 'MEGA' };

  let pages = [];
  let proposals = [];
  let notes = [];
  let droppedItems = [];
  let autoChanges = [];
  let busy = false;

  const panel = $('panel-review');
  panel.innerHTML = `
    <div id="rvHealth"></div>
    <div class="rv-head"><h2>Waiting for review</h2>
      <button class="secondary" id="rvUndo" type="button">Undo last change</button></div>
    <div class="gq-meta">Only big personal changes wait here. Everything else updates on its own each Sunday, and Undo reverses the latest change.</div>
    <div id="rvMsg" role="status"></div>
    <div id="rvList"><div class="pl-empty">Loading…</div></div>
    <div class="section-title"><span>Updated automatically</span></div>
    <div id="rvAuto"></div>
    <div class="section-title"><span>Your pages</span></div>
    <div id="rvPages"></div>
    <div class="section-title"><span>What Claude noticed about you</span></div>
    <div class="gq-meta">Saved automatically from your sessions. Delete anything that's wrong.</div>
    <div id="rvNotes"></div>
    <div class="section-title"><span>Dropped from your core page</span></div>
    <div class="gq-meta">Lines that left your core page, and when.</div>
    <div id="rvDropped"></div>`;

  const pageName = (slug) => (pages.find(p => p.slug === slug) || {}).title || PAGE_NAMES[slug] || slug;
  const pageText = (slug) => (pages.find(p => p.slug === slug) || {}).current_text || '';
  const when = (t) => (t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');

  function say(text, ok) {
    const el = $('rvMsg');
    el.innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}">${esc(text)}</div>`;
    clearTimeout(el._h); el._h = setTimeout(() => { el.innerHTML = ''; }, 6000);
  }

  function textBlock(text, cls = '') {
    const t = String(text || '');
    return t.trim()
      ? `<div class="rv-text ${cls}">${esc(t)}</div>`
      : `<div class="rv-text rv-empty ${cls}">(empty)</div>`;
  }

  function sourcesList(src) {
    const list = Array.isArray(src) ? src : [];
    if (!list.length) return '';
    return `<div class="rv-label">Based on</div><ul class="rv-sources">${
      list.map(s => `<li>${esc((s && (s.label || s.kind)) || 'a note')}</li>`).join('')}</ul>`;
  }

  function proposalCard(p) {
    return `<div class="thought-card rv-card" data-rv-id="${esc(p.id)}">
      <div class="thought-meta">${esc(pageName(p.target_slug))} page · ${esc(when(p.created_at))}</div>
      ${p.sensitive ? '<div class="rv-warn">⚠ Sensitive: this may include private details (health, money, relationships, journal…). Read it carefully before approving.</div>' : ''}
      ${p.reason ? `<div class="rv-reason">${esc(p.reason)}</div>` : ''}
      <div class="rv-label">Now</div>${textBlock(pageText(p.target_slug))}
      <div class="rv-label">Proposed</div>${textBlock(p.proposed_text, 'rv-new')}
      ${sourcesList(p.source_ids)}
      <div class="rv-actions">
        <button type="button" data-rv-act="approve">Approve</button>
        <button class="secondary" type="button" data-rv-act="reject">Reject</button>
      </div></div>`;
  }

  function pageCard(p) {
    const hasHistory = String(p.history_text || '').trim();
    return `<div class="thought-card rv-page">
      <div class="rv-page-title">${esc(p.title || PAGE_NAMES[p.slug] || p.slug)}</div>
      <div class="thought-meta">${p.updated_at ? 'Updated ' + esc(when(p.updated_at)) : ''}</div>
      <div class="rv-label">Current</div>${textBlock(p.current_text)}
      ${hasHistory ? `<details><summary>History</summary>${textBlock(p.history_text)}</details>` : ''}</div>`;
  }

  function render() {
    $('rvList').innerHTML = proposals.length
      ? proposals.map(proposalCard).join('')
      : '<div class="pl-empty">Nothing waiting for you.</div>';
    $('rvAuto').innerHTML = autoChanges.length ? autoChanges.map(a => `<div class="thought-card">
        <div class="thought-meta">${esc(pageName(a.target_slug))} page · ${esc(when(a.reviewed_at))}</div>
        <div>${esc(a.reason)}</div></div>`).join('')
      : '<div class="pl-empty">No automatic updates yet.</div>';
    const sorted = [...pages].sort((a, b) => {
      const ia = PAGE_ORDER.indexOf(a.slug), ib = PAGE_ORDER.indexOf(b.slug);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.slug).localeCompare(String(b.slug));
    });
    $('rvPages').innerHTML = sorted.length ? sorted.map(pageCard).join('')
      : '<div class="pl-empty">No pages yet. They are made the first time the weekly condenser runs.</div>';
    $('rvNotes').innerHTML = notes.length ? notes.map(n => `<div class="thought-card" data-rv-note="${esc(n.id)}">
        <div class="thought-meta">${esc(when(n.created_at))}${n.project ? ' · ' + esc(n.project) : ''}</div>
        <div>${esc(n.note)}</div>
        <div class="rv-actions"><button class="secondary" type="button" data-rv-note-del>Delete</button></div></div>`).join('')
      : '<div class="pl-empty">Nothing yet. Notes appear after your Claude Code sessions.</div>';
    $('rvDropped').innerHTML = droppedItems.length ? droppedItems.map(d => `<div class="thought-card">
        <div class="thought-meta">Dropped ${esc(when(d.dropped_at))}</div>
        <div>${esc(d.item)}</div>
        ${d.reason ? `<div class="rv-reason">${esc(d.reason)}</div>` : ''}</div>`).join('')
      : '<div class="pl-empty">Nothing has dropped off yet.</div>';
  }

  // Brain health card. Extra, so if it can't load the card just stays away.
  function healthCard(h) {
    const problems = Array.isArray(h.problems) ? h.problems : [];
    const info = h.info || {};
    const facts = [
      [info.proposals_waiting, 'waiting for review'],
      [info.flagged_library, 'flagged in the library'],
      [info.stale_notes, 'not touched in 60+ days'],
      [info.older_untagged, 'older notes without tags'],
    ].filter(([n]) => Number(n) > 0).map(([n, label]) => `${Number(n)} ${label}`);
    return `<div class="thought-card rv-card">
      <div class="rv-page-title">Brain health: ${problems.length ? `${problems.length} to fix` : 'all good'}</div>
      ${problems.map(p => `<div class="rv-warn">⚠ ${esc(p.text)}</div>`).join('')}
      ${facts.length ? `<div class="thought-meta">${esc(facts.join(' · '))}</div>` : ''}
    </div>`;
  }

  async function loadHealth() {
    try {
      const { health } = await act({ action: 'health' });
      $('rvHealth').innerHTML = health ? healthCard(health) : '';
    } catch { $('rvHealth').innerHTML = ''; }
  }

  async function loadReview() {
    if (busy) return;
    loadHealth();
    try {
      const [pr, pg, nt, dr, au] = await Promise.all([
        sb.from('brain_proposals')
          .select('id, target_slug, proposed_text, reason, source_ids, sensitive, created_at')
          .eq('status', 'pending').order('created_at', { ascending: true }).limit(50),
        sb.from('brain_pages').select('slug, title, current_text, history_text, updated_at'),
        sb.from('about_me_notes').select('id, note, project, created_at').order('created_at', { ascending: false }).limit(100),
        sb.from('core_dropped_items').select('item, reason, dropped_at').order('dropped_at', { ascending: false }).limit(200),
        sb.from('brain_proposals').select('target_slug, reason, reviewed_at')
          .eq('status', 'approved').eq('auto_applied', true).order('reviewed_at', { ascending: false }).limit(20),
      ]);
      if (pr.error) throw pr.error;
      if (pg.error) throw pg.error;
      proposals = pr.data || [];
      pages = pg.data || [];
      // These lists shouldn't stop the rest of the tab from loading.
      notes = (nt && !nt.error && nt.data) || [];
      droppedItems = (dr && !dr.error && dr.data) || [];
      autoChanges = (au && !au.error && au.data) || [];
      render();
    } catch (err) {
      if (!proposals.length && !pages.length) $('rvList').innerHTML = '';
      say(navigator.onLine ? (err.message || 'Could not load your pages.') : 'Review needs a connection.', false);
    }
  }
  window.loadReview = loadReview;

  // Calls review-proposal. supabase-js hides the function's own error, so read it.
  async function act(body) {
    if (!navigator.onLine) throw new Error('This needs a connection.');
    const { data, error } = await sb.functions.invoke('review-proposal', { body });
    if (error) {
      let reason = '';
      try { reason = (await error.context.json()).error || ''; } catch { /* not JSON */ }
      throw new Error(reason || error.message);
    }
    if (!data || data.ok === false) throw new Error((data && data.error) || 'Something went wrong.');
    return data;
  }

  function setButtons(disabled) {
    panel.querySelectorAll('button').forEach(b => { b.disabled = disabled; });
  }

  $('rvList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-rv-act]');
    const card = ev.target.closest('[data-rv-id]');
    if (!btn || !card || busy) return;
    const p = proposals.find(x => x.id === card.dataset.rvId);
    if (!p) return;
    const action = btn.dataset.rvAct;
    if (action === 'approve' && p.sensitive &&
        !confirm(`This change to your ${pageName(p.target_slug)} page is marked SENSITIVE.\n\nIt will be part of what Claude reads about you at the start of chats.\n\nApprove it?`)) return;
    busy = true; setButtons(true);
    try {
      await act({ action, id: p.id });
      say(action === 'approve' ? `${pageName(p.target_slug)} page updated. You can undo it.` : 'Rejected. The page was not changed.', true);
    } catch (err) {
      say(err.message || 'Could not save that.', false);
    } finally {
      busy = false; setButtons(false);
      loadReview();
    }
  });

  $('rvNotes').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-rv-note-del]');
    const card = ev.target.closest('[data-rv-note]');
    if (!btn || !card || busy) return;
    if (!confirm('Delete this note? Claude will no longer see it.')) return;
    busy = true; setButtons(true);
    try {
      const { error } = await sb.from('about_me_notes').delete().eq('id', card.dataset.rvNote);
      if (error) throw error;
      say('Note deleted.', true);
    } catch (err) {
      say(err.message || 'Could not delete that.', false);
    } finally {
      busy = false; setButtons(false);
      loadReview();
    }
  });

  $('rvUndo').addEventListener('click', async () => {
    if (busy) return;
    if (!confirm('Undo the last approved change? The page goes back to how it was before it.')) return;
    busy = true; setButtons(true);
    try {
      const r = await act({ action: 'undo' });
      say(`Undone. ${r.slug ? pageName(r.slug) + ' page' : 'The page'} is back to how it was.`, true);
    } catch (err) {
      say(err.message || 'Could not undo.', false);
    } finally {
      busy = false; setButtons(false);
      loadReview();
    }
  });
})();
