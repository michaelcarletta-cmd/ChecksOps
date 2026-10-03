/**
 * M6.3D / M6.4A: unregister leftover Workbox PWA so pay-setup cannot be routed
 * back to a cached Lovable bundle. The production SPA must keep serving this
 * kill-switch at /sw.js — do not upload VitePWA's generated worker.
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
