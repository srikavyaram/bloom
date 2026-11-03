/* Bloom service worker (classic script, not a module).
 *
 * - Precaches the app shell so Bloom works fully offline.
 * - Cache-first for same-origin GETs, with network fallback + runtime caching.
 * - Navigations are served from the cached index.html (query strings such as
 *   ?action=add are ignored when matching).
 * - Shows due reminders on 'periodicsync' (Chromium, installed PWA) by reading
 *   the reminders the page saved into IndexedDB.
 *
 * DEPLOYING A NEW VERSION: bump VERSION below. Browsers only pick up a new
 * service worker when this file's bytes change; the page then shows an
 * "Update available" toast (see js/notify.js).
 */

const VERSION = 'v2';
const CACHE = `bloom-${VERSION}`;

// Every file the app needs to boot offline. Paths are relative to this
// script, so the app works from a sub-path such as /todo-list/.
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/schedule.js',
  'js/store.js',
  'js/notify.js',
  'js/ics.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/badge-96.png',
];

const INDEX_URL = new URL('index.html', self.registration.scope).href;

// ------------------------------------------------------------- lifecycle

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' bypasses the HTTP cache so we never precache stale files.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  // No skipWaiting() here: an update waits until the page asks for it
  // (message SKIP_WAITING), so a running session never mixes versions.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('bloom-') && k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ----------------------------------------------------------------- fetch

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let the browser handle it

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function handleNavigation(req) {
  const cache = await caches.open(CACHE);
  const cached =
    (await cache.match(req, { ignoreSearch: true })) ||
    (await cache.match(INDEX_URL)) ||
    (await cache.match(new URL('./', self.registration.scope).href));
  if (cached) return cached;
  try {
    return await fetch(req);
  } catch (err) {
    return new Response('<h1>Bloom is offline</h1><p>Please reconnect once to finish installing.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    // Runtime-cache successful same-origin responses (not partial/opaque ones).
    if (res.ok && res.type === 'basic' && res.status === 200) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// ---------------------------------------------------------- notifications

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const scope = self.registration.scope;
      const client = all.find((c) => c.url.startsWith(scope));
      if (client) {
        client.postMessage({ type: 'bloom:notification-click', id: data.id || null });
        return client.focus();
      }
      return self.clients.openWindow(target);
    })()
  );
});

// --------------------------------------------------------- periodic sync

const DB_NAME = 'bloom-db';
const STORE = 'kv';
const SHOWN_LIMIT = 500;
const LATE_WINDOW_MS = 60 * 60 * 1000; // show reminders up to 60 min late

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'bloom-reminders') event.waitUntil(showDueReminders());
});

/** Open the existing app DB. Never creates it (that's js/store.js's job). */
function openDB() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME);
    } catch (e) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      // DB doesn't exist yet: abort so we don't create an empty v1 DB
      // without the 'kv' store (which would block store.js's upgrade).
      req.transaction.abort();
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        resolve(null);
      } else resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Values are stored as structured clones; tolerate JSON strings too.
const asArray = (v) => {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { return []; }
  }
  return Array.isArray(v) ? v : [];
};

async function showDueReminders() {
  if (self.Notification && Notification.permission !== 'granted') return;
  const db = await openDB();
  if (!db) return;
  try {
    const reminders = asArray(await idbGet(db, 'reminders'));
    const shown = asArray(await idbGet(db, 'shownReminders'));
    const shownSet = new Set(shown);
    const now = Date.now();
    const due = reminders.filter(
      (r) => r && r.id && r.fireAt <= now && r.fireAt > now - LATE_WINDOW_MS && !shownSet.has(r.id)
    );
    for (const r of due) {
      await self.registration.showNotification(r.title, {
        body: r.body || '',
        tag: r.id,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-96.png',
        data: { url: './', id: r.id },
      });
      shown.push(r.id);
    }
    if (due.length) await idbPut(db, 'shownReminders', shown.slice(-SHOWN_LIMIT));
  } catch (e) {
    // Best effort only.
  } finally {
    db.close();
  }
}
