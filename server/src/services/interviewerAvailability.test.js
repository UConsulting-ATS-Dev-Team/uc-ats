import { describe, it, expect } from 'vitest';
import {
  conflictsWithAvailability,
  coverageByTime,
  covers,
  mergeWindows,
  overlaps,
  whoCanCover,
} from './interviewerAvailability.js';

const T = (hhmm) => new Date(`2027-01-15T${hhmm}:00`);
const win = (userId, from, to) => ({ userId, startTime: T(from), endTime: T(to) });

describe('covers', () => {
  it('needs the whole session, not a piece of it', () => {
    // Free 9-10 does not mean you can run 9:30-10:30; you would leave halfway,
    // and a half-covered session is an unstaffed one.
    expect(covers(win('u', '09:00', '12:00'), T('10:00'), T('11:00'))).toBe(true);
    expect(covers(win('u', '09:00', '10:00'), T('09:30'), T('10:30'))).toBe(false);
  });

  it('counts a session that exactly fills the window', () => {
    expect(covers(win('u', '09:00', '10:00'), T('09:00'), T('10:00'))).toBe(true);
  });

  it('overlap is a different question and stays separate', () => {
    expect(overlaps(T('09:00'), T('10:00'), T('09:30'), T('10:30'))).toBe(true);
    expect(overlaps(T('09:00'), T('10:00'), T('10:00'), T('11:00'))).toBe(false);
  });
});

describe('mergeWindows', () => {
  it('joins windows that touch, so nobody is counted twice at the seam', () => {
    const merged = mergeWindows([win('u', '09:00', '11:00'), win('u', '11:00', '13:00')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].endTime).toEqual(T('13:00'));
  });

  it('joins overlapping windows', () => {
    const merged = mergeWindows([win('u', '09:00', '11:00'), win('u', '10:00', '12:00')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].endTime).toEqual(T('12:00'));
  });

  it('keeps a real gap apart', () => {
    // Somebody free in the morning and again after lunch is not free at lunch.
    const merged = mergeWindows([win('u', '09:00', '11:00'), win('u', '14:00', '16:00')]);
    expect(merged).toHaveLength(2);
  });

  it('drops a window that ends before it starts', () => {
    expect(mergeWindows([win('u', '11:00', '09:00')])).toEqual([]);
  });

  it('lets a merged window cover a session neither half could', () => {
    const merged = mergeWindows([win('u', '09:00', '11:00'), win('u', '11:00', '13:00')]);
    expect(covers(merged[0], T('10:30'), T('11:30'))).toBe(true);
  });
});

describe('whoCanCover', () => {
  const availability = [
    win('ada', '09:00', '13:00'),
    win('alan', '10:00', '12:00'),
    win('grace', '14:00', '17:00'),
  ];

  it('lists only people free for the whole session', () => {
    expect(whoCanCover(availability, T('10:00'), T('11:00')).sort()).toEqual(['ada', 'alan']);
    expect(whoCanCover(availability, T('12:00'), T('13:00'))).toEqual(['ada']);
    expect(whoCanCover(availability, T('15:00'), T('16:00'))).toEqual(['grace']);
  });

  it('finds nobody for a time nobody offered', () => {
    expect(whoCanCover(availability, T('13:00'), T('14:00'))).toEqual([]);
  });

  it('counts a person once however many windows they gave', () => {
    const many = [win('ada', '09:00', '11:00'), win('ada', '11:00', '13:00')];
    expect(whoCanCover(many, T('10:00'), T('11:00'))).toEqual(['ada']);
  });
});

describe('coverageByTime', () => {
  const availability = [
    win('a', '09:00', '12:00'),
    win('b', '09:00', '12:00'),
    win('c', '09:00', '11:00'),
    win('d', '09:00', '11:00'),
    win('e', '11:00', '12:00'),
  ];

  it('says how many panels each hour could support', () => {
    // The number recruitment is actually after: four people free at 9:00 is two
    // panels of two, so 9:00 can run two sessions at once.
    const rows = coverageByTime(availability, {
      start: T('09:00'),
      end: T('12:00'),
      minutes: 60,
      interviewersPerSession: 2,
    });
    expect(rows.map((r) => r.availableInterviewers)).toEqual([4, 4, 3]);
    expect(rows.map((r) => r.possibleSessions)).toEqual([2, 2, 1]);
  });

  it('rounds down, because three people cannot run two panels of two', () => {
    const rows = coverageByTime([win('a', '09:00', '10:00'), win('b', '09:00', '10:00'), win('c', '09:00', '10:00')], {
      start: T('09:00'),
      end: T('10:00'),
      minutes: 60,
      interviewersPerSession: 2,
    });
    expect(rows[0]).toMatchObject({ availableInterviewers: 3, possibleSessions: 1 });
  });

  it('shows an hour nobody can cover rather than skipping it', () => {
    // A gap in the middle of the day is the most important thing on the grid.
    const rows = coverageByTime([win('a', '09:00', '10:00'), win('a', '11:00', '12:00')], {
      start: T('09:00'),
      end: T('12:00'),
      minutes: 60,
    });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ availableInterviewers: 0, possibleSessions: 0 });
  });

  it('refuses a nonsensical day rather than looping', () => {
    expect(coverageByTime([], { start: T('12:00'), end: T('09:00'), minutes: 60 })).toEqual([]);
    expect(coverageByTime([], { start: T('09:00'), end: T('12:00'), minutes: 0 })).toEqual([]);
  });
});

describe('conflictsWithAvailability', () => {
  const availability = [win('ada', '09:00', '12:00')];

  it('says nothing when the placement fits', () => {
    expect(conflictsWithAvailability(availability, 'ada', T('10:00'), T('11:00'))).toBeNull();
  });

  it('separates "said no" from "never said"', () => {
    // Different problems: one needs a conversation, the other needs a form
    // filling in.
    expect(conflictsWithAvailability(availability, 'ada', T('15:00'), T('16:00'))).toBe('OUTSIDE_AVAILABILITY');
    expect(conflictsWithAvailability(availability, 'stranger', T('10:00'), T('11:00'))).toBe('NO_AVAILABILITY_GIVEN');
  });
});
