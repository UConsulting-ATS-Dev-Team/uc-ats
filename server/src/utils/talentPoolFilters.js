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
// either uploaded-resume pool, so those pools drop such a row rather than
// answering it - see the unnarrowedBy note in buildMemberResumeWhere.
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
//
// It was 500, set when "every opted-in application in the system" was ~250 rows
// and the cap was therefore twice the entire assignable universe. Reading the
// consent gate as "has not opted out" tripled that universe to ~760, which put
// the cap BELOW it - and because the preview always takes the same first page
// by submitted date, the rows past the cap became unreachable: re-running the
// filter returned the identical page, every row already assigned, with nothing
// new to tick. An admin could get to 521 of 762 and then stall with no
// indication why.
//
// 2000 restores the original intent - comfortably above the whole assignable
// set - and matches MAX_MATERIALIZED in clientResumeQuery.js, which bounds the
// same universe from the portal side.
export const PREVIEW_CAP = 2000;

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
 * Returns { value: { pool, pools, rows, unfiltered }, errors: string[] }.
 *
 * No rows at all is legal and means "every assignable resume in the selected
 * pools" - the pool choice is the filter. A row set that was written and then
 * fully rejected is an ERROR, because that one would widen the match behind the
 * admin's back. See the note on the guard itself.
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

  if (rows.length === 0 && rawRows.length > 0) {
    // The distinction that matters. NO rows is a coherent request - "everything
    // in the pools I ticked" - and the pool selection is itself the filter.
    // Rows that were written and then all failed validation is a different
    // thing: the admin meant to narrow and the narrowing silently evaporated,
    // which is the one mistake here that cannot be walked back once a client
    // has seen the rows. That case still errors; an empty filter does not.
    errors.push(
      'None of those filters could be used. Fix them, or remove them to match the whole pool.'
    );
  }

  // True only when the admin wrote no rows at all - never as a consequence of
  // rows being dropped, which errors above. A caller reading this as "no
  // narrowing was applied" would otherwise treat a failed filter as a
  // deliberate one.
  const unfiltered = rows.length === 0 && rawRows.length === 0;

  return { value: { pool, pools, rows, unfiltered }, errors };
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
 * The applicant consent gate, read as "this PERSON has not said no".
 *
 * An explicit No is the one answer that makes an applicant permanently
 * unassignable. A null - every Fall 2025 applicant, and anyone whose form
 * predates the question - is not a refusal, it is an absence, and treating the
 * two the same hid the entire back catalogue from the network.
 *
 * The second clause is the part that is easy to get wrong, and did. Opt-in is
 * stored per APPLICATION, but consent belongs to the person: someone who
 * applied twice and answered No on one form has said no, full stop. Checking
 * only the row in hand let their other application - submitted before the
 * question existed, so null - stay assignable, which put two people who had
 * explicitly refused in front of a client. `applications: { none: ... }` asks
 * the question of every form they have ever submitted.
 *
 * Rows with no candidateId are matched on their own answer alone: an
 * unlinked application has no other rows to be contradicted by. Sync links
 * applications to a Candidate by studentId or email, so this is a small and
 * shrinking set - but it fails safe either way, because an unlinked row that
 * says No is still excluded by the first clause.
 *
 * Written as an OR rather than `{ not: false }` so the null branch is visible
 * at the call site: this clause decides who may be shared with an outside
 * organization, and it should not rest on the reader knowing how Prisma treats
 * NULL under a negation. Exported so the preview's diagnostics count exactly
 * what the gate excludes, rather than a restatement that could drift from it.
 */
export const NOT_OPTED_OUT = {
  AND: [
    { OR: [{ talentPoolOptIn: true }, { talentPoolOptIn: null }] },
    {
      OR: [
        { candidateId: null },
        { candidate: { applications: { none: { talentPoolOptIn: false } } } }
      ]
    }
  ]
};

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
    return { where: null, filterOnlyWhere: null, gateClauses: [], unnarrowedBy: [], notes };
  }

  // Clauses that come from the admin's filter, kept separate from the consent
  // gates so the preview can count what each gate excluded and say so. Only
  // `where` below is ever used to select rows for assignment - `filterOnlyWhere`
  // exists to answer "how many did consent remove?" and nothing else.
  const filterClauses = [{ resumeUrl: { not: '' } }];

  // Non-negotiable gates. Not admin-controllable.
  const gateClauses = [NOT_OPTED_OUT];

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
 * @returns {{ where: object|null, unnarrowedBy: string[], notes: string[] }}
 * where is null when this pool is out of scope entirely - not selected, or a
 * BLIND client that can never be shown an unredacted upload. `unnarrowedBy`
 * names the applicant-only filter rows this pool could not answer and therefore
 * ignored; the caller must flag those rows rather than presenting them as a
 * full match.
 */
export const buildMemberResumeWhere = (dsl, { visibility = 'BLIND' } = {}) => {
  const notes = [];
  const rows = dsl?.rows ?? [];

  if (!includesPool(dsl, 'MEMBERS')) {
    return { where: null, filterOnlyWhere: null, gateClauses: [], unnarrowedBy: [], notes };
  }

  if (visibility === 'BLIND') {
    // Applications carry a separately redacted blindResumeUrl. A member uploads
    // one file and there is no redacted variant of it, so there is nothing a
    // BLIND client could safely be shown.
    notes.push('Member resumes have no redacted version, so they cannot be assigned to a blind-visibility client.');
    return { where: null, filterOnlyWhere: null, gateClauses: [], unnarrowedBy: [], notes };
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
    // These rows are dropped for this pool rather than zeroing it. Zeroing was
    // the old behaviour and it made the commonest filter of all - a recruiting
    // cycle, which no uploaded resume has - silently return no members at all.
    // Dropping them means the rows below are narrowed by less than the admin
    // asked for, so they come back flagged and the builder leaves them
    // unticked: visible, explained, and one deliberate click from being shared.
    notes.push(
      `Member resumes do not record ${unsupported.join(', ')}, so that part of the filter does not narrow them. They are listed unticked - tick the ones you mean to share.`
    );
  }

  return {
    where: { AND: [...gateClauses, ...filterClauses] },
    filterOnlyWhere: { AND: [...filterClauses] },
    gateClauses,
    unnarrowedBy: unsupported,
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
 * @returns {{ where: object|null, unnarrowedBy: string[], notes: string[] }}
 * Same contract as buildMemberResumeWhere above.
 */
export const buildExternalResumeWhere = (dsl, { visibility = 'BLIND' } = {}) => {
  const notes = [];
  const rows = dsl?.rows ?? [];

  if (!includesPool(dsl, 'EXTERNALS')) {
    return { where: null, filterOnlyWhere: null, gateClauses: [], unnarrowedBy: [], notes };
  }

  if (visibility === 'BLIND') {
    // Applications carry a separately redacted blindResumeUrl. A student
    // uploads one file and there is no redacted variant of it, so there is
    // nothing a BLIND client could safely be shown.
    notes.push(
      'Student-uploaded resumes have no redacted version, so they cannot be assigned to a blind-visibility client.'
    );
    return { where: null, filterOnlyWhere: null, gateClauses: [], unnarrowedBy: [], notes };
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
    // Same rule as the member pool above: drop the rows this pool cannot
    // answer, flag what was dropped, and let the admin tick.
    notes.push(
      `Student-uploaded resumes do not record ${unsupported.join(', ')}, so that part of the filter does not narrow them. They are listed unticked - tick the ones you mean to share.`
    );
  }

  return {
    where: { AND: [...gateClauses, ...filterClauses] },
    filterOnlyWhere: { AND: [...filterClauses] },
    gateClauses,
    unnarrowedBy: unsupported,
    notes
  };
};

/**
 * Collapse applications to one row per PERSON, newest first.
 *
 * The applicant pool is keyed on Application, not on Candidate, so someone who
 * applied in two cycles is two rows - and assigning both puts the same person
 * in a client's library twice. 762 assignable rows are 627 people, and one
 * client was already holding 521 rows for 456 people.
 *
 * Rows must arrive newest-first: the first one seen for a person wins, which is
 * their most recent application and therefore their most recent resume. Same
 * key and same rule as the all-cycles roster in routes/admin.js, so the two
 * views of "how many applicants are there" cannot disagree.
 *
 * The `app:` fallback keeps an unlinked, email-less row as its own person
 * rather than collapsing every such row into one.
 */
export const personKey = (app) =>
  app.candidateId
  || (app.email ? `email:${String(app.email).trim().toLowerCase()}` : null)
  || (app.studentId ? `student:${String(app.studentId).trim()}` : null)
  || `app:${app.id}`;

export const dedupeApplicantsByPerson = (applications) => {
  const seen = new Set();
  const out = [];
  for (const app of applications) {
    const key = personKey(app);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(app);
  }
  return out;
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
