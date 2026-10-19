// shell.js — the phone-app shell for design C (Capture First), Oct 2026.
// - Bottom tab bar: Today · Jobs · Capture · Study · Brain (the 10 old tabs live inside these)
// - Offline: saved copies of Today, Jobs and Recent; thoughts typed offline wait in a queue
//   on this phone and save themselves when the connection comes back
// - Quick capture box and "From your brain" card on Today
// - iPhone details: no zoom, tab bar hides while typing, scroll position kept per screen
// Everything here talks to Supabase with your own login (sb + currentUser from index.html).

(function () {
  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  // Saved copies for offline. Small on purpose (no full transcripts).
  window.obCache = {
    put(key, value) { store.set('ob.cache.' + key, { at: Date.now(), value }); },
    get(key) { return store.get('ob.cache.' + key); },
  };

  function toast(text, ok = true) {
    let t = $('obToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'obToast'; t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:30;bottom:calc(env(safe-area-inset-bottom,0px) + 92px);max-width:calc(100% - 40px);padding:12px 16px;border-radius:16px;font-size:15px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.4);transition:opacity .2s;';
      document.body.appendChild(t);
    }
    t.style.background = ok ? '#14301F' : '#331816'; t.style.color = ok ? '#4ADE80' : '#FCA5A5';
    t.textContent = text; t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  }

  // ---------- saving thoughts (works offline) ----------
  const OUTBOX = 'ob.outbox';
  const looksOffline = (err) => !navigator.onLine || /fetch|network|load failed/i.test(String(err && (err.message || err)));

  async function upsertThought(row) {
    const { error } = await sb.from('thoughts').upsert(
      { ...row, user_id: currentUser.id },
      { onConflict: 'dedup_key,user_id', ignoreDuplicates: false });
    if (error) throw error;
  }

  // Returns { queued: true } when it had to wait for a connection.
  window.obSaveThought = async function (row) {
    if (!row || !String(row.content || '').trim()) throw new Error('Nothing to save yet.');
    if (navigator.onLine) {
      try { await upsertThought(row); return { queued: false }; }
      catch (err) { if (!looksOffline(err)) throw err; }
    }
    const box = store.get(OUTBOX) || [];
    box.push({ row, at: Date.now() });
    if (!store.set(OUTBOX, box)) throw new Error('Could not save on this phone (storage is full or private mode).');
    updateOutboxBadge();
    return { queued: true };
  };

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !navigator.onLine || typeof currentUser === 'undefined' || !currentUser) return;
    const box = store.get(OUTBOX) || [];
    if (!box.length) return;
    flushing = true;
    let sent = 0;
    try {
      while (box.length) {
        try { await upsertThought(box[0].row); box.shift(); sent++; store.set(OUTBOX, box); }
        catch (err) { if (looksOffline(err)) break; console.warn('Outbox item failed, keeping it:', err); break; }
      }
    } finally { flushing = false; updateOutboxBadge(); }
    if (sent) { toast(`${sent} saved ${sent === 1 ? 'thought' : 'thoughts'} sent to your brain`); if (current.screen === 'brain') loadRecent(); }
  }
  function updateOutboxBadge() {
    const n = (store.get(OUTBOX) || []).length;
    const bar = document.querySelector('.offline-bar');
    if (bar) bar.textContent = navigator.onLine
      ? `${n} ${n === 1 ? 'thought is' : 'thoughts are'} waiting to send…`
      : `You're offline. Showing your last saved copy.${n ? ` ${n} new ${n === 1 ? 'thought' : 'thoughts'} will send when you're back.` : ' New thoughts save when you\'re back.'}`;
    document.body.classList.toggle('offline', !navigator.onLine || n > 0);
  }

  // ---------- offline copies of Today and Jobs ----------
  // planner.js / jobs.js draw these boxes; after a good load we keep a copy of what they drew.
  const SNAP = { today: ['plannerWaiting', 'plannerTimeline', 'plannerTray'], jobs: ['jobsList'] };
  function saveSnap(name) {
    if (!SNAP[name].some(id => $(id) && $(id).innerHTML.trim())) return;   // never overwrite a good copy with an empty/failed load
    obCache.put('snap.' + name, SNAP[name].map(id => ($(id) ? $(id).innerHTML : '')));
  }
  function showSnap(name) {
    const s = obCache.get('snap.' + name);
    SNAP[name].forEach((id, i) => { if ($(id)) { $(id).innerHTML = s ? s.value[i] : ''; $(id).classList.add('stale'); } });
    if (!s && $(SNAP[name][0])) $(SNAP[name][0]).innerHTML = '<div class="pl-empty">No saved copy yet. Open this once while online.</div>';
  }
  function wrapLoader(fnName, snapName) {
    const orig = window[fnName];
    if (typeof orig !== 'function') return;
    window[fnName] = async function (...args) {
      if (!navigator.onLine) { showSnap(snapName); return; }
      SNAP[snapName].forEach(id => $(id) && $(id).classList.remove('stale'));
      const r = await orig.apply(this, args);
      saveSnap(snapName);
      return r;
    };
  }
  wrapLoader('loadPlanner', 'today');
  wrapLoader('loadJobs', 'jobs');

  // ---------- pdf.js on demand ----------
  let pdfPromise = null;
  window.obLoadPdfJs = function () {
    if (window.pdfjsLib) return Promise.resolve();
    if (!pdfPromise) pdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve(); };
      s.onerror = () => { pdfPromise = null; reject(new Error('Could not load the PDF reader. Check your connection.')); };
      document.head.appendChild(s);
    });
    return pdfPromise;
  };

  // ---------- voice typing for any box (used by Study answers) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  window.obDictate = function (textarea, button) {
    if (!SR) { toast('Voice typing isn\'t supported in this browser', false); return; }
    if (button._rec) { button._rec.stop(); return; }
    const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    const start = textarea.value ? textarea.value.trimEnd() + ' ' : '';
    button._rec = rec; button.classList.add('listening'); button.setAttribute('aria-pressed', 'true');
    rec.onresult = (e) => {
      let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      textarea.value = start + t; textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    rec.onend = rec.onerror = () => { button._rec = null; button.classList.remove('listening'); button.setAttribute('aria-pressed', 'false'); };
    rec.start();
  };

  // ---------- screens and tabs ----------
  const SCREEN_OF = {
    today: 'today', jobs: 'jobs', capture: 'capture', study: 'study', brain: 'brain',
    voice: 'capture', url: 'capture', youtube: 'capture', pdf: 'capture',
    gaps: 'study', quiz: 'study', graph: 'brain', map: 'brain', thoughts: 'brain', search: 'brain', recent: 'brain',
  };
  const SUB_ALIAS = { search: 'thoughts', recent: 'thoughts', map: 'graph' };
  const DEFAULT_SUB = { capture: 'voice', study: 'gaps', brain: 'graph' };
  const lastSub = { capture: 'voice', study: 'gaps', brain: 'graph' };
  const scrollPos = {};
  const current = { screen: 'today', sub: null };

  function load(screen, sub) {
    if (screen === 'today' && window.loadPlanner) loadPlanner();
    if (screen === 'jobs' && window.loadJobs) loadJobs();
    if (screen === 'study' && sub === 'gaps' && window.loadGaps) loadGaps(false);
    if (screen === 'study' && sub === 'quiz' && window.loadQuiz) loadQuiz(false);
    if (screen === 'brain' && sub === 'graph' && window.obGraph) obGraph.show();
    if (screen === 'brain' && sub === 'thoughts' && !$('searchResults').innerHTML) loadRecent();
  }

  function go(name, opts = {}) {
    const screen = SCREEN_OF[name] || 'today';
    const sub = DEFAULT_SUB[screen] ? (name === screen ? lastSub[screen] : (SUB_ALIAS[name] || name)) : null;
    // The map only animates while you're looking at it (saves battery).
    if (window.obGraph && !(screen === 'brain' && sub === 'graph')) obGraph.hide();
    const sameScreen = screen === current.screen;
    if (!sameScreen) scrollPos[current.screen] = window.scrollY;

    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + screen));
    document.querySelectorAll('#tabbar [data-screen]').forEach(b => {
      const on = b.dataset.screen === screen;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (sub) {
      lastSub[screen] = sub;
      const scr = $('screen-' + screen);
      scr.querySelectorAll('.chip[data-sub]').forEach(c => { c.classList.toggle('active', c.dataset.sub === sub); c.setAttribute('aria-selected', c.dataset.sub === sub); });
      scr.querySelectorAll(':scope > .sub').forEach(p => p.classList.toggle('active', p.id === 'panel-' + sub));
    }
    current.screen = screen; current.sub = sub;

    const hash = '#' + (sub || screen);
    if (location.hash !== hash) history.replaceState(null, '', hash);
    if (!sameScreen) window.scrollTo(0, opts.top ? 0 : (scrollPos[screen] || 0));
    if (opts.load !== false) load(screen, sub);
  }
  window.obGo = go;
  // Old code (and Telegram links) still say showTab('jobs') etc.; it maps to the new screens.
  window.showTab = (name) => go(name, { load: false });

  function routeFromHash() {
    const h = (location.hash || '').replace('#', '');
    go(SCREEN_OF[h] ? h : 'today', { top: true });
  }

  document.querySelectorAll('#tabbar [data-screen]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.screen === current.screen) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    go(b.dataset.screen);
  }));
  document.querySelectorAll('.chip[data-sub]').forEach(c => c.addEventListener('click', () => go(c.dataset.sub)));
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (SCREEN_OF[h] && (SUB_ALIAS[h] || h) !== (current.sub || current.screen)) go(h, { top: true });
  });

  // ---------- iPhone feel ----------
  // Hide the tab bar while the keyboard is up, so it doesn't float over what you type.
  const isTyping = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(el.type)));
  document.addEventListener('focusin', (e) => { if (isTyping(e.target)) document.body.classList.add('typing'); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!isTyping(document.activeElement)) document.body.classList.remove('typing'); }, 80));
  // iOS ignores maximum-scale for pinch; this stops pinch-zoom in the installed app.
  ['gesturestart', 'gesturechange'].forEach(ev => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

  // ---------- Today: greeting + quick capture ----------
  function greet() {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = (window.OB_NAME || (currentUser && currentUser.user_metadata && currentUser.user_metadata.first_name) || '').trim();
    $('greeting').textContent = name ? `${part}, ${name}` : part;
  }

  const QUICK_DRAFT = 'ob.quick.draft';
  const quick = $('quickText');
  quick.value = store.get(QUICK_DRAFT) || '';
  quick.addEventListener('input', () => store.set(QUICK_DRAFT, quick.value));
  $('quickSave').addEventListener('click', async () => {
    const text = quick.value.trim();
    if (!text) { quick.focus(); return; }
    const btn = $('quickSave'); btn.disabled = true;
    try {
      const r = await obSaveThought({ content: text });
      quick.value = ''; store.del(QUICK_DRAFT); quick.blur();
      toast(r.queued ? 'Saved on this phone. Sends when you\'re online.' : 'Saved to your brain');
    } catch (err) {
      toast(err.message || 'Save failed', false);
    } finally { btn.disabled = false; }
  });
  $('quickVoice').addEventListener('click', () => {
    go('voice', { top: true });
    const typed = quick.value.trim();
    if (typed) $('voiceTranscript').value = typed;
    if ($('micBtn') && !$('micBtn').disabled) $('micBtn').click();
  });
  $('quickLink').addEventListener('click', () => { go('url', { top: true }); setTimeout(() => $('urlInput').focus(), 50); });
  $('quickPdf').addEventListener('click', () => { go('pdf', { top: true }); $('pdfInput').click(); });

  // ---------- Today: "From your brain" ----------
  let resurfacePool = [];
  async function loadResurface() {
    try {
      if (navigator.onLine) {
        const before = new Date(Date.now() - 2 * 864e5).toISOString();
        const { data, error } = await sb.from('thoughts')
          .select('id, summary, category, created_at')
          .not('summary', 'is', null)
          .or('category.is.null,category.neq.digest')
          .lt('created_at', before)
          .order('created_at', { ascending: false })
          .limit(80);
        if (error) throw error;
        resurfacePool = data || [];
        obCache.put('resurface', resurfacePool);
      } else {
        resurfacePool = (obCache.get('resurface') || {}).value || [];
      }
    } catch (err) {
      console.warn('From your brain:', err);
      resurfacePool = (obCache.get('resurface') || {}).value || [];
    }
    showResurface();
  }
  async function showResurface() {
    if (!resurfacePool.length) { $('resurfaceWrap').style.display = 'none'; return; }
    const t = resurfacePool[Math.floor(Math.random() * resurfacePool.length)];
    const when = new Date(t.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const card = $('resurface');
    card.dataset.id = t.id; card.dataset.open = '';
    card.setAttribute('role', 'button'); card.tabIndex = 0;
    card.innerHTML = `<div class="meta"><span>${esc(when)}${t.category ? ' · ' + esc(t.category) : ''}</span><span id="resurfaceLinks"></span></div>
      <div class="text">${esc(t.summary)}</div><div class="hint" style="margin-top:8px;">Tap to read it</div>`;
    $('resurfaceWrap').style.display = '';
    if (navigator.onLine) {
      try {
        const { count } = await sb.from('thought_links').select('id', { count: 'exact', head: true })
          .or(`source_thought_id.eq.${t.id},target_thought_id.eq.${t.id}`);
        if (count && card.dataset.id === t.id) $('resurfaceLinks').textContent = ` · linked to ${count} ${count === 1 ? 'thought' : 'thoughts'}`;
      } catch { /* the count is a nice-to-have */ }
    }
  }
  async function openResurface() {
    const card = $('resurface');
    if (card.dataset.open) return;
    card.dataset.open = '1';
    const textEl = card.querySelector('.text'), hint = card.querySelector('.hint');
    if (!navigator.onLine) { hint.textContent = 'Opening the full thought needs a connection.'; card.dataset.open = ''; return; }
    hint.textContent = 'Opening…';
    try {
      const { data, error } = await sb.from('thoughts').select('content').eq('id', card.dataset.id).single();
      if (error) throw error;
      const full = String(data.content || '');
      textEl.style.whiteSpace = 'pre-wrap';
      textEl.textContent = full.length > 1500 ? full.slice(0, 1500) + '…' : full;
      hint.textContent = '';
    } catch (err) { hint.textContent = 'Could not open it.'; card.dataset.open = ''; }
  }
  $('resurface').addEventListener('click', openResurface);
  $('resurface').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openResurface(); } });
  $('resurfaceNext').addEventListener('click', showResurface);

  // ---------- connection changes ----------
  window.addEventListener('online', () => { updateOutboxBadge(); flushOutbox(); if (currentUser) load(current.screen, current.sub); checkConnection(); });
  window.addEventListener('offline', () => { updateOutboxBadge(); const d = $('statusDot'); if (d) d.className = 'dot off'; });

  // ---------- sign in / out (called from index.html) ----------
  window.obShell = {
    onSignedIn() {
      $('tabbar').style.display = '';
      greet();
      if (!navigator.onLine) { const d = $('statusDot'); if (d) d.className = 'dot off'; }
      updateOutboxBadge();
      routeFromHash();
      loadResurface();
      flushOutbox();
    },
    onSignedOut() { $('tabbar').style.display = 'none'; },
  };
})();
