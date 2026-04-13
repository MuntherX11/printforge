const CACHE_VERSION = 'v3';
const STATIC_CACHE = `printforge-static-${CACHE_VERSION}`;
const FONT_CACHE = `printforge-fonts-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// ---------------------------------------------------------------------------
// Install: precache shell assets
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })))
        .catch(() => {}) // don't fail install if an optional asset is missing
    ).then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activate: delete stale caches from previous versions
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('printforge-') && k !== STATIC_CACHE && k !== FONT_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch strategy
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and browser-extension requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // Socket.IO: always network, never cache
  if (url.pathname.startsWith('/api/socket.io')) return;

  // API calls: network-first, no cache fallback (stale data is worse than no data)
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
    event.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    return;
  }

  // Google Fonts: cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Static assets (_next/static, icons, manifest): stale-while-revalidate
  const isStatic =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    /\.(js|css|svg|png|jpg|jpeg|webp|woff2?|ico)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
          // Serve cached immediately; update in background
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // HTML navigation (app shell): network-first, fall back to cached '/'
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match('/').then((cached) => cached || new Response('Offline', { status: 503 }))
        )
    );
  }
});
