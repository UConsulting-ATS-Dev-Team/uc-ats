#!/usr/bin/env node
// One-time move: copy case page images and PDFs from server/storage/ into the
// private Supabase "cases" bucket.
//
//   cd server && node scripts/migrate-case-files-to-storage.js          # dry run
//   cd server && node scripts/migrate-case-files-to-storage.js --apply  # upload
//
// Case files used to be written to the instance's own disk, which Render wipes on
// deploy (services/caseStorage.js). Run this from a checkout that still has the
// files: each one is uploaded under the key its row already names, so the row,
// and the page's tags, stay as they are.
//
// A file already in the bucket is never replaced, which makes the script safe
// to re-run; a storage error other than "not there" stops it. A row whose file
// is in neither place is listed at the end with what to do about it.

import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import fs from 'node:fs';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { default: supabase, isSupabaseAvailable } = await import('../src/supabaseClient.js');
const { CASE_BUCKET, putCaseFile, isMissingObjectError } = await import('../src/services/caseStorage.js');
const { LOCAL_STORAGE_ROOT } = await import('../src/services/resumeStorage.js');

const apply = process.argv.includes('--apply');

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

if (!isSupabaseAvailable()) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set; there is nowhere to copy to.');
  process.exit(1);
}

// Throws on anything but a clear yes or no: an outage read as "absent" would
// upload an older disk copy over what is there.
const inBucket = async (key) => {
  const { data, error } = await supabase.storage.from(CASE_BUCKET).exists(key);
  if (error && !isMissingObjectError(error)) throw error;
  return data === true;
};

const cases = await prisma.case.findMany({
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    title: true,
    pdfStoragePath: true,
    pages: { orderBy: { pageNumber: 'asc' }, select: { pageNumber: true, imageStoragePath: true } },
  },
});

const missing = [];
let copied = 0;
let already = 0;

for (const c of cases) {
  const files = [
    ...c.pages.map((p) => ({ key: p.imageStoragePath, label: `page ${p.pageNumber}` })),
    ...(c.pdfStoragePath ? [{ key: c.pdfStoragePath, label: 'original PDF' }] : []),
  ];
  let caseCopied = 0;
  let caseAlready = 0;
  const caseMissing = [];

  for (const file of files) {
    if (await inBucket(file.key)) {
      caseAlready++;
      continue;
    }
    const absolute = join(LOCAL_STORAGE_ROOT, file.key);
    if (!absolute.startsWith(join(LOCAL_STORAGE_ROOT, 'cases')) || !fs.existsSync(absolute)) {
      caseMissing.push(file.label);
      continue;
    }
    if (apply) {
      const contentType = CONTENT_TYPES[extname(file.key).toLowerCase()] || 'application/octet-stream';
      await putCaseFile(file.key, fs.readFileSync(absolute), contentType, { overwrite: false });
    }
    caseCopied++;
  }

  console.log(
    `${c.title} (${c.id}): ${caseCopied} ${apply ? 'copied' : 'to copy'}, ${caseAlready} already in storage, ` +
      `${caseMissing.length} missing`
  );
  copied += caseCopied;
  already += caseAlready;
  if (caseMissing.length) missing.push({ title: c.title, id: c.id, labels: caseMissing });
}

console.log(`\n${apply ? 'Copied' : 'Would copy'} ${copied}; ${already} already in storage.`);
const missingPages = missing
  .map((m) => ({ ...m, pages: m.labels.filter((l) => l !== 'original PDF').length }))
  .filter((m) => m.pages > 0);
const missingPdfs = missing.filter((m) => m.labels.includes('original PDF'));
if (missingPages.length) {
  console.log('\nPage images found nowhere. On the Cases page, use "Re-upload page images..." (keeps tags):');
  for (const m of missingPages) console.log(`  ${m.title} (${m.id}): ${m.pages} page image(s)`);
}
if (missingPdfs.length) {
  // Nothing displays the original PDF; the pages are what interviewers see.
  console.log(
    '\nOriginal PDF found nowhere. It is kept for reference only and nothing shows it. ' +
      '"Replace PDF..." stores it again but clears every page tag:'
  );
  for (const m of missingPdfs) console.log(`  ${m.title} (${m.id})`);
}
if (!apply) console.log('\nDry run. Nothing was uploaded; add --apply to copy.');

await prisma.$disconnect();
