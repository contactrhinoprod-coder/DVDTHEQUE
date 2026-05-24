/* DVDthèque — service worker (ZÉRO cache + auto-update)
   IMPORTANT : à chaque mise à jour de l'app, changer le numéro
   SW_VERSION ci-dessous (ex: v8 -> v9). Ça suffit à ce que le
   navigateur détecte un nouveau service worker, l'active, et
   recharge l'app automatiquement. Plus besoin de vider le cache. */

const SW_VERSION = 'v15';

self.addEventListener('install', () => {
  self.skipWaiting(); // active la nouvelle version sans attendre
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k))); // purge tout cache
    await self.clients.claim(); // prend la main -> déclenche controllerchange
  })());
});

// Toujours réseau, jamais de cache.
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))
  );
});
