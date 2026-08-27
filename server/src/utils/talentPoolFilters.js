// Translates the admin assignment filter into Prisma where clauses, for each of
// the three resume pools: applicants (Application), members (MemberResume) and
// self-registered UCLA students (ExternalResume).
//
// Pure on purpose - no prisma import - so the consent gates and the
// "never match everything" guards below are unit-testable without a database.
// Same shape as utils/gtkucProfile.js: exported constants plus a sanitizer that
// returns { value, errors } and leaves the route thin.
//
// Shape of the DSL:
//   { pool: 'APPLICANTS' | 'MEMBERS' | 'EXTERNALS' | 'BOTH',
//     rows: [ { field: 'graduationYear', values: ['2029', '2030'] },
//             { field: 'cumulativeGpa',  op: 'gte', value: '3.50' },
//             { field: 'isFirstGeneration', value: true } ] }
//
// Rows AND together. Values within a row OR. One field per row - that is the
// whole grammar, and it is what the builder UI produces.

// 'BOTH' predates the external pool and is kept as the "every pool" value
// rather than renamed: it is the value the admin UI already sends, and the
// saved filterJson on historical batches is documentation that is never
// re-run, so nothing depends on it having meant exactly two. It now widens the
// PREVIEW to three pools, which is safe because a commit only ever assigns the
// explicit keys the admin left checked - see the snapshot note in
// routes/talentPoolAdmin.js.
// The pools a resume can actually come from. `BOTH` is not one of them - it is
// the legacy way of saying "all of these".
export const CONCRETE_POOLS = ['APPLICANTS', 'MEMBERS', 'EXTERNALS'];

export const POOLS = [...CONCRETE_POOLS, 'BOTH'];

/**
 * Which pools this filter covers.
 *
 * Two spellings, one meaning. `pools: [...]` is what the builder sends now, so
 * an admin can pick any combination - applicants and students but not members,
 * say, which the old single `pool` could not express at all. `pool: 'X'` is the
 * old single-select, kept because saved filterJson on historical batches still
 * carries it and those records must keep reading the way they were written.
 *
 * Anything unrecognized - absent, empty, misspelled, or the legacy 'BOTH' -
 * means every pool. That is deliberate: this value decides what a client is
 * shown, and a filter that quietly narrowed itself because of a typo would hide
 * candidates with nothing to indicate it had happened.
 */
const selectedPools = (dsl) => {
  if (Array.isArray(dsl?.pools)) {
    const picked = CONCRETE_POOLS.filter((p) => dsl.pools.includes(p));
    if (picked.length > 0) return picked;
  }
  if (CONCRETE_POOLS.includes(dsl?.pool)) return [dsl.pool];
  return CONCRETE_POOLS;
};

const includesPool = (dsl, pool) => selectedPools(dsl).includes(pool);

export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED'
];

// `pool: 'both'` means the field exists on every pool - applicants, member
// resumes and external resumes. `applicants` fields have no equivalent on
// either uploaded-resume pool: a filter using one cannot match a member or
// external resume, which buildMemberResumeWhere and buildExternalResumeWhere
// report rather than silently returning zero rows.
export const FILTER_FIELDS = [
  { key: 'graduationYear', label: 'Graduation year', pool: 'both', type: 'multiText' },
  { key: 'gender', label: 'Gender', pool: 'both', type: 'multiText' },
  { key: 'major', label: 'Major', pool: 'both', type: 'multiText' },
  { key: 'cycleId', label: 'Recruiting cycle', pool: 'applicants', type: 'multiId' },
  { key: 'status', label: 'Application status', pool: 'applicants', type: 'multiId' },
  { key: 'cumulativeGpa', label: 'Cumulative GPA', pool: 'applicants', type: 'number' },
  { key: 'majorGpa', label: 'Major GPA', pool: 'applicants', type: 'number' },
  { key: 'isFirstGeneration', label: 'First-generation', pool: 'applicants', type: 'bool' },
  { key: 'isTransferStudent', label: 'Transfer student', pool: 'applicants', type: 'bool' }
];

const FIELD_BY_KEY = new Map(FILTER_FIELDS.map((f) => [f.key, f]));

export const NUMBER_OPS = ['gte', 'lte'];

// The preview never renders more than this, and a commit never accepts more.
// A runaway filter therefore cannot quietly hand a client thousands of resumes.
export const PREVIEW_CAP = 500;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const cleanStrings = (values) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
};

// Decimal columns are compared as strings. Passing a JS float here would let
// binary rounding decide who is in a GPA cut-off.
const cleanDecimal = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  return s;
};

/**
 * Normalize and validate raw filter input from the admin UI.
 * Returns { value: { pool, rows }, errors: string[] }.
 *
 * An empty or fully-invalid row set is an ERROR, never "match everything" -
 * see the guard note on buildApplicantWhere.
 */
export const sanitizeFilterDsl = (input) => {
  const errors = [];
  const raw = isPlainObject(input) ? input : {};

  // Normalized to an explicit list so everything downstream - the builders, the
  // saved filterJson, the preview - reads one shape. `pool` is still emitted
  // alongside it so a reader written against the old single-select keeps
  // working: it collapses to the one pool when exactly one is chosen, and to
  // the historical 'BOTH' otherwise.
  const requestedPools = Array.isArray(raw.pools)
    ? CONCRETE_POOLS.filter((p) => raw.pools.includes(p))
    : CONCRETE_POOLS.includes(raw.pool)
      ? [raw.pool]
      : raw.pool === 'BOTH'
        ? [...CONCRETE_POOLS]
        : [];

  if (Array.isArray(raw.pools) && requestedPools.length === 0) {
    errors.push('Choose at least one pool.');
  }

  const pools = requestedPools.length > 0 ? requestedPools : [...CONCRETE_POOLS];
  const pool = pools.length === 1 ? pools[0] : 'BOTH';

  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const rows = [];
  const usedFields = new Set();

  for (const rawRow of rawRows) {
    if (!isPlainObject(rawRow)) continue;

    const field = FIELD_BY_KEY.get(rawRow.field);
    if (!field) {
      if (rawRow.field) errors.push(`Unknown filter field "${rawRow.field}" was ignored.`);
      continue;
    }

    if (usedFields.has(field.key)) {
      errors.push(`"${field.label}" appears more than once - only the first was used.`);
      continue;
    }

    if (field.type === 'multiText' || field.type === 'multiId') {
      const values = cleanStrings(rawRow.values);
      if (values.length === 0) {
        errors.push(`Select at least one value for "${field.label}".`);
        continue;
      }
      if (field.key === 'status') {
        const bad = values.filter((v) => !APPLICATION_STATUSES.includes(v));
        if (bad.length > 0) {
          errors.push(`Unknown application status: ${bad.join(', ')}.`);
          continue;
        }
      }
      rows.push({ field: field.key, values });
      usedFields.add(field.key);
      continue;
    }

    if (field.type === 'number') {
      const op = NUMBER_OPS.includes(rawRow.op) ? rawRow.op : 'gte';
      const value = cleanDecimal(rawRow.value);
      if (value === null) {
        errors.push(`"${field.label}" needs a number like 3.50.`);
        continue;
      }
      rows.push({ field: field.key, op, value });
      usedFields.add(field.key);
      continue;
    }

    if (field.type === 'bool') {
      if (typeof rawRow.value !== 'boolean') {
        errors.push(`"${field.label}" needs a yes or no.`);
        continue;
      }
      rows.push({ field: field.key, value: rawRow.value });
      usedFields.add(field.key);
    }
  }

  if (rows.length === 0) {
    // Deliberately an error. "No filter" must never be read as "every resume":
    // that is the one mistake in this feature that cannot be walked back once a
    // client has seen the rows.
    errors.push('Add at least one filter before previewing.');
  }

  return { value: { pool, pools, rows }, errors };
};

// Prisma's `in` has no case-insensitive mode, and both gender and major are
// free text off a Google Form ("Female" / "female"). An OR of case-insensitive
// equals is the only way to match them reliably.
const anyOf = (column, values) => ({
  OR: values.map((v) => ({ [column]: { equals: v, mode: 'insensitive' } }))
});

const majorAnyOf = (values) => ({
  OR: values.flatMap((v) => [
    { major1: { equals: v, mode: 'insensitive' } },
    { major2: { equals: v, mode: 'insensitive' } }
  ])
});

/**
 * Build the Prisma where clause for the applicant pool.
 *
 * @returns {{ where: object|null, notes: string[] }} where is null when the
 * filter cannot match any applicant.
 */
export const buildApplicantWhere = (dsl, { visibility = 'BLIND', activeCycleId = null } = {}) => {
  const notes = [];
  const rows = dsl?.rows ?? [];

  if (!includesPool(dsl, 'APPLICANTS')) {
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  // Clauses that come from the admin's filter, kept separate from the consent
  // gates so the preview can count what each gate excluded and say so. Only
  // `where` below is ever used to select rows for assignment - `filterOnlyWhere`
  // exists to answer "how many did consent remove?" and nothing else.
  const filterClauses = [{ resumeUrl: { not: '' } }];

  // Non-negotiable gates. Not admin-controllable.
  const gateClauses = [
    // The consent record. An applicant who answered No, and every Fall 2025
    // applicant who was never asked (null), is never assignable.
    { talentPoolOptIn: true }
  ];

  if (visibility === 'BLIND') {
    // A BLIND client is only ever served blindResumeUrl, so an application
    // without one is not assignable to them at all.
    gateClauses.push({ blindResumeUrl: { not: null } });
    gateClauses.push({ blindResumeUrl: { not: '' } });
  }

  const AND = filterClauses;
  let sawCycleRow = false;

  for (const row of rows) {
    switch (row.field) {
      case 'graduationYear':
        AND.push(anyOf('graduationYear', row.values));
        break;
      case 'gender':
        AND.push(anyOf('gender', row.values));
        break;
      case 'major':
        AND.push(majorAnyOf(row.values));
        break;
      case 'cycleId':
        AND.push({ cycleId: { in: row.values } });
        sawCycleRow = true;
        break;
      case 'status':
        AND.push({ status: { in: row.values } });
        break;
      case 'cumulativeGpa':
      case 'majorGpa':
        AND.push({ [row.field]: { [row.op]: row.value } });
        break;
      case 'isFirstGeneration':
      case 'isTransferStudent':
        AND.push({ [row.field]: row.value });
        break;
      default:
        break;
    }
  }

  // Without an explicit cycle row, scope to the active cycle rather than every
  // application ever submitted - and say so, so the admin can add an explicit
  // "all cycles" row if that is what they meant.
  if (!sawCycleRow && activeCycleId) {
    AND.push({ cycleId: activeCycleId });
    notes.push('Limited to the active recruiting cycle. Add a cycle filter to widen it.');
  }

  return {
    where: { AND: [...gateClauses, ...filterClauses] },
    filterOnlyWhere: { AND: [...filterClauses] },
    gateClauses,
    notes
  };
};

/**
 * Build the Prisma where clause for the member resume pool.
 *
 * @returns {{ where: object|null, notes: string[] }} where is null when the
 * filter cannot match any member resume - which the caller must surface rather
 * than rendering an empty result as "nothing matched".
 */
export const buildMemberResumeWhere = (dsl, { visibility = 'BLIND' } = {}) => {
  const notes = [];
  const rows = dsl?.rows ?? [];

  if (!includesPool(dsl, 'MEMBERS')) {
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  if (visibility === 'BLIND') {
    // Applications carry a separately redacted blindResumeUrl. A member uploads
    // one file and there is no redacted variant of it, so there is nothing a
    // BLIND client could safely be shown.
    notes.push('Member resumes have no redacted version, so they cannot be assigned to a blind-visibility client.');
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  const filterClauses = [{ isCurrent: true }];
  const gateClauses = [
    { shareConsent: true },
    { consentRevokedAt: null },
    // A deactivated account is how this app records that someone has left, and
    // their resume should stop going to recruiters. The external pool below has
    // always required this; the member pool did not, so a graduated member
    // stayed assignable indefinitely.
    { member: { isActive: true } },
  ];

  const AND = filterClauses;
  const unsupported = [];

  for (const row of rows) {
    switch (row.field) {
      case 'graduationYear':
        AND.push(anyOf('graduationYear', row.values));
        break;
      case 'gender':
        AND.push(anyOf('gender', row.values));
        break;
      case 'major':
        AND.push(majorAnyOf(row.values));
        break;
      default: {
        const field = FIELD_BY_KEY.get(row.field);
        if (field) unsupported.push(field.label);
        break;
      }
    }
  }

  if (unsupported.length > 0) {
    // Naming the field matters. Silently returning zero members when an
    // applicant-only filter is in play reads as "no members matched", which is
    // a different and wrong conclusion.
    notes.push(
      `Member resumes do not record ${unsupported.join(', ')}, so no member resume can match this filter.`
    );
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  return {
    where: { AND: [...gateClauses, ...filterClauses] },
    filterOnlyWhere: { AND: [...filterClauses] },
    gateClauses,
    notes
  };
};

/**
 * Build the Prisma where clause for the external resume pool - UCLA students
 * who registered through the public talent portal.
 *
 * Same shape as buildMemberResumeWhere, with one gate members do not need. A
 * member is vouched for by having been recruited; an external account is
 * vouched for by nothing except a verified ucla.edu address, so an unverified
 * or deactivated owner's resume is not assignable at any visibility. That gate
 * lives here, in the same place as the consent gate, so no caller can assemble
 * one without the other.
 *
 * @returns {{ where: object|null, notes: string[] }} where is null when the
 * filter cannot match any external resume - which the caller must surface
 * rather than rendering an empty result as "nothing matched".
 */
export const buildExternalResumeWhere = (dsl, { visibility = 'BLIND' } = {}) => {
  const notes = [];
  const rows = dsl?.rows ?? [];

  if (!includesPool(dsl, 'EXTERNALS')) {
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  if (visibility === 'BLIND') {
    // Applications carry a separately redacted blindResumeUrl. A student
    // uploads one file and there is no redacted variant of it, so there is
    // nothing a BLIND client could safely be shown.
    notes.push(
      'Student-uploaded resumes have no redacted version, so they cannot be assigned to a blind-visibility client.'
    );
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  const filterClauses = [{ isCurrent: true }];
  const gateClauses = [
    { shareConsent: true },
    { consentRevokedAt: null },
    { user: { emailVerifiedAt: { not: null }, isActive: true } }
  ];

  const AND = filterClauses;
  const unsupported = [];

  for (const row of rows) {
    switch (row.field) {
      case 'graduationYear':
        AND.push(anyOf('graduationYear', row.values));
        break;
      case 'gender':
        AND.push(anyOf('gender', row.values));
        break;
      case 'major':
        AND.push(majorAnyOf(row.values));
        break;
      default: {
        const field = FIELD_BY_KEY.get(row.field);
        if (field) unsupported.push(field.label);
        break;
      }
    }
  }

  if (unsupported.length > 0) {
    notes.push(
      `Student-uploaded resumes do not record ${unsupported.join(', ')}, so no student resume can match this filter.`
    );
    return { where: null, filterOnlyWhere: null, gateClauses: [], notes };
  }

  return {
    where: { AND: [...gateClauses, ...filterClauses] },
    filterOnlyWhere: { AND: [...filterClauses] },
    gateClauses,
    notes
  };
};

// Assignment keys are opaque to the client UI and are what a commit sends back.
export const ASSIGNMENT_KEY_KINDS = ['APPLICATION', 'MEMBER_RESUME', 'EXTERNAL_RESUME'];

export const buildAssignmentKey = (kind, id) => `${kind}:${id}`;

export const parseAssignmentKey = (key) => {
  if (typeof key !== 'string') return null;
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const kind = key.slice(0, idx);
  const id = key.slice(idx + 1).trim();
  if (!ASSIGNMENT_KEY_KINDS.includes(kind) || !id) return null;
  return { kind, id };
};
