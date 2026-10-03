#!/usr/bin/env node
// One-time: send the "We Received Your Application" email to everyone who
// applied before form sync started sending it.
//
//   cd server && node scripts/send-application-received-backfill.js            # dry run
//   cd server && node scripts/send-application-received-backfill.js --apply    # send
//
// Options:
//   --cycle=<id>   a cycle other than the one applicants are currently applying to
//
// Who is owed one, and sending it once, is services/applicationReceipts.js -
// the same code form sync sends through. So the dry run lists exactly who
// --apply would write to, anyone sync already emailed is skipped, and this can
// run beside live sync, or be re-run after a partial run, without anyone
// getting two.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { resolveCandidateCycle } = await import('../src/services/activeCycle.js');
const { planApplicationReceipts, sendApplicationReceipts } = await import('../src/services/applicationReceipts.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cycleOption = args.find((a) => a.startsWith('--cycle='))?.split('=')[1];

// Keeps a long run well under the SES account's per-second send rate.
const PAUSE_MS = 150;

const cycle = cycleOption
  ? await prisma.recruitingCycle.findUnique({ where: { id: cycleOption } })
  : await resolveCandidateCycle(prisma);

if (!cycle) {
  console.error(cycleOption ? `No cycle with id ${cycleOption}` : 'No cycle is currently taking applications. Pass --cycle=<id>.');
  process.exit(1);
}

const summarize = ({ applicationCount, toSend, skipped }) => {
  console.log(`Cycle: ${cycle.name} (${cycle.id})`);
  console.log(`Applications: ${applicationCount}`);
  console.log(`Owed a receipt: ${toSend.length}`);
  console.log(`Skipped: ${skipped.length}`);
  const reasons = skipped.reduce((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] || 0) + 1 }), {});
  for (const [reason, count] of Object.entries(reasons)) console.log(`  ${count}  ${reason}`);
};

if (!apply) {
  const plan = await planApplicationReceipts({ cycle });
  summarize(plan);
  console.log('\nRecipients:');
  for (const r of plan.toSend) console.log(`  ${r.name} <${r.email}>`);
  if (plan.skipped.length) {
    console.log('\nSkipped:');
    for (const s of plan.skipped) console.log(`  ${s.name} <${s.email}>: ${s.reason}`);
  }
  console.log('\nDry run. Nothing was sent. Re-run with --apply to send.');
  await prisma.$disconnect();
  process.exit(0);
}

const result = await sendApplicationReceipts({
  cycle,
  pauseMs: PAUSE_MS,
  onProgress: (done, total) => {
    if (done % 25 === 0 || done === total) console.log(`  ${done}/${total}`);
  },
});

summarize(result);
console.log(`\nSent: ${result.sent}`);
console.log(`Failed: ${result.failed.length}`);
for (const f of result.failed) console.log(`  ${f.name} <${f.email}>: ${f.error}`);
const elsewhere = result.toSend.length - result.sent - result.failed.length;
if (elsewhere > 0) console.log(`Sent by another process meanwhile: ${elsewhere}`);
if (result.failed.length) console.log('Re-run with --apply to retry the failures; sent ones are skipped.');

await prisma.$disconnect();
process.exit(result.failed.length ? 1 : 0);
