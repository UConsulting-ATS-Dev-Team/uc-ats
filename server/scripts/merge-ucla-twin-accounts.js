#!/usr/bin/env node
// Fold each pair of accounts under one UCLA inbox (x@ucla.edu + x@g.ucla.edu)
// into one account.
//
//   cd server && node scripts/merge-ucla-twin-accounts.js            # dry run
//   cd server && node scripts/merge-ucla-twin-accounts.js --apply    # write
//
// The pairs come from Google sign-in creating a talent-portal account for the
// other spelling of an address somebody had already registered. The real
// account is kept; the talent account's resumes and Google link move onto it,
// and the talent account is deactivated, not deleted. Rules live in
// src/services/uclaTwinAccounts.js. Every pair that does not fit the simple
// shape is listed with its reason and left alone.
//
// A JSON record of every pair and what was done is written to scripts/output/,
// so a merge can be traced (and undone by hand) later.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { planUclaTwinMerges, mergeUclaTwinPair } = await import('../src/services/uclaTwinAccounts.js');

const apply = process.argv.includes('--apply');
const label = (u) => `${u.email} (${u.role === 'USER' ? (u.isExternalTalent ? 'talent' : 'candidate') : u.role.toLowerCase()})`;

try {
  const plan = await planUclaTwinMerges(prisma);
  const ready = plan.filter((p) => p.decision.ok);
  const refused = plan.filter((p) => !p.decision.ok);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${plan.length} pair(s) sharing a UCLA inbox`);
  console.log(`  to merge: ${ready.length}   left alone: ${refused.length}\n`);

  const record = [];
  for (const { decision: d } of ready) {
    const what = [
      d.moveResumeIds.length && `${d.moveResumeIds.length} resume(s)`,
      d.moveGoogle && 'Google link',
      d.fillVerified && 'verified address',
    ].filter(Boolean).join(', ') || 'nothing to move';
    console.log(`  keep ${label(d.keep)}  <-  retire ${label(d.retire)}   [${what}]`);

    let result = d;
    if (apply) {
      // Each pair is its own transaction, so one failure rolls back only that
      // pair and the rest still run.
      try {
        result = await mergeUclaTwinPair(d.keep.id, d.retire.id, prisma);
      } catch (error) {
        result = { ok: false, reason: `failed: ${error.code ?? ''} ${error.message.split('\n').filter(Boolean).pop()}`.trim() };
      }
      if (!result.ok) console.log(`    SKIPPED at write time: ${result.reason}`);
    }
    record.push({
      keep: { id: d.keep.id, email: d.keep.email },
      retire: { id: d.retire.id, email: d.retire.email, googleId: d.retire.googleId },
      movedResumeIds: d.moveResumeIds,
      demotedResumeIds: d.demoteResumeIds,
      movedGoogle: d.moveGoogle,
      applied: apply && result.ok,
      ...(result.ok ? {} : { skipped: result.reason }),
    });
  }

  for (const { users, decision } of refused) {
    console.log(`  LEFT ALONE ${users.map(label).join(' + ')}: ${decision.reason}`);
    record.push({ users: users.map((u) => ({ id: u.id, email: u.email })), refused: decision.reason });
  }

  const outDir = join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `merge-ucla-twin-accounts-${apply ? 'apply' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nRecord: ${outFile}`);
  if (!apply) console.log('Nothing was written. Re-run with --apply to merge.');
} finally {
  await prisma.$disconnect();
}
