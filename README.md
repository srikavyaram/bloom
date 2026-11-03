# Bloom · Daily Planner

Something that remembers, what you need to remember.

Bloom is a small, cheerful daily planner. Set up your routine once and Bloom
reminds you when each activity is about to start. Every evening it also asks
whether you want to add anything new for tomorrow. It's an offline-first
**Progressive Web App**, so you can install it on your phone like a native app.
It has no accounts, no servers and no tracking. Your data stays on your device.

## Features

- **Today view**: a "Next up" card with a countdown, a timeline of the day,
  big check-boxes, a progress ring and a 🔥 streak. There's a small
  celebration when you tick things off.
- **Tomorrow view**: a preview of tomorrow's schedule, with new one-off items
  marked **New ✨**, and a quick "Add something for tomorrow" form.
- **Nightly planning nudge**: at your chosen time (default 8:00 PM) Bloom
  reminds you to look at tomorrow and add anything new.
- **Routine view**: your recurring activities, settings, calendar export,
  backup and restore, and install.
- **Flexible repeats**: once, every day, weekdays (Mon–Fri) or chosen days
  of the week. You can also skip a single occurrence.
- **Reminders**: in-app toasts and system notifications a few minutes before
  each activity (you choose how early).
- **Works offline** after the first visit, with light and dark mode.

The first time it runs, Bloom is seeded with this routine:

| Activity                | When                      |
| ----------------------- | ------------------------- |
| ☕ Scrum                | 10:00 AM, Monday–Friday   |
| 📊 Accounting           | 11:00 AM, every Wednesday |
| 🎹 Music online session | 10:30 AM, every Friday    |
| 🎶 Music class (evening)| 5:30 PM, every day        |

You can edit or delete any of them.

## Run it locally

Bloom has **no dependencies and no build step**. You need Node.js 18 or newer
for the dev server and the tests.

```bash
npm start            # serves the app at http://localhost:5173/
PORT=8080 npm start  # use another port
```

Quick look without Node: double-click `index.html`. Planning, ticking off and
saving all work, but browsers block offline mode, installing and reminders on
`file://` pages. Those need `localhost` or HTTPS (`npm start`, or deploy it).

Other scripts:

```bash
npm test             # run unit tests (node --test "tests/*.test.mjs")
npm run icons        # regenerate icons/*.png from scripts/gen-icons.mjs
```

## Install on your phone

**Android (Chrome, Edge, Samsung Internet)**
1. Open the app URL.
2. Tap **Install** in Bloom's Routine tab, or use the browser menu and choose
   **Install app** / **Add to Home screen**.
3. Open Bloom from your home screen and tap **Enable reminders**.

**iPhone / iPad (Safari, iOS 16.4+)**
1. Open the app URL in **Safari**.
2. Tap **Share** and then **Add to Home Screen**.
3. Open Bloom **from the home-screen icon** and tap **Enable reminders**.
   iOS only allows web notifications for apps added to the home screen.

**Desktop (Chrome / Edge)**: click the install icon in the address bar.

## How reminders work (and their limits)

A web app can't schedule an alarm on its own without a push server, and Bloom
deliberately has no server. So it uses three layers, from most convenient to
most reliable:

1. **While Bloom is open** (in a tab or as an installed app, including in the
   background), it checks every 20 seconds. Each due reminder shows an in-app
   toast and, if you allowed notifications, a system notification. A reminder
   can arrive up to 15 minutes late (for example, after the phone wakes up).
   It is never shown twice.
2. **Periodic background sync** (best effort, Chromium-based browsers, installed
   app only). The browser may wake Bloom's service worker every so often and
   show reminders that are due. The browser decides how often this happens,
   based on how much you use the app, so you can't count on it.
3. **Add to phone calendar (.ics)**: in the Routine tab, download a calendar
   file containing your routine, with alerts. Import it into Google Calendar,
   Apple Calendar or Outlook. Your phone's calendar then sends reminders
   **even when Bloom and the browser are closed**. This is the only fully
   reliable option. Download it again after you change your routine.

The nightly "plan tomorrow" reminder goes through the same in-app and
notification path. When you open Bloom after your planning time, a banner on
the Today view also invites you to plan tomorrow.

## Deploy to GitHub Pages

All URLs in the app are relative, so it works from a sub-path such as
`https://<user>.github.io/todo-list/`.

1. Push the repository to GitHub.
2. Go to **Settings → Pages**. Under **Build and deployment**, choose
   **Deploy from a branch**, then `main` and `/ (root)`.
3. Wait a minute and open `https://<user>.github.io/<repo>/`.

**When you ship a change**, bump `VERSION` at the top of `sw.js` (for example
`'v1'` → `'v2'`). The service worker serves the app cache-first, so devices
only download new files after `sw.js` changes. Open copies of the app then show
an **"Update available — Refresh"** toast. If you add a new file the app needs,
also add it to the `PRECACHE` list in `sw.js`.

## Project layout

```
index.html, styles.css    app shell and styles
js/app.js                 UI and app wiring
js/schedule.js            pure scheduling logic (occurrences, reminders, streaks…)
js/store.js               persistence (IndexedDB, falls back to localStorage)
js/ics.js                 .ics calendar export
js/notify.js              service-worker registration, notifications, reminder loop
sw.js                     service worker (offline cache, periodic sync, notification clicks)
manifest.webmanifest      PWA manifest
icons/                    app icons (PNG generated by scripts/gen-icons.mjs, plus icon.svg)
scripts/serve.mjs         zero-dependency dev server
tests/                    node:test unit tests
```

## Privacy

Everything is stored locally in your browser (IndexedDB). Use **Export
backup** in the Routine tab to keep a copy or move to another device.
