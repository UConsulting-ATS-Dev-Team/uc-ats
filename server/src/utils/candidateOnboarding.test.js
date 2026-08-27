// Field validation for the onboarding module.
//
// The two fields worth pinning down are the ones a person types freely. Both
// have a bound that is not obvious from the field name: a GPA ceiling that has
// to clear a weighted high-school scale without admitting a percentage, and a
// phone number that has to end up as the bare digits the rest of the data uses.
import { describe, it, expect } from 'vitest';
import {
  sanitizeOnboardingInput,
  normalizePhone,
  normalizeGpa,
} from './candidateOnboarding.js';

const valid = {
  phoneNumber: '310-555-0134',
  graduationYear: '2028',
  cumulativeGpa: '3.85',
  major1: 'Economics or Business Economics',
  isTransferStudent: 'false',
  isFirstGeneration: 'true',
  talentPoolOptIn: 'true',
};

describe('normalizePhone', () => {
  it.each([
    ['3105550134', '3105550134'],
    ['310-555-0134', '3105550134'],
    ['(310) 555-0134', '3105550134'],
    ['310 555 0134', '3105550134'],
    ['+1 (310) 555-0134', '3105550134'],
    ['13105550134', '3105550134'],
    ['  310.555.0134  ', '3105550134'],
  ])('reduces %s to the ten digits that identify it', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['', 'blank'],
    ['call me', 'no digits at all'],
    ['555-0134', 'seven digits - a local number with no area code'],
    ['310555013', 'nine digits, one short'],
    ['31055501345', 'eleven digits not starting with a country code'],
    ['23105550134', 'eleven digits with the wrong country code'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('normalizeGpa', () => {
  it.each([
    ['3.85', '3.85'],
    ['4', '4.00'],
    ['4.0', '4.00'],
    ['3.9', '3.90'],
    ['0', '0.00'],
    ['  3.85  ', '3.85'],
  ])('pins %s to the two decimals the column stores', (input, expected) => {
    expect(normalizeGpa(input)).toBe(expected);
  });

  it('accepts a weighted high-school GPA above 4.00', () => {
    // First-years are told to enter their high-school GPA, and 114 of the
    // applications on file are already above 4.30 - the highest a real 5.32.
    expect(normalizeGpa('4.83')).toBe('4.83');
    expect(normalizeGpa('5.32')).toBe('5.32');
  });

  it.each([
    ['3.456', 'a third decimal the column cannot store'],
    ['95', 'a percentage'],
    ['9.99', 'the value a Decimal(3,2) clamps garbage to'],
    ['6.01', 'past the anti-typo ceiling'],
    ['-1', 'negative'],
    ['3.85.2', 'two decimal points'],
    ['3,85', 'a comma decimal separator'],
    ['A', 'a letter grade'],
    ['', 'blank'],
    ['   ', 'whitespace'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeGpa(input)).toBeNull();
  });
});

describe('sanitizeOnboardingInput', () => {
  it('accepts a well-formed submission and normalizes both free-text numbers', () => {
    const { value, errors } = sanitizeOnboardingInput(valid);
    expect(errors).toEqual([]);
    expect(value.phoneNumber).toBe('3105550134');
    expect(value.cumulativeGpa).toBe('3.85');
  });

  it('names the phone format rather than just calling it invalid', () => {
    const { errors } = sanitizeOnboardingInput({ ...valid, phoneNumber: '555-0134' });
    expect(errors[0]).toMatch(/10-digit/);
  });

  it('says how many decimals a GPA may have', () => {
    const { errors } = sanitizeOnboardingInput({ ...valid, cumulativeGpa: '3.456' });
    expect(errors[0]).toMatch(/two decimal places/);
  });

  it('does not name the GPA ceiling, which is an anti-typo bound and not a scale', () => {
    const { errors } = sanitizeOnboardingInput({ ...valid, cumulativeGpa: '95' });
    expect(errors[0]).not.toMatch(/6/);
  });

  it('reports every bad field at once rather than one per round trip', () => {
    const { errors } = sanitizeOnboardingInput({
      ...valid,
      phoneNumber: 'nope',
      cumulativeGpa: '3.456',
      major1: '   ',
    });
    expect(errors).toHaveLength(3);
  });
});
