import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { commitCycleEventCopy, previewCycleEventCopy } from './eventCopy.js';

const dbUrl = process.env.INTEGRATION_DB_URL;

describe.skipIf(!dbUrl)('eventCopy integration', () => {
  let prisma;

  beforeAll(async () => {
    if (!dbUrl) return;
    prisma = new PrismaClient({
      datasources: { db: { url: dbUrl } },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists source→target provenance and reads it back on a fresh query', async () => {
    const suffix = randomUUID();
    const sourceCycle = await prisma.recruitingCycle.create({
      data: { name: `Source Cycle IT ${suffix}`, isActive: false },
    });
    const targetCycle = await prisma.recruitingCycle.create({
      data: { name: `Target Cycle IT ${suffix}`, isActive: true },
    });
    const actor = await prisma.user.create({
      data: {
        email: `copy-admin-${suffix}@example.com`,
        password: 'notused',
        role: 'ADMIN',
        fullName: 'Copy Admin',
      },
    });
    const sourceEvent = await prisma.events.create({
      data: {
        eventName: 'Info Session',
        eventStartDate: new Date('2025-09-01T18:00:00.000Z'),
        eventEndDate: new Date('2025-09-01T20:00:00.000Z'),
        cycleId: sourceCycle.id,
      },
    });

    const preview = await previewCycleEventCopy({
      prisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
    });
    expect(preview.events).toHaveLength(1);
    expect(preview.events[0].alreadyExists).toBe(false);

    const commit = await commitCycleEventCopy({
      prisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
      events: [
        {
          sourceEventId: sourceEvent.id,
          eventName: 'Info Session Copy',
          eventStartDate: '2026-09-01T18:00:00.000Z',
          eventEndDate: '2026-09-01T20:00:00.000Z',
          eventLocation: 'Room B',
          showToCandidates: true,
          rsvpForm: '',
          attendanceForm: '',
          memberRsvpUrl: '',
        },
      ],
      actorId: actor.id,
    });

    expect(commit.copiedCount).toBe(1);
    expect(commit.created[0].sourceEventId).toBe(sourceEvent.id);

    // Fresh DB read
    const createdId = commit.created[0].id;
    const fresh = await prisma.events.findUnique({
      where: { id: createdId },
    });

    expect(fresh.copiedFromCycleId).toBe(sourceCycle.id);
    expect(fresh.copiedFromEventId).toBe(sourceEvent.id);
    expect(fresh.copiedByUserId).toBe(actor.id);
    expect(fresh.copiedAt).toBeInstanceOf(Date);

    // Re-run with same source event should skip based on durable provenance
    const rerun = await commitCycleEventCopy({
      prisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
      events: [
        {
          sourceEventId: sourceEvent.id,
          eventName: 'Renamed Info Session',
          eventStartDate: '2026-09-01T18:00:00.000Z',
          eventEndDate: '2026-09-01T20:00:00.000Z',
          eventLocation: 'Room B',
          showToCandidates: true,
          rsvpForm: '',
          attendanceForm: '',
          memberRsvpUrl: '',
        },
      ],
      actorId: actor.id,
      force: true,
    });

    expect(rerun.copiedCount).toBe(0);
    expect(rerun.skippedCount).toBe(1);
    expect(rerun.skipped[0].targetEventId).toBe(createdId);

    await prisma.events.deleteMany({ where: { cycleId: { in: [sourceCycle.id, targetCycle.id] } } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `copy-admin-${suffix}` } },
    });
    await prisma.recruitingCycle.deleteMany({ where: { id: { in: [sourceCycle.id, targetCycle.id] } } });
  });
});
