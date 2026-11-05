// graph.js — the brain map (Brain screen > Map). v5, Nov 2026: "neural" redesign.
// A 2D force-directed map drawn on a canvas, no library, so it works offline from the saved copy.
//
// Data: the brain_graph() function in Supabase, called with your login (RLS applies).
//   - dots = thoughts, coloured by topic (legend under the map); bigger = more connections
//   - lines = thought_links; small light trails travel along them (not with reduced motion)
//   - hover a dot (or tap it on a phone) for a preview card; click / "Open" shows the whole thought
//   - wheel, drag and pinch to zoom and pan; +, - and reset buttons do the same
//   - search highlights matching thoughts and zooms to them
//   - topic chips hide or show a topic; "Min. connections" hides loosely linked thoughts
//   - checks for new thoughts every 40s while open; new ones flash
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const STRONG = 0.70;            // "strong link" cutoff (similarity)
  const POLL_MS = 40000;
  const MAX_EDGES = 1500;         // never draw more lines than this (strongest first)
  const PALETTE = ['#22D3EE', '#A78BFA', '#FBBF24', '#4ADE80', '#F472B6', '#60A5FA', '#F87171', '#2DD4BF', '#E879F9', '#FDE047'];
  const GREY = [148, 163, 184];

  const hexRgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255];
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // seeded random: the map looks the same every time you open it
  function rng(s) { let x = s >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

  const G = {
    nodes: [], byId: new Map(), edges: [], clusters: [], cById: new Map(),
    W: 300, H: 300, dpr: 1, view: { x: 0, y: 0, k: 1 }, anim: null,
    alpha: 0, visible: false, raf: 0, dirty: true,
    hidden: new Set(), minDeg: 0, strongOnly: false, query: '', matches: null,
    hover: null, selected: null, preview: null, pointers: new Map(), drag: null, sparks: [], t0: performance.now(),
  };

  // ---------- data ----------
  function ingest(data, { fresh } = {}) {
    if (!data) return;
    const firstTime = !G.nodes.length;
    G.clusters = (data.clusters || []).map((c, i) => ({ ...c, rgb: hexRgb(c.color) || hexRgb(PALETTE[i % PALETTE.length]) }));
    G.cById = new Map(G.clusters.map(c => [c.id, c]));
    const old = G.byId;
    const nodes = (data.nodes || []).map(n => {
      const prev = old.get(n.id);
      const c = G.cById.get(n.c1);
      return {
        id: n.id, label: String(n.label || '').trim() || '(empty thought)', cat: n.cat, at: new Date(n.at).getTime() || Date.now(),
        c1: n.c1 ?? null, rgb: c ? c.rgb : GREY, deg: 0, r: 4,
        x: prev ? prev.x : NaN, y: prev ? prev.y : NaN, vx: 0, vy: 0, isNew: !prev && !firstTime, pulse: 0,
      };
    });
    G.nodes = nodes; G.byId = new Map(nodes.map(n => [n.id, n]));
    G.edges = (data.edges || []).map(([a, b, w]) => ({ a: G.byId.get(a), b: G.byId.get(b), w: Number(w) || 0 }))
      .filter(e => e.a && e.b && e.a !== e.b).sort((x, y) => y.w - x.w).slice(0, MAX_EDGES);
    for (const e of G.edges) { e.a.deg++; e.b.deg++; }
    for (const n of nodes) n.r = Math.min(18, 3.6 + 2.3 * Math.sqrt(n.deg));
    G.maxDeg = nodes.reduce((m, n) => Math.max(m, n.deg), 0);
    if (G.selected) G.selected = G.byId.get(G.selected.id) || null;
    G.hover = null; hidePreview();

    placeNew(firstTime);
    if (firstTime) { settle(REDUCED ? 400 : 160); G.alpha = REDUCED ? 0 : 0.25; }
    else if (nodes.some(n => n.isNew)) {
      const t = performance.now(), added = nodes.filter(n => n.isNew);
      added.forEach(n => { n.pulse = t; n.isNew = false; });
      G.alpha = Math.max(G.alpha, 0.3);
      if (fresh) note(`${added.length} new ${added.length === 1 ? 'thought' : 'thoughts'} just landed on your map`);
    }
    G.at = data.at;
    seedSparks();
    renderControls();
    applySearch(false);
    $('graphCanvas').setAttribute('aria-label', `Map of ${nodes.length} thoughts in ${G.clusters.length} topics, ${G.edges.length} links`);
    if (firstTime) { resize(); fit(false); }
    wake();
  }

  // Each topic gets a home on a ring; its thoughts start around it.
  function anchors() {
    const n = Math.max(1, G.clusters.length), R = 70 + 26 * Math.sqrt(G.nodes.length);
    const A = new Map();
    G.clusters.forEach((c, i) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; A.set(c.id, { x: Math.cos(a) * R, y: Math.sin(a) * R * 0.78 }); });
    G.anchors = A; return A;
  }
  function placeNew(all) {
    const A = anchors();
    for (const n of G.nodes) {
      if (!all && !Number.isNaN(n.x)) continue;
      const r = rng(hash(n.id)), a = A.get(n.c1) || { x: 0, y: 0 };
      const nb = G.edges.find(e => (e.a === n && !Number.isNaN(e.b.x)) || (e.b === n && !Number.isNaN(e.a.x)));
      const base = !all && nb ? (nb.a === n ? nb.b : nb.a) : a;
      const ang = r() * Math.PI * 2, d = (all ? 30 + r() * 60 : 12 + r() * 14);
      n.x = base.x + Math.cos(ang) * d; n.y = base.y + Math.sin(ang) * d;
    }
  }

  // ---------- physics (springs on links, push between dots, pull toward the topic home) ----------
  function step(alpha) {
    const N = G.nodes, A = G.anchors, CELL = 90, grid = new Map();
    for (const n of N) {
      const k = Math.floor(n.x / CELL) + ',' + Math.floor(n.y / CELL);
      let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(n);
    }
    for (const n of N) {
      const gx = Math.floor(n.x / CELL), gy = Math.floor(n.y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const c = grid.get((gx + i) + ',' + (gy + j)); if (!c) continue;
        for (const m of c) {
          if (m === n) continue;
          let dx = n.x - m.x, dy = n.y - m.y, d2 = dx * dx + dy * dy;
          if (d2 > CELL * CELL) continue;
          if (d2 < 0.01) { dx = (hash(n.id) % 7) - 3 || 1; dy = 1; d2 = dx * dx + 1; }
          const minD = n.r + m.r + 6;
          const f = (900 / d2 + (d2 < minD * minD ? 0.6 : 0)) * alpha;
          n.vx += dx * f * 0.05; n.vy += dy * f * 0.05;
        }
      }
    }
    for (const e of G.edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const same = e.a.c1 === e.b.c1, L = (same ? 34 : 90) + (1 - e.w) * 40;
      const k = (same ? 0.06 : 0.015) * alpha * (d - L) / d;
      const ka = 1 / (1 + e.a.deg * 0.15), kb = 1 / (1 + e.b.deg * 0.15);
      e.a.vx += dx * k * ka; e.a.vy += dy * k * ka; e.b.vx -= dx * k * kb; e.b.vy -= dy * k * kb;
    }
    for (const n of N) {
      const a = A.get(n.c1) || { x: 0, y: 0 };
      n.vx += (a.x - n.x) * 0.012 * alpha - n.x * 0.0015 * alpha;
      n.vy += (a.y - n.y) * 0.012 * alpha - n.y * 0.0015 * alpha;
      if (G.drag && G.drag.node === n) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.62; n.vy *= 0.62;
      n.x += Math.max(-20, Math.min(20, n.vx)); n.y += Math.max(-20, Math.min(20, n.vy));
    }
  }
  function settle(ticks) { for (let i = 0; i < ticks; i++) step(1 - i / ticks * 0.8); }

  // ---------- view ----------
  const toScreen = (x, y) => [x * G.view.k + G.view.x, y * G.view.k + G.view.y];
  const toWorld = (sx, sy) => [(sx - G.view.x) / G.view.k, (sy - G.view.y) / G.view.k];
  const nodeR = (n) => n.r * Math.pow(Math.max(0.35, Math.min(3, G.view.k)), 0.55);
  const shown = (n) => !G.hidden.has(n.c1) && n.deg >= G.minDeg;

  function viewFor(list, pad) {
    if (!list.length) return { x: G.W / 2, y: G.H / 2, k: 1 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const w = Math.max(80, x1 - x0), h = Math.max(80, y1 - y0);
    const k = Math.max(0.15, Math.min(2.6, Math.min((G.W - pad * 2) / w, (G.H - pad * 2) / h)));
    return { k, x: G.W / 2 - (x0 + x1) / 2 * k, y: G.H / 2 - (y0 + y1) / 2 * k };
  }
  function animateTo(v, ms = 520) {
    if (REDUCED || ms === 0) { G.view = v; G.anim = null; G.dirty = true; wake(); return; }
    G.anim = { from: { ...G.view }, to: v, t0: performance.now(), ms }; wake();
  }
  function fit(animate = true) {
    const list = G.nodes.filter(shown);
    animateTo(viewFor(list.length ? list : G.nodes, Math.min(G.W, G.H) < 420 ? 28 : 48), animate ? 520 : 0);
  }
  function zoomAt(sx, sy, factor, animate) {
    const k = Math.max(0.15, Math.min(6, G.view.k * factor));
    const [wx, wy] = toWorld(sx, sy);
    const v = { k, x: sx - wx * k, y: sy - wy * k };
    if (animate) animateTo(v, 220); else { G.view = v; G.anim = null; G.dirty = true; wake(); }
  }

  function resize() {
    const c = $('graphCanvas'); if (!c) return;
    const r = c.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const oldW = G.W, oldH = G.H;
    G.W = r.width; G.H = r.height;
    G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(G.W * G.dpr); c.height = Math.round(G.H * G.dpr);
    if (oldW && oldH && G.nodes.length) { G.view.x += (G.W - oldW) / 2; G.view.y += (G.H - oldH) / 2; }
    G.dirty = true; wake();
  }

  // ---------- glow sprites (one per colour, drawn once) ----------
  const sprites = new Map();
  function sprite(rgb) {
    const key = rgb.join(',');
    if (sprites.has(key)) return sprites.get(key);
    const s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(rgb, 0.8)); gr.addColorStop(0.22, rgba(rgb, 0.38)); gr.addColorStop(0.55, rgba(rgb, 0.1)); gr.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    sprites.set(key, s); return s;
  }

  // ---------- light trails ----------
  function seedSparks() {
    G.sparks = [];
    if (REDUCED || !G.edges.length) return;
    const r = rng(7), n = Math.min(60, Math.round(G.edges.length * 0.25));
    for (let i = 0; i < n; i++) G.sparks.push({ e: G.edges[Math.floor(r() * G.edges.length)], t: r(), v: 0.0025 + r() * 0.004, dir: r() < 0.5 ? 1 : -1 });
  }

  // ---------- drawing ----------
  function edgeOn(e) { return shown(e.a) && shown(e.b) && (!G.strongOnly || e.w >= STRONG); }
  function draw(now = performance.now()) {
    const c = $('graphCanvas'); if (!c) return;
    const g = c.getContext('2d'), d = G.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, G.W, G.H);
    const focus = G.selected || G.hover;
    const nbr = focus ? new Set(G.edges.filter(e => e.a === focus || e.b === focus).flatMap(e => [e.a, e.b])) : null;
    const M = G.matches;
    const dimmed = (n) => (M && !M.has(n)) || (nbr && !nbr.has(n));

    // edges: batched by colour so 1,000+ lines stay cheap
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    const batches = new Map(), hot = [];
    for (const e of G.edges) {
      if (!edgeOn(e)) continue;
      if (nbr && (e.a === focus || e.b === focus)) { hot.push(e); continue; }
      const key = e.a.rgb.join(',') + (dimmed(e.a) || dimmed(e.b) ? '|d' : '');
      let b = batches.get(key); if (!b) batches.set(key, b = { rgb: e.a.rgb, dim: key.endsWith('|d'), list: [] });
      b.list.push(e);
    }
    g.lineWidth = Math.max(0.6, Math.min(1.6, 0.9 * Math.sqrt(G.view.k)));
    for (const b of batches.values()) {
      g.strokeStyle = rgba(b.rgb, b.dim ? 0.05 : 0.26);
      g.beginPath();
      for (const e of b.list) { const [x1, y1] = toScreen(e.a.x, e.a.y), [x2, y2] = toScreen(e.b.x, e.b.y); g.moveTo(x1, y1); g.lineTo(x2, y2); }
      g.stroke();
    }
    for (const e of hot) {
      const [x1, y1] = toScreen(e.a.x, e.a.y), [x2, y2] = toScreen(e.b.x, e.b.y);
      const gr = g.createLinearGradient(x1, y1, x2, y2);
      gr.addColorStop(0, rgba(e.a.rgb, 0.85)); gr.addColorStop(1, rgba(e.b.rgb, 0.85));
      g.strokeStyle = gr; g.lineWidth = 1.2 + e.w * 1.6;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    // light trails
    if (!REDUCED) {
      for (const s of G.sparks) {
        s.t += s.v * s.dir; if (s.t > 1) s.t -= 1; if (s.t < 0) s.t += 1;
        if (!edgeOn(s.e) || (M && (!M.has(s.e.a) || !M.has(s.e.b)))) continue;
        const [x1, y1] = toScreen(s.e.a.x, s.e.a.y), [x2, y2] = toScreen(s.e.b.x, s.e.b.y);
        const px = x1 + (x2 - x1) * s.t, py = y1 + (y2 - y1) * s.t;
        const tail = 0.12 * s.dir, tx = x1 + (x2 - x1) * (s.t - tail), ty = y1 + (y2 - y1) * (s.t - tail);
        const gr = g.createLinearGradient(tx, ty, px, py);
        gr.addColorStop(0, rgba(s.e.a.rgb, 0)); gr.addColorStop(1, rgba([230, 250, 255], 0.75));
        g.strokeStyle = gr; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(px, py); g.stroke();
      }
    }

    // nodes: glow, then a solid core with a bright rim
    const vis = [];
    for (const n of G.nodes) {
      if (!shown(n)) continue;
      const [x, y] = toScreen(n.x, n.y), r = nodeR(n);
      if (x < -40 || y < -40 || x > G.W + 40 || y > G.H + 40) continue;
      vis.push([n, x, y, r]);
    }
    for (const [n, x, y, r] of vis) {
      const dim = dimmed(n);
      g.globalAlpha = dim ? 0.18 : (n === focus ? 1 : 0.85);
      const s = r * (n === focus ? 7 : 5.2);
      g.drawImage(sprite(n.rgb), x - s / 2, y - s / 2, s, s);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    for (const [n, x, y, r] of vis) {
      const dim = dimmed(n);
      g.fillStyle = dim ? rgba(n.rgb, 0.22) : rgba(n.rgb, 0.95);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (!dim) { g.fillStyle = 'rgba(240,252,255,0.85)'; g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, Math.max(0.8, r * 0.32), 0, Math.PI * 2); g.fill(); }
      if (M && M.has(n)) { g.strokeStyle = 'rgba(240,252,255,0.9)'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke(); }
      if (n.pulse && now - n.pulse < 2400) {
        const p = (now - n.pulse) / 2400;
        g.strokeStyle = rgba(n.rgb, 1 - p); g.lineWidth = 2; g.beginPath(); g.arc(x, y, r + 4 + p * 26, 0, Math.PI * 2); g.stroke();
      }
    }
    // gentle pulse on the dot under the pointer (static ring with reduced motion)
    if (focus && shown(focus)) {
      const [x, y] = toScreen(focus.x, focus.y), r = nodeR(focus);
      const p = REDUCED ? 0.5 : ((now - G.t0) % 1600) / 1600;
      g.strokeStyle = rgba(focus.rgb, REDUCED ? 0.8 : 0.9 * (1 - p)); g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, r + 3 + p * 12, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(240,252,255,0.95)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, r + 2, 0, Math.PI * 2); g.stroke();
    }
    // labels: search matches (when there are few) and big hubs when zoomed in
    g.font = '500 12px "JetBrains Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';
    const labelled = [];
    if (M && M.size <= 14) for (const [n, x, y, r] of vis) if (M.has(n)) labelled.push([n, x, y, r]);
    if (!M && G.view.k > 1.5) for (const [n, x, y, r] of vis) if (n.deg >= Math.max(5, G.maxDeg * 0.6)) labelled.push([n, x, y, r]);
    for (const [n, x, y, r] of labelled.slice(0, 18)) {
      if (n === G.hover) continue;
      const t = n.label.length > 34 ? n.label.slice(0, 33) + '…' : n.label, w = g.measureText(t).width;
      const lx = Math.min(G.W - w - 12, Math.max(6, x + r + 8)), ly = y;
      g.fillStyle = 'rgba(5,8,16,0.82)'; roundRect(g, lx - 6, ly - 10, w + 12, 20, 6); g.fill();
      g.fillStyle = '#E6F6FF'; g.fillText(t, lx, ly + 0.5);
    }
    G.dirty = false;
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  function frame(now) {
    G.raf = 0;
    if (!G.visible || document.hidden) return;
    if (G.anim) {
      const a = G.anim, p = Math.min(1, (now - a.t0) / a.ms), e = 1 - Math.pow(1 - p, 3);
      G.view = { k: a.from.k + (a.to.k - a.from.k) * e, x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e };
      if (p >= 1) G.anim = null;
      G.dirty = true;
    }
    if (G.alpha > 0.005) { step(G.alpha); G.alpha *= 0.985; G.dirty = true; if (G.preview) placePreview(); }
    const pulsing = G.nodes.some(n => n.pulse && now - n.pulse < 2400);
    const live = !REDUCED && (G.sparks.length || G.hover || G.selected || pulsing);
    if (G.dirty || live) draw(now);
    if (G.anim || G.alpha > 0.005 || live || G.drag) wake();
  }
  function wake() { G.dirty = true; if (!G.raf && G.visible) G.raf = requestAnimationFrame(frame); }

  // ---------- preview card (hover on a computer, tap on a phone) ----------
  function topicName(n) { const c = G.cById.get(n.c1); return c ? c.name : 'No topic yet'; }
  function showPreview(n, touch) {
    const el = $('graphPreview'); if (!el) return;
    G.preview = { n, touch };
    const date = new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    el.innerHTML = `<div class="gp-topic"><span class="gs-dot" style="background:${rgba(n.rgb, 1)}; color:${rgba(n.rgb, 1)}"></span>${esc(topicName(n))}</div>
      <div class="gp-title">${esc(n.label.length > 140 ? n.label.slice(0, 139) + '…' : n.label)}</div>
      <div class="gp-meta"><span><b>${n.deg}</b> ${n.deg === 1 ? 'connection' : 'connections'}</span><span>${esc(date)}</span></div>
      ${touch ? `<button type="button" class="gp-open" data-gp-open="${esc(n.id)}">Open thought</button>` : '<div class="gp-hint">Click to open</div>'}`;
    el.hidden = false; el.classList.toggle('touch', !!touch);
    placePreview();
  }
  function placePreview() {
    const el = $('graphPreview'); if (!el || !G.preview) return;
    const n = G.preview.n, [x, y] = toScreen(n.x, n.y), r = nodeR(n);
    const w = el.offsetWidth || 240, h = el.offsetHeight || 110;
    let left = x + r + 14, top = y - h / 2;
    if (left + w > G.W - 8) left = x - r - 14 - w;
    if (left < 8) { left = Math.max(8, Math.min(G.W - w - 8, x - w / 2)); top = y + r + 14; if (top + h > G.H - 8) top = y - r - 14 - h; }
    top = Math.max(8, Math.min(G.H - h - 8, top));
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function hidePreview() { const el = $('graphPreview'); G.preview = null; if (el) { el.hidden = true; el.innerHTML = ''; } }

  // ---------- the side sheet with the whole thought ----------
  function select(n) {
    G.selected = n;
    const sheet = $('graphSheet');
    sheet.parentElement.scrollLeft = 0; sheet.parentElement.scrollTop = 0;   // focus inside the sheet must never scroll the map
    if (!n) { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); wake(); return; }
    hidePreview();
    const near = G.edges.filter(e => e.a === n || e.b === n).sort((a, b) => b.w - a.w).slice(0, 6).map(e => (e.a === n ? e.b : e.a));
    sheet.innerHTML = `
      <div class="gs-top"><span class="gs-dot" style="background:${rgba(n.rgb, 1)}; color:${rgba(n.rgb, 1)}"></span>
        <span class="gs-topic">${esc(topicName(n))}</span>
        <button class="secondary icon-btn gs-close" type="button" aria-label="Close" data-gs-close="1">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gs-date">${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''} · ${n.deg} ${n.deg === 1 ? 'connection' : 'connections'}</div>
      <div class="gs-text" id="gsText">${esc(n.label)}</div>
      <button type="button" data-gs-open="${esc(n.id)}" style="width:100%; margin-top:12px;">Read the full thought</button>
      ${near.length ? `<div class="gs-near-title">Connected</div>${near.map(m => `
        <button type="button" class="gs-near" data-gs-jump="${esc(m.id)}"><span class="gs-dot" style="background:${rgba(m.rgb, 1)}; color:${rgba(m.rgb, 1)}"></span><span>${esc(m.label)}</span></button>`).join('')}` : ''}`;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
    const k = Math.max(G.view.k, 1.1), wide = G.W > 720;
    animateTo({ k, x: (wide ? G.W * 0.38 : G.W / 2) - n.x * k, y: (wide ? G.H / 2 : G.H * 0.28) - n.y * k });
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

  // ---------- pointer: hover, tap, drag, pinch, wheel ----------
  function local(e) { const r = $('graphCanvas').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hit(sx, sy, slop) {
    let best = null, bd = Infinity;
    for (const n of G.nodes) {
      if (!shown(n)) continue;
      const [x, y] = toScreen(n.x, n.y), r = nodeR(n) + slop, d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < r * r && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  function onDown(e) {
    const c = $('graphCanvas');
    c.setPointerCapture && c.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    G.pointers.set(e.pointerId, { x, y });
    if (G.pointers.size === 2) {
      const [p, q] = [...G.pointers.values()];
      G.drag = { pinch: true, d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, k0: G.view.k, view0: { ...G.view }, mid: [(p.x + q.x) / 2, (p.y + q.y) / 2] };
      return;
    }
    const n = hit(x, y, e.pointerType === 'mouse' ? 3 : 12);
    G.drag = { x0: x, y0: y, view0: { ...G.view }, node: n, moved: false, type: e.pointerType };
    G.anim = null;
    c.classList.add('grabbing');
  }
  function onMove(e) {
    const [x, y] = local(e);
    if (G.pointers.has(e.pointerId)) G.pointers.set(e.pointerId, { x, y });
    const D = G.drag;
    if (D && D.pinch && G.pointers.size >= 2) {
      const [p, q] = [...G.pointers.values()];
      const k = Math.max(0.15, Math.min(6, D.k0 * (Math.hypot(p.x - q.x, p.y - q.y) / D.d0)));
      const mid = [(p.x + q.x) / 2, (p.y + q.y) / 2];
      const wx = (D.mid[0] - D.view0.x) / D.view0.k, wy = (D.mid[1] - D.view0.y) / D.view0.k;
      G.view = { k, x: mid[0] - wx * k, y: mid[1] - wy * k };
      hidePreview(); wake(); return;
    }
    if (D) {
      if (!D.moved && Math.hypot(x - D.x0, y - D.y0) > (D.type === 'mouse' ? 3 : 8)) { D.moved = true; hidePreview(); }
      if (!D.moved) return;
      if (D.node) {
        const [wx, wy] = toWorld(x, y);
        D.node.x = wx; D.node.y = wy; D.node.vx = D.node.vy = 0;
        G.alpha = Math.max(G.alpha, 0.12);
      } else {
        G.view = { ...D.view0, x: D.view0.x + (x - D.x0), y: D.view0.y + (y - D.y0) };
      }
      wake(); return;
    }
    if (e.pointerType === 'mouse') {
      const n = hit(x, y, 3);
      if (n !== G.hover) {
        G.hover = n;
        $('graphCanvas').style.cursor = n ? 'pointer' : '';
        if (n) showPreview(n, false); else hidePreview();
        wake();
      }
    }
  }
  function onUp(e) {
    G.pointers.delete(e.pointerId);
    const D = G.drag;
    $('graphCanvas').classList.remove('grabbing');
    if (D && D.pinch) { if (G.pointers.size === 0) G.drag = null; return; }
    G.drag = null;
    if (!D || D.moved || e.type === 'pointercancel') { wake(); return; }
    const n = D.node;
    if (D.type === 'mouse') { if (n) select(n); else { select(null); hidePreview(); } return; }
    // touch / pen: first tap shows the preview, tapping the same dot again opens it
    if (!n) { G.hover = null; hidePreview(); wake(); return; }
    if (G.preview && G.preview.n === n) { select(n); return; }
    G.hover = n; showPreview(n, true); wake();
  }
  function onLeave() { if (!G.drag && G.hover && !(G.preview && G.preview.touch)) { G.hover = null; hidePreview(); wake(); } }

  // ---------- search, filters, legend ----------
  function applySearch(focus) {
    const q = G.query.trim().toLowerCase();
    const out = $('graphSearchCount');
    if (!q) { G.matches = null; if (out) out.textContent = ''; wake(); return; }
    const words = q.split(/\s+/).filter(Boolean);
    const list = G.nodes.filter(n => shown(n) && words.every(w => (n.label + ' ' + topicName(n) + ' ' + (n.cat || '')).toLowerCase().includes(w)));
    G.matches = new Set(list);
    if (out) out.textContent = list.length ? `${list.length} ${list.length === 1 ? 'match' : 'matches'}` : 'No matches';
    if (focus && list.length) animateTo(viewFor(list, Math.min(G.W, G.H) < 420 ? 50 : 90));
    wake();
  }
  function renderControls() {
    const el = $('graphLegend');
    if (el) {
      el.innerHTML = G.clusters.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).map(c => {
        const on = !G.hidden.has(c.id), n = G.nodes.filter(x => x.c1 === c.id).length;
        return `<button type="button" class="chip legend-chip ${on ? 'on' : 'off'}" data-topic="${esc(c.id)}" aria-pressed="${on}">
          <span class="gs-dot" style="background:${rgba(c.rgb, 1)}; color:${rgba(c.rgb, 1)}"></span>${esc(c.name)}<span class="legend-n">${n}</span></button>`;
      }).join('');
    }
    const r = $('graphMinDeg');
    if (r) { r.max = String(Math.max(1, G.maxDeg || 1)); if (G.minDeg > G.maxDeg) G.minDeg = 0; r.value = String(G.minDeg); }
    updateStats();
  }
  function updateStats() {
    const v = $('graphMinDegValue'); if (v) v.textContent = String(G.minDeg);
    const s = $('graphStats');
    if (s) {
      const nodes = G.nodes.filter(shown).length, edges = G.edges.filter(edgeOn).length;
      s.innerHTML = `<span><b>${nodes}</b> thoughts</span><span><b>${edges}</b> links</span><span><b>${G.clusters.length - G.hidden.size}</b> topics</span>`;
    }
    const all = $('graphShowAll'); if (all) all.hidden = !G.hidden.size && !G.minDeg;
  }
  function filtersChanged() {
    if (G.selected && !shown(G.selected)) select(null);
    if (G.preview && !shown(G.preview.n)) { G.hover = null; hidePreview(); }
    renderControls(); applySearch(false); wake();
  }

  function note(text) {
    const el = $('graphNote'); if (!el) return;
    el.textContent = text; el.style.opacity = '1'; clearTimeout(el._h); el._h = setTimeout(() => { el.style.opacity = '0'; }, 3500);
  }

  let loading = false;
  async function fetchGraph({ quiet } = {}) {
    if (loading) return;
    if (!navigator.onLine) {
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value, { fresh: false }); else $('graphStatus').textContent = 'Your map needs a connection the first time.';
      }
      return;
    }
    loading = true;
    if (!quiet && !G.nodes.length) $('graphStatus').textContent = 'Wiring up your brain…';
    try {
      const { data, error } = await sb.rpc('brain_graph');
      if (error) throw error;
      ingest(data, { fresh: G.nodes.length > 0 });
      obCache.put('graph', data);                    // short labels only, never full thoughts
      $('graphStatus').textContent = G.nodes.length ? '' : 'No thoughts on your map yet. Save a few and they appear here.';
    } catch (err) {
      console.warn('brain_graph failed:', err);
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value, { fresh: false });
        $('graphStatus').textContent = c ? '' : 'Could not load your map: ' + (err.message || 'unknown error');
      }
    } finally { loading = false; }
  }

  function setup() {
    const c = $('graphCanvas'); if (!c) return;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      hidePreview(); G.hover = null;
      zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), false);
    }, { passive: false });
    $('graphZoomIn')?.addEventListener('click', () => zoomAt(G.W / 2, G.H / 2, 1.35, true));
    $('graphZoomOut')?.addEventListener('click', () => zoomAt(G.W / 2, G.H / 2, 1 / 1.35, true));
    $('graphFit')?.addEventListener('click', () => { select(null); hidePreview(); G.hover = null; fit(); });
    $('graphLinks')?.addEventListener('click', () => {
      G.strongOnly = !G.strongOnly;
      $('graphLinks').textContent = G.strongOnly ? 'Strong links' : 'All links';
      $('graphLinks').setAttribute('aria-pressed', String(G.strongOnly));
      updateStats(); wake();
    });
    $('graphLegend')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-topic]'); if (!b) return;
      const id = G.clusters.find(c => String(c.id) === b.dataset.topic)?.id;
      if (id === undefined) return;
      if (G.hidden.has(id)) G.hidden.delete(id); else G.hidden.add(id);
      if (G.hidden.size === G.clusters.length) G.hidden.delete(id);   // never hide everything
      filtersChanged();
    });
    $('graphMinDeg')?.addEventListener('input', (e) => { G.minDeg = Number(e.target.value) || 0; filtersChanged(); });
    $('graphShowAll')?.addEventListener('click', () => { G.hidden.clear(); G.minDeg = 0; filtersChanged(); fit(); });
    let t = 0;
    $('graphSearch')?.addEventListener('input', (e) => { G.query = e.target.value; clearTimeout(t); t = setTimeout(() => applySearch(true), 220); });
    $('graphSearchForm')?.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(t); G.query = $('graphSearch').value; applySearch(true); document.activeElement?.blur?.(); });
    $('graphSearchClear')?.addEventListener('click', () => { $('graphSearch').value = ''; G.query = ''; applySearch(false); fit(); });
    $('graphSheet')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.gsClose) select(null);
      else if (b.dataset.gsOpen) openFull(b.dataset.gsOpen);
      else if (b.dataset.gsJump) { const n = G.byId.get(b.dataset.gsJump); if (n) select(n); }
    });
    $('graphPreview')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gp-open]'); if (!b) return;
      const n = G.byId.get(b.dataset.gpOpen); if (n) select(n);
    });
    document.addEventListener('keydown', (e) => {
      if (!G.visible || e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') { select(null); hidePreview(); G.hover = null; wake(); }
      if (e.key === '+' || e.key === '=') zoomAt(G.W / 2, G.H / 2, 1.25, true);
      if (e.key === '-') zoomAt(G.W / 2, G.H / 2, 0.8, true);
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
    hide() { G.visible = false; stop(); hidePreview(); },
    reset() {                                        // forget the current map (used by the preview page)
      G.nodes = []; G.byId = new Map(); G.edges = []; G.selected = null; G.hover = null; G.hidden.clear(); G.minDeg = 0; G.query = ''; G.matches = null;
      G.view = { x: 0, y: 0, k: 1 }; $('graphSheet')?.classList.remove('open'); hidePreview();
    },
    fit,
    _draw: (t) => draw(t),                          // for the browser test (timing)
    _state: G,                                       // for the browser test
    _screenOf(id) {                                  // for the browser test: where a dot is on the page
      const n = G.byId.get(id); if (!n) return null;
      const r = $('graphCanvas').getBoundingClientRect(), [x, y] = toScreen(n.x, n.y);
      return { x: r.left + x, y: r.top + y };
    },
  };
})();
