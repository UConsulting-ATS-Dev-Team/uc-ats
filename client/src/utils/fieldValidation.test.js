// The client half of the onboarding field rules.
//
// These mirror the server's, so the tests worth having are the ones that pin
// the mirror: the same values must be accepted and rejected on both sides, and
// what the field displays must never be what gets submitted.
import { describe, it, expect } from 'vitest';
import { formatPhone, digitsOf, normalizePhone, phoneError, gpaError, normalizeGpa } from './fieldValidation';

describe('formatPhone', () => {
  it.each([
    ['', ''],
    ['3', '3'],
    ['310', '310'],
    ['3105', '(310) 5'],
    ['310555', '(310) 555'],
    ['3105550134', '(310) 555-0134'],
  ])('formats %s progressively as %s', (input, expected) => {
    expect(formatPhone(input)).toBe(expected);
  });

  it('drops a leading country code rather than shifting every digit right', () => {
    expect(formatPhone('13105550134')).toBe('(310) 555-0134');
  });

  it('stops at ten digits, so extra keystrokes cannot corrupt the format', () => {
    expect(formatPhone('310555013456789')).toBe('(310) 555-0134');
  });

  it('is idempotent, so re-formatting an already formatted value is safe', () => {
    expect(formatPhone(formatPhone('3105550134'))).toBe('(310) 555-0134');
  });

  it('reduces back to the digits that get submitted', () => {
    expect(digitsOf(formatPhone('3105550134'))).toBe('3105550134');
  });
});

describe('phoneError', () => {
  it('stays quiet on an empty field - nobody has made a mistake yet', () => {
    expect(phoneError('')).toBe('');
  });

  it.each(['(310) 555-013', '555-0134', '(310) 5'])('flags the incomplete number %s', (input) => {
    expect(phoneError(input)).toMatch(/10-digit/);
  });

  it('accepts a complete number', () => {
    expect(phoneError('(310) 555-0134')).toBe('');
    expect(normalizePhone('(310) 555-0134')).toBe('3105550134');
  });
});

describe('gpaError', () => {
  it('stays quiet on an empty field', () => {
    expect(gpaError('')).toBe('');
  });

  it('names the decimal limit, which is the mistake someone can act on', () => {
    expect(gpaError('3.456')).toMatch(/two decimal places/);
  });

  it('reports an out-of-range value separately from a malformed one', () => {
    expect(gpaError('95')).toMatch(/4\.0 scale/);
    expect(gpaError('95')).not.toMatch(/two decimal places/);
  });

  it.each(['3.85', '4', '4.0', '3.9', '4.83', '5.32'])('accepts %s', (input) => {
    expect(gpaError(input)).toBe('');
  });

  it('agrees with the server on the two-decimal canonical form', () => {
    expect(normalizeGpa('3.9')).toBe('3.90');
    expect(normalizeGpa('4')).toBe('4.00');
  });
});
