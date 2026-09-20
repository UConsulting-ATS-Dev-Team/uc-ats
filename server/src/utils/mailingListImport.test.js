import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv } from './csv.js';
import {
  normalizeEmail,
  isPlausibleEmail,
  detectEmailColumn,
  indexExistingEmails,
  dedupeMailingList,
  summarize,
  OUTCOMES,
} from './mailingListImport.js';

const index = (pairs) => indexExistingEmails(pairs);

describe('normalizeEmail', () => {
  it('lowercases and trims, because the ATS stores addresses lowercased', () => {
    expect(normalizeEmail('  Joe.Bruin@UCLA.edu ')).toBe('joe.bruin@ucla.edu');
  });

  it('pulls the address out of a display-name export', () => {
    expect(normalizeEmail('Joe Bruin <Joe@ucla.edu>')).toBe('joe@ucla.edu');
  });

  it('returns empty for blank input', () => {
    expect(normalizeEmail('')).toBe('');
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
  });
});

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isPlausibleEmail('joe@ucla.edu')).toBe(true);
    expect(isPlausibleEmail('joe.bruin+news@g.ucla.edu')).toBe(true);
  });

  it('rejects things that are not addresses', () => {
    for (const bad of ['joe', 'joe@', '@ucla.edu', 'joe@ucla', 'a b@ucla.edu', 'joe@ucla..edu']) {
      expect(isPlausibleEmail(bad), bad).toBe(false);
    }
  });
});

describe('detectEmailColumn', () => {
  it('prefers an exact match over a column that merely contains "email"', () => {
    expect(detectEmailColumn(['Email Verified', 'Email', 'Name'])).toBe('Email');
  });

  it('falls back to a looser match', () => {
    expect(detectEmailColumn(['Name', 'Contact E-Mail Address'])).toBe('Contact E-Mail Address');
  });

  it('honours an explicit override and reports when there is nothing to find', () => {
    expect(detectEmailColumn(['Name', 'Address'], 'Address')).toBe('Address');
    expect(detectEmailColumn(['Name', 'School'])).toBeNull();
  });
});

describe('indexExistingEmails', () => {
  it('collects every table an address appears in rather than overwriting', () => {
    const idx = index([
      { email: 'Joe@ucla.edu', source: 'candidate' },
      { email: 'joe@UCLA.edu', source: 'user' },
    ]);
    expect(idx.size).toBe(1);
    expect([...idx.get('joe@ucla.edu')].sort()).toEqual(['candidate', 'user']);
  });

  it('ignores blank addresses', () => {
    expect(index([{ email: '', source: 'user' }]).size).toBe(0);
  });
});

describe('dedupeMailingList', () => {
  const run = (csv, existing = []) => {
    const { headers, records } = parseCsv(csv);
    const emailColumn = detectEmailColumn(headers);
    return { headers, ...dedupeMailingList({ records, emailColumn, existingIndex: index(existing) }) };
  };

  it('keeps people the ATS has never seen', () => {
    const { results, kept } = run('Name,Email\r\nJoe,joe@ucla.edu\r\n');
    expect(results[0].outcome).toBe(OUTCOMES.KEPT);
    expect(kept).toHaveLength(1);
  });

  it('drops an address already in the ATS regardless of case', () => {
    const { results, kept } = run(
      'Name,Email\r\nJoe,JOE@ucla.edu\r\n',
      [{ email: 'joe@ucla.edu', source: 'candidate' }],
    );
    expect(results[0].outcome).toBe(OUTCOMES.ALREADY_IN_SYSTEM);
    expect(results[0].sources).toEqual(['candidate']);
    expect(kept).toEqual([]);
  });

  it('drops a repeat within the file and points at the line it repeats', () => {
    const { results, kept } = run('Name,Email\r\nJoe,joe@ucla.edu\r\nJoseph,Joe@UCLA.edu\r\n');
    expect(results.map((r) => r.outcome)).toEqual([OUTCOMES.KEPT, OUTCOMES.DUPLICATE_IN_FILE]);
    expect(results[1].firstSeenAt).toBe(2);
    expect(kept).toHaveLength(1);
  });

  it('separates an unreadable address from a missing one', () => {
    const { results } = run('Name,Email\r\nJoe,not-an-address\r\nAmy,\r\n');
    expect(results.map((r) => r.outcome)).toEqual([OUTCOMES.INVALID_EMAIL, OUTCOMES.MISSING_EMAIL]);
    expect(results[0].raw).toBe('not-an-address');
  });

  it('reports the real line number of every dropped row', () => {
    // Blank line 3 must not shift the numbering of everything after it.
    const { results } = run('Name,Email\r\nJoe,joe@ucla.edu\r\n\r\nAmy,bad\r\n');
    expect(results.map((r) => r.line)).toEqual([2, 4]);
  });

  it('leaves surviving rows and their columns untouched for re-export', () => {
    const { headers, kept } = run('Name,Email,Year\r\n"Bruin, Joe",joe@ucla.edu,2027\r\n');
    const csv = toCsv(headers, kept);
    expect(csv).toBe('Name,Email,Year\r\n"Bruin, Joe",joe@ucla.edu,2027\r\n');
  });
});

describe('summarize', () => {
  it('counts outcomes, and counts sources separately because they overlap', () => {
    const { headers, records } = parseCsv(
      'Email\r\nnew@ucla.edu\r\nboth@ucla.edu\r\nbad\r\n',
    );
    const existingIndex = index([
      { email: 'both@ucla.edu', source: 'candidate' },
      { email: 'both@ucla.edu', source: 'user' },
    ]);
    const { results } = dedupeMailingList({
      records,
      emailColumn: detectEmailColumn(headers),
      existingIndex,
    });
    const { total, counts, bySource } = summarize(results);

    expect(total).toBe(3);
    expect(counts[OUTCOMES.KEPT]).toBe(1);
    expect(counts[OUTCOMES.ALREADY_IN_SYSTEM]).toBe(1);
    expect(counts[OUTCOMES.INVALID_EMAIL]).toBe(1);
    // One person, two tables - so these exceed the dropped-row count on purpose.
    expect(bySource).toEqual({ candidate: 1, user: 1 });
  });
});

describe('toCsv', () => {
  it('quotes only what needs it and round-trips through parseCsv', () => {
    const headers = ['Name', 'Email', 'Note'];
    const rows = [{ Name: 'Bruin, Joe', Email: 'joe@ucla.edu', Note: 'said "yes"' }];
    const csv = toCsv(headers, rows);
    expect(csv).toBe('Name,Email,Note\r\n"Bruin, Joe",joe@ucla.edu,"said ""yes"""\r\n');

    const reparsed = parseCsv(csv);
    expect(reparsed.records[0].Name).toBe('Bruin, Joe');
    expect(reparsed.records[0].Note).toBe('said "yes"');
  });

  it('writes an empty cell for a column a row does not have', () => {
    expect(toCsv(['A', 'B'], [{ A: 'x' }])).toBe('A,B\r\nx,\r\n');
  });
});
