// graph.js — the thought map (Brain screen > Map). v5 "root garden", design-v3, Nov 2026.
// A flat garden instead of the old rotating 3D brain:
//   - every thought is a seed; its colour is its topic (legend = the topic chips above the map)
//   - bigger seed = more connections; the best-connected seeds grow a small sprout
//   - links are curved, branch-like lines; links inside one topic take the topic colour
//   - hover a seed (or tap it on a phone) for a preview card; click / "Open" shows the full thought
//   - wheel, drag and pinch to zoom and pan; + / − / reset buttons do the same
//   - search box highlights matching seeds and zooms to them
//   - topic chips switch topics on and off; the slider hides seeds with few connections
// Data: the brain_graph() function in Supabase, called with your login (RLS applies).
//   { clusters: [{id, name, color, size}], nodes: [{id, label, cat, at, c1, c2, w}], edges: [[a, b, w]], at }
// No library: a canvas and a small force layout, so it works offline from the saved copy.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STRONG = 0.70;                 // "strong link" cutoff (similarity)
  const POLL_MS = 40000;
  const MAX_EDGES = 2500;              // never draw more lines than this (strongest first)
  const K_MIN = 0.15, K_MAX = 6;
  // Earthy topic colours: terracotta, moss, ochre, berry, slate teal, walnut, then a few spares.
  const PALETTE = ['#B4532A', '#5F7A3A', '#B07D1E', '#7C3F5E', '#3E6B70', '#8A5A3B', '#6D7F2E', '#9A4A44', '#55606E', '#A0702A'];
  const INK = '#2E2419', BRANCH = 'rgba(110, 84, 58, ';

  // ---------- small helpers ----------
  function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  function hex2rgb(h) { const m = String(h || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); return m ? m.slice(1).map(x => parseInt(x, 16)) : [138, 120, 100]; }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const lighten = (c, t) => c.map(v => Math.round(v + (255 - v) * t));
  const darken = (c, t) => c.map(v => Math.round(v * (1 - t)));

  const G = {
    nodes: [], byId: new Map(), edges: [], clusters: [], cById: new Map(),
    view: { x: 0, y: 0, k: 1 }, W: 300, H: 300, dpr: 1,
    hidden: new Set(), minDeg: 0, maxDeg: 0, query: '', matches: null,
    hover: null, card: null, selected: null, strongOnly: false,
    pointers: new Map(), drag: null, pinch: null, tween: null,
    visible: false, raf: 0, dirty: true, poll: 0, at: null, fitted: false,
  };

  // ---------- layout: topics are beds in the garden, a small force layout settles the seeds ----------
  function placeClusters() {
    const list = G.clusters.slice().sort((a, b) => a.id - b.id);
    const n = Math.max(1, list.length);
    const R = 140 + Math.sqrt(G.nodes.length) * 22;
    list.forEach((c, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const cc = G.cById.get(c.id);
      cc.cx = n === 1 ? 0 : Math.cos(a) * R; cc.cy = n === 1 ? 0 : Math.sin(a) * R * 0.82;
    });
  }

  function layout(iterations, onlyNew) {
    const N = G.nodes;
    if (!N.length) return;
    const spring = 46, rep = 1400, cell = 90;
    for (let it = 0; it < iterations; it++) {
      const alpha = 1 - it / iterations;
      // repulsion between seeds that are close (grid, so it stays fast with thousands of seeds)
      const grid = new Map();
      for (const n of N) { const key = Math.floor(n.x / cell) + ',' + Math.floor(n.y / cell); let b = grid.get(key); if (!b) grid.set(key, b = []); b.push(n); n.fx = 0; n.fy = 0; }
      for (const n of N) {
        const gx = Math.floor(n.x / cell), gy = Math.floor(n.y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const b = grid.get((gx + dx) + ',' + (gy + dy)); if (!b) continue;
          for (const m of b) {
            if (m === n) continue;
            let x = n.x - m.x, y = n.y - m.y, d2 = x * x + y * y;
            if (d2 > cell * cell) continue;
            if (d2 < 0.01) { x = hash(n.id) - 0.5; y = hash(m.id) - 0.5; d2 = 0.5; }
            const f = rep / d2;
            n.fx += x * f / Math.sqrt(d2); n.fy += y * f / Math.sqrt(d2);
          }
        }
      }
      for (const e of G.edges) {
        const a = G.byId.get(e.a), b = G.byId.get(e.b);
        const x = b.x - a.x, y = b.y - a.y, d = Math.sqrt(x * x + y * y) || 1;
        const same = a.c1 === b.c1;
        const f = (d - spring) * (same ? 0.05 : 0.012) * (0.5 + e.w);
        a.fx += x / d * f; a.fy += y / d * f; b.fx -= x / d * f; b.fy -= y / d * f;
      }
      for (const n of N) {
        const c = G.cById.get(n.c1);
        if (c) { n.fx += (c.cx - n.x) * 0.018; n.fy += (c.cy - n.y) * 0.018; }
        if (onlyNew && !n.fresh) continue;
        const step = Math.min(12, 1.6 * alpha + 0.2);
        const len = Math.hypot(n.fx, n.fy) || 1;
        n.x += n.fx / len * Math.min(len, 30) * step * 0.25;
        n.y += n.fy / len * Math.min(len, 30) * step * 0.25;
      }
    }
  }

  // ---------- data in ----------
  function ingest(data) {
    const prev = G.byId;
    G.clusters = (data.clusters || []).slice();
    G.cById = new Map(G.clusters.slice().sort((a, b) => a.id - b.id).map((c, i) => [c.id, { ...c, rgb: hex2rgb(PALETTE[i % PALETTE.length]) }]));
    const nodes = (data.nodes || []).map(r => {
      const old = prev.get(r.id);
      return { id: r.id, label: String(r.label || ''), cat: r.cat, at: new Date(r.at).getTime(), c1: r.c1, c2: r.c2, w: Number(r.w) || 0,
        deg: 0, x: old ? old.x : 0, y: old ? old.y : 0, fresh: !old, rot: hash(r.id) * Math.PI };
    });
    G.nodes = nodes; G.byId = new Map(nodes.map(n => [n.id, n]));
    G.edges = (data.edges || []).map(([a, b, w]) => ({ a, b, w: Number(w) || 0 })).filter(e => G.byId.has(e.a) && G.byId.has(e.b) && e.a !== e.b);
    G.edges.sort((x, y) => y.w - x.w);
    if (G.edges.length > MAX_EDGES) G.edges.length = MAX_EDGES;
    for (const e of G.edges) { G.byId.get(e.a).deg++; G.byId.get(e.b).deg++; e.bend = (hash(e.a + e.b) - 0.5) * 0.7; }
    G.maxDeg = nodes.reduce((m, n) => Math.max(m, n.deg), 0);
    const degs = nodes.map(n => n.deg).sort((a, b) => b - a);
    const hubCut = Math.max(4, degs[Math.floor(degs.length * 0.06)] || 4);
    for (const n of nodes) { n.hub = n.deg >= hubCut; n.r = 4.6 + Math.sqrt(n.deg) * 2.6; }
    for (const c of G.cById.values()) c.size = nodes.filter(n => n.c1 === c.id).length;
    placeClusters();
    const fresh = nodes.filter(n => n.fresh);
    for (const n of fresh) {
      const c = G.cById.get(n.c1) || { cx: 0, cy: 0 };
      const a = hash(n.id + 'a') * Math.PI * 2, d = 20 + hash(n.id + 'd') * 90;
      n.x = c.cx + Math.cos(a) * d; n.y = c.cy + Math.sin(a) * d;
    }
    if (fresh.length === nodes.length) layout(nodes.length > 1500 ? 90 : 220, false);
    else if (fresh.length) layout(80, true);
    nodes.forEach(n => { n.fresh = false; });
    if (G.selected) G.selected = G.byId.get(G.selected.id) || null;
    if (G.hover) G.hover = G.byId.get(G.hover.id) || null;
    G.at = data.at;
    const slider = $('graphMinLinks');
    if (slider) { slider.max = String(Math.max(1, Math.min(G.maxDeg, 20))); if (G.minDeg > Number(slider.max)) setMinDeg(Number(slider.max)); }
    applySearch(false);
    renderLegend();
    $('graphCanvas').setAttribute('aria-label', `Map of ${nodes.length} thoughts in ${G.clusters.length} topics`);
    resize();
    if (!G.fitted) { fit(false); G.fitted = true; }
    wake();
  }

  async function fetchGraph({ quiet } = {}) {
    if (!navigator.onLine) {
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value); else $('graphStatus').textContent = 'Your map needs a connection the first time.';
      }
      return;
    }
    if (!quiet && !G.nodes.length) $('graphStatus').textContent = 'Planting your garden…';
    try {
      const { data, error } = await sb.rpc('brain_graph');
      if (error) throw error;
      if (G.at && data.at === G.at && G.nodes.length) return;
      ingest(data);
      try { obCache.put('graph', data); } catch { /* storage full: fine */ }
      $('graphStatus').textContent = G.nodes.length ? '' : 'No thoughts on the map yet. Save one and it sprouts here.';
    } catch (err) {
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value);
        $('graphStatus').textContent = c ? '' : 'Could not load your map: ' + (err.message || 'unknown error');
      }
    }
  }

  // ---------- what is shown ----------
  const shown = (n) => !G.hidden.has(n.c1) && n.deg >= G.minDeg;
  const edgeShown = (e) => (!G.strongOnly || e.w >= STRONG) && shown(G.byId.get(e.a)) && shown(G.byId.get(e.b));
  function focusSet() {
    const f = G.selected || G.hover;
    if (!f) return null;
    const s = new Set([f.id]);
    for (const e of G.edges) { if (e.a === f.id) s.add(e.b); else if (e.b === f.id) s.add(e.a); }
    return s;
  }

  // ---------- drawing ----------
  function resize() {
    const wrap = $('graphCanvas').parentElement, r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const oldW = G.W, oldH = G.H;
    G.W = r.width; G.H = r.height; G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = $('graphCanvas'); c.width = Math.round(G.W * G.dpr); c.height = Math.round(G.H * G.dpr);
    if (G.fitted && (oldW !== G.W || oldH !== G.H)) { G.view.x += (G.W - oldW) / 2; G.view.y += (G.H - oldH) / 2; }
    wake();
  }
  const sx = (x) => x * G.view.k + G.view.x, sy = (y) => y * G.view.k + G.view.y;
  const seedR = (n) => n.r * Math.pow(Math.min(Math.max(G.view.k, 0.35), 2.6), 0.6);

  function draw() {
    const c = $('graphCanvas'), g = c.getContext('2d'), d = G.dpr, k = G.view.k;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, G.W, G.H);
    const focus = focusSet();
    const dimAll = !!(focus || G.matches);
    const pad = 40;
    const inView = (n) => { const x = sx(n.x), y = sy(n.y); return x > -pad && x < G.W + pad && y > -pad && y < G.H + pad; };

    // garden beds: a soft wash of colour behind each topic
    for (const cl of G.cById.values()) {
      if (G.hidden.has(cl.id) || !cl.size) continue;
      const x = sx(cl.cx), y = sy(cl.cy), rr = (60 + Math.sqrt(cl.size) * 26) * k;
      const grad = g.createRadialGradient(x, y, 0, x, y, rr);
      grad.addColorStop(0, rgba(cl.rgb, 0.13)); grad.addColorStop(0.7, rgba(cl.rgb, 0.05)); grad.addColorStop(1, rgba(cl.rgb, 0));
      g.fillStyle = grad; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    }

    // branches (links)
    g.lineCap = 'round';
    for (const e of G.edges) {
      if (!edgeShown(e)) continue;
      const a = G.byId.get(e.a), b = G.byId.get(e.b);
      const ax = sx(a.x), ay = sy(a.y), bx = sx(b.x), by = sy(b.y);
      if ((ax < -pad && bx < -pad) || (ax > G.W + pad && bx > G.W + pad) || (ay < -pad && by < -pad) || (ay > G.H + pad && by > G.H + pad)) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay;
      const cx = mx - dy * e.bend, cy = my + dx * e.bend;
      const lit = focus ? (focus.has(a.id) && focus.has(b.id) && (a.id === (G.selected || G.hover).id || b.id === (G.selected || G.hover).id))
        : G.matches ? (G.matches.has(a.id) || G.matches.has(b.id)) : true;
      const same = a.c1 === b.c1, col = same && G.cById.get(a.c1) ? G.cById.get(a.c1).rgb : null;
      const base = (0.22 + (e.w - 0.5) * 0.9);
      const alpha = lit ? (dimAll ? 0.85 : Math.max(0.16, base)) : 0.06;
      g.strokeStyle = col ? rgba(darken(col, 0.1), alpha) : BRANCH + (alpha * 0.85) + ')';
      g.lineWidth = (0.7 + Math.max(0, e.w - 0.5) * 3.2) * Math.min(1.8, Math.max(0.6, Math.sqrt(k))) * (lit && dimAll ? 1.5 : 1);
      g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo(cx, cy, bx, by); g.stroke();
    }

    // seeds (thoughts)
    const labels = [];
    for (const n of G.nodes) {
      if (!shown(n) || !inView(n)) continue;
      const cl = G.cById.get(n.c1), rgb = cl ? cl.rgb : [138, 120, 100];
      const x = sx(n.x), y = sy(n.y), r = seedR(n);
      const lit = focus ? focus.has(n.id) : G.matches ? G.matches.has(n.id) : true;
      g.globalAlpha = lit ? 1 : 0.2;
      g.save(); g.translate(x, y); g.rotate(n.rot);
      if (n.hub && r > 3) {                         // a little sprout on the busiest seeds
        g.strokeStyle = rgba([95, 122, 58], 0.9); g.lineWidth = Math.max(1, r * 0.18);
        g.beginPath(); g.moveTo(0, -r * 0.6); g.quadraticCurveTo(r * 0.3, -r * 1.3, 0, -r * 1.9); g.stroke();
        g.fillStyle = rgba([110, 140, 66], 0.95);
        g.beginPath(); g.moveTo(0, -r * 1.6); g.quadraticCurveTo(r * 0.9, -r * 2.2, r * 1.2, -r * 1.5); g.quadraticCurveTo(r * 0.5, -r * 1.2, 0, -r * 1.6); g.fill();
      }
      g.fillStyle = rgba(rgb, 1);
      g.beginPath(); g.ellipse(0, 0, r, r * 0.74, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = rgba(darken(rgb, 0.35), 0.9); g.lineWidth = Math.max(0.8, r * 0.12); g.stroke();
      if (r > 3.5) {                                 // the seed's groove and a soft shine
        g.strokeStyle = rgba(darken(rgb, 0.3), 0.55); g.lineWidth = Math.max(0.6, r * 0.09);
        g.beginPath(); g.moveTo(-r * 0.62, 0); g.quadraticCurveTo(0, r * 0.18, r * 0.62, 0); g.stroke();
        g.fillStyle = rgba(lighten(rgb, 0.55), 0.55);
        g.beginPath(); g.ellipse(-r * 0.28, -r * 0.3, r * 0.32, r * 0.16, -0.4, 0, Math.PI * 2); g.fill();
      }
      g.restore();
      const isFocus = n === G.selected || n === G.hover;
      if (isFocus || (G.matches && G.matches.has(n.id))) {
        g.globalAlpha = 1; g.strokeStyle = isFocus ? INK : rgba([176, 125, 30], 1); g.lineWidth = 2;
        g.setLineDash(isFocus ? [] : [3, 3]);
        g.beginPath(); g.arc(x, y, r + 5, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      }
      if (lit && (isFocus || (k > 1.7 && r > 4) || (G.matches && G.matches.has(n.id) && G.matches.size <= 12))) labels.push([n, x, y, r]);
      g.globalAlpha = 1;
    }

    // topic names, in the garden's serif
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const cl of G.cById.values()) {
      if (G.hidden.has(cl.id) || !cl.size) continue;
      const fs = Math.max(13, Math.min(22, 15 * Math.sqrt(k)));
      g.font = `italic 600 ${fs}px Fraunces, Georgia, serif`;
      const x = sx(cl.cx), y = sy(cl.cy) - (34 + Math.sqrt(cl.size) * 16) * k - 6;
      g.lineWidth = 4; g.strokeStyle = 'rgba(250, 244, 232, 0.92)'; g.strokeText(cl.name, x, y);
      g.fillStyle = rgba(darken(cl.rgb, 0.35), dimAll ? 0.55 : 1); g.fillText(cl.name, x, y);
    }
    // seed labels (only when zoomed in, or for search matches)
    g.textAlign = 'left'; g.font = '600 12px "Nunito Sans", system-ui, sans-serif';
    for (const [n, x, y, r] of labels.slice(0, 70)) {
      const t = n.label.length > 38 ? n.label.slice(0, 37) + '…' : n.label;
      g.lineWidth = 3.5; g.strokeStyle = 'rgba(250, 244, 232, 0.95)'; g.strokeText(t, x + r + 6, y);
      g.fillStyle = INK; g.fillText(t, x + r + 6, y);
    }
  }

  function frame(now) {
    G.raf = 0;
    if (G.tween) {
      const t = Math.min(1, (now - G.tween.t0) / G.tween.ms), e = 1 - Math.pow(1 - t, 3);
      const a = G.tween.from, b = G.tween.to;
      G.view = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, k: a.k + (b.k - a.k) * e };
      G.dirty = true;
      if (t >= 1) G.tween = null;
    }
    if (G.dirty) { G.dirty = false; draw(); positionCard(); }
    if (G.tween) G.raf = requestAnimationFrame(frame);
  }
  function wake() { G.dirty = true; if (!G.raf && G.visible) G.raf = requestAnimationFrame(frame); }

  // ---------- camera ----------
  function animateTo(to, ms = 380) {
    if (REDUCED) { G.view = to; G.tween = null; wake(); return; }
    G.tween = { t0: performance.now(), ms, from: { ...G.view }, to }; wake();
  }
  function zoomAt(px, py, f, animate) {
    const k = Math.max(K_MIN, Math.min(K_MAX, G.view.k * f));
    const wx = (px - G.view.x) / G.view.k, wy = (py - G.view.y) / G.view.k;
    const to = { k, x: px - wx * k, y: py - wy * k };
    if (animate) animateTo(to, 220); else { G.view = to; wake(); }
  }
  function frameNodes(list, animate, maxK = 2.4) {
    if (!list.length || !G.W) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const padX = G.W < 520 ? 24 : 60, padY = G.W < 520 ? 50 : 70;
    const k = Math.max(K_MIN, Math.min(maxK, Math.min((G.W - padX * 2) / Math.max(1, x1 - x0), (G.H - padY * 2) / Math.max(1, y1 - y0))));
    const to = { k, x: G.W / 2 - ((x0 + x1) / 2) * k, y: G.H / 2 - ((y0 + y1) / 2) * k + 8 };
    if (animate) animateTo(to); else { G.view = to; wake(); }
  }
  function fit(animate = true) {
    const list = G.nodes.filter(shown);
    frameNodes(list.length ? list : G.nodes, animate, 1.6);
  }

  // ---------- hover / tap preview card ----------
  function topicName(n) { const c = G.cById.get(n.c1); return c ? c.name : 'No topic yet'; }
  function showCard(n, touch) {
    const card = $('graphCard');
    G.card = n ? { n, touch } : null;
    if (!n) { card.hidden = true; return; }
    const c = G.cById.get(n.c1);
    card.innerHTML = `<div class="gc-top"><span class="gs-dot" style="background:${c ? rgba(c.rgb, 1) : '#8A7864'}"></span><span class="gc-topic">${esc(topicName(n))}</span></div>
      <div class="gc-title">${esc(n.label.length > 120 ? n.label.slice(0, 119) + '…' : n.label)}</div>
      <div class="gc-meta">${n.deg} ${n.deg === 1 ? 'connection' : 'connections'} · ${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</div>
      ${touch ? `<button type="button" class="gc-open" data-gc-open="${esc(n.id)}">Open thought</button>` : '<div class="gc-hint">Click to open</div>'}`;
    card.hidden = false;
    card.classList.toggle('touch', !!touch);
    positionCard();
  }
  function positionCard() {
    const card = $('graphCard');
    if (!G.card || card.hidden) return;
    const n = G.card.n;
    if (!shown(n)) { showCard(null); return; }
    const x = sx(n.x), y = sy(n.y), r = seedR(n);
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = x + r + 12, top = y - h / 2;
    if (left + w > G.W - 8) left = x - r - 12 - w;
    if (left < 8) { left = Math.max(8, Math.min(G.W - w - 8, x - w / 2)); top = y + r + 12; if (top + h > G.H - 60) top = y - r - 12 - h; }
    top = Math.max(8, Math.min(G.H - h - 8, top));
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // ---------- the full thought (bottom sheet) ----------
  function select(n, { center } = {}) {
    G.selected = n;
    const sheet = $('graphSheet');
    if (!n) { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); wake(); return; }
    showCard(null);
    const nbr = new Map();
    for (const e of G.edges) { if (e.a === n.id) nbr.set(e.b, e.w); if (e.b === n.id) nbr.set(e.a, e.w); }
    const c1 = G.cById.get(n.c1);
    const near = [...nbr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => G.byId.get(id)).filter(Boolean);
    sheet.innerHTML = `
      <div class="gs-top"><span class="gs-dot" style="background:${c1 ? rgba(c1.rgb, 1) : '#8A7864'}"></span>
        <span class="gs-topic">${esc(topicName(n))}</span>
        <button class="secondary icon-btn gs-close" type="button" aria-label="Close" data-gs-close="1">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gs-date">${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''} · ${n.deg} ${n.deg === 1 ? 'connection' : 'connections'}</div>
      <div class="gs-text" id="gsText">${esc(n.label)}</div>
      <button type="button" data-gs-open="${esc(n.id)}" style="width:100%; margin-top:12px;">Read the full thought</button>
      ${near.length ? `<div class="gs-near-title">Connected</div>${near.map(m => {
        const cm = G.cById.get(m.c1);
        return `<button type="button" class="gs-near" data-gs-jump="${esc(m.id)}"><span class="gs-dot" style="background:${cm ? rgba(cm.rgb, 1) : '#8A7864'}"></span><span>${esc(m.label)}</span></button>`; }).join('')}` : ''}`;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
    if (center) {
      const k = Math.max(G.view.k, 1.1);
      animateTo({ k, x: G.W / 2 - n.x * k, y: G.H * 0.3 - n.y * k });
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

  // ---------- search ----------
  function applySearch(focusIt) {
    const q = G.query.trim().toLowerCase();
    const out = $('graphSearchCount');
    if (!q) { G.matches = null; if (out) out.textContent = ''; wake(); return; }
    const words = q.split(/\s+/).filter(Boolean);
    const list = G.nodes.filter(n => { const t = (n.label + ' ' + (n.cat || '') + ' ' + topicName(n)).toLowerCase(); return words.every(w => t.includes(w)); });
    G.matches = new Set(list.map(n => n.id));
    const vis = list.filter(shown);
    if (out) out.textContent = list.length
      ? `${list.length} ${list.length === 1 ? 'thought matches' : 'thoughts match'}${vis.length < list.length ? ` (${list.length - vis.length} hidden by filters)` : ''}`
      : 'No thoughts match that.';
    if (focusIt && vis.length) frameNodes(vis, true, 2.4);
    wake();
  }

  // ---------- filters ----------
  function renderLegend() {
    const el = $('graphLegend');
    const list = [...G.cById.values()].filter(c => c.size).sort((a, b) => b.size - a.size);
    el.innerHTML = list.map(c => `
      <button type="button" class="chip legend-chip ${G.hidden.has(c.id) ? 'off' : 'active'}" data-topic="${c.id}" aria-pressed="${!G.hidden.has(c.id)}">
        <span class="gs-dot" style="background:${rgba(c.rgb, 1)}"></span>${esc(c.name)} <span class="legend-n">${c.size}</span></button>`).join('') +
      (G.hidden.size ? '<button type="button" class="chip legend-all" data-topic-all="1">Show all</button>' : '');
  }
  function setMinDeg(v) {
    G.minDeg = Math.max(0, Number(v) || 0);
    const s = $('graphMinLinks'), o = $('graphMinOut');
    if (s && Number(s.value) !== G.minDeg) s.value = String(G.minDeg);
    if (o) o.textContent = String(G.minDeg);
    afterFilter();
  }
  function afterFilter() {
    if (G.selected && !shown(G.selected)) select(null);
    if (G.hover && !shown(G.hover)) G.hover = null;
    if (G.card && !shown(G.card.n)) showCard(null);
    const vis = G.nodes.filter(shown).length;
    $('graphStatus').textContent = G.nodes.length && !vis ? 'Nothing matches these filters.' : '';
    applySearch(false);
    renderLegend();
    wake();
  }

  // ---------- pointer input ----------
  function local(e) { const r = $('graphCanvas').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hit(px, py, slop) {
    let best = null, bd = Infinity;
    for (const n of G.nodes) {
      if (!shown(n)) continue;
      const d = Math.hypot(sx(n.x) - px, sy(n.y) - py), r = seedR(n) + slop;
      if (d < r && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  function onDown(e) {
    const c = $('graphCanvas');
    try { c.setPointerCapture(e.pointerId); } catch { /* fine */ }
    const [x, y] = local(e);
    G.pointers.set(e.pointerId, { x, y });
    G.tween = null;
    if (G.pointers.size === 1) G.drag = { x, y, vx: G.view.x, vy: G.view.y, moved: false, type: e.pointerType };
    if (G.pointers.size === 2) {
      const [a, b] = [...G.pointers.values()];
      G.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      if (G.drag) G.drag.moved = true;
    }
    c.classList.add('grabbing');
  }
  function onMove(e) {
    const [x, y] = local(e);
    if (G.pointers.has(e.pointerId)) G.pointers.set(e.pointerId, { x, y });
    if (G.pinch && G.pointers.size >= 2) {
      const [a, b] = [...G.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      zoomAt(mx, my, d / G.pinch.d);
      G.view.x += mx - G.pinch.mx; G.view.y += my - G.pinch.my;
      G.pinch = { d, mx, my }; wake();
      return;
    }
    if (G.drag && G.pointers.size === 1) {
      const dx = x - G.drag.x, dy = y - G.drag.y;
      if (!G.drag.moved && Math.hypot(dx, dy) > 6) { G.drag.moved = true; if (G.card && G.card.touch) showCard(null); }
      if (G.drag.moved) { G.view.x = G.drag.vx + dx; G.view.y = G.drag.vy + dy; wake(); }
      return;
    }
    if (e.pointerType === 'mouse' && !G.pointers.size) {
      const n = hit(x, y, 4);
      if (n !== G.hover) {
        G.hover = n; showCard(n, false);
        $('graphCanvas').style.cursor = n ? 'pointer' : '';
        wake();
      }
    }
  }
  function onUp(e) {
    const [x, y] = local(e);
    const drag = G.drag;
    G.pointers.delete(e.pointerId);
    if (G.pointers.size < 2) G.pinch = null;
    if (G.pointers.size === 1) { const [p] = [...G.pointers.values()]; G.drag = { x: p.x, y: p.y, vx: G.view.x, vy: G.view.y, moved: true }; return; }
    G.drag = null;
    $('graphCanvas').classList.remove('grabbing');
    if (!drag || drag.moved || e.type === 'pointercancel') return;
    const touch = e.pointerType !== 'mouse';
    const n = hit(x, y, touch ? 14 : 4);
    if (!n) { showCard(null); G.hover = null; if (G.selected) select(null); wake(); return; }
    if (touch) {
      if (G.selected) select(null);
      G.hover = n; showCard(n, true); wake();
    } else select(n);
  }
  function onLeave() { if (G.hover && !(G.card && G.card.touch)) { G.hover = null; showCard(null); wake(); } }

  // ---------- wiring ----------
  function setup() {
    const c = $('graphCanvas');
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') { zoomAt(G.W / 2, G.H / 2, 1.3, true); e.preventDefault(); }
      if (e.key === '-' || e.key === '_') { zoomAt(G.W / 2, G.H / 2, 1 / 1.3, true); e.preventDefault(); }
      if (e.key === '0') { fit(); e.preventDefault(); }
      const step = 60;
      if (e.key === 'ArrowLeft') { G.view.x += step; wake(); e.preventDefault(); }
      if (e.key === 'ArrowRight') { G.view.x -= step; wake(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { G.view.y += step; wake(); e.preventDefault(); }
      if (e.key === 'ArrowDown') { G.view.y -= step; wake(); e.preventDefault(); }
      if (e.key === 'Escape') { select(null); showCard(null); G.hover = null; wake(); }
    });
    $('graphZoomIn').addEventListener('click', () => zoomAt(G.W / 2, G.H / 2, 1.4, true));
    $('graphZoomOut').addEventListener('click', () => zoomAt(G.W / 2, G.H / 2, 1 / 1.4, true));
    $('graphFit').addEventListener('click', () => { select(null); showCard(null); G.hover = null; fit(); });
    $('graphLinks').addEventListener('click', () => {
      G.strongOnly = !G.strongOnly;
      $('graphLinks').textContent = G.strongOnly ? 'Strong links only' : 'All links';
      $('graphLinks').setAttribute('aria-pressed', String(G.strongOnly)); wake();
    });
    $('graphLegend').addEventListener('click', (e) => {
      if (e.target.closest('[data-topic-all]')) { G.hidden.clear(); afterFilter(); return; }
      const b = e.target.closest('[data-topic]'); if (!b) return;
      const id = Number(b.dataset.topic);
      if (G.hidden.has(id)) G.hidden.delete(id); else G.hidden.add(id);
      afterFilter();
    });
    $('graphMinLinks').addEventListener('input', (e) => setMinDeg(e.target.value));
    $('graphSearch').addEventListener('input', (e) => { G.query = e.target.value; applySearch(false); });
    $('graphSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      G.query = $('graphSearch').value; applySearch(true);
      document.activeElement && document.activeElement.blur();
    });
    $('graphSearch').addEventListener('search', (e) => { if (!e.target.value) { G.query = ''; applySearch(false); } });
    $('graphCard').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gc-open]'); if (!b) return;
      const n = G.byId.get(b.dataset.gcOpen); if (n) select(n, { center: true });
    });
    $('graphSheet').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.gsClose) select(null);
      else if (b.dataset.gsOpen) openFull(b.dataset.gsOpen);
      else if (b.dataset.gsJump) { const n = G.byId.get(b.dataset.gsJump); if (n) select(n, { center: true }); }
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
    hide() { G.visible = false; stop(); showCard(null); },
    reset() {                                        // forget the current map
      G.nodes = []; G.byId = new Map(); G.edges = []; G.selected = null; G.hover = null; G.at = null; G.fitted = false;
      G.hidden.clear(); G.minDeg = 0; G.query = ''; G.matches = null; G.view = { x: 0, y: 0, k: 1 };
      $('graphSheet').classList.remove('open'); showCard(null);
    },
    fit,
    zoomBy(f) { zoomAt(G.W / 2, G.H / 2, f); },
    screenPos(id) { const n = G.byId.get(id); return n ? { x: sx(n.x), y: sy(n.y), r: seedR(n) } : null; },
    _draw: () => draw(),                             // for the browser test (timing)
    _state: G,                                       // for the browser test
  };
})();
