import { describe, it, expect } from 'vitest';
import { getNextDeadline, formatDeadline } from './getNextDeadline';

describe('getNextDeadline', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');

  const makeApplications = (cycleOverrides = []) => cycleOverrides.map((cycle, index) => ({
    id: `app-${index}`,
    cycle: {
      id: cycle.id || `cycle-${index}`,
      name: cycle.name || `Cycle ${index}`,
      endDate: cycle.endDate ?? null,
    },
  }));

  it('returns the earliest future application deadline across multiple cycles', () => {
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-10-10T00:00:00.000Z' },
      { name: 'Winter 2027', endDate: '2026-10-05T00:00:00.000Z' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Application deadline');
    expect(next.cycleName).toBe('Winter 2027');
    expect(next.raw).toBe('2026-10-05T00:00:00.000Z');
  });

  it('returns a single future application deadline', () => {
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-11-15T00:00:00.000Z' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Application deadline');
    expect(next.cycleName).toBe('Fall 2026');
  });

  it('returns null when no endDate is provided', () => {
    const applications = makeApplications([{ name: 'Spring 2027' }]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('ignores malformed endDate values and returns null', () => {
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: 'Oct 4th, Morning' },
    ]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('ignores past endDate values and returns null', () => {
    const applications = makeApplications([
      { name: 'Fall 2025', endDate: '2025-09-01T00:00:00.000Z' },
    ]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('only considers deadlines from the provided applications (cycle isolation)', () => {
    const applications = makeApplications([
      { name: 'Cycle A', endDate: '2026-10-02T00:00:00.000Z' },
      { name: 'Cycle B', endDate: '2026-10-04T00:00:00.000Z' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.cycleName).toBe('Cycle A');
  });

  it('handles a date-only endDate string', () => {
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-10-05' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Application deadline');
    expect(next.raw).toBe('2026-10-05');
  });
});

describe('formatDeadline', () => {
  it('formats a date-only deadline with a timezone label', () => {
    const date = new Date('2026-10-04T07:00:00.000Z');
    const formatted = formatDeadline(date, false);
    expect(formatted).toMatch(/October 4, 2026/);
    expect(formatted).toMatch(/PDT|PST/);
    expect(formatted).not.toMatch(/\d:\d{2}/);
  });

  it('formats a time-bearing deadline with an unambiguous timezone label', () => {
    const date = new Date('2026-10-04T17:00:00.000Z');
    const formatted = formatDeadline(date, true);
    expect(formatted).toMatch(/October 4, 2026/);
    expect(formatted).toMatch(/10:00 AM/);
    expect(formatted).toMatch(/PDT|PST/);
  });
});
