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
//   --allow-empty              upload even when no rows survived dedup
//
// The mailing list is being retired, so this is expected to run once. It is
// still safe to re-run: it only ever reads the ATS and writes a new Drive file.
//
// The dedup itself lives in src/services/mailingListDedup.js, shared with the
// Mailing List tab in Master Communications. This file is the command line
// around it: arguments, printing, and the Drive upload.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { dedupeMailingListCsv } = await import('../src/services/mailingListDedup.js');
const { OUTCOMES } = await import('../src/utils/mailingListImport.js');

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

try {
  const {
    headers, records, emailColumn, knownAddresses, results, kept, summary, csv,
  } = await dedupeMailingListCsv({
    content: fs.readFileSync(resolved, 'utf-8'),
    emailColumnOverride: option('email-col'),
  });

  console.log(`CSV:    ${resolved}`);
  console.log(`Rows:   ${records.length}`);
  console.log(`Email column: ${emailColumn || '(none found)'}`);
  console.log('');

  if (!emailColumn) {
    const override = option('email-col');
    if (override) {
      console.error(`--email-col="${override}" matches no column in this file.`);
    } else {
      console.error('Could not find an email column.');
    }
    console.error('Headers:', headers);
    console.error('Pass one explicitly, e.g. --email-col="Email Address"');
    // Exits past the finally below, so the disconnect is skipped. That is fine
    // for a command line tool the OS is about to reap, and the alternative -
    // threading a "stop here" flag through the rest of the run - buys nothing.
    process.exit(1);
  }

  console.log(`Known addresses in the ATS: ${knownAddresses}`);
  console.log('');

  const { counts, bySource } = summary;

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
  } else if (!kept.length && !flag('allow-empty')) {
    // A file with nothing but a header row is what a wrong column or a wrong
    // file looks like, and it is indistinguishable from a real list where
    // everyone was already in the ATS. Make someone say which one they meant.
    console.error('No rows survived, so there is no list to upload.');
    console.error('Check the email column and the source file, or pass --allow-empty if a header-only file is really what you want.');
    process.exitCode = 1;
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
