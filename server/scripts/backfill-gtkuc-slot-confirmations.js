#!/usr/bin/env node
// Send the "your GTKUC slot is open" confirmation, with its calendar invite, to
// every host whose slot was opened before that email existed.
//
// Opening a slot sends this automatically now. Slots opened earlier never got
// it, so their hosts have no calendar entry until a candidate books, and none
// at all if nobody does.
//
//   cd server && node scripts/backfill-gtkuc-slot-confirmations.js                        # dry run, candidate-active cycle
//   cd server && node scripts/backfill-gtkuc-slot-confirmations.js --cycle "Fall 2026"    # dry run, a named cycle
//   cd server && node scripts/backfill-gtkuc-slot-confirmations.js --apply                # sends
//
// Covers slots that start inside the cycle's dates and have not started yet -
// the same slots candidates can book. A slot that already has bookings gets an
// invite naming them, because its host already has an entry from the signup
// emails and an "open slot" invite would overwrite it.
//
// Re-runnable: a slot whose confirmation was already sent is skipped.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

// Imported after .env is loaded: config.js throws without JWT_SECRET, and the
// Prisma client reads DATABASE_URL when it is constructed.
const { default: prisma } = await import('../src/prismaClient.js');
const { resolveCandidateCycle } = await import('../src/services/activeCycle.js');
const { notifyHostSlotCreated, MEETING_COMM_SUBJECTS } = await import('../src/services/meetingComms.js');
const { formatEmailDateTime } = await import('../src/utils/timezoneUtils.js');

const apply = process.argv.includes('--apply');
const cycleFlag = process.argv.indexOf('--cycle');
const cycleName = cycleFlag !== -1 ? process.argv[cycleFlag + 1] : null;

async function findCycle() {
  if (cycleName) {
    return prisma.recruitingCycle.findUnique({ where: { name: cycleName } });
  }
  return resolveCandidateCycle(prisma);
}

async function main() {
  if (cycleFlag !== -1 && !cycleName) {
    throw new Error('--cycle needs a name, e.g. --cycle "Fall 2026"');
  }
  if (apply && !process.env.EMAIL_FROM) {
    throw new Error('EMAIL_FROM is not set, so no calendar invite could be built. Set it before --apply.');
  }

  const cycle = await findCycle();
  if (!cycle) {
    throw new Error(cycleName ? `No cycle named "${cycleName}".` : 'No cycle is active for candidates. Pass --cycle "<name>".');
  }
  if (!cycle.startDate && !cycle.endDate) {
    throw new Error(`Cycle "${cycle.name}" has no dates, so its slots cannot be told apart from other cycles'.`);
  }

  const now = new Date();
  const earliest = cycle.startDate && cycle.startDate > now ? cycle.startDate : now;
  const slots = await prisma.meetingSlot.findMany({
    where: {
      startTime: { gte: earliest, ...(cycle.endDate ? { lte: cycle.endDate } : {}) },
    },
    include: {
      member: { select: { fullName: true, email: true } },
      signups: { select: { fullName: true }, orderBy: { createdAt: 'asc' } },
      communications: {
        where: { type: 'HOST_NOTIFICATION', signupId: null, subject: MEETING_COMM_SUBJECTS.SLOT_CREATED, status: 'SENT' },
        select: { id: true },
      },
    },
    orderBy: { startTime: 'asc' },
  });

  const alreadySent = slots.filter((slot) => slot.communications.length > 0);
  const noEmail = slots.filter((slot) => !slot.communications.length && !slot.member?.email);
  const due = slots.filter((slot) => !slot.communications.length && slot.member?.email);

  console.log(`Cycle: ${cycle.name}`);
  console.log(
    `${slots.length} upcoming slot(s): ${due.length} to confirm, ${alreadySent.length} already confirmed, ` +
      `${noEmail.length} with no host email.`
  );
  for (const slot of due) {
    const booked = slot.signups.length ? ` - booked: ${slot.signups.map((s) => s.fullName).join(', ')}` : '';
    console.log(
      `  ${slot.member.fullName} <${slot.member.email}>  ${formatEmailDateTime(slot.startTime)} @ ${slot.location}${booked}`
    );
  }
  for (const slot of noEmail) {
    console.log(`  SKIP (host has no email): slot ${slot.id} ${formatEmailDateTime(slot.startTime)}`);
  }

  if (!apply) {
    console.log('\nDry run - nothing sent. Re-run with --apply to email these hosts.');
    return;
  }

  let sent = 0;
  const failed = [];
  // One at a time: Gmail throttles bursts, and a hundred parallel sends is how
  // half of them come back refused.
  for (const slot of due) {
    const { ok } = await notifyHostSlotCreated(slot, slot.member, {
      attendeeNames: slot.signups.map((s) => s.fullName),
    });
    if (ok) sent += 1;
    else failed.push(slot);
  }

  console.log(`\nSent ${sent} of ${due.length}.`);
  if (failed.length) {
    console.log('Failed (logged as FAILED on the slot; re-run to retry):');
    for (const slot of failed) console.log(`  ${slot.member.email}  slot ${slot.id}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
