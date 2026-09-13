// Concurrency and invariant tests against a real PostgreSQL.
//
// Skipped unless TEST_DATABASE_URL points at a throwaway database. Start one with:
//
//   initdb -D /tmp/ucpgdata -U postgres --auth=trust
//   pg_ctl -D /tmp/ucpgdata -o "-p 55432 -k /tmp/ucpg" start
//   createdb -h 127.0.0.1 -p 55432 -U postgres ucats_test
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/ucats_test npx vitest run
//
// Why a real database rather than a mocked $transaction: a mock that runs the
// callback inline makes the isolation level a no-op, so every capacity test
// passes whether or not the code is safe. These assertions are only meaningful
// against an engine that actually implements SSI - which is also why the first
// test asserts the isolation level it is running under.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb('interview slot signups against real PostgreSQL', () => {
  // Two independent clients. A single client serialises requests through one
  // connection pool and would prove nothing about two transactions racing.
  let clientA;
  let clientB;
  let fixture;

  beforeAll(async () => {
    // Built with the same offline diff + `db execute --url` the real migrations
    // use, rather than `prisma db push`: the CLI reads .env and would point at
    // the production database regardless of what is passed in the environment.
    const schemaSql = join(tmpdir(), `ucats-test-schema-${process.pid}.sql`);
    const resetSql = join(tmpdir(), `ucats-test-reset-${process.pid}.sql`);
    // Rebuilt from empty every run, so a leftover schema from a previous run
    // cannot make the suite pass or fail for reasons that have nothing to do
    // with the code under test.
    writeFileSync(resetSql, 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n');
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${resetSql}`, { stdio: 'pipe' });
    execSync(
      `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > ${schemaSql}`,
      { stdio: 'pipe', shell: '/bin/bash' }
    );
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${schemaSql}`, { stdio: 'pipe' });
    rmSync(schemaSql, { force: true });
    rmSync(resetSql, { force: true });

    // The two partial indexes carry the invariants and exist only in the
    // hand-written migration - Prisma's schema cannot express an index WHERE
    // clause, so a schema-derived build does not create them.
    const bootstrap = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    await bootstrap.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_confirmed_per_interview"
        ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'CONFIRMED'`);
    await bootstrap.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_waitlist_per_interview"
        ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'WAITLISTED'`);
    await bootstrap.$disconnect();

    clientA = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    clientB = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120000);

  afterAll(async () => {
    await clientA?.$disconnect();
    await clientB?.$disconnect();
  });

  const futureDate = (hoursFromNow) => new Date(Date.now() + hoursFromNow * 3600 * 1000);

  async function seed({ capacities = [2, 2], applicationCount = 4 } = {}) {
    await clientA.interviewSlotSignup.deleteMany({});
    await clientA.interviewSlot.deleteMany({});
    await clientA.interview.deleteMany({});
    await clientA.application.deleteMany({});
    await clientA.recruitingCycle.deleteMany({});
    await clientA.user.deleteMany({});

    const admin = await clientA.user.create({
      data: { email: `admin-${Date.now()}@test.local`, password: 'x', fullName: 'Admin', role: 'ADMIN' },
    });
    const cycle = await clientA.recruitingCycle.create({
      data: { name: `Test Cycle ${Date.now()}`, isActive: true, isAdminActive: true },
    });
    const interview = await clientA.interview.create({
      data: {
        title: 'Coffee Chats',
        interviewType: 'COFFEE_CHAT',
        startDate: futureDate(48),
        endDate: futureDate(56),
        location: 'Covel',
        cycleId: cycle.id,
        createdBy: admin.id,
      },
    });

    const slots = [];
    for (const [i, capacity] of capacities.entries()) {
      slots.push(
        await clientA.interviewSlot.create({
          data: {
            interviewId: interview.id,
            label: i === 0 ? 'Morning Block' : `Block ${i + 1}`,
            startTime: futureDate(48 + i * 4),
            endTime: futureDate(50 + i * 4),
            candidateCapacity: capacity,
          },
        })
      );
    }

    const applications = [];
    for (let i = 0; i < applicationCount; i += 1) {
      applications.push(
        await clientA.application.create({
          data: {
            responseID: `resp-${Date.now()}-${i}`,
            email: `cand${i}@test.local`,
            firstName: 'Cand',
            lastName: `${i}`,
            studentId: `${100000 + i}`,
            phoneNumber: '555',
            graduationYear: '2027',
            isTransferStudent: false,
            cumulativeGpa: 3.5,
            major1: 'Econ',
            isFirstGeneration: false,
            resumeUrl: 'https://example.test/r',
            headshotUrl: 'https://example.test/h',
            rawResponses: {},
            currentRound: '2',
            cycleId: cycle.id,
          },
        })
      );
    }

    fixture = { admin, cycle, interview, slots, applications };
    return fixture;
  }

  beforeEach(async () => {
    await seed();
  });

  it('runs at serializable isolation', async () => {
    // The assertion that catches a pooler silently downgrading isolation, which
    // would leave every other test in this file green and meaningless.
    const [level] = await clientA.$transaction(
      async (tx) => tx.$queryRawUnsafe('SHOW transaction_isolation'),
      { isolationLevel: 'Serializable' }
    );
    expect(level.transaction_isolation).toBe('serializable');
  });

  it('enforces one confirmed seat per candidate per interview', async () => {
    const { interview, slots, applications } = fixture;
    await clientA.interviewSlotSignup.create({
      data: { slotId: slots[0].id, interviewId: interview.id, applicationId: applications[0].id, status: 'CONFIRMED' },
    });
    await expect(
      clientA.interviewSlotSignup.create({
        data: { slotId: slots[1].id, interviewId: interview.id, applicationId: applications[0].id, status: 'CONFIRMED' },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets a candidate re-book after cancelling', async () => {
    // The reason the index is partial. A plain unique pair would count the
    // cancelled row and lock this candidate out of the interview for good.
    const { interview, slots, applications } = fixture;
    const first = await clientA.interviewSlotSignup.create({
      data: { slotId: slots[0].id, interviewId: interview.id, applicationId: applications[0].id, status: 'CONFIRMED' },
    });
    await clientA.interviewSlotSignup.update({
      where: { id: first.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    const second = await clientA.interviewSlotSignup.create({
      data: { slotId: slots[0].id, interviewId: interview.id, applicationId: applications[0].id, status: 'CONFIRMED' },
    });
    expect(second.id).not.toBe(first.id);
  });

  it('gives the last seat to exactly one of two simultaneous claims', async () => {
    const { interview, slots, applications } = fixture;
    const slot = slots[0]; // capacity 2
    await clientA.interviewSlotSignup.create({
      data: { slotId: slot.id, interviewId: interview.id, applicationId: applications[0].id, status: 'CONFIRMED' },
    });

    // A barrier forces both transactions to finish counting before either
    // writes. Without it the two might simply serialise and the race would go
    // untested while the test still passed.
    let ready;
    const bothCounted = new Promise((resolve) => {
      let seen = 0;
      ready = () => {
        seen += 1;
        if (seen === 2) resolve();
      };
    });

    const claim = (client, applicationId) =>
      client.$transaction(
        async (tx) => {
          const count = await tx.interviewSlotSignup.count({
            where: { slotId: slot.id, status: 'CONFIRMED' },
          });
          ready();
          await bothCounted;
          if (count >= slot.candidateCapacity) throw new Error('FULL');
          return tx.interviewSlotSignup.create({
            data: { slotId: slot.id, interviewId: interview.id, applicationId, status: 'CONFIRMED' },
          });
        },
        { isolationLevel: 'Serializable', timeout: 15000 }
      );

    const results = await Promise.allSettled([
      claim(clientA, applications[1].id),
      claim(clientB, applications[2].id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser must fail on serialisation (40001 -> P2034), not on a capacity
    // check - both read "one seat left", so only the engine can separate them.
    expect(rejected[0].reason?.code ?? rejected[0].reason?.message).toBe('P2034');

    const confirmed = await clientA.interviewSlotSignup.count({
      where: { slotId: slot.id, status: 'CONFIRMED' },
    });
    expect(confirmed).toBe(slot.candidateCapacity);
  }, 30000);

  it('never exceeds capacity under a burst of concurrent claims', async () => {
    const { interview, slots, applications } = await seed({ capacities: [2, 2], applicationCount: 8 });
    const slot = slots[0];

    const attempts = applications.map((application) =>
      clientA
        .$transaction(
          async (tx) => {
            const count = await tx.interviewSlotSignup.count({
              where: { slotId: slot.id, status: 'CONFIRMED' },
            });
            if (count >= slot.candidateCapacity) throw new Error('FULL');
            return tx.interviewSlotSignup.create({
              data: {
                slotId: slot.id,
                interviewId: interview.id,
                applicationId: application.id,
                status: 'CONFIRMED',
              },
            });
          },
          { isolationLevel: 'Serializable', timeout: 15000 }
        )
        .catch((error) => ({ failed: error.code ?? error.message }))
    );

    await Promise.all(attempts);

    const confirmed = await clientA.interviewSlotSignup.count({
      where: { slotId: slot.id, status: 'CONFIRMED' },
    });
    // The point of the whole design: overbooking is impossible, whatever the
    // interleaving happened to be.
    expect(confirmed).toBeLessThanOrEqual(slot.candidateCapacity);
  }, 60000);
});
