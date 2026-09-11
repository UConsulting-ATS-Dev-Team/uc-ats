#!/usr/bin/env node
// One-time seal for everyone who is already staff.
//
// Records seal automatically when decision processing turns someone into a
// member. People who were members or admins before that existed still have
// readable files, so this seals every candidate whose student ID or email
// matches a current MEMBER or ADMIN account.
//
//   cd server && node scripts/backfill-exec-locks.js           # dry run: lists who would be sealed
//   cd server && node scripts/backfill-exec-locks.js --apply   # seals them, one audit row each
//
// Re-runnable: candidates that are already sealed are skipped.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

// Imported after .env is loaded: config.js throws without JWT_SECRET, and the
// Prisma client reads DATABASE_URL when it is constructed.
const { default: prisma } = await import('../src/prismaClient.js');
const { EXEC_ACCESS_ACTIONS, lockCandidateRecords } = await import('../src/services/execAccess.js');

const apply = process.argv.includes('--apply');

async function main() {
  const staff = await prisma.user.findMany({
    where: { role: { in: ['MEMBER', 'ADMIN'] } },
    select: { email: true, studentId: true }
  });
  const staffStudentIds = new Set(staff.map((user) => user.studentId).filter(Boolean).map(String));
  const staffEmails = new Set(staff.map((user) => user.email?.toLowerCase()).filter(Boolean));

  // Matched in memory because candidate emails are not reliably lower-case.
  const unsealed = await prisma.candidate.findMany({
    where: { recordsLockedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, studentId: true }
  });
  const matches = unsealed.filter((candidate) =>
    staffStudentIds.has(String(candidate.studentId)) || staffEmails.has(candidate.email?.toLowerCase())
  );

  console.log(`${staff.length} member/admin account(s); ${matches.length} unsealed candidate record(s) belong to them.`);
  for (const candidate of matches) {
    console.log(`  ${candidate.firstName} ${candidate.lastName} <${candidate.email}> (${candidate.studentId})`);
  }

  if (!apply) {
    console.log('\nDry run - nothing changed. Re-run with --apply to seal these records.');
    return;
  }

  let sealed = 0;
  for (const candidate of matches) {
    if (await lockCandidateRecords(candidate.id, { action: EXEC_ACCESS_ACTIONS.BACKFILL_LOCK })) {
      sealed += 1;
    }
  }
  console.log(`\nSealed ${sealed} record(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
