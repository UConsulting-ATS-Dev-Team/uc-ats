#!/usr/bin/env node
//
// How does slot signup behave when a decision email lands in 200 inboxes?
//
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/ucats_load \
//     node scripts/loadtest-slot-signup.js --candidates 200 --seats 40
//
// Refuses to run against anything but an explicit TEST_DATABASE_URL, because
// the whole point is to hammer a database until something gives.
//
// What it is actually measuring: claimWithFallback holds a serialisable
// transaction open across several round trips, and every candidate claiming the
// same session performs the same predicate read. That is the worst case for
// SSI - each insert conflicts with every concurrent reader - so the questions
// are whether capacity still holds, how many attempts it costs, and what a
// candidate sees when the retry budget runs out.

import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  console.error('Set TEST_DATABASE_URL to a throwaway database. Refusing to run.');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_URL;

const args = process.argv.slice(2);
const numArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const candidates = numArg('--candidates', 200);
const seats = numArg('--seats', 40);
const secondSeats = numArg('--second-seats', 40);

const prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

async function buildSchema() {
  const schemaSql = join(tmpdir(), `load-schema-${process.pid}.sql`);
  const resetSql = join(tmpdir(), `load-reset-${process.pid}.sql`);
  writeFileSync(resetSql, 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n');
  execSync(`npx prisma db execute --url "${TEST_URL}" --file ${resetSql}`, { stdio: 'pipe' });
  execSync(
    `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > ${schemaSql}`,
    { stdio: 'pipe', shell: '/bin/bash' }
  );
  execSync(`npx prisma db execute --url "${TEST_URL}" --file ${schemaSql}`, { stdio: 'pipe' });
  rmSync(schemaSql, { force: true });
  rmSync(resetSql, { force: true });

  // The partial indexes live only in the hand-written migration, and they are
  // the actual enforcement of the invariant being tested.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_confirmed_per_interview"
      ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'CONFIRMED'`);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_waitlist_per_interview"
      ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'WAITLISTED'`);
}

const future = (h) => new Date(Date.now() + h * 3600 * 1000);

async function seed() {
  const admin = await prisma.user.create({
    data: { email: `load-${Date.now()}@test.local`, password: 'x', fullName: 'Load', role: 'ADMIN' },
  });
  const cycle = await prisma.recruitingCycle.create({
    data: { name: `Load ${Date.now()}`, isActive: true, isAdminActive: true },
  });
  const interview = await prisma.interview.create({
    data: {
      title: 'Load Coffee Chats',
      interviewType: 'COFFEE_CHAT',
      startDate: future(72),
      endDate: future(78),
      location: 'Covel',
      cycleId: cycle.id,
      createdBy: admin.id,
      slots: {
        create: [
          { label: 'Morning', startTime: future(72), endTime: future(74), candidateCapacity: seats },
          { label: 'Afternoon', startTime: future(76), endTime: future(78), candidateCapacity: secondSeats },
        ],
      },
    },
    include: { slots: { orderBy: { startTime: 'asc' } } },
  });

  const apps = [];
  for (let i = 0; i < candidates; i += 1) {
    apps.push(
      await prisma.application.create({
        data: {
          responseID: `LOAD-${i}`,
          email: `load${i}@test.local`,
          firstName: 'Load',
          lastName: `${i}`,
          studentId: `${800000 + i}`,
          phoneNumber: '555',
          graduationYear: '2028',
          isTransferStudent: false,
          cumulativeGpa: 3.5,
          major1: 'Econ',
          isFirstGeneration: false,
          resumeUrl: 'https://example.invalid/r',
          headshotUrl: 'https://example.invalid/h',
          rawResponses: {},
          currentRound: '2',
          cycleId: cycle.id,
        },
      })
    );
  }
  return { cycle, interview, apps };
}

async function main() {
  console.log(`Building a throwaway schema…`);
  await buildSchema();
  console.log(`Seeding ${candidates} candidates, sessions of ${seats} and ${secondSeats}…`);
  const { cycle, interview, apps } = await seed();

  // Imported after DATABASE_URL is pointed at the test database, so the shared
  // client inside the service connects there rather than to the real one.
  const { claimWithFallback } = await import('../src/services/interviewSignups.js');

  const morning = interview.slots[0];
  console.log(`\nEveryone claims "${morning.label}" at once…\n`);

  const started = Date.now();
  const results = await Promise.all(
    apps.map(async (application) => {
      const t0 = Date.now();
      try {
        const result = await claimWithFallback({
          applicationId: application.id,
          slotId: morning.id,
          cycleId: cycle.id,
        });
        return { ok: true, outcome: result.outcome, ms: Date.now() - t0 };
      } catch (error) {
        return { ok: false, code: error.code ?? error.status ?? error.message, ms: Date.now() - t0 };
      }
    })
  );
  const elapsed = Date.now() - started;

  const byOutcome = {};
  const failures = {};
  for (const r of results) {
    if (r.ok) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    else failures[r.code] = (failures[r.code] ?? 0) + 1;
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((times.length * p) / 100))];

  const confirmedMorning = await prisma.interviewSlotSignup.count({
    where: { slotId: morning.id, status: 'CONFIRMED' },
  });
  const confirmedTotal = await prisma.interviewSlotSignup.count({
    where: { interviewId: interview.id, status: 'CONFIRMED' },
  });
  const doubleBooked = await prisma.$queryRawUnsafe(`
    SELECT "applicationId" FROM interview_slot_signups
    WHERE status='CONFIRMED' GROUP BY 1, "interviewId" HAVING COUNT(*) > 1`);

  console.log('--- outcomes ---');
  Object.entries(byOutcome).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));
  if (Object.keys(failures).length) {
    console.log('--- failures ---');
    Object.entries(failures).forEach(([k, v]) => console.log(`  ${String(k).padEnd(16)} ${v}`));
  } else {
    console.log('--- failures ---\n  none');
  }

  console.log('\n--- timing ---');
  console.log(`  wall clock       ${elapsed} ms for ${candidates} claims`);
  console.log(`  throughput       ${(candidates / (elapsed / 1000)).toFixed(1)} claims/sec`);
  console.log(`  p50 / p95 / max  ${pct(50)} / ${pct(95)} / ${times[times.length - 1]} ms`);

  console.log('\n--- correctness ---');
  console.log(`  morning capacity ${seats}, confirmed ${confirmedMorning}  ${confirmedMorning <= seats ? 'OK' : 'OVERBOOKED'}`);
  console.log(`  confirmed total  ${confirmedTotal} (cap ${seats + secondSeats})`);
  console.log(`  double-booked    ${doubleBooked.length}  ${doubleBooked.length === 0 ? 'OK' : 'BROKEN'}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
