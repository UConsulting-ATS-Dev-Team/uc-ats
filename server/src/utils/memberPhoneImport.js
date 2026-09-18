// Pure matching logic for scripts/import-member-phones-from-csv.js, kept apart
// from the script so it can be tested without a database or a file.

import { normalizePhoneNumber } from './phone.js';

// RFC 4180-ish: quoted fields may hold commas, newlines and "" escapes.
export function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const text = content.replace(/^﻿/, '');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Carry each surviving row's real position in the file. Numbering the
  // filtered array instead means one blank row anywhere makes every "line N"
  // below it point at the wrong person, which is worse than no line number at
  // all when someone is reconciling a roster by hand.
  const nonEmpty = [];
  rows.forEach((r, i) => {
    if (r.some((v) => v.trim() !== '')) nonEmpty.push({ values: r, line: i + 1 });
  });
  if (!nonEmpty.length) return { headers: [], records: [] };
  const headers = nonEmpty[0].values.map((h) => h.trim());
  const records = nonEmpty.slice(1).map(({ values, line }) => {
    const record = { __line: line };
    headers.forEach((h, idx) => {
      record[h] = (values[idx] ?? '').trim();
    });
    return record;
  });
  return { headers, records };
}

export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Picks columns by header keyword. Explicit overrides win; a missing email or
// name column is fine as long as one of them exists.
export function detectColumns(headers, overrides = {}) {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (pred) => {
    const i = lower.findIndex(pred);
    return i === -1 ? null : headers[i];
  };
  return {
    email: overrides.email || find((h) => h.includes('email')),
    phone: overrides.phone || find((h) => h.includes('phone') || h.includes('mobile') || h.includes('cell')),
    firstName: overrides.firstName || find((h) => h.includes('first') && h.includes('name')),
    lastName: overrides.lastName || find((h) => h.includes('last') && h.includes('name')),
    name: overrides.name || find((h) => h.includes('name') && !h.includes('first') && !h.includes('last')
      && !h.includes('email') && !h.includes('user')),
  };
}

function rowName(record, columns) {
  if (columns.name && record[columns.name]) return record[columns.name];
  return [record[columns.firstName], record[columns.lastName]].filter(Boolean).join(' ');
}

// Returns one entry per CSV row, each tagged with what happened to it, plus the
// updates to write keyed by user id.
export function matchPhoneRows({ records, columns, users, overwrite = false }) {
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const byName = new Map();
  for (const u of users) {
    const key = normalizeName(u.fullName);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) || []), u]);
  }

  const results = [];
  const updates = new Map();
  // Every phone this run has already resolved for a user, whatever the outcome.
  // `updates` alone is not enough: a row that matched the number already on the
  // account produces no pending update, so a later row disagreeing about the
  // same person would sail past the conflict check and, under --overwrite,
  // quietly win. Two rows disagreeing is a roster problem and has to be said out
  // loud, not resolved by file order.
  const seen = new Map();

  for (const record of records) {
    const email = columns.email ? record[columns.email]?.toLowerCase() : '';
    const name = rowName(record, columns);
    const rawPhone = columns.phone ? record[columns.phone] : '';
    const base = { line: record.__line, email, name, rawPhone };

    let user = email ? byEmail.get(email) : null;
    let matchedBy = user ? 'email' : null;
    if (!user) {
      const candidates = byName.get(normalizeName(name)) || [];
      if (candidates.length > 1) {
        results.push({ ...base, outcome: 'ambiguous-name', users: candidates.map((u) => u.email) });
        continue;
      }
      if (candidates.length === 1) {
        user = candidates[0];
        matchedBy = 'name';
      }
    }
    if (!user) {
      results.push({ ...base, outcome: 'not-ats-account' });
      continue;
    }

    const phone = normalizePhoneNumber(rawPhone);
    if (!phone) {
      results.push({ ...base, user, outcome: 'bad-phone' });
      continue;
    }

    const priorPhone = seen.get(user.id);
    if (priorPhone && priorPhone !== phone) {
      results.push({ ...base, user, phone, outcome: 'conflicting-phone', otherPhone: priorPhone });
      continue;
    }
    seen.set(user.id, phone);
    if (user.phoneNumber === phone) {
      results.push({ ...base, user, phone, outcome: 'unchanged' });
      continue;
    }
    if (user.phoneNumber && !overwrite) {
      results.push({ ...base, user, phone, outcome: 'kept-existing' });
      continue;
    }

    updates.set(user.id, { user, phone, matchedBy });
    results.push({ ...base, user, phone, outcome: matchedBy === 'email' ? 'matched-email' : 'matched-name' });
  }

  // A user whose rows disagreed gets nothing written: pick by hand.
  for (const r of results) {
    if (r.outcome === 'conflicting-phone') updates.delete(r.user.id);
  }

  return { results, updates: [...updates.values()] };
}
