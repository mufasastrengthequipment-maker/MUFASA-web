// ══════════════════════════════════════════════════════════════
//  MUFASA STRENGTH — Service Worker
//  Strategy:
//    • Shell + static assets  → Cache First (instant load)
//    • Firebase / API calls   → Network First (fresh data)
//    • Images                 → Stale While Revalidate
//    • Offline fallback page  → served from cache when network fails
// ══════════════════════════════════════════════════════════════

const CACHE_NAME     = 'mufasa-v3';
const IMG_CACHE      = 'mufasa-images-v3';
const DYNAMIC_CACHE  = 'mufasa-dynamic-v3';

// ── Assets to pre-cache on install ──────────────────────────
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/mufasa-register.html',
  '/manifest.json',
  '/mufasa-header-logo.png',
  // Hero & product images
  '/hero-bg.png',
  '/b580ce7684acdf3f50585a63262be7b6.jpg',
  '/FB_IMG_17764489238779449.jpg',
  '/343490bc1f30e07fafa24787db7cc40e.jpg',
  // Accessory images
  '/acc-bands.jpg',
  '/acc-rope.jpg',
  '/acc-gloves.jpg',
  '/acc-mat.jpg',
  '/acc-pullup.jpg',
  '/acc-bench.jpg',
  '/acc-rack.jpg',
  '/acc-bag.jpg',
  '/acc-roller.jpg',
  '/acc-ankle.jpg',
  // Google Fonts (cached dynamically on first visit — see fetch handler)
];

// ── URLs that must always go to network ─────────────────────
const NETWORK_ONLY = [
  'firebaseio.com',
  'firebasedatabase.app',
  'googleapis.com/identitytoolkit',
  'wa.me',
  'api.whatsapp.com',
];

// ── URLs for stale-while-revalidate (images) ────────────────
const SWR_ORIGINS = [
  'img.youtube.com',
  'i.ytimg.com',
  'firebasestorage.googleapis.com',
];


// ══════════════════════════════════════════════════════════════
//  INSTALL — pre-cache shell assets
// ══════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .catch(err => {
        // Some assets may not exist yet (e.g. hero-bg.png not uploaded) — log but don't block install
        console.warn('[SW] Install: some assets missing —', err.message);
      })
      .then(() => self.skipWaiting())
  );
});


// ══════════════════════════════════════════════════════════════
//  ACTIVATE — delete old caches
// ══════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  const VALID_CACHES = [CACHE_NAME, IMG_CACHE, DYNAMIC_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !VALID_CACHES.includes(k))
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});


// ══════════════════════════════════════════════════════════════
//  FETCH — routing logic
// ══════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Skip non-GET and chrome-extension requests ──
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // ── Network-only (Firebase real-time, WhatsApp, auth) ──
  if (NETWORK_ONLY.some(host => url.hostname.includes(host))) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Stale-While-Revalidate for YouTube thumbnails & CDN images ──
  if (SWR_ORIGINS.some(host => url.hostname.includes(host))) {
    event.respondWith(staleWhileRevalidate(request, IMG_CACHE));
    return;
  }

  // ── Google Fonts — cache first, fall back to network ──
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request, DYNAMIC_CACHE));
    return;
  }

  // ── Firebase JS SDK and other CDN scripts — cache first ──
  if (url.hostname.includes('gstatic.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirst(request, DYNAMIC_CACHE));
    return;
  }

  // ── HTML pages — Network first, fall back to cache ──
  if (request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(networkFirst(request, CACHE_NAME));
    return;
  }

  // ── Everything else (JS, CSS, local images) — Cache first ──
  event.respondWith(cacheFirst(request, CACHE_NAME));
});


// ══════════════════════════════════════════════════════════════
//  STRATEGIES
// ══════════════════════════════════════════════════════════════

/**
 * Cache First — return from cache; if missing, fetch and cache it.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Network First — try network; on failure serve from cache.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineFallback(request);
  }
}

/**
 * Stale While Revalidate — serve cache immediately, update in background.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || networkPromise || offlineFallback(request);
}

/**
 * Offline fallback — return cached index.html for navigation,
 * or a minimal JSON/image placeholder for other asset types.
 */
async function offlineFallback(request) {
  const accept = request.headers.get('Accept') || '';

  // HTML pages → cached index
  if (accept.includes('text/html')) {
    const cache = await caches.open(CACHE_NAME);
    const fallback = await cache.match('/index.html') || await cache.match('/');
    if (fallback) return fallback;
  }

  // Images → transparent 1×1 GIF placeholder
  if (accept.includes('image')) {
    return new Response(
      atob('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='),
      { headers: { 'Content-Type': 'image/gif' } }
    );
  }

  // Anything else → minimal offline response
  return new Response(
    JSON.stringify({ offline: true, message: 'No connection. Please try again.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}


// ══════════════════════════════════════════════════════════════
//  BACKGROUND SYNC (queued WhatsApp orders & session logs)
//  Falls back gracefully if Background Sync API is unsupported.
// ══════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'sync-progress') {
    event.waitUntil(syncPendingProgress());
  }
});

async function syncPendingProgress() {
  // Reads queued entries from IndexedDB and retries Firebase writes.
  // Implementation is a no-op placeholder — the main app handles
  // Firebase writes directly; this hook is here for future use.
  console.log('[SW] Background sync: sync-progress triggered');
}


// ══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (placeholder — enable in Firebase Console)
// ══════════════════════════════════════════════════════════════
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'MUFASA', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(data.title || '🦁 MUFASA STRENGTH', {
      body:    data.body  || 'You have a new update.',
      icon:    '/mufasa-header-logo.png',
      badge:   '/mufasa-header-logo.png',
      tag:     data.tag   || 'mufasa-notification',
      data:    { url: data.url || '/' },
      actions: data.actions || [],
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      return clients.openWindow(target);
    })
  );
});
