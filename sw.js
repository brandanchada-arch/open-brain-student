// Service worker: lets the app open with no signal.
// - Your own files (index.html, *.js): try the network first (so a push to Vercel shows up
//   right away), fall back to the saved copy after 3 seconds or when offline.
// - Libraries and fonts from CDNs: saved copy first (their URLs are pinned, they never change).
// - Supabase (your data, your login): never touched or stored here. Offline copies of your
//   lists are kept by shell.js on the phone itself, trimmed and only for you.
// Bump VERSION when you change this file so phones pick up the new one.
const VERSION = 'ob-2026-10-19-c2';
const SHELL = [
  './', 'index.html', 'shell.js', 'graph.js', 'gaps.js', 'planner.js', 'jobs.js', 'config.js',
  'manifest.json', 'icon-192.png', 'icon-512.png',
];
const CDN_PRELOAD = ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // A CDN hiccup shouldn't stop the install; it gets cached on first use instead.
    await Promise.all(CDN_PRELOAD.map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([fetch(request), timeout(3000)]);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true })
      || (request.mode === 'navigate' ? (await cache.match('./')) || (await cache.match('index.html')) : null);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;           // your data: always live, never stored here
  if (url.origin === self.location.origin) { event.respondWith(networkFirst(req)); return; }
  if (CDN_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req)); return; }
});
