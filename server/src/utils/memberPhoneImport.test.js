import { describe, it, expect } from 'vitest';
import { detectColumns, matchPhoneRows, parseCsv } from './memberPhoneImport.js';
import { normalizePhoneNumber } from './phone.js';

describe('normalizePhoneNumber', () => {
  it('reads the ways people write US numbers', () => {
    expect(normalizePhoneNumber('(310) 555-1234')).toBe('+13105551234');
    expect(normalizePhoneNumber('1-310-555-1234')).toBe('+13105551234');
    expect(normalizePhoneNumber('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('refuses rather than guesses', () => {
    expect(normalizePhoneNumber('555-1234')).toBeNull();
    expect(normalizePhoneNumber('n/a')).toBeNull();
    expect(normalizePhoneNumber('')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('keeps quoted commas inside one field', () => {
    const { headers, records } = parseCsv('Name,Phone\r\n"Bruin, Joe","(310) 555-1234"\r\n');
    expect(headers).toEqual(['Name', 'Phone']);
    expect(records[0]).toMatchObject({ Name: 'Bruin, Joe', Phone: '(310) 555-1234', __line: 2 });
  });
});

describe('matchPhoneRows', () => {
  const users = [
    { id: 'u1', email: 'joe@g.ucla.edu', fullName: 'Joe Bruin', phoneNumber: null },
    { id: 'u2', email: 'ann@g.ucla.edu', fullName: 'Ann Lee', phoneNumber: null },
    { id: 'u3', email: 'ann2@g.ucla.edu', fullName: 'Ann Lee', phoneNumber: null },
    { id: 'u4', email: 'kim@g.ucla.edu', fullName: 'Kim Park', phoneNumber: '+13105550000' },
  ];
  const { headers, records } = parseCsv([
    'Full Name,Email Address,Phone Number',
    'Joe Bruin,JOE@g.ucla.edu,310-555-1111',
    'Ann Lee,,310-555-2222',
    'Not Here,nobody@x.com,310-555-3333',
    'Kim Park,,310-555-4444',
  ].join('\n'));
  const columns = detectColumns(headers);

  it('matches email case-insensitively and skips people without accounts', () => {
    const { results, updates } = matchPhoneRows({ records, columns, users });
    const outcome = Object.fromEntries(results.map((r) => [r.line, r.outcome]));
    expect(outcome).toEqual({ 2: 'matched-email', 3: 'ambiguous-name', 4: 'not-ats-account', 5: 'kept-existing' });
    expect(updates.map((u) => [u.user.id, u.phone])).toEqual([['u1', '+13105551111']]);
  });

  it('replaces an existing number only when told to', () => {
    const { updates } = matchPhoneRows({ records, columns, users, overwrite: true });
    expect(updates.find((u) => u.user.id === 'u4').phone).toBe('+13105554444');
  });
});

describe('regressions', () => {
  it('numbers rows by their real position when the file has a blank line', () => {
    const { records } = parseCsv([
      'Full Name,Email Address,Phone Number',
      'Joe Bruin,joe@g.ucla.edu,310-555-1111',
      '',
      'Ann Lee,ann@g.ucla.edu,310-555-2222',
    ].join('\n'));
    // Ann is on line 4 of the file. Numbering the filtered array would call her line 3.
    expect(records.map((r) => r.__line)).toEqual([2, 4]);
  });

  it('reports two rows disagreeing about one person even when the first matched what was already stored', () => {
    const users = [{ id: 'u1', fullName: 'Joe Bruin', email: 'joe@g.ucla.edu', phoneNumber: '+13105551111' }];
    const { headers, records } = parseCsv([
      'Full Name,Email Address,Phone Number',
      'Joe Bruin,joe@g.ucla.edu,310-555-1111',
      'Joe Bruin,joe@g.ucla.edu,310-555-9999',
    ].join('\n'));
    const columns = detectColumns(headers);
    const { results, updates } = matchPhoneRows({ records, columns, users, overwrite: true });
    expect(results.map((r) => r.outcome)).toEqual(['unchanged', 'conflicting-phone']);
    // The disagreeing row must not quietly win just because it came second.
    expect(updates).toEqual([]);
  });
});
