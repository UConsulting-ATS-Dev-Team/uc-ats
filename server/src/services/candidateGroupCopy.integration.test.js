import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { previewCandidateGroupCopy, commitCandidateGroupCopy } from './candidateGroupCopy.js';

const dbUrl = process.env.INTEGRATION_DB_URL;

describe.skipIf(!dbUrl)('candidateGroupCopy integration', () => {
  let prisma;

  beforeAll(async () => {
    if (!dbUrl) return;
    prisma = new PrismaClient({
      datasources: { db: { url: dbUrl } },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('copies source candidates into a destination interview group and skips missing ones', async () => {
    const suffix = randomUUID();
    const cycle = await prisma.recruitingCycle.create({
      data: { name: `Copy Test Cycle ${suffix}`, isActive: true },
    });

    const actor = await prisma.user.create({
      data: {
        email: `copy-admin-${suffix}@example.com`,
        password: 'notused',
        role: 'ADMIN',
        fullName: 'Copy Admin',
      },
    });

    const candidateOne = await prisma.candidate.create({
      data: {
        studentId: `s1-${suffix}`,
        firstName: 'Alice',
        lastName: 'Anderson',
        email: `alice-${suffix}@example.com`,
      },
    });

    const candidateTwo = await prisma.candidate.create({
      data: {
        studentId: `s2-${suffix}`,
        firstName: 'Bob',
        lastName: 'Baker',
        email: `bob-${suffix}@example.com`,
      },
    });

    const candidateThree = await prisma.candidate.create({
      data: {
        studentId: `s3-${suffix}`,
        firstName: 'Carol',
        lastName: 'Chen',
        email: `carol-${suffix}@example.com`,
      },
    });

    const appOne = await prisma.application.create({
      data: {
        responseID: `resp-${suffix}-1`,
        email: candidateOne.email,
        firstName: candidateOne.firstName,
        lastName: candidateOne.lastName,
        studentId: candidateOne.studentId,
        phoneNumber: '555-0001',
        graduationYear: '2027',
        isTransferStudent: false,
        cumulativeGpa: 3.8,
        major1: 'Economics',
        isFirstGeneration: false,
        resumeUrl: 'https://example.com/resume.pdf',
        headshotUrl: 'https://example.com/headshot.jpg',
        cycleId: cycle.id,
        candidateId: candidateOne.id,
      },
    });

    const appTwo = await prisma.application.create({
      data: {
        responseID: `resp-${suffix}-2`,
        email: candidateTwo.email,
        firstName: candidateTwo.firstName,
        lastName: candidateTwo.lastName,
        studentId: candidateTwo.studentId,
        phoneNumber: '555-0002',
        graduationYear: '2027',
        isTransferStudent: false,
        cumulativeGpa: 3.7,
        major1: 'Business',
        isFirstGeneration: false,
        resumeUrl: 'https://example.com/resume2.pdf',
        headshotUrl: 'https://example.com/headshot2.jpg',
        cycleId: cycle.id,
        candidateId: candidateTwo.id,
      },
    });

    const sourceGroup = await prisma.groups.create({
      data: {
        name: `Source Group ${suffix}`,
        cycleId: cycle.id,
        assignedCandidates: {
          connect: [
            { id: candidateOne.id },
            { id: candidateTwo.id },
            { id: candidateThree.id },
          ],
        },
      },
    });

    const interview = await prisma.interview.create({
      data: {
        title: `Interview ${suffix}`,
        interviewType: 'COFFEE_CHAT',
        startDate: new Date(),
        endDate: new Date(),
        location: 'Zoom',
        cycleId: cycle.id,
        createdBy: actor.id,
        description: JSON.stringify({ applicationGroups: [], memberGroups: [], groupAssignments: {} }),
      },
    });

    const preview = await previewCandidateGroupCopy({
      prisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
    });

    expect(preview.additions).toHaveLength(2);
    expect(preview.duplicates).toHaveLength(0);
    expect(preview.skipped).toHaveLength(1);

    const commit = await commitCandidateGroupCopy({
      prisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      actorId: actor.id,
    });

    expect(commit.additionCount).toBe(2);
    expect(commit.duplicateCount).toBe(0);
    expect(commit.skippedCount).toBe(1);
    expect(commit.copiedByUserId).toBe(actor.id);

    const updated = await prisma.interview.findUnique({ where: { id: interview.id } });
    const config = JSON.parse(updated.description);
    expect(config.applicationGroups).toHaveLength(1);
    expect(config.applicationGroups[0].applicationIds).toEqual([appOne.id, appTwo.id]);
    expect(config.applicationGroups[0].copiedFromGroupId).toBe(sourceGroup.id);
    expect(config.applicationGroups[0].copiedByUserId).toBe(actor.id);

    // Re-run is idempotent
    const rerun = await commitCandidateGroupCopy({
      prisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      destinationGroupId: config.applicationGroups[0].id,
      actorId: actor.id,
    });

    expect(rerun.additionCount).toBe(0);
    expect(rerun.duplicateCount).toBe(2);

    await prisma.interview.deleteMany({ where: { cycleId: cycle.id } });
    await prisma.groups.deleteMany({ where: { cycleId: cycle.id } });
    await prisma.application.deleteMany({ where: { cycleId: cycle.id } });
    await prisma.candidate.deleteMany({
      where: { id: { in: [candidateOne.id, candidateTwo.id, candidateThree.id] } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: `copy-admin-${suffix}` } } });
    await prisma.recruitingCycle.deleteMany({ where: { id: cycle.id } });
  });
});
