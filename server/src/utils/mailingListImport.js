// Pure dedup logic for scripts/import-mailing-list-csv.js, kept apart from the
// script so it can be tested without a database, a file or Google Drive.
//
// The mailing list is a single list of people who expressed interest in
// recruiting for UC. It is being retired, so this runs once: read the export,
// drop anyone the ATS already knows about, and keep the rest.

// Addresses are compared case-insensitively and stored lowercased everywhere in
// this codebase (there is a unique index on lower(email)), so a raw spreadsheet
// export will not match the database until it goes through here.
export function normalizeEmail(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  // Exports from mail tools often carry a display name: Joe Bruin <joe@ucla.edu>.
  const angled = str.match(/<([^>]+)>\s*$/);
  return (angled ? angled[1] : str).trim().toLowerCase();
}

// Deliberately loose. This rejects what is obviously not an address so the
// count of dropped rows means something; it is not an RFC 5322 validator, and a
// one-time import is not the place to invent one.
export function isPlausibleEmail(email) {
  return /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(email);
}

export function detectEmailColumn(headers, override) {
  // A misspelled --email-col must not be taken at face value. Every row would
  // return undefined for that field, every row would count as missing an
  // address, and --apply would upload a file containing nothing but headers.
  if (override) return headers.includes(override) ? override : null;
  const lower = headers.map((h) => h.toLowerCase());
  // Prefer a column that is exactly "email" over one that merely contains it,
  // so a sheet with both "Email" and "Email Verified" picks the address.
  const exact = lower.findIndex((h) => h === 'email' || h === 'email address' || h === 'e-mail');
  if (exact !== -1) return headers[exact];
  const loose = lower.findIndex((h) => h.includes('email') || h.includes('e-mail'));
  return loose === -1 ? null : headers[loose];
}

// `existing` is [{ email, source }] drawn from every table that holds a real
// person's address. One address can sit in several of them, so the sources are
// collected rather than overwritten - which of them matched is the only signal
// available for telling a past applicant apart from a current one.
export function indexExistingEmails(existing) {
  const index = new Map();
  for (const { email, source } of existing) {
    const key = normalizeEmail(email);
    if (!key) continue;
    const sources = index.get(key);
    if (sources) sources.add(source);
    else index.set(key, new Set([source]));
  }
  return index;
}

export const OUTCOMES = {
  KEPT: 'kept',
  ALREADY_IN_SYSTEM: 'already-in-system',
  DUPLICATE_IN_FILE: 'duplicate-in-file',
  INVALID_EMAIL: 'invalid-email',
  MISSING_EMAIL: 'missing-email',
};

// Returns one entry per CSV row tagged with what happened to it, plus `kept`:
// the rows that survive, in their original order and with their original
// columns untouched.
//
// Rows are never silently discarded. Every dropped row keeps its line number
// and its reason so the run can be reconciled against the source spreadsheet
// afterwards - a bare survivor count cannot be checked by anyone.
export function dedupeMailingList({ records, emailColumn, existingIndex }) {
  const results = [];
  const kept = [];
  const seenInFile = new Map();

  for (const record of records) {
    const raw = emailColumn ? record[emailColumn] : '';
    const email = normalizeEmail(raw);
    const base = { line: record.__line, raw: String(raw ?? '').trim(), email, record };

    if (!email) {
      results.push({ ...base, outcome: OUTCOMES.MISSING_EMAIL });
      continue;
    }
    if (!isPlausibleEmail(email)) {
      results.push({ ...base, outcome: OUTCOMES.INVALID_EMAIL });
      continue;
    }

    const firstSeenAt = seenInFile.get(email);
    if (firstSeenAt !== undefined) {
      results.push({ ...base, outcome: OUTCOMES.DUPLICATE_IN_FILE, firstSeenAt });
      continue;
    }

    const sources = existingIndex.get(email);
    if (sources) {
      results.push({ ...base, outcome: OUTCOMES.ALREADY_IN_SYSTEM, sources: [...sources].sort() });
      continue;
    }

    seenInFile.set(email, record.__line);
    results.push({ ...base, outcome: OUTCOMES.KEPT });
    kept.push(record);
  }

  return { results, kept };
}

export function summarize(results) {
  const counts = Object.fromEntries(Object.values(OUTCOMES).map((o) => [o, 0]));
  // Which table a dropped row matched, counted independently of the row totals:
  // one address can be both a Candidate and a User, so these deliberately do
  // not sum to the already-in-system count.
  const bySource = {};
  for (const r of results) {
    counts[r.outcome] += 1;
    for (const source of r.sources || []) bySource[source] = (bySource[source] || 0) + 1;
  }
  return { total: results.length, counts, bySource };
}

// Which columns hold a name, so an imported contact can be greeted by one.
// Exports vary: some split first and last, some carry one "Name" column, some
// have none at all. A contact with no name is still worth importing.
export function detectNameColumns(headers) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const find = (...names) => {
    const i = lower.findIndex((h) => names.includes(h));
    return i === -1 ? null : headers[i];
  };
  return {
    first: find('first name', 'firstname', 'first', 'given name'),
    last: find('last name', 'lastname', 'last', 'surname', 'family name'),
    full: find('name', 'full name', 'fullname'),
  };
}

// Turns the rows that survived dedup into contacts ready to store. A single
// name column is split on its first space, which is wrong for some names but
// only ever feeds a {{firstName}} greeting.
export function toContacts({ kept, emailColumn, nameColumns }) {
  return kept.map((record) => {
    let firstName = nameColumns.first ? record[nameColumns.first] : '';
    let lastName = nameColumns.last ? record[nameColumns.last] : '';
    if (!firstName && !lastName && nameColumns.full) {
      const [first, ...rest] = String(record[nameColumns.full] || '').trim().split(/\s+/);
      firstName = first || '';
      lastName = rest.join(' ');
    }
    return {
      email: normalizeEmail(record[emailColumn]),
      firstName: firstName || null,
      lastName: lastName || null,
    };
  });
}
