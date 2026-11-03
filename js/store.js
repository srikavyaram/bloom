// Bloom · store.js
// Persistence: IndexedDB key/value store, falling back to localStorage (e.g. some
// private modes) and finally to in-memory storage (e.g. Node tests). Importing this
// module has no side effects; the backend is opened lazily on first use.
//
// Classic script (not an ES module) so the app also runs when index.html is
// opened straight from disk. Shares code through the global `Bloom` namespace.

(function () {
'use strict';

const Bloom = (globalThis.Bloom = globalThis.Bloom || {});
const {
  DEFAULT_ACTIVITIES, DEFAULT_SETTINGS, addDays, isDateKey, validateActivity,
} = Bloom.schedule;

const DB_NAME = 'bloom-db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const KEYS = Object.freeze({
  activities: 'activities',
  completions: 'completions',
  settings: 'settings',
  reminders: 'reminders',
  shownReminders: 'shownReminders',
});
const SHOWN_LIMIT = 500;
const LS_PREFIX = 'bloom:';

// Plain-JSON copy: strips proxies/functions so IDB structured clone never throws.
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------
// Backends: { get(key), set(key, value), update(key, fn) }
// ---------------------------------------------------------------------------

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('no indexedDB')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error('indexedDB open timed out')), 4000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('indexedDB open failed')); };
    req.onblocked = () => { /* another tab holds an old version; keep waiting until timeout */ };
  });
}

function idbBackend(db) {
  // If the browser closes the connection (e.g. storage cleared), reopen next time.
  db.onversionchange = () => { db.close(); backendPromise = null; };
  db.onclose = () => { backendPromise = null; };

  const tx = (mode, work) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE_NAME, mode);
    const store = t.objectStore(STORE_NAME);
    let result;
    Promise.resolve(work(store)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });

  return {
    kind: 'indexeddb',
    get: (key) => tx('readonly', (s) => reqToPromise(s.get(key))),
    set: (key, value) => tx('readwrite', (s) => { s.put(clone(value), key); }),
    // Read-modify-write inside a single transaction (atomic w.r.t. the service worker).
    update: (key, fn) => tx('readwrite', (s) => new Promise((resolve, reject) => {
      const r = s.get(key);
      r.onsuccess = () => {
        const next = clone(fn(r.result));
        s.put(next, key);
        resolve(next);
      };
      r.onerror = () => reject(r.error);
    })),
  };
}

function syncBackend(kind, read, write) {
  return {
    kind,
    get: async (key) => read(key),
    set: async (key, value) => { write(key, clone(value)); },
    update: async (key, fn) => { const next = clone(fn(read(key))); write(key, next); return next; },
  };
}

function localStorageBackend() {
  const ls = globalThis.localStorage;
  if (!ls) throw new Error('no localStorage');
  ls.setItem(`${LS_PREFIX}__probe`, '1');
  ls.removeItem(`${LS_PREFIX}__probe`);
  return syncBackend(
    'localstorage',
    (key) => { const raw = ls.getItem(LS_PREFIX + key); return raw == null ? undefined : JSON.parse(raw); },
    (key, value) => ls.setItem(LS_PREFIX + key, JSON.stringify(value)),
  );
}

function memoryBackend() {
  const map = new Map();
  return syncBackend('memory', (key) => clone(map.get(key)), (key, value) => map.set(key, value));
}

let backendPromise = null;

function backend() {
  if (!backendPromise) {
    backendPromise = openIDB().then(idbBackend).catch(() => {
      try { return localStorageBackend(); } catch { return memoryBackend(); }
    });
  }
  return backendPromise;
}

/** Which storage is in use: 'indexeddb' | 'localstorage' | 'memory'. */
async function storageKind() {
  return (await backend()).kind;
}

async function get(key) { return (await backend()).get(key); }
async function set(key, value) { return (await backend()).set(key, value); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function normaliseActivities(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => validateActivity(a).value).filter(Boolean);
}

function normaliseSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  out.notifications = Boolean(out.notifications);
  out.name = typeof out.name === 'string' ? out.name : '';
  out.planTime = /^\d{2}:\d{2}$/.test(out.planTime) ? out.planTime : DEFAULT_SETTINGS.planTime;
  out.seeded = Boolean(out.seeded);
  return out;
}

function normaliseCompletions(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  const out = {};
  for (const [key, day] of Object.entries(c)) {
    if (!isDateKey(key) || !day || typeof day !== 'object') continue;
    const ids = Object.keys(day).filter((id) => day[id] === true);
    if (ids.length) out[key] = Object.fromEntries(ids.map((id) => [id, true]));
  }
  return out;
}

/**
 * Load everything the UI needs. On first run (settings.seeded falsy) the default
 * routine from the user's brief is written, stamped with the current time.
 */
async function loadState() {
  const [rawActivities, rawCompletions, rawSettings] = await Promise.all([
    get(KEYS.activities), get(KEYS.completions), get(KEYS.settings),
  ]);
  let settings = normaliseSettings(rawSettings);
  let activities = normaliseActivities(rawActivities);

  if (!settings.seeded) {
    if (!Array.isArray(rawActivities) || rawActivities.length === 0) {
      const now = Date.now();
      activities = DEFAULT_ACTIVITIES.map((a) => ({ ...clone(a), createdAt: now }));
      await set(KEYS.activities, activities);
    }
    settings = { ...settings, seeded: true };
    await set(KEYS.settings, settings);
  }
  return { activities, completions: normaliseCompletions(rawCompletions), settings };
}

async function saveActivities(list) { await set(KEYS.activities, Array.isArray(list) ? list : []); }
async function saveCompletions(obj) { await set(KEYS.completions, obj && typeof obj === 'object' ? obj : {}); }
async function saveSettings(obj) { await set(KEYS.settings, normaliseSettings(obj)); }

async function saveReminders(list) { await set(KEYS.reminders, Array.isArray(list) ? list : []); }
async function getReminders() { const r = await get(KEYS.reminders); return Array.isArray(r) ? r : []; }

async function getShownReminders() { const r = await get(KEYS.shownReminders); return Array.isArray(r) ? r : []; }

/** Remember that a reminder was shown (keeps the 500 most recent ids). */
async function markReminderShown(id) {
  await (await backend()).update(KEYS.shownReminders, (cur) => {
    const list = (Array.isArray(cur) ? cur : []).filter((x) => x !== id);
    list.push(id);
    return list.slice(-SHOWN_LIMIT);
  });
}

/** JSON-serialisable backup of user data. */
async function exportBackup() {
  const [activities, completions, settings] = await Promise.all([
    get(KEYS.activities), get(KEYS.completions), get(KEYS.settings),
  ]);
  return {
    version: 1,
    app: 'bloom',
    exportedAt: new Date().toISOString(),
    activities: normaliseActivities(activities),
    completions: normaliseCompletions(completions),
    settings: normaliseSettings(settings),
  };
}

/**
 * Replace stored data with a backup (object or JSON string). Throws an Error with a
 * friendly message if the backup is not recognisable. Returns the imported state.
 * The `notifications` flag is kept from the current device (permission is per device).
 */
async function importBackup(obj) {
  let data = obj;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error('That file isn’t a valid Bloom backup.'); }
  }
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.activities)) {
    throw new Error('That file isn’t a valid Bloom backup.');
  }
  const current = normaliseSettings(await get(KEYS.settings));
  const activities = normaliseActivities(data.activities);
  const completions = normaliseCompletions(data.completions);
  const settings = normaliseSettings({ ...data.settings, notifications: current.notifications, seeded: true });
  await set(KEYS.activities, activities);
  await set(KEYS.completions, completions);
  await set(KEYS.settings, settings);
  return { activities, completions, settings };
}

/** Drop completion days older than keepDays before todayKey (sync, pure). */
function pruneCompletions(obj, todayKey, keepDays = 400) {
  const cutoff = addDays(todayKey, -keepDays);
  const out = {};
  for (const [key, day] of Object.entries(obj || {})) {
    if (isDateKey(key) && key >= cutoff) out[key] = day;
  }
  return out;
}

Bloom.store = {
  DB_NAME, DB_VERSION, STORE_NAME, KEYS, storageKind, loadState,
  saveActivities, saveCompletions, saveSettings, saveReminders, getReminders,
  getShownReminders, markReminderShown, exportBackup, importBackup,
  pruneCompletions,
};
})();
