// The assertions that matter here: a visibility level can never be widened by
// a query parameter, and a CSV cell can never become a spreadsheet formula.
// Both are properties of pure functions, so none of this needs a database.
import { describe, it, expect } from 'vitest';
import {
  MAX_PAGE,
  buildAssignmentFilters,
  buildFacets,
  buildSearchClause,
  csvFilename,
  escapeCsvCell,
  exportColumns,
  filterableFields,
  referenceFor,
  sanitizeClientQuery,
  sortRows,
  sortableFields,
  toCsv
} from './clientResumeQuery.js';

const dto = (overrides = {}) => ({
  assignmentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  kind: 'APPLICANT',
  assignedAt: '2026-08-01T00:00:00.000Z',
  available: true,
  graduationYear: '2030',
  major1: 'Economics',
  major2: null,
  ...overrides
});

describe('what a visibility level may ask for', () => {
  it('never offers gender or GPA to a blind client', () => {
    expect(filterableFields('BLIND')).toEqual(['kind', 'graduationYear', 'major']);
    expect(sortableFields('BLIND')).not.toContain('name');
    expect(sortableFields('BLIND')).not.toContain('gender');
    expect(sortableFields('BLIND')).not.toContain('cumulativeGpa');
  });

  it('adds identity at BASIC and contact at FULL', () => {
    expect(filterableFields('BASIC')).toContain('gender');
    expect(filterableFields('BASIC')).not.toContain('gpa');
    expect(filterableFields('FULL')).toContain('gpa');
    expect(sortableFields('FULL')).toContain('cumulativeGpa');
  });

  it('makes every numeric column a FULL client can read sortable', () => {
    expect(sortableFields('FULL')).toEqual(expect.arrayContaining([
      'graduationYear', 'cumulativeGpa', 'majorGpa'
    ]));
    // ...and none of them below the level that projects them.
    expect(sortableFields('BASIC')).not.toContain('majorGpa');
    expect(sortableFields('BLIND')).not.toContain('majorGpa');
  });

  it('drops a filter the level hides rather than honouring it', () => {
    const { value } = sanitizeClientQuery({ gender: 'Female', gpaMin: '3.5' }, 'BLIND');
    expect(value.filters).toEqual({});
  });

  it('drops a sort the level hides and falls back to the default', () => {
    const { value } = sanitizeClientQuery({ sort: 'cumulativeGpa', dir: 'asc' }, 'BASIC');
    // Ordering by a hidden column would leak it one comparison at a time.
    expect(value.sort).toEqual({ field: 'assignedAt', dir: 'asc' });
  });

  it('treats an unknown visibility as BLIND', () => {
    const { value } = sanitizeClientQuery({ gender: 'Female' }, 'SUPERUSER');
    expect(value.filters).toEqual({});
  });

  it('caps the page size', () => {
    expect(sanitizeClientQuery({ limit: '100000' }, 'FULL').value.limit).toBe(MAX_PAGE);
    expect(sanitizeClientQuery({ limit: '-5' }, 'FULL').value.limit).toBe(1);
    expect(sanitizeClientQuery({ offset: '-5' }, 'FULL').value.offset).toBe(0);
  });

  it('reports a malformed GPA instead of silently ignoring it', () => {
    const { errors } = sanitizeClientQuery({ gpaMin: 'four point oh' }, 'FULL');
    expect(errors[0]).toMatch(/Minimum GPA/);
  });

  it('accepts repeated and comma-joined values alike, de-duplicated', () => {
    expect(sanitizeClientQuery({ graduationYear: '2029,2030,2029' }, 'BLIND').value.filters
      .graduationYear).toEqual(['2029', '2030']);
    expect(sanitizeClientQuery({ major: ['Econ', 'econ', ' Stats '] }, 'BLIND').value.filters
      .major).toEqual(['Econ', 'Stats']);
  });

  it('reads both kinds selected as no kind filter at all', () => {
    expect(sanitizeClientQuery({ kind: 'APPLICANT,MEMBER' }, 'BLIND').value.filters.kind)
      .toBeUndefined();
    expect(sanitizeClientQuery({ kind: 'MEMBER' }, 'BLIND').value.filters.kind).toBe('MEMBER');
  });
});

describe('filter translation', () => {
  it('matches a shared field against either pool', () => {
    const { and } = buildAssignmentFilters({ graduationYear: ['2030'] });
    const json = JSON.stringify(and);
    // A "class of 2030" filter has to mean the same thing for an applicant and
    // for a member, and the two live on different relations.
    expect(json).toContain('application');
    expect(json).toContain('memberResume');
  });

  it('compares free text case-insensitively', () => {
    const { and } = buildAssignmentFilters({ gender: ['Female'] });
    expect(JSON.stringify(and)).toContain('insensitive');
  });

  it('matches a major against either major column', () => {
    const { and } = buildAssignmentFilters({ major: ['Economics'] });
    const json = JSON.stringify(and);
    expect(json).toContain('major1');
    expect(json).toContain('major2');
  });

  it('narrows by kind through the foreign key, not the relation', () => {
    expect(buildAssignmentFilters({ kind: 'MEMBER' }).and).toEqual([
      { memberResumeId: { not: null } }
    ]);
  });

  it('says a GPA filter excludes members rather than showing an empty member half', () => {
    const { and, notes } = buildAssignmentFilters({ gpaMin: '3.50' });
    expect(and).toEqual([{ application: { cumulativeGpa: { gte: '3.50' } } }]);
    expect(notes.join(' ')).toMatch(/Member resumes do not record a GPA/);
  });

  it('stays quiet about members when the filter already excluded them', () => {
    expect(buildAssignmentFilters({ gpaMin: '3.50', kind: 'APPLICANT' }).notes).toEqual([]);
  });

  it('compares GPA as a string so float rounding never decides a cut-off', () => {
    const { and } = buildAssignmentFilters({ gpaMin: '3.50', gpaMax: '4.00' });
    expect(and[0].application.cumulativeGpa).toEqual({ gte: '3.50', lte: '4.00' });
  });

  it('produces no clauses for an empty filter set', () => {
    expect(buildAssignmentFilters({}).and).toEqual([]);
  });
});

describe('free-text search', () => {
  it('never reaches a name field under BLIND', () => {
    const json = JSON.stringify(buildSearchClause('Jane', 'BLIND'));
    // A name search plus a result count is a yes/no oracle for "is this person
    // in my set", which is deanonymization by another route.
    expect(json).not.toContain('firstName');
    expect(json).not.toContain('lastName');
    expect(json).not.toContain('fullName');
    expect(json).toContain('major1');
  });

  it('reaches names once identity is already visible', () => {
    const json = JSON.stringify(buildSearchClause('Jane', 'BASIC'));
    expect(json).toContain('firstName');
    expect(json).toContain('lastName');
    expect(json).toContain('fullName');
  });

  it('searches resume text only at FULL, for both pools', () => {
    const full = JSON.stringify(buildSearchClause('Python', 'FULL'));
    expect(full).toContain('resumeExtraction');
    // Both an application and a member resume can carry an extraction, and a
    // search that reached only one pool would silently hide half the library.
    expect(full.match(/resumeExtraction/g)).toHaveLength(2);
  });

  it('keeps resume text away from the tiers that cannot see the resume', () => {
    // The extraction is of the UNREDACTED resume: it names employers and
    // projects a blind partner is never shown, and matching on it plus a result
    // count is the same identity oracle the name rule closes.
    expect(JSON.stringify(buildSearchClause('Goldman', 'BLIND'))).not.toContain('resumeExtraction');
    expect(JSON.stringify(buildSearchClause('Goldman', 'BASIC'))).not.toContain('resumeExtraction');
  });
});

describe('sorting', () => {
  it('sorts blanks last in both directions', () => {
    const rows = [
      dto({ assignmentId: 'a', major1: 'Statistics' }),
      dto({ assignmentId: 'b', major1: null }),
      dto({ assignmentId: 'c', major1: 'Economics' })
    ];

    expect(sortRows(rows, { field: 'major', dir: 'asc' }).map((r) => r.assignmentId))
      .toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, { field: 'major', dir: 'desc' }).map((r) => r.assignmentId))
      .toEqual(['a', 'c', 'b']);
  });

  it('interleaves both pools on a shared column', () => {
    const rows = [
      dto({ assignmentId: 'a', kind: 'APPLICANT', graduationYear: '2030' }),
      dto({ assignmentId: 'b', kind: 'MEMBER', graduationYear: '2028' }),
      dto({ assignmentId: 'c', kind: 'APPLICANT', graduationYear: '2029' })
    ];

    // The reason sorting is in memory at all: no Prisma orderBy interleaves two
    // nullable to-one relations, so members would clump at one end.
    expect(sortRows(rows, { field: 'graduationYear', dir: 'asc' }).map((r) => r.assignmentId))
      .toEqual(['b', 'c', 'a']);
  });

  it('sorts GPA numerically, not lexically', () => {
    const rows = [
      dto({ assignmentId: 'a', cumulativeGpa: '3.90' }),
      dto({ assignmentId: 'b', cumulativeGpa: '3.10' }),
      dto({ assignmentId: 'c', cumulativeGpa: '10.00' })
    ];
    expect(sortRows(rows, { field: 'cumulativeGpa', dir: 'asc' }).map((r) => r.assignmentId))
      .toEqual(['b', 'a', 'c']);
  });

  it('sorts major GPA numerically too', () => {
    const rows = [
      dto({ assignmentId: 'a', majorGpa: '3.90' }),
      dto({ assignmentId: 'b', majorGpa: '3.10' }),
      dto({ assignmentId: 'c', majorGpa: '10.00' })
    ];
    expect(sortRows(rows, { field: 'majorGpa', dir: 'asc' }).map((r) => r.assignmentId))
      .toEqual(['b', 'a', 'c']);
  });

  it('keeps a non-numeric graduation year among the years instead of with the blanks', () => {
    // The column is free text off a Google Form. Coercing it to a number would
    // turn "Spring 2029" into NaN, which isBlank() files at the very bottom.
    const rows = [
      dto({ assignmentId: 'a', graduationYear: '2030' }),
      dto({ assignmentId: 'b', graduationYear: 'Spring 2029' }),
      dto({ assignmentId: 'c', graduationYear: null })
    ];
    const order = sortRows(rows, { field: 'graduationYear', dir: 'asc' }).map((r) => r.assignmentId);
    expect(order[order.length - 1]).toBe('c');
    expect(order).toContain('b');
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('breaks ties stably so paging does not reshuffle rows', () => {
    const rows = [
      dto({ assignmentId: 'zzz', graduationYear: '2030' }),
      dto({ assignmentId: 'aaa', graduationYear: '2030' })
    ];
    expect(sortRows(rows, { field: 'graduationYear', dir: 'asc' }).map((r) => r.assignmentId))
      .toEqual(['aaa', 'zzz']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [dto({ assignmentId: 'b' }), dto({ assignmentId: 'a' })];
    sortRows(rows, { field: 'assignmentId', dir: 'asc' });
    expect(rows[0].assignmentId).toBe('b');
  });
});

describe('facets', () => {
  it('collapses case variants to one choice', () => {
    const facets = buildFacets(
      [dto({ gender: 'Female' }), dto({ gender: 'female' })],
      'FULL'
    );
    expect(facets.gender).toEqual(['Female']);
  });

  it('pulls both major columns into one list', () => {
    const facets = buildFacets(
      [dto({ major1: 'Economics', major2: 'Statistics' })],
      'BLIND'
    );
    expect(facets.major).toEqual(['Economics', 'Statistics']);
  });

  it('offers no gender facet to a blind client', () => {
    expect(buildFacets([dto({ gender: 'Female' })], 'BLIND').gender).toBeUndefined();
  });
});

describe('CSV', () => {
  it('neutralizes a cell that would otherwise run as a formula', () => {
    // These cells hold applicant free text off a Google Form, and Excel
    // executes a leading =, +, - or @.
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('-2')).toBe("'-2");
    // Neutralized first, then quoted because the value also contains a quote.
    expect(escapeCsvCell('+HYPERLINK("x")')).toBe('"\'+HYPERLINK(""x"")"');
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('Economics')).toBe('Economics');
  });

  it('quotes separators and doubles inner quotes', () => {
    expect(escapeCsvCell('Ruiz, Jr')).toBe('"Ruiz, Jr"');
    expect(escapeCsvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('renders nothing for a missing value', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('carries only the columns the visibility already exposes', () => {
    const blind = exportColumns('BLIND').map((c) => c.key);
    expect(blind).not.toContain('firstName');
    expect(blind).not.toContain('gender');
    expect(blind).not.toContain('email');
    expect(blind).toContain('graduationYear');

    const full = exportColumns('FULL').map((c) => c.key);
    expect(full).toEqual(expect.arrayContaining(['firstName', 'gender', 'cumulativeGpa', 'email']));
  });

  it('never emits a Drive id or a storage path', () => {
    const csv = toCsv(
      [dto({ pdfUrl: '/api/client/resumes/x/pdf', resumeUrl: 'drive-secret' })],
      'FULL'
    );
    expect(csv).not.toContain('drive-secret');
    expect(csv).not.toContain('pdf');
  });

  it('leads with a BOM and separates rows with CRLF so Excel reads it correctly', () => {
    const csv = toCsv([dto()], 'BLIND');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });

  it('renders the reference, type, date and availability as a reader expects', () => {
    const csv = toCsv([dto({ available: false, kind: 'MEMBER' })], 'BLIND');
    const row = csv.trim().split('\r\n')[1];
    expect(row).toContain('AAAAAAAA');
    expect(row).toContain('Member');
    expect(row).toContain('2026-08-01');
    expect(row.endsWith('No')).toBe(true);
  });
});

describe('reference and filename', () => {
  it('derives a stable handle from the assignment id', () => {
    expect(referenceFor('aaaaaaaa-bbbb-cccc')).toBe('AAAAAAAA');
    expect(referenceFor(null)).toBe('');
  });

  it('slugs the organization and stamps the date', () => {
    expect(csvFilename('Acme Recruiting, LLC', new Date('2026-08-26T12:00:00Z')))
      .toBe('acme-recruiting-llc-resumes-2026-08-26.csv');
  });

  it('falls back when the organization slugs to nothing', () => {
    expect(csvFilename('///', new Date('2026-08-26T12:00:00Z')))
      .toBe('resumes-2026-08-26.csv');
    expect(csvFilename('', new Date('2026-08-26T12:00:00Z')))
      .toBe('resumes-2026-08-26.csv');
  });
});
