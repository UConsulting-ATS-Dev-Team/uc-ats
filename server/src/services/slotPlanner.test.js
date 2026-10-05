import { describe, it, expect } from 'vitest';
import {
  MAX_CUSTOM_SESSIONS,
  assignIds,
  combine,
  defaultSpecFor,
  planBlocks,
  planCadence,
  planCustomSessions,
  planSessions,
  widenRange,
} from './slotPlanner.js';

// Read back in Los Angeles, not in whatever zone the test runner is in. Reading
// with getHours() passed on a laptop in Pacific time and hid that the server,
// which runs in UTC, stored 9:00 as 9:00 UTC - 2 AM for everyone using it.
const hhmm = (date) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);

const DAY = '2027-01-15';

describe('combine', () => {
  it('puts a wall-clock time on a calendar day', () => {
    expect(hhmm(combine(DAY, '09:30'))).toBe('09:30');
  });

  it('reads the time as Los Angeles time, whatever zone the server is in', () => {
    // January is PST (UTC-8); October is PDT (UTC-7).
    expect(combine('2027-01-15', '09:00').toISOString()).toBe('2027-01-15T17:00:00.000Z');
    expect(combine('2026-10-06', '09:00').toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(combine('2026-10-06', '17:00').toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });

  it('returns null rather than an Invalid Date', () => {
    // A nullish answer is checkable; an Invalid Date propagates silently into a
    // slot row and surfaces as a session in 1970.
    expect(combine(null, '09:00')).toBeNull();
    expect(combine(DAY, null)).toBeNull();
    expect(combine(DAY, 'lunchtime')).toBeNull();
  });
});

describe('planBlocks — the coffee chat shape', () => {
  it('makes one session per named block, keeping its capacity', () => {
    const rows = planBlocks(DAY, [
      { label: 'Morning Session', start: '09:00', end: '11:00', capacity: 20, interviewers: 4 },
      { label: 'Afternoon Session', start: '14:00', end: '16:00', capacity: 25 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: 'Morning Session', candidateCapacity: 20, interviewerCapacity: 4 });
    // Named sittings run in rotation groups, so bookings get labelled from the
    // first one rather than waiting for somebody to set it.
    expect(rows[0].groupSize).toBe(2);
    expect(hhmm(rows[0].startTime)).toBe('09:00');
    expect(rows[1].candidateCapacity).toBe(25);
    expect(rows[1].interviewerCapacity).toBeNull();
  });

  it('rejects a block that ends before it starts, by name', () => {
    expect(() => planBlocks(DAY, [{ label: 'Evening', start: '18:00', end: '17:00' }])).toThrow(/Evening/);
  });

  it('rejects a block with a missing time', () => {
    expect(() => planBlocks(DAY, [{ label: 'Morning', start: '09:00' }])).toThrow(/start and an end/);
  });

  it('treats a blank capacity as "not open to candidates", not zero', () => {
    // Null and 0 mean different things: one is a staff-only sitting, the other
    // is a sitting that is full.
    const [row] = planBlocks(DAY, [{ label: 'Held', start: '09:00', end: '10:00', capacity: '' }]);
    expect(row.candidateCapacity).toBeNull();
  });
});

describe('planCadence — the first round shape', () => {
  it('fills the day with back-to-back sessions', () => {
    const rows = planCadence(DAY, { start: '08:00', end: '12:00', minutes: 60, capacity: 4 });
    expect(rows.map((r) => hhmm(r.startTime))).toEqual(['08:00', '09:00', '10:00', '11:00']);
    expect(rows.every((r) => r.candidateCapacity === 4)).toBe(true);
    expect(rows.every((r) => r.label === null)).toBe(true);
  });

  it('never runs past the end of the day', () => {
    // 08:00-11:30 at 60 minutes fits three, not three and a half.
    const rows = planCadence(DAY, { start: '08:00', end: '11:30', minutes: 60 });
    expect(rows).toHaveLength(3);
    expect(hhmm(rows[2].endTime)).toBe('11:00');
  });

  it('skips a break and resumes at the end of it', () => {
    // Resuming at the end of the break rather than stepping one session keeps
    // the afternoon on the hour instead of shifting it by the break length.
    const rows = planCadence(DAY, {
      start: '11:00',
      end: '15:00',
      minutes: 60,
      breaks: [{ start: '12:00', end: '13:00' }],
    });
    expect(rows.map((r) => hhmm(r.startTime))).toEqual(['11:00', '13:00', '14:00']);
  });

  it('handles a break that does not align to the session length', () => {
    // The 09:00 sitting would run into a 09:30 break, so it is dropped and the
    // day restarts at 10:15 - off the hour, which is correct: the break is
    // where it is, not where a tidy schedule would like it to be.
    const rows = planCadence(DAY, {
      start: '09:00',
      end: '12:15',
      minutes: 60,
      breaks: [{ start: '09:30', end: '10:15' }],
    });
    expect(rows.map((r) => hhmm(r.startTime))).toEqual(['10:15', '11:15']);
  });

  it('drops a sitting that would only partly fit before the day ends', () => {
    const rows = planCadence(DAY, {
      start: '09:00',
      end: '12:00',
      minutes: 60,
      breaks: [{ start: '09:30', end: '10:15' }],
    });
    // 10:15 runs to 11:15; the next would end at 12:15, past the close.
    expect(rows.map((r) => hhmm(r.startTime))).toEqual(['10:15']);
  });

  it('rejects a schedule that cannot produce anything', () => {
    expect(() => planCadence(DAY, { start: '09:00', end: '09:30', minutes: 60 })).toThrow(/no sessions/);
    expect(() => planCadence(DAY, { start: '17:00', end: '09:00', minutes: 60 })).toThrow(/ends before/);
    expect(() => planCadence(DAY, { start: '09:00', end: '17:00', minutes: 0 })).toThrow(/length in minutes/);
  });

  it('stops well before a typo can ask for thousands of rows', () => {
    const rows = planCadence(DAY, { start: '00:00', end: '23:59', minutes: 1 });
    expect(rows.length).toBeLessThanOrEqual(60);
  });
});

describe('planSessions', () => {
  it('picks the shape from what it was given', () => {
    expect(planSessions({ day: DAY, blocks: [{ label: 'A', start: '09:00', end: '10:00' }] })).toHaveLength(1);
    expect(planSessions({ day: DAY, cadence: { start: '09:00', end: '11:00', minutes: 60 } })).toHaveLength(2);
  });

  it('allows an interview with no sessions decided yet', () => {
    expect(planSessions({ day: DAY })).toEqual([]);
    expect(planSessions({})).toEqual([]);
  });
});

describe('defaultSpecFor', () => {
  it('offers coffee chats two named sittings', () => {
    const spec = defaultSpecFor('COFFEE_CHAT');
    expect(spec.mode).toBe('blocks');
    expect(spec.blocks.map((b) => b.label)).toEqual(['Morning Session', 'Afternoon Session']);
  });

  it('offers first round a time frame and no sessions', () => {
    // Groups come after availability, not before it: how many run at once is
    // decided by how many interviewers turn out to be free, so creating them
    // up front asks the question before the answer exists.
    const spec = defaultSpecFor('ROUND_ONE');
    expect(spec.mode).toBe('range');
    expect(spec.range).toEqual({ start: '08:00', end: '17:00' });
    expect(spec.cadence).toBeUndefined();
  });

  it('offers the final round a time frame too', () => {
    expect(defaultSpecFor('FINAL_ROUND').mode).toBe('range');
  });

  it('still plans a schedule for anyone who asks for one', () => {
    // Range is the default, not the only option - the cadence planner is
    // untouched and is what "create the groups" uses later.
    expect(planSessions({
      day: '2026-10-06',
      cadence: { start: '09:00', end: '11:00', minutes: 60, capacity: 4 },
    })).toHaveLength(2);
  });
});

describe('planCadence — more than one interview at a time', () => {
  it('makes a session per room at each sitting', () => {
    // Three panels at 9, three at 10. Each is its own session because each has
    // its own four candidates and its own interviewers.
    const rows = planCadence(DAY, { start: '09:00', end: '11:00', minutes: 60, capacity: 4, parallel: 3 });
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => hhmm(r.startTime) === '09:00')).toHaveLength(3);
    expect(rows.every((r) => r.candidateCapacity === 4)).toBe(true);
  });

  it('names the rooms so two sessions at the same hour are tellable apart', () => {
    const rows = planCadence(DAY, { start: '09:00', end: '10:00', minutes: 60, parallel: 2 });
    expect(rows.map((r) => r.label)).toEqual(['Room 1', 'Room 2']);
  });

  it('uses the names given rather than inventing them', () => {
    const rows = planCadence(DAY, {
      start: '09:00', end: '10:00', minutes: 60, parallel: 2,
      rooms: ['Anderson 1234', 'Covel B'],
    });
    expect(rows.map((r) => r.label)).toEqual(['Anderson 1234', 'Covel B']);
  });

  it('leaves a single session unnamed, because the time is its name', () => {
    const rows = planCadence(DAY, { start: '09:00', end: '10:00', minutes: 60, parallel: 1 });
    expect(rows[0].label).toBeNull();
  });

  it('counts the day in sittings, not rows', () => {
    // Four rooms must not cut the day to a quarter of its length.
    const rows = planCadence(DAY, { start: '08:00', end: '17:00', minutes: 60, parallel: 4 });
    var distinct = new Set(rows.map((r) => hhmm(r.startTime)));
    expect(distinct.size).toBe(9);
    expect(rows).toHaveLength(36);
  });

  it('treats a nonsense room count as one', () => {
    expect(planCadence(DAY, { start: '09:00', end: '10:00', minutes: 60, parallel: 0 })).toHaveLength(1);
    expect(planCadence(DAY, { start: '09:00', end: '10:00', minutes: 60, parallel: 'lots' })).toHaveLength(1);
  });
});

describe('planCustomSessions — sessions built from the availability grid', () => {
  const session = (overrides = {}) => ({
    startTime: '2026-10-06T16:00:00.000Z',
    endTime: '2026-10-06T17:00:00.000Z',
    ...overrides,
  });

  it('normalises each row into a slot and its interviewers', () => {
    const [row] = planCustomSessions([
      session({
        label: '  Panel A  ',
        location: ' Kerckhoff 133 ',
        candidateCapacity: '4',
        groupSize: 2,
        interviewerCapacity: 3,
        interviewerIds: ['u1', 'u2'],
      }),
    ]);
    expect(row.slot).toEqual({
      label: 'Panel A',
      startTime: new Date('2026-10-06T16:00:00.000Z'),
      endTime: new Date('2026-10-06T17:00:00.000Z'),
      location: 'Kerckhoff 133',
      candidateCapacity: 4,
      groupSize: 2,
      interviewerCapacity: 3,
    });
    expect(row.interviewerIds).toEqual(['u1', 'u2']);
  });

  it('reads empty strings and missing fields as unset', () => {
    const [row] = planCustomSessions([
      session({ label: '   ', location: '', candidateCapacity: '', groupSize: '', interviewerCapacity: null }),
    ]);
    expect(row.slot).toMatchObject({
      label: null,
      location: null,
      candidateCapacity: null,
      groupSize: null,
      interviewerCapacity: null,
    });
    expect(row.interviewerIds).toEqual([]);
  });

  it('keeps zero seats, which closes a session to self-signup rather than unsetting it', () => {
    const [row] = planCustomSessions([session({ candidateCapacity: 0 })]);
    expect(row.slot.candidateCapacity).toBe(0);
  });

  it('names the row whose end is not after its start', () => {
    expect(() =>
      planCustomSessions([session(), session(), session({ endTime: '2026-10-06T16:00:00.000Z' })])
    ).toThrow('Session 3: the end time must be after the start time');
  });

  it('names the row with an unreadable time', () => {
    expect(() => planCustomSessions([session({ startTime: 'nine-ish' })])).toThrow(/^Session 1: a valid start/);
    expect(() => planCustomSessions([session({ endTime: undefined })])).toThrow(/^Session 1:/);
  });

  it('refuses a capacity that is not a whole number, by row', () => {
    expect(() => planCustomSessions([session(), session({ candidateCapacity: 2.5 })])).toThrow(/^Session 2: seats/);
    expect(() => planCustomSessions([session({ candidateCapacity: -1 })])).toThrow(/^Session 1: seats/);
    expect(() => planCustomSessions([session({ interviewerCapacity: 'four' })])).toThrow(/interviewers wanted/);
  });

  it('refuses a group size of zero, which is not the same as no grouping', () => {
    expect(() => planCustomSessions([session({ groupSize: 0 })])).toThrow(/^Session 1: group size/);
  });

  it('dedupes interviewers and drops anything that is not an id', () => {
    const [row] = planCustomSessions([session({ interviewerIds: ['u1', 'u1', 7, null, '', 'u2', 'u2'] })]);
    expect(row.interviewerIds).toEqual(['u1', 'u2']);
  });

  it('requires at least one session', () => {
    expect(() => planCustomSessions([])).toThrow(/at least one session/);
    expect(() => planCustomSessions(undefined)).toThrow(/at least one session/);
    expect(() => planCustomSessions({ startTime: 'x' })).toThrow(/at least one session/);
  });

  it(`refuses more than ${MAX_CUSTOM_SESSIONS} sessions at once`, () => {
    const many = Array.from({ length: MAX_CUSTOM_SESSIONS + 1 }, () => session());
    expect(() => planCustomSessions(many)).toThrow(/At most 100/);
    expect(planCustomSessions(many.slice(1))).toHaveLength(MAX_CUSTOM_SESSIONS);
  });
});

describe('assignIds', () => {
  const counter = () => {
    let n = 0;
    return () => `slot-${(n += 1)}`;
  };
  const planned = () =>
    planCustomSessions([
      { startTime: '2026-10-06T16:00:00Z', endTime: '2026-10-06T17:00:00Z', label: 'A', interviewerIds: ['u1', 'u2'] },
      { startTime: '2026-10-06T17:00:00Z', endTime: '2026-10-06T18:00:00Z' },
      { startTime: '2026-10-06T18:00:00Z', endTime: '2026-10-06T19:00:00Z', interviewerIds: ['u2'] },
    ]);

  it('gives each slot an id and its interview, and points every assignment at its slot', () => {
    const { slots, assignments } = assignIds(planned(), 'int-1', counter());
    expect(slots.map((s) => [s.id, s.interviewId, s.label])).toEqual([
      ['slot-1', 'int-1', 'A'],
      ['slot-2', 'int-1', null],
      ['slot-3', 'int-1', null],
    ]);
    expect(slots[0].startTime).toEqual(new Date('2026-10-06T16:00:00Z'));
    expect(assignments).toEqual([
      { slotId: 'slot-1', interviewId: 'int-1', userId: 'u1', role: 'INTERVIEWER' },
      { slotId: 'slot-1', interviewId: 'int-1', userId: 'u2', role: 'INTERVIEWER' },
      { slotId: 'slot-3', interviewId: 'int-1', userId: 'u2', role: 'INTERVIEWER' },
    ]);
  });

  it('leaves the planned sessions untouched', () => {
    const input = planned();
    const before = structuredClone(input);
    assignIds(input, 'int-1', counter());
    expect(input).toEqual(before);
    expect(input[0].slot).not.toHaveProperty('id');
  });

  it('makes real ids by default', () => {
    const { slots } = assignIds(planned(), 'int-1');
    expect(new Set(slots.map((s) => s.id)).size).toBe(3);
    expect(slots[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns nothing for nothing', () => {
    expect(assignIds([], 'int-1', counter())).toEqual({ slots: [], assignments: [] });
  });
});

describe('widenRange', () => {
  const range = {
    startDate: new Date('2026-10-06T16:00:00Z'),
    endDate: new Date('2026-10-07T00:00:00Z'),
  };
  const slot = (start, end) => ({ startTime: new Date(start), endTime: new Date(end) });

  it('keeps the range, unchanged, when every session fits inside it', () => {
    const result = widenRange(range, [slot('2026-10-06T17:00:00Z', '2026-10-06T18:00:00Z')]);
    expect(result).toEqual({ ...range, changed: false });
    expect(result.startDate).toBe(range.startDate);
  });

  it('moves the start earlier for a session that begins before it', () => {
    expect(widenRange(range, [slot('2026-10-06T15:00:00Z', '2026-10-06T16:00:00Z')])).toEqual({
      startDate: new Date('2026-10-06T15:00:00Z'),
      endDate: range.endDate,
      changed: true,
    });
  });

  it('moves the end later for a session that runs past it, and both at once', () => {
    expect(
      widenRange(range, [
        slot('2026-10-06T14:00:00Z', '2026-10-06T15:00:00Z'),
        slot('2026-10-07T00:00:00Z', '2026-10-07T01:30:00Z'),
      ])
    ).toEqual({
      startDate: new Date('2026-10-06T14:00:00Z'),
      endDate: new Date('2026-10-07T01:30:00Z'),
      changed: true,
    });
  });

  it('never narrows a range wider than its sessions', () => {
    const result = widenRange(range, [slot('2026-10-06T20:00:00Z', '2026-10-06T21:00:00Z')]);
    expect(result.startDate).toEqual(range.startDate);
    expect(result.endDate).toEqual(range.endDate);
    expect(result.changed).toBe(false);
  });

  it('reports no change for no sessions', () => {
    expect(widenRange(range, [])).toEqual({ ...range, changed: false });
  });
});
