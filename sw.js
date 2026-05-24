/* DVDthèque — service worker (mode DÉVELOPPEMENT, ZÉRO cache)
   - Ne met jamais rien en cache.
   - Supprime tous les anciens caches au démarrage.
   - Prend le contrôle immédiatement (skipWaiting + clients.claim).
   - Réseau uniquement : on voit toujours la dernière version. */

const SW_VERSION = 'dev-nocache-v3';

self.addEventListener('install', () => {
  self.skipWaiting(); // ne pas attendre la fermeture des onglets
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge tous les caches existants (vestiges des anciennes versions)
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim(); // prend la main sur les pages ouvertes
  })());
});

// Toujours réseau, jamais de cache. (HTML/JS/CSS toujours frais.)
self.addEventListener('fetch', (e) => {
  // On ne touche pas aux requêtes cross-origin (TMDB, Firebase, gstatic…)
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))
  );
});
