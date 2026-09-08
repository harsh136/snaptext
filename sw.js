const SHELL = 'snaptext-shell-v10';
const CDN = 'snaptext-cdn-v1';
const CORE = ['.', 'index.html', 'styles.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  // Cache each file on its own: one failure must not kill the whole worker.
  e.waitUntil(
    caches.open(SHELL).then(async (c) => {
      await Promise.all(CORE.map(async (u) => {
        try {
          const r = await fetch(u);
          if (r.ok) await c.put(u, r);
        } catch { /* offline on first visit: runtime caching covers it later */ }
      }));
      await self.skipWaiting();
    })
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Engine + language files: cache on first (online) use, serve from device after.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.open(CDN).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) c.put(e.request, res.clone()).catch(() => {});
        return res;
      })))
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
