// Browser notification + service worker helpers for Bloom.
//
// Reminders on the web without a push server are best effort:
//   1. While the app (or its tab) is alive, startReminderLoop() checks every
//      20 s and shows an OS notification + an in-app toast.
//   2. On Chromium installed PWAs, periodic background sync lets sw.js wake up
//      occasionally (browser decides how often) and show due reminders.
//   3. For fully reliable reminders the UI offers an .ics calendar export.
//
// Classic script (not an ES module) so the app also runs when index.html is
// opened straight from disk. Shares code through the global `Bloom` namespace.

(function () {
'use strict';

const Bloom = (globalThis.Bloom = globalThis.Bloom || {});
const {
  getShownReminders, markReminderShown,
} = Bloom.store;

const TICK_MS = 20 * 1000;
const LATE_WINDOW_MS = 15 * 60 * 1000; // a reminder may fire up to 15 min late
const ICON = 'icons/icon-192.png';
const BADGE = 'icons/badge-96.png';

let registration = null;
let reloading = false;

// Service workers need http(s) or localhost; opened from disk (file://) the app
// still works, just without offline caching or background reminders.
const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  && typeof location !== 'undefined' && location.protocol !== 'file:';

/**
 * Register ./sw.js. Resolves to the registration, or null if unsupported/failed.
 * Dispatches window event 'bloom:update-ready' (detail: { registration }) when a
 * new version has installed and is waiting.
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
async function registerServiceWorker() {
  if (!swSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    registration = reg;

    const announce = () =>
      window.dispatchEvent(new CustomEvent('bloom:update-ready', { detail: { registration: reg } }));

    // An update may already be waiting from a previous visit.
    if (reg.waiting && navigator.serviceWorker.controller) announce();

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        // With no controller this is the first install, not an update.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announce();
      });
    });

    // Look for new versions when the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
    return reg;
  } catch (err) {
    console.warn('[bloom] service worker registration failed', err);
    return null;
  }
}

/** Activate the waiting service worker and reload once it takes control. */
function applyUpdate() {
  if (!swSupported()) {
    location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const go = (reg) => {
    if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  };
  if (registration) go(registration);
  else navigator.serviceWorker.getRegistration().then(go, () => location.reload());
}

/** @returns {boolean} */
function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** @returns {'granted'|'denied'|'default'|'unsupported'} */
function permissionState() {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/**
 * Ask for notification permission (call from a user gesture).
 * @returns {Promise<string>} 'granted' | 'denied' | 'default' | 'unsupported'
 */
async function requestPermission() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    // Older Safari only supports the callback form.
    const result = await new Promise((resolve) => {
      const maybe = Notification.requestPermission(resolve);
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve(Notification.permission));
    });
    return result || Notification.permission;
  } catch (err) {
    return Notification.permission;
  }
}

async function getRegistration() {
  if (registration) return registration;
  if (!swSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) || null;
  } catch (err) {
    return null;
  }
}

/** Show an OS notification for a reminder (only if permission is granted). */
async function showOsNotification(reminder) {
  if (permissionState() !== 'granted') return false;
  const options = {
    body: reminder.body || '',
    tag: reminder.id,
    icon: ICON,
    badge: BADGE,
    data: { url: './', id: reminder.id },
  };
  try {
    const reg = await getRegistration();
    if (reg && reg.showNotification) {
      await reg.showNotification(reminder.title, options);
      return true;
    }
    // No service worker (e.g. http on a LAN IP): fall back to a page notification.
    const n = new Notification(reminder.title, options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch (err) {
    console.warn('[bloom] could not show notification', err);
    return false;
  }
}

/**
 * Start checking for due reminders. Fires each reminder whose
 * fireAt is in (now - 15 min, now] and that hasn't been shown before.
 *
 * @param {() => Reminder[] | Promise<Reminder[]>} getReminders
 * @param {{ onFire?: (reminder: Reminder) => void }} [opts]
 * @returns {() => void} stop function
 */
function startReminderLoop(getReminders, { onFire } = {}) {
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const now = Date.now();
      const list = (await getReminders()) || [];
      const due = list.filter((r) => r && r.id && r.fireAt <= now && r.fireAt > now - LATE_WINDOW_MS);
      if (!due.length) return;
      const shown = new Set((await getShownReminders()) || []);
      for (const r of due) {
        if (shown.has(r.id)) continue;
        // Mark first so a concurrent tab/tick doesn't double-fire.
        await markReminderShown(r.id);
        shown.add(r.id);
        await showOsNotification(r);
        try {
          if (onFire) onFire(r);
        } catch (err) {
          console.warn('[bloom] onFire handler failed', err);
        }
      }
    } catch (err) {
      console.warn('[bloom] reminder check failed', err);
    } finally {
      running = false;
    }
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  const timer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', tick);
  tick();

  return function stop() {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', tick);
  };
}

/**
 * Best-effort periodic background sync (Chromium, installed PWA only).
 * @returns {Promise<boolean>} true if registered
 */
async function registerPeriodicSync() {
  try {
    if (!swSupported()) return false;
    // periodicSync needs an *active* worker, so wait for ready (with a timeout).
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!reg || !('periodicSync' in reg)) return false;
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state !== 'granted') return false;
    }
    await reg.periodicSync.register('bloom-reminders', { minInterval: 15 * 60 * 1000 });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * @typedef {{ id: string, activityId: string|null, dateKey: string, kind: 'activity'|'plan',
 *   title: string, body: string, fireAt: number, startAt: number|null }} Reminder
 */

Bloom.notify = {
  registerServiceWorker, applyUpdate, notificationsSupported, permissionState,
  requestPermission, startReminderLoop, registerPeriodicSync,
};
})();
