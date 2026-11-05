// graph.js — the thought map (Brain screen > Map). v5, Nov 2026 (design-v4, "glass" look).
// A flat, calm map of your thoughts on a floating glass panel:
//   - one soft round dot per thought, colored by topic (legend under the map)
//   - bigger dot = more connections; lines = thought_links ("Strong links only" hides weak ones)
//   - hover (or tap on a phone) shows a small preview card: first words, topic, connections
//   - click a dot (or "Open" on the card) to read the whole thought and jump to linked ones
//   - zoom: mouse wheel / trackpad, pinch, the + and − buttons, or + / − keys; drag to move
//   - "Fit" (or 0) eases back to the whole map
//   - search box: matching dots light up and the map glides to them
//   - filters: tap a topic in the legend to hide/show it; "Min links" hides loosely linked dots
// Layout: a small force simulation runs once when the data arrives (same result every time),
// then the map only redraws while something moves, so it stays smooth with hundreds of dots.
// Data: the brain_graph() function in Supabase, called with your login (RLS applies).
// No library: canvas + a little math, so it works offline from the saved copy.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const mq = (q) => (window.matchMedia ? matchMedia(q) : { matches: false, addEventListener() {} });
  const REDUCED_MQ = mq('(prefers-reduced-motion: reduce)');
  const reduced = () => REDUCED_MQ.matches;
  const STRONG = 0.70;              // "strong link" cutoff (similarity)
  const POLL_MS = 40000;
  const MIN_K = 0.25, MAX_K = 6;

  // Topic colors: soft, saturated, readable on light and dark glass.
  const PALETTE = ['#30B26B', '#3478F6', '#F29A2E', '#A35BDB', '#22A7C9', '#E8507A', '#8E8E93', '#C8A02C', '#5E5CE6', '#FF6B4A'];
  const hex2rgb = (h) => { const x = parseInt(String(h || '#8E8E93').replace('#', ''), 16); return [x >> 16 & 255, x >> 8 & 255, x & 255]; };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // ---------- seeded random: the map looks the same every time you open it ----------
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ---------- state ----------
  const G = {
    nodes: [], byId: new Map(), edges: [], clusters: [], cById: new Map(),
    cam: { x: 0, y: 0, k: 1 }, target: { x: 0, y: 0, k: 1 }, W: 0, H: 0, dpr: 1,
    strongOnly: false, hiddenTopics: new Set(), minLinks: 0, query: '', matches: null,
    hover: null, pinned: null, selected: null, pointers: new Map(), gesture: null,
    visible: false, raf: 0, poll: 0, dirty: true, lastT: 0, at: null, theme: null, maxDeg: 0,
  };

  // ---------- theme colors (read from CSS so light/dark both work) ----------
  function readTheme() {
    const cs = getComputedStyle($('graphCanvas').parentElement);
    const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    G.theme = {
      edge: v('--graph-edge', 'rgba(60,60,67,.16)'), ring: v('--graph-ring', '#ffffff'),
      label: v('--graph-label', '#1d1d1f'), labelBg: v('--graph-label-bg', 'rgba(255,255,255,.78)'),
      match: v('--graph-match', '#0a84ff'), font: v('--font', 'system-ui, sans-serif'),
    };
    G.dirty = true;
  }

  // ---------- layout: topics on a ring, a short force simulation inside ----------
  function layout(keep) {
    const N = G.nodes.length;
    if (!N) return;
    const topics = G.clusters.map(c => c.id);
    const ring = Math.max(140, 70 * Math.sqrt(N / Math.max(1, topics.length))) + 40 * topics.length;
    // Tall phone screen: a taller ring, so the map fills it.
    const aspect = G.W && G.H ? Math.max(0.75, Math.min(1.7, G.H / G.W)) : 0.82;
    const sx = aspect > 1 ? 0.85 : 1, sy = aspect > 1 ? aspect * 0.85 : aspect;
    const center = new Map(topics.map((id, i) => {
      const a = -Math.PI / 2 + (i / Math.max(1, topics.length)) * Math.PI * 2;
      return [id, { x: Math.cos(a) * ring * sx, y: Math.sin(a) * ring * sy }];
    }));
    for (const n of G.nodes) {
      if (keep && n.x != null) continue;
      const r = rng(hash(n.id)), c = center.get(n.c1) || { x: 0, y: 0 };
      const a = r() * Math.PI * 2, d = 20 + r() * 90;
      n.x = c.x + Math.cos(a) * d; n.y = c.y + Math.sin(a) * d;
    }
    const idx = new Map(G.nodes.map((n, i) => [n.id, i]));
    const E = G.edges.map(e => [idx.get(e.a), idx.get(e.b), e.w, G.byId.get(e.a).c1 === G.byId.get(e.b).c1 ? 0.04 : 0.006]).filter(e => e[0] != null && e[1] != null);
    const X = new Float64Array(N), Y = new Float64Array(N), VX = new Float64Array(N), VY = new Float64Array(N), R = new Float64Array(N);
    G.nodes.forEach((n, i) => { X[i] = n.x; Y[i] = n.y; R[i] = n.r; });
    const CX = G.nodes.map(n => (center.get(n.c1) || { x: 0 }).x), CY = G.nodes.map(n => (center.get(n.c1) || { y: 0 }).y);
    const iters = keep ? 120 : 260;
    for (let it = 0; it < iters; it++) {
      const alpha = 1 - it / iters, rep = 900 * (0.4 + alpha);
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          let dx = X[i] - X[j], dy = Y[i] - Y[j];
          let d2 = dx * dx + dy * dy;
          if (d2 > 40000) continue;                       // only neighbours push each other
          if (d2 < 0.01) { dx = 0.1 * (i - j); dy = 0.1; d2 = 0.02; }
          const minD = R[i] + R[j] + 6;
          let f = rep / d2;
          if (d2 < minD * minD) f += 0.6 * (minD - Math.sqrt(d2)) / Math.sqrt(d2);
          VX[i] += dx * f * 0.05; VY[i] += dy * f * 0.05; VX[j] -= dx * f * 0.05; VY[j] -= dy * f * 0.05;
        }
      }
      for (const [a, b, w, k] of E) {
        const dx = X[b] - X[a], dy = Y[b] - Y[a], d = Math.sqrt(dx * dx + dy * dy) || 1;
        const want = 46 + R[a] + R[b] - 30 * (w - 0.5);
        const f = (d - want) / d * k;
        VX[a] += dx * f; VY[a] += dy * f; VX[b] -= dx * f; VY[b] -= dy * f;
      }
      for (let i = 0; i < N; i++) {
        VX[i] += (CX[i] - X[i]) * 0.02; VY[i] += (CY[i] - Y[i]) * 0.02;
        VX[i] *= 0.62; VY[i] *= 0.62;
        X[i] += Math.max(-30, Math.min(30, VX[i])); Y[i] += Math.max(-30, Math.min(30, VY[i]));
      }
    }
    G.nodes.forEach((n, i) => { n.x = X[i]; n.y = Y[i]; });
  }

  // ---------- data in ----------
  function ingest(data, { fresh }) {
    const firstTime = G.byId.size === 0;
    G.clusters = (data.clusters || []).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    G.cById = new Map(G.clusters.map((c, i) => [c.id, { ...c, rgb: hex2rgb(c.color || PALETTE[i % PALETTE.length]) }]));
    const old = G.byId;
    const nodes = (data.nodes || []).map(r => {
      const prev = old.get(r.id), n = prev || { id: r.id };
      Object.assign(n, { label: String(r.label || ''), cat: r.cat, at: new Date(r.at).getTime(), c1: r.c1, c2: r.c2, w: Number(r.w) || 0, deg: 0 });
      n.isNew = !prev;
      return n;
    });
    G.nodes = nodes; G.byId = new Map(nodes.map(n => [n.id, n]));
    G.edges = (data.edges || []).map(([a, b, w]) => ({ a, b, w: Number(w) })).filter(e => G.byId.has(e.a) && G.byId.has(e.b));
    for (const e of G.edges) { G.byId.get(e.a).deg++; G.byId.get(e.b).deg++; }
    G.maxDeg = nodes.reduce((m, n) => Math.max(m, n.deg), 0);
    const topHub = new Map();
    for (const n of nodes) if (!topHub.has(n.c1) || topHub.get(n.c1).deg < n.deg) topHub.set(n.c1, n);
    for (const n of nodes) {
      n.hub = topHub.get(n.c1) === n;
      const c = G.cById.get(n.c1);
      n.rgb = c ? c.rgb : [142, 142, 147];
      n.r = Math.min(22, 5 + 2.4 * Math.sqrt(n.deg));
      n.nbr = [];
    }
    for (const e of G.edges) { const a = G.byId.get(e.a), b = G.byId.get(e.b); a.nbr.push([b, e.w]); b.nbr.push([a, e.w]); }
    const added = nodes.filter(n => n.isNew && !firstTime);
    if (firstTime) { resize(); layout(false); } else if (added.length) layout(true);
    nodes.forEach(n => { n.isNew = false; });
    if (fresh && added.length) note(`${added.length} new ${added.length === 1 ? 'thought' : 'thoughts'} just landed on your map`);
    G.at = data.at;
    const slider = $('graphMinLinks');
    slider.max = String(Math.max(1, Math.min(12, G.maxDeg)));
    if (G.minLinks > Number(slider.max)) setMinLinks(Number(slider.max));
    renderLegend();
    applySearch(false);
    $('graphCanvas').setAttribute('aria-label', `Map of ${nodes.length} thoughts in ${G.clusters.length} topics`);
    if (firstTime) { resize(); fit(true); }
    G.dirty = true; wake();
  }

  function note(text) {
    const el = $('graphNote');
    el.textContent = text;
    el.classList.add('show'); clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), 3200);
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
    if (!quiet && !G.nodes.length) $('graphStatus').textContent = 'Drawing your map…';
    try {
      const { data, error } = await sb.rpc('brain_graph');
      if (error) throw error;
      ingest(data, { fresh: G.nodes.length > 0 });
      obCache.put('graph', data);                    // short labels only, never full thoughts
      $('graphStatus').textContent = G.nodes.length ? '' : 'No thoughts on your map yet. Save one and it appears here.';
    } catch (err) {
      console.warn('brain_graph failed:', err);
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value, { fresh: false });
        $('graphStatus').textContent = c ? '' : 'Could not load your map: ' + (err.message || 'unknown error');
      }
    } finally { loading = false; }
  }

  // ---------- what is shown ----------
  const isShown = (n) => !G.hiddenTopics.has(n.c1) && n.deg >= G.minLinks;
  const nodeR = (n) => n.r * Math.max(0.55, Math.min(1.8, Math.sqrt(G.cam.k)));
  const toScreen = (x, y, cam = G.cam) => ({ sx: (x - cam.x) * cam.k + G.W / 2, sy: (y - cam.y) * cam.k + G.H / 2 });
  const toWorld = (sx, sy, cam = G.cam) => ({ x: (sx - G.W / 2) / cam.k + cam.x, y: (sy - G.H / 2) / cam.k + cam.y });

  function hitTest(sx, sy) {
    let best = null, bd = Infinity;
    for (const n of G.nodes) {
      if (!isShown(n)) continue;
      const p = toScreen(n.x, n.y), r = nodeR(n) + 8;
      const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
      if (d < r * r && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ---------- drawing ----------
  function resize() {
    const wrap = $('graphCanvas').parentElement, r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    G.W = r.width; G.H = r.height;
    const c = $('graphCanvas'); c.width = Math.round(G.W * G.dpr); c.height = Math.round(G.H * G.dpr);
    if (!G.theme) readTheme();
    G.dirty = true; wake();
  }

  function draw() {
    const c = $('graphCanvas'), x = c.getContext('2d'), T = G.theme || {};
    x.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    x.clearRect(0, 0, G.W, G.H);
    if (!G.nodes.length) return;
    const focus = G.pinned || G.hover || G.selected;
    const near = focus ? new Set([focus.id, ...focus.nbr.map(([m]) => m.id)]) : null;
    const M = G.matches;
    const P = new Map();
    for (const n of G.nodes) if (isShown(n)) P.set(n.id, toScreen(n.x, n.y));

    // lines
    x.lineCap = 'round';
    x.strokeStyle = T.edge; x.lineWidth = 1;
    x.beginPath();
    for (const e of G.edges) {
      if (G.strongOnly && e.w < STRONG) continue;
      const a = P.get(e.a), b = P.get(e.b);
      if (!a || !b) continue;
      if (focus && (e.a === focus.id || e.b === focus.id)) continue;
      x.moveTo(a.sx, a.sy); x.lineTo(b.sx, b.sy);
    }
    x.globalAlpha = focus || M ? 0.45 : 1;
    x.stroke();
    x.globalAlpha = 1;
    if (focus && P.has(focus.id)) {
      x.strokeStyle = rgba(focus.rgb, 0.75); x.lineWidth = 2;
      x.beginPath();
      const a = P.get(focus.id);
      for (const [m, w] of focus.nbr) {
        if (G.strongOnly && w < STRONG) continue;
        const b = P.get(m.id); if (!b) continue;
        x.moveTo(a.sx, a.sy); x.lineTo(b.sx, b.sy);
      }
      x.stroke();
    }

    // dots: soft halo, white ring, topic color
    for (const n of G.nodes) {
      const p = P.get(n.id); if (!p) continue;
      const r = nodeR(n);
      if (p.sx < -r - 20 || p.sy < -r - 20 || p.sx > G.W + r + 20 || p.sy > G.H + r + 20) continue;
      const dim = (near && !near.has(n.id)) || (M && !M.has(n.id));
      x.globalAlpha = dim ? 0.18 : 1;
      x.fillStyle = rgba(n.rgb, 0.16);
      x.beginPath(); x.arc(p.sx, p.sy + 1.5, r + 4, 0, Math.PI * 2); x.fill();
      x.fillStyle = T.ring;
      x.beginPath(); x.arc(p.sx, p.sy, r + 2, 0, Math.PI * 2); x.fill();
      x.fillStyle = rgba(n.rgb, 1);
      x.beginPath(); x.arc(p.sx, p.sy, r, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(255,255,255,.28)';                 // a soft highlight, like light from above
      x.beginPath(); x.arc(p.sx - r * 0.3, p.sy - r * 0.35, r * 0.45, 0, Math.PI * 2); x.fill();
      if (M && M.has(n.id)) {
        x.strokeStyle = T.match; x.lineWidth = 2.5;
        x.beginPath(); x.arc(p.sx, p.sy, r + 5, 0, Math.PI * 2); x.stroke();
      }
      if (n === focus) {
        x.strokeStyle = rgba(n.rgb, 0.9); x.lineWidth = 2;
        x.beginPath(); x.arc(p.sx, p.sy, r + 6, 0, Math.PI * 2); x.stroke();
      }
    }
    x.globalAlpha = 1;

    // labels: when zoomed in, for big dots, and for matches
    const showAll = G.cam.k >= 1.7;
    x.font = `600 12px ${T.font}`;
    x.textAlign = 'center'; x.textBaseline = 'top';
    const placed = [];                                   // never draw a label on top of another
    const order = G.nodes.filter(n => P.has(n.id)).sort((a, b) => (b === focus) - (a === focus) || b.deg - a.deg);
    for (const n of order) {
      const p = P.get(n.id);
      const want = n === focus || (M && M.has(n.id) && M.size <= 12) || (showAll && (n.deg >= 4 || G.cam.k >= 2.6)) || (!M && !focus && n.hub);
      if (!want || (near && !near.has(n.id))) continue;
      if (p.sx < 0 || p.sy < 0 || p.sx > G.W || p.sy > G.H) continue;
      const text = shortLabel(n.label, 26), w = x.measureText(text).width + 12, y = p.sy + nodeR(n) + 6;
      const box = [p.sx - w / 2 - 3, y - 4, p.sx + w / 2 + 3, y + 19];
      if (placed.some(b => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
      placed.push(box);
      x.fillStyle = T.labelBg; roundRect(x, p.sx - w / 2, y - 2, w, 19, 9.5); x.fill();
      x.fillStyle = T.label; x.fillText(text, p.sx, y + 1);
    }
  }
  function roundRect(x, l, t, w, h, r) { x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r); x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath(); }
  function shortLabel(s, n) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }

  // ---------- animation: the camera glides to its target (spring-like ease) ----------
  function frame(t) {
    G.raf = 0;
    if (!G.visible) return;
    const dt = Math.min(64, t - (G.lastT || t)); G.lastT = t;
    const c = G.cam, g = G.target;
    let moving = false;
    if (reduced()) { c.x = g.x; c.y = g.y; c.k = g.k; }
    else {
      const a = 1 - Math.exp(-dt / 110);
      const dk = Math.log(g.k / c.k);
      if (Math.abs(g.x - c.x) * c.k > 0.3 || Math.abs(g.y - c.y) * c.k > 0.3 || Math.abs(dk) > 0.002) {
        c.x += (g.x - c.x) * a; c.y += (g.y - c.y) * a; c.k *= Math.exp(dk * a);
        moving = true;
      } else { c.x = g.x; c.y = g.y; c.k = g.k; }
    }
    if (moving || G.dirty) { draw(); placeHover(); G.dirty = false; }
    if (moving) wake();
  }
  function wake() { if (!G.raf && G.visible) { G.lastT = 0; G.raf = requestAnimationFrame(frame); } }
  function redraw() { G.dirty = true; wake(); }

  function clampK(k) { return Math.max(MIN_K, Math.min(MAX_K, k)); }
  function zoomBy(f, sx = G.W / 2, sy = G.H / 2) {
    const g = G.target, w = toWorld(sx, sy, g), k = clampK(g.k * f);
    G.target = { k, x: w.x - (sx - G.W / 2) / k, y: w.y - (sy - G.H / 2) / k };
    wake();
  }
  function fitTo(list, now, maxK = 2.2) {
    if (!list.length || !G.W) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
    const pad = 36, k = clampK(Math.min(maxK, (G.W - pad * 2) / Math.max(40, x1 - x0), (G.H - pad * 2 - 30) / Math.max(40, y1 - y0)));
    G.target = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 12 / k, k };
    if (now) G.cam = { ...G.target };
    wake();
  }
  function fit(now) { fitTo(G.nodes.filter(isShown).length ? G.nodes.filter(isShown) : G.nodes, now === true); }
  function focusOn(n, k = 2.4) { G.target = { x: n.x, y: n.y + 30 / k, k: Math.max(G.target.k, k) }; wake(); }

  // ---------- hover / tap preview card ----------
  function cardHtml(n) {
    const c = G.cById.get(n.c1);
    const first = shortLabel(String(n.label).split(/\n/)[0], 120);
    return `<div class="gh-topic"><span class="gs-dot" style="background:${rgba(n.rgb, 1)}"></span>${esc(c ? c.name : 'No topic yet')}</div>
      <div class="gh-title">${esc(first)}</div>
      <div class="gh-meta">${n.deg} ${n.deg === 1 ? 'connection' : 'connections'} · ${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</div>
      ${G.pinned === n ? `<button type="button" class="gh-open" data-gh-open="${esc(n.id)}">Open note</button>` : ''}`;
  }
  function showHover(n, pinned) {
    const card = $('graphHover');
    if (pinned) G.pinned = n; else G.hover = n;
    const show = G.pinned || G.hover;
    if (!show) { card.classList.remove('show'); card.hidden = true; card._n = null; redraw(); return; }
    if (card._n !== show || card._pinned !== !!G.pinned) {
      card.innerHTML = cardHtml(show); card._n = show; card._pinned = !!G.pinned;
    }
    card.classList.toggle('pinned', !!G.pinned);
    card.hidden = false;
    requestAnimationFrame(() => card.classList.add('show'));
    placeHover(); redraw();
  }
  function hideHover() { G.hover = null; G.pinned = null; showHover(null); }
  function placeHover() {
    const card = $('graphHover'), n = card._n;
    if (!n || card.hidden) return;
    const p = toScreen(n.x, n.y), r = nodeR(n);
    const w = card.offsetWidth || 240, h = card.offsetHeight || 90;
    let left = p.sx - w / 2, top = p.sy - r - h - 12;
    if (top < 8) top = p.sy + r + 12;
    left = Math.max(8, Math.min(G.W - w - 8, left));
    top = Math.max(8, Math.min(G.H - h - 8, top));
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // ---------- the full note sheet ----------
  function select(n) {
    G.selected = n;
    const sheet = $('graphSheet');
    if (!n) { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); redraw(); return; }
    hideHover();
    const c1 = G.cById.get(n.c1);
    const near = n.nbr.slice().sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m]) => m);
    sheet.innerHTML = `
      <div class="gs-grab" aria-hidden="true"></div>
      <div class="gs-top"><span class="gs-dot" style="background:${rgba(n.rgb, 1)}"></span>
        <span class="gs-topic">${c1 ? esc(c1.name) : 'No topic yet'}</span>
        <button class="secondary icon-btn gs-close" type="button" aria-label="Close" data-gs-close="1">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gs-date">${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''} · ${n.deg} ${n.deg === 1 ? 'connection' : 'connections'}</div>
      <div class="gs-text" id="gsText">${esc(n.label)}</div>
      <button type="button" data-gs-open="${esc(n.id)}" style="width:100%; margin-top:12px;">Read the full thought</button>
      ${near.length ? `<div class="gs-near-title">Connected</div>${near.map(m => `
        <button type="button" class="gs-near" data-gs-jump="${esc(m.id)}"><span class="gs-dot" style="background:${rgba(m.rgb, 1)}"></span><span>${esc(m.label)}</span></button>`).join('')}` : ''}`;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
    focusOn(n);
    redraw();
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
  function jumpTo(id) { const n = G.byId.get(id); if (n) { if (!isShown(n)) { G.hiddenTopics.delete(n.c1); setMinLinks(0); renderLegend(); } select(n); } }

  // ---------- legend = topic filter ----------
  function renderLegend() {
    const el = $('graphLegend');
    const count = new Map();
    G.nodes.forEach(n => count.set(n.c1, (count.get(n.c1) || 0) + 1));
    el.innerHTML = G.clusters.map(c => {
      const on = !G.hiddenTopics.has(c.id);
      return `<button type="button" class="legend-chip ${on ? 'on' : 'off'}" data-topic="${esc(c.id)}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(c.name)}">
        <span class="gs-dot" style="background:${rgba(G.cById.get(c.id).rgb, 1)}"></span>${esc(c.name)}<span class="legend-n">${count.get(c.id) || 0}</span></button>`;
    }).join('') + (G.hiddenTopics.size ? '<button type="button" class="legend-chip legend-all" data-topic-all="1">Show all</button>' : '');
    updateCount();
  }
  function updateCount() {
    const shown = G.nodes.filter(isShown).length;
    const el = $('graphCount');
    if (el) el.textContent = G.nodes.length ? (shown === G.nodes.length ? `${shown} thoughts` : `${shown} of ${G.nodes.length} shown`) : '';
  }
  function setMinLinks(v) {
    G.minLinks = v;
    $('graphMinLinks').value = String(v);
    $('graphMinOut').textContent = String(v);
    updateCount();
  }
  function filtersChanged() {
    if ((G.hover && !isShown(G.hover)) || (G.pinned && !isShown(G.pinned))) hideHover();
    if (G.selected && !isShown(G.selected)) select(null);
    applySearch(false);
    fit();
    redraw();
  }

  // ---------- search ----------
  function applySearch(move) {
    const q = G.query.trim().toLowerCase();
    const el = $('graphSearchCount');
    if (!q) { G.matches = null; if (el) el.textContent = ''; redraw(); return; }
    const words = q.split(/\s+/).filter(Boolean);
    const list = G.nodes.filter(n => isShown(n) && words.every(w => n.label.toLowerCase().includes(w) || String((G.cById.get(n.c1) || {}).name || '').toLowerCase().includes(w)));
    G.matches = new Set(list.map(n => n.id));
    if (el) el.textContent = list.length ? `${list.length} ${list.length === 1 ? 'match' : 'matches'}` : 'No matches';
    if (move && list.length) {
      if (list.length === 1) { focusOn(list[0], 2.6); setTimeout(() => showHover(list[0], true), reduced() ? 0 : 380); }
      else { hideHover(); fitTo(list, false, 2.4); }
    }
    redraw();
  }

  // ---------- pointer: drag to move, pinch / wheel to zoom, hover and tap ----------
  function local(e) { const r = $('graphCanvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onDown(e) {
    const c = $('graphCanvas');
    c.setPointerCapture && c.setPointerCapture(e.pointerId);
    G.pointers.set(e.pointerId, local(e));
    if (G.pointers.size === 1) {
      const p = local(e);
      G.gesture = { kind: 'pan', x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), moved: false, type: e.pointerType };
    } else if (G.pointers.size === 2) {
      const [a, b] = [...G.pointers.values()];
      G.gesture = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, moved: true };
    }
    c.classList.add('grabbing');
  }
  function onMove(e) {
    const p = local(e);
    if (!G.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && !G.pinned) {        // plain hover
        const n = hitTest(p.x, p.y);
        $('graphCanvas').style.cursor = n ? 'pointer' : 'grab';
        if (n !== G.hover) showHover(n, false);
      }
      return;
    }
    G.pointers.set(e.pointerId, p);
    const g = G.gesture; if (!g) return;
    if (g.kind === 'pan' && G.pointers.size === 1) {
      const dx = p.x - g.x, dy = p.y - g.y;
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 6) return;
      g.moved = true; g.x = p.x; g.y = p.y;
      G.cam.x -= dx / G.cam.k; G.cam.y -= dy / G.cam.k;
      G.target = { ...G.cam };
      if (G.hover && !G.pinned) showHover(null, false);
      redraw();
    } else if (g.kind === 'pinch' && G.pointers.size >= 2) {
      const [a, b] = [...G.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const w = toWorld(g.mx, g.my);
      const k = clampK(G.cam.k * (d / (g.d || d)));
      G.cam = { k, x: w.x - (mx - G.W / 2) / k, y: w.y - (my - G.H / 2) / k };
      G.target = { ...G.cam };
      g.d = d; g.mx = mx; g.my = my;
      redraw();
    }
  }
  function onUp(e) {
    const g = G.gesture;
    G.pointers.delete(e.pointerId);
    $('graphCanvas').classList.remove('grabbing');
    if (G.pointers.size === 1 && g && g.kind === 'pinch') {         // one finger left: keep moving with it
      const p = [...G.pointers.values()][0];
      G.gesture = { kind: 'pan', x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), moved: true };
      return;
    }
    if (G.pointers.size) return;
    G.gesture = null;
    if (!g || g.kind !== 'pan' || g.moved || e.type === 'pointercancel') return;
    const p = local(e), n = hitTest(p.x, p.y);
    if (g.type === 'mouse') { if (n) select(n); else { select(null); hideHover(); } return; }
    // touch / pen: first tap shows the preview card, tapping the same dot again opens it
    if (!n) { hideHover(); return; }
    if (G.pinned === n) { select(n); return; }
    G.hover = null; showHover(n, true);
  }

  function setup() {
    const c = $('graphCanvas');
    c.tabIndex = 0;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !G.pinned && G.hover) showHover(null, false); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      zoomBy(f, p.x, p.y);
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      const step = 60 / G.target.k;
      const k = { '+': () => zoomBy(1.35), '=': () => zoomBy(1.35), '-': () => zoomBy(1 / 1.35), '0': () => fit(),
        ArrowLeft: () => { G.target.x -= step; }, ArrowRight: () => { G.target.x += step; }, ArrowUp: () => { G.target.y -= step; }, ArrowDown: () => { G.target.y += step; },
        Escape: () => { select(null); hideHover(); } }[e.key];
      if (k) { e.preventDefault(); k(); wake(); }
    });
    $('graphZoomIn').addEventListener('click', () => zoomBy(1.4));
    $('graphZoomOut').addEventListener('click', () => zoomBy(1 / 1.4));
    $('graphFit').addEventListener('click', () => {
      select(null); hideHover();
      G.query = ''; $('graphSearch').value = ''; applySearch(false);
      G.hiddenTopics.clear(); setMinLinks(0); renderLegend();
      fit();
    });
    $('graphLinks').addEventListener('click', () => {
      G.strongOnly = !G.strongOnly;
      $('graphLinks').setAttribute('aria-pressed', String(G.strongOnly));
      redraw();
    });
    $('graphLegend').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.topicAll) G.hiddenTopics.clear();
      else {
        const id = G.clusters.find(c => String(c.id) === b.dataset.topic)?.id;
        if (id === undefined) return;
        if (G.hiddenTopics.has(id)) G.hiddenTopics.delete(id);
        else if (G.hiddenTopics.size < G.clusters.length - 1) G.hiddenTopics.add(id);
      }
      renderLegend(); filtersChanged();
    });
    $('graphMinLinks').addEventListener('input', (e) => { setMinLinks(Number(e.target.value) || 0); filtersChanged(); });
    let searchTimer = 0;
    $('graphSearch').addEventListener('input', (e) => {
      G.query = e.target.value; clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applySearch(true), 220);
    });
    $('graphSearchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); G.query = $('graphSearch').value; applySearch(true); document.activeElement && document.activeElement.blur(); });
    $('graphHover').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gh-open]'); if (b) jumpTo(b.dataset.ghOpen);
    });
    $('graphSheet').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.gsClose) select(null);
      else if (b.dataset.gsOpen) openFull(b.dataset.gsOpen);
      else if (b.dataset.gsJump) jumpTo(b.dataset.gsJump);
    });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(c.parentElement);
    window.addEventListener('resize', resize);
    const dark = mq('(prefers-color-scheme: dark)');
    if (dark.addEventListener) dark.addEventListener('change', () => { readTheme(); redraw(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (G.visible) start(); });
    window.addEventListener('online', () => { if (G.visible) fetchGraph({ quiet: true }); });
  }

  function start() {
    resize(); readTheme(); redraw();
    clearInterval(G.poll);
    G.poll = setInterval(() => { if (G.visible && !document.hidden) fetchGraph({ quiet: true }); }, POLL_MS);
  }
  function stop() { cancelAnimationFrame(G.raf); G.raf = 0; clearInterval(G.poll); }

  setup();
  window.obGraph = {
    show() { G.visible = true; start(); fetchGraph(); },
    hide() { G.visible = false; stop(); },
    reset() {                                        // forget the current map (used by the preview page)
      G.nodes = []; G.byId = new Map(); G.edges = []; G.selected = null; G.hover = null; G.pinned = null;
      G.hiddenTopics.clear(); G.minLinks = 0; G.query = ''; G.matches = null;
      G.cam = { x: 0, y: 0, k: 1 }; G.target = { ...G.cam };
      $('graphSheet').classList.remove('open');
    },
    fit,
    _draw: () => draw(),                            // for the browser test (timing)
    _state: G,                                       // for the browser test
    _toScreen: (n) => toScreen(n.x, n.y),            // for the browser test (where a dot is)
  };
})();
