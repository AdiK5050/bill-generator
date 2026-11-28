// Service worker: caches the app shell so the app works offline after the first load.
// Bump CACHE_VERSION whenever any file in APP_SHELL changes.
const CACHE_VERSION = 'v24';
const CACHE_NAME = `bill-generator-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/vendor/purify.min.js',
  'js/app.js',
  'js/version.js',
  'js/library.js',
  'js/settings.js',
  'js/storage.js',
  'js/engine/index.js',
  'js/engine/calc.js',
  'js/engine/fields.js',
  'js/engine/format.js',
  'js/engine/parser.js',
  'js/engine/renderer.js',
  'js/engine/sanitizer.js',
  'js/ai/config.js',
  'js/ai/key-sync.js',
  'js/ai/providers.js',
  'js/ai/template-assistant.js',
  'js/sync/account.js',
  'js/sync/sync.js',
  'js/ui/ai-panel.js',
  'js/ui/bill-view.js',
  'js/ui/dom.js',
  'js/ui/form.js',
  'js/ui/history-view.js',
  'js/ui/preview.js',
  'js/ui/settings-view.js',
  'js/ui/templates-view.js',
  'templates/classic.html',
  'templates/modern.html',
  'templates/gst-invoice.html',
  'templates/thermal-receipt.html',
  'docs/template-guide.html',
  'docs/template-guide.css',
  'docs/template-guide.js',
  'docs/theme.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('bill-generator-') && k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only the app's own files. Calls to the sync server always go to the network.
  if (url.origin !== self.location.origin) return;

  // Pages: network first so updates show up, cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('index.html', { ignoreSearch: true })));
    return;
  }

  // Static files: cache first, then network (and cache the result).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
