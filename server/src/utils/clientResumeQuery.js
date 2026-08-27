// Filtering, sorting and CSV shaping for the Talent Partner Network portal.
//
// Pure - no prisma, no express - for the same reason clientVisibility.js is:
// the properties that matter here are "a client can never filter or sort on a
// field their visibility hides" and "a CSV cell can never become an Excel
// formula", and both should be provable without a database.
//
// The division of labour with clientVisibility.js: that module decides what a
// client may SEE about one assignment; this one decides what they may ASK for
// across the set. They share a single source of truth - `visibility` - and the
// rule below keeps them from drifting: every filter and sort key here must
// correspond to a field projectAssignment() actually emits at that level.
// Otherwise a BLIND client could sort by GPA and read the ordering as data,
// which is the column leaking one bit at a time.

import { VISIBILITY_LEVELS, searchableFields } from './clientVisibility.js';

export const MAX_PAGE = 100;

// Sorting and faceting happen in memory (see the note on sortRows), so the set
// they run over has to be bounded. This ceiling is ~8x the entire assignable
// universe - every opted-in application in the system is ~250 rows - so it is a
// runaway guard, not a paging limit. When it bites, the response says so rather
// than quietly serving a sorted prefix as if it were the whole library.
export const MAX_MATERIALIZED = 2000;

// One export is one deliberate act by a person looking at a table. A request
// for more rows than this is a scrape, and the cap is the difference.
export const MAX_EXPORT = 1000;

const showsIdentity = (visibility) => visibility === 'BASIC' || visibility === 'FULL';
const showsContact = (visibility) => visibility === 'FULL';

export const KINDS = ['APPLICANT', 'MEMBER', 'EXTERNAL'];

// Which assignment column backs each kind. One map so the filter clause and any
// future kind stay in step with KINDS rather than drifting into a switch.
const KIND_COLUMN = {
  APPLICANT: 'applicationId',
  MEMBER: 'memberResumeId',
  EXTERNAL: 'externalResumeId'
};

// What a client sees in the Type column and the kind facet. "UCLA Student" and
// not "External": the word describes the person's relationship to UConsulting,
// which is internal vocabulary and means nothing to the buyer reading the CSV.
export const KIND_LABELS = {
  APPLICANT: 'Applicant',
  MEMBER: 'Member',
  EXTERNAL: 'UCLA Student'
};

/**
 * Which filters the UI may offer, and the server may honour, at a given level.
 * Graduation year and major are projected at every level; gender only from
 * BASIC; GPA only at FULL.
 */
export const filterableFields = (visibility) => {
  const fields = ['kind', 'graduationYear', 'major'];
  if (showsIdentity(visibility)) fields.push('gender');
  if (showsContact(visibility)) fields.push('gpa');
  return fields;
};

export const sortableFields = (visibility) => {
  const fields = ['graduationYear', 'major', 'kind', 'assignedAt'];
  if (showsIdentity(visibility)) fields.push('name', 'gender');
  // Every numeric column the projection emits is sortable, not just the one the
  // filter bar happens to offer a min/max for: a client reading a GPA in the
  // table expects to be able to order by it.
  if (showsContact(visibility)) fields.push('cumulativeGpa', 'majorGpa');
  return fields;
};

export const DEFAULT_SORT = { field: 'assignedAt', dir: 'desc' };

/**
 * The spreadsheet. Column order is the reading order of the table, and the set
 * is exactly what projectAssignment() emits at this level - so an export can
 * never carry a field the client could not already read on screen.
 */
/**
 * A short, stable handle for one row.
 *
 * Under BLIND there is no name, so without this a client has no way to say
 * "the second one" to their UConsulting contact. It is a prefix of the
 * assignment id, which the client already holds - the PDF URL is built from it
 * - so it discloses nothing new, and it stays put across sorts and pages.
 */
export const referenceFor = (assignmentId) =>
  String(assignmentId || '').replace(/-/g, '').slice(0, 8).toUpperCase();

export const exportColumns = (visibility) => {
  const cols = [{ key: 'reference', label: 'Reference' }];
  if (showsIdentity(visibility)) {
    cols.push({ key: 'firstName', label: 'First Name' }, { key: 'lastName', label: 'Last Name' });
  }
  cols.push(
    { key: 'kindLabel', label: 'Type' },
    { key: 'graduationYear', label: 'Graduation Year' },
    { key: 'major1', label: 'Major' },
    { key: 'major2', label: 'Second Major' }
  );
  if (showsIdentity(visibility)) cols.push({ key: 'gender', label: 'Gender' });
  if (showsContact(visibility)) {
    cols.push(
      { key: 'cumulativeGpa', label: 'Cumulative GPA' },
      { key: 'majorGpa', label: 'Major GPA' },
      { key: 'email', label: 'Email' },
      { key: 'phoneNumber', label: 'Phone' }
    );
  }
  cols.push(
    { key: 'assignedAtDate', label: 'Shared On' },
    { key: 'availableLabel', label: 'Resume Available' }
  );
  return cols;
};

const toArray = (value) => {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = String(item).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
};

// Decimals are compared as strings so binary float rounding never decides who
// falls on which side of a GPA cut-off - same rule as talentPoolFilters.js.
const cleanDecimal = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  return /^\d{1,2}(\.\d{1,2})?$/.test(s) ? s : null;
};

/**
 * Normalize raw query params into a filter/sort/page spec, dropping anything
 * the client's visibility does not permit.
 *
 * Silently dropping rather than erroring is deliberate for the visibility
 * fields: a 400 saying "gender is not filterable for you" is itself the
 * disclosure. Malformed input from our own UI still reports an error.
 *
 * @returns {{ value: object, errors: string[] }}
 */
export const sanitizeClientQuery = (query = {}, visibility = 'BLIND') => {
  const level = VISIBILITY_LEVELS.includes(visibility) ? visibility : 'BLIND';
  const errors = [];
  const allowedFilters = new Set(filterableFields(level));
  const allowedSorts = new Set(sortableFields(level));

  const filters = {};

  // One kind or the other narrows; selecting both is the same as selecting
  // neither, so it produces no clause rather than an impossible AND.
  const kinds = toArray(query.kind)
    .map((k) => k.toUpperCase())
    .filter((k) => KINDS.includes(k));
  if (kinds.length === 1) filters.kind = kinds[0];

  const graduationYear = toArray(query.graduationYear);
  if (graduationYear.length > 0) filters.graduationYear = graduationYear;

  const major = toArray(query.major);
  if (major.length > 0) filters.major = major;

  if (allowedFilters.has('gender')) {
    const gender = toArray(query.gender);
    if (gender.length > 0) filters.gender = gender;
  }

  if (allowedFilters.has('gpa')) {
    const gpaMin = cleanDecimal(query.gpaMin);
    const gpaMax = cleanDecimal(query.gpaMax);
    if (query.gpaMin && gpaMin === null) errors.push('Minimum GPA needs a number like 3.50.');
    if (query.gpaMax && gpaMax === null) errors.push('Maximum GPA needs a number like 3.50.');
    if (gpaMin !== null) filters.gpaMin = gpaMin;
    if (gpaMax !== null) filters.gpaMax = gpaMax;
  }

  const q = typeof query.q === 'string' ? query.q.trim() : '';

  const sortField = allowedSorts.has(query.sort) ? query.sort : DEFAULT_SORT.field;
  const sortDir = query.dir === 'asc' || query.dir === 'desc' ? query.dir : DEFAULT_SORT.dir;

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), MAX_PAGE);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);

  return {
    value: { q, filters, sort: { field: sortField, dir: sortDir }, limit, offset },
    errors
  };
};

// Both pools are free text off a Google Form ("Female" / "female"), and Prisma's
// `in` has no case-insensitive mode. Same workaround as talentPoolFilters.js.
const anyOfInsensitive = (column, values) => ({
  OR: values.map((v) => ({ [column]: { equals: v, mode: 'insensitive' } }))
});

const majorAnyOf = (values) => ({
  OR: values.flatMap((v) => [
    { major1: { equals: v, mode: 'insensitive' } },
    { major2: { equals: v, mode: 'insensitive' } }
  ])
});

// A filter names a field on the underlying row, which lives on one of three
// relations. Matching any of them is what makes "class of 2030" mean the same
// thing for an applicant, a member and a self-registered student.
const anyPool = (clause) => ({
  OR: [{ application: clause }, { memberResume: clause }, { externalResume: clause }]
});

/**
 * Translate a sanitized filter set into the Prisma `AND` fragments that narrow
 * a client's own assignment rows. Never includes the clientId / revokedAt
 * scoping - the route owns that, so this function cannot widen it.
 *
 * @returns {{ and: object[], notes: string[] }}
 */
export const buildAssignmentFilters = (filters = {}) => {
  const and = [];
  const notes = [];

  const kindColumn = KIND_COLUMN[filters.kind];
  if (kindColumn) and.push({ [kindColumn]: { not: null } });

  if (filters.graduationYear?.length) {
    and.push(anyPool(anyOfInsensitive('graduationYear', filters.graduationYear)));
  }
  if (filters.gender?.length) {
    and.push(anyPool(anyOfInsensitive('gender', filters.gender)));
  }
  if (filters.major?.length) {
    and.push(anyPool(majorAnyOf(filters.major)));
  }

  const gpa = {};
  if (filters.gpaMin) gpa.gte = filters.gpaMin;
  if (filters.gpaMax) gpa.lte = filters.gpaMax;
  if (Object.keys(gpa).length > 0) {
    // Uploaded resumes - member and student alike - carry no GPA, so a GPA
    // filter necessarily drops every one of those rows. Saying so beats letting
    // the client read the empty half as "no members matched".
    and.push({ application: { cumulativeGpa: gpa } });
    if (filters.kind !== 'APPLICANT') {
      notes.push('Uploaded resumes do not record a GPA, so a GPA filter shows applicants only.');
    }
  }

  return { and, notes };
};

/**
 * Free-text search across only the fields this visibility already exposes.
 *
 * The field list comes from searchableFields() in clientVisibility.js rather
 * than being restated here, so the two cannot drift. Its rule: under BLIND a
 * name search plus a result count is a yes/no oracle for "is this person in my
 * set", which is deanonymization by another route.
 */
export const buildSearchClause = (q, visibility) => {
  const contains = { contains: q, mode: 'insensitive' };
  const or = [];
  let uploadedNameAdded = false;

  for (const field of searchableFields(visibility)) {
    if (field === 'firstName' || field === 'lastName') {
      or.push({ application: { [field]: contains } });
      // The name behind an uploaded resume lives on the related User, not on
      // the resume row, so one clause per pool covers both name fields.
      if (!uploadedNameAdded) {
        or.push({ memberResume: { member: { fullName: contains } } });
        or.push({ externalResume: { user: { fullName: contains } } });
        uploadedNameAdded = true;
      }
      continue;
    }
    or.push({ application: { [field]: contains } });
    or.push({ memberResume: { [field]: contains } });
    or.push({ externalResume: { [field]: contains } });
  }

  return { OR: or };
};

const nameOf = (dto) => [dto.firstName, dto.lastName].filter(Boolean).join(' ').trim();

// A number wins over lexical ordering ("10.00" before "3.10"), but only when the
// value really is one. Graduation year is free text off a Google Form and can
// arrive as "Spring 2029"; coercing that to NaN would file it with the blanks
// at the bottom instead of sorting it among the years.
const asNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  return Number(s);
};

const sortValue = (dto, field) => {
  switch (field) {
    case 'name':
      return nameOf(dto) || null;
    case 'major':
      return dto.major1 ?? null;
    case 'kind':
      return dto.kind ?? null;
    case 'graduationYear':
    case 'cumulativeGpa':
    case 'majorGpa':
      return asNumber(dto[field] ?? null);
    case 'assignedAt':
      return dto.assignedAt ? new Date(dto.assignedAt).getTime() : null;
    default:
      return dto[field] ?? null;
  }
};

const isBlank = (v) => v === null || v === undefined || v === '' || Number.isNaN(v);

/**
 * Sort projected DTOs in memory.
 *
 * Why not `orderBy` in Prisma: an assignment points at an application OR a
 * member resume, and there is no orderBy that interleaves two nullable to-one
 * relations on the same column - `[{application:{...}},{memberResume:{...}}]`
 * sorts every member row to one end on the first key. In-memory sorting over a
 * set bounded by MAX_MATERIALIZED is the correct answer at this scale and gives
 * the table one consistent ordering across both pools.
 *
 * Blanks always sort last, in both directions: a missing major is not "before
 * A", it is absent, and burying it under the populated rows is what a reader
 * expects from a spreadsheet.
 */
export const sortRows = (rows, sort = DEFAULT_SORT) => {
  const { field, dir } = sort;
  const factor = dir === 'asc' ? 1 : -1;

  return [...rows].sort((rowA, rowB) => {
    const a = sortValue(rowA, field);
    const b = sortValue(rowB, field);
    const aBlank = isBlank(a);
    const bBlank = isBlank(b);

    if (aBlank || bBlank) {
      if (aBlank && !bBlank) return 1;
      if (!aBlank && bBlank) return -1;
    } else if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return (a - b) * factor;
    } else {
      const cmp = String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp * factor;
    }

    // Stable tiebreak so paging never reshuffles rows between requests.
    return String(rowA.assignmentId).localeCompare(String(rowB.assignmentId));
  });
};

/**
 * Facet values for the filter bar, derived from the client's own library so the
 * dropdowns only ever offer values that can actually return a row.
 *
 * Values are deduplicated case-insensitively and the first spelling wins, which
 * keeps "Female" and "female" from appearing as two choices that each match
 * both.
 */
export const buildFacets = (rows, visibility) => {
  const collect = (pick) => {
    const seen = new Map();
    for (const row of rows) {
      for (const value of pick(row)) {
        if (value === null || value === undefined) continue;
        const s = String(value).trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (!seen.has(key)) seen.set(key, s);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  };

  const facets = {
    graduationYear: collect((r) => [r.graduationYear]),
    major: collect((r) => [r.major1, r.major2]),
    kind: collect((r) => [r.kind])
  };

  if (showsIdentity(visibility)) {
    facets.gender = collect((r) => [r.gender]);
  }

  return facets;
};

// A cell beginning =, +, - or @ is executed as a formula by Excel and Sheets,
// and these cells hold applicant free text off a Google Form. Prefixing with an
// apostrophe is the standard neutralization and survives the round trip.
const NEUTRALIZE = /^[=+\-@\t\r]/;

export const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (NEUTRALIZE.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
};

const csvRowValues = (dto) => ({
  ...dto,
  reference: referenceFor(dto.assignmentId),
  kindLabel: KIND_LABELS[dto.kind] || 'Applicant',
  availableLabel: dto.available ? 'Yes' : 'No',
  assignedAtDate: dto.assignedAt ? new Date(dto.assignedAt).toISOString().slice(0, 10) : ''
});

/**
 * Render projected DTOs as CSV. Takes DTOs, never raw assignment rows, so a
 * column the projection omitted cannot reappear in the spreadsheet.
 *
 * CRLF line endings and a UTF-8 BOM: Excel on Windows reads a bare-LF, BOM-less
 * file as the system codepage, which mangles every non-ASCII name in it.
 */
export const toCsv = (rows, visibility) => {
  const columns = exportColumns(visibility);
  const lines = [columns.map((c) => escapeCsvCell(c.label)).join(',')];
  for (const dto of rows) {
    const values = csvRowValues(dto);
    lines.push(columns.map((c) => escapeCsvCell(values[c.key])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

export const csvFilename = (organization, now) => {
  const slug = String(organization || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  const date = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  return slug ? `${slug}-resumes-${date}.csv` : `resumes-${date}.csv`;
};
