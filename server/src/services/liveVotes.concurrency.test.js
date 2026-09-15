// Live vote races against a real PostgreSQL.
//
// Skipped unless TEST_DATABASE_URL points at a throwaway database - see the header
// of interviewSignups.concurrency.test.js for starting one.
//
// The in-memory suite (liveVotes.test.js) runs transactions inline, so it cannot
// show that the session row lock and the partial unique indexes hold when
// requests genuinely overlap. These can: two independent clients, real
// transactions, real row locks.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginSession,
  castVote,
  clearStateCache,
  closeBallot,
  joinSession,
  launchSession,
  navigateSession
} from './liveVotes.js';

vi.mock('./realtime.js', () => ({ nudgeLiveVote: vi.fn(), nudgeLiveVotesGlobal: vi.fn() }));

const TEST_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb('live votes against real PostgreSQL', () => {
  let clientA;
  let clientB;
  let admin;
  let admin2;
  let voters;

  beforeAll(async () => {
    const schemaSql = join(tmpdir(), `ucats-livevote-schema-${process.pid}.sql`);
    const resetSql = join(tmpdir(), `ucats-livevote-reset-${process.pid}.sql`);
    writeFileSync(resetSql, 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n');
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${resetSql}`, { stdio: 'pipe' });
    execSync(
      `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > ${schemaSql}`,
      { stdio: 'pipe', shell: '/bin/bash' }
    );
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${schemaSql}`, { stdio: 'pipe' });
    rmSync(schemaSql, { force: true });
    rmSync(resetSql, { force: true });

    // The invariants from the hand-written migration, which a schema-derived
    // build does not create.
    const bootstrap = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    await bootstrap.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_sessions_single_open"
        ON "live_vote_sessions" ((true)) WHERE "status" IN ('LOBBY', 'ACTIVE')`);
    await bootstrap.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_ballots_single_open"
        ON "live_vote_ballots" ("sessionId") WHERE "status" = 'OPEN'`);
    await bootstrap.$disconnect();

    clientA = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    clientB = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120000);

  afterAll(async () => {
    await clientA?.$disconnect();
    await clientB?.$disconnect();
  });

  const pick = (index) => (index % 2 ? clientB : clientA);

  beforeEach(async () => {
    clearStateCache();
    await clientA.liveVoteSession.deleteMany({});
    await clientA.comment.deleteMany({});
    await clientA.application.deleteMany({});
    await clientA.recruitingCycle.deleteMany({});
    await clientA.user.deleteMany({});

    const cycle = await clientA.recruitingCycle.create({ data: { name: 'Race Cycle', isActive: true } });
    const application = (index) => ({
      responseID: `resp-${index}`,
      email: `cand${index}@ucla.edu`,
      firstName: `Cand${index}`,
      lastName: 'Race',
      studentId: `9000${index}`,
      phoneNumber: '555',
      graduationYear: '2028',
      isTransferStudent: false,
      cumulativeGpa: '3.50',
      major1: 'Economics',
      isFirstGeneration: false,
      resumeUrl: '/api/files/r/view',
      headshotUrl: '/api/files/h/image',
      rawResponses: {},
      cycleId: cycle.id
    });
    await clientA.application.createMany({ data: [0, 1, 2].map(application) });

    const makeUser = (id, role) => ({ id, role, email: `${id}@ucla.edu`, fullName: id, password: null });
    await clientA.user.createMany({
      data: [makeUser('admin-1', 'ADMIN'), makeUser('admin-2', 'ADMIN'),
        ...Array.from({ length: 30 }, (_, i) => makeUser(`voter-${i}`, 'MEMBER'))]
    });
    admin = { id: 'admin-1', role: 'ADMIN', email: 'admin-1@ucla.edu' };
    admin2 = { id: 'admin-2', role: 'ADMIN', email: 'admin-2@ucla.edu' };
    voters = Array.from({ length: 30 }, (_, i) => ({ id: `voter-${i}`, role: 'MEMBER', email: `voter-${i}@ucla.edu` }));
  });

  async function applicationIds() {
    const rows = await clientA.application.findMany({ orderBy: { responseID: 'asc' }, select: { id: true } });
    return rows.map((row) => row.id);
  }

  it('lets exactly one of two simultaneous launches through', async () => {
    const ids = await applicationIds();
    const results = await Promise.allSettled([
      launchSession({ client: clientA, user: admin, phase: 'final', applicationIds: ids }),
      launchSession({ client: clientB, user: admin2, phase: 'final', applicationIds: ids })
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused.reason).toMatchObject({ status: 409, code: 'LIVE_VOTE_ACTIVE' });
    expect(await clientA.liveVoteSession.count()).toBe(1);
  });

  it('freezes counts that match the stored votes when votes race a close', async () => {
    const { session } = await launchSession({ client: clientA, user: admin, phase: 'final', applicationIds: await applicationIds() });
    for (const voter of voters) await joinSession({ client: clientA, sessionId: session.id, user: voter });
    const state = await beginSession({ client: clientA, sessionId: session.id, user: admin });
    const ballotId = state.current.ballot.id;

    const votes = voters.map((voter, i) => () =>
      castVote({ client: pick(i), sessionId: session.id, ballotId, value: i % 3 ? 'YES' : 'NO', user: voter }));
    const close = () => closeBallot({ client: clientB, sessionId: session.id, ballotId, user: admin });

    const results = await Promise.allSettled([
      ...votes.slice(0, 15).map((run) => run()),
      close(),
      ...votes.slice(15).map((run) => run())
    ]);

    const closeResult = results[15];
    expect(closeResult.status).toBe('fulfilled');
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason.code).toBe('BALLOT_CLOSED');
    }

    const ballot = await clientA.liveVoteBallot.findUnique({ where: { id: ballotId } });
    const stored = await clientA.liveVoteVote.groupBy({ by: ['value'], where: { ballotId }, _count: true });
    const storedCount = (value) => stored.find((row) => row.value === value)?._count ?? 0;
    expect(ballot.status).toBe('CLOSED');
    expect(ballot.yesCount).toBe(storedCount('YES'));
    expect(ballot.noCount).toBe(storedCount('NO'));
    expect(ballot.yesCount + ballot.noCount).toBe(results.filter((r, i) => i !== 15 && r.status === 'fulfilled').length);
  }, 60000);

  it('moves on once when two admins press Next at the same moment', async () => {
    const { session } = await launchSession({ client: clientA, user: admin, phase: 'final', applicationIds: await applicationIds() });
    await joinSession({ client: clientA, sessionId: session.id, user: admin2 });
    await beginSession({ client: clientA, sessionId: session.id, user: admin });

    const results = await Promise.allSettled([
      navigateSession({ client: clientA, sessionId: session.id, fromIndex: 0, toIndex: 1, user: admin }),
      navigateSession({ client: clientB, sessionId: session.id, fromIndex: 0, toIndex: 1, user: admin2 })
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'STALE_INDEX' });
    const after = await clientA.liveVoteSession.findUnique({ where: { id: session.id } });
    expect(after.currentIndex).toBe(1);
    // One open ballot, on the second candidate. The first was never voted on, so
    // moving past it discarded it rather than recording a 0-0.
    const ballots = await clientA.liveVoteBallot.findMany({
      where: { sessionId: session.id },
      include: { sessionCandidate: { select: { position: true } } }
    });
    expect(ballots.map((ballot) => [ballot.sessionCandidate.position, ballot.status])).toEqual([[1, 'OPEN']]);
  });
});
