import { describe, it, expect } from 'vitest';
import { combine, defaultSpecFor, planBlocks, planCadence, planSessions } from './slotPlanner.js';

const hhmm = (date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

const DAY = '2027-01-15';

describe('combine', () => {
  it('puts a wall-clock time on a calendar day', () => {
    expect(hhmm(combine(DAY, '09:30'))).toBe('09:30');
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

  it('offers first round a day of group sittings with a lunch break', () => {
    const spec = defaultSpecFor('ROUND_ONE');
    expect(spec.mode).toBe('cadence');
    expect(spec.cadence).toMatchObject({ start: '08:00', end: '17:00', capacity: 4 });
    expect(spec.cadence.breaks).toHaveLength(1);
  });

  it('defaults the final round to one candidate a sitting', () => {
    // Final round is one-on-one; the real data names those groups after the
    // candidate, which is the same thing said badly.
    expect(defaultSpecFor('FINAL_ROUND').cadence.capacity).toBe(1);
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
