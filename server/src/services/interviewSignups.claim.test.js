// claimWithFallback against a real PostgreSQL, under bursts.
//
// Skipped unless TEST_DATABASE_URL points at a throwaway database; see
// interviewSignups.concurrency.test.js for how to start one. The schema is
// rebuilt from empty, so never point this at anything you want to keep.
//
// What it pins: claims for one round are queued in memory and booked in
// batches. Capacity, one-seat-per-round, first-come-first-served and group
// labels have to come out exactly as they did when every claim was its own
// transaction - including when two server instances, each with its own queue,
// book the same round at once.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A schema of its own, so this file and interviewSignups.concurrency.test.js -
// which rebuilds `public` - can share one throwaway database while vitest runs
// them in parallel.
const SCHEMA = 'claim_test';
const TEST_URL = (() => {
  if (!process.env.TEST_DATABASE_URL) return null;
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', SCHEMA);
  return url.toString();
})();
const describeDb = TEST_URL ? describe : describe.skip;

describeDb('claimWithFallback against real PostgreSQL', () => {
  let db;
  // Each instance is a fresh copy of the module graph: its own claim queue and
  // its own connection pool, the way two servers on one database would be.
  const instances = [];

  async function loadInstance() {
    vi.resetModules();
    const service = await import('./interviewSignups.js');
    const { default: client } = await import('../prismaClient.js');
    instances.push(client);
    return service;
  }

  beforeAll(async () => {
    // prismaClient.js reads DATABASE_URL at import; vitest.setup.js points it
    // somewhere that refuses, so it is redirected before the service loads.
    process.env.DATABASE_URL = TEST_URL;

    const schemaSql = join(tmpdir(), `ucats-claim-schema-${process.pid}.sql`);
    const resetSql = join(tmpdir(), `ucats-claim-reset-${process.pid}.sql`);
    writeFileSync(resetSql, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;\nCREATE SCHEMA ${SCHEMA};\n`);
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${resetSql}`, { stdio: 'pipe' });
    // The diff names nothing by schema, so it lands wherever search_path points.
    execSync(
      `(echo 'SET search_path TO ${SCHEMA};'; npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script) > ${schemaSql}`,
      { stdio: 'pipe', shell: '/bin/bash' }
    );
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${schemaSql}`, { stdio: 'pipe' });
    rmSync(schemaSql, { force: true });
    rmSync(resetSql, { force: true });

    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    // The partial indexes live only in the hand-written migration.
    await db.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_confirmed_per_interview"
        ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'CONFIRMED'`);
    await db.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_waitlist_per_interview"
        ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'WAITLISTED'`);
  }, 120000);

  afterAll(async () => {
    await Promise.all(instances.map((client) => client.$disconnect()));
    await db?.$disconnect();
  });

  const future = (hours) => new Date(Date.now() + hours * 3600 * 1000);
  let fixture;

  /** Two sibling coffee chat interviews, one session each. */
  async function seed({ morning = 20, afternoon = 20, groupSize = null, applications = 60, opensAt = null } = {}) {
    await db.interviewSlotSignup.deleteMany({});
    await db.interviewSlot.deleteMany({});
    await db.interview.deleteMany({});
    await db.application.deleteMany({});
    await db.recruitingCycle.deleteMany({});
    await db.user.deleteMany({});

    const admin = await db.user.create({
      data: { email: 'admin@test.local', password: 'x', fullName: 'Admin', role: 'ADMIN' },
    });
    const cycle = await db.recruitingCycle.create({ data: { name: 'Claim test', isActive: true } });
    const makeInterview = (title, startHours, capacity) =>
      db.interview.create({
        data: {
          title,
          interviewType: 'COFFEE_CHAT',
          startDate: future(startHours),
          endDate: future(startHours + 2),
          location: 'Covel',
          cycleId: cycle.id,
          createdBy: admin.id,
          slots: {
            create: [{
              label: title,
              startTime: future(startHours),
              endTime: future(startHours + 2),
              candidateCapacity: capacity,
              groupSize,
              signupOpensAt: opensAt,
            }],
          },
        },
        include: { slots: true },
      });
    const am = await makeInterview('Coffee Chat - Round 1', 72, morning);
    const pm = await makeInterview('Coffee Chat - Round 2', 76, afternoon);

    const apps = [];
    for (let i = 0; i < applications; i += 1) {
      apps.push(
        await db.application.create({
          data: {
            responseID: `CLAIM-${i}`,
            email: `claim${i}@test.local`,
            firstName: 'Claim',
            lastName: `${i}`,
            studentId: `${700000 + i}`,
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
    fixture = { cycle, morningSlot: am.slots[0], afternoonSlot: pm.slots[0], apps };
    return fixture;
  }

  const settle = (promises) =>
    Promise.all(
      promises.map((p) =>
        p.then(
          (result) => ({ outcome: result.outcome, result }),
          (error) => ({ outcome: 'ERROR', status: error.status, message: error.message })
        )
      )
    );

  const tally = (results) =>
    results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});

  async function assertInvariants() {
    const { morningSlot, afternoonSlot } = fixture;
    for (const slot of [morningSlot, afternoonSlot]) {
      const confirmed = await db.interviewSlotSignup.count({ where: { slotId: slot.id, status: 'CONFIRMED' } });
      expect(confirmed).toBeLessThanOrEqual(slot.candidateCapacity);
    }
    // One live seat per candidate per round, across both sibling interviews.
    const doubleBooked = await db.$queryRawUnsafe(`
      SELECT "applicationId" FROM interview_slot_signups
      WHERE status = 'CONFIRMED' GROUP BY 1 HAVING COUNT(*) > 1`);
    expect(doubleBooked).toEqual([]);
    // Nobody is waitlisted without a confirmed seat behind them.
    const orphaned = await db.$queryRawUnsafe(`
      SELECT w.id FROM interview_slot_signups w
      LEFT JOIN interview_slot_signups h ON h.id = w."heldSeatId"
      WHERE w.status = 'WAITLISTED' AND (h.id IS NULL OR h.status <> 'CONFIRMED' OR h."applicationId" <> w."applicationId")`);
    expect(orphaned).toEqual([]);
  }

  beforeEach(async () => {
    await seed();
  }, 60000);

  it('books a burst exactly: seats, then fallbacks, then placement', async () => {
    const { claimWithFallback } = await loadInstance();
    const { cycle, morningSlot, apps } = fixture;

    const results = await settle(
      apps.map((app) => claimWithFallback({ applicationId: app.id, slotId: morningSlot.id, cycleId: cycle.id }))
    );

    expect(tally(results)).toEqual({ CONFIRMED: 20, WAITLISTED: 20, NEEDS_PLACEMENT: 20 });
    await assertInvariants();
  }, 60000);

  it('hands out seats first come, first served', async () => {
    const { claimWithFallback } = await loadInstance();
    const { cycle, morningSlot, apps } = fixture;

    await settle(apps.map((app) => claimWithFallback({ applicationId: app.id, slotId: morningSlot.id, cycleId: cycle.id })));

    const rows = await db.interviewSlotSignup.findMany({ where: { slotId: morningSlot.id } });
    const seated = rows.filter((r) => r.status === 'CONFIRMED').map((r) => r.signedUpAt.getTime());
    const waiting = rows.filter((r) => r.status === 'WAITLISTED').map((r) => r.waitlistedAt.getTime());
    const unplaced = rows.filter((r) => r.status === 'NEEDS_PLACEMENT').map((r) => r.signedUpAt.getTime());

    // Everyone seated arrived before everyone waitlisted, who arrived before
    // everyone left unplaced.
    expect(Math.max(...seated)).toBeLessThan(Math.min(...waiting));
    expect(Math.max(...waiting)).toBeLessThan(Math.min(...unplaced));
    // And no two waitlist entries tie, so promotion order is never left to a
    // random id.
    expect(new Set(waiting).size).toBe(waiting.length);
  }, 60000);

  it('fills rotation groups to size, in order', async () => {
    await seed({ morning: 20, afternoon: 20, groupSize: 4, applications: 20 });
    const { claimWithFallback } = await loadInstance();
    const { cycle, morningSlot, apps } = fixture;

    await settle(apps.map((app) => claimWithFallback({ applicationId: app.id, slotId: morningSlot.id, cycleId: cycle.id })));

    const groups = await db.interviewSlotSignup.groupBy({
      by: ['groupLabel'],
      where: { slotId: morningSlot.id, status: 'CONFIRMED' },
      _count: { _all: true },
    });
    const sizes = Object.fromEntries(groups.map((g) => [g.groupLabel, g._count._all]));
    expect(sizes).toEqual({ '1A': 4, '1B': 4, '2A': 4, '2B': 4, '3A': 4 });
  }, 60000);

  it('books a double click once', async () => {
    const { claimWithFallback } = await loadInstance();
    const { cycle, morningSlot, apps } = fixture;
    const claim = () => claimWithFallback({ applicationId: apps[0].id, slotId: morningSlot.id, cycleId: cycle.id });

    const results = await settle([claim(), claim(), claim()]);

    expect(results.filter((r) => r.outcome === 'CONFIRMED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'ERROR').map((r) => r.status)).toEqual([409, 409]);
    expect(await db.interviewSlotSignup.count({ where: { applicationId: apps[0].id } })).toBe(1);
  }, 60000);

  it('refuses a claim on its own without failing the rest of its batch', async () => {
    const { claimWithFallback } = await loadInstance();
    const { cycle, morningSlot, afternoonSlot, apps } = fixture;
    // apps[1] already holds the afternoon seat, so their morning claim is a
    // second booking in the round and must be refused.
    await claimWithFallback({ applicationId: apps[1].id, slotId: afternoonSlot.id, cycleId: cycle.id });

    const results = await settle(
      apps.slice(0, 10).map((app) => claimWithFallback({ applicationId: app.id, slotId: morningSlot.id, cycleId: cycle.id }))
    );

    expect(results[1]).toMatchObject({ outcome: 'ERROR', status: 409 });
    expect(tally(results)).toEqual({ CONFIRMED: 9, ERROR: 1 });
    await assertInvariants();
  }, 60000);

  it('refuses a session that is not open yet', async () => {
    await seed({ applications: 3, opensAt: future(24) });
    const { claimWithFallback } = await loadInstance();
    const { cycle, morningSlot, apps } = fixture;

    const results = await settle(
      apps.map((app) => claimWithFallback({ applicationId: app.id, slotId: morningSlot.id, cycleId: cycle.id }))
    );
    expect(results.map((r) => r.message)).toEqual(Array(3).fill('Signup is not open for that time slot'));
    expect(await db.interviewSlotSignup.count()).toBe(0);
  }, 60000);

  it('rejects a slot from another cycle before queueing it', async () => {
    const { claimWithFallback } = await loadInstance();
    const { morningSlot, apps } = fixture;
    await expect(
      claimWithFallback({ applicationId: apps[0].id, slotId: morningSlot.id, cycleId: 'another-cycle' })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('holds capacity when two server instances book the same round at once', async () => {
    await seed({ morning: 15, afternoon: 15, applications: 40 });
    const serverA = await loadInstance();
    const serverB = await loadInstance();
    const { cycle, morningSlot, apps } = fixture;

    const results = await settle(
      apps.map((app, i) =>
        (i % 2 === 0 ? serverA : serverB).claimWithFallback({
          applicationId: app.id,
          slotId: morningSlot.id,
          cycleId: cycle.id,
        })
      )
    );

    expect(tally(results)).toEqual({ CONFIRMED: 15, WAITLISTED: 15, NEEDS_PLACEMENT: 10 });
    await assertInvariants();
  }, 60000);
});
