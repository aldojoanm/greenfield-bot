const CACHE = 'inbox-greenfield-v4';
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
  // No cachear SSE
  if (req.headers.get('accept')?.includes('text/event-stream')) return;

  const url = new URL(req.url);
  const isShell = url.pathname.endsWith('/agent.html') || APP_SHELL.some(p => url.pathname.endsWith(p.replace('./','/')));

  if (isShell || /.(css|js|png|jpg|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(r => {
        const clone = r.clone(); caches.open(CACHE).then(c => c.put(req, clone)); return r;
      }))
    );
  } else {
    e.respondWith(fetch(req).catch(()=> caches.match('./agent.html')));
  }
});
