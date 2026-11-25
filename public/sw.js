const CACHE_NAME = 'bluedrop-shell-v4';
const PRECACHE_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/robots.txt' ||
    url.pathname === '/sitemap.xml'
  ) {
    return;
  }

  // Navigation requests: network-first, update shell cache, fallback cleanly to cached '/'
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE_NAME).then((c) => c.put(req, copy).catch(() => {}));
          }
          return res;
        })
        .catch(async () => {
          return (await caches.match(req)) || (await caches.match('/')) || Response.error();
        })
    );
    return;
  }

  // Static app shell assets (/assets/*, js, css, fonts, icons): cache-first / network fill so offline startup works cleanly
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE_NAME).then((c) => c.put(req, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => cached || new Response('', { status: 504, statusText: 'Offline' }));

      if (cached) {
        // Return cached immediately for hashed assets; keep updating non-hashed assets in background
        if (!url.pathname.startsWith('/assets/')) {
          void networkFetch;
        }
        return cached;
      }
      return networkFetch;
    })
  );
});
