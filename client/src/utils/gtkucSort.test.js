import { describe, expect, it } from 'vitest';
import { ATTENDANCE_SORT_KEYS, SLOT_SORT_KEYS, nextSort, sortRows } from './gtkucSort';

const NOW = new Date('2026-10-01T18:00:00Z');

const slot = (id, overrides = {}) => ({
  id,
  member: { fullName: `Host ${id}` },
  location: 'Kerckhoff',
  startTime: '2026-10-02T18:00:00Z',
  endTime: null,
  capacity: 2,
  signups: [],
  ...overrides
});

const ids = (rows) => rows.map((r) => r.id);

describe('sortRows on time slots', () => {
  const slots = [
    slot('b', { member: { fullName: 'bea' }, startTime: '2026-10-03T18:00:00Z' }),
    slot('a', { member: { fullName: 'Al' }, startTime: '2026-10-02T18:00:00Z' }),
    slot('c', { member: null, startTime: '2026-10-01T17:30:00Z' })
  ];

  it('sorts hosts case-insensitively and puts a missing host last either way', () => {
    expect(ids(sortRows(slots, SLOT_SORT_KEYS, { field: 'host', dir: 'asc' }))).toEqual(['a', 'b', 'c']);
    expect(ids(sortRows(slots, SLOT_SORT_KEYS, { field: 'host', dir: 'desc' }))).toEqual(['b', 'a', 'c']);
  });

  it('sorts by start time', () => {
    expect(ids(sortRows(slots, SLOT_SORT_KEYS, { field: 'start', dir: 'asc' }))).toEqual(['c', 'a', 'b']);
  });

  it('orders status as happening now, upcoming, past', () => {
    const mixed = [
      slot('past', { startTime: '2026-09-30T18:00:00Z' }),
      slot('up', { startTime: '2026-10-05T18:00:00Z' }),
      slot('now', { startTime: '2026-10-01T17:45:00Z' })
    ];
    expect(ids(sortRows(mixed, SLOT_SORT_KEYS, { field: 'status', dir: 'asc' }, { now: NOW })))
      .toEqual(['now', 'up', 'past']);
  });

  it('breaks ties with the tiebreak column, ascending', () => {
    const tied = [
      slot('late', { location: 'Ackerman', startTime: '2026-10-09T18:00:00Z' }),
      slot('early', { location: 'Ackerman', startTime: '2026-10-02T18:00:00Z' })
    ];
    expect(ids(sortRows(tied, SLOT_SORT_KEYS, { field: 'location', dir: 'desc' }, { tiebreak: 'start' })))
      .toEqual(['early', 'late']);
  });

  it('sorts by signups, open spots and attended counts', () => {
    const counted = [
      slot('full', { capacity: 2, signups: [{ attended: true }, { attended: true }] }),
      slot('empty', { capacity: 3, signups: [] }),
      slot('half', { capacity: 2, signups: [{ attended: false }] })
    ];
    expect(ids(sortRows(counted, SLOT_SORT_KEYS, { field: 'signups', dir: 'desc' }))).toEqual(['full', 'half', 'empty']);
    expect(ids(sortRows(counted, SLOT_SORT_KEYS, { field: 'openSpots', dir: 'desc' }))).toEqual(['empty', 'half', 'full']);
    expect(ids(sortRows(counted, SLOT_SORT_KEYS, { field: 'attended', dir: 'desc' }))).toEqual(['full', 'empty', 'half']);
  });

  it('returns rows untouched for an unknown field', () => {
    expect(sortRows(slots, SLOT_SORT_KEYS, { field: 'nope', dir: 'asc' })).toBe(slots);
  });
});

describe('sortRows on attendance', () => {
  const rows = [
    { id: 1, fullName: 'Zed', studentId: '905000010', attended: false, createdAt: '2026-09-20T00:00:00Z', slot: slot('x') },
    { id: 2, fullName: 'amy', studentId: '905000002', attended: true, createdAt: '2026-09-22T00:00:00Z', slot: slot('y', { startTime: '2026-10-01T00:00:00Z' }) },
    { id: 3, fullName: 'Bo', studentId: null, attended: false, createdAt: '2026-09-21T00:00:00Z', slot: slot('z') }
  ];

  it('sorts candidates by name', () => {
    expect(ids(sortRows(rows, ATTENDANCE_SORT_KEYS, { field: 'candidate', dir: 'asc' }))).toEqual([2, 3, 1]);
  });

  it('compares student IDs numerically and puts blanks last', () => {
    expect(ids(sortRows(rows, ATTENDANCE_SORT_KEYS, { field: 'studentId', dir: 'asc' }))).toEqual([2, 1, 3]);
    expect(ids(sortRows(rows, ATTENDANCE_SORT_KEYS, { field: 'studentId', dir: 'desc' }))).toEqual([1, 2, 3]);
  });

  it('puts attendees first when sorting present descending', () => {
    expect(ids(sortRows(rows, ATTENDANCE_SORT_KEYS, { field: 'present', dir: 'desc' }))[0]).toBe(2);
  });

  it('sorts by slot time and by signup time', () => {
    expect(ids(sortRows(rows, ATTENDANCE_SORT_KEYS, { field: 'slot', dir: 'asc' }))[0]).toBe(2);
    expect(ids(sortRows(rows, ATTENDANCE_SORT_KEYS, { field: 'signedUp', dir: 'asc' }))).toEqual([1, 3, 2]);
  });
});

describe('nextSort', () => {
  it('flips the active column', () => {
    expect(nextSort({ field: 'host', dir: 'asc' }, 'host')).toEqual({ field: 'host', dir: 'desc' });
    expect(nextSort({ field: 'host', dir: 'desc' }, 'host')).toEqual({ field: 'host', dir: 'asc' });
  });

  it('starts text and dates ascending, counts descending', () => {
    expect(nextSort({ field: 'host', dir: 'asc' }, 'start')).toEqual({ field: 'start', dir: 'asc' });
    expect(nextSort({ field: 'host', dir: 'asc' }, 'signups')).toEqual({ field: 'signups', dir: 'desc' });
  });
});
