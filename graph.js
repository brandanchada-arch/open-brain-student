// graph.js — the thought map (Brain screen > Map). v5, Nov 2026: a flat, quiet 2D map.
//
// Data: the brain_graph() function in Supabase, called with your login (RLS applies).
//   { clusters: [{id, name, color, size}], nodes: [{id, label, cat, at, c1, c2, w}], edges: [[a, b, similarity]] }
// What you see:
//   - one small flat dot per thought, colored by topic (legend above the map); bigger = more connections
//   - thin grey lines = thought_links; "Strong links only" hides the weaker ones
//   - hover a dot (tap on a phone) for a preview card; click it (or "Open" on the card) for the full note
//   - wheel / pinch to zoom, drag to move; + / − / reset buttons in the corner
//   - search box: matching dots stay bright, the rest fade, and the view moves to the matches
//   - topic chips switch topics on and off; "Min. links" hides dots with fewer connections
//   - checks for new thoughts every 40s while open; new ones get a short ring
// The layout is worked out once (a small force simulation), then the map only redraws when
// something changes, so it stays smooth with hundreds of dots. No library, works offline from the saved copy.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const STRONG = 0.70;                  // "strong link" cutoff (similarity)
  const POLL_MS = 40000;
  const MIN_K = 0.15, MAX_K = 8;
  const GREY = '#A3A6AD';
  const EDGE = 'rgba(120,124,132,0.22)', EDGE_HI = 'rgba(60,64,72,0.55)';

  // ---------- seeded random: the map looks the same every time you open it ----------
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const MUTED = ['#4C6FA8', '#8064A2', '#3F8F7F', '#B07A4F', '#6B8A45', '#B05C6E', '#5B8BA6', '#A0874A', '#7A7FA8', '#9A6A8F'];

  const G = {
    nodes: [], byId: new Map(), edges: [], clusters: [], cById: new Map(),
    k: 1, tx: 0, ty: 0, W: 0, H: 0, dpr: 1,
    hidden: new Set(),              // topic ids switched off
    minDeg: 0, strongOnly: false,
    query: '', matches: null,       // null = not searching
    hover: null, pinned: null, selected: null,
    visible: false, raf: 0, anim: null, poll: 0, at: null,
  };

  // ---------- data in ----------
  function topicColor(c, i) { return /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : MUTED[i % MUTED.length]; }
  function ingest(data, { fresh }) {
    G.clusters = (data.clusters || []).slice();
    G.cById = new Map(G.clusters.map((c, i) => [c.id, { ...c, rgb: topicColor(c, i) }]));
    const old = G.byId, firstTime = old.size === 0;
    const nodes = (data.nodes || []).map(r => {
      const prev = old.get(r.id), n = prev || { id: r.id };
      Object.assign(n, { label: String(r.label || ''), cat: r.cat, at: new Date(r.at).getTime(), c1: r.c1, c2: r.c2, w: Number(r.w) || 0, deg: 0, nbr: [] });
      n.isNew = !prev;
      return n;
    });
    G.nodes = nodes; G.byId = new Map(nodes.map(n => [n.id, n]));
    G.edges = (data.edges || []).map(([a, b, w]) => ({ a: G.byId.get(a), b: G.byId.get(b), w: Number(w) })).filter(e => e.a && e.b && e.a !== e.b);
    for (const e of G.edges) { e.a.deg++; e.b.deg++; e.a.nbr.push(e); e.b.nbr.push(e); }
    for (const n of nodes) {
      const c = G.cById.get(n.c1);
      n.color = c ? c.rgb : GREY;
      n.r = 3.4 + Math.sqrt(n.deg) * 1.6;            // size by number of connections
      n.lc = n.label.toLowerCase();
    }
    const added = nodes.filter(n => n.isNew);
    layout(firstTime ? nodes : added, firstTime);
    if (!firstTime && fresh && added.length) { const t = performance.now(); added.forEach(n => { n.pulse = t; }); toastNew(added.length); }
    nodes.forEach(n => { n.isNew = false; });
    G.at = data.at;
    const maxDeg = Math.max(1, ...nodes.map(n => n.deg));
    const slider = $('graphMin');
    slider.max = String(Math.min(20, maxDeg));
    if (G.minDeg > maxDeg) setMin(0);
    renderLegend();
    $('graphCanvas').setAttribute('aria-label', `Map of ${nodes.length} thoughts in ${G.clusters.length} topics`);
    if (G.query) runSearch(G.query, false);
    if (firstTime) { resize(); fit(false); }
    redraw();
  }

  // ---------- layout: topics around a ring, then a short force simulation ----------
  function layout(list, all) {
    if (!list.length) return;
    const R = 220 + Math.sqrt(G.nodes.length) * 14;
    const order = G.clusters.map(c => c.id);
    const centre = new Map(order.map((id, i) => {
      const a = (i / Math.max(1, order.length)) * Math.PI * 2 - Math.PI / 2;
      return [id, { x: Math.cos(a) * R, y: Math.sin(a) * R }];
    }));
    for (const n of list) {
      const r = rng(hash(n.id)), c = centre.get(n.c1) || { x: 0, y: 0 };
      const nb = !all && n.nbr.map(e => (e.a === n ? e.b : e.a)).find(m => !m.isNew);
      const base = nb || c, spread = nb ? 30 : 60 + Math.sqrt(G.nodes.length) * 4;
      n.x = base.x + (r() - 0.5) * spread; n.y = base.y + (r() - 0.5) * spread; n.vx = n.vy = 0;
    }
    simulate(all ? 260 : 80, all ? null : new Set(list), centre);
  }
  function simulate(steps, only, centre) {
    const N = G.nodes, L = 46, cell = 90;
    for (let s = 0; s < steps; s++) {
      const alpha = 1 - s / steps, grid = new Map();
      for (const n of N) { const k = Math.floor(n.x / cell) + ',' + Math.floor(n.y / cell); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
      for (const n of N) {
        if (only && !only.has(n)) continue;
        let fx = 0, fy = 0;
        const gx = Math.floor(n.x / cell), gy = Math.floor(n.y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const b = grid.get((gx + dx) + ',' + (gy + dy)); if (!b) continue;
          for (const m of b) {
            if (m === n) continue;
            let x = n.x - m.x, y = n.y - m.y, d2 = x * x + y * y;
            if (d2 < 0.01) { x = (hash(n.id + m.id) % 7) - 3 || 1; y = 1; d2 = x * x + y * y; }
            if (d2 > cell * cell) continue;
            const f = 900 / d2; fx += x * f; fy += y * f;
          }
        }
        const c = centre.get(n.c1) || { x: 0, y: 0 };
        fx += (c.x - n.x) * 0.012; fy += (c.y - n.y) * 0.012;  // stay near your topic
        n.vx = (n.vx + fx) * 0.55; n.vy = (n.vy + fy) * 0.55;
      }
      for (const e of G.edges) {                           // links pull a little
        const x = e.b.x - e.a.x, y = e.b.y - e.a.y, d = Math.sqrt(x * x + y * y) || 1;
        const f = (d - L) / d * 0.035 * (e.a.c1 === e.b.c1 ? 1 : 0.35);
        if (!only || only.has(e.a)) { e.a.vx += x * f; e.a.vy += y * f; }
        if (!only || only.has(e.b)) { e.b.vx -= x * f; e.b.vy -= y * f; }
      }
      const cap = 24 * alpha + 2;
      for (const n of N) {
        if (only && !only.has(n)) continue;
        const v = Math.hypot(n.vx, n.vy); if (v > cap) { n.vx *= cap / v; n.vy *= cap / v; }
        n.x += n.vx; n.y += n.vy;
      }
    }
  }

  // ---------- what's on screen ----------
  const shown = (n) => !G.hidden.has(n.c1) && n.deg >= G.minDeg;
  const edgeShown = (e) => (!G.strongOnly || e.w >= STRONG) && shown(e.a) && shown(e.b);
  const toScreen = (n) => ({ x: n.x * G.k + G.tx, y: n.y * G.k + G.ty });
  const rOf = (n) => Math.max(2.2, n.r * Math.min(1.6, Math.max(0.6, Math.sqrt(G.k))));

  function resize() {
    const c = $('graphCanvas'), r = c.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cx = G.W ? (G.W / 2 - G.tx) / G.k : null, cy = G.H ? (G.H / 2 - G.ty) / G.k : null;
    G.W = r.width; G.H = r.height; G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(G.W * G.dpr); c.height = Math.round(G.H * G.dpr);
    if (cx !== null) { G.tx = G.W / 2 - cx * G.k; G.ty = G.H / 2 - cy * G.k; }
    redraw();
  }

  function bounds(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
    return isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }
  function viewFor(list, maxK = 2.2) {
    const b = bounds(list);
    if (!b || !G.W) return null;
    const pad = Math.min(60, G.W * 0.08);
    const k = Math.max(MIN_K, Math.min(maxK, Math.min((G.W - pad * 2) / Math.max(40, b.x1 - b.x0), (G.H - pad * 2) / Math.max(40, b.y1 - b.y0))));
    return { k, tx: G.W / 2 - (b.x0 + b.x1) / 2 * k, ty: G.H / 2 - (b.y0 + b.y1) / 2 * k };
  }
  function animateTo(v, animate = true) {
    if (!v) return;
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { Object.assign(G, v); G.anim = null; redraw(); return; }
    G.anim = { from: { k: G.k, tx: G.tx, ty: G.ty }, to: v, t0: performance.now(), ms: 320 };
    redraw();
  }
  function fit(animate = true) { const list = G.nodes.filter(shown); animateTo(viewFor(list.length ? list : G.nodes, 1.6), animate); }
  function zoomAt(f, sx = G.W / 2, sy = G.H / 2, animate = false) {
    const k = Math.max(MIN_K, Math.min(MAX_K, G.k * f)), wx = (sx - G.tx) / G.k, wy = (sy - G.ty) / G.k;
    animateTo({ k, tx: sx - wx * k, ty: sy - wy * k }, animate);
  }

  // ---------- drawing (only when something changed) ----------
  function redraw() { if (G.visible && !G.raf && G.W) G.raf = requestAnimationFrame(frame); }
  function frame(now) {
    G.raf = 0;
    if (G.anim) {
      const a = G.anim, t = Math.min(1, (now - a.t0) / a.ms), e = 1 - Math.pow(1 - t, 3);
      G.k = a.from.k + (a.to.k - a.from.k) * e; G.tx = a.from.tx + (a.to.tx - a.from.tx) * e; G.ty = a.from.ty + (a.to.ty - a.from.ty) * e;
      if (t >= 1) G.anim = null;
    }
    draw(now);
    const pulsing = G.nodes.some(n => n.pulse && now - n.pulse < 2400);
    if (G.anim || pulsing) redraw();
  }
  function draw(now = performance.now()) {
    const c = $('graphCanvas'), g = c.getContext('2d'), d = G.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, G.W, G.H);
    const focus = G.hover || G.pinned || G.selected;
    const near = focus ? new Set(focus.nbr.map(e => (e.a === focus ? e.b : e.a)).concat(focus)) : null;
    const searching = G.matches !== null;
    const lit = (n) => (searching ? G.matches.has(n) : true) && (!near || near.has(n));

    // edges: one path for the quiet ones, one for the highlighted ones
    g.lineWidth = 1;
    g.beginPath(); g.strokeStyle = (searching || near) ? 'rgba(120,124,132,0.10)' : EDGE;
    const hi = [];
    for (const e of G.edges) {
      if (!edgeShown(e)) continue;
      if (focus && (e.a === focus || e.b === focus)) { hi.push(e); continue; }
      if (searching && G.matches.has(e.a) && G.matches.has(e.b)) { hi.push(e); continue; }
      const p = toScreen(e.a), q = toScreen(e.b);
      g.moveTo(p.x, p.y); g.lineTo(q.x, q.y);
    }
    g.stroke();
    if (hi.length) {
      g.beginPath(); g.strokeStyle = EDGE_HI;
      for (const e of hi) { const p = toScreen(e.a), q = toScreen(e.b); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); }
      g.stroke();
    }

    // dots: flat circles with a thin white edge so they separate
    const margin = 20;
    const drawDot = (n, alpha) => {
      const p = toScreen(n), r = rOf(n);
      if (p.x < -margin || p.y < -margin || p.x > G.W + margin || p.y > G.H + margin) return;
      g.globalAlpha = alpha;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = n.color; g.fill();
      g.lineWidth = 1; g.strokeStyle = '#FFFFFF'; g.stroke();
    };
    const dim = [], bright = [];
    for (const n of G.nodes) { if (!shown(n)) continue; (lit(n) ? bright : dim).push(n); }
    for (const n of dim) drawDot(n, 0.16);
    for (const n of bright) drawDot(n, 1);
    g.globalAlpha = 1;

    // rings: search matches, the focused dot, new dots
    const ring = (n, color, extra = 3, w = 1.5) => { const p = toScreen(n); g.beginPath(); g.arc(p.x, p.y, rOf(n) + extra, 0, Math.PI * 2); g.lineWidth = w; g.strokeStyle = color; g.stroke(); };
    if (searching) for (const n of G.matches) if (shown(n)) ring(n, '#3E63DD', 2.5, 1.25);
    if (focus && shown(focus)) ring(focus, '#1D1E20', 3, 1.5);
    for (const n of G.nodes) {
      if (!n.pulse) continue;
      const t = (now - n.pulse) / 2400;
      if (t >= 1) { n.pulse = 0; continue; }
      g.globalAlpha = 1 - t; ring(n, '#3E63DD', 3 + t * 12, 1); g.globalAlpha = 1;
    }
  }

  // ---------- hit testing ----------
  function local(e) { const r = $('graphCanvas').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hit(sx, sy, slop) {
    let best = null, bd = Infinity;
    for (const n of G.nodes) {
      if (!shown(n)) continue;
      const p = toScreen(n), d = Math.hypot(p.x - sx, p.y - sy), lim = rOf(n) + slop;
      if (d <= lim && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ---------- preview card ----------
  function showTip(n, pinned) {
    const tip = $('graphTip');
    if (!n) { tip.hidden = true; tip.classList.remove('pinned'); return; }
    const c = G.cById.get(n.c1);
    const lines = n.label.length > 180 ? n.label.slice(0, 177) + '…' : n.label;
    tip.innerHTML = `<div class="gt-top"><span class="gs-dot" style="background:${n.color}"></span><span>${esc(c ? c.name : 'No topic')}</span>
      <span class="gt-n">${n.deg} ${n.deg === 1 ? 'connection' : 'connections'}</span></div>
      <div class="gt-text">${esc(lines)}</div>${pinned ? `<button type="button" class="gt-open" data-gt-open="${esc(n.id)}">Open note</button>` : ''}`;
    tip.classList.toggle('pinned', !!pinned);
    tip.hidden = false;
    const p = toScreen(n), w = tip.offsetWidth, h = tip.offsetHeight, r = rOf(n);
    let x = p.x + r + 10, y = p.y - h / 2;
    if (x + w > G.W - 8) x = p.x - r - 10 - w;
    if (x < 8) { x = Math.max(8, Math.min(G.W - w - 8, p.x - w / 2)); y = p.y + r + 10; if (y + h > G.H - 8) y = p.y - r - 10 - h; }
    y = Math.max(8, Math.min(G.H - h - 8, y));
    tip.style.left = Math.round(x) + 'px'; tip.style.top = Math.round(y) + 'px';
  }
  function setHover(n) {
    if (G.hover === n) return;
    G.hover = n;
    $('graphCanvas').classList.toggle('pointing', !!n);
    if (!G.pinned) showTip(n, false);
    redraw();
  }
  function pin(n) { G.pinned = n; G.hover = null; showTip(n, !!n); redraw(); }

  // ---------- pointer: drag to pan, pinch / wheel to zoom ----------
  const P = { pts: new Map(), start: null, moved: false, pinch: null };
  function onDown(e) {
    $('graphCanvas').setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    P.pts.set(e.pointerId, { x, y, type: e.pointerType });
    G.anim = null;
    if (P.pts.size === 1) { P.start = { x, y, tx: G.tx, ty: G.ty }; P.moved = false; }
    if (P.pts.size === 2) {
      const [a, b] = [...P.pts.values()];
      P.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: G.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx: G.tx, ty: G.ty };
      P.moved = true;
    }
  }
  function onMove(e) {
    const [x, y] = local(e);
    if (!P.pts.has(e.pointerId)) { if (e.pointerType === 'mouse') setHover(hit(x, y, 4)); return; }
    P.pts.set(e.pointerId, { x, y, type: e.pointerType });
    if (P.pinch && P.pts.size >= 2) {
      const [a, b] = [...P.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const k = Math.max(MIN_K, Math.min(MAX_K, P.pinch.k * d / P.pinch.d));
      const wx = (P.pinch.cx - P.pinch.tx) / P.pinch.k, wy = (P.pinch.cy - P.pinch.ty) / P.pinch.k;
      G.k = k; G.tx = cx - wx * k; G.ty = cy - wy * k;
      if (G.pinned) showTip(G.pinned, true);
      redraw(); return;
    }
    if (!P.start) return;
    const dx = x - P.start.x, dy = y - P.start.y;
    if (!P.moved && Math.hypot(dx, dy) > 4) { P.moved = true; $('graphCanvas').classList.add('dragging'); setHover(null); }
    if (P.moved) { G.tx = P.start.tx + dx; G.ty = P.start.ty + dy; if (G.pinned) showTip(G.pinned, true); redraw(); }
  }
  function onUp(e) {
    const p = P.pts.get(e.pointerId);
    P.pts.delete(e.pointerId);
    if (P.pts.size < 2) P.pinch = null;
    if (P.pts.size) return;
    $('graphCanvas').classList.remove('dragging');
    const wasTap = !P.moved && e.type === 'pointerup';
    P.start = null;
    if (!wasTap || !p) return;
    const touch = p.type !== 'mouse';
    const n = hit(p.x, p.y, touch ? 12 : 4);
    if (touch) {
      // phone: first tap shows the preview card, a second tap on the same dot opens it
      if (n && G.pinned === n) { pin(null); select(n); }
      else { select(null); pin(n); }
    } else {
      pin(null);
      select(n);
      setHover(n);
    }
  }

  // ---------- the detail panel ----------
  function select(n) {
    G.selected = n;
    const sheet = $('graphSheet');
    if (!n) { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); redraw(); return; }
    const c1 = G.cById.get(n.c1), c2 = G.cById.get(n.c2);
    const topic = c1 ? `${esc(c1.name)}${c2 && n.w > 0.2 ? ` <span style="color:var(--muted); font-weight:400">· also ${esc(c2.name)}</span>` : ''}` : 'No topic yet';
    const near = n.nbr.slice().sort((a, b) => b.w - a.w).slice(0, 6).map(e => (e.a === n ? e.b : e.a));
    sheet.innerHTML = `
      <div class="gs-top"><span class="gs-dot" style="background:${n.color}"></span>
        <span class="gs-topic">${topic}</span>
        <button class="secondary icon-btn gs-close" type="button" aria-label="Close" data-gs-close="1">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gs-date">${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''} · ${n.deg} ${n.deg === 1 ? 'connection' : 'connections'}</div>
      <div class="gs-text" id="gsText">${esc(n.label)}</div>
      <button type="button" class="secondary" data-gs-open="${esc(n.id)}" style="width:100%; margin-top:12px;">Read the full thought</button>
      ${near.length ? `<div class="gs-near-title">Connected</div>${near.map(m => `
        <button type="button" class="gs-near" data-gs-jump="${esc(m.id)}"><span class="gs-dot" style="background:${m.color}"></span><span>${esc(m.label)}</span></button>`).join('')}` : ''}`;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
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
  function centreOn(n) {
    const p = toScreen(n), side = G.W >= 700 && $('graphSheet').classList.contains('open') ? 180 : 0;
    if (p.x < 40 || p.y < 40 || p.x > G.W - 40 - side * 2 || p.y > G.H - 40) animateTo({ k: G.k, tx: (G.W - side * 2) / 2 - n.x * G.k, ty: G.H / 2 - n.y * G.k });
  }
  function jumpTo(id) { const n = G.byId.get(id); if (n) { if (!shown(n)) { G.hidden.delete(n.c1); if (n.deg < G.minDeg) setMin(0); renderLegend(); } select(n); centreOn(n); } }

  // ---------- search ----------
  function runSearch(q, move = true) {
    G.query = q = String(q || '').trim().toLowerCase();
    const out = $('graphSearchCount');
    if (!q) { G.matches = null; out.textContent = ''; redraw(); return; }
    const words = q.split(/\s+/).filter(Boolean);
    const topicHit = new Set(G.clusters.filter(c => String(c.name).toLowerCase().includes(q)).map(c => c.id));
    G.matches = new Set(G.nodes.filter(n => topicHit.has(n.c1) || words.every(w => n.lc.includes(w))));
    const vis = [...G.matches].filter(shown);
    out.textContent = vis.length === G.matches.size ? `${vis.length} found` : `${vis.length} of ${G.matches.size}`;
    if (move && vis.length) {
      animateTo(viewFor(vis, vis.length === 1 ? 2.4 : 2));
      if (vis.length === 1) setTimeout(() => { if (G.matches && G.matches.size && !G.anim) { pin(null); G.hover = vis[0]; showTip(vis[0], false); redraw(); } }, 360);
    }
    redraw();
  }

  // ---------- filters ----------
  function setMin(v) {
    G.minDeg = Math.max(0, Number(v) || 0);
    $('graphMin').value = String(G.minDeg); $('graphMinOut').textContent = String(G.minDeg);
  }
  function afterFilter() {
    if (G.pinned && !shown(G.pinned)) pin(null);
    if (G.hover && !shown(G.hover)) setHover(null);
    if (G.selected && !shown(G.selected)) select(null);
    if (G.query) runSearch(G.query, false);
    renderLegend(); redraw();
  }
  function renderLegend() {
    const el = $('graphLegend'), count = new Map();
    for (const n of G.nodes) if (n.deg >= G.minDeg) count.set(n.c1, (count.get(n.c1) || 0) + 1);
    const any = G.hidden.size > 0 || G.minDeg > 0 || G.strongOnly;
    el.innerHTML = G.clusters.map(c => {
      const off = G.hidden.has(c.id);
      return `<button type="button" class="legend-chip ${off ? 'off' : ''}" data-topic="${esc(c.id)}" aria-pressed="${!off}" title="${off ? 'Show' : 'Hide'} ${esc(c.name)}">
        <span class="gs-dot" style="background:${G.cById.get(c.id).rgb}"></span>${esc(c.name)} <span class="n">${count.get(c.id) || 0}</span></button>`;
    }).join('') + (any ? '<button type="button" class="legend-chip reset" data-topic-reset="1">Show all</button>' : '');
  }

  function toastNew(n) {
    const el = $('graphNote');
    el.textContent = `${n} new ${n === 1 ? 'thought' : 'thoughts'} on your map`;
    el.style.opacity = '1'; clearTimeout(el._h); el._h = setTimeout(() => { el.style.opacity = '0'; }, 3500);
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
      ingest(data || {}, { fresh: G.nodes.length > 0 });
      obCache.put('graph', data);                    // short labels only, never full thoughts
      $('graphStatus').textContent = G.nodes.length ? '' : 'No thoughts on your map yet.';
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
    const c = $('graphCanvas');
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !P.pts.size) setHover(null); });
    c.addEventListener('wheel', (e) => {             // trackpad / mouse zoom, around the cursor
      e.preventDefault();
      const [x, y] = local(e);
      G.anim = null;
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), x, y);
      if (G.pinned) showTip(G.pinned, true); else if (G.hover) showTip(G.hover, false);
    }, { passive: false });
    $('graphZoomIn').addEventListener('click', () => zoomAt(1.4, G.W / 2, G.H / 2, true));
    $('graphZoomOut').addEventListener('click', () => zoomAt(1 / 1.4, G.W / 2, G.H / 2, true));
    $('graphFit').addEventListener('click', () => { select(null); pin(null); fit(); });
    $('graphLegend').addEventListener('click', (e) => {
      if (e.target.closest('[data-topic-reset]')) { G.hidden.clear(); setMin(0); G.strongOnly = false; syncLinks(); afterFilter(); return; }
      const b = e.target.closest('[data-topic]'); if (!b) return;
      const c = G.clusters.find(x => String(x.id) === b.dataset.topic); if (!c) return;
      if (G.hidden.has(c.id)) G.hidden.delete(c.id); else G.hidden.add(c.id);
      afterFilter();
    });
    $('graphMin').addEventListener('input', (e) => { setMin(e.target.value); afterFilter(); });
    const syncLinks = () => { $('graphLinks').setAttribute('aria-pressed', String(G.strongOnly)); };
    $('graphLinks').addEventListener('click', () => { G.strongOnly = !G.strongOnly; syncLinks(); renderLegend(); redraw(); });
    let qTimer = 0;
    $('graphSearch').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => runSearch(e.target.value), 180); });
    $('graphSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qTimer); runSearch(e.target.value); } if (e.key === 'Escape') { e.target.value = ''; runSearch(''); } });
    $('graphTip').addEventListener('click', (e) => { const b = e.target.closest('[data-gt-open]'); if (b) { const n = G.byId.get(b.dataset.gtOpen); pin(null); select(n); } });
    $('graphSheet').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.gsClose) select(null);
      else if (b.dataset.gsOpen) openFull(b.dataset.gsOpen);
      else if (b.dataset.gsJump) jumpTo(b.dataset.gsJump);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && G.visible) { select(null); pin(null); } });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(c.parentElement);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (G.visible) start(); });
    window.addEventListener('online', () => { if (G.visible) fetchGraph({ quiet: true }); });
  }

  function start() {
    resize(); redraw();
    clearInterval(G.poll);
    G.poll = setInterval(() => { if (G.visible && !document.hidden) fetchGraph({ quiet: true }); }, POLL_MS);
  }
  function stop() { cancelAnimationFrame(G.raf); G.raf = 0; clearInterval(G.poll); }

  setup();
  window.obGraph = {
    show() { G.visible = true; start(); fetchGraph(); },
    hide() { G.visible = false; stop(); },
    reset() {                                        // forget the current map
      G.nodes = []; G.byId = new Map(); G.edges = []; G.selected = null; G.hover = null; G.pinned = null; G.matches = null;
      G.k = 1; G.tx = G.ty = 0;
      $('graphSheet').classList.remove('open'); showTip(null);
    },
    fit,
    _draw: (t) => draw(t),                          // for the browser test (timing)
    _state: G,                                       // for the browser test
    _screenOf: (id) => { const n = G.byId.get(id); return n ? toScreen(n) : null; },
  };
})();
