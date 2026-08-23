import { describe, it, expect } from 'vitest';
import { localInputToUTC, utcToLocalInput } from './timezoneUtils.js';

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

  it('keeps midnight on its own LA day', () => {
    expect(localInputToUTC('2026-09-15T00:00').toISOString()).toBe('2026-09-15T07:00:00.000Z');
  });
});

describe('utcToLocalInput', () => {
  it('round-trips a PDT wall-clock value', () => {
    expect(utcToLocalInput('2026-09-16T01:00:00.000Z')).toBe('2026-09-15T18:00');
  });

  it('round-trips a PST wall-clock value', () => {
    expect(utcToLocalInput('2026-01-16T02:00:00.000Z')).toBe('2026-01-15T18:00');
  });

  it('round-trips LA midnight without shifting the date', () => {
    expect(utcToLocalInput('2026-09-15T07:00:00.000Z')).toBe('2026-09-15T00:00');
    expect(utcToLocalInput(localInputToUTC('2026-09-15T00:00'))).toBe('2026-09-15T00:00');
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(utcToLocalInput(new Date('2026-09-16T01:00:00.000Z'))).toBe('2026-09-15T18:00');
  });

  it('returns null for empty or invalid values', () => {
    expect(utcToLocalInput(null)).toBeNull();
    expect(utcToLocalInput('')).toBeNull();
    expect(utcToLocalInput('not-a-date')).toBeNull();
  });
});
