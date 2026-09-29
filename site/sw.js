// HexTriad service worker: lets the installed app open and play offline.
// Network first, so a newly uploaded version is picked up whenever the device is online;
// the cached copy is used only when offline. The build stamps a new version below each time.
const CACHE = 'hextriad-mumye26b';
const FILES = ['./', './index.html', './manifest.webmanifest',
  './app-icons/icon-192.png', './app-icons/icon-512.png', './app-icons/icon-maskable-512.png', './app-icons/apple-touch-icon.png'];

// Each file is cached on its own: if one is missing on the host (for example the server does not
// answer the bare folder address "./"), the others are still cached and the worker still installs.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => undefined))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hextriad-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
        .then((hit) => hit || Response.error()))
  );
});
