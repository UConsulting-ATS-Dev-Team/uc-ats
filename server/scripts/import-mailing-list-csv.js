#!/usr/bin/env node
// One-time import of the UC recruiting-interest mailing list into the Marketing
// Drive folder, dropping anyone the ATS already knows about.
//
//   cd server && node scripts/import-mailing-list-csv.js <csv>            # dry run
//   cd server && node scripts/import-mailing-list-csv.js <csv> --apply    # upload
//
// Options:
//   --folder=<driveFolderId>   target folder (default: MARKETING_DRIVE_FOLDER_ID)
//   --email-col="Header"       when the email column is not detected
//   --name=<fileName>          name for the uploaded file
//   --out=<path>               also write the deduped CSV locally
//   --list-kept                print the surviving addresses, not just dropped ones
//
// The mailing list is being retired, so this is expected to run once. It is
// still safe to re-run: it only ever reads the ATS and writes a new Drive file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { parseCsv, toCsv } = await import('../src/utils/csv.js');
const {
  detectEmailColumn,
  indexExistingEmails,
  dedupeMailingList,
  summarize,
  OUTCOMES,
} = await import('../src/utils/mailingListImport.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const csvPath = args.find((a) => !a.startsWith('--'));

if (!csvPath) {
  console.error('Usage: node scripts/import-mailing-list-csv.js <csv> [--apply] [--folder=<id>]');
  process.exit(1);
}

const resolved = path.resolve(csvPath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const apply = flag('apply');
const folderId = option('folder') || process.env.MARKETING_DRIVE_FOLDER_ID;
const outPath = option('out');

const { headers, records } = parseCsv(fs.readFileSync(resolved, 'utf-8'));
const emailColumn = detectEmailColumn(headers, option('email-col'));

console.log(`CSV:    ${resolved}`);
console.log(`Rows:   ${records.length}`);
console.log(`Email column: ${emailColumn || '(none found)'}`);
console.log('');

if (!emailColumn) {
  console.error('Could not find an email column. Headers:', headers);
  console.error('Pass it explicitly, e.g. --email-col="Email Address"');
  process.exit(1);
}

try {
  // Every table holding a real person's address. DecisionMessage.email is left
  // out on purpose: it is a copy of Application.email made when a decision is
  // queued, so counting it would double-count the same person.
  const [users, candidates, applications, meetingSignups] = await Promise.all([
    prisma.user.findMany({ select: { email: true } }),
    prisma.candidate.findMany({ select: { email: true } }),
    prisma.application.findMany({ select: { email: true } }),
    prisma.meetingSignup.findMany({ select: { email: true } }),
  ]);

  const existingIndex = indexExistingEmails([
    ...users.map((u) => ({ email: u.email, source: 'user' })),
    ...candidates.map((c) => ({ email: c.email, source: 'candidate' })),
    ...applications.map((a) => ({ email: a.email, source: 'application' })),
    ...meetingSignups.map((m) => ({ email: m.email, source: 'meeting-signup' })),
  ]);

  console.log(`Known addresses in the ATS: ${existingIndex.size}`);
  console.log('');

  const { results, kept } = dedupeMailingList({ records, emailColumn, existingIndex });
  const { counts, bySource } = summarize(results);

  const LABELS = [
    [OUTCOMES.KEPT, 'Kept (not in the ATS)'],
    [OUTCOMES.ALREADY_IN_SYSTEM, 'Dropped - already in the ATS'],
    [OUTCOMES.DUPLICATE_IN_FILE, 'Dropped - repeated in this file'],
    [OUTCOMES.INVALID_EMAIL, 'Dropped - unreadable address'],
    [OUTCOMES.MISSING_EMAIL, 'Dropped - no address'],
  ];
  for (const [outcome, label] of LABELS) {
    console.log(`${label}: ${counts[outcome]}`);
  }
  console.log('');

  if (counts[OUTCOMES.ALREADY_IN_SYSTEM]) {
    // One address can match more than one table, so these do not sum to the
    // dropped count above.
    console.log('Where the already-in-the-ATS rows matched:');
    for (const [source, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source}: ${n}`);
    }
    console.log('');
  }

  const dropped = results.filter((r) => r.outcome !== OUTCOMES.KEPT);
  if (dropped.length) {
    console.log('Dropped rows:');
    for (const r of dropped) {
      const why = r.outcome === OUTCOMES.ALREADY_IN_SYSTEM ? `already in the ATS (${r.sources.join(', ')})`
        : r.outcome === OUTCOMES.DUPLICATE_IN_FILE ? `repeat of line ${r.firstSeenAt}`
        : r.outcome === OUTCOMES.INVALID_EMAIL ? `unreadable: "${r.raw}"`
        : 'no address';
      console.log(`  line ${r.line}  ${r.email || r.raw || '(blank)'} - ${why}`);
    }
    console.log('');
  }

  if (flag('list-kept')) {
    console.log('Kept rows:');
    for (const r of results.filter((x) => x.outcome === OUTCOMES.KEPT)) {
      console.log(`  line ${r.line}  ${r.email}`);
    }
    console.log('');
  }

  // Write the survivors with the source file's columns untouched: whoever picks
  // this file up later should see the list they recognise, minus the dropped rows.
  const outputHeaders = headers.filter((h) => h !== '__line');
  const csv = toCsv(outputHeaders, kept);
  const fileName = option('name')
    || `${path.basename(resolved, path.extname(resolved))}-deduped-${new Date().toISOString().slice(0, 10)}.csv`;

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), csv);
    console.log(`Wrote ${kept.length} row(s) to ${path.resolve(outPath)}`);
  }

  if (!apply) {
    console.log(`Dry run - ${kept.length} row(s) would be uploaded as "${fileName}".`);
    console.log(folderId
      ? `Target folder: ${folderId}. Re-run with --apply.`
      : 'No target folder set. Pass --folder=<driveFolderId> or set MARKETING_DRIVE_FOLDER_ID, then re-run with --apply.');
  } else if (!folderId) {
    console.error('--apply needs a target folder: pass --folder=<driveFolderId> or set MARKETING_DRIVE_FOLDER_ID.');
    process.exitCode = 1;
  } else {
    const { uploadFile, getFileMetadata } = await import('../src/services/google/drive.js');

    // Check the folder before writing. Uploading to a file id, or to a folder
    // the service account cannot see, otherwise fails in a way that reads like
    // a network problem.
    const folder = await getFileMetadata(folderId);
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      console.error(`${folderId} is "${folder.name}" (${folder.mimeType}), not a folder.`);
      process.exitCode = 1;
    } else {
      const uploaded = await uploadFile({ name: fileName, folderId, body: csv });
      console.log(`Uploaded ${kept.length} row(s) to "${folder.name}" as "${uploaded.name}".`);
      console.log(`  ${uploaded.webViewLink || uploaded.id}`);
    }
  }
} finally {
  await prisma.$disconnect();
}
