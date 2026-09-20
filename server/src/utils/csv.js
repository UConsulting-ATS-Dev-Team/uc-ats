// Shared CSV reading and writing. Lives apart from any one importer because
// more than one of them needs it: scripts/import-member-phones-from-csv.js and
// scripts/import-mailing-list-csv.js both start by parsing a spreadsheet export.

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

// Quote only when the value would otherwise change meaning, so a file that
// needed no quoting round-trips unchanged through parseCsv -> toCsv.
function escapeField(value) {
  const str = value == null ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Writes `headers` as the first line, then one line per record, reading each
// record by header name so a caller cannot silently shift columns.
export function toCsv(headers, records) {
  const lines = [headers.map(escapeField).join(',')];
  for (const record of records) {
    lines.push(headers.map((h) => escapeField(record[h])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
