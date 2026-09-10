/**
 * M6.3D: unregister the leftover M6.2L Workbox PWA so the AWS session-load SPA can load.
 * The aws-mode build does not register a service worker. This file replaces live /sw.js.
 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url) client.navigate(client.url);
    }
  })());
});
