// Service worker: lets the app open with no signal.
// - Your own files (index.html, *.js): try the network first (so a push to Vercel shows up
//   right away), fall back to the saved copy after 3 seconds or when offline.
// - Libraries and fonts from CDNs: saved copy first (their URLs are pinned, they never change).
// - Supabase (your data, your login): never touched or stored here. Offline copies of your
//   lists are kept by shell.js on the phone itself, trimmed and only for you.
// - Brain Calendar notifications: shows pushed messages and opens the right tab when tapped.
// Bump VERSION when you change this file so phones pick up the new one.
const VERSION = 'ob-2026-10-21-push1';
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

// ---------- Notifications from Brain Calendar (web push, #63-#66) ----------
// The server sends { title, body, url }. Tapping opens that place in the app
// (e.g. /#today, /#jobs/<id>) or, for an email, the email itself.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'Brain Calendar';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || '/#today' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/#today', self.location.origin).href;
  event.waitUntil((async () => {
    const sameApp = target.startsWith(self.location.origin);
    if (sameApp) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find(w => w.url.startsWith(self.location.origin));
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', url: target }); // the page switches tab (shell.js)
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
