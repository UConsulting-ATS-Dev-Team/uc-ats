import { describe, it, expect } from 'vitest';
import {
  sanitizeFilterDsl,
  buildApplicantWhere,
  buildMemberResumeWhere,
  parseAssignmentKey,
  buildAssignmentKey,
  PREVIEW_CAP
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

  it('errors rather than matching everything when there are no rows', () => {
    const { value, errors } = sanitizeFilterDsl({ pool: 'APPLICANTS', rows: [] });
    expect(value.rows).toEqual([]);
    expect(errors).toContain('Add at least one filter before previewing.');
  });

  it('errors when every row is an unknown field, instead of falling back to an empty filter', () => {
    const { value, errors } = sanitizeFilterDsl({
      rows: [{ field: 'salaryExpectation', values: ['high'] }]
    });
    expect(value.rows).toEqual([]);
    expect(errors).toContain('Add at least one filter before previewing.');
    expect(errors.some((e) => e.includes('salaryExpectation'))).toBe(true);
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
  it('always requires talentPoolOptIn true', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'gender', values: ['Female'] }]));
    expect(where.AND).toContainEqual({ talentPoolOptIn: true });
  });

  it('requires it even when the filter mentions nothing else', () => {
    const { where } = buildApplicantWhere(dsl([{ field: 'graduationYear', values: ['2030'] }]));
    expect(where.AND).toContainEqual({ talentPoolOptIn: true });
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
    expect(where.AND.filter((c) => c.OR).length).toBe(2);
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

  it('names the applicant-only field instead of silently returning zero members', () => {
    const { where, notes } = buildMemberResumeWhere(
      dsl(
        [
          { field: 'gender', values: ['Female'] },
          { field: 'cumulativeGpa', op: 'gte', value: '3.50' }
        ],
        'BOTH'
      ),
      { visibility: 'FULL' }
    );
    expect(where).toBeNull();
    expect(notes.join(' ')).toMatch(/Cumulative GPA/);
    expect(notes.join(' ')).toMatch(/do not record/i);
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
  it('bounds preview and commit size', () => {
    expect(PREVIEW_CAP).toBe(500);
  });
});
