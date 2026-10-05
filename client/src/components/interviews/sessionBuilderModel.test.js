import { describe, it, expect } from 'vitest';
import {
  BUSY,
  FREE,
  SILENT,
  appendRows,
  buildPayload,
  duplicateRow,
  fillRange,
  fillShape,
  findClashes,
  isFreeAt,
  makeRow,
  nextRow,
  pickerOptions,
  sharedRooms,
  summarize,
  validateRow,
} from './sessionBuilderModel';

const firstRound = { interviewType: 'ROUND_ONE', location: 'Bunche 2156', day: '2026-10-06' };
const coffee = { interviewType: 'COFFEE_CHAT', location: 'Covel', day: '2026-10-06' };

// 2026-10-06 is in daylight time: 9:00 Pacific is 16:00Z.
const at = (hhmm) => new Date(`2026-10-06T${String(Number(hhmm.slice(0, 2)) + 7).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`);

describe('row defaults', () => {
  it('starts first round as an hour-long panel of four with two interviewers', () => {
    const row = makeRow({}, firstRound);
    expect(row).toMatchObject({ start: '09:00', end: '10:00', candidateCapacity: 4, interviewerCapacity: 2, groupSize: '' });
    expect(row.location).toBe('Bunche 2156');
  });

  it('starts coffee chat as a two-hour block of forty in groups of two', () => {
    expect(makeRow({}, coffee)).toMatchObject({ start: '09:00', end: '11:00', candidateCapacity: 40, groupSize: 2 });
  });

  it('gives every row its own key, including copies', () => {
    const row = makeRow({}, firstRound);
    expect(duplicateRow(row).key).not.toBe(row.key);
  });
});

describe('nextRow', () => {
  it('opens at 9:00 on the default day when there is nothing yet', () => {
    expect(nextRow([], firstRound)).toMatchObject({ day: '2026-10-06', start: '09:00', end: '10:00' });
  });

  it('starts where the last one ends, keeping its length, place and seats but not its people', () => {
    const last = makeRow(
      { start: '10:00', end: '10:45', location: 'YRL 2', candidateCapacity: 6, interviewerIds: ['u1'] },
      firstRound
    );
    expect(nextRow([last], firstRound)).toMatchObject({
      day: '2026-10-06',
      start: '10:45',
      end: '11:30',
      location: 'YRL 2',
      candidateCapacity: 6,
      interviewerIds: [],
    });
  });

  it('keeps a coffee chat group size', () => {
    const last = makeRow({ groupSize: 3 }, coffee);
    expect(nextRow([last], coffee).groupSize).toBe(3);
  });
});

describe('fillRange', () => {
  it('lays out back-to-back sessions across the range', () => {
    const rows = fillRange({ day: '2026-10-06', start: '09:00', end: '12:00', minutes: 60, rooms: 1, seats: 4 }, firstRound);
    expect(rows.map((r) => [r.start, r.end])).toEqual([
      ['09:00', '10:00'],
      ['10:00', '11:00'],
      ['11:00', '12:00'],
    ]);
  });

  it('runs several rooms at each time', () => {
    const rows = fillRange({ day: '2026-10-06', start: '09:00', end: '11:00', minutes: 60, rooms: 3, seats: 5 }, firstRound);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.start === '09:00')).toHaveLength(3);
    expect(rows.every((r) => r.candidateCapacity === 5 && r.location === 'Bunche 2156')).toBe(true);
  });

  it('stops at the last session that fits rather than running past the end', () => {
    const rows = fillRange({ day: '2026-10-06', start: '09:00', end: '11:30', minutes: 45, rooms: 1 }, firstRound);
    expect(rows.map((r) => r.start)).toEqual(['09:00', '09:45', '10:30']);
    expect(rows[rows.length - 1].end).toBe('11:15');
  });

  it('previews the same count the fill makes', () => {
    const fill = { day: '2026-10-06', start: '09:00', end: '17:00', minutes: 60, rooms: 3 };
    expect(fillShape(fill)).toEqual({ times: 8, rooms: 3, total: 24 });
    expect(fillRange(fill, firstRound)).toHaveLength(24);
    expect(fillShape({ ...fill, end: '11:30', minutes: 45, rooms: 1 }).total).toBe(3);
  });

  it('makes nothing from a backwards range', () => {
    expect(fillRange({ day: '2026-10-06', start: '12:00', end: '09:00', minutes: 60, rooms: 2 }, firstRound)).toEqual([]);
  });

  it('replaces the untouched opening row instead of leaving it in front', () => {
    const opening = { ...makeRow({}, firstRound), pristine: true };
    const filled = fillRange({ day: '2026-10-06', start: '13:00', end: '14:00', minutes: 60, rooms: 2 }, firstRound);
    expect(appendRows([opening], filled)).toEqual(filled);
    const touched = { ...opening, pristine: false };
    expect(appendRows([touched], filled)).toHaveLength(3);
  });
});

describe('availability', () => {
  const windows = [{ startTime: at('09:00').toISOString(), endTime: at('11:00').toISOString() }];

  it('counts someone free only when one window covers the whole session', () => {
    expect(isFreeAt(windows, at('09:00'), at('10:00'))).toBe(true);
    expect(isFreeAt(windows, at('10:00'), at('11:00'))).toBe(true);
    expect(isFreeAt(windows, at('10:30'), at('11:30'))).toBe(false);
    expect(isFreeAt([], at('09:00'), at('10:00'))).toBe(false);
  });

  it('orders the picker free, then busy, then silent, and leaves nobody out', () => {
    const staff = [
      { id: 'u3', fullName: 'Cleo Silent', responded: false },
      { id: 'u2', fullName: 'Ben Busy', responded: true },
      { id: 'u1', fullName: 'Ada Free', responded: true },
    ];
    const byUser = new Map([
      ['u1', windows],
      ['u2', [{ startTime: at('13:00').toISOString(), endTime: at('14:00').toISOString() }]],
    ]);
    const options = pickerOptions(staff, byUser, at('09:00'), at('10:00'));
    expect(options.map((o) => [o.user.id, o.group])).toEqual([
      ['u1', FREE],
      ['u2', BUSY],
      ['u3', SILENT],
    ]);
  });
});

describe('findClashes', () => {
  it('flags one person on two draft sessions that overlap', () => {
    const a = makeRow({ start: '09:00', end: '10:00', interviewerIds: ['u1'] }, firstRound);
    const b = makeRow({ start: '09:30', end: '10:30', interviewerIds: ['u1', 'u2'] }, firstRound);
    const clashes = findClashes([a, b]);
    expect(clashes[a.key]).toEqual({ u1: ['new session 2'] });
    expect(clashes[b.key]).toEqual({ u1: ['new session 1'] });
  });

  it('lets back-to-back sessions share a person', () => {
    const a = makeRow({ start: '09:00', end: '10:00', interviewerIds: ['u1'] }, firstRound);
    const b = makeRow({ start: '10:00', end: '11:00', interviewerIds: ['u1'] }, firstRound);
    expect(findClashes([a, b])).toEqual({});
  });

  it('flags a person already on an existing session at that time', () => {
    const row = makeRow({ start: '09:00', end: '10:00', interviewerIds: ['u1'] }, firstRound);
    const existing = [
      { id: 's1', label: 'Group 1A', startTime: at('09:30').toISOString(), endTime: at('10:30').toISOString(), assigned: [{ id: 'u1' }] },
      { id: 's2', label: 'Group 1B', startTime: at('09:00').toISOString(), endTime: at('10:00').toISOString(), assigned: [{ id: 'u9' }] },
    ];
    expect(findClashes([row], existing)).toEqual({ [row.key]: { u1: ['Group 1A'] } });
  });

  it('notices two parallel sessions left in the same room', () => {
    const a = makeRow({ start: '09:00', end: '10:00' }, firstRound);
    const b = makeRow({ start: '09:00', end: '10:00' }, firstRound);
    const c = makeRow({ start: '09:00', end: '10:00', location: 'YRL 2' }, firstRound);
    expect([...sharedRooms([a, b, c])]).toEqual([a.key, b.key]);
  });
});

describe('validation and payload', () => {
  it('refuses a session that ends before it starts, or has no day', () => {
    expect(validateRow(makeRow({ start: '10:00', end: '09:00' }, firstRound))).toEqual({ end: 'Must end after it starts' });
    expect(validateRow(makeRow({}, { ...firstRound, day: '' }))).toEqual({ day: 'Pick a day' });
    expect(validateRow(makeRow({ candidateCapacity: '2.5' }, firstRound))).toEqual({ candidateCapacity: 'Whole number' });
  });

  it('builds instants in Pacific, whatever zone the browser is in', () => {
    const row = makeRow(
      { label: '  Group 1A ', start: '09:00', end: '10:00', interviewerIds: ['u1', 'u2'], interviewerCapacity: '' },
      firstRound
    );
    expect(buildPayload([row], firstRound)).toEqual({
      sessions: [
        {
          label: 'Group 1A',
          startTime: '2026-10-06T16:00:00.000Z',
          endTime: '2026-10-06T17:00:00.000Z',
          // Still the interview's own, so it is inherited rather than copied.
          location: null,
          candidateCapacity: 4,
          groupSize: null,
          interviewerCapacity: null,
          interviewerIds: ['u1', 'u2'],
        },
      ],
    });
  });

  it('sends the default location as null so the session inherits it', () => {
    const same = makeRow({ location: ' bunche 2156 ' }, firstRound);
    const other = makeRow({ location: 'YRL 2' }, firstRound);
    const [inherited, own] = buildPayload([same, other], firstRound).sessions;
    expect(inherited.location).toBeNull();
    expect(own.location).toBe('YRL 2');
  });

  it('sends a coffee chat group size, and a blank name or location as null', () => {
    const row = makeRow({ location: ' ', candidateCapacity: '40', groupSize: '3' }, coffee);
    expect(buildPayload([row], coffee).sessions[0]).toMatchObject({
      label: null,
      location: null,
      candidateCapacity: 40,
      groupSize: 3,
    });
  });

  it('adds up sessions, seats and placements', () => {
    const rows = [
      makeRow({ candidateCapacity: 4, interviewerIds: ['u1', 'u2'] }, firstRound),
      makeRow({ candidateCapacity: '6', interviewerIds: ['u3'] }, firstRound),
    ];
    expect(summarize(rows)).toEqual({ sessions: 2, seats: 10, placements: 3 });
  });
});
