// ══════════════════════════════════════════════════════════════════════════════
//  RECON ENGINE — Service Worker  v17-pwa
//  Strategy: Cache-first for static assets, network-first for data
//  Supports: Full offline operation, background sync, update detection
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

const SW_VERSION   = 'recon-v17-pwa-1.0.0';
const STATIC_CACHE = `${SW_VERSION}-static`;
const DATA_CACHE   = `${SW_VERSION}-data`;

// Assets to pre-cache at install time
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  // Google Fonts — cache the CSS; font files cached on first use
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap',
];

// ── INSTALL: pre-cache static shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      // Cache what we can; don't fail install on individual network errors
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] Precache miss:', url, err.message)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DATA_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => {
      console.log('[SW] Activated:', SW_VERSION);
      return self.clients.claim();
    })
  );
});

// ── FETCH: cache-first for static, passthrough for data ──────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;
  if (url.protocol === 'moz-extension:') return;

  // Google Fonts — cache-first (fonts don't change)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // App shell (same origin) — cache-first with network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const networkFetch = fetch(request).then(response => {
            if (response.ok && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          }).catch(() => cached || new Response('App is offline.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          }));
          // Return cache immediately if available, update in background
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // All other requests — passthrough (no caching for external APIs)
  // The app is fully offline-capable via IndexedDB, so no external data needed
});

// ── BACKGROUND SYNC ───────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'recon-sync') {
    console.log('[SW] Background sync triggered: recon-sync');
    event.waitUntil(doBackgroundSync());
  }
});

async function doBackgroundSync() {
  try {
    // Notify all open clients that sync is running
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_START', timestamp: Date.now() });
    });

    // Background sync is a stub — the app manages its own IndexedDB
    // In a real deployment, this would POST pendingSync queue to an API
    // For now, signal completion so the UI can update sync status
    await new Promise(resolve => setTimeout(resolve, 100));

    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_COMPLETE', timestamp: Date.now() });
    });

    console.log('[SW] Background sync complete');
  } catch (err) {
    console.error('[SW] Background sync failed:', err);
    throw err; // Causes browser to retry
  }
});

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  const { data } = event;
  if (!data || !data.type) return;

  switch (data.type) {
    case 'SKIP_WAITING':
      // Client requests immediate activation of new SW
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.source.postMessage({ type: 'VERSION', version: SW_VERSION });
      break;

    case 'CACHE_URLS':
      // Dynamically cache URLs sent from the app
      if (Array.isArray(data.urls)) {
        caches.open(STATIC_CACHE).then(cache =>
          Promise.allSettled(data.urls.map(url => cache.add(url)))
        );
      }
      break;

    default:
      break;
  }
});

// ── PUSH NOTIFICATIONS (stub — extend when server push is available) ──────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const payload = event.data.json().catch(() => ({ title: 'Recon Engine', body: event.data.text() }));
  event.waitUntil(
    payload.then(data =>
      self.registration.showNotification(data.title || 'Reconciliation Engine', {
        body: data.body || 'New notification',
        icon: './icons/icon-192.png',
        badge: './icons/icon-72.png',
        tag: 'recon-notification',
        renotify: false,
      })
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

console.log('[SW] Service Worker loaded:', SW_VERSION);
