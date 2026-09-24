import { describe, it, expect } from 'vitest';
import { getNextDeadline, getCycleDeadline, formatDeadline } from './getNextDeadline';

// 2026-10-01 11:59 PM PDT.
const OCT_1_CLOSE = '2026-10-02T06:59:00.000Z';

function makeApplications(cycles = []) {
  return cycles.map((cycle, index) => ({
    id: `app-${index}`,
    cycle: { id: cycle.id || `cycle-${index}`, name: cycle.name || `Cycle ${index}`, ...cycle },
  }));
}

describe('getCycleDeadline', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');

  it('reads applicationDeadline, not endDate', () => {
    const deadline = getCycleDeadline(
      { id: 'fall', name: 'Fall 2026', endDate: '2026-10-11T00:00:00.000Z', applicationDeadline: OCT_1_CLOSE },
      now
    );
    expect(deadline.date.toISOString()).toBe(OCT_1_CLOSE);
    expect(deadline.hasTime).toBe(true);
    expect(deadline.label).toBe('Application deadline');
    expect(deadline.cycleName).toBe('Fall 2026');
  });

  it('returns null when only endDate is set', () => {
    expect(getCycleDeadline({ id: 'fall', name: 'Fall 2026', endDate: '2026-10-11T00:00:00.000Z' }, now)).toBeNull();
  });

  it('returns null for no cycle or an unparseable deadline', () => {
    expect(getCycleDeadline(null, now)).toBeNull();
    expect(getCycleDeadline({ id: 'c', name: 'C', applicationDeadline: 'Oct 4th, Morning' }, now)).toBeNull();
  });

  it('is open up to the stored instant and closed from it', () => {
    const cycle = { id: 'fall', name: 'Fall 2026', applicationDeadline: OCT_1_CLOSE };
    expect(getCycleDeadline(cycle, new Date('2026-10-02T06:58:59.000Z'))).not.toBeNull();
    expect(getCycleDeadline(cycle, new Date(OCT_1_CLOSE))).toBeNull();
  });
});

describe('getNextDeadline', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');

  it('returns the earliest future application deadline across cycles', () => {
    const next = getNextDeadline(
      makeApplications([
        { name: 'Winter 2027', applicationDeadline: '2027-01-15T07:59:00.000Z' },
        { name: 'Fall 2026', applicationDeadline: OCT_1_CLOSE },
      ]),
      now
    );
    expect(next.cycleName).toBe('Fall 2026');
  });

  it('ignores cycles whose deadline is missing or past', () => {
    expect(
      getNextDeadline(
        makeApplications([
          { name: 'No deadline', endDate: '2026-10-11T00:00:00.000Z' },
          { name: 'Fall 2025', applicationDeadline: '2025-10-02T06:59:00.000Z' },
        ]),
        now
      )
    ).toBeNull();
  });

  it('returns null for a non-array', () => {
    expect(getNextDeadline(null, now)).toBeNull();
  });
});

describe('formatDeadline', () => {
  it('formats a date-only deadline with a timezone label', () => {
    const formatted = formatDeadline(new Date('2026-10-04T07:00:00.000Z'), false);
    expect(formatted).toMatch(/October 4, 2026/);
    expect(formatted).toMatch(/PDT|PST/);
    expect(formatted).not.toMatch(/\d:\d{2}/);
  });

  it('shows the Oct 1 close as 11:59 PM Pacific', () => {
    expect(formatDeadline(new Date(OCT_1_CLOSE), true)).toBe('October 1, 2026 at 11:59 PM PDT');
  });
});
