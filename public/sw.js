// Minimal service worker so the app can be installed.
// We'll improve caching later.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
