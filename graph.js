// graph.js — Brain screen > Map. v5 (design-v5, Nov 2026): an analytical network view.
//
// Data: the brain_graph() function in Supabase, called with your login (RLS applies):
//   { clusters: [{id, name, color, size}], nodes: [{id, label, cat, at, c1, c2, w}], edges: [[a, b, similarity]], at }
//
// What you see:
//   - dots = thoughts, colored by topic (legend chips double as topic filters); bigger = more connections
//   - lines = thought_links; "Strong only" keeps links with similarity 0.70+
//   - hover a dot (tap on a phone) for a preview card; click it (or "Open" on the card) for the full note
//   - wheel / drag / pinch to zoom and pan, or the + / − / reset buttons
//   - search highlights matching notes and zooms to them; "Min links" hides loosely connected notes
//   - the side panel ranks the most-connected notes and shows network totals
// No library: a small force layout computed once per load on a canvas, so it stays smooth at 300+ notes
// and works offline from the saved copy.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const STRONG = 0.70;
  const POLL_MS = 40000;
  const PALETTE = ['#3B82F6', '#14B8A6', '#F59E0B', '#A78BFA', '#22C55E', '#F472B6', '#38BDF8', '#F97316', '#94A3B8', '#E879F9'];
  const fmt = (n) => Number(n).toLocaleString();

  // seeded random: the map looks the same every time you open it
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  const G = {
    nodes: [], byId: new Map(), edges: [], clusters: [], cById: new Map(),
    k: 1, tx: 0, ty: 0, W: 0, H: 0, dpr: 1,
    strongOnly: false, hidden: new Set(), minDeg: 0, query: '', matches: new Set(),
    hover: null, selected: null, pointers: new Map(), pan: null, pinch: null, moved: false,
    visible: false, poll: 0, dirty: false, raf: 0, at: null, anim: null, frames: 0,
  };
  window.obGraphState = G;

  // ---------- data in ----------
  let loading = false;
  async function fetchGraph({ quiet } = {}) {
    if (loading) return;
    if (!navigator.onLine) {
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value); else $('graphStatus').textContent = 'Your map needs a connection the first time.';
      }
      return;
    }
    loading = true;
    if (!quiet && !G.nodes.length) $('graphStatus').textContent = 'Building the network…';
    try {
      const { data, error } = await sb.rpc('brain_graph');
      if (error) throw error;
      ingest(data);
      try { obCache.put('graph', data); } catch { /* storage full */ }
      $('graphStatus').textContent = '';
    } catch (err) {
      console.warn('brain_graph failed:', err);
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value);
        $('graphStatus').textContent = c ? '' : 'Could not load your map: ' + (err.message || 'unknown error');
      }
    } finally { loading = false; }
  }

  function ingest(data) {
    if (!data) return;
    const sameAt = G.at && data.at === G.at && G.nodes.length === (data.nodes || []).length;
    if (sameAt) return;
    const old = G.byId, fresh = old.size > 0;
    G.clusters = (data.clusters || []).slice().sort((a, b) => a.id - b.id);
    G.cById = new Map(G.clusters.map((c, i) => [c.id, { ...c, color: PALETTE[i % PALETTE.length], count: 0 }]));
    const nodes = (data.nodes || []).map(r => {
      const prev = old.get(r.id);
      return { id: r.id, label: String(r.label || '').trim() || '(empty note)', cat: r.cat, at: new Date(r.at).getTime(), c1: r.c1, deg: 0, nbr: new Map(),
        x: prev ? prev.x : NaN, y: prev ? prev.y : NaN, isNew: fresh && !prev };
    });
    G.nodes = nodes; G.byId = new Map(nodes.map(n => [n.id, n]));
    G.edges = (data.edges || []).map(([a, b, w]) => ({ a: G.byId.get(a), b: G.byId.get(b), w: Number(w) || 0 })).filter(e => e.a && e.b && e.a !== e.b);
    for (const e of G.edges) {
      e.a.deg++; e.b.deg++;
      e.a.nbr.set(e.b.id, Math.max(e.w, e.a.nbr.get(e.b.id) || 0));
      e.b.nbr.set(e.a.id, Math.max(e.w, e.b.nbr.get(e.a.id) || 0));
    }
    for (const n of nodes) { const c = G.cById.get(n.c1); if (c) c.count++; n.color = c ? c.color : '#94A3B8'; }
    G.maxDeg = nodes.reduce((m, n) => Math.max(m, n.deg), 0);
    const added = nodes.filter(n => n.isNew).length;
    layout(!fresh);
    if (G.selected) G.selected = G.byId.get(G.selected.id) || null;
    if (G.hover) G.hover = null;
    G.at = data.at;
    $('graphMin').max = String(Math.max(1, Math.min(20, G.maxDeg)));
    if (G.minDeg > G.maxDeg) setMinDeg(0);
    renderLegend(); applySearch(false); renderSide();
    $('graphCanvas').setAttribute('aria-label', `Network of ${nodes.length} notes in ${G.clusters.length} topics with ${G.edges.length} links`);
    if (!fresh) fit(false);
    if (added) note(`${added} new ${added === 1 ? 'note' : 'notes'} added to the map`);
    wake();
  }

  // ---------- force layout (runs once per load; deterministic) ----------
  function layout(firstTime) {
    const N = G.nodes.length;
    if (!N) return;
    const R = 160 + Math.sqrt(N) * 26;
    const cl = G.clusters.length || 1;
    const anchor = new Map(G.clusters.map((c, i) => {
      const a = (i / cl) * Math.PI * 2 - Math.PI / 2;
      return [c.id, { x: Math.cos(a) * R * 0.62, y: Math.sin(a) * R * 0.62 }];
    }));
    for (const n of G.nodes) {
      if (!firstTime && isFinite(n.x)) continue;
      const r = rng(hash(n.id)), A = anchor.get(n.c1) || { x: 0, y: 0 };
      const a = r() * Math.PI * 2, d = 20 + r() * R * 0.3;
      n.x = A.x + Math.cos(a) * d; n.y = A.y + Math.sin(a) * d;
    }
    const iters = N > 250 ? 220 : 300;
    const L = 46, cell = 90;
    for (let it = 0; it < iters; it++) {
      const alpha = 1 - it / iters;
      for (const n of G.nodes) { n.fx = 0; n.fy = 0; }
      // repulsion with a grid so far-apart notes are skipped
      const grid = new Map();
      for (const n of G.nodes) {
        const key = Math.floor(n.x / cell) + ',' + Math.floor(n.y / cell);
        (grid.get(key) || grid.set(key, []).get(key)).push(n);
      }
      for (const n of G.nodes) {
        const gx = Math.floor(n.x / cell), gy = Math.floor(n.y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get((gx + dx) + ',' + (gy + dy));
          if (!list) continue;
          for (const m of list) {
            if (m === n) continue;
            let x = n.x - m.x, y = n.y - m.y, d2 = x * x + y * y;
            if (d2 < 0.01) { x = (hash(n.id + m.id) % 7) - 3; y = 1; d2 = x * x + y * y; }
            if (d2 > cell * cell) continue;
            const f = 900 / d2;
            n.fx += x * f; n.fy += y * f;
          }
        }
      }
      for (const e of G.edges) {
        const x = e.b.x - e.a.x, y = e.b.y - e.a.y, d = Math.sqrt(x * x + y * y) || 1;
        const same = e.a.c1 === e.b.c1;
        const f = (d - L * (same ? 1 : 2.2)) * (same ? 0.06 : 0.015) / d;
        e.a.fx += x * f; e.a.fy += y * f; e.b.fx -= x * f; e.b.fy -= y * f;
      }
      for (const n of G.nodes) {
        const A = anchor.get(n.c1) || { x: 0, y: 0 };
        n.fx += (A.x - n.x) * 0.012 - n.x * 0.002;
        n.fy += (A.y - n.y) * 0.012 - n.y * 0.002;
        const step = 9 * alpha + 0.4;
        const m = Math.hypot(n.fx, n.fy);
        const s = m > step ? step / m : 1;
        n.x += n.fx * s; n.y += n.fy * s;
      }
    }
  }

  // ---------- view ----------
  const nodeR = (n) => 3.5 + Math.sqrt(n.deg) * 2.4;
  const screenR = (n) => nodeR(n) * Math.max(0.7, Math.min(1.8, Math.sqrt(G.k)));
  const toScreen = (n) => ({ x: n.x * G.k + G.tx, y: n.y * G.k + G.ty });
  const toWorld = (sx, sy) => ({ x: (sx - G.tx) / G.k, y: (sy - G.ty) / G.k });
  const isVisible = (n) => !G.hidden.has(n.c1) && n.deg >= G.minDeg;
  const edgeVisible = (e) => (!G.strongOnly || e.w >= STRONG) && isVisible(e.a) && isVisible(e.b);

  function resize() {
    const wrap = $('graphCanvas').parentElement, r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const firstSize = !G.W;
    G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    G.W = r.width; G.H = r.height;
    const c = $('graphCanvas'); c.width = Math.round(G.W * G.dpr); c.height = Math.round(G.H * G.dpr);
    if ((firstSize || !G.touched) && G.nodes.length) fit(false);
    wake();
  }

  function boundsOf(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    return { x0, y0, x1, y1 };
  }
  function viewFor(list, maxK = 3) {
    if (!list.length || !G.W) return { k: G.k, tx: G.tx, ty: G.ty };
    const b = boundsOf(list), pad = 48;
    const w = Math.max(60, b.x1 - b.x0), h = Math.max(60, b.y1 - b.y0);
    const k = Math.max(0.15, Math.min(maxK, Math.min((G.W - pad * 2) / w, (G.H - pad * 2) / h)));
    return { k, tx: G.W / 2 - (b.x0 + b.x1) / 2 * k, ty: G.H / 2 - (b.y0 + b.y1) / 2 * k };
  }
  function animateTo(v, ms = 380) {
    if (!ms || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { Object.assign(G, v); G.anim = null; wake(); return; }
    G.anim = { from: { k: G.k, tx: G.tx, ty: G.ty }, to: v, t0: performance.now(), ms };
    wake();
  }
  function fit(animate = true) {
    const list = G.nodes.filter(isVisible);
    const v = viewFor(list.length ? list : G.nodes, 2.2);
    animate ? animateTo(v) : (Object.assign(G, v), wake());
  }
  function zoomAt(f, sx = G.W / 2, sy = G.H / 2) {
    G.touched = true;
    const k = Math.max(0.15, Math.min(8, G.k * f));
    const w = toWorld(sx, sy);
    G.k = k; G.tx = sx - w.x * k; G.ty = sy - w.y * k;
    G.anim = null; wake();
  }

  // ---------- drawing ----------
  function wake() { G.dirty = true; if (G.visible && !G.raf) G.raf = requestAnimationFrame(frame); }
  function frame(now) {
    G.raf = 0;
    if (G.anim) {
      const t = Math.min(1, (now - G.anim.t0) / G.anim.ms), e = 1 - Math.pow(1 - t, 3);
      const { from, to } = G.anim;
      G.k = from.k + (to.k - from.k) * e; G.tx = from.tx + (to.tx - from.tx) * e; G.ty = from.ty + (to.ty - from.ty) * e;
      if (t >= 1) G.anim = null;
      G.dirty = true;
    }
    if (G.dirty) { G.dirty = false; draw(); }
    if (G.anim && G.visible) G.raf = requestAnimationFrame(frame);
    if (G.hover) placeHover();
  }

  function focusSet() {
    const s = G.selected || G.hover;
    if (s) return new Set([s.id, ...s.nbr.keys()]);
    if (G.query && G.matches.size) return G.matches;
    return null;
  }

  function draw() {
    G.frames++;
    const c = $('graphCanvas'), g = c.getContext('2d'), d = G.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, G.W, G.H);
    // grid backdrop (analytical look)
    g.strokeStyle = 'rgba(148,163,184,0.06)'; g.lineWidth = 1;
    const step = 40;
    g.beginPath();
    for (let x = (G.tx % step + step) % step; x < G.W; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, G.H); }
    for (let y = (G.ty % step + step) % step; y < G.H; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(G.W, Math.round(y) + 0.5); }
    g.stroke();
    if (!G.nodes.length) return;

    const focus = focusSet();
    const sel = G.selected || G.hover;
    // edges
    g.lineCap = 'round';
    for (const e of G.edges) {
      if (!edgeVisible(e)) continue;
      const A = toScreen(e.a), B = toScreen(e.b);
      if ((A.x < -20 && B.x < -20) || (A.x > G.W + 20 && B.x > G.W + 20) || (A.y < -20 && B.y < -20) || (A.y > G.H + 20 && B.y > G.H + 20)) continue;
      const touch = sel && (e.a === sel || e.b === sel);
      const inFocus = !focus || (focus.has(e.a.id) && focus.has(e.b.id));
      if (touch) { g.strokeStyle = hexA(sel.color, 0.9); g.lineWidth = 1.6; }
      else if (!inFocus) { g.strokeStyle = 'rgba(100,116,139,0.06)'; g.lineWidth = 1; }
      else { g.strokeStyle = e.w >= STRONG ? 'rgba(148,163,184,0.42)' : 'rgba(100,116,139,0.24)'; g.lineWidth = e.w >= STRONG ? 1.2 : 0.8; }
      g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
    }
    // nodes
    const visibleNodes = [];
    for (const n of G.nodes) {
      if (!isVisible(n)) continue;
      const p = toScreen(n), r = screenR(n);
      if (p.x < -r || p.x > G.W + r || p.y < -r || p.y > G.H + r) continue;
      const dim = focus && !focus.has(n.id);
      g.globalAlpha = dim ? 0.16 : 1;
      g.fillStyle = n.color;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
      g.lineWidth = 1.5; g.strokeStyle = '#0B1220'; g.stroke();
      if (G.matches.has(n.id)) { g.lineWidth = 2; g.strokeStyle = '#FBBF24'; g.beginPath(); g.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2); g.stroke(); }
      if (n === sel) { g.lineWidth = 2; g.strokeStyle = '#F8FAFC'; g.beginPath(); g.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2); g.stroke(); }
      g.globalAlpha = 1;
      if (!dim) visibleNodes.push({ n, p, r });
    }
    // labels: biggest first, skip overlaps
    g.font = '500 11px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    const placed = [];
    const want = G.k > 1.7 ? 60 : G.k > 1.1 ? 22 : 10;
    visibleNodes.sort((a, b) => (b.n === sel) - (a.n === sel) || G.matches.has(b.n.id) - G.matches.has(a.n.id) || b.n.deg - a.n.deg);
    let shown = 0;
    for (const v of visibleNodes) {
      if (shown >= want && v.n !== sel && !G.matches.has(v.n.id)) break;
      const text = v.n.label.length > 30 ? v.n.label.slice(0, 29).trimEnd() + '…' : v.n.label;
      const w = g.measureText(text).width, x = v.p.x + v.r + 5, y = v.p.y;
      const box = { x0: x - 3, y0: y - 8, x1: x + w + 3, y1: y + 8 };
      if (box.x1 > G.W || placed.some(b => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1))) continue;
      placed.push(box); shown++;
      g.fillStyle = 'rgba(11,18,32,0.78)'; g.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      g.fillStyle = v.n === sel ? '#F8FAFC' : '#CBD5E1'; g.fillText(text, x, y);
    }
  }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }

  // ---------- hit test ----------
  function nodeAt(sx, sy, slop = 6) {
    let best = null, bd = Infinity;
    for (const n of G.nodes) {
      if (!isVisible(n)) continue;
      const p = toScreen(n), r = screenR(n) + slop, d = Math.hypot(p.x - sx, p.y - sy);
      if (d < r && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ---------- hover / preview card ----------
  const topicName = (n) => (G.cById.get(n.c1) || {}).name || 'Other';
  function showHover(n, touch) {
    G.hover = n;
    const card = $('graphHover');
    if (!n) { card.hidden = true; wake(); return; }
    const when = new Date(n.at);
    card.innerHTML = `
      <div class="gh-top"><span class="gs-dot" style="background:${n.color}"></span><span class="gh-topic">${esc(topicName(n))}</span>
        <span class="gh-deg num">${n.deg} ${n.deg === 1 ? 'link' : 'links'}</span></div>
      <div class="gh-text">${esc(n.label.length > 160 ? n.label.slice(0, 159) + '…' : n.label)}</div>
      <div class="gh-meta num">${isNaN(when) ? '' : esc(when.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''}</div>
      ${touch ? `<button type="button" class="gh-open" data-gh-open="${esc(n.id)}">Open note</button>` : ''}`;
    card.hidden = false;
    card.classList.toggle('touch', !!touch);
    placeHover();
    wake();
  }
  function placeHover() {
    const n = G.hover, card = $('graphHover');
    if (!n || card.hidden) return;
    const p = toScreen(n), r = screenR(n);
    const w = card.offsetWidth, h = card.offsetHeight;
    let x = p.x + r + 12, y = p.y - h / 2;
    if (x + w > G.W - 8) x = p.x - r - 12 - w;
    if (x < 8) x = Math.max(8, Math.min(G.W - w - 8, p.x - w / 2));
    if (x !== p.x + r + 12 && x !== p.x - r - 12 - w) y = p.y + r + 12;
    y = Math.max(8, Math.min(G.H - h - 8, y));
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---------- selection + detail sheet ----------
  function select(n) {
    G.selected = n;
    const sheet = $('graphSheet');
    renderSide();
    if (!n) { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); wake(); return; }
    showHover(null);
    const near = [...n.nbr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, w]) => ({ m: G.byId.get(id), w })).filter(x => x.m);
    sheet.innerHTML = `
      <div class="gs-top"><span class="gs-dot" style="background:${n.color}"></span>
        <span class="gs-topic">${esc(topicName(n))}</span>
        <button class="secondary icon-btn gs-close" type="button" aria-label="Close" data-gs-close="1">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gs-date num">${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''} · ${n.deg} ${n.deg === 1 ? 'link' : 'links'}</div>
      <div class="gs-text" id="gsText">${esc(n.label)}</div>
      <button type="button" data-gs-open="${esc(n.id)}" style="width:100%; margin-top:10px;">Read the full note</button>
      ${near.length ? `<div class="gs-near-title">Connected <span class="num">(${n.deg})</span></div>${near.map(({ m, w }) => `
        <button type="button" class="gs-near" data-gs-jump="${esc(m.id)}"><span class="gs-dot" style="background:${m.color}"></span><span class="gs-near-text">${esc(m.label)}</span><span class="num gs-sim">${w.toFixed(2)}</span></button>`).join('')}` : ''}`;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
    // keep the note on screen (left part, so the sheet doesn't cover it)
    const p = toScreen(n);
    if (p.x < 40 || p.x > G.W - 40 || p.y < 40 || p.y > G.H * 0.5) {
      animateTo({ k: G.k, tx: G.tx + (G.W / 2 - p.x), ty: G.ty + (G.H * 0.3 - p.y) });
    }
    wake();
  }
  async function openFull(id) {
    const box = $('gsText'), btn = document.querySelector('[data-gs-open]');
    if (!navigator.onLine) { btn.textContent = 'Needs a connection'; return; }
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const { data, error } = await sb.from('thoughts').select('content').eq('id', id).single();
      if (error) throw error;
      const full = String(data.content || '');
      box.textContent = full.length > 4000 ? full.slice(0, 4000) + '…' : full;
      box.classList.add('full'); btn.remove();
    } catch (err) { btn.disabled = false; btn.textContent = 'Could not open it. Try again'; }
  }
  function focusNode(n) {
    if (!n) return;
    const k = Math.max(G.k, 1.6);
    animateTo({ k, tx: G.W / 2 - n.x * k, ty: G.H * 0.35 - n.y * k });
  }

  // ---------- search ----------
  function applySearch(focus = true) {
    const q = G.query.trim().toLowerCase();
    G.matches = new Set();
    if (q) for (const n of G.nodes) if (isVisible(n) && (n.label.toLowerCase().includes(q) || topicName(n).toLowerCase() === q)) G.matches.add(n.id);
    const out = $('graphSearchCount');
    out.textContent = q ? `${G.matches.size} ${G.matches.size === 1 ? 'match' : 'matches'}` : '';
    out.classList.toggle('none', !!q && !G.matches.size);
    if (focus && G.matches.size) {
      const list = [...G.matches].map(id => G.byId.get(id));
      if (list.length === 1) focusNode(list[0]); else animateTo(viewFor(list, 2.6));
    }
    renderSide();
    wake();
  }

  // ---------- legend (topic filters) ----------
  function renderLegend() {
    const el = $('graphLegend');
    const anyHidden = G.hidden.size > 0;
    el.innerHTML = G.clusters.map(c => {
      const C = G.cById.get(c.id), on = !G.hidden.has(c.id);
      return `<button type="button" class="chip legend-chip ${on ? 'on' : 'off'}" data-topic="${c.id}" aria-pressed="${on}">
        <span class="gs-dot" style="background:${C.color}"></span>${esc(c.name)} <span class="num legend-n">${C.count}</span></button>`;
    }).join('') + (anyHidden ? '<button type="button" class="chip legend-all" data-topic-all="1">Show all</button>' : '');
  }
  function setMinDeg(v) {
    G.minDeg = Math.max(0, Number(v) || 0);
    $('graphMin').value = String(G.minDeg);
    $('graphMinOut').textContent = String(G.minDeg);
  }
  function filtersChanged() {
    if (G.selected && !isVisible(G.selected)) select(null);
    if (G.hover && !isVisible(G.hover)) showHover(null);
    applySearch(false);
    renderSide();
    wake();
  }

  // ---------- side panel: ranking + totals ----------
  function renderSide() {
    const vis = G.nodes.filter(isVisible);
    const visIds = new Set(vis.map(n => n.id));
    const edges = G.edges.filter(edgeVisible);
    const top = vis.slice().sort((a, b) => b.deg - a.deg || b.at - a.at).slice(0, 10);
    const max = top.length ? top[0].deg || 1 : 1;
    $('graphRank').innerHTML = top.length ? top.map((n, i) => `
      <li><button type="button" class="rank-row ${G.selected === n ? 'active' : ''} ${G.matches.has(n.id) ? 'match' : ''}" data-rank="${esc(n.id)}">
        <span class="rank-i num">${i + 1}</span>
        <span class="gs-dot" style="background:${n.color}"></span>
        <span class="rank-label">${esc(n.label)}</span>
        <span class="rank-bar" aria-hidden="true"><span style="width:${Math.round(n.deg / max * 100)}%; background:${n.color}"></span></span>
        <span class="rank-deg num">${n.deg}</span></button></li>`).join('')
      : '<li class="pl-empty">No notes match these filters.</li>';
    const avg = vis.length ? (edges.length * 2 / vis.length) : 0;
    const possible = vis.length * (vis.length - 1) / 2;
    const topics = new Set(vis.map(n => n.c1)).size;
    $('graphStats').innerHTML = `
      <div><dt>Notes</dt><dd class="num">${fmt(vis.length)}<small>/${fmt(G.nodes.length)}</small></dd></div>
      <div><dt>Links</dt><dd class="num">${fmt(edges.length)}</dd></div>
      <div><dt>Avg links</dt><dd class="num">${avg.toFixed(1)}</dd></div>
      <div><dt>Density</dt><dd class="num">${possible ? (edges.length / possible * 100).toFixed(1) + '%' : '—'}</dd></div>
      <div><dt>Topics</dt><dd class="num">${topics}</dd></div>
      <div><dt>Isolated</dt><dd class="num">${vis.filter(n => ![...n.nbr.keys()].some(id => visIds.has(id))).length}</dd></div>`;
  }

  function note(text) {
    const el = $('graphNote');
    el.textContent = text; el.style.opacity = '1';
    clearTimeout(el._h); el._h = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  // ---------- input ----------
  function localPoint(e) { const r = $('graphCanvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onDown(e) {
    const c = $('graphCanvas');
    c.setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    G.pointers.set(e.pointerId, p);
    G.moved = false;
    if (G.pointers.size === 2) {
      const [a, b] = [...G.pointers.values()];
      G.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: G.k, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, tx: G.tx, ty: G.ty };
      G.pan = null;
    } else {
      G.pan = { x: p.x, y: p.y, tx: G.tx, ty: G.ty };
    }
    G.anim = null;
    c.classList.add('grabbing');
  }
  function onMove(e) {
    const p = localPoint(e);
    if (G.pointers.has(e.pointerId)) G.pointers.set(e.pointerId, p);
    if (G.pinch && G.pointers.size >= 2) {
      const [a, b] = [...G.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = Math.max(0.15, Math.min(8, G.pinch.k * d / G.pinch.d));
      const w = { x: (G.pinch.mid.x - G.pinch.tx) / G.pinch.k, y: (G.pinch.mid.y - G.pinch.ty) / G.pinch.k };
      G.k = k; G.tx = mid.x - w.x * k; G.ty = mid.y - w.y * k;
      G.moved = true; G.touched = true; wake(); return;
    }
    if (G.pan && G.pointers.has(e.pointerId)) {
      const dx = p.x - G.pan.x, dy = p.y - G.pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) G.moved = true;
      if (G.moved) { G.touched = true; G.tx = G.pan.tx + dx; G.ty = G.pan.ty + dy; if (G.hover && e.pointerType === 'mouse') showHover(null); wake(); }
      return;
    }
    if (e.pointerType === 'mouse') {
      const n = nodeAt(p.x, p.y);
      $('graphCanvas').classList.toggle('pointing', !!n);
      if (n !== G.hover) showHover(n, false);
    }
  }
  function onUp(e) {
    const p = G.pointers.get(e.pointerId) || localPoint(e);
    G.pointers.delete(e.pointerId);
    $('graphCanvas').classList.remove('grabbing');
    if (G.pinch) { if (G.pointers.size < 2) G.pinch = null; if (G.pointers.size === 1) { const q = [...G.pointers.values()][0]; G.pan = { x: q.x, y: q.y, tx: G.tx, ty: G.ty }; } return; }
    G.pan = null;
    if (G.moved || e.type === 'pointercancel') return;
    const n = nodeAt(p.x, p.y, e.pointerType === 'mouse' ? 6 : 14);
    if (e.pointerType === 'mouse') { select(n); }
    else if (n) { G.selected = n; renderSide(); showHover(n, true); }
    else { G.selected = null; renderSide(); showHover(null); $('graphSheet').classList.remove('open'); }
  }

  function setup() {
    const c = $('graphCanvas');
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !G.pan) { showHover(null); c.classList.remove('pointing'); } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = localPoint(e);
      zoomAt(Math.exp(-e.deltaY * 0.0018), p.x, p.y);
    }, { passive: false });
    $('graphZoomIn').addEventListener('click', () => zoomAt(1.35));
    $('graphZoomOut').addEventListener('click', () => zoomAt(1 / 1.35));
    $('graphFit').addEventListener('click', () => { select(null); showHover(null); G.touched = false; fit(); });
    $('graphLegend').addEventListener('click', (e) => {
      if (e.target.closest('[data-topic-all]')) { G.hidden.clear(); renderLegend(); filtersChanged(); return; }
      const b = e.target.closest('[data-topic]'); if (!b) return;
      const id = Number(b.dataset.topic);
      if (G.hidden.has(id)) G.hidden.delete(id); else G.hidden.add(id);
      if (G.hidden.size >= G.clusters.length) G.hidden.delete(id);   // never hide everything
      renderLegend(); filtersChanged();
    });
    $('graphMin').addEventListener('input', (e) => { setMinDeg(e.target.value); filtersChanged(); });
    let t = 0;
    $('graphSearch').addEventListener('input', (e) => { G.query = e.target.value; clearTimeout(t); t = setTimeout(() => applySearch(true), 220); });
    $('graphSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); G.query = e.target.value; applySearch(true); e.target.blur(); }
      if (e.key === 'Escape') { e.target.value = ''; G.query = ''; applySearch(false); }
    });
    $('graphLinks').addEventListener('click', () => {
      G.strongOnly = !G.strongOnly;
      $('graphLinks').textContent = G.strongOnly ? 'Strong only' : 'All links';
      $('graphLinks').setAttribute('aria-pressed', String(G.strongOnly));
      renderSide(); wake();
    });
    $('graphRank').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rank]'); if (!b) return;
      const n = G.byId.get(b.dataset.rank); if (!n) return;
      focusNode(n); select(n);
    });
    $('graphHover').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gh-open]'); if (!b) return;
      const n = G.byId.get(b.dataset.ghOpen); if (n) select(n);
    });
    $('graphSheet').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.gsClose) select(null);
      else if (b.dataset.gsOpen) openFull(b.dataset.gsOpen);
      else if (b.dataset.gsJump) { const n = G.byId.get(b.dataset.gsJump); if (n) select(n); }
    });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(c.parentElement);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (G.visible) start(); });
    window.addEventListener('online', () => { if (G.visible) fetchGraph({ quiet: true }); });
  }

  function start() {
    resize(); wake();
    clearInterval(G.poll);
    G.poll = setInterval(() => { if (G.visible && !document.hidden) fetchGraph({ quiet: true }); }, POLL_MS);
  }
  function stop() { cancelAnimationFrame(G.raf); G.raf = 0; clearInterval(G.poll); }

  setup();
  window.obGraph = {
    show() { G.visible = true; start(); fetchGraph(); },
    hide() { G.visible = false; stop(); showHover(null); },
    reset() {
      G.nodes = []; G.byId = new Map(); G.edges = []; G.selected = null; G.hover = null; G.hidden.clear(); G.at = null;
      $('graphSheet').classList.remove('open');
    },
    fit,
    _draw: () => draw(),                                  // for the browser test (timing)
    _state: G,                                             // for the browser test
    _screenPos(id) {                                       // for the browser test: a note's position in page pixels
      const n = G.byId.get(id); if (!n) return null;
      const r = $('graphCanvas').getBoundingClientRect(), p = toScreen(n);
      return { x: r.left + p.x, y: r.top + p.y };
    },
  };
})();
