import { describe, it, expect } from 'vitest';
import {
  sanitizeFilterDsl,
  buildApplicantWhere,
  buildMemberResumeWhere,
  buildExternalResumeWhere,
  parseAssignmentKey,
  buildAssignmentKey,
  PREVIEW_CAP,
  NOT_OPTED_OUT
} from './talentPoolFilters.js';

const dsl = (rows, pool = 'APPLICANTS') => ({ pool, rows });

// Pull the predicate for a given column out of the AND array.
const findClause = (where, predicate) => where.AND.find(predicate);

describe('sanitizeFilterDsl', () => {
  it('keeps a well-formed multi-value row and dedupes case-insensitively', () => {
    const { value, errors } = sanitizeFilterDsl({
      pool: 'BOTH',
      rows: [{ field: 'graduationYear', values: ['2029', ' 2030 ', '2029'] }]
    });
    expect(errors).toEqual([]);
    expect(value.pool).toBe('BOTH');
    expect(value.rows).toEqual([{ field: 'graduationYear', values: ['2029', '2030'] }]);
  });

  it('reads no rows at all as the whole pool, which the pool choice already scopes', () => {
    const { value, errors } = sanitizeFilterDsl({ pool: 'APPLICANTS', rows: [] });
    expect(value.rows).toEqual([]);
    expect(value.unfiltered).toBe(true);
    expect(errors).toEqual([]);
  });

  it('errors when every row is an unknown field, rather than widening to the whole pool', () => {
    // The dangerous case, and the reason `unfiltered` is not simply
    // "rows.length === 0": the admin asked to narrow and the narrowing
    // vanished. An empty filter is a choice; this is a silent failure.
    const { value, errors } = sanitizeFilterDsl({
      rows: [{ field: 'salaryExpectation', values: ['high'] }]
    });
    expect(value.rows).toEqual([]);
    expect(value.unfiltered).toBe(false);
    expect(errors.some((e) => e.includes('None of those filters could be used'))).toBe(true);
    expect(errors.some((e) => e.includes('salaryExpectation'))).toBe(true);
  });

  it('errors when a written row is dropped for an empty value list', () => {
    const { value, errors } = sanitizeFilterDsl({
      pool: 'MEMBERS',
      rows: [{ field: 'graduationYear', values: [] }]
    });
    expect(value.unfiltered).toBe(false);
    expect(errors.some((e) => e.includes('None of those filters could be used'))).toBe(true);
  });

  it('rejects a garbage GPA rather than coercing it', () => {
    const { errors } = sanitizeFilterDsl({
      rows: [{ field: 'cumulativeGpa', op: 'gte', value: 'four point oh' }]
    });
    expect(errors.some((e) => e.includes('Cumulative GPA'))).toBe(true);
  });

  it('keeps GPA as a string so binary rounding never decides a cut-off', () => {
    const { value } = sanitizeFilterDsl({
      rows: [{ field: 'cumulativeGpa', op: 'gte', value: 3.5 }]
    });
    expect(value.rows[0]).toEqual({ field: 'cumulativeGpa', op: 'gte', value: '3.5' });
    expect(typeof value.rows[0].value).toBe('string');
  });

  it('rejects an unknown application status', () => {
    const { errors } = sanitizeFilterDsl({
      rows: [{ field: 'status', values: ['PROMOTED'] }]
    });
    expect(errors.some((e) => e.includes('PROMOTED'))).toBe(true);
  });

  it('requires a real boolean for boolean fields', () => {
    const { errors } = sanitizeFilterDsl({
      rows: [{ field: 'isFirstGeneration', value: 'yes' }]
    });
    expect(errors.some((e) => e.includes('First-generation'))).toBe(true);
  });

  it('ignores a duplicated field rather than silently ANDing two of them', () => {
    const { value, errors } = sanitizeFilterDsl({
      rows: [
        { field: 'gender', values: ['Female'] },
        { field: 'gender', values: ['Male'] }
      ]
    });
    expect(value.rows).toHaveLength(1);
    expect(value.rows[0].values).toEqual(['Female']);
    expect(errors.some((e) => e.includes('more than once'))).toBe(true);
  });
});

describe('buildApplicantWhere - consent is not optional', () => {
  const gateOf = (where) =>
    where.AND.find((c) => JSON.stringify(c).includes('talentPoolOptIn'));

  it('always applies the consent gate', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }]));
    expect(where.AND).toContainEqual(NOT_OPTED_OUT);
  });

  it('keeps applicants who were never asked - a null is an absence, not a refusal', () => {
    const gate = gateOf(buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }])).where);
    expect(gate.AND[0].OR).toContainEqual({ talentPoolOptIn: null });
    expect(gate.AND[0].OR).toContainEqual({ talentPoolOptIn: true });
    // The one answer the row-level clause must never admit.
    expect(gate.AND[0].OR).not.toContainEqual({ talentPoolOptIn: false });
  });

  it('disqualifies every application of someone who said no on any one of them', () => {
    // Consent belongs to the person. Checking only the row in hand let a "no"
    // on one application coexist with a still-shareable null on another, which
    // put two people who had explicitly refused in front of a client.
    const gate = gateOf(buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }])).where);
    expect(gate.AND[1].OR).toContainEqual({
      candidate: { applications: { none: { talentPoolOptIn: false } } }
    });
    // An unlinked application has no siblings to be contradicted by, and its
    // own answer is still checked by the first clause.
    expect(gate.AND[1].OR).toContainEqual({ candidateId: null });
  });

  it('requires it even when the filter mentions nothing else', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'graduationYear', values: ['2030'] }]));
    expect(where.AND).toContainEqual(NOT_OPTED_OUT);
    expect(where.AND).toContainEqual({ resumeUrl: { not: '' } });
  });

  it('additionally requires a blind resume for a BLIND client', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }]), {
      visibility: 'BLIND'
    });
    expect(where.AND).toContainEqual({ blindResumeUrl: { not: null } });
    expect(where.AND).toContainEqual({ blindResumeUrl: { not: '' } });
  });

  it('does not require a blind resume for BASIC or FULL', () => {
    for (const visibility of ['BASIC', 'FULL']) {
      const { where } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }]), {
        visibility
      });
      expect(where.AND).not.toContainEqual({ blindResumeUrl: { not: null } });
    }
  });
});

describe('buildApplicantWhere - field mapping', () => {
  it('ORs values within a row, case-insensitively, because gender is free-form form text', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female', 'Other'] }]));
    const clause = findClause(where, (c) => c.OR?.[0]?.gender);
    expect(clause).toEqual({
      OR: [
        { gender: { equals: 'Female', mode: 'insensitive' } },
        { gender: { equals: 'Other', mode: 'insensitive' } }
      ]
    });
  });

  it('expands a major row across major1 and major2', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'major', values: ['Economics'] }]));
    const clause = findClause(where, (c) => c.OR?.some((o) => o.major1 || o.major2));
    expect(clause.OR).toEqual([
      { major1: { equals: 'Economics', mode: 'insensitive' } },
      { major2: { equals: 'Economics', mode: 'insensitive' } }
    ]);
  });

  it('ANDs separate rows together', () => {
    const { where } = buildApplicantWhere(
      dsl([
        { field: 'graduationYear', values: ['2030'] },
        { field: 'gender', values: ['Female'] },
        { field: 'cumulativeGpa', op: 'gte', value: '3.50' }
      ])
    );
    expect(where.AND).toContainEqual({ cumulativeGpa: { gte: '3.50' } });
    // Two OR clauses from the filter rows - graduation year and gender. The
    // consent gate is an OR too, so it is excluded by name rather than counted.
    const rowOrs = where.AND.filter(
      (c) => c.OR && !JSON.stringify(c).includes('talentPoolOptIn')
    );
    expect(rowOrs.length).toBe(2);
  });

  it('passes booleans through as equality', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'isFirstGeneration', value: true }]));
    expect(where.AND).toContainEqual({ isFirstGeneration: true });
  });

  it('defaults to the active cycle and says so when no cycle row is given', () => {
    const { where, notes } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }]), {
      activeCycleId: 'cycle-1'
    });
    expect(where.AND).toContainEqual({ cycleId: 'cycle-1' });
    expect(notes.join(' ')).toMatch(/active recruiting cycle/i);
  });

  it('respects an explicit cycle row and drops the default', () => {
    const { where, notes } = buildApplicantWhere(
      dsl([{ field: 'cycleId', values: ['cycle-a', 'cycle-b'] }]),
      { activeCycleId: 'cycle-1' }
    );
    expect(where.AND).toContainEqual({ cycleId: { in: ['cycle-a', 'cycle-b'] } });
    expect(where.AND).not.toContainEqual({ cycleId: 'cycle-1' });
    expect(notes).toEqual([]);
  });

  it('matches nothing when the pool is members-only', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }], 'MEMBERS'));
    expect(where).toBeNull();
  });
});

describe('buildMemberResumeWhere', () => {
  it('always requires current, consented, non-withdrawn rows', () => {
    const { where } = buildMemberResumeWhere(
      dsl([{ field: 'gender', values: ['Female'] }], 'MEMBERS'),
      { visibility: 'BASIC' }
    );
    expect(where.AND).toContainEqual({ isCurrent: true });
    expect(where.AND).toContainEqual({ shareConsent: true });
    expect(where.AND).toContainEqual({ consentRevokedAt: null });
  });

  it('matches nothing for a BLIND client and explains why', () => {
    const { where, notes } = buildMemberResumeWhere(
      dsl([{ field: 'gender', values: ['Female'] }], 'MEMBERS'),
      { visibility: 'BLIND' }
    );
    expect(where).toBeNull();
    expect(notes.join(' ')).toMatch(/no redacted version/i);
  });

  it('ignores an applicant-only row instead of zeroing the pool, and names what it ignored', () => {
    // The old behaviour returned null here, which is why a filter scoped to a
    // recruiting cycle - the commonest one there is - showed no members at all.
    const { where, notes, unnarrowedBy } = buildMemberResumeWhere(
      dsl(
        [
          { field: 'gender', values: ['Female'] },
          { field: 'cumulativeGpa', op: 'gte', value: '3.50' }
        ],
        'BOTH'
      ),
      { visibility: 'FULL' }
    );
    expect(where).not.toBeNull();
    expect(unnarrowedBy).toEqual(['Cumulative GPA']);
    expect(notes.join(' ')).toMatch(/does not narrow them/i);
    // The row it CAN answer still narrows.
    expect(JSON.stringify(where)).toContain('Female');
    // The one it cannot is absent rather than mistranslated.
    expect(JSON.stringify(where)).not.toContain('cumulativeGpa');
  });

  it('still applies every consent gate to a row the filter could not narrow', () => {
    const { where } = buildMemberResumeWhere(
      dsl([{ field: 'cycleId', values: ['cycle-a'] }], 'MEMBERS'),
      { visibility: 'FULL' }
    );
    expect(where.AND).toContainEqual({ shareConsent: true });
    expect(where.AND).toContainEqual({ consentRevokedAt: null });
    expect(where.AND).toContainEqual({ member: { isActive: true } });
  });

  it('matches nothing when the pool is applicants-only', () => {
    const { where } = buildMemberResumeWhere(
      dsl([{ field: 'gender', values: ['Female'] }], 'APPLICANTS'),
      { visibility: 'FULL' }
    );
    expect(where).toBeNull();
  });
});

describe('assignment keys', () => {
  it('round-trips', () => {
    expect(parseAssignmentKey(buildAssignmentKey('APPLICATION', 'abc-123'))).toEqual({
      kind: 'APPLICATION',
      id: 'abc-123'
    });
  });

  it('survives an id containing a colon', () => {
    expect(parseAssignmentKey('MEMBER_RESUME:a:b')).toEqual({ kind: 'MEMBER_RESUME', id: 'a:b' });
  });

  it('rejects unknown kinds, empty ids and non-strings', () => {
    expect(parseAssignmentKey('USER:abc')).toBeNull();
    expect(parseAssignmentKey('APPLICATION:')).toBeNull();
    expect(parseAssignmentKey(':abc')).toBeNull();
    expect(parseAssignmentKey(null)).toBeNull();
    expect(parseAssignmentKey({ kind: 'APPLICATION' })).toBeNull();
  });
});

describe('caps', () => {
  it('bounds preview and commit size above the whole assignable universe', () => {
    // The cap must stay ABOVE the set it bounds. Below it, the preview returns
    // the same unreachable first page every run and the tail can never be
    // assigned - which is how a client stalled at 521 of 762.
    expect(PREVIEW_CAP).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// The external pool: self-registered UCLA students
// ---------------------------------------------------------------------------

describe('buildExternalResumeWhere', () => {
  const rows = [{ field: 'graduationYear', values: ['2027'] }];

  it('gates on verified ownership as well as consent', () => {
    // The gate members do not have. A member is vouched for by having been
    // recruited; an external account is vouched for by nothing else.
    const { where } = buildExternalResumeWhere({ pool: 'EXTERNALS', rows }, { visibility: 'BASIC' });
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { shareConsent: true },
        { consentRevokedAt: null },
        { user: { emailVerifiedAt: { not: null }, isActive: true } }
      ])
    );
  });

  it('leaves the verification gate out of filterOnlyWhere, which is diagnostics only', () => {
    const { filterOnlyWhere } = buildExternalResumeWhere(
      { pool: 'EXTERNALS', rows },
      { visibility: 'BASIC' }
    );
    expect(JSON.stringify(filterOnlyWhere)).not.toMatch(/emailVerifiedAt/);
    expect(JSON.stringify(filterOnlyWhere)).not.toMatch(/shareConsent/);
  });

  it('matches nothing for a blind client, and says why', () => {
    const { where, notes } = buildExternalResumeWhere(
      { pool: 'EXTERNALS', rows },
      { visibility: 'BLIND' }
    );
    expect(where).toBeNull();
    expect(notes.join(' ')).toMatch(/redacted/);
  });

  it('matches nothing when the pool excludes it', () => {
    expect(buildExternalResumeWhere({ pool: 'APPLICANTS', rows }, { visibility: 'FULL' }).where).toBeNull();
    expect(buildExternalResumeWhere({ pool: 'MEMBERS', rows }, { visibility: 'FULL' }).where).toBeNull();
  });

  it('ignores the applicant-only field rather than zeroing the pool', () => {
    const { where, notes, unnarrowedBy } = buildExternalResumeWhere(
      { pool: 'BOTH', rows: [{ field: 'cumulativeGpa', op: 'gte', value: '3.50' }] },
      { visibility: 'FULL' }
    );
    expect(where).not.toBeNull();
    expect(unnarrowedBy).toEqual(['Cumulative GPA']);
    expect(notes.join(' ')).toMatch(/Cumulative GPA/);
    expect(where.AND).toContainEqual({ user: { emailVerifiedAt: { not: null }, isActive: true } });
  });
});

describe('pool widening', () => {
  const rows = [{ field: 'graduationYear', values: ['2027'] }];

  it("'BOTH' now reaches all three pools", () => {
    // Safe to widen the PREVIEW: a commit only ever assigns the explicit keys
    // the admin left checked, so nothing is assigned by this alone.
    const opts = { visibility: 'FULL' };
    expect(buildApplicantWhere({ pool: 'BOTH', rows }, opts).where).not.toBeNull();
    expect(buildMemberResumeWhere({ pool: 'BOTH', rows }, opts).where).not.toBeNull();
    expect(buildExternalResumeWhere({ pool: 'BOTH', rows }, opts).where).not.toBeNull();
  });

  it('selecting one pool excludes the other two', () => {
    const opts = { visibility: 'FULL' };
    expect(buildApplicantWhere({ pool: 'EXTERNALS', rows }, opts).where).toBeNull();
    expect(buildMemberResumeWhere({ pool: 'EXTERNALS', rows }, opts).where).toBeNull();
    expect(buildExternalResumeWhere({ pool: 'EXTERNALS', rows }, opts).where).not.toBeNull();
  });
});

describe('EXTERNAL_RESUME assignment keys', () => {
  it('round-trips', () => {
    const key = buildAssignmentKey('EXTERNAL_RESUME', 'er-1');
    expect(parseAssignmentKey(key)).toEqual({ kind: 'EXTERNAL_RESUME', id: 'er-1' });
  });

  it('still rejects an unknown kind', () => {
    expect(parseAssignmentKey('SOMETHING_ELSE:er-1')).toBeNull();
  });
});

describe('choosing several pools at once', () => {
  const rows = [{ field: 'graduationYear', values: ['2028'] }];
  // IDENTIFIED throughout: both uploaded-resume pools are withheld from a
  // blind client regardless of pool selection, which is a different rule and
  // has its own tests.
  const seen = { visibility: 'IDENTIFIED' };
  const covers = (dsl) => ({
    applicants: buildApplicantWhere(dsl, seen).where !== null,
    members: buildMemberResumeWhere(dsl, seen).where !== null,
    externals: buildExternalResumeWhere(dsl, seen).where !== null,
  });

  it('covers exactly the pools named, and no others', () => {
    expect(covers({ pools: ['APPLICANTS', 'EXTERNALS'], rows }))
      .toEqual({ applicants: true, members: false, externals: true });
  });

  it('supports a combination the old single-select could not express', () => {
    // Applicants plus students but not members had no spelling before: `pool`
    // could say one pool or all of them, never two of three.
    expect(covers({ pools: ['MEMBERS', 'EXTERNALS'], rows }))
      .toEqual({ applicants: false, members: true, externals: true });
  });

  it('behaves like the single-select when only one pool is named', () => {
    expect(covers({ pools: ['MEMBERS'], rows })).toEqual(covers({ pool: 'MEMBERS', rows }));
  });

  it('still honours the legacy single `pool`, which saved batches carry', () => {
    expect(covers({ pool: 'APPLICANTS', rows }))
      .toEqual({ applicants: true, members: false, externals: false });
  });

  it('treats legacy BOTH as every pool', () => {
    expect(covers({ pool: 'BOTH', rows }))
      .toEqual({ applicants: true, members: true, externals: true });
  });

  it.each([
    ['an absent selection', { rows }],
    ['an empty list', { pools: [], rows }],
    ['a list of nonsense', { pools: ['NOPE'], rows }],
  ])('widens to every pool rather than narrowing on %s', (_label, dsl) => {
    // Narrowing on a malformed value would hide candidates from a client with
    // nothing on screen to say why.
    expect(covers(dsl)).toEqual({ applicants: true, members: true, externals: true });
  });

  it('ignores unrecognized entries but keeps the valid ones', () => {
    expect(covers({ pools: ['APPLICANTS', 'NOPE'], rows }))
      .toEqual({ applicants: true, members: false, externals: false });
  });
});

describe('sanitizeFilterDsl and pools', () => {
  const rows = [{ field: 'graduationYear', values: ['2028'] }];

  it('normalizes a selection to an explicit list', () => {
    const { value } = sanitizeFilterDsl({ pools: ['EXTERNALS', 'APPLICANTS'], rows });
    // Emitted in canonical order, not the order they were clicked.
    expect(value.pools).toEqual(['APPLICANTS', 'EXTERNALS']);
  });

  it('collapses `pool` to the single value when exactly one is chosen', () => {
    expect(sanitizeFilterDsl({ pools: ['MEMBERS'], rows }).value.pool).toBe('MEMBERS');
  });

  it('reports BOTH in `pool` when several are chosen, so old readers still work', () => {
    expect(sanitizeFilterDsl({ pools: ['MEMBERS', 'EXTERNALS'], rows }).value.pool).toBe('BOTH');
  });

  it('rejects an explicitly empty selection rather than silently widening it', () => {
    const { errors } = sanitizeFilterDsl({ pools: [], rows });
    expect(errors.join(' ')).toMatch(/at least one pool/i);
  });

  it('expands a legacy BOTH into the full list', () => {
    expect(sanitizeFilterDsl({ pool: 'BOTH', rows }).value.pools)
      .toEqual(['APPLICANTS', 'MEMBERS', 'EXTERNALS']);
  });
});

describe('deactivated accounts', () => {
  const rows = [{ field: 'graduationYear', values: ['2028'] }];
  const seen = { visibility: 'IDENTIFIED' };

  it('are excluded from the member pool', () => {
    // A deactivated account is how this app records that someone has left.
    // The member pool used to check only consent, so a graduated member stayed
    // assignable to new clients indefinitely.
    const { gateClauses } = buildMemberResumeWhere({ pools: ['MEMBERS'], rows }, seen);
    expect(gateClauses).toContainEqual({ member: { isActive: true } });
  });

  it('are excluded from the external pool, as they always were', () => {
    const { gateClauses } = buildExternalResumeWhere({ pools: ['EXTERNALS'], rows }, seen);
    expect(gateClauses).toContainEqual({ user: { emailVerifiedAt: { not: null }, isActive: true } });
  });

  it('keeps the member gate non-negotiable, not something a filter can drop', () => {
    const { where } = buildMemberResumeWhere({ pools: ['MEMBERS'], rows }, seen);
    expect(where.AND).toContainEqual({ member: { isActive: true } });
  });
});
