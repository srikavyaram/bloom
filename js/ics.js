// Bloom · ics.js
// Builds an RFC 5545 iCalendar file from the user's activities so the phone's own
// calendar can deliver reminders even when the PWA is closed (no push server needed).
// Times are "floating" local times (no Z, no TZID): they ring at the same wall-clock
// time wherever the device is.
//
// Classic script (not an ES module) so the app also runs when index.html is
// opened straight from disk. Shares code through the global `Bloom` namespace.

(function () {
'use strict';

const Bloom = (globalThis.Bloom = globalThis.Bloom || {});
const {
  addDays, isDateKey, occursOn, parseTime, toDateKey,
} = Bloom.schedule;

const CRLF = '\r\n';
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad2 = (n) => String(n).padStart(2, '0');
const encoder = new TextEncoder();

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function escapeText(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line so no physical line exceeds 75 octets (excluding CRLF).
 * Continuation lines start with a single space. Never splits a UTF-8 sequence.
 */
function foldLine(line) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = encoder.encode(ch).length;
    if (curBytes + b > 75) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join(CRLF);
}

/** 'YYYY-MM-DD' + 'HH:MM' -> floating 'YYYYMMDDTHHMMSS'. */
function floating(dateKey, time) {
  const t = parseTime(time);
  return `${dateKey.replace(/-/g, '')}T${pad2(t.h)}${pad2(t.m)}00`;
}

function utcStamp(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T`
    + `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function rruleFor(repeat) {
  switch (repeat.type) {
    case 'daily': return 'FREQ=DAILY';
    case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly': {
      const days = [...new Set(repeat.days || [])].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
      return days.length ? `FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY[d]).join(',')}` : null;
    }
    default: return null;
  }
}

/** First date >= fromKey on which the repeat rule matches (skipDates ignored). */
function firstMatch(activity, fromKey) {
  const ruleOnly = { ...activity, skipDates: [] };
  for (let i = 0; i < 7; i++) {
    const key = addDays(fromKey, i);
    if (occursOn(ruleOnly, key)) return key;
  }
  return null;
}

function alarm(lines, description, minutesBefore) {
  const m = Math.max(0, Math.round(Number(minutesBefore) || 0));
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(description)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
}

/**
 * buildICS(activities, { now = new Date(), planTime?, calName? }) -> string (CRLF, folded)
 * - one VEVENT per timed activity (anytime tasks are skipped)
 * - recurring: RRULE, DTSTART = first matching date >= today, EXDATE for skipDates
 * - once: omitted when its date is before today or it was skipped
 * - VALARM TRIGGER:-PT{remindBefore}M
 * - optional daily "Plan tomorrow" event at planTime
 */
function buildICS(activities, { now = new Date(), planTime, calName = 'Bloom' } = {}) {
  const today = toDateKey(now);
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bloom//Daily Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];

  for (const a of activities || []) {
    if (!a || !parseTime(a.time) || !a.repeat) continue;
    const label = `${a.emoji ? `${a.emoji} ` : ''}${a.title}`;
    const skips = (Array.isArray(a.skipDates) ? a.skipDates : []).filter(isDateKey);
    let startKey;
    let rrule = null;

    if (a.repeat.type === 'once') {
      startKey = a.repeat.date;
      if (!isDateKey(startKey) || startKey < today || skips.includes(startKey)) continue;
    } else {
      rrule = rruleFor(a.repeat);
      startKey = rrule && firstMatch(a, today);
      if (!startKey) continue;
    }

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(a.id)}@bloom.planner`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${floating(startKey, a.time)}`,
    );
    if (Number(a.durationMin) > 0) lines.push(`DURATION:PT${Math.round(Number(a.durationMin))}M`);
    if (rrule) {
      lines.push(`RRULE:${rrule}`);
      const ruleOnly = { ...a, skipDates: [] };
      const ex = [...new Set(skips)].sort()
        .filter((k) => k >= startKey && occursOn(ruleOnly, k))
        .map((k) => floating(k, a.time));
      if (ex.length) lines.push(`EXDATE:${ex.join(',')}`);
    }
    lines.push(`SUMMARY:${escapeText(label)}`);
    if (a.notes) lines.push(`DESCRIPTION:${escapeText(a.notes)}`);
    alarm(lines, label, a.remindBefore);
    lines.push('END:VEVENT');
  }

  if (parseTime(planTime)) {
    lines.push(
      'BEGIN:VEVENT',
      'UID:plan-tomorrow@bloom.planner',
      `DTSTAMP:${stamp}`,
      `DTSTART:${floating(today, planTime)}`,
      'DURATION:PT10M',
      'RRULE:FREQ=DAILY',
      `SUMMARY:${escapeText('🌱 Plan tomorrow')}`,
      `DESCRIPTION:${escapeText('Open Bloom, check what’s lined up for tomorrow, and add anything new.')}`,
    );
    alarm(lines, 'Plan tomorrow in Bloom', 0);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

Bloom.ics = {
  escapeText, foldLine, buildICS,
};
})();
