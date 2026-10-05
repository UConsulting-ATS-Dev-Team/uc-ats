#!/usr/bin/env node
// Link talent-portal accounts that belong to applicants to their application.
//
//   cd server && node scripts/link-talent-accounts.js                        # dry run
//   cd server && node scripts/link-talent-accounts.js --apply                # link the safe ones
//   cd server && node scripts/link-talent-accounts.js --link=<userId>:<UID> --apply
//
// A talent account has no UID, so ProtectedRoute sends it to /talent/profile
// from every page: an applicant holding one cannot reach interview sign-up.
// Sign-in now links them as it happens (src/services/applicantAccounts.js);
// this catches the accounts made before that, which may never sign in again
// before their interview.
//
// --apply links every account whose verified address is its applicant's, by
// the same rule sign-in uses. Every other account is listed with its reason,
// and with any applicant who has the same name - usually someone who applied
// under a UCLA address and signed up with a personal one. A name is not proof,
// so those are never linked automatically: confirm who it is, then link that
// one account with --link=<userId>:<UID> --apply.
//
// A JSON record of every account and what was done is written to
// scripts/output/, so a link can be traced (and undone by hand) later.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { planTalentAccountLinks, linkTalentAccountToUid, PLAN_REASONS } =
  await import('../src/services/applicantAccounts.js');

const apply = process.argv.includes('--apply');
const manual = process.argv.find((arg) => arg.startsWith('--link='))?.slice('--link='.length);

const outDir = join(__dirname, 'output');
fs.mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `link-talent-accounts-${apply ? 'apply' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const record = [];
// Written after every account, so an interrupted run still leaves a record of
// each link that committed before it stopped.
const save = (entry) => {
  record.push(entry);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
};

const linkOne = async (account, uid) => {
  if (!apply) return { applied: false };
  const updated = await linkTalentAccountToUid(account.id, uid);
  return updated
    ? { applied: true }
    : { applied: false, skipped: 'no longer an empty talent account, or the UID was taken meanwhile' };
};

try {
  if (manual) {
    // One account an admin has identified by hand. The UID must be an
    // applicant's and free; the account must be an empty talent account, which
    // linkTalentAccountToUid re-checks under the row lock.
    const [userId, uid] = manual.split(':');
    const account = await prisma.user.findUnique({ where: { id: userId || '' } });
    const candidate = uid ? await prisma.candidate.findUnique({ where: { studentId: uid } }) : null;
    const holder = uid ? await prisma.user.findUnique({ where: { studentId: uid }, select: { id: true, email: true } }) : null;

    const refusal =
      !account ? `no account ${userId}` :
      !candidate ? `no applicant has UID ${uid}` :
      holder ? `UID ${uid} already belongs to ${holder.email}; that is the account to sign in with` :
      account.isExternalTalent !== true || account.studentId ? `${account.email} is not a talent account` :
      null;
    if (refusal) {
      console.log(`REFUSED: ${refusal}`);
      process.exitCode = 1;
    } else {
      console.log(`${apply ? 'APPLY' : 'DRY RUN'}: link ${account.email} -> ${candidate.firstName} ${candidate.lastName} (UID ${uid}, ${candidate.email})`);
      const result = await linkOne(account, uid);
      if (result.skipped) {
        console.log(`  SKIPPED: ${result.skipped}`);
        process.exitCode = 1;
      }
      save({ account: { id: account.id, email: account.email }, uid, manual: true, ...result });
    }
  } else {
    const plan = await planTalentAccountLinks(prisma);
    const ready = plan.filter((p) => p.decision.link);
    const rest = plan.filter((p) => !p.decision.link);
    // Worth a look by hand: an applicant with the same name, or a UID typed on
    // the profile that was never confirmed.
    const hinted = rest.filter((p) => p.nameMatches.length > 0 || p.account.claimedStudentId);

    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${plan.length} talent account(s) without a UID`);
    console.log(`  to link: ${ready.length}   to check by hand: ${hinted.length}\n`);

    let failed = 0;
    for (const { account, decision } of ready) {
      console.log(`  LINK ${account.email} -> UID ${decision.link}`);
      let result;
      try {
        result = await linkOne(account, decision.link);
      } catch (error) {
        result = { applied: false, skipped: `failed: ${error.code ?? ''} ${error.message.split('\n').filter(Boolean).pop()}`.trim() };
      }
      if (result.skipped) {
        failed += 1;
        console.log(`    SKIPPED at write time: ${result.skipped}`);
      }
      save({ account: { id: account.id, email: account.email }, uid: decision.link, ...result });
    }

    for (const { account, decision, nameMatches } of hinted) {
      console.log(`\n  CHECK ${account.email} (${account.fullName}, user ${account.id}): ${PLAN_REASONS[decision.reason] || decision.reason}`);
      if (decision.holder) console.log(`    UID ${decision.uid} is held by ${decision.holder.email}`);
      if (account.claimedStudentId) {
        console.log(`    typed UID ${account.claimedStudentId} on their profile (not confirmed)`);
        console.log(`      to link: --link=${account.id}:${account.claimedStudentId} --apply`);
      }
      for (const match of nameMatches) {
        console.log(`    same name: ${match.firstName} ${match.lastName}, ${match.email}, UID ${match.studentId}`);
        console.log(`      to link: --link=${account.id}:${match.studentId} --apply`);
      }
      save({ account: { id: account.id, email: account.email }, reason: decision.reason, nameMatches, applied: false });
    }

    const counts = {};
    for (const { decision } of rest) counts[decision.reason] = (counts[decision.reason] || 0) + 1;
    console.log('\nLeft alone, by reason:');
    for (const [reason, count] of Object.entries(counts)) console.log(`  ${count}  ${PLAN_REASONS[reason] || reason}`);
    for (const { account, decision } of rest.filter((p) => !hinted.includes(p))) {
      save({ account: { id: account.id, email: account.email }, reason: decision.reason, applied: false });
    }

    if (failed) {
      console.log(`${failed} account(s) were not linked. Re-run to retry them.`);
      process.exitCode = 1;
    }
  }

  console.log(`\nRecord: ${outFile}`);
  if (!apply) console.log('Nothing was written. Re-run with --apply to link.');
} finally {
  await prisma.$disconnect();
}
