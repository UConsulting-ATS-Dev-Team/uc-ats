import { describe, it, expect } from 'vitest';
import { localInputToUTC } from './timezoneUtils.js';

describe('localInputToUTC', () => {
  it('converts PDT wall-clock to UTC', () => {
    const result = localInputToUTC('2026-09-15T18:00');
    expect(result.toISOString()).toBe('2026-09-16T01:00:00.000Z');
  });

  it('converts PST wall-clock to UTC', () => {
    const result = localInputToUTC('2026-01-15T18:00');
    expect(result.toISOString()).toBe('2026-01-16T02:00:00.000Z');
  });

  it('handles the DST spring-forward gap', () => {
    const result = localInputToUTC('2025-03-09T02:30');
    // 2:30 AM does not exist on spring-forward, but the function resolves it.
    expect(result).toBeInstanceOf(Date);
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  it('handles the DST fall-back overlap', () => {
    const result = localInputToUTC('2025-11-02T01:30');
    expect(result).toBeInstanceOf(Date);
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  it('returns null for an empty value', () => {
    expect(localInputToUTC('')).toBeNull();
    expect(localInputToUTC(null)).toBeNull();
    expect(localInputToUTC(undefined)).toBeNull();
  });

  it('returns null for an invalid value', () => {
    expect(localInputToUTC('not-a-date')).toBeNull();
  });
});
