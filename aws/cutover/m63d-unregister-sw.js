if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
  if (navigator.serviceWorker.getRegistrations) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
}
