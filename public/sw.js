// sw.js — cachea HTML/CSS/JS/íconos; no cachea SSE ni POSTs
const CACHE = 'inbox-greenfield-v1';
const APP_SHELL = [
  '/public/agent.html',
  '/public/agent.css',
  '/public/agent.js',
  '/public/manifest.webmanifest',
  '/public/icons/icon-192.png',
  '/public/icons/icon-512.png',
  '/public/icons/maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;

  // No interceptar SSE ni métodos no-GET
  if (request.method !== 'GET') return;
  if (request.headers.get('accept')?.includes('text/event-stream')) return;

  const url = new URL(request.url);

  // Estrategia: Static -> cache first; resto -> network first con fallback
  const isStatic = url.pathname.startsWith('/public/') || url.pathname.match(/\.(css|js|png|jpg|svg|webp|ico|woff2?)$/i);

  if (isStatic) {
    e.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(request, clone));
        return r;
      }))
    );
  } else {
    e.respondWith(
      fetch(request).catch(() => caches.match(request).then(hit => hit || caches.match('/public/agent.html')))
    );
  }
});
