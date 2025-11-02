const CACHE = 'inbox-greenfield-v6'; // bump cache to force refresh
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

  if (isShell || /\.(css|js|png|jpg|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(r => {
        const clone = r.clone(); caches.open(CACHE).then(c => c.put(req, clone)); return r;
      }))
    );
  } else {
    e.respondWith(fetch(req).catch(()=> caches.match('./agent.html')));
  }
});

/* Web Push */
self.addEventListener('push', (event) => {
  let data = {};
  try{ data = event.data?.json() || {}; }catch{}
  const title = data.title || 'Nuevo mensaje';
  const body  = data.body  || 'Tienes un nuevo mensaje en Inbox';
  const tag   = data.tag   || 'inbox';
  const icon  = data.icon  || './greenfield-logo.png';
  const badge = data.badge || './greenfield-logo.png';
  const options = { body, tag, icon, badge, data: data.url || './agent.html' };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data || './agent.html';
  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for (const c of list) { if (c.url.endsWith('/agent.html')) return c.focus(); }
      return clients.openWindow(url);
    })
  );
});
