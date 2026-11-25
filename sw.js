// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'cbz-compiler-v1';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'css/app.css',
  'js/app.js', 'js/natural.js', 'js/paths.js', 'js/zip.js', 'js/model.js', 'js/ordering.js', 'js/textorder.js',
  'js/rules.js', 'js/structure.js', 'js/export.js', 'js/validate.js', 'js/importer.js',
  'js/ui/dom.js', 'js/ui/virtual.js', 'js/ui/thumbs.js', 'js/ui/pagelist.js', 'js/ui/import-dialog.js',
  'js/ui/order-dialogs.js', 'js/ui/export-dialog.js', 'js/ui/rules-dialog.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first so updates show up, cache as the offline fallback.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))),
  );
});
