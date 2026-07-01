// Laxorq Automate service worker — makes the dashboard installable + usable offline.
// Strategy: never cache /api (always live data); network-first for the app shell with a
// cache fallback so the installed app still opens without a connection.
const CACHE = 'laxorq-automate-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;                 // let POST/PATCH hit the network
  if (url.pathname.startsWith('/api/')) return;         // live data, never cached
  if (url.origin !== self.location.origin) return;      // third-party (fonts) — default

  e.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/')))
  );
});
