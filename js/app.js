// Bloom · app.js
// UI controller: renders the Today / Tomorrow / Routine views, the add/edit sheet,
// toasts and celebrations. All scheduling logic lives in schedule.js, persistence in
// store.js, notifications + service worker in notify.js, calendar export in ics.js.
//
// Classic script (not an ES module) so the app also runs when index.html is
// opened straight from disk. Shares code through the global `Bloom` namespace.

(function () {
'use strict';

const Bloom = (globalThis.Bloom = globalThis.Bloom || {});
const {
  COLORS, DEFAULT_EMOJI, DEFAULT_REMIND_BEFORE, DEFAULT_ACTIVITIES,
  DEFAULT_SETTINGS, toDateKey, fromDateKey, addDays, weekdayOf, dayNumber,
  parseTime, formatTime, formatDateShort, occursOn, occurrenceStart,
  activitiesForDate, nextUp, upcomingReminders, tomorrowSummary, describeRepeat,
  validateActivity, streak, greeting, encouragement,
} = Bloom.schedule;
const {
  loadState, saveActivities, saveCompletions, saveSettings, saveReminders,
  exportBackup, importBackup, pruneCompletions,
} = Bloom.store;
const {
  buildICS,
} = Bloom.ics;
const {
  registerServiceWorker, applyUpdate, notificationsSupported, permissionState,
  requestPermission, startReminderLoop, registerPeriodicSync,
} = Bloom.notify;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMOJIS = ['✨', '☕', '📊', '🎹', '🎶', '💪', '📚', '🧘', '🛒', '💼', '📞', '🌱'];
const REMIND_OPTIONS = [[0, 'At start time'], [5, '5 min before'], [10, '10 min before'],
  [15, '15 min before'], [30, '30 min before'], [60, '1 hour before']];
const DURATION_OPTIONS = [['', 'Not set'], [15, '15 min'], [30, '30 min'], [45, '45 min'],
  [60, '1 hour'], [90, '1½ hours'], [120, '2 hours']];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
const CHEERS = ['Nice one! 🌸', 'Done & dusted ✨', 'Look at you go! 💪', 'One more step forward 🌱',
  'Ticked off! 💛', 'Lovely work 🌼', 'You’re on a roll! 🎶', 'Proud of you ⭐'];
const BURST_EMOJI = ['🌸', '✨', '💛', '🌼', '⭐', '💖'];
const CONFETTI_COLORS = ['#FFB347', '#FF7EA4', '#6DB7FF', '#4FD8AE', '#B79BFF', '#FF9C6E', '#FFD966'];
const REMINDER_REFRESH_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// State + small helpers
// ---------------------------------------------------------------------------

const state = {
  activities: [],
  completions: {},
  settings: { ...DEFAULT_SETTINGS },
  reminders: [],
  remindersAt: 0,
  todayKey: toDateKey(new Date()),
  view: 'today',
  planFiredFor: null, // dateKey on which the nightly plan reminder fired
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

/** Per-device UI conveniences only (never data). Storage may be unavailable. */
const uiPref = {
  get(k) { try { return localStorage.getItem(`bloom-ui:${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`bloom-ui:${k}`, v); } catch { /* ignore */ } },
};

const isDone = (key, id) => Boolean(state.completions[key] && state.completions[key][id]);
const tomorrowKey = () => addDays(state.todayKey, 1);
const findActivity = (id) => state.activities.find((a) => a.id === id);

function fmtDuration(min) {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "in 25 min" / "in 2 h 5 min" / "now". */
function relTime(start, now) {
  const mins = Math.ceil((start.getTime() - now.getTime()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

function dayLabel(key) {
  if (key === state.todayKey) return 'Today';
  if (key === tomorrowKey()) return 'Tomorrow';
  return formatDateShort(key);
}

function longDate(key) {
  return fromDateKey(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function minutesOfDay(date) { return date.getHours() * 60 + date.getMinutes(); }

function greetingEmoji(now) {
  const h = now.getHours();
  if (h < 5) return '✨';
  if (h < 12) return '☀️';
  if (h < 17) return '🌤️';
  return '🌙';
}

// ---------------------------------------------------------------------------
// Persistence pipeline: mutate state -> render -> persist -> reminders
// ---------------------------------------------------------------------------

let saveWarned = false;

async function persist(parts) {
  try {
    const jobs = [];
    if (parts.activities) jobs.push(saveActivities(state.activities));
    if (parts.completions) {
      state.completions = pruneCompletions(state.completions, state.todayKey);
      jobs.push(saveCompletions(state.completions));
    }
    if (parts.settings) jobs.push(saveSettings(state.settings));
    await Promise.all(jobs);
  } catch (err) {
    console.error('[bloom] save failed', err);
    if (!saveWarned) {
      saveWarned = true;
      toast('Couldn’t save to this device just now. Your changes are kept while Bloom is open.');
    }
  }
  await refreshReminders();
}

/** Apply a data change: re-render immediately, then save + reschedule reminders. */
function commit(parts) {
  render();
  return persist(parts);
}

async function refreshReminders() {
  const now = new Date();
  // Don't nag about things already ticked off.
  state.reminders = upcomingReminders(state.activities, state.settings, now)
    .filter((r) => !(r.kind === 'activity' && isDone(r.dateKey, r.activityId)));
  state.remindersAt = now.getTime();
  try { await saveReminders(state.reminders); } catch (err) { console.warn('[bloom] could not save reminders', err); }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Keep keyboard focus stable across re-renders (lists are rebuilt as HTML).
  const fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
  const now = new Date();
  renderHero(now);
  renderToday(now);
  renderTomorrow();
  renderRoutine();
  renderSettingsStatus();
  if (fk) {
    const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

function renderHero(now) {
  const key = state.todayKey;
  $('#greeting').textContent = greeting(now, state.settings.name);
  $('#greeting-emoji').textContent = greetingEmoji(now);
  $('#today-date').textContent = longDate(key);
  $('#affirmation').textContent = encouragement(dayNumber(key));

  const items = activitiesForDate(state.activities, key);
  const total = items.length;
  const done = items.filter((a) => isDone(key, a.id)).length;
  const ratio = total ? done / total : 0;
  const C = 2 * Math.PI * 26;
  $('#ring-fill').style.strokeDashoffset = String(C * (1 - ratio));
  $('#ring-text').textContent = total ? `${done}/${total}` : '☀️';
  $('#ring').setAttribute('aria-label', total ? `${done} of ${total} done today` : 'Nothing scheduled today');

  let main;
  let sub;
  if (!total) { main = 'A free day'; sub = 'Enjoy the space ☀️'; }
  else if (done === total) { main = `All ${total} done!`; sub = 'You did it. Time to bloom 🌸'; }
  else {
    main = `${done} of ${total} done`;
    if (done === 0) sub = 'Let’s begin, one step at a time 🌱';
    else if (ratio < 0.5) sub = 'Nice start — keep it gentle';
    else sub = 'Over halfway — keep going!';
  }
  $('#progress-main').textContent = main;
  $('#progress-sub').textContent = sub;

  const s = streak(state.completions, state.activities, key);
  $('#streak-chip').textContent = s > 0 ? `🔥 ${s}-day streak` : '🌱 Start a streak';
}

function planBannerVisible(now) {
  const key = state.todayKey;
  if (uiPref.get('planDismissed') === key) return false;
  if (state.planFiredFor === key) return true;
  const t = parseTime(state.settings.planTime) || parseTime(DEFAULT_SETTINGS.planTime);
  return minutesOfDay(now) >= t.h * 60 + t.m;
}

function renderToday(now) {
  const key = state.todayKey;

  // Plan-tomorrow banner (evening, or when the plan reminder fires)
  const showPlan = planBannerVisible(now);
  $('#plan-banner').hidden = !showPlan;
  $('#tomorrow-dot').hidden = !showPlan;
  if (showPlan) {
    const n = tomorrowSummary(state.activities, key).items.length;
    $('#plan-banner-text').textContent = n
      ? `Planning tomorrow? You have ${n} ${n === 1 ? 'thing' : 'things'} lined up — anything new to add?`
      : 'Planning tomorrow? It’s wide open so far — anything new to add?';
  }

  // Next-up hero card
  const items = activitiesForDate(state.activities, key);
  $('#next-card').innerHTML = nextCardHTML(now, items);

  // Timeline + anytime
  const timed = items.filter((a) => a.time);
  const anytime = items.filter((a) => !a.time);
  $('#today-list').innerHTML = timed.map((a) => itemHTML(a, key, { now, checkable: true })).join('');
  $('#anytime-list').innerHTML = anytime.map((a) => itemHTML(a, key, { now, checkable: true })).join('');
  $('#anytime-wrap').hidden = anytime.length === 0;
  $('#today-empty').innerHTML = timed.length ? '' : emptyHTML(
    anytime.length ? '🌤️' : '🌼',
    anytime.length ? 'No fixed times today' : 'A calm, open day',
    anytime.length ? 'Just your anytime tasks below — go at your own pace.' : 'Nothing planned. Add something, or simply enjoy it.',
    anytime.length ? '' : '<button type="button" class="btn btn-primary" data-action="add">Add something</button>',
  );
}

function nextCardHTML(now, items) {
  const nu = nextUp(state.activities, state.completions, now);
  const allDone = items.length > 0 && items.every((a) => isDone(state.todayKey, a.id));
  const nextToday = nu && nu.dateKey <= state.todayKey;

  if (!nextToday) {
    // Nothing left with a time today: celebrate or reassure, and hint at what's next.
    const later = nu ? `Next: ${esc(nu.activity.title)} · ${esc(dayLabel(nu.dateKey))}, ${esc(formatTime(nu.activity.time))}` : '';
    const title = allDone ? 'All done for today!' : items.length ? 'No more timed plans today' : 'Nothing on the clock today';
    const emoji = allDone ? '🎉' : '🌸';
    const sub = allDone ? 'Rest, play, or do something kind for yourself.' : (later || 'Enjoy the open space.');
    return `<article class="next-card is-calm c-sun">
      <div class="next-emoji" aria-hidden="true">${emoji}</div>
      <p class="next-label">${allDone ? 'Wonderful' : 'Breathe easy'}</p>
      <h2 class="next-title">${title}</h2>
      <p class="next-when">${allDone && later ? later : sub}</p>
    </article>`;
  }

  if (!nu) return '';
  const a = nu.activity;
  let label;
  let when;
  if (nu.inProgress) {
    label = 'Happening now';
    const endsAt = a.durationMin ? ` · until ${formatTime(hhmm(nu.end))}` : '';
    when = `Started ${formatTime(a.time)}${endsAt}`;
  } else {
    label = 'Next up';
    when = `${nu.dateKey === state.todayKey ? '' : `${dayLabel(nu.dateKey)} · `}${formatTime(a.time)}`;
  }
  const countdown = nu.inProgress ? 'now' : relTime(nu.start, now);
  const canTick = nu.dateKey <= state.todayKey;
  return `<article class="next-card c-${esc(a.color)}" aria-label="${esc(label)}: ${esc(a.title)}">
    <div class="next-emoji" aria-hidden="true">${esc(a.emoji || DEFAULT_EMOJI)}</div>
    <p class="next-label${nu.inProgress ? ' is-now' : ''}">${label}</p>
    <h2 class="next-title">${esc(a.title)}</h2>
    <p class="next-when">${esc(when)} <span class="next-count">${esc(countdown)}</span></p>
    ${canTick ? `<div class="next-actions">
      <button type="button" class="btn btn-primary btn-small" data-action="toggle" data-id="${esc(a.id)}" data-date="${esc(nu.dateKey)}" data-fk="next-done">✓ Mark done</button>
      <button type="button" class="btn btn-ghost btn-small" data-action="edit" data-id="${esc(a.id)}" data-date="${esc(nu.dateKey)}">Details</button>
    </div>` : ''}
  </article>`;
}

/**
 * One timeline row. opts: { now, checkable, showNew }.
 * Non-checkable rows (tomorrow preview) show a coloured dot instead of a checkbox.
 */
function itemHTML(a, key, { now = new Date(), checkable = true, showNew = false } = {}) {
  const done = isDone(key, a.id);
  const start = occurrenceStart(a, key);
  let status = '';
  let pill = '';
  if (checkable && key === state.todayKey && start && !done) {
    const end = new Date(start.getTime() + (a.durationMin || 0) * 60000);
    if (start <= now && now < end) { status = 'is-now'; pill = '<span class="pill pill-now">Now</span>'; }
    else if ((a.durationMin ? end : start) <= now) { status = 'is-past'; pill = '<span class="pill">Earlier</span>'; }
  }
  if (done) status = 'is-done';
  if (showNew) pill = '<span class="pill pill-new">New ✨</span>';

  const [tMain, tSuffix] = a.time ? formatTime(a.time).split(' ') : ['', ''];
  const timeCol = a.time ? `<div class="item-time" aria-hidden="true">${esc(tMain)}<small>${esc(tSuffix)}</small></div>` : '';
  const repeatText = a.repeat.type === 'once' ? 'One-time' : describeRepeat(a.repeat);
  const meta = [repeatText, fmtDuration(a.durationMin)].filter(Boolean).join(' · ');
  const when = a.time ? formatTime(a.time) : 'anytime';
  const id = esc(a.id);

  const control = checkable
    ? `<button type="button" class="check" role="checkbox" aria-checked="${done}" data-action="toggle"
         data-id="${id}" data-date="${esc(key)}" data-fk="chk-${id}" aria-label="${esc(a.title)}, ${esc(when)}">
         <span class="check-box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
       </button>`
    : '<span class="check-dot" aria-hidden="true"></span>';

  return `<li class="item c-${esc(a.color)} ${status}">
    ${timeCol}
    <div class="item-card">
      ${control}
      <button type="button" class="item-main" data-action="edit" data-id="${id}" data-date="${esc(key)}" data-fk="edit-${id}"
        aria-label="Edit ${esc(a.title)}, ${esc(when)}, ${esc(meta)}">
        <span class="item-emoji" aria-hidden="true">${esc(a.emoji || DEFAULT_EMOJI)}</span>
        <span class="item-text"><span class="item-title">${esc(a.title)}</span><span class="item-meta">${esc(meta)}</span></span>
      </button>
      ${pill}
    </div>
  </li>`;
}

function emptyHTML(emoji, title, text, extra = '') {
  return `<div class="empty"><span class="empty-emoji" aria-hidden="true">${emoji}</span>
    <p class="empty-title">${esc(title)}</p><p class="empty-text">${esc(text)}</p>${extra}</div>`;
}

function renderTomorrow() {
  const sum = tomorrowSummary(state.activities, state.todayKey);
  $('#tomorrow-date').textContent = longDate(sum.dateKey);
  const oneOffIds = new Set(sum.oneOffs.map((a) => a.id));
  $('#tomorrow-list').innerHTML = sum.items
    .map((a) => itemHTML(a, sum.dateKey, { checkable: false, showNew: oneOffIds.has(a.id) }))
    .join('');
  const parts = [];
  if (sum.routine.length) parts.push(`${sum.routine.length} from your routine`);
  if (sum.oneOffs.length) parts.push(`${sum.oneOffs.length} new`);
  $('#tomorrow-summary').textContent = sum.items.length
    ? `${sum.items.length} ${sum.items.length === 1 ? 'thing' : 'things'} lined up · ${parts.join(', ')}`
    : '';
  $('#tomorrow-empty').innerHTML = sum.items.length ? '' : emptyHTML(
    '🌤️', 'Tomorrow is a blank page', 'Add anything new above — Bloom will remind you when it’s time.',
  );
}

function routineRowHTML(a) {
  const when = a.time ? formatTime(a.time) : 'Anytime';
  const rep = describeRepeat(a.repeat);
  const id = esc(a.id);
  return `<li class="item c-${esc(a.color)}">
    <div class="item-card">
      <button type="button" class="item-main" data-action="edit" data-id="${id}" data-fk="redit-${id}"
        aria-label="Edit ${esc(a.title)}, ${esc(when)}, ${esc(rep)}">
        <span class="item-emoji" aria-hidden="true">${esc(a.emoji || DEFAULT_EMOJI)}</span>
        <span class="item-text"><span class="item-title">${esc(a.title)}</span>
        <span class="item-meta">${esc(when)} · ${esc(rep)}</span></span>
      </button>
      <button type="button" class="icon-btn" data-action="delete" data-id="${id}" aria-label="Delete ${esc(a.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
      </button>
    </div>
  </li>`;
}

function renderRoutine() {
  const byTime = (a, b) => (a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : a.title.localeCompare(b.title);
  const routine = state.activities.filter((a) => a.repeat.type !== 'once').sort(byTime);
  const oneOffs = state.activities
    .filter((a) => a.repeat.type === 'once' && a.repeat.date >= state.todayKey)
    .sort((a, b) => (a.repeat.date < b.repeat.date ? -1 : a.repeat.date > b.repeat.date ? 1 : byTime(a, b)));

  $('#routine-list').innerHTML = routine.length
    ? routine.map(routineRowHTML).join('')
    : `<li>${emptyHTML('🌱', 'No routine yet', 'Add something that repeats — like a daily walk — and it will show up by itself.',
      '<button type="button" class="btn btn-primary" data-action="add" data-repeat="daily">Add a routine</button>')}</li>`;
  $('#oneoff-list').innerHTML = oneOffs.map(routineRowHTML).join('');
  $('#oneoff-wrap').hidden = oneOffs.length === 0;
}

function renderSettingsStatus() {
  const perm = permissionState();
  const btn = $('#notif-btn');
  const status = $('#notif-status');
  btn.hidden = false;
  btn.disabled = false;
  if (perm === 'unsupported') {
    status.textContent = 'This browser can’t show notifications. Use the calendar option below for reminders.';
    btn.hidden = true;
  } else if (perm === 'granted') {
    status.textContent = 'Reminders are on ✓ Bloom nudges you while it’s open (and in the background on some Android phones).';
    btn.textContent = 'Send a test reminder';
  } else if (perm === 'denied') {
    status.textContent = 'Notifications are blocked. You can allow them in your browser’s site settings.';
    btn.hidden = true;
  } else {
    status.textContent = 'Get a gentle nudge before each activity and a nightly “plan tomorrow” reminder.';
    btn.textContent = 'Turn on reminders';
  }
}

function fillSettingsForm() {
  $('#set-name').value = state.settings.name || '';
  $('#set-plantime').value = state.settings.planTime || DEFAULT_SETTINGS.planTime;
}

// ---------------------------------------------------------------------------
// Views / tabs
// ---------------------------------------------------------------------------

function setView(view, { focusTab = false } = {}) {
  if (!['today', 'tomorrow', 'routine'].includes(view)) view = 'today';
  state.view = view;
  document.body.dataset.view = view;
  for (const tab of $$('.tab')) {
    const on = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focusTab) tab.focus();
  }
  for (const v of ['today', 'tomorrow', 'routine']) $(`#view-${v}`).hidden = v !== view;
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---------------------------------------------------------------------------
// Completion toggling + celebration
// ---------------------------------------------------------------------------

function toggleDone(id, key, sourceEl) {
  const rect = sourceEl ? sourceEl.getBoundingClientRect() : null;
  const day = { ...(state.completions[key] || {}) };
  const nowDone = !day[id];
  if (nowDone) day[id] = true; else delete day[id];
  const next = { ...state.completions, [key]: day };
  if (!Object.keys(day).length) delete next[key];
  state.completions = next;
  commit({ completions: true });

  if (!nowDone) return;
  const todays = activitiesForDate(state.activities, state.todayKey);
  const allDone = key === state.todayKey && todays.length > 0 && todays.every((a) => isDone(key, a.id));
  if (allDone) {
    confetti();
    toast('Everything for today is done. You should be proud! 🎉', { title: 'You did it!', timeout: 6000 });
  } else {
    if (rect) burstAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    toast(pick(CHEERS), { timeout: 2200 });
  }
}

function burstAt(x, y) {
  if (reducedMotion()) return;
  const layer = $('#fx');
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.className = 'burst';
    s.textContent = pick(BURST_EMOJI);
    const angle = (Math.PI * 2 * i) / 10 + Math.random() * 0.5;
    const dist = 40 + Math.random() * 40;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.setProperty('--x', `${Math.cos(angle) * dist}px`);
    s.style.setProperty('--y', `${Math.sin(angle) * dist - 20}px`);
    s.style.setProperty('--r', `${Math.round(Math.random() * 120 - 60)}deg`);
    layer.appendChild(s);
    setTimeout(() => s.remove(), 1000);
  }
}

function confetti() {
  if (reducedMotion()) return;
  const layer = $('#fx');
  const n = window.innerWidth < 500 ? 70 : 110;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('span');
    const r = Math.random();
    c.className = r < 0.12 ? 'confetti is-emoji' : r < 0.45 ? 'confetti is-round' : 'confetti';
    if (r < 0.12) c.textContent = pick(['🌸', '🎉', '✨', '💛']);
    c.style.left = `${Math.random() * 100}vw`;
    c.style.setProperty('--c', pick(CONFETTI_COLORS));
    c.style.setProperty('--dx', `${Math.round(Math.random() * 160 - 80)}px`);
    c.style.setProperty('--rot', `${Math.round(Math.random() * 900 - 450)}deg`);
    c.style.setProperty('--delay', `${(Math.random() * 0.6).toFixed(2)}s`);
    c.style.setProperty('--dur', `${(2.2 + Math.random() * 1.6).toFixed(2)}s`);
    layer.appendChild(c);
    setTimeout(() => c.remove(), 4600);
  }
}

// ---------------------------------------------------------------------------
// Toasts (aria-live region in index.html)
// ---------------------------------------------------------------------------

/**
 * toast(message, { title, action, onAction, timeout = 4500 })
 * timeout 0 keeps the toast until dismissed. Returns a dismiss function.
 */
function toast(message, { title = '', action = '', onAction = null, timeout = 4500 } = {}) {
  const wrap = $('#toasts');
  while (wrap.children.length >= 3) wrap.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<p class="toast-text">${title ? `<strong class="toast-title">${esc(title)}</strong>` : ''}${esc(message)}</p>
    ${action ? `<button type="button" class="toast-btn">${esc(action)}</button>` : ''}
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) {
    el.querySelector('.toast-btn').addEventListener('click', () => { dismiss(); if (onAction) onAction(); });
  }
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  wrap.appendChild(el);
  if (timeout) timer = setTimeout(dismiss, timeout);
  return dismiss;
}

// ---------------------------------------------------------------------------
// Add / edit sheet
// ---------------------------------------------------------------------------

const sheet = { ctx: null }; // { id: string|null, dateKey, opener: Element|null }

function optionList(select, options, value) {
  const vals = options.map(([v]) => String(v));
  const extra = value != null && value !== '' && !vals.includes(String(value))
    ? [[value, `${value} min`]] : [];
  select.innerHTML = [...options, ...extra]
    .map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  select.value = value == null ? '' : String(value);
}

function buildSheetChoices(activity) {
  const emoji = activity.emoji || DEFAULT_EMOJI;
  const emojis = EMOJIS.includes(emoji) ? EMOJIS : [emoji, ...EMOJIS];
  $('#emoji-row').innerHTML = emojis.map((e, i) => `<label>
      <input type="radio" name="emoji" value="${esc(e)}"${e === emoji ? ' checked' : ''} aria-label="Emoji ${i + 1}: ${esc(e)}">
      <span aria-hidden="true">${esc(e)}</span></label>`).join('');

  $('#color-row').innerHTML = COLORS.map((c) => `<label class="c-${c}">
      <input type="radio" name="color" value="${c}"${c === activity.color ? ' checked' : ''} aria-label="${c[0].toUpperCase()}${c.slice(1)}">
      <span aria-hidden="true"></span></label>`).join('');

  const days = activity.repeat.type === 'weekly' ? activity.repeat.days : [weekdayOf(sheet.ctx.dateKey)];
  $('#day-chips').innerHTML = MON_FIRST.map((d) => `<label>
      <input type="checkbox" name="days" value="${d}"${days.includes(d) ? ' checked' : ''} aria-label="${DAY_NAMES[d]}">
      <span aria-hidden="true">${DAY_LETTERS[d]}</span></label>`).join('');
}

/** Sensible default start time for a new task: the next full hour, or anytime late at night. */
function defaultTime(dateKey) {
  if (dateKey !== state.todayKey) return '09:00';
  const h = new Date().getHours() + 1;
  return h <= 22 ? `${pad2(h)}:00` : null;
}

function openSheet({ id = null, dateKey = null, repeatType = null } = {}) {
  const existing = id ? findActivity(id) : null;
  if (id && !existing) return;
  const key = dateKey || (state.view === 'tomorrow' ? tomorrowKey() : state.todayKey);
  sheet.ctx = { id: existing ? existing.id : null, dateKey: key, opener: document.activeElement };

  const a = existing || {
    title: '', emoji: DEFAULT_EMOJI, time: defaultTime(key), durationMin: null,
    repeat: repeatType ? { type: repeatType } : { type: 'once', date: key },
    remindBefore: DEFAULT_REMIND_BEFORE, notes: '',
    color: COLORS[state.activities.length % COLORS.length],
  };

  const form = $('#sheet-form');
  form.reset();
  clearErrors();
  $('#sheet-title').textContent = existing ? 'Edit activity' : (key === tomorrowKey() ? 'New for tomorrow' : 'New activity');
  $('#save-btn').textContent = existing ? 'Save changes' : 'Add it';
  $('#f-title').value = a.title;
  $('#f-time').value = a.time || '';
  $('#f-anytime').checked = !a.time;
  $('#f-time').disabled = !a.time;
  form.elements.repeat.value = a.repeat.type;
  $('#f-date').value = a.repeat.type === 'once' && a.repeat.date ? a.repeat.date : key;
  $('#f-date').min = existing ? '' : state.todayKey;
  optionList($('#f-remind'), REMIND_OPTIONS, a.remindBefore ?? DEFAULT_REMIND_BEFORE);
  optionList($('#f-duration'), DURATION_OPTIONS, a.durationMin ?? '');
  $('#f-notes').value = a.notes || '';
  $('#more').open = Boolean(a.notes || a.durationMin) && Boolean(existing);
  buildSheetChoices(a);
  syncRepeatFields();

  // Edit-only actions: skip this occurrence (recurring, on/after today) and delete.
  $('#sheet-secondary').hidden = !existing;
  if (existing) {
    const canSkip = existing.repeat.type !== 'once' && key >= state.todayKey && occursOn(existing, key);
    $('#skip-btn').hidden = !canSkip;
    $('#skip-btn').textContent = key === state.todayKey ? 'Skip today only'
      : key === tomorrowKey() ? 'Skip tomorrow only' : `Skip ${formatDateShort(key)}`;
    $('#sheet-secondary').style.gridTemplateColumns = canSkip ? '' : '1fr';
  }

  const dlg = $('#sheet');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  // Focus the name for new items (fast entry); for edits focus the dialog heading area.
  if (!existing) $('#f-title').focus();
  else $('#sheet .icon-btn').focus();
  $('#sheet').scrollTop = 0;
}

function closeSheet() {
  const dlg = $('#sheet');
  if (dlg.open) {
    if (typeof dlg.close === 'function') dlg.close(); else { dlg.removeAttribute('open'); onSheetClosed(); }
  }
}

function onSheetClosed() {
  const opener = sheet.ctx && sheet.ctx.opener;
  sheet.ctx = null;
  // Return focus to whatever opened the sheet (if it still exists), else main.
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  else if (opener && opener.dataset && opener.dataset.fk) {
    const el = document.querySelector(`[data-fk="${CSS.escape(opener.dataset.fk)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

function syncRepeatFields() {
  const type = $('#sheet-form').elements.repeat.value;
  $('#day-chips').hidden = type !== 'weekly';
  $('#date-wrap').hidden = type !== 'once';
}

function clearErrors() {
  for (const el of $$('#sheet .field-error')) el.textContent = '';
  for (const el of $$('#sheet [aria-invalid]')) el.removeAttribute('aria-invalid');
}

const ERROR_TARGET = {
  title: '#f-title', time: '#f-time', repeat: '#repeat-seg input:checked', remindBefore: '#f-remind',
  durationMin: '#f-duration', notes: '#f-notes',
};

function showErrors(errors) {
  clearErrors();
  let first = null;
  for (const [field, msg] of Object.entries(errors)) {
    const out = $(`#err-${field}`);
    if (out) out.textContent = msg;
    const target = ERROR_TARGET[field] ? $(ERROR_TARGET[field]) : null;
    if (target) {
      if (field !== 'repeat') target.setAttribute('aria-invalid', 'true');
      if (!first) first = target;
    }
    if ((field === 'durationMin' || field === 'notes')) $('#more').open = true;
  }
  if (first) first.focus();
}

function readSheet() {
  const form = $('#sheet-form');
  const fd = new FormData(form);
  const anytime = $('#f-anytime').checked;
  const type = fd.get('repeat');
  let repeat;
  if (type === 'once') repeat = { type, date: $('#f-date').value || sheet.ctx.dateKey };
  else if (type === 'weekly') repeat = { type, days: fd.getAll('days').map(Number) };
  else repeat = { type };
  return {
    anytime,
    input: {
      title: $('#f-title').value,
      emoji: fd.get('emoji') || DEFAULT_EMOJI,
      time: anytime ? null : $('#f-time').value || '',
      durationMin: fd.get('durationMin') || null,
      remindBefore: fd.get('remindBefore'),
      repeat,
      notes: $('#f-notes').value,
      color: fd.get('color') || COLORS[0],
    },
  };
}

function submitSheet() {
  const { anytime, input } = readSheet();
  const existing = sheet.ctx.id ? findActivity(sheet.ctx.id) : null;
  const res = validateActivity(existing ? { ...existing, ...input } : input);
  const errors = { ...res.errors };
  if (!anytime && !input.time && !errors.time) errors.time = 'Pick a time, or switch on Anytime';
  if (Object.keys(errors).length) { showErrors(errors); return; }

  const value = res.value;
  if (existing) {
    state.activities = state.activities.map((a) => (a.id === value.id ? value : a));
  } else {
    state.activities = [...state.activities, value];
  }
  closeSheet();
  commit({ activities: true });

  if (existing) {
    toast('Saved ✨');
  } else {
    const where = value.repeat.type === 'once'
      ? (value.repeat.date === state.todayKey ? 'for today' : value.repeat.date === tomorrowKey() ? 'for tomorrow' : `for ${formatDateShort(value.repeat.date)}`)
      : `· ${describeRepeat(value.repeat)}`;
    toast(`“${value.title}” added ${where}. You’ve got this! 💪`);
  }
}

function deleteActivity(id) {
  const idx = state.activities.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const removed = state.activities[idx];
  state.activities = state.activities.filter((a) => a.id !== id);
  closeSheet();
  commit({ activities: true });
  toast(`Removed “${removed.title}”`, {
    action: 'Undo',
    timeout: 7000,
    onAction() {
      if (findActivity(removed.id)) return;
      const list = [...state.activities];
      list.splice(Math.min(idx, list.length), 0, removed);
      state.activities = list;
      commit({ activities: true });
    },
  });
}

function skipOccurrence(id, key) {
  const a = findActivity(id);
  if (!a) return;
  const updated = { ...a, skipDates: [...new Set([...(a.skipDates || []), key])].sort() };
  state.activities = state.activities.map((x) => (x.id === id ? updated : x));
  closeSheet();
  commit({ activities: true });
  toast(`Skipping ${a.title} ${key === state.todayKey ? 'today' : key === tomorrowKey() ? 'tomorrow' : `on ${formatDateShort(key)}`}. Rest is productive too 🌿`, {
    action: 'Undo',
    timeout: 7000,
    onAction() {
      const cur = findActivity(id);
      if (!cur) return;
      const restored = { ...cur, skipDates: (cur.skipDates || []).filter((d) => d !== key) };
      state.activities = state.activities.map((x) => (x.id === id ? restored : x));
      commit({ activities: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Tomorrow quick-add
// ---------------------------------------------------------------------------

function quickAdd(form) {
  const title = form.elements.title.value;
  const time = form.elements.time.value || null;
  const key = tomorrowKey();
  const res = validateActivity({
    title, time, repeat: { type: 'once', date: key }, remindBefore: DEFAULT_REMIND_BEFORE,
    emoji: DEFAULT_EMOJI, color: COLORS[state.activities.length % COLORS.length],
  });
  const err = $('#qa-error');
  if (!res.ok) {
    err.textContent = res.errors.title ? 'What would you like to do tomorrow?' : Object.values(res.errors)[0];
    form.elements.title.setAttribute('aria-invalid', 'true');
    form.elements.title.focus();
    return;
  }
  err.textContent = '';
  form.elements.title.removeAttribute('aria-invalid');
  state.activities = [...state.activities, res.value];
  const btn = form.querySelector('button[type="submit"]');
  const rect = btn.getBoundingClientRect();
  form.reset();
  form.elements.title.focus();
  uiPref.set('planDismissed', state.todayKey); // they're planning: no need to nag tonight
  commit({ activities: true });
  burstAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  toast(`Added for tomorrow${res.value.time ? ` at ${formatTime(res.value.time)}` : ''}. Future you says thanks ✨`);
}

// ---------------------------------------------------------------------------
// Settings actions
// ---------------------------------------------------------------------------

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function onNotifButton() {
  const perm = permissionState();
  if (perm === 'granted') {
    // Already on: show a friendly test so the user can see what reminders look like.
    try {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      const opts = { body: 'This is how Bloom will nudge you. 🌸', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'bloom-test' };
      if (reg && reg.showNotification) await reg.showNotification('Reminders are working!', opts);
      else new Notification('Reminders are working!', opts); // eslint-disable-line no-new
    } catch { /* ignore */ }
    toast('Test reminder sent 🔔');
    return;
  }
  const result = await requestPermission();
  const granted = result === 'granted';
  state.settings = { ...state.settings, notifications: granted };
  commit({ settings: true });
  if (granted) {
    registerPeriodicSync();
    toast('Reminders are on! Bloom will nudge you before each activity 🔔');
  } else if (result === 'denied') {
    toast('No problem — you can still add your routine to your phone calendar below.');
  }
}

function onExportICS() {
  const ics = buildICS(state.activities, { now: new Date(), planTime: state.settings.planTime });
  download('bloom-routine.ics', ics, 'text/calendar;charset=utf-8');
  toast('Calendar file ready. Open it to add your routine to your phone’s calendar 📅', { timeout: 6000 });
}

async function onExportBackup() {
  try {
    const data = await exportBackup();
    download(`bloom-backup-${state.todayKey}.json`, JSON.stringify(data, null, 2), 'application/json');
    toast('Backup saved 💾');
  } catch (err) {
    toast('Sorry, the backup couldn’t be created.');
  }
}

async function onImportFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const imported = await importBackup(text);
    state.activities = imported.activities;
    state.completions = imported.completions;
    state.settings = imported.settings;
    fillSettingsForm();
    render();
    await refreshReminders();
    toast('Welcome back! Your plans are restored 🌸');
  } catch (err) {
    toast(err && err.message ? err.message : 'That file isn’t a valid Bloom backup.');
  }
}

// ---------------------------------------------------------------------------
// Install prompt (+ iOS hint)
// ---------------------------------------------------------------------------

let deferredInstall = null;

function isStandalone() {
  return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function setupInstall() {
  const card = $('#install-card');
  const btn = $('#install-btn');
  if (isStandalone()) { card.hidden = true; return; }
  if (isIOS()) {
    card.hidden = false;
    $('#install-text').textContent = 'On iPhone or iPad: tap the Share button, then “Add to Home Screen”. Bloom will open like an app and work offline.';
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    card.hidden = false;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    card.hidden = true;
    toast('Bloom is installed. See you on your home screen! 🌸');
  });
  btn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch { /* ignore */ }
    deferredInstall = null;
    btn.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function bindEvents() {
  // Delegated actions inside main (lists, cards, banners)
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id, date } = el.dataset;
    switch (action) {
      case 'toggle': toggleDone(id, date || state.todayKey, el); break;
      case 'edit': openSheet({ id, dateKey: date || state.todayKey }); break;
      case 'add': openSheet({ repeatType: el.dataset.repeat || null }); break;
      case 'delete':
        if (el.closest('#sheet')) deleteActivity(sheet.ctx && sheet.ctx.id);
        else deleteActivity(id);
        break;
      case 'skip': if (sheet.ctx) skipOccurrence(sheet.ctx.id, sheet.ctx.dateKey); break;
      case 'close-sheet': closeSheet(); break;
      case 'go-tomorrow':
        uiPref.set('planDismissed', state.todayKey);
        setView('tomorrow');
        render();
        $('#quick-add input[name="title"]').focus();
        break;
      case 'dismiss-plan':
        uiPref.set('planDismissed', state.todayKey);
        state.planFiredFor = null;
        render();
        $('#next-card').querySelector('button, [tabindex]')?.focus?.();
        break;
      default: break;
    }
  });

  // Tabs (click + arrow keys)
  const tabs = $$('.tab');
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
    tab.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); setView(tabs[j].dataset.view, { focusTab: true }); }
    });
  });

  $('#fab').addEventListener('click', () => openSheet());

  // Sheet
  const dlg = $('#sheet');
  const form = $('#sheet-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); submitSheet(); });
  dlg.addEventListener('close', onSheetClosed);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); }); // backdrop tap
  form.addEventListener('change', (e) => {
    if (e.target.name === 'repeat') syncRepeatFields();
    if (e.target.id === 'f-anytime') {
      const t = $('#f-time');
      t.disabled = e.target.checked;
      if (!e.target.checked && !t.value) t.value = defaultTime(sheet.ctx ? sheet.ctx.dateKey : state.todayKey) || '09:00';
      $('#err-time').textContent = '';
      t.removeAttribute('aria-invalid');
    }
  });
  form.addEventListener('input', (e) => {
    const out = e.target.id && $(`#err-${e.target.id.replace(/^f-/, '').replace('remind', 'remindBefore').replace('duration', 'durationMin')}`);
    if (out && out.textContent) { out.textContent = ''; e.target.removeAttribute('aria-invalid'); }
  });

  // Tomorrow quick-add
  $('#quick-add').addEventListener('submit', (e) => { e.preventDefault(); quickAdd(e.currentTarget); });
  $('#quick-add input[name="title"]').addEventListener('input', (e) => {
    if ($('#qa-error').textContent) { $('#qa-error').textContent = ''; e.target.removeAttribute('aria-invalid'); }
  });

  // Settings
  let nameTimer = null;
  $('#set-name').addEventListener('input', (e) => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      state.settings = { ...state.settings, name: e.target.value.trim().slice(0, 40) };
      commit({ settings: true });
    }, 400);
  });
  $('#set-plantime').addEventListener('change', (e) => {
    const t = parseTime(e.target.value);
    if (!t) { e.target.value = state.settings.planTime; return; }
    state.settings = { ...state.settings, planTime: `${pad2(t.h)}:${pad2(t.m)}` };
    commit({ settings: true });
    toast(`I’ll remind you to plan tomorrow at ${formatTime(state.settings.planTime)} 🌙`);
  });
  $('#notif-btn').addEventListener('click', onNotifButton);
  $('#ics-btn').addEventListener('click', onExportICS);
  $('#export-btn').addEventListener('click', onExportBackup);
  $('#import-file').addEventListener('change', (e) => onImportFile(e.target));

  // Service worker update toast
  window.addEventListener('bloom:update-ready', () => {
    toast('A fresh version of Bloom is ready.', { title: 'Update available', action: 'Refresh', onAction: applyUpdate, timeout: 0 });
  });

  // Re-render on return to the app (handles midnight rollover while hidden)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('focus', tick);
}

// ---------------------------------------------------------------------------
// Clock: minute ticks, date rollover, reminder refresh
// ---------------------------------------------------------------------------

function tick() {
  const key = toDateKey(new Date());
  if (key !== state.todayKey) {
    state.todayKey = key;
    refreshReminders();
  } else if (Date.now() - state.remindersAt > REMINDER_REFRESH_MS) {
    refreshReminders();
  }
  render();
}

function startClock() {
  const msToNextMinute = 60000 - (Date.now() % 60000) + 250;
  setTimeout(() => { tick(); setInterval(tick, 60000); }, msToNextMinute);
}

function onReminderFire(r) {
  if (r.kind === 'plan') {
    state.planFiredFor = state.todayKey;
    if (uiPref.get('planDismissed') === state.todayKey) uiPref.set('planDismissed', '');
    render();
    toast(r.body, { title: r.title, action: 'Plan tomorrow', onAction: () => { setView('tomorrow'); render(); }, timeout: 15000 });
  } else {
    toast(r.body, { title: r.title, timeout: 12000 });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function handleUrlParams() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const action = params.get('action');
  if (view) setView(view);
  if (view || action) {
    // Clean the URL so a reload doesn't re-trigger the shortcut.
    try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* ignore */ }
  }
  return { add: action === 'add' };
}

async function init() {
  bindEvents();
  setupInstall();

  try {
    const loaded = await loadState();
    state.activities = loaded.activities;
    state.completions = loaded.completions;
    state.settings = loaded.settings;
  } catch (err) {
    console.error('[bloom] could not load data', err);
    const now = Date.now();
    state.activities = DEFAULT_ACTIVITIES.map((a) => ({ ...JSON.parse(JSON.stringify(a)), createdAt: now }));
    toast('Storage is unavailable, so changes won’t be kept after closing.');
  }

  fillSettingsForm();
  const { add } = handleUrlParams();
  render();
  document.documentElement.classList.add('is-ready');

  await refreshReminders();
  startReminderLoop(() => state.reminders, { onFire: onReminderFire });
  startClock();

  if (add) openSheet();

  registerServiceWorker().then((reg) => {
    if (reg && notificationsSupported() && permissionState() === 'granted') registerPeriodicSync();
  });
}

init();
})();
