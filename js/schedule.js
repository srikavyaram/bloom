// Bloom · schedule.js
// Pure scheduling helpers: no DOM, no storage, no globals beyond Date/Intl.
// All dates and times are the device's LOCAL time. A "dateKey" is 'YYYY-MM-DD'.
//
// Classic script (not an ES module) so the app also runs when index.html is
// opened straight from disk. Shares code through the global `Bloom` namespace.

(function () {
'use strict';

const Bloom = (globalThis.Bloom = globalThis.Bloom || {});

const MINUTE = 60 * 1000;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Allowed accent colours for activities (first one is the default). */
const COLORS = Object.freeze(['sun', 'sky', 'mint', 'rose', 'lilac', 'peach']);
/** Repeat types understood by the scheduler. */
const REPEAT_TYPES = Object.freeze(['once', 'daily', 'weekdays', 'weekly']);
const DEFAULT_EMOJI = '✨';
const DEFAULT_REMIND_BEFORE = 10;
const TITLE_MAX = 80;
const NOTES_MAX = 1000;

function deepFreeze(obj) {
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(obj);
}

/**
 * Seed activities from the user's brief. createdAt is 0 here; store.js stamps the
 * real install time when seeding. Frozen: clone before mutating.
 */
const DEFAULT_ACTIVITIES = deepFreeze([
  {
    id: 'seed-scrum', title: 'Scrum', emoji: '☕', time: '10:00', durationMin: 15,
    repeat: { type: 'weekdays' }, remindBefore: 10, skipDates: [], notes: '', color: 'sky', createdAt: 0,
  },
  {
    id: 'seed-accounting', title: 'Accounting', emoji: '📊', time: '11:00', durationMin: 60,
    repeat: { type: 'weekly', days: [3] }, remindBefore: 10, skipDates: [], notes: '', color: 'mint', createdAt: 0,
  },
  {
    id: 'seed-music-online', title: 'Music online session', emoji: '🎹', time: '10:30', durationMin: 60,
    repeat: { type: 'weekly', days: [5] }, remindBefore: 10, skipDates: [], notes: '', color: 'lilac', createdAt: 0,
  },
  {
    id: 'seed-music-class', title: 'Music class (evening)', emoji: '🎶', time: '17:30', durationMin: 60,
    repeat: { type: 'daily' }, remindBefore: 10, skipDates: [], notes: '', color: 'rose', createdAt: 0,
  },
]);

const DEFAULT_SETTINGS = deepFreeze({
  planTime: '20:00',
  notifications: false,
  name: '',
  seeded: false,
});

// ---------------------------------------------------------------------------
// Date keys
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

function splitKey(key) {
  const m = DATE_KEY_RE.exec(String(key));
  if (!m) throw new TypeError(`Invalid dateKey: ${key}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True if `key` is a well-formed, real calendar date 'YYYY-MM-DD'. */
function isDateKey(key) {
  if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) return false;
  const [y, m, d] = splitKey(key);
  const dt = new Date(y, m - 1, d, 12);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Local calendar date of `date` as 'YYYY-MM-DD'. */
function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local midnight of the given dateKey. */
function fromDateKey(key) {
  const [y, m, d] = splitKey(key);
  return new Date(y, m - 1, d);
}

/**
 * Calendar arithmetic on date keys (DST-safe). Uses local noon so that zones whose
 * DST switch happens at midnight can never shift the result onto another day.
 */
function addDays(key, n) {
  const [y, m, d] = splitKey(key);
  return toDateKey(new Date(y, m - 1, d + n, 12));
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(key) {
  const [y, m, d] = splitKey(key);
  return new Date(y, m - 1, d, 12).getDay();
}

/** Whole days since 1970-01-01 for a dateKey (timezone-independent). Handy as a seed. */
function dayNumber(key) {
  const [y, m, d] = splitKey(key);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/** 'HH:MM' (also 'H:MM' or 'HH:MM:SS') -> {h, m}; anything else -> null. */
function parseTime(str) {
  if (typeof str !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(str.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

function normaliseTime(str) {
  const t = parseTime(str);
  return t ? `${pad2(t.h)}:${pad2(t.m)}` : null;
}

/**
 * Human time. formatTime('10:30') -> '10:30 AM'; formatTime('17:30', {hour12:false}) -> '17:30';
 * null/undefined -> 'Anytime'. Unparseable strings -> ''.
 */
function formatTime(time, opts = {}) {
  if (time == null || time === '') return 'Anytime';
  const t = parseTime(time);
  if (!t) return '';
  if (opts.hour12 === false) return `${pad2(t.h)}:${pad2(t.m)}`;
  const suffix = t.h < 12 ? 'AM' : 'PM';
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  return `${h12}:${pad2(t.m)} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

/** Does the repeat rule match this day, ignoring skipDates? */
function ruleMatches(repeat, key) {
  if (!repeat) return false;
  switch (repeat.type) {
    case 'once': return repeat.date === key;
    case 'daily': return true;
    case 'weekdays': { const wd = weekdayOf(key); return wd >= 1 && wd <= 5; }
    case 'weekly': return Array.isArray(repeat.days) && repeat.days.includes(weekdayOf(key));
    default: return false;
  }
}

/** Whether `activity` happens on `dateKey` (respects repeat + skipDates). */
function occursOn(activity, dateKey) {
  if (!activity) return false;
  if (Array.isArray(activity.skipDates) && activity.skipDates.includes(dateKey)) return false;
  return ruleMatches(activity.repeat, dateKey);
}

/**
 * Local start Date of the activity on dateKey, or null for "anytime" tasks.
 * Does not check occursOn — callers decide which days to ask about.
 */
function occurrenceStart(activity, dateKey) {
  const t = activity ? parseTime(activity.time) : null;
  if (!t) return null;
  const [y, m, d] = splitKey(dateKey);
  return new Date(y, m - 1, d, t.h, t.m);
}

function occurrenceEnd(activity, start) {
  const dur = Number(activity.durationMin) > 0 ? Number(activity.durationMin) : 0;
  return new Date(start.getTime() + dur * MINUTE);
}

function compareActivities(a, b) {
  const ta = normaliseTime(a.time);
  const tb = normaliseTime(b.time);
  if (ta !== tb) {
    if (ta === null) return 1; // anytime last
    if (tb === null) return -1;
    return ta < tb ? -1 : 1;
  }
  return String(a.title).localeCompare(String(b.title));
}

/** Activities occurring on dateKey, sorted by time (anytime last), ties by title. */
function activitiesForDate(activities, dateKey) {
  return (activities || []).filter((a) => occursOn(a, dateKey)).sort(compareActivities);
}

function isDone(completions, dateKey, id) {
  return Boolean(completions && completions[dateKey] && completions[dateKey][id]);
}

/**
 * The next thing to focus on. An occurrence in progress (start <= now < start+duration)
 * wins; otherwise the earliest not-completed timed occurrence starting >= now within
 * today + the next 7 days. Returns { activity, dateKey, start, end, inProgress } or null.
 */
function nextUp(activities, completions, now) {
  const today = toDateKey(now);
  const t = now.getTime();
  let inProgress = null;
  let upcoming = null;
  const better = (cur, cand) => !cur
    || cand.start < cur.start
    || (cand.start.getTime() === cur.start.getTime() && compareActivities(cand.activity, cur.activity) < 0);

  // Start at yesterday so late-evening activities running past midnight count as in progress.
  for (let i = -1; i <= 7; i++) {
    const key = addDays(today, i);
    for (const activity of activities || []) {
      if (!occursOn(activity, key) || isDone(completions, key, activity.id)) continue;
      const start = occurrenceStart(activity, key);
      if (!start) continue;
      const end = occurrenceEnd(activity, start);
      const cand = { activity, dateKey: key, start, end };
      if (start.getTime() <= t && t < end.getTime()) {
        if (better(inProgress, cand)) inProgress = cand;
      } else if (start.getTime() >= t) {
        if (better(upcoming, cand)) upcoming = cand;
      }
    }
  }
  if (inProgress) return { ...inProgress, inProgress: true };
  if (upcoming) return { ...upcoming, inProgress: false };
  return null;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

const REMINDER_GRACE = 15 * MINUTE;

function planSummaryBody(items) {
  if (!items.length) return 'Tomorrow is wide open so far. Anything new to add?';
  const MAX = 5;
  const parts = items.slice(0, MAX).map((a) => (a.time ? `${a.title} ${formatTime(a.time)}` : a.title));
  if (items.length > MAX) parts.push(`+${items.length - MAX} more`);
  return `Tomorrow: ${parts.join(', ')}. Anything new to add?`;
}

/**
 * Reminders whose fireAt lies in (now - 15 min, now + horizonHours].
 * - kind 'activity': one per timed occurrence, fireAt = start - remindBefore minutes.
 * - kind 'plan': one per day at settings.planTime; dateKey is the evening it fires on,
 *   body summarises the following day.
 * Sorted by fireAt (ties by id).
 */
function upcomingReminders(activities, settings, now, horizonHours = 48) {
  const list = [];
  const lo = now.getTime() - REMINDER_GRACE;
  const hi = now.getTime() + horizonHours * 60 * MINUTE;
  const inWindow = (ms) => ms > lo && ms <= hi;
  const today = toDateKey(now);
  // remindBefore can be up to a day, so look one day either side of the window.
  const lastDay = Math.ceil(horizonHours / 24) + 2;

  for (let i = -1; i <= lastDay; i++) {
    const key = addDays(today, i);
    for (const a of activities || []) {
      if (!occursOn(a, key)) continue;
      const start = occurrenceStart(a, key);
      if (!start) continue;
      const before = Math.max(0, Number(a.remindBefore) || 0);
      const fireAt = start.getTime() - before * MINUTE;
      if (!inWindow(fireAt)) continue;
      const when = formatTime(a.time);
      list.push({
        id: `${a.id}@${key}`,
        activityId: a.id,
        dateKey: key,
        kind: 'activity',
        title: `${a.emoji || DEFAULT_EMOJI} ${a.title}`,
        body: before > 0
          ? `Starts at ${when} (in ${before} min). You've got this!`
          : `Starting now (${when}). You've got this!`,
        fireAt,
        startAt: start.getTime(),
      });
    }

    const plan = parseTime(settings && settings.planTime) || parseTime(DEFAULT_SETTINGS.planTime);
    const [y, m, d] = splitKey(key);
    const planAt = new Date(y, m - 1, d, plan.h, plan.m).getTime();
    if (inWindow(planAt)) {
      list.push({
        id: `plan@${key}`,
        activityId: null,
        dateKey: key,
        kind: 'plan',
        title: 'Time to plan tomorrow 🌱',
        body: planSummaryBody(activitiesForDate(activities, addDays(key, 1))),
        fireAt: planAt,
        startAt: null,
      });
    }
  }
  return list.sort((a, b) => a.fireAt - b.fireAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Tomorrow's line-up, split into routine (recurring) and one-off items. */
function tomorrowSummary(activities, todayKey) {
  const dateKey = addDays(todayKey, 1);
  const items = activitiesForDate(activities, dateKey);
  return {
    dateKey,
    items,
    routine: items.filter((a) => a.repeat && a.repeat.type !== 'once'),
    oneOffs: items.filter((a) => a.repeat && a.repeat.type === 'once'),
  };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/** 'Tue, 4 Nov' style label for a dateKey. */
function formatDateShort(key) {
  const [, m, d] = splitKey(key);
  return `${DAY_SHORT[weekdayOf(key)]}, ${d} ${MONTH_SHORT[m - 1]}`;
}

/** Friendly label for a repeat rule. */
function describeRepeat(repeat) {
  if (!repeat) return '';
  switch (repeat.type) {
    case 'daily': return 'Every day';
    case 'weekdays': return 'Weekdays';
    case 'once': return isDateKey(repeat.date) ? `Once · ${formatDateShort(repeat.date)}` : 'Once';
    case 'weekly': {
      const days = [...new Set(repeat.days || [])].filter((d) => d >= 0 && d <= 6);
      if (days.length === 0) return 'Weekly';
      if (days.length === 7) return 'Every day';
      const sorted = MON_FIRST.filter((d) => days.includes(d));
      if (sorted.join() === '1,2,3,4,5') return 'Weekdays';
      if (sorted.join() === '6,0') return 'Weekends';
      if (sorted.length === 1) return `Every ${DAY_SHORT[sorted[0]]}`;
      return joinAnd(sorted.map((d) => DAY_SHORT[d]));
    }
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Random id: crypto.randomUUID when available, otherwise a timestamp+random fallback. */
function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function firstGrapheme(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)[Symbol.iterator]();
    const first = it.next();
    return first.done ? '' : first.value.segment;
  }
  return Array.from(str)[0] || '';
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Normalise + validate a (possibly partial) activity from a form.
 * Returns { ok, errors: {field: message}, value: Activity | null }.
 * Optional second arg { now } is used to default a 'once' date / missing repeat to today.
 */
function validateActivity(input, { now = new Date() } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};

  // title
  const title = typeof src.title === 'string' ? src.title.trim().replace(/\s+/g, ' ') : '';
  if (!title) errors.title = 'Give it a name';
  else if (Array.from(title).length > TITLE_MAX) errors.title = `Keep it under ${TITLE_MAX} characters`;

  // emoji
  const emoji = typeof src.emoji === 'string' && src.emoji.trim() ? firstGrapheme(src.emoji.trim()) : DEFAULT_EMOJI;

  // time
  let time = null;
  if (!isBlank(src.time)) {
    time = normaliseTime(String(src.time));
    if (!time) errors.time = 'Pick a valid time';
  }

  // duration
  let durationMin = null;
  if (!isBlank(src.durationMin)) {
    const n = Number(src.durationMin);
    if (!Number.isFinite(n) || n <= 0 || n > 1440) errors.durationMin = 'Duration must be 1–1440 minutes';
    else durationMin = Math.round(n);
  }

  // remindBefore
  let remindBefore = DEFAULT_REMIND_BEFORE;
  if (!isBlank(src.remindBefore)) {
    const n = Number(src.remindBefore);
    if (!Number.isFinite(n) || n < 0 || n > 1440) errors.remindBefore = 'Reminder must be 0–1440 minutes before';
    else remindBefore = Math.round(n);
  }

  // repeat
  let repeat = null;
  const r = src.repeat;
  if (r == null) {
    repeat = { type: 'once', date: toDateKey(now) };
  } else if (typeof r !== 'object' || !REPEAT_TYPES.includes(r.type)) {
    errors.repeat = 'Choose how often this happens';
  } else if (r.type === 'once') {
    const date = isBlank(r.date) ? toDateKey(now) : String(r.date);
    if (!isDateKey(date)) errors.repeat = 'Pick a valid date';
    else repeat = { type: 'once', date };
  } else if (r.type === 'weekly') {
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (!days.length) errors.repeat = 'Pick at least one day';
    else repeat = { type: 'weekly', days };
  } else {
    repeat = { type: r.type };
  }

  // skipDates
  const skipDates = [...new Set((Array.isArray(src.skipDates) ? src.skipDates : []).filter(isDateKey))].sort();

  // notes
  const notes = typeof src.notes === 'string' ? src.notes.trim() : '';
  if (notes.length > NOTES_MAX) errors.notes = `Notes can be up to ${NOTES_MAX} characters`;

  const color = COLORS.includes(src.color) ? src.color : COLORS[0];
  const id = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : newId();
  const createdAt = Number.isFinite(src.createdAt) ? src.createdAt : now.getTime();

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok
      ? { id, title, emoji, time, durationMin, repeat, remindBefore, skipDates, notes, color, createdAt }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Encouragement
// ---------------------------------------------------------------------------

/**
 * Consecutive "perfect" days ending yesterday (plus today if everything today is done).
 * A day counts when it had >= 1 occurrence and all were completed; days with no
 * occurrences are neutral. Occurrences before an activity's createdAt day are ignored,
 * so adding a new routine doesn't retroactively break a streak. Looks back <= 365 days.
 */
function streak(completions, activities, todayKey) {
  const list = activities || [];
  const createdKey = new Map(list.map((a) => [a.id, a.createdAt > 0 ? toDateKey(new Date(a.createdAt)) : null]));
  const dayStatus = (key) => {
    const due = list.filter((a) => {
      const c = createdKey.get(a.id);
      return (!c || key >= c) && occursOn(a, key);
    });
    if (!due.length) return 'empty';
    return due.every((a) => isDone(completions, key, a.id)) ? 'done' : 'missed';
  };

  let count = 0;
  for (let i = 1; i <= 365; i++) {
    const s = dayStatus(addDays(todayKey, -i));
    if (s === 'missed') break;
    if (s === 'done') count++;
  }
  if (dayStatus(todayKey) === 'done') count++;
  return count;
}

/** Time-of-day greeting, e.g. 'Good morning, Kavya'. */
function greeting(now, name) {
  const h = now.getHours();
  const base = h < 5 ? 'Hello, night owl' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const who = typeof name === 'string' ? name.trim() : '';
  if (!who) return base;
  return h < 5 ? `Hello, ${who}` : `${base}, ${who}`;
}

const AFFIRMATIONS = Object.freeze([
  'Small steps still move you forward.',
  'You showed up today. That matters.',
  'One thing at a time. You’ve got this.',
  'Progress, not perfection.',
  'Your future self says thank you.',
  'Breathe in. Begin again.',
  'Little by little, a little becomes a lot.',
  'Today is full of good possibilities.',
  'Be proud of how far you’ve come.',
  'Done is better than perfect.',
  'You’re building something beautiful.',
  'Gentle consistency beats rare bursts.',
  'Make today count — kindly.',
  'Every tick is a tiny celebration.',
  'You are capable of wonderful things.',
  'Rest is part of the rhythm too.',
  'Keep going — you’re doing great.',
  'Your effort is planting seeds. 🌱',
  'Focus on the next right thing.',
  'A calm mind makes a bright day.',
  'You make hard things look doable.',
  'Celebrate the small wins today.',
  'Let your music and your work both sing. 🎶',
  'Fresh day, fresh start.',
]);

/** Deterministic affirmation for a numeric seed (e.g. dayNumber(todayKey)). */
function encouragement(seed) {
  const n = AFFIRMATIONS.length;
  const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
  return AFFIRMATIONS[((s % n) + n) % n];
}

/** Exposed for tests / UI variety. */
const ENCOURAGEMENTS = AFFIRMATIONS;

Bloom.schedule = {
  COLORS, REPEAT_TYPES, DEFAULT_EMOJI, DEFAULT_REMIND_BEFORE, TITLE_MAX,
  NOTES_MAX, DEFAULT_ACTIVITIES, DEFAULT_SETTINGS, isDateKey, toDateKey,
  fromDateKey, addDays, weekdayOf, dayNumber, parseTime, formatTime, occursOn,
  occurrenceStart, activitiesForDate, nextUp, upcomingReminders,
  tomorrowSummary, formatDateShort, describeRepeat, newId, validateActivity,
  streak, greeting, encouragement, ENCOURAGEMENTS,
};
})();
