/* DVDthèque — service worker (mode DÉVELOPPEMENT, sans cache)
   Pendant la phase de test, on ne met RIEN en cache : chaque
   rechargement sert toujours la dernière version des fichiers.
   On purge aussi les anciens caches de la version précédente.
   (On réactivera le cache offline quand l'app sera stable.) */

self.addEventListener('install', (e) => {
  self.skipWaiting(); // prend le contrôle immédiatement
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k)))) // vide tout
      .then(() => self.clients.claim())
  );
});

// Toujours aller au réseau, jamais le cache
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
