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
// Only applications still waiting on a first decision get one: SUBMITTED or
// UNDER_REVIEW, on round 1. Telling someone already advanced or rejected that
// they "will hear from us shortly" would be wrong, so they are listed as
// skipped rather than sent.
//
// One email per person: two applications from the same address (either UCLA
// spelling) are one send. An address that already has an APPLICATION_RECEIVED
// row for this cycle that did not fail is skipped, so re-running after a
// partial run only sends what is left, and anyone form sync already emailed
// is not emailed twice.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const { default: prisma } = await import('../src/prismaClient.js');
const { resolveCandidateCycle } = await import('../src/services/activeCycle.js');
const { sendApplicationReceivedEmail } = await import('../src/services/emailNotifications.js');
const { emailIdentityKey } = await import('../src/utils/mailingListImport.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cycleOption = args.find((a) => a.startsWith('--cycle='))?.split('=')[1];

const WAITING_STATUSES = new Set(['SUBMITTED', 'UNDER_REVIEW']);
// Keeps a long run well under the SES account's per-second send rate.
const PAUSE_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cycle = cycleOption
  ? await prisma.recruitingCycle.findUnique({ where: { id: cycleOption } })
  : await resolveCandidateCycle(prisma);

if (!cycle) {
  console.error(cycleOption ? `No cycle with id ${cycleOption}` : 'No cycle is currently taking applications. Pass --cycle=<id>.');
  process.exit(1);
}

const applications = await prisma.application.findMany({
  where: { cycleId: cycle.id },
  select: { id: true, email: true, firstName: true, lastName: true, status: true, currentRound: true, submittedAt: true },
  orderBy: { submittedAt: 'asc' },
});

const alreadySent = new Set(
  (await prisma.communicationLog.findMany({
    where: { category: 'APPLICATION_RECEIVED', cycleId: cycle.id, status: { not: 'FAILED' } },
    select: { recipient: true },
  })).map((row) => emailIdentityKey(row.recipient))
);

const toSend = [];
const skipped = [];
const seen = new Set();

for (const app of applications) {
  const email = (app.email || '').trim();
  const name = [app.firstName, app.lastName].filter(Boolean).join(' ') || 'Applicant';
  const key = email ? emailIdentityKey(email) : null;
  const skip = (reason) => skipped.push({ name, email: email || '(none)', reason });

  if (!email) skip('no email on the application');
  else if (seen.has(key)) skip('second application from the same address');
  else if (alreadySent.has(key)) skip('already sent');
  else if (!WAITING_STATUSES.has(app.status) || (app.currentRound && app.currentRound !== '1')) {
    skip(`already decided (status ${app.status}, round ${app.currentRound ?? '-'})`);
  } else toSend.push({ email, name });

  if (key) seen.add(key);
}

console.log(`Cycle: ${cycle.name} (${cycle.id})`);
console.log(`Applications: ${applications.length}`);
console.log(`Will send: ${toSend.length}`);
console.log(`Skipped: ${skipped.length}`);

const reasons = skipped.reduce((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] || 0) + 1 }), {});
for (const [reason, count] of Object.entries(reasons)) console.log(`  ${count}  ${reason}`);

if (!apply) {
  console.log('\nRecipients:');
  for (const r of toSend) console.log(`  ${r.name} <${r.email}>`);
  if (skipped.length) {
    console.log('\nSkipped:');
    for (const s of skipped) console.log(`  ${s.name} <${s.email}>: ${s.reason}`);
  }
  console.log('\nDry run. Nothing was sent. Re-run with --apply to send.');
  await prisma.$disconnect();
  process.exit(0);
}

let sent = 0;
const failed = [];
for (const [i, r] of toSend.entries()) {
  const result = await sendApplicationReceivedEmail(r.email, r.name, cycle.name, { cycleId: cycle.id });
  if (result?.success === false) failed.push({ ...r, error: result.error });
  else sent += 1;
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${toSend.length}`);
  await sleep(PAUSE_MS);
}

console.log(`\nSent: ${sent}`);
console.log(`Failed: ${failed.length}`);
for (const f of failed) console.log(`  ${f.name} <${f.email}>: ${f.error}`);
if (failed.length) console.log('Re-run with --apply to retry the failures; successful sends are skipped.');

await prisma.$disconnect();
process.exit(failed.length ? 1 : 0);
