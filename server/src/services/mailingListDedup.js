// One dedup run over a mailing-list export, shared by the two things that ask
// for one: scripts/import-mailing-list-csv.js and the Mailing List tab in
// Master Communications.
//
// The pure parts live in utils/mailingListImport.js. What lives here is the
// part that needs a database - which tables count as "the ATS already has this
// person" - plus the assembly of a whole run, so the script and the route
// cannot drift on either. Each caller keeps its own presentation: the script
// prints, the route returns JSON.

import prisma from '../prismaClient.js';
import { parseCsv, toCsv } from '../utils/csv.js';
import {
  detectEmailColumn,
  indexExistingEmails,
  dedupeMailingList,
  summarize,
  detectNameColumns,
  toContacts,
} from '../utils/mailingListImport.js';

// Every table holding a real person's address. DecisionMessage.email is left
// out on purpose: it is a copy of Application.email made when a decision is
// queued, so counting it would double-count the same person.
//
// Contacts already imported from an earlier upload count too, so running the
// same export twice imports nobody the second time.
export async function loadExistingEmailIndex(client = prisma) {
  const [users, candidates, applications, meetingSignups, mailingList] = await Promise.all([
    client.user.findMany({ select: { email: true } }),
    client.candidate.findMany({ select: { email: true } }),
    client.application.findMany({ select: { email: true } }),
    client.meetingSignup.findMany({ select: { email: true } }),
    client.mailingListContact.findMany({ select: { email: true } }),
  ]);

  return indexExistingEmails([
    ...users.map((u) => ({ email: u.email, source: 'user' })),
    ...candidates.map((c) => ({ email: c.email, source: 'candidate' })),
    ...applications.map((a) => ({ email: a.email, source: 'application' })),
    ...meetingSignups.map((m) => ({ email: m.email, source: 'meeting-signup' })),
    ...mailingList.map((m) => ({ email: m.email, source: 'mailing-list' })),
  ]);
}

// Saves the rows of an upload that survive dedup as MailingListContacts, so
// Master Communications can email them.
//
// The file is deduped again here rather than trusting a list the browser sends
// back: between the preview and the click, someone on the list may have
// applied, and the server is the only side that can see that.
export async function importMailingListCsv({ content, emailColumnOverride, fileName, importedById, client = prisma }) {
  const run = await dedupeMailingListCsv({ content, emailColumnOverride, client });
  if (!run.emailColumn) return { ...run, imported: 0 };

  const contacts = toContacts({
    kept: run.kept,
    emailColumn: run.emailColumn,
    nameColumns: detectNameColumns(run.headers),
  });

  // skipDuplicates covers two admins importing the same file at once: the
  // unique index on email decides, and the loser's rows are skipped.
  const { count } = contacts.length
    ? await client.mailingListContact.createMany({
      data: contacts.map((c) => ({ ...c, sourceFile: fileName || null, importedById: importedById || null })),
      skipDuplicates: true,
    })
    : { count: 0 };

  return { ...run, imported: count };
}

// Reads a CSV export and returns everything either caller needs to report on
// the run, including the deduped file itself.
//
// A file whose email column cannot be found is not an error here. The script
// exits on it, but the UI has to show the admin the headers so they can pick
// the column by hand, and it can only do that if this returns them. Callers
// decide what an absent `emailColumn` means to them.
export async function dedupeMailingListCsv({ content, emailColumnOverride, client } = {}) {
  const { headers, records } = parseCsv(content);
  const emailColumn = detectEmailColumn(headers, emailColumnOverride);

  if (!emailColumn) {
    return { headers, records, emailColumn: null, knownAddresses: 0, results: [], kept: [], summary: null, csv: null };
  }

  const existingIndex = await loadExistingEmailIndex(client);
  const { results, kept } = dedupeMailingList({ records, emailColumn, existingIndex });

  // The survivors keep the source file's columns untouched, so whoever picks
  // the file up later sees the list they recognise minus the dropped rows.
  // __line is ours, not theirs.
  const outputHeaders = headers.filter((h) => h !== '__line');

  return {
    headers,
    records,
    emailColumn,
    knownAddresses: existingIndex.size,
    results,
    kept,
    summary: summarize(results),
    csv: toCsv(outputHeaders, kept),
  };
}
