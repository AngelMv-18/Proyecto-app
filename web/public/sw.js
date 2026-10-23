// Service worker mínimo: guarda en caché SOLO el "cascarón" estático de la app.
// Nunca se almacenan respuestas de /api (datos financieros) en la caché del navegador.
const CACHE = 'nova-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon.svg']))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then((r) => { if (r.ok && (u.pathname.startsWith('/assets/') || u.pathname === '/')) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/'))),
  );
});
