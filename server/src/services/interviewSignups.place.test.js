// placeCandidate against a real PostgreSQL.
//
// Skipped unless TEST_DATABASE_URL points at a throwaway database; see
// interviewSignups.concurrency.test.js for how to start one. Uses a schema of
// its own, rebuilt from empty, so it can share that database with the other
// real-database suites.
//
// What it pins: an admin placing someone who never booked gets them the same
// seat a self-booking would - a rotation group in a grouped coffee chat
// session, and never a second seat when they already hold one in the sibling
// interview of the round.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = 'place_test';
const TEST_URL = (() => {
  if (!process.env.TEST_DATABASE_URL) return null;
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', SCHEMA);
  return url.toString();
})();
const describeDb = TEST_URL ? describe : describe.skip;

describeDb('placeCandidate against real PostgreSQL', () => {
  let db;
  let service;
  let serviceClient;

  beforeAll(async () => {
    // prismaClient.js reads DATABASE_URL at import; vitest.setup.js points it
    // somewhere that refuses, so it is redirected before the service loads.
    process.env.DATABASE_URL = TEST_URL;

    const schemaSql = join(tmpdir(), `ucats-place-schema-${process.pid}.sql`);
    const resetSql = join(tmpdir(), `ucats-place-reset-${process.pid}.sql`);
    writeFileSync(resetSql, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;\nCREATE SCHEMA ${SCHEMA};\n`);
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${resetSql}`, { stdio: 'pipe' });
    execSync(
      `(echo 'SET search_path TO ${SCHEMA};'; npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script) > ${schemaSql}`,
      { stdio: 'pipe', shell: '/bin/bash' }
    );
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${schemaSql}`, { stdio: 'pipe' });
    rmSync(schemaSql, { force: true });
    rmSync(resetSql, { force: true });

    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    await db.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_confirmed_per_interview"
        ON "interview_slot_signups" ("interviewId", "applicationId") WHERE "status" = 'CONFIRMED'`);

    vi.resetModules();
    service = await import('./interviewSignups.js');
    serviceClient = (await import('../prismaClient.js')).default;
  }, 120000);

  afterAll(async () => {
    await serviceClient?.$disconnect();
    await db?.$disconnect();
  });

  const future = (hours) => new Date(Date.now() + hours * 3600 * 1000);
  let fixture;

  /** Two sibling coffee chat interviews, one grouped session each. */
  beforeEach(async () => {
    await db.interviewSlotSignup.deleteMany({});
    await db.interviewSlot.deleteMany({});
    await db.interview.deleteMany({});
    await db.application.deleteMany({});
    await db.recruitingCycle.deleteMany({});
    await db.user.deleteMany({});

    const admin = await db.user.create({
      data: { email: 'admin@test.local', password: 'x', fullName: 'Admin', role: 'ADMIN' },
    });
    const cycle = await db.recruitingCycle.create({ data: { name: 'Place test', isActive: true } });
    const makeInterview = (title, startHours) =>
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
              candidateCapacity: 40,
              groupSize: 2,
            }],
          },
        },
        include: { slots: true },
      });
    const am = await makeInterview('Coffee Chat - Round 1', 72);
    const pm = await makeInterview('Coffee Chat - Round 2', 76);

    const apps = [];
    for (let i = 0; i < 3; i += 1) {
      apps.push(
        await db.application.create({
          data: {
            responseID: `PLACE-${i}`,
            email: `place${i}@test.local`,
            firstName: 'Place',
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
    fixture = { admin, am, pm, apps };
  });

  const place = (interview, application) =>
    service.placeCandidate({
      interviewId: interview.id,
      slotId: interview.slots[0].id,
      applicationId: application.id,
      actorId: fixture.admin.id,
    });

  it('puts a hand-placed candidate into a rotation group, two to a group', async () => {
    const { am, apps } = fixture;
    const labels = [];
    for (const app of apps) {
      const { placed } = await place(am, app);
      const row = await db.interviewSlotSignup.findUnique({ where: { id: placed.id } });
      labels.push(row.groupLabel);
    }

    expect(labels.every(Boolean)).toBe(true);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[2]).not.toBe(labels[0]);
  });

  it('moves someone already in the sibling interview rather than seating them twice', async () => {
    const { am, pm, apps } = fixture;
    const morning = await place(am, apps[0]);

    const result = await place(pm, apps[0]);

    expect(result).toEqual({ placed: null, moveInstead: morning.placed.id });
    const live = await db.interviewSlotSignup.count({
      where: { applicationId: apps[0].id, status: 'CONFIRMED' },
    });
    expect(live).toBe(1);
  });

  it('refuses to place someone into the session they already hold', async () => {
    const { am, apps } = fixture;
    await place(am, apps[0]);
    await expect(place(am, apps[0])).rejects.toMatchObject({ status: 409 });
  });
});
