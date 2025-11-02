const CACHE = 'inbox-greenfield-v3';
const APP_SHELL = [
  './agent.html',
  './agent.css',
  './agent.js',
  './manifest.webmanifest',
  './greenfield-logo.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.get('accept')?.includes('text/event-stream')) return; // no cachear SSE

  const url = new URL(req.url);
  const isStatic = url.pathname.endsWith('/agent.html') || APP_SHELL.some(p => url.pathname.endsWith(p.replace('./','/')));

  if (isStatic || /\.(css|js|png|jpg|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(r => {
        const clone = r.clone(); caches.open(CACHE).then(c => c.put(req, clone)); return r;
      }))
    );
  } else {
    e.respondWith(fetch(req).catch(()=> caches.match('./agent.html')));
  }
});
