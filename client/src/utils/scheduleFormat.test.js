import { describe, it, expect } from 'vitest';
import { fromPacificInput, toPacificInput } from './scheduleFormat';

// Edit forms read and write Pacific, like the pages that display these times,
// whatever zone the admin's laptop is set to.
describe('toPacificInput', () => {
  it('shows an instant as Pacific wall-clock time', () => {
    expect(toPacificInput('2026-10-06T16:00:00Z')).toBe('2026-10-06T09:00');
    expect(toPacificInput('2027-01-15T17:00:00Z')).toBe('2027-01-15T09:00');
  });

  it('keeps the Pacific day when the UTC day has already rolled over', () => {
    // 5 PM PDT on October 6 is midnight UTC on October 7.
    expect(toPacificInput('2026-10-07T00:00:00Z')).toBe('2026-10-06T17:00');
  });

  it('is empty for nothing or nonsense', () => {
    expect(toPacificInput(null)).toBe('');
    expect(toPacificInput('not a date')).toBe('');
  });
});

describe('fromPacificInput', () => {
  it('reads a form value as Pacific time, in summer and in winter', () => {
    expect(fromPacificInput('2026-10-06T09:00').toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(fromPacificInput('2027-01-15T09:00').toISOString()).toBe('2027-01-15T17:00:00.000Z');
  });

  it('round-trips with toPacificInput', () => {
    for (const value of ['2026-10-06T09:00', '2026-10-06T17:00', '2026-11-01T12:30', '2027-03-14T08:00']) {
      expect(toPacificInput(fromPacificInput(value))).toBe(value);
    }
  });

  it('is null for anything that is not a form value', () => {
    expect(fromPacificInput('')).toBeNull();
    expect(fromPacificInput('9am')).toBeNull();
  });
});
