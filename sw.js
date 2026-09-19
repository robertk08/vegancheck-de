/* Offline-Hülle: die App startet auch ohne Netz, Produktdaten brauchen Verbindung.
   Netz zuerst, Cache als Rückfall – sonst bliebe ein Besucher für immer auf der
   Fassung hängen, die er beim ersten Besuch geladen hat. */
const CACHE = 'vegancheck-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js',
  'icon.svg', 'manifest.webmanifest', 'vendor/zxing-0.21.3.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;  // Produktabfragen immer live

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
