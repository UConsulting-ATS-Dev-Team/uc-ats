import { describe, it, expect } from 'vitest';
import { isCaseLockedError, caseUnlocksAt, formatUnlockWait, CASE_LOCKED_CODE } from './caseLock';

// Shaped like the errors client/src/utils/api.js throws: status, code and the
// whole parsed body.
const lockedError = (unlocksAt) => ({
  status: 423,
  code: CASE_LOCKED_CODE,
  body: { error: 'This case unlocks closer to the interview.', code: CASE_LOCKED_CODE, unlocksAt },
});

describe('isCaseLockedError', () => {
  it('recognises a locked case', () => {
    expect(isCaseLockedError(lockedError('2026-09-18T18:00:00.000Z'))).toBe(true);
  });

  it('does not treat a plain 403 as locked — that case is not theirs at all', () => {
    expect(isCaseLockedError({ status: 403, body: { error: 'Forbidden' } })).toBe(false);
  });

  it('does not treat a sealed record (423 RECORD_LOCKED) as a locked case', () => {
    expect(isCaseLockedError({ status: 423, code: 'RECORD_LOCKED' })).toBe(false);
  });

  it('survives an undefined error', () => {
    expect(isCaseLockedError(undefined)).toBe(false);
  });
});

describe('caseUnlocksAt', () => {
  it('parses the timestamp out of the body', () => {
    expect(caseUnlocksAt(lockedError('2026-09-18T18:00:00.000Z')).toISOString()).toBe(
      '2026-09-18T18:00:00.000Z'
    );
  });

  it('returns null when the server sent no timestamp', () => {
    expect(caseUnlocksAt({ status: 423, code: CASE_LOCKED_CODE, body: {} })).toBe(null);
  });

  it('returns null on an unparseable timestamp rather than an Invalid Date', () => {
    expect(caseUnlocksAt(lockedError('not-a-date'))).toBe(null);
  });
});

describe('formatUnlockWait', () => {
  const now = new Date('2026-09-18T12:00:00.000Z');
  const inMinutes = (m) => new Date(now.getTime() + m * 60000);

  it('counts minutes under an hour', () => {
    expect(formatUnlockWait(inMinutes(25), now)).toBe('in 25 minutes');
  });

  it('says a single minute in the singular', () => {
    expect(formatUnlockWait(inMinutes(1), now)).toBe('in 1 minute');
  });

  it('counts hours up to two days', () => {
    expect(formatUnlockWait(inMinutes(180), now)).toBe('in about 3 hours');
  });

  it('counts days beyond that', () => {
    expect(formatUnlockWait(inMinutes(60 * 72), now)).toBe('in about 3 days');
  });

  it('does not count backwards once the time has passed', () => {
    expect(formatUnlockWait(inMinutes(-5), now)).toBe('in a moment');
  });

  it('returns null with no unlock time', () => {
    expect(formatUnlockWait(null, now)).toBe(null);
  });
});
