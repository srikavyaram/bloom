import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The app scripts are classic scripts that register themselves on globalThis.Bloom.
import '../js/schedule.js';
import '../js/store.js';

const {
  DEFAULT_ACTIVITIES, DEFAULT_SETTINGS, COLORS,
  toDateKey, fromDateKey, addDays, weekdayOf, dayNumber, isDateKey,
  parseTime, formatTime, occursOn, occurrenceStart, activitiesForDate,
  nextUp, upcomingReminders, tomorrowSummary, describeRepeat, validateActivity,
  streak, greeting, encouragement, ENCOURAGEMENTS,
} = globalThis.Bloom.schedule;
const { pruneCompletions } = globalThis.Bloom.store;

// Reference week (Nov 2026): Mon 2 … Sun 8.
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const WEEK = [MON, TUE, WED, THU, FRI, SAT, SUN];

const seed = (id) => structuredClone(DEFAULT_ACTIVITIES.find((a) => a.id === id));
const SCRUM = seed('seed-scrum');
const ACCOUNTING = seed('seed-accounting');
const MUSIC_ONLINE = seed('seed-music-online');
const MUSIC_CLASS = seed('seed-music-class');
const SEEDS = [SCRUM, ACCOUNTING, MUSIC_ONLINE, MUSIC_CLASS];

const at = (key, hh, mm = 0) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm);
};
const act = (over) => validateActivity({ title: 'Thing', time: '09:00', repeat: { type: 'daily' }, ...over }).value;
const days = (a) => WEEK.filter((k) => occursOn(a, k));

describe('date keys', () => {
  test('reference week weekdays', () => {
    assert.deepEqual(WEEK.map(weekdayOf), [1, 2, 3, 4, 5, 6, 0]);
  });

  test('toDateKey / fromDateKey round trip at local midnight', () => {
    const d = fromDateKey('2026-01-05');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 0);
    assert.equal(d.getDate(), 5);
    assert.equal(d.getHours(), 0);
    assert.equal(toDateKey(d), '2026-01-05');
    assert.equal(toDateKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  });

  test('isDateKey', () => {
    assert.ok(isDateKey('2028-02-29'));
    assert.ok(!isDateKey('2026-02-29'));
    assert.ok(!isDateKey('2026-13-01'));
    assert.ok(!isDateKey('2026-1-01'));
    assert.ok(!isDateKey(null));
  });

  test('addDays: month/year ends, leap years, negatives', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01');
    assert.equal(addDays(TUE, 0), TUE);
    assert.equal(addDays(TUE, 30), '2026-12-03');
    assert.equal(addDays(TUE, -365), '2025-11-03');
  });

  test('addDays across US & EU DST transitions', () => {
    // US: 2026-03-08 (spring) and 2026-11-01 (fall). EU: 2026-03-29 and 2026-10-25.
    assert.equal(addDays('2026-03-07', 1), '2026-03-08');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-03-07', 2), '2026-03-09');
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
    assert.equal(addDays('2026-11-02', -2), '2026-10-31');
    assert.equal(addDays('2026-03-28', 1), '2026-03-29');
    assert.equal(addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(addDays('2026-10-24', 2), '2026-10-26');
    assert.equal(addDays('2026-10-26', -2), '2026-10-24');
  });

  test('addDays matches UTC calendar arithmetic for every day over 3 years', () => {
    let key = '2025-01-01';
    const base = Date.UTC(2025, 0, 1);
    for (let i = 1; i <= 3 * 366; i++) {
      key = addDays(key, 1);
      const ref = new Date(base + i * 86400000).toISOString().slice(0, 10);
      assert.equal(key, ref);
      assert.equal(weekdayOf(key), new Date(base + i * 86400000).getUTCDay());
    }
  });

  test('occurrence start keeps wall-clock time on DST days', () => {
    for (const key of ['2026-03-08', '2026-03-09', '2026-03-29', '2026-03-30', '2026-10-25', '2026-11-01', '2026-11-02']) {
      const s = occurrenceStart(MUSIC_CLASS, key);
      assert.equal(toDateKey(s), key);
      assert.equal(s.getHours(), 17);
      assert.equal(s.getMinutes(), 30);
    }
  });

  test('dayNumber is consecutive', () => {
    assert.equal(dayNumber('1970-01-02'), 1);
    assert.equal(dayNumber(addDays(TUE, 1)) - dayNumber(TUE), 1);
    assert.equal(dayNumber('2026-03-09') - dayNumber('2026-03-08'), 1);
  });
});

describe('times', () => {
  test('parseTime', () => {
    assert.deepEqual(parseTime('10:30'), { h: 10, m: 30 });
    assert.deepEqual(parseTime('7:05'), { h: 7, m: 5 });
    assert.deepEqual(parseTime('17:30:00'), { h: 17, m: 30 });
    assert.equal(parseTime('24:00'), null);
    assert.equal(parseTime('10:60'), null);
    assert.equal(parseTime('abc'), null);
    assert.equal(parseTime(null), null);
  });

  test('formatTime', () => {
    assert.equal(formatTime('10:30'), '10:30 AM');
    assert.equal(formatTime('17:30'), '5:30 PM');
    assert.equal(formatTime('00:05'), '12:05 AM');
    assert.equal(formatTime('12:00'), '12:00 PM');
    assert.equal(formatTime('17:30', { hour12: false }), '17:30');
    assert.equal(formatTime(null), 'Anytime');
    assert.equal(formatTime('nope'), '');
  });
});

describe('seeded routine from the brief', () => {
  test('defaults are valid and match the brief', () => {
    for (const a of DEFAULT_ACTIVITIES) {
      const v = validateActivity(a);
      assert.ok(v.ok, `${a.id}: ${JSON.stringify(v.errors)}`);
      assert.equal(a.remindBefore, 10);
      assert.ok(COLORS.includes(a.color));
    }
    assert.equal(SCRUM.time, '10:00');
    assert.equal(ACCOUNTING.time, '11:00');
    assert.equal(MUSIC_ONLINE.time, '10:30');
    assert.equal(MUSIC_CLASS.time, '17:30');
    assert.deepEqual(DEFAULT_SETTINGS, { planTime: '20:00', notifications: false, name: '', seeded: false });
  });

  test('scrum: Mon–Fri only, never weekends', () => {
    assert.deepEqual(days(SCRUM), [MON, TUE, WED, THU, FRI]);
    assert.equal(occursOn(SCRUM, SAT), false);
    assert.equal(occursOn(SCRUM, SUN), false);
  });

  test('accounting: Wednesdays at 11:00 only', () => {
    assert.deepEqual(days(ACCOUNTING), [WED]);
    assert.ok(occursOn(ACCOUNTING, addDays(WED, 7)));
    const s = occurrenceStart(ACCOUNTING, WED);
    assert.equal(s.getHours(), 11);
    assert.equal(s.getMinutes(), 0);
  });

  test('music online: Fridays at 10:30 only', () => {
    assert.deepEqual(days(MUSIC_ONLINE), [FRI]);
    const s = occurrenceStart(MUSIC_ONLINE, FRI);
    assert.equal(s.getHours(), 10);
    assert.equal(s.getMinutes(), 30);
  });

  test('music class: every day at 17:30', () => {
    assert.deepEqual(days(MUSIC_CLASS), WEEK);
    assert.equal(occurrenceStart(MUSIC_CLASS, SUN).getTime(), at(SUN, 17, 30).getTime());
  });
});

describe('occurrences', () => {
  test('skipDates remove a single occurrence', () => {
    const a = { ...SCRUM, skipDates: [WED] };
    assert.deepEqual(days(a), [MON, TUE, THU, FRI]);
  });

  test("'once' occurs only on its date", () => {
    const a = act({ repeat: { type: 'once', date: THU } });
    assert.deepEqual(days(a), [THU]);
    assert.equal(occursOn({ ...a, skipDates: [THU] }, THU), false);
  });

  test('weekly with multiple days', () => {
    assert.deepEqual(days(act({ repeat: { type: 'weekly', days: [1, 3, 5] } })), [MON, WED, FRI]);
  });

  test('occurrenceStart is null for anytime tasks', () => {
    assert.equal(occurrenceStart(act({ time: null }), TUE), null);
  });

  test('activitiesForDate orders by time, ties by title, anytime last', () => {
    const anyB = act({ title: 'B anytime', time: null });
    const anyA = act({ title: 'A anytime', time: '' });
    const early = act({ title: 'Zebra', time: '07:00' });
    const tieB = act({ title: 'Beta', time: '10:00' });
    const onceOther = act({ title: 'Other day', repeat: { type: 'once', date: THU } });
    const fri = activitiesForDate([...SEEDS, anyB, anyA, early, tieB, onceOther], FRI);
    assert.deepEqual(fri.map((a) => a.title), [
      'Zebra', 'Beta', 'Scrum', 'Music online session', 'Music class (evening)', 'A anytime', 'B anytime',
    ]);
    assert.deepEqual(activitiesForDate(SEEDS, SAT).map((a) => a.id), ['seed-music-class']);
    assert.deepEqual(activitiesForDate(SEEDS, WED).map((a) => a.id), ['seed-scrum', 'seed-accounting', 'seed-music-class']);
    assert.deepEqual(activitiesForDate([], WED), []);
  });
});

describe('nextUp', () => {
  test('next timed occurrence later today', () => {
    const n = nextUp(SEEDS, {}, at(TUE, 9, 0));
    assert.equal(n.activity.id, 'seed-scrum');
    assert.equal(n.dateKey, TUE);
    assert.equal(n.start.getTime(), at(TUE, 10).getTime());
    assert.equal(n.inProgress, false);
  });

  test('starting exactly now counts', () => {
    const n = nextUp(SEEDS, {}, at(WED, 11, 0));
    assert.equal(n.activity.id, 'seed-accounting');
    assert.equal(n.inProgress, true);
  });

  test('in-progress occurrence comes first', () => {
    // Accounting 11:00–12:00 is running at 11:30; music class at 17:30 is later.
    const n = nextUp(SEEDS, {}, at(WED, 11, 30));
    assert.equal(n.activity.id, 'seed-accounting');
    assert.equal(n.inProgress, true);
    assert.equal(n.end.getTime(), at(WED, 12).getTime());
  });

  test('completed occurrences are skipped (incl. in progress)', () => {
    const done = { [WED]: { 'seed-accounting': true } };
    const n = nextUp(SEEDS, done, at(WED, 11, 30));
    assert.equal(n.activity.id, 'seed-music-class');
    assert.equal(n.dateKey, WED);
  });

  test('rolls over to the next day after the last item', () => {
    const n = nextUp(SEEDS, {}, at(TUE, 19, 0));
    assert.equal(n.activity.id, 'seed-scrum');
    assert.equal(n.dateKey, WED);
  });

  test('rolls over the weekend: Sat evening -> Sun music class, Sun evening -> Mon scrum', () => {
    const satNight = nextUp(SEEDS, {}, at(SAT, 19, 0));
    assert.equal(satNight.activity.id, 'seed-music-class');
    assert.equal(satNight.dateKey, SUN);
    const weekdayOnly = [SCRUM, ACCOUNTING, MUSIC_ONLINE];
    const fri = nextUp(weekdayOnly, {}, at(FRI, 12, 0));
    assert.equal(fri.activity.id, 'seed-scrum');
    assert.equal(fri.dateKey, addDays(SUN, 1));
    assert.equal(fri.start.getTime(), at(addDays(SUN, 1), 10).getTime());
  });

  test('ignores anytime tasks and returns null when nothing in the next 7 days', () => {
    assert.equal(nextUp([act({ time: null })], {}, at(TUE, 9)), null);
    assert.equal(nextUp([act({ repeat: { type: 'once', date: addDays(TUE, 9) } })], {}, at(TUE, 9)), null);
    assert.equal(nextUp([], {}, at(TUE, 9)), null);
  });

  test('overlap at same start: tie broken by title', () => {
    const a = act({ title: 'Alpha', time: '10:00' });
    const n = nextUp([SCRUM, a], {}, at(TUE, 9));
    assert.equal(n.activity.title, 'Alpha');
  });
});

describe('upcomingReminders', () => {
  const settings = { ...DEFAULT_SETTINGS, planTime: '20:00' };

  test('activity reminders fire remindBefore minutes early with stable ids', () => {
    const r = upcomingReminders(SEEDS, settings, at(TUE, 8, 0), 12);
    const scrum = r.find((x) => x.activityId === 'seed-scrum');
    assert.equal(scrum.id, `seed-scrum@${TUE}`);
    assert.equal(scrum.kind, 'activity');
    assert.equal(scrum.dateKey, TUE);
    assert.equal(scrum.fireAt, at(TUE, 9, 50).getTime());
    assert.equal(scrum.startAt, at(TUE, 10).getTime());
    assert.match(scrum.title, /Scrum/);
    assert.match(scrum.body, /10:00 AM/);
    // 12h horizon from 08:00 -> up to 20:00 inclusive: scrum, music class, plan.
    assert.deepEqual(r.map((x) => x.id), [`seed-scrum@${TUE}`, `seed-music-class@${TUE}`, `plan@${TUE}`]);
  });

  test('sorted by fireAt across days', () => {
    const r = upcomingReminders(SEEDS, settings, at(TUE, 8, 0));
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].fireAt <= r[i].fireAt);
    // 48h from Tue 08:00 includes Wed accounting and Thu scrum (09:50 > Thu 08:00 -> excluded).
    assert.ok(r.some((x) => x.id === `seed-accounting@${WED}`));
    assert.ok(!r.some((x) => x.id === `seed-scrum@${THU}`));
  });

  test('window edges: (now - 15min, now + horizon]', () => {
    const fire = at(TUE, 9, 50).getTime();
    const ids = (now, h = 1) => upcomingReminders([SCRUM], { planTime: '23:59' }, new Date(now), h).map((x) => x.id);
    assert.deepEqual(ids(fire), [`seed-scrum@${TUE}`]); // fireAt == now
    assert.deepEqual(ids(fire + 14 * 60000), [`seed-scrum@${TUE}`]); // still in grace
    assert.deepEqual(ids(fire + 15 * 60000), []); // exactly 15 min late -> excluded
    assert.deepEqual(ids(fire - 60 * 60000), [`seed-scrum@${TUE}`]); // exactly at horizon -> included
    assert.deepEqual(ids(fire - 60 * 60000 - 1), []); // just beyond horizon
  });

  test('remindBefore 0 fires at start; skipped dates produce no reminder', () => {
    const a = { ...SCRUM, remindBefore: 0, skipDates: [WED] };
    const r = upcomingReminders([a], { planTime: '23:00' }, at(TUE, 0, 0), 48);
    assert.deepEqual(r.filter((x) => x.kind === 'activity').map((x) => x.id), [`seed-scrum@${TUE}`]);
    assert.equal(r[0].fireAt, at(TUE, 10).getTime());
    assert.match(r[0].body, /now/i);
  });

  test('anytime tasks never produce activity reminders', () => {
    const r = upcomingReminders([act({ time: null })], settings, at(TUE, 8), 48);
    assert.ok(r.every((x) => x.kind === 'plan'));
  });

  test('a reminder can fire on the previous day (long remindBefore across midnight)', () => {
    const early = act({ id: 'early', time: '00:10', remindBefore: 30 });
    const r = upcomingReminders([early], { planTime: '20:00' }, at(TUE, 23, 30), 1);
    assert.deepEqual(r.map((x) => x.id), [`early@${WED}`]);
    assert.equal(r[0].fireAt, at(TUE, 23, 40).getTime());
  });

  test('plan reminder: one per day at planTime, summarising tomorrow', () => {
    const r = upcomingReminders(SEEDS, settings, at(TUE, 8), 48);
    const plans = r.filter((x) => x.kind === 'plan');
    assert.deepEqual(plans.map((x) => x.id), [`plan@${TUE}`, `plan@${WED}`]);
    const tue = plans[0];
    assert.equal(tue.activityId, null);
    assert.equal(tue.startAt, null);
    assert.equal(tue.dateKey, TUE);
    assert.equal(tue.fireAt, at(TUE, 20).getTime());
    // Tomorrow (Wed): Scrum, Accounting, Music class.
    assert.equal(tue.body, 'Tomorrow: Scrum 10:00 AM, Accounting 11:00 AM, Music class (evening) 5:30 PM. Anything new to add?');
    // Wednesday evening previews Thursday: no accounting, no music online.
    assert.equal(plans[1].body, 'Tomorrow: Scrum 10:00 AM, Music class (evening) 5:30 PM. Anything new to add?');
  });

  test('plan reminder honours custom planTime and empty tomorrow', () => {
    const r = upcomingReminders([], { planTime: '21:15' }, at(TUE, 8), 24);
    assert.equal(r.length, 1);
    assert.equal(r[0].fireAt, at(TUE, 21, 15).getTime());
    assert.match(r[0].body, /wide open/);
    assert.match(r[0].body, /Anything new to add\?/);
  });

  test('plan body mentions anytime items and truncates long lists', () => {
    const many = Array.from({ length: 7 }, (_, i) => act({ title: `T${i}`, time: `0${i}:00` }));
    const r = upcomingReminders([...many, act({ title: 'Call mum', time: null })], { planTime: '20:00' }, at(TUE, 19), 2);
    const plan = r.find((x) => x.kind === 'plan');
    assert.match(plan.body, /^Tomorrow: T0 12:00 AM, T1 1:00 AM/);
    assert.match(plan.body, /\+3 more\. Anything new to add\?$/);
  });
});

describe('tomorrowSummary', () => {
  test('splits routine and one-offs for tomorrow', () => {
    const dentist = act({ title: 'Dentist', time: '15:00', repeat: { type: 'once', date: WED } });
    const later = act({ title: 'Later', repeat: { type: 'once', date: THU } });
    const s = tomorrowSummary([...SEEDS, dentist, later], TUE);
    assert.equal(s.dateKey, WED);
    assert.deepEqual(s.items.map((a) => a.title), ['Scrum', 'Accounting', 'Dentist', 'Music class (evening)']);
    assert.deepEqual(s.routine.map((a) => a.title), ['Scrum', 'Accounting', 'Music class (evening)']);
    assert.deepEqual(s.oneOffs.map((a) => a.title), ['Dentist']);
  });

  test('Friday -> Saturday only has music class', () => {
    const s = tomorrowSummary(SEEDS, FRI);
    assert.equal(s.dateKey, SAT);
    assert.deepEqual(s.items.map((a) => a.id), ['seed-music-class']);
    assert.deepEqual(s.oneOffs, []);
  });
});

describe('describeRepeat', () => {
  test('labels', () => {
    assert.equal(describeRepeat({ type: 'daily' }), 'Every day');
    assert.equal(describeRepeat({ type: 'weekdays' }), 'Weekdays');
    assert.equal(describeRepeat({ type: 'weekly', days: [3] }), 'Every Wed');
    assert.equal(describeRepeat({ type: 'weekly', days: [5] }), 'Every Fri');
    assert.equal(describeRepeat({ type: 'weekly', days: [1, 3, 5] }), 'Mon, Wed & Fri');
    assert.equal(describeRepeat({ type: 'weekly', days: [2, 4] }), 'Tue & Thu');
    assert.equal(describeRepeat({ type: 'weekly', days: [0, 1] }), 'Mon & Sun');
    assert.equal(describeRepeat({ type: 'weekly', days: [0, 6] }), 'Weekends');
    assert.equal(describeRepeat({ type: 'weekly', days: [1, 2, 3, 4, 5] }), 'Weekdays');
    assert.equal(describeRepeat({ type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6] }), 'Every day');
    assert.equal(describeRepeat({ type: 'once', date: '2026-11-04' }), 'Once · Wed, 4 Nov');
    assert.equal(describeRepeat({ type: 'once', date: TUE }), 'Once · Tue, 3 Nov');
  });
});

describe('validateActivity', () => {
  const now = at(TUE, 9);

  test('fills defaults and normalises', () => {
    const { ok, errors, value } = validateActivity({ title: '  Yoga   class ', time: '7:05' }, { now });
    assert.ok(ok, JSON.stringify(errors));
    assert.equal(value.title, 'Yoga class');
    assert.equal(value.time, '07:05');
    assert.equal(value.emoji, '✨');
    assert.equal(value.remindBefore, 10);
    assert.equal(value.durationMin, null);
    assert.deepEqual(value.repeat, { type: 'once', date: TUE });
    assert.deepEqual(value.skipDates, []);
    assert.equal(value.notes, '');
    assert.equal(value.color, 'sun');
    assert.equal(value.createdAt, now.getTime());
    assert.equal(typeof value.id, 'string');
    assert.ok(value.id.length > 0);
  });

  test('keeps id/createdAt, sorts weekly days, dedupes skipDates, anytime', () => {
    const { value } = validateActivity({
      id: 'x', createdAt: 5, title: 'T', time: '', emoji: '🎹🎶', color: 'mint',
      repeat: { type: 'weekly', days: [5, '1', 5, 9] }, skipDates: [WED, 'bad', WED, MON], remindBefore: '0', durationMin: '45',
    });
    assert.equal(value.id, 'x');
    assert.equal(value.createdAt, 5);
    assert.equal(value.time, null);
    assert.equal(value.emoji, '🎹');
    assert.equal(value.color, 'mint');
    assert.deepEqual(value.repeat, { type: 'weekly', days: [1, 5] });
    assert.deepEqual(value.skipDates, [MON, WED]);
    assert.equal(value.remindBefore, 0);
    assert.equal(value.durationMin, 45);
  });

  test('generates unique ids', () => {
    const a = validateActivity({ title: 'a' }).value.id;
    const b = validateActivity({ title: 'a' }).value.id;
    assert.notEqual(a, b);
  });

  test('errors', () => {
    const r = validateActivity({
      title: '   ', time: '25:00', durationMin: -5, remindBefore: 'soon', repeat: { type: 'weekly', days: [] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.value, null);
    assert.deepEqual(Object.keys(r.errors).sort(), ['durationMin', 'remindBefore', 'repeat', 'time', 'title']);

    assert.ok(validateActivity({ title: 'x'.repeat(81) }).errors.title);
    assert.ok(validateActivity({ title: 'x'.repeat(80) }).ok);
    assert.ok(validateActivity({ title: 'x', repeat: { type: 'monthly' } }).errors.repeat);
    assert.ok(validateActivity({ title: 'x', repeat: { type: 'once', date: '2026-02-30' } }).errors.repeat);
    assert.ok(validateActivity({ title: 'x', notes: 'n'.repeat(1001) }).errors.notes);
    assert.equal(validateActivity(null).ok, false);
  });
});

describe('streak', () => {
  const created = at('2026-01-01', 9).getTime();
  const routine = [{ ...SCRUM, createdAt: created }, { ...MUSIC_CLASS, createdAt: created }];
  const doneDay = (key) => Object.fromEntries(activitiesForDate(routine, key).map((a) => [a.id, true]));

  test('counts consecutive perfect days up to yesterday, weekends included', () => {
    const c = {};
    for (const k of ['2026-10-30', '2026-10-31', '2026-11-01', MON]) c[k] = doneDay(k);
    // Fri 30 Oct … Mon 2 Nov all done; Thu 29 Oct missed.
    assert.equal(streak(c, routine, TUE), 4);
  });

  test('today adds one only when everything today is done', () => {
    const c = { [MON]: doneDay(MON), [TUE]: { 'seed-scrum': true } };
    assert.equal(streak(c, routine, TUE), 1);
    c[TUE] = doneDay(TUE);
    assert.equal(streak(c, routine, TUE), 2);
  });

  test('days with no occurrences do not break the streak', () => {
    const weekdayOnly = [{ ...SCRUM, createdAt: created }];
    const c = { '2026-10-30': { 'seed-scrum': true }, [MON]: { 'seed-scrum': true } };
    // Sat/Sun have nothing scheduled.
    assert.equal(streak(c, weekdayOnly, TUE), 2);
  });

  test('occurrences before an activity was created are ignored; zero when nothing done', () => {
    assert.equal(streak({}, routine, TUE), 0);
    const fresh = [{ ...MUSIC_CLASS, createdAt: at(MON, 8).getTime() }];
    assert.equal(streak({ [MON]: { 'seed-music-class': true } }, fresh, TUE), 1);
    // Adding a brand-new routine today doesn't break yesterday's streak.
    const plusNew = [...fresh, act({ id: 'new', createdAt: at(TUE, 8).getTime() })];
    assert.equal(streak({ [MON]: { 'seed-music-class': true } }, plusNew, TUE), 1);
  });

  test('caps lookback at 365 days', () => {
    const c = {};
    for (let i = 1; i <= 400; i++) { const k = addDays(TUE, -i); c[k] = doneDay(k); }
    assert.equal(streak(c, routine.map((a) => ({ ...a, createdAt: 0 })), TUE), 365);
  });
});

describe('greeting & encouragement', () => {
  test('greeting by time of day', () => {
    assert.equal(greeting(at(TUE, 8), 'Kavya'), 'Good morning, Kavya');
    assert.equal(greeting(at(TUE, 13)), 'Good afternoon');
    assert.equal(greeting(at(TUE, 19), '  '), 'Good evening');
    assert.match(greeting(at(TUE, 2)), /night owl/);
  });

  test('encouragement is deterministic with >= 20 options', () => {
    assert.ok(ENCOURAGEMENTS.length >= 20);
    assert.equal(encouragement(42), encouragement(42));
    assert.equal(typeof encouragement(-7), 'string');
    assert.equal(typeof encouragement(NaN), 'string');
    assert.notEqual(encouragement(dayNumber(TUE)), encouragement(dayNumber(WED)));
    const seen = new Set(Array.from({ length: ENCOURAGEMENTS.length }, (_, i) => encouragement(i)));
    assert.equal(seen.size, ENCOURAGEMENTS.length);
  });
});

describe('store.pruneCompletions', () => {
  test('drops days older than keepDays, keeps recent and future', () => {
    const c = { '2020-01-01': { a: true }, [addDays(TUE, -10)]: { a: true }, [TUE]: { b: true }, [WED]: { c: true }, junk: {} };
    const p = pruneCompletions(c, TUE, 5);
    assert.deepEqual(Object.keys(p).sort(), [TUE, WED]);
    assert.deepEqual(Object.keys(pruneCompletions(c, TUE)).sort(), [addDays(TUE, -10), TUE, WED]);
  });
});
