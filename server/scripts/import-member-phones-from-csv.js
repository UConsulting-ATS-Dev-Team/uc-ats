#!/usr/bin/env node
// Import staff phone numbers (User.phoneNumber) from a roster CSV, for iMessage
// in Master Communications.
//
//   cd server && node scripts/import-member-phones-from-csv.js <csv>            # dry run
//   cd server && node scripts/import-member-phones-from-csv.js <csv> --apply    # write
//
// Options:
//   --overwrite            replace a number already on file
//   --email-col="Header"   --name-col="Header"   --phone-col="Header"
//   --first-col="Header"   --last-col="Header"   (when headers are not detected)
//
// Only ADMIN and MEMBER accounts are matched - the roster will hold people with
// no ATS account and they are reported, not created. Rows match by email first
// (case-insensitive), then by full name when exactly one account has that name.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { parseCsv, detectColumns, matchPhoneRows } = await import('../src/utils/memberPhoneImport.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const csvPath = args.find((a) => !a.startsWith('--'));

if (!csvPath) {
  console.error('Usage: node scripts/import-member-phones-from-csv.js <csv> [--apply] [--overwrite]');
  process.exit(1);
}

const resolved = path.resolve(csvPath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const apply = flag('apply');
const { headers, records } = parseCsv(fs.readFileSync(resolved, 'utf-8'));
const columns = detectColumns(headers, {
  email: option('email-col'),
  name: option('name-col'),
  phone: option('phone-col'),
  firstName: option('first-col'),
  lastName: option('last-col'),
});

console.log(`CSV: ${resolved}`);
console.log(`Rows: ${records.length}`);
console.log('Columns:', columns);
console.log('');

if (!columns.phone || (!columns.email && !columns.name && !columns.firstName)) {
  console.error('Could not find a phone column and an email or name column. Headers:', headers);
  console.error('Pass them explicitly, e.g. --phone-col="Phone Number" --name-col="Full Name"');
  process.exit(1);
}

try {
  const users = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'MEMBER'] } },
    select: { id: true, email: true, fullName: true, role: true, isActive: true, phoneNumber: true },
  });

  const { results, updates } = matchPhoneRows({ records, columns, users, overwrite: flag('overwrite') });

  const groups = {};
  for (const r of results) (groups[r.outcome] ||= []).push(r);

  const describe = (r) => {
    const who = r.user ? `${r.user.fullName} <${r.user.email}>${r.user.isActive ? '' : ' (inactive)'}` : (r.name || r.email || '?');
    switch (r.outcome) {
      case 'matched-email':
      case 'matched-name':
        return `${who}: ${r.user.phoneNumber ? `${r.user.phoneNumber} -> ` : ''}${r.phone}`;
      case 'kept-existing':
        return `${who}: has ${r.user.phoneNumber}, CSV says ${r.phone} (use --overwrite)`;
      case 'unchanged':
        return `${who}: ${r.phone}`;
      case 'bad-phone':
        return `${who}: could not read "${r.rawPhone}"`;
      case 'ambiguous-name':
        return `${r.name}: several accounts - ${r.users.join(', ')}`;
      case 'conflicting-phone':
        return `${who}: rows disagree (${r.otherPhone} vs ${r.phone}); nothing written`;
      default:
        return who;
    }
  };

  const ORDER = [
    ['matched-email', 'Matched by email'],
    ['matched-name', 'Matched by name - check these'],
    ['unchanged', 'Already on file'],
    ['kept-existing', 'Different number already on file'],
    ['conflicting-phone', 'Conflicting rows'],
    ['ambiguous-name', 'Ambiguous name'],
    ['bad-phone', 'Unreadable phone number'],
    ['not-ats-account', 'Not an ATS member or admin (skipped)'],
  ];
  for (const [key, title] of ORDER) {
    const list = groups[key] || [];
    console.log(`${title}: ${list.length}`);
    if (key === 'not-ats-account') continue;
    for (const r of list) console.log(`  line ${r.line}  ${describe(r)}`);
  }
  console.log('');

  const covered = new Set([
    ...updates.map((u) => u.user.id),
    ...users.filter((u) => u.phoneNumber).map((u) => u.id),
  ]);
  const missing = users.filter((u) => u.isActive && !covered.has(u.id));
  console.log(`Active members/admins still without a number: ${missing.length}`);
  for (const u of missing) console.log(`  ${u.fullName} <${u.email}> (${u.role})`);
  console.log('');

  if (!apply) {
    console.log(`Dry run - ${updates.length} number(s) would be written. Re-run with --apply.`);
  } else {
    for (const { user, phone } of updates) {
      await prisma.user.update({ where: { id: user.id }, data: { phoneNumber: phone } });
    }
    console.log(`Wrote ${updates.length} phone number(s).`);
  }
} finally {
  await prisma.$disconnect();
}
