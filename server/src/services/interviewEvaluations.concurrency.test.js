// Saving interview evaluations against a real PostgreSQL.
//
// Skipped unless TEST_DATABASE_URL points at a throwaway database; see
// interviewSignups.concurrency.test.js for how to start one.
//
// A mocked client cannot show this: the bug was two requests both reading "no row yet"
// and both inserting, which only an engine enforcing the unique index can reproduce.
// Two clients stand in for two server processes (or two pooled connections) racing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveInterviewEvaluation } from './interviewEvaluations.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb('saving interview evaluations against real PostgreSQL', () => {
  let clientA;
  let clientB;
  let fixture;

  beforeAll(async () => {
    // Same schema build as interviewSignups.concurrency.test.js: `db execute --url`,
    // never `db push`, which would read .env and reach the production database.
    const schemaSql = join(tmpdir(), `ucats-eval-schema-${process.pid}.sql`);
    const resetSql = join(tmpdir(), `ucats-eval-reset-${process.pid}.sql`);
    writeFileSync(resetSql, 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n');
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${resetSql}`, { stdio: 'pipe' });
    execSync(
      `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > ${schemaSql}`,
      { stdio: 'pipe', shell: '/bin/bash' }
    );
    execSync(`npx prisma db execute --url "${TEST_URL}" --file ${schemaSql}`, { stdio: 'pipe' });
    rmSync(schemaSql, { force: true });
    rmSync(resetSql, { force: true });

    clientA = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    clientB = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    fixture = await seed(clientA);
  }, 120000);

  afterAll(async () => {
    await clientA?.$disconnect();
    await clientB?.$disconnect();
  });

  async function seed(db) {
    const stamp = Date.now();
    const evaluators = [];
    for (let i = 0; i < 40; i += 1) {
      evaluators.push(await db.user.create({
        data: { email: `interviewer${i}-${stamp}@test.local`, password: 'x', fullName: `Interviewer ${i}`, role: 'MEMBER' },
      }));
    }
    const cycle = await db.recruitingCycle.create({
      data: { name: `Eval Cycle ${stamp}`, isActive: true, isAdminActive: true },
    });
    const interview = (interviewType) => db.interview.create({
      data: {
        title: interviewType,
        interviewType,
        startDate: new Date(),
        endDate: new Date(Date.now() + 3600 * 1000),
        location: 'Covel',
        cycleId: cycle.id,
        createdBy: evaluators[0].id,
      },
    });
    const applications = [];
    for (let i = 0; i < 3; i += 1) {
      applications.push(await db.application.create({
        data: {
          responseID: `eval-resp-${stamp}-${i}`,
          email: `evalcand${i}@test.local`,
          firstName: 'Cand',
          lastName: `${i}`,
          studentId: `${200000 + i}`,
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
      }));
    }
    return {
      evaluators,
      applications,
      finalRound: await interview('FINAL_ROUND'),
      firstRound: await interview('ROUND_ONE'),
    };
  }

  it.each([
    ['final round', 'finalRound', 'interviewEvaluation', (i) => ({ notes: `save ${i}` })],
    ['first round', 'firstRound', 'firstRoundInterviewEvaluation', (i) => ({ notes: `save ${i}`, behavioralTotal: i })],
  ])('lets every simultaneous first save of a %s evaluation succeed, as one row', async (_, round, model, body) => {
    const interview = fixture[round];
    const [application] = fixture.applications;
    const evaluatorId = fixture.evaluators[1].id;

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => saveInterviewEvaluation(i % 2 ? clientB : clientA, {
        interview, applicationId: application.id, evaluatorId, body: body(i),
      }))
    );

    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.code)).toEqual([]);
    const rows = await clientA[model].findMany({ where: { interviewId: interview.id, applicationId: application.id, evaluatorId } });
    expect(rows).toHaveLength(1);
  });

  it('saves 40 interviewers on 3 candidates at once without a failure', async () => {
    const interview = fixture.finalRound;
    const saves = [];
    for (const [e, evaluator] of fixture.evaluators.entries()) {
      for (const application of fixture.applications) {
        // Two saves each, as an autosave and Save landing together would send.
        for (let n = 0; n < 2; n += 1) {
          saves.push(saveInterviewEvaluation((e + n) % 2 ? clientB : clientA, {
            interview, applicationId: application.id, evaluatorId: evaluator.id,
            body: { notes: `${evaluator.fullName} on ${application.lastName}`, decision: 'YES' },
          }));
        }
      }
    }

    const results = await Promise.allSettled(saves);

    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message)).toEqual([]);
    expect(await clientA.interviewEvaluation.count({ where: { interviewId: interview.id } })).toBe(40 * 3);
  }, 60000);

  it('keeps fields a later partial save leaves out', async () => {
    const interview = fixture.finalRound;
    const [, application] = fixture.applications;
    const evaluatorId = fixture.evaluators[2].id;
    const save = (body) => saveInterviewEvaluation(clientA, { interview, applicationId: application.id, evaluatorId, body });

    await save({ casingNotes: { q1: 'Strong framework' }, notes: 'First pass' });
    const row = await save({ decision: 'MAYBE_YES', notes: 'Changed my mind' });

    expect(row).toMatchObject({ decision: 'MAYBE_YES', notes: 'Changed my mind', casingNotes: '{"q1":"Strong framework"}' });
  });
});
