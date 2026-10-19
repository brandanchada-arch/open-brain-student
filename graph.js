// graph.js — the brain web (Brain screen > Map). v4, Oct 19, 2026: a rotating 3D brain.
// Look and brain shape adapted from Brain Atlas by colorpulse6 (MIT License,
// https://github.com/colorpulse6/brain-atlas), including its "Graphite" colors and lighting:
// a faint cloud of tiny points traces a 3D brain,
// thoughts sit inside it as brighter dots, grouped by topic into lobes.
//
// Data: the brain_graph() function in Supabase, called with your login (RLS applies).
//   - dots = thoughts; near-white with a faint topic tint; bigger = more links; hubs get a small crosshair
//   - each topic lives in a part of the brain that fits it (career up front, habits in the cerebellum...)
//   - curved lines = your strongest thought_links ("All links" shows the rest); small sparks travel along them
//   - no text on the map: topic names are in the list under it; tap one to light up that region
//   - drag to turn the brain, pinch to zoom; it spins slowly for a few seconds after you touch it
//   - drag a dot and let go: it springs back. Tap a dot: the brain turns to it and the thought opens
//   - checks for new thoughts every 40s while open; new ones flash
// No library: canvas + a little 3D math, so it works offline from the saved copy.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STRONG = 0.70;                  // "strong link" cutoff (similarity)
  const POLL_MS = 40000;
  const SPIN_MS = 12000;                // keep turning this long after the last touch, then rest (battery)
  const HOME_ROT = { x: -0.18, y: 0.62 };
  const MAX_EDGES = 900;                // never draw more lines than this (strongest first)

  // ---------- seeded random: the map looks the same every time you open it ----------
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ---------- colors ----------
  const hex2rgb = (h) => { const n = parseInt((h || '#9AA3AD').slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const mix = (a, b, t) => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const WHITE = [255, 255, 255], DUST = [214, 206, 192], GREY = [190, 190, 190];
  const tint = (c) => mix(c, WHITE, 0.6);            // dots: near-white with a hint of the topic color

  const haloCache = new Map();
  function haloSprite(c) {
    const key = c.join(',');
    let h = haloCache.get(key);
    if (h) return h;
    h = document.createElement('canvas'); h.width = h.height = 48;
    const x = h.getContext('2d'), gr = x.createRadialGradient(24, 24, 0, 24, 24, 24);
    gr.addColorStop(0, rgba(c, 0.5)); gr.addColorStop(0.3, rgba(c, 0.16)); gr.addColorStop(1, rgba(c, 0));
    x.fillStyle = gr; x.fillRect(0, 0, 48, 48);
    haloCache.set(key, h);
    return h;
  }

  // ---------- the brain shape (from Brain Atlas: y up, z toward the front) ----------
  function brainPoint(theta, phi, foldAmp) {
    const cp = Math.cos(phi), sp = Math.sin(phi);
    let x = 0.95 * cp * Math.sin(theta), z = 1.25 * cp * Math.cos(theta), y = 0.92 * sp;
    if (z < -0.4) z -= 0.06 * (-z - 0.4);
    if (z > 0.4 && y > -0.1) x *= 1 + 0.05 * Math.min(0.6, z * (y + 0.4));
    if (y < -0.4) y = -0.4 + (y + 0.4) * 0.55;
    if (y > 0.55 && Math.abs(x) < 0.12) y -= 0.04 * (y - 0.55) * (1 - Math.abs(x) / 0.12);   // the groove between halves
    const fold = foldAmp * (Math.sin(theta * 11 + phi * 7) + 0.55 * Math.sin(theta * 17 - phi * 5) + 0.35 * Math.sin(theta * 5 + phi * 13));
    const r = Math.hypot(x, y, z) || 1;
    return { x: x + x / r * fold, y: y + y / r * fold, z: z + z / r * fold };
  }
  const DUST_POINTS = (() => {
    const out = [], golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < 1400; i++) {                 // cerebrum surface
      const t = (i + 0.5) / 1400, phi = Math.asin(2 * t - 1), theta = (golden * i) % (Math.PI * 2);
      out.push({ ...brainPoint(theta, phi, 0.026), tp: (i * 0.731) % 6.283, tf: 0.4 + (i % 9) / 12 });
    }
    for (let i = 0; i < 220; i++) {                  // cerebellum
      const t = (i + 0.5) / 220, phi = Math.asin(2 * t - 1), th = (golden * i) % (Math.PI * 2), cp = Math.cos(phi);
      const ridge = 0.02 * Math.sin(th * 14 + phi * 9);
      out.push({ x: (0.40 + ridge) * cp * Math.sin(th), y: -0.55 + 0.26 * Math.sin(phi), z: -0.78 + (0.32 + ridge) * cp * Math.cos(th), tp: (i * 0.91) % 6.283, tf: 0.5 + (i % 5) / 8 });
    }
    for (let i = 0; i < 28; i++) {                   // brain stem
      const t = (i / 28) * 0.6, a = ((i * 1.31) % 1) - 0.5;
      out.push({ x: a * 0.06, y: -0.55 - t * 0.45, z: -0.55 + a * 0.04, tp: i * 0.55, tf: 0.3 });
    }
    return out;
  })();
  // tint each dust point with the color of the nearest topic region
  function tintDust() {
    const regs = [...G.anchors.values()];
    for (const p of DUST_POINTS) {
      let best = null, bd = Infinity;
      for (const R of regs) for (const sx of (R.mirror ? [1, -1] : [1])) {
        const d = (p.x - R.c.x * sx) ** 2 + (p.y - R.c.y) ** 2 + (p.z - R.c.z) ** 2;
        if (d < bd) { bd = d; best = R; }
      }
      p.col = best ? mix(hex2rgb(best.color), DUST, 0.35) : DUST;
      p.key = p.col.join(',');
    }
  }
  const insideBrain = (p) => (p.x / 0.88) ** 2 + (p.y / 0.84) ** 2 + (p.z / 1.16) ** 2 <= 1
    || ((p.x / 0.36) ** 2 + ((p.y + 0.55) / 0.22) ** 2 + ((p.z + 0.78) / 0.28) ** 2 <= 1);

  // Brain regions and which topics belong there (matched by topic name; leftovers fill free regions).
  const REGIONS = [
    { c: { x: 0.18, y: 0.32, z: 0.78 }, r: 0.36, color: '#c9b896', area: 'Frontal lobe', re: /career|job|goal|plan|\bme\b/i },
    { c: { x: -0.2, y: -0.05, z: 0.92 }, r: 0.3, color: '#d4b878', area: 'Prefrontal', re: /strateg|decision|leader/i },
    { c: { x: 0, y: 0.68, z: 0.22 }, r: 0.32, color: '#9aa4ac', area: 'Motor cortex', re: /\bai\b|build|code|tech|project/i },
    { c: { x: -0.1, y: 0.62, z: -0.32 }, r: 0.34, color: '#a8b3a0', area: 'Parietal lobe', re: /mega|sim|game|case/i },
    { c: { x: 0.5, y: 0.36, z: -0.4 }, r: 0.28, color: '#c0b888', area: 'Parietal lobe', re: /financ|class|course|school|study/i },
    { c: { x: 0, y: 0.06, z: -0.95 }, r: 0.32, color: '#a8b0bc', area: 'Occipital lobe', re: /idea|video|watch|read|learn/i },
    { c: { x: 0.62, y: -0.16, z: 0.12 }, r: 0.3, color: '#d4d0c4', area: 'Temporal lobe', re: /personal|memor|life|family|faith/i, mirror: true },
    { c: { x: 0, y: -0.55, z: -0.78 }, r: 0.27, color: '#c89878', area: 'Cerebellum', re: /daily|win|habit|routine|done/i },
    { c: { x: -0.45, y: 0.3, z: 0.25 }, r: 0.3, color: '#b89898', area: 'Center', re: null },
    { c: { x: 0, y: 0.15, z: 0 }, r: 0.3, color: '#a89cb0', area: 'Center', re: null },
  ];

  // ---------- state ----------
  const G = {
    nodes: [], byId: new Map(), edges: [], clusters: [], cById: new Map(), anchors: new Map(),
    rot: { ...HOME_ROT }, zoom: 1, W: 0, H: 0, dpr: 1,
    strongOnly: true, showDust: true, density: 1, spread: 1, highlight: null, selected: null, drag: null, pinch: null, turnTo: null,
    visible: false, raf: 0, poll: 0, lastUser: 0, lastFrame: 0, signals: [], lastSpark: 0, at: null,
  };

  function placeClusters() {
    const used = new Set(), place = new Map();
    const bySize = G.clusters.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
    for (const c of bySize) {
      const i = REGIONS.findIndex((r, k) => !used.has(k) && r.re && r.re.test(c.name || ''));
      if (i >= 0) { used.add(i); place.set(c.id, i); }
    }
    for (const c of bySize) {
      if (place.has(c.id)) continue;
      const i = REGIONS.findIndex((r, k) => !used.has(k));
      if (i >= 0) { used.add(i); place.set(c.id, i); }
    }
    G.anchors = new Map(G.clusters.map((c, j) => [c.id, REGIONS[place.get(c.id) ?? (j % REGIONS.length)]]));
  }

  // Put a thought somewhere inside its region (same spot every time), a little toward a
  // second topic if it sits between two, and near an older thought it links to (makes threads).
  function placeNode(n) {
    const A = G.anchors.get(n.c1) || { c: { x: 0, y: 0.15, z: 0 }, r: 0.4 };
    const B = G.anchors.get(n.c2);
    const r = rng(hash(n.id));
    const side = A.mirror && r() < 0.5 ? -1 : 1;
    let base = { x: A.c.x * side, y: A.c.y, z: A.c.z };
    if (B && n.w > 0.05) {
      const bx = B.mirror ? Math.abs(B.c.x) * Math.sign(base.x || 1) : B.c.x;
      base = { x: base.x + (bx - base.x) * n.w, y: base.y + (B.c.y - base.y) * n.w, z: base.z + (B.c.z - base.z) * n.w };
    }
    let p;
    for (let tries = 0; tries < 8; tries++) {
      const u = r() * Math.PI * 2, v = Math.acos(2 * r() - 1), rad = A.r * G.spread * (n.hub ? 0.35 : 0.25 + 0.75 * Math.cbrt(r()));
      p = { x: base.x + rad * Math.sin(v) * Math.cos(u), y: base.y + rad * Math.sin(v) * Math.sin(u) * 0.85, z: base.z + rad * Math.cos(v) };
      if (insideBrain(p)) break;
    }
    if (!insideBrain(p)) p = { x: base.x, y: base.y, z: base.z };
    if (n.parent && n.parent.p) {                    // drift toward a linked, older thought
      const t = 0.3 + r() * 0.2;
      p = { x: p.x + (n.parent.p.x - p.x) * t, y: p.y + (n.parent.p.y - p.y) * t, z: p.z + (n.parent.p.z - p.z) * t };
    }
    n.p = p; n.ox = n.oy = n.vx = n.vy = 0;
  }

  // ---------- data in ----------
  function ingest(data, { fresh }) {
    G.clusters = data.clusters || [];
    const old = G.byId, firstTime = old.size === 0;
    if (firstTime || !G.anchors.size) placeClusters();
    G.cById = new Map(G.clusters.map(c => [c.id, { ...c, rgb: hex2rgb((G.anchors.get(c.id) || {}).color || c.color) }]));
    const nodes = (data.nodes || []).map(r => {
      const prev = old.get(r.id), n = prev || { id: r.id };
      Object.assign(n, { label: r.label, cat: r.cat, at: new Date(r.at).getTime(), c1: r.c1, c2: r.c2, w: Number(r.w) || 0, deg: 0, parent: null });
      n.isNew = !prev;
      return n;
    });
    G.nodes = nodes; G.byId = new Map(nodes.map(n => [n.id, n]));
    G.edges = (data.edges || []).map(([a, b, w]) => ({ a, b, w: Number(w) })).filter(e => G.byId.has(e.a) && G.byId.has(e.b));
    for (const e of G.edges) { G.byId.get(e.a).deg++; G.byId.get(e.b).deg++; }
    G.edges.sort((x, y) => y.w - x.w);
    const degs = nodes.map(n => n.deg).sort((a, b) => b - a), hubCut = Math.max(6, degs[Math.floor(degs.length * 0.03)] || 6);
    const newest = nodes.length ? Math.max(...nodes.map(n => n.at)) : Date.now();
    for (const n of nodes) {
      const a = G.cById.get(n.c1), b = G.cById.get(n.c2);
      n.rgb = a ? (b ? mix(a.rgb, b.rgb, n.w) : a.rgb) : GREY;
      n.dot = a ? (b ? mix(a.rgb, b.rgb, Math.round(n.w * 10) / 10) : a.rgb) : GREY;
      n.bright = 0.7 + 0.3 * Math.exp(-Math.max(0, (newest - n.at) / 864e5) / 21);   // newer = a bit brighter
      n.hub = n.deg >= hubCut;
    }
    // thread parent: strongest link to an older thought in the same topic
    for (const e of G.edges) {
      if (e.w < 0.6) continue;
      const a = G.byId.get(e.a), b = G.byId.get(e.b);
      if (a.c1 !== b.c1) continue;
      const [older, newer] = a.at <= b.at ? [a, b] : [b, a];
      if (!newer.parent && !newer.hub) newer.parent = older;
    }
    const order = nodes.slice().sort((x, y) => x.at - y.at);
    if (firstTime) {
      // As the brain grows, dots get a bit smaller and topics fill more of the brain, so it stays
      // a cloud of points instead of turning into blobs.
      G.density = Math.max(0.42, Math.min(1, Math.sqrt(173 / Math.max(1, nodes.length))));
      G.spread = 1 + (1 - G.density) * 1.1;
      tintDust();
      order.forEach(placeNode);
      nodes.forEach(n => { n.isNew = false; });
    } else {
      const added = order.filter(n => n.isNew);
      added.forEach(placeNode);
      if (fresh && added.length) { const t = performance.now(); added.forEach(n => { n.pulse = t; }); obGraphToast(added.length); }
      added.forEach(n => { n.isNew = false; });
    }
    G.at = data.at;
    renderLegend();
    $('graphCanvas').setAttribute('aria-label', `3D map of ${nodes.length} thoughts in ${G.clusters.length} topics`);
    if (firstTime) resize();
    G.lastUser = performance.now();                  // spin a little when it first appears
    wake();
  }

  function obGraphToast(n) {
    const el = $('graphNote');
    el.textContent = `${n} new ${n === 1 ? 'thought' : 'thoughts'} just landed on your map`;
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
    if (!quiet && !G.nodes.length) $('graphStatus').textContent = 'Drawing your brain…';
    try {
      const { data, error } = await sb.rpc('brain_graph');
      if (error) throw error;
      ingest(data, { fresh: G.nodes.length > 0 });
      obCache.put('graph', data);                    // short labels only, never full thoughts
      $('graphStatus').textContent = '';
    } catch (err) {
      console.warn('brain_graph failed:', err);
      if (!G.nodes.length) {
        const c = obCache.get('graph');
        if (c) ingest(c.value, { fresh: false });
        $('graphStatus').textContent = c ? '' : 'Could not load your map: ' + (err.message || 'unknown error');
      }
    } finally { loading = false; }
  }

  // ---------- 3D -> screen ----------
  function projector() {
    const scale = Math.min(G.W, G.H * 1.15) * 0.36 * G.zoom, dist = 3.4;
    const cx = G.W / 2, cy = G.H / 2 + G.H * 0.03;
    const cY = Math.cos(G.rot.y), sY = Math.sin(G.rot.y), cX = Math.cos(G.rot.x), sX = Math.sin(G.rot.x);
    return (p) => {
      const rx = p.x * cY + p.z * sY, z1 = -p.x * sY + p.z * cY;
      const ry = p.y * cX - z1 * sX, z2 = p.y * sX + z1 * cX;
      const f = scale / (dist + z2);
      return { sx: cx + rx * f * dist, sy: cy - ry * f * dist, z: z2, s: f * dist / scale, depth: (z2 + 1.5) / 3 };
    };
  }

  function resize() {
    const wrap = $('graphCanvas').parentElement, r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    G.dpr = Math.min(window.devicePixelRatio || 1, G.nodes.length > 900 ? 2 : 3);
    G.W = r.width; G.H = r.height;
    const c = $('graphCanvas'); c.width = Math.round(G.W * G.dpr); c.height = Math.round(G.H * G.dpr);
    wake();
  }
  function fit() { G.rot = { ...HOME_ROT }; G.zoom = 1; G.lastUser = performance.now(); wake(); }

  // ---------- drawing ----------
  const BG = '#16151a', BG_FAR = '#0c0b0e';                 // Graphite: soft charcoal center, darker edges
  function focusOn(n) {
    const sel = G.selected, hl = G.highlight;
    return (!sel || n === sel || sel.nbr?.has(n.id)) && (hl == null || n.c1 === hl || n.c2 === hl);
  }
  const dotR = (n) => (0.9 + Math.sqrt(n.deg) * 0.36) * (0.55 + 0.45 * (G.density || 1)) * Math.max(0.6, n.s) * Math.min(1.8, 0.85 + G.zoom * 0.15);

  function draw(now) {
    G.frames = (G.frames || 0) + 1;
    const c = $('graphCanvas'), g = c.getContext('2d'), d = G.dpr, P = projector();
    const sel = G.selected, hl = G.highlight, dimming = !!sel || hl != null;
    // Background + a faint glow over each brain region (Graphite lighting). It's all soft,
    // so it's painted into a small layer and stretched: cheap even while the brain turns.
    const S = 4, L = G.sky || (G.sky = document.createElement('canvas'));
    const lw = Math.max(1, Math.ceil(G.W / S)), lh = Math.max(1, Math.ceil(G.H / S));
    if (L.width !== lw || L.height !== lh) { L.width = lw; L.height = lh; }
    const q = L.getContext('2d');
    q.globalCompositeOperation = 'source-over';
    const bg = q.createRadialGradient(lw / 2, lh / 2, 0, lw / 2, lh / 2, Math.max(lw, lh) * 0.75);
    bg.addColorStop(0, BG); bg.addColorStop(0.55, BG); bg.addColorStop(1, BG_FAR);
    q.fillStyle = bg; q.fillRect(0, 0, lw, lh);
    q.globalCompositeOperation = 'lighter';
    const scale = Math.min(G.W, G.H * 1.15) * 0.36 * G.zoom;
    for (const [id, R] of G.anchors) {
      for (const sx of (R.mirror ? [1, -1] : [1])) {
        const pr = P({ x: R.c.x * sx, y: R.c.y, z: R.c.z });
        const rad = R.r * G.spread * scale * 1.4 * pr.s / S;
        const depthFade = Math.max(0.25, 1 - pr.depth * 0.55);
        const on = hl == null || hl === id;
        const al = (hl === id ? 0.2 : 0.075) * depthFade * (on ? 1 : 0.3);
        const col = hex2rgb(R.color), gr = q.createRadialGradient(pr.sx / S, pr.sy / S, 0, pr.sx / S, pr.sy / S, rad);
        gr.addColorStop(0, rgba(col, al)); gr.addColorStop(0.55, rgba(col, al * 0.45)); gr.addColorStop(1, rgba(col, 0));
        q.fillStyle = gr; q.beginPath(); q.arc(pr.sx / S, pr.sy / S, rad, 0, 6.2832); q.fill();
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy'; g.globalAlpha = 1; g.imageSmoothingEnabled = true;
    g.drawImage(L, 0, 0, lw * S * d, lh * S * d);
    g.setTransform(d, 0, 0, d, 0, 0);
    g.globalCompositeOperation = 'source-over';

    // project every thought (plus any drag offset)
    for (const n of G.nodes) { const q = P(n.p); n.sx = q.sx + n.ox; n.sy = q.sy + n.oy; n.z = q.z; n.s = q.s; n.depth = q.depth; }

    // 1. brain dust: the shape, as a faint twinkling cloud (grouped by brightness = fast)
    if (G.showDust) {
      const t = REDUCED ? 0 : now * 0.0005, buckets = new Map();
      for (const p of DUST_POINTS) {
        const q = P(p);
        const tw = 0.65 + 0.35 * Math.sin(t * p.tf + p.tp);
        const a = (1 - q.depth) * (q.z > 0 ? 0.2 : 0.36) * tw * (dimming ? 0.6 : 1);
        const b = Math.max(0, Math.min(7, Math.round(a * 20)));
        if (!b) continue;
        const key = (p.key || '214,206,192') + '|' + b;
        let path = buckets.get(key); if (!path) buckets.set(key, path = new Path2D());
        const r = q.z > 0 ? 0.8 : 1.05;
        path.rect(q.sx - r, q.sy - r, r * 2, r * 2);     // tiny squares: look the same, cheaper
      }
      g.globalCompositeOperation = 'lighter';
      for (const [key, path] of buckets) { const [cs, b] = key.split('|'); g.fillStyle = `rgba(${cs},${b / 20})`; g.fill(path); }
      g.globalCompositeOperation = 'source-over';
    }

    // 2. links: soft curves through the inside of the brain (grouped by color = fast)
    const groups = new Map(), lit = new Path2D(); let litN = 0, drawn = 0;
    for (const e of G.edges) {
      const isLit = sel && (e.a === sel.id || e.b === sel.id);
      if (!isLit && G.strongOnly && e.w < STRONG) continue;
      if (!isLit && drawn >= MAX_EDGES) continue;
      const a = G.byId.get(e.a), b = G.byId.get(e.b);
      if (!isLit && dimming && !(focusOn(a) && focusOn(b))) continue;
      const ctrl = P({ x: (a.p.x + b.p.x) * 0.35, y: (a.p.y + b.p.y) * 0.35, z: (a.p.z + b.p.z) * 0.35 });
      const cxs = ctrl.sx + (a.ox + b.ox) / 2, cys = ctrl.sy + (a.oy + b.oy) / 2;
      if (isLit) { lit.moveTo(a.sx, a.sy); lit.quadraticCurveTo(cxs, cys, b.sx, b.sy); litN++; continue; }
      const far = (a.z + b.z) / 2 > 0;
      const al = (far ? 0.06 : 0.15) * (a.c1 === b.c1 ? 1 : 1.5) * (dimming ? 0.7 : 1);
      const key = mix(a.dot, b.dot, 0.5).join(',') + '|' + Math.round(al * 40);
      let path = groups.get(key); if (!path) groups.set(key, path = new Path2D());
      path.moveTo(a.sx, a.sy); path.quadraticCurveTo(cxs, cys, b.sx, b.sy);
      drawn++;
    }
    g.lineWidth = 0.7; g.lineCap = 'round';
    for (const [key, path] of groups) { const [cs, al] = key.split('|'); g.strokeStyle = `rgba(${cs},${Number(al) / 40})`; g.stroke(path); }
    if (litN) { g.strokeStyle = rgba(mix(sel.dot, WHITE, 0.3), 0.85); g.lineWidth = 1.2; g.stroke(lit); }

    // 3. sparks travelling along links (a living feel)
    if (!REDUCED && G.signals.length) {
      g.globalCompositeOperation = 'lighter';
      for (const s of G.signals) {
        const p = (now - s.born) / s.dur; if (p < 0 || p > 1) continue;
        const env = Math.sin(p * Math.PI), A = s.a.p, B = s.b.p;
        const m = { x: (A.x + B.x) * 0.35, y: (A.y + B.y) * 0.35, z: (A.z + B.z) * 0.35 };
        for (let i = 0; i < 5; i++) {
          const t = Math.max(0, p - i * 0.035), mt = 1 - t;
          const q = P({ x: mt * mt * A.x + 2 * mt * t * m.x + t * t * B.x, y: mt * mt * A.y + 2 * mt * t * m.y + t * t * B.y, z: mt * mt * A.z + 2 * mt * t * m.z + t * t * B.z });
          g.fillStyle = rgba(mix(s.a.dot, s.b.dot, t), (1 - i / 5) * env * 0.9);
          g.beginPath(); g.arc(q.sx, q.sy, (1.4 - i * 0.18) * Math.max(0.6, q.s), 0, 6.2832); g.fill();
        }
      }
      g.globalCompositeOperation = 'source-over';
    }

    // 4. thoughts: back half first, then front half. Within each half, dots are drawn in batches
    // by color + brightness (fast even with thousands): small halo, colored dot, white core.
    const crowded = (G.density || 1) < 0.6;
    for (const front of [false, true]) {
      const discs = new Map(), cores = new Map(), hubs = new Path2D(); let hubA = 0;
      g.globalCompositeOperation = 'lighter';
      for (const n of G.nodes) {
        if ((n.z <= 0) !== front) continue;
        if (n.sx < -20 || n.sy < -20 || n.sx > G.W + 20 || n.sy > G.H + 20) continue;
        const fade = Math.max(0.35, 1 - n.depth * 0.7) * n.bright;
        const a = Math.min(1, focusOn(n) ? fade : fade * 0.14);
        const r = dotR(n) * (n === sel ? 1.5 : 1);
        n.r = r; n.a = a;
        if (r > 1.3 && (!crowded || n.hub)) {
          g.globalAlpha = Math.min(1, a * 0.9 * (G.density || 1) ** 1.5);   // halos fade in a crowd
          g.drawImage(haloSprite(n.dot), n.sx - r * 2.6, n.sy - r * 2.6, r * 5.2, r * 5.2);
        }
        const ab = Math.max(1, Math.round(a * 10));
        const dk = n.dot.join(',') + '|' + ab;
        let dp = discs.get(dk); if (!dp) discs.set(dk, dp = new Path2D());
        dp.moveTo(n.sx + r, n.sy); dp.arc(n.sx, n.sy, r, 0, 6.2832);
        let cp = cores.get(ab); if (!cp) cores.set(ab, cp = new Path2D());
        const cr = Math.max(0.6, r * 0.45); cp.moveTo(n.sx + cr, n.sy); cp.arc(n.sx, n.sy, cr, 0, 6.2832);
        if (n.hub && a > 0.3) {
          hubA = Math.max(hubA, a);
          hubs.moveTo(n.sx + r + 3.5, n.sy); hubs.arc(n.sx, n.sy, r + 3.5, 0, 6.2832);
          hubs.moveTo(n.sx - r * 3.4 - 4, n.sy); hubs.lineTo(n.sx - r - 5, n.sy); hubs.moveTo(n.sx + r + 5, n.sy); hubs.lineTo(n.sx + r * 3.4 + 4, n.sy);
          hubs.moveTo(n.sx, n.sy - r * 3.4 - 4); hubs.lineTo(n.sx, n.sy - r - 5); hubs.moveTo(n.sx, n.sy + r + 5); hubs.lineTo(n.sx, n.sy + r * 3.4 + 4);
        }
      }
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      for (const [k, dp] of discs) { const [cs, ab] = k.split('|'); g.fillStyle = `rgba(${cs},${ab / 10 * 0.93})`; g.fill(dp); }
      for (const [ab, cp] of cores) { g.fillStyle = `rgba(255,255,255,${ab / 10})`; g.fill(cp); }
      if (hubA) { g.strokeStyle = `rgba(220,214,200,${0.45 * hubA})`; g.lineWidth = 0.7; g.stroke(hubs); }
    }
    for (const n of G.nodes) {                         // a ring flashes on brand-new thoughts
      if (!n.pulse) continue;
      const p = (now - n.pulse) / 2400;
      if (p >= 1) { n.pulse = 0; continue; }
      g.strokeStyle = rgba(n.dot, (1 - p) * 0.9); g.lineWidth = 1.4; g.beginPath(); g.arc(n.sx, n.sy, (n.r || 2) + p * 26, 0, 6.2832); g.stroke();
    }
    if (sel) {
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.3;
      g.beginPath(); g.arc(sel.sx, sel.sy, dotR(sel) * 1.5 + 4, 0, 6.2832); g.stroke();
    }
  }

  // ---------- animation loop ----------
  function physics() {                               // dragged dots spring back (with a little wobble)
    let moving = false;
    for (const n of G.nodes) {
      if (G.drag && G.drag.node === n) continue;
      if (!n.ox && !n.oy && !n.vx && !n.vy) continue;
      n.vx = (n.vx - n.ox * 0.12) * 0.8; n.vy = (n.vy - n.oy * 0.12) * 0.8;
      n.ox += n.vx; n.oy += n.vy;
      if (Math.abs(n.ox) + Math.abs(n.oy) + Math.abs(n.vx) + Math.abs(n.vy) < 0.05) { n.ox = n.oy = n.vx = n.vy = 0; } else moving = true;
    }
    return moving;
  }

  function frame(now) {
    G.raf = 0;
    if (!G.visible) return;
    const dt = Math.min(50, now - (G.lastFrame || now));
    const spinning = !REDUCED && !G.drag && !G.pinch && now - G.lastUser < SPIN_MS;
    const moving = physics();
    // A slow idle spin only needs ~24 frames a second (like Brain Atlas's phone mode); touching it runs at full speed.
    if (spinning && !moving && !G.turnTo && now - G.lastFrame < 40) { G.raf = requestAnimationFrame(frame); return; }
    G.lastFrame = now;
    if (spinning && !G.turnTo) G.rot.y += dt * 0.00011 * (1 - Math.min(1, (now - G.lastUser) / SPIN_MS) * 0.7);
    if (G.turnTo) {                                    // turning to face a tapped thought
      const p = Math.min(1, (now - G.turnTo.t0) / 500), e = 1 - Math.pow(1 - p, 3);
      G.rot.y = G.turnTo.from.y + G.turnTo.dy * e; G.rot.x = G.turnTo.from.x + (G.turnTo.x - G.turnTo.from.x) * e;
      if (p >= 1) G.turnTo = null;
    }
    if (!REDUCED && spinning && now - G.lastSpark > 900 && G.edges.length) {   // a spark about every second
      const e = G.edges[Math.floor(Math.random() * Math.min(G.edges.length, 300))];
      G.signals.push({ a: G.byId.get(e.a), b: G.byId.get(e.b), born: now, dur: 1600 }); G.lastSpark = now;
    }
    G.signals = G.signals.filter(s => now - s.born < s.dur);
    draw(now);
    const busy = spinning || moving || G.drag || G.pinch || G.turnTo || G.signals.length || G.nodes.some(n => n.pulse);
    if (busy) G.raf = requestAnimationFrame(frame);
  }
  function wake() { if (G.visible && !G.raf && G.W) G.raf = requestAnimationFrame(frame); }

  // ---------- touch: turn, pinch, drag a dot, tap ----------
  const ptrs = new Map();
  function local(e) { const r = $('graphCanvas').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hit(sx, sy) {
    let best = null, bd = Infinity;
    for (const n of G.nodes) {
      if (n.sx === undefined) continue;
      const d = Math.hypot(n.sx - sx, n.sy - sy);
      if (d < 22 && d + n.z * 6 < bd) { bd = d + n.z * 6; best = n; }   // 44px finger target; nearer dots win
    }
    return best;
  }
  function onDown(e) {
    $('graphCanvas').setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    ptrs.set(e.pointerId, { sx, sy, x0: sx, y0: sy, t0: performance.now() });
    G.lastUser = performance.now(); G.turnTo = null;
    if (ptrs.size === 2) {
      G.drag = null;
      const [p, q] = [...ptrs.values()];
      G.pinch = { d0: Math.hypot(p.sx - q.sx, p.sy - q.sy), z0: G.zoom };
      return;
    }
    const n = hit(sx, sy);
    G.drag = n ? { node: n } : { rot: { ...G.rot } };
    wake();
  }
  function onMove(e) {
    const p = ptrs.get(e.pointerId); if (!p) return;
    [p.sx, p.sy] = local(e);
    G.lastUser = performance.now();
    if (G.pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      G.zoom = Math.max(0.6, Math.min(5, G.pinch.z0 * Math.hypot(a.sx - b.sx, a.sy - b.sy) / G.pinch.d0));
      wake(); return;
    }
    if (!G.drag) return;
    const dx = p.sx - p.x0, dy = p.sy - p.y0;
    if (G.drag.node) {                                // pull the dot; linked dots follow a little
      const n = G.drag.node; n.ox = dx; n.oy = dy; n.vx = n.vy = 0;
      for (const e2 of G.edges) {
        if (e2.w < 0.6) continue;
        const m = e2.a === n.id ? G.byId.get(e2.b) : e2.b === n.id ? G.byId.get(e2.a) : null;
        if (m) { m.ox = dx * 0.3; m.oy = dy * 0.3; m.vx = m.vy = 0; }
      }
    } else if (G.drag.rot) {                          // turn the brain
      G.rot.y = G.drag.rot.y - dx / 180;
      G.rot.x = Math.max(-1.4, Math.min(1.4, G.drag.rot.x - dy / 180));
    }
    wake();
  }
  function onUp(e) {
    const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
    if (ptrs.size < 2) G.pinch = null;
    if (!p) return;
    const moved = Math.hypot(p.sx - p.x0, p.sy - p.y0), quick = performance.now() - p.t0 < 400;
    const d = G.drag; G.drag = null;
    G.lastUser = performance.now();
    if (moved < 8 && quick && ptrs.size === 0) select(d && d.node ? d.node : null);
    wake();                                           // let go: dots spring back, the brain keeps turning a bit
  }

  // ---------- a thought ----------
  function turnToFace(p) {                           // rotate so this point faces you
    const target = Math.atan2(p.x, -p.z);
    let dy = target - G.rot.y; dy = ((dy + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    G.turnTo = { t0: performance.now(), from: { ...G.rot }, dy, x: Math.max(-0.6, Math.min(0.6, -p.y * 0.5)) };
    G.lastUser = performance.now();
    wake();
  }
  function select(n) {
    G.selected = n;
    const sheet = $('graphSheet');
    if (!n) { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); wake(); return; }
    n.nbr = new Map();
    for (const e of G.edges) { if (e.a === n.id) n.nbr.set(e.b, e.w); if (e.b === n.id) n.nbr.set(e.a, e.w); }
    const c1 = G.cById.get(n.c1), c2 = G.cById.get(n.c2);
    const area = G.anchors.get(n.c1)?.area;
    const topic = c1 ? `${esc(c1.name)}${area ? ` <span style="color:var(--muted); font-weight:500;">· ${esc(area)}</span>` : ''}${c2 && n.w > 0.2 ? ` <span style="color:var(--muted)">· between ${esc(c1.name)} and ${esc(c2.name)}</span>` : ''}` : 'No topic yet';
    const near = [...n.nbr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => G.byId.get(id)).filter(Boolean);
    sheet.innerHTML = `
      <div class="gs-top"><span class="gs-dot" style="background:${rgba(n.dot, 1)}"></span>
        <span class="gs-topic">${topic}</span>
        <button class="secondary icon-btn gs-close" type="button" aria-label="Close" data-gs-close="1">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gs-date">${esc(new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}${n.cat ? ' · ' + esc(n.cat) : ''} · ${n.deg} ${n.deg === 1 ? 'link' : 'links'}</div>
      <div class="gs-text" id="gsText">${esc(n.label)}</div>
      <button type="button" data-gs-open="${esc(n.id)}" style="width:100%; margin-top:12px;">Read the full thought</button>
      ${near.length ? `<div class="gs-near-title">Connected</div>${near.map(m => `
        <button type="button" class="gs-near" data-gs-jump="${esc(m.id)}"><span class="gs-dot" style="background:${rgba(m.dot, 1)}"></span><span>${esc(m.label)}</span></button>`).join('')}` : ''}`;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
    turnToFace(n.p);
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
  function jumpTo(id) { const n = G.byId.get(id); if (n) select(n); }

  // ---------- topic list under the map ----------
  function renderLegend() {
    const el = $('graphLegend');
    el.innerHTML = G.clusters.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).map(c => `
      <button type="button" class="chip legend-chip ${G.highlight === c.id ? 'active' : ''}" data-topic="${c.id}" aria-pressed="${G.highlight === c.id}">
        <span class="gs-dot" style="background:${rgba(G.cById.get(c.id).rgb, 1)}"></span>${esc(c.name)}</button>`).join('');
  }

  function setup() {
    const c = $('graphCanvas');
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('wheel', (e) => {             // trackpad / mouse zoom on a computer
      e.preventDefault();
      G.zoom = Math.max(0.6, Math.min(5, G.zoom * Math.exp(-e.deltaY * 0.0015)));
      G.lastUser = performance.now(); wake();
    }, { passive: false });
    $('graphLegend').addEventListener('click', (e) => {
      const b = e.target.closest('[data-topic]'); if (!b) return;
      const id = Number(b.dataset.topic);
      G.highlight = G.highlight === id ? null : id; renderLegend();
      const A = G.highlight != null && G.anchors.get(id);
      if (A) turnToFace(A.c);                       // turn the brain toward that region
      G.lastUser = performance.now(); wake();
    });
    $('graphLinks').addEventListener('click', () => {
      G.strongOnly = !G.strongOnly;
      $('graphLinks').textContent = G.strongOnly ? 'Strong links' : 'All links';
      $('graphLinks').setAttribute('aria-pressed', String(!G.strongOnly)); wake();
    });
    $('graphFit').addEventListener('click', () => { select(null); G.highlight = null; renderLegend(); fit(); });
    $('graphSheet').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.gsClose) select(null);
      else if (b.dataset.gsOpen) openFull(b.dataset.gsOpen);
      else if (b.dataset.gsJump) jumpTo(b.dataset.gsJump);
    });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(c.parentElement);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (G.visible) start(); });
    window.addEventListener('online', () => { if (G.visible) fetchGraph({ quiet: true }); });
  }

  function start() {
    resize(); G.lastUser = performance.now(); wake();
    clearInterval(G.poll);
    G.poll = setInterval(() => { if (G.visible && !document.hidden) fetchGraph({ quiet: true }); }, POLL_MS);
  }
  function stop() { cancelAnimationFrame(G.raf); G.raf = 0; clearInterval(G.poll); }

  setup();
  window.obGraph = {
    show() { G.visible = true; start(); fetchGraph(); },
    hide() { G.visible = false; stop(); },
    reset() {                                        // forget the current map (used by the preview page)
      G.nodes = []; G.byId = new Map(); G.edges = []; G.selected = null; G.highlight = null; G.signals = [];
      G.rot = { ...HOME_ROT }; G.zoom = 1;
      $('graphSheet').classList.remove('open');
    },
    fit,
    _draw: (t) => draw(t),                          // for the browser test (timing)
    _state: G,                                       // for the browser test
  };
})();
