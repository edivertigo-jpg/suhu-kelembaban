// ============================================================
// Service Worker - RSU SHND Suhu Monitor
// ============================================================
const CACHE_NAME = 'suhu-shnd-v1.0.0';
const STATIC_CACHE = 'suhu-shnd-static-v1';
const DATA_CACHE = 'suhu-shnd-data-v1';

// Files to cache for offline use
const STATIC_FILES = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
];

// ============================================================
// INSTALL - cache static files
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      console.log('[SW] Caching static files');
      return cache.addAll(STATIC_FILES.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => console.warn('[SW] Some static files failed to cache:', err));
    }).then(() => self.skipWaiting())
  );
});

// ============================================================
// ACTIVATE - cleanup old caches
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== DATA_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================
// FETCH - network first for API, cache first for static
// ============================================================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and non-http requests
  if (!url.protocol.startsWith('http')) return;

  // Google Apps Script API calls - network first, fallback to cache
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleapis.com')) {
    event.respondWith(networkFirstStrategy(event.request, DATA_CACHE));
    return;
  }

  // Chart.js CDN - cache first
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('cdnjs')) {
    event.respondWith(cacheFirstStrategy(event.request, STATIC_CACHE));
    return;
  }

  // Local files - cache first
  if (url.origin === self.location.origin || event.request.url.startsWith(self.location.origin)) {
    event.respondWith(cacheFirstStrategy(event.request, STATIC_CACHE));
    return;
  }

  // Default: network first
  event.respondWith(networkFirstStrategy(event.request, STATIC_CACHE));
});

// ============================================================
// STRATEGIES
// ============================================================
async function cacheFirstStrategy(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] Cache first fetch failed:', err);
    return new Response('<h1>Offline</h1><p>Koneksi tidak tersedia.</p>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function networkFirstStrategy(request, cacheName) {
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] Network first failed, trying cache:', err);
    const cached = await caches.match(request);
    if (cached) return cached;

    // Return offline placeholder for API calls
    return new Response(JSON.stringify({
      error: 'offline',
      message: 'Tidak ada koneksi internet. Data menampilkan cache terakhir.'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
// BACKGROUND SYNC - queue offline submissions
// ============================================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-suhu-data') {
    console.log('[SW] Background sync: sync-suhu-data');
    event.waitUntil(syncOfflineData());
  }
});

async function syncOfflineData() {
  const db = await openDB();
  const pendingData = await getAllPending(db);

  if (pendingData.length === 0) return;

  // Get GAS URL from IndexedDB config
  const config = await getConfig(db);
  if (!config || !config.gasUrl) {
    console.warn('[SW] No GAS URL configured, skipping sync');
    return;
  }

  for (const item of pendingData) {
    try {
      const resp = await fetch(config.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addData', data: item.data })
      });

      if (resp.ok) {
        await deletePending(db, item.id);
        console.log('[SW] Synced item:', item.id);
        // Notify clients
        const clients = await self.clients.matchAll();
        clients.forEach(c => c.postMessage({ type: 'SYNC_SUCCESS', id: item.id }));
      }
    } catch (err) {
      console.warn('[SW] Sync failed for item:', item.id, err);
    }
  }
}

// ============================================================
// SIMPLE INDEXEDDB HELPERS
// ============================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('suhu-shnd-db', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function deletePending(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    const req = tx.objectStore('pending').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

function getConfig(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readonly');
    const req = tx.objectStore('config').get('settings');
    req.onsuccess = e => resolve(e.target.result ? e.target.result.value : null);
    req.onerror = e => reject(e.target.error);
  });
}

// ============================================================
// PUSH NOTIFICATIONS (opsional)
// ============================================================
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'Suhu Alert', {
    body: data.body || 'Ada data suhu yang perlu diperhatikan',
    icon: './icons/icon-192.png',
    badge: './icons/icon-72.png',
    tag: 'suhu-alert',
    data: data
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || './')
  );
});

console.log('[SW] Service Worker loaded - RSU SHND v1.0.0');
