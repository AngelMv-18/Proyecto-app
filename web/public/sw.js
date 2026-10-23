// Service worker mínimo: guarda en caché SOLO el "cascarón" estático de la app.
// Nunca se almacenan respuestas de /api (datos financieros) en la caché del navegador.
const CACHE = 'nova-shell-v2';
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

// Notificaciones push: el servidor envía solo título, texto (en modo privado sin importes) y la ruta a abrir.
self.addEventListener('push', (e) => {
  let d = { title: 'NOVA FINANCE', body: 'Tienes una novedad.', url: '/#/' };
  try { d = { ...d, ...e.data.json() }; } catch { /* sin datos */ }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag, data: { url: d.url }, lang: 'es' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? '/#/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.startsWith(self.location.origin));
    return c ? c.navigate(url).then((w) => w?.focus()) : self.clients.openWindow(url);
  }));
});
