import { describe, it, expect } from 'vitest';
import { getNextDeadline, formatDeadline } from './getNextDeadline';

describe('getNextDeadline', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');

  const makeApplications = (cycleOverrides = []) => cycleOverrides.map((cycle, index) => ({
    id: `app-${index}`,
    cycle: {
      id: cycle.id || `cycle-${index}`,
      name: cycle.name || `Cycle ${index}`,
      resumeDeadline: cycle.resumeDeadline ?? null,
      coverLetterDeadline: cycle.coverLetterDeadline ?? null,
      videoDeadline: cycle.videoDeadline ?? null,
    },
  }));

  it('returns the earliest future deadline across multiple deadlines', () => {
    const applications = makeApplications([
      {
        name: 'Fall 2026',
        resumeDeadline: '2026-10-05',
        coverLetterDeadline: '2026-10-03',
        videoDeadline: '2026-10-10',
      },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Cover Letter');
    expect(next.cycleName).toBe('Fall 2026');
    expect(next.raw).toBe('2026-10-03');
  });

  it('returns a single future deadline', () => {
    const applications = makeApplications([
      { name: 'Winter 2027', resumeDeadline: '2026-11-15' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Resume');
    expect(next.cycleName).toBe('Winter 2027');
  });

  it('returns null when no deadlines are provided', () => {
    const applications = makeApplications([{ name: 'Spring 2027' }]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('ignores malformed prose deadlines and returns null', () => {
    const applications = makeApplications([
      { name: 'Fall 2026', resumeDeadline: 'Oct 4th, Morning' },
    ]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('ignores past deadlines and returns null when all deadlines are past', () => {
    const applications = makeApplications([
      {
        name: 'Fall 2025',
        resumeDeadline: '2025-09-01',
        coverLetterDeadline: '2025-09-02',
        videoDeadline: '2025-09-03',
      },
    ]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('only considers deadlines from the provided applications (cycle isolation)', () => {
    const applications = makeApplications([
      {
        name: 'Cycle A',
        resumeDeadline: '2026-10-02',
      },
      {
        name: 'Cycle B',
        coverLetterDeadline: '2026-10-04',
      },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Resume');
    expect(next.cycleName).toBe('Cycle A');
  });

  it('prefers an earlier deadline in a different cycle over a later one', () => {
    const applications = makeApplications([
      { name: 'Cycle A', resumeDeadline: '2026-10-08' },
      { name: 'Cycle B', coverLetterDeadline: '2026-10-04' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Cover Letter');
    expect(next.cycleName).toBe('Cycle B');
  });

  it('handles date-time strings with timezone offsets', () => {
    const applications = makeApplications([
      { name: 'Fall 2026', resumeDeadline: '2026-10-01T12:00:00-07:00' },
      { name: 'Fall 2026', coverLetterDeadline: '2026-10-01T20:00:00Z' },
    ]);

    const next = getNextDeadline(applications, now);
    // 2026-10-01T12:00-07:00 is 19:00 UTC, earlier than 20:00 UTC
    expect(next.label).toBe('Resume');
    expect(next.hasTime).toBe(true);
  });
});

describe('formatDeadline', () => {
  it('formats a date-only deadline without a time', () => {
    const date = new Date('2026-10-04T07:00:00.000Z');
    const formatted = formatDeadline(date, false);
    expect(formatted).toMatch(/October 4, 2026/);
    expect(formatted).not.toMatch(/AM|PM|\d:\d{2}/);
  });

  it('formats a deadline with time and timezone context', () => {
    const date = new Date('2026-10-04T17:00:00.000Z');
    const formatted = formatDeadline(date, true);
    expect(formatted).toMatch(/October 4, 2026/);
    expect(formatted).toMatch(/10:00 AM/);
  });
});
