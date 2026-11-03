import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The app scripts are classic scripts that register themselves on globalThis.Bloom
// (schedule.js must load before ics.js, as in index.html).
import '../js/schedule.js';
import '../js/ics.js';

const { buildICS, foldLine, escapeText } = globalThis.Bloom.ics;
const { DEFAULT_ACTIVITIES, validateActivity } = globalThis.Bloom.schedule;

const NOW = new Date(2026, 10, 3, 9, 0); // Tue 3 Nov 2026, 09:00 local
const SEEDS = structuredClone(DEFAULT_ACTIVITIES);
const act = (over) => validateActivity({ title: 'Thing', time: '09:00', repeat: { type: 'daily' }, ...over }).value;

/** Unfold (RFC 5545 §3.1) and split into logical lines. */
const unfold = (ics) => ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
/** Logical lines of the VEVENT whose UID starts with `uid`. */
function eventLines(ics, uid) {
  const lines = unfold(ics);
  const events = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = [];
    else if (l === 'END:VEVENT') { events.push(cur); cur = null; } else if (cur) cur.push(l);
  }
  return events.find((e) => e.includes(`UID:${uid}@bloom.planner`));
}
const prop = (lines, name) => lines.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1));

describe('buildICS structure', () => {
  const ics = buildICS(SEEDS, { now: NOW });

  test('calendar envelope and CRLF line endings', () => {
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/[^\r]\n/.test(ics), 'every LF must be preceded by CR');
    assert.match(ics, /\r\nPRODID:[^\r]+\r\n/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
    assert.equal((ics.match(/END:VEVENT/g) || []).length, 4);
  });

  test('scrum: weekdays RRULE, floating DTSTART today, VALARM -10 min', () => {
    const e = eventLines(ics, 'seed-scrum');
    assert.deepEqual(prop(e, 'DTSTART'), ['20261103T100000']); // no Z, no TZID
    assert.deepEqual(prop(e, 'RRULE'), ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);
    assert.deepEqual(prop(e, 'DURATION'), ['PT15M']);
    assert.deepEqual(prop(e, 'SUMMARY'), ['☕ Scrum']);
    assert.ok(e.includes('BEGIN:VALARM'));
    assert.ok(e.includes('ACTION:DISPLAY'));
    assert.deepEqual(prop(e, 'TRIGGER'), ['-PT10M']);
    assert.match(prop(e, 'DTSTAMP')[0], /^\d{8}T\d{6}Z$/);
  });

  test('accounting: first Wednesday on/after today', () => {
    const e = eventLines(ics, 'seed-accounting');
    assert.deepEqual(prop(e, 'DTSTART'), ['20261104T110000']);
    assert.deepEqual(prop(e, 'RRULE'), ['FREQ=WEEKLY;BYDAY=WE']);
  });

  test('music online: Friday 10:30', () => {
    const e = eventLines(ics, 'seed-music-online');
    assert.deepEqual(prop(e, 'DTSTART'), ['20261106T103000']);
    assert.deepEqual(prop(e, 'RRULE'), ['FREQ=WEEKLY;BYDAY=FR']);
  });

  test('music class: daily 17:30 starting today', () => {
    const e = eventLines(ics, 'seed-music-class');
    assert.deepEqual(prop(e, 'DTSTART'), ['20261103T173000']);
    assert.deepEqual(prop(e, 'RRULE'), ['FREQ=DAILY']);
    assert.deepEqual(prop(e, 'SUMMARY'), ['🎶 Music class (evening)']);
  });

  test('no plan event unless planTime is given', () => {
    assert.equal(eventLines(ics, 'plan-tomorrow'), undefined);
  });
});

describe('buildICS rules', () => {
  test('EXDATE lists skipped occurrences (from DTSTART on, matching the rule)', () => {
    const a = { ...SEEDS[0], skipDates: ['2026-11-05', '2026-11-03', '2026-11-07', '2026-10-01'] };
    const e = eventLines(buildICS([a], { now: NOW }), 'seed-scrum');
    // Sat 7 Nov isn't a weekday and 1 Oct is in the past: both dropped.
    assert.deepEqual(prop(e, 'EXDATE'), ['20261103T100000,20261105T100000']);
    assert.deepEqual(prop(e, 'DTSTART'), ['20261103T100000']);
  });

  test('weekly multi-day BYDAY order and Sunday handling', () => {
    const a = act({ id: 'multi', repeat: { type: 'weekly', days: [0, 5, 1] } });
    const e = eventLines(buildICS([a], { now: NOW }), 'multi');
    assert.deepEqual(prop(e, 'RRULE'), ['FREQ=WEEKLY;BYDAY=SU,MO,FR']);
    assert.deepEqual(prop(e, 'DTSTART'), ['20261106T090000']); // Friday is the first match after Tue
  });

  test("'once': future/today kept without RRULE, past or skipped omitted", () => {
    const future = act({ id: 'future', repeat: { type: 'once', date: '2026-11-20' }, time: '14:15' });
    const today = act({ id: 'today', repeat: { type: 'once', date: '2026-11-03' } });
    const past = act({ id: 'past', repeat: { type: 'once', date: '2026-11-02' } });
    const skipped = act({ id: 'skipped', repeat: { type: 'once', date: '2026-11-10' }, skipDates: ['2026-11-10'] });
    const ics = buildICS([future, today, past, skipped], { now: NOW });
    const e = eventLines(ics, 'future');
    assert.deepEqual(prop(e, 'DTSTART'), ['20261120T141500']);
    assert.deepEqual(prop(e, 'RRULE'), []);
    assert.ok(eventLines(ics, 'today'));
    assert.equal(eventLines(ics, 'past'), undefined);
    assert.equal(eventLines(ics, 'skipped'), undefined);
  });

  test('anytime tasks are omitted; remindBefore 0 -> TRIGGER:-PT0M; no duration -> no DURATION', () => {
    const anytime = act({ id: 'anytime', time: null });
    const zero = act({ id: 'zero', remindBefore: 0 });
    const ics = buildICS([anytime, zero], { now: NOW });
    assert.equal(eventLines(ics, 'anytime'), undefined);
    const e = eventLines(ics, 'zero');
    assert.deepEqual(prop(e, 'TRIGGER'), ['-PT0M']);
    assert.deepEqual(prop(e, 'DURATION'), []);
  });

  test('optional daily plan-tomorrow event at planTime', () => {
    const e = eventLines(buildICS([], { now: NOW, planTime: '20:00' }), 'plan-tomorrow');
    assert.deepEqual(prop(e, 'DTSTART'), ['20261103T200000']);
    assert.deepEqual(prop(e, 'RRULE'), ['FREQ=DAILY']);
    assert.ok(prop(e, 'SUMMARY')[0].includes('Plan tomorrow'));
    assert.deepEqual(prop(e, 'TRIGGER'), ['-PT0M']);
  });

  test('text is escaped and notes become DESCRIPTION', () => {
    const a = act({ id: 'esc', title: 'Pay rent; call bank, then \\ relax', notes: 'line1\nline2' });
    const e = eventLines(buildICS([a], { now: NOW }), 'esc');
    assert.deepEqual(prop(e, 'SUMMARY'), ['✨ Pay rent\\; call bank\\, then \\\\ relax']);
    // The event's own DESCRIPTION (the VALARM has its own, after BEGIN:VALARM).
    assert.deepEqual(prop(e.slice(0, e.indexOf('BEGIN:VALARM')), 'DESCRIPTION'), ['line1\\nline2']);
  });
});

describe('folding & escaping helpers', () => {
  test('escapeText', () => {
    assert.equal(escapeText('a,b;c\\d\r\ne'), 'a\\,b\\;c\\\\d\\ne');
    assert.equal(escapeText(null), '');
  });

  test('short lines are untouched', () => {
    assert.equal(foldLine('SUMMARY:Hi'), 'SUMMARY:Hi');
    assert.equal(foldLine('X'.repeat(75)), 'X'.repeat(75));
  });

  test('long lines fold at 75 octets with a leading space', () => {
    const line = `DESCRIPTION:${'a'.repeat(200)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1);
    parts.forEach((p, i) => {
      assert.ok(Buffer.byteLength(p, 'utf8') <= 75, `part ${i} too long`);
      if (i > 0) assert.equal(p[0], ' ');
    });
    assert.equal(parts[0].length, 75);
    assert.equal(folded.replace(/\r\n /g, ''), line);
  });

  test('multi-byte characters are never split', () => {
    const line = `SUMMARY:${'🎶é'.repeat(40)}`;
    const folded = foldLine(line);
    for (const p of folded.split('\r\n')) {
      assert.ok(Buffer.byteLength(p, 'utf8') <= 75);
      assert.ok(!p.includes('�'));
      // Round-trip through bytes must be lossless (no broken surrogate pairs).
      assert.equal(Buffer.from(p, 'utf8').toString('utf8'), p);
    }
    assert.equal(folded.replace(/\r\n /g, ''), line);
  });

  test('every physical line of a real export is <= 75 octets', () => {
    const long = act({ id: 'long', title: 'L'.repeat(80), notes: 'Remember the sheet music 🎼 and the metronome, please! '.repeat(5) });
    const ics = buildICS([...SEEDS, long], { now: NOW, planTime: '20:00' });
    for (const p of ics.split('\r\n')) assert.ok(Buffer.byteLength(p, 'utf8') <= 75, p);
    assert.equal(prop(eventLines(ics, 'long'), 'SUMMARY')[0], `✨ ${'L'.repeat(80)}`);
  });
});
