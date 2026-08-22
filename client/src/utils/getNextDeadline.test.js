import { describe, it, expect } from 'vitest';
import { getNextDeadline, formatDeadline } from './getNextDeadline';

function makeApplications(cycleOverrides = []) {
  return cycleOverrides.map((cycle, index) => ({
    id: `app-${index}`,
    cycle: {
      id: cycle.id || `cycle-${index}`,
      name: cycle.name || `Cycle ${index}`,
      endDate: cycle.endDate ?? null,
    },
  }));
}

describe('getNextDeadline', () => {
  it('returns the earliest future application deadline across multiple cycles', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
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
    const now = new Date('2026-10-01T00:00:00.000Z');
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-11-15T00:00:00.000Z' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Application deadline');
    expect(next.cycleName).toBe('Fall 2026');
  });

  it('returns null when no endDate is provided', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const applications = makeApplications([{ name: 'Spring 2027' }]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('ignores malformed endDate values and returns null', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: 'Oct 4th, Morning' },
    ]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('ignores past endDate values and returns null', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const applications = makeApplications([
      { name: 'Fall 2025', endDate: '2025-09-01T00:00:00.000Z' },
    ]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });

  it('only considers deadlines from the provided applications (cycle isolation)', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const applications = makeApplications([
      { name: 'Cycle A', endDate: '2026-10-02T00:00:00.000Z' },
      { name: 'Cycle B', endDate: '2026-10-04T00:00:00.000Z' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.cycleName).toBe('Cycle A');
  });

  it('handles a date-only endDate string', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-10-05' },
    ]);

    const next = getNextDeadline(applications, now);
    expect(next.label).toBe('Application deadline');
    expect(next.raw).toBe('2026-10-05');
  });
});

describe('deadline-day cutoff (calendar-day endDate)', () => {
  const endDate = '2026-10-05T00:00:00.000Z';
  // PT is UTC-7 in October, so the cutoff is the start of 2026-10-06 in PT,
  // which is 2026-10-06T07:00:00.000Z.

  it('shows the deadline one minute before the stated day begins in PT', () => {
    const now = new Date('2026-10-05T06:59:00.000Z'); // 2026-10-04 23:59 PDT
    const applications = makeApplications([{ name: 'Fall 2026', endDate }]);
    expect(getNextDeadline(applications, now)).not.toBeNull();
  });

  it('shows the deadline at the start of the stated day in PT', () => {
    const now = new Date('2026-10-05T07:00:00.000Z'); // 2026-10-05 00:00 PDT
    const applications = makeApplications([{ name: 'Fall 2026', endDate }]);
    expect(getNextDeadline(applications, now)).not.toBeNull();
  });

  it('shows the deadline at noon PT on the stated day', () => {
    const now = new Date('2026-10-05T19:00:00.000Z'); // 2026-10-05 12:00 PDT
    const applications = makeApplications([{ name: 'Fall 2026', endDate }]);
    expect(getNextDeadline(applications, now)).not.toBeNull();
  });

  it('shows the deadline one second before the stated day ends in PT', () => {
    const now = new Date('2026-10-06T06:59:59.000Z'); // 2026-10-05 23:59:59 PDT
    const applications = makeApplications([{ name: 'Fall 2026', endDate }]);
    expect(getNextDeadline(applications, now)).not.toBeNull();
  });

  it('hides the deadline once the stated day ends in PT', () => {
    const now = new Date('2026-10-06T07:00:00.000Z'); // 2026-10-06 00:00 PDT
    const applications = makeApplications([{ name: 'Fall 2026', endDate }]);
    expect(getNextDeadline(applications, now)).toBeNull();
  });
});

describe('structured timestamp parsing (offset/Z regression)', () => {
  it('parses a Z timestamp as an absolute instant', () => {
    const now = new Date('2026-10-05T10:00:00.000Z'); // before 12:00 UTC
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-10-05T12:00:00.000Z' },
    ]);
    expect(getNextDeadline(applications, now)).not.toBeNull();

    const after = new Date('2026-10-05T13:00:00.000Z');
    expect(getNextDeadline(applications, after)).toBeNull();
  });

  it('parses an explicit offset timestamp as an absolute instant', () => {
    const now = new Date('2026-10-05T18:00:00.000Z'); // before 12:00 PDT (19:00 UTC)
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-10-05T12:00:00-07:00' },
    ]);
    expect(getNextDeadline(applications, now)).not.toBeNull();

    const after = new Date('2026-10-05T20:00:00.000Z');
    expect(getNextDeadline(applications, after)).toBeNull();
  });

  it('parses a non-offset time as local Los Angeles time', () => {
    const now = new Date('2026-10-05T18:00:00.000Z'); // before 12:00 PDT (19:00 UTC)
    const applications = makeApplications([
      { name: 'Fall 2026', endDate: '2026-10-05 12:00:00' },
    ]);
    expect(getNextDeadline(applications, now)).not.toBeNull();

    const after = new Date('2026-10-05T20:00:00.000Z');
    expect(getNextDeadline(applications, after)).toBeNull();
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
