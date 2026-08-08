import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  previewCycleBootstrap,
  commitCycleBootstrap,
  timelineFromPriorCycle
} from './cycleBootstrap.js';

const validTimeline = () => ({
  applications_open: { start: '2026-09-01' },
  info_session: { start: '2026-09-05', end: '2026-09-05T20:00' },
  applications_close: { start: '2026-09-20' },
  resume_deadline: { start: '2026-09-20' },
  coffee_chats: { start: '2026-09-25', end: '2026-09-28' },
  round_one: { start: '2026-10-01', end: '2026-10-03' },
  deliberations: { start: '2026-10-10', end: '2026-10-11' },
  offers_released: { start: '2026-10-15' }
});

const makePrisma = ({ existingCycle = null, cycles = {}, existingEvents = [], failOnEvent = null } = {}) => {
  const createdEvents = [];
  const tx = {
    recruitingCycle: {
      create: vi.fn(async ({ data }) => ({ id: 'cycle-1', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    events: {
      create: vi.fn(async ({ data }) => {
        if (failOnEvent && data.generatedFromStage === failOnEvent) {
          throw new Error('event insert failed');
        }
        createdEvents.push(data);
        return { id: `event-${createdEvents.length}`, ...data };
      })
    }
  };

  return {
    createdEvents,
    tx,
    recruitingCycle: {
      findFirst: vi.fn(async () => existingCycle),
      findUnique: vi.fn(async ({ where }) => cycles[where.id] || null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async ({ data }) => ({ id: 'cycle-1', ...data }))
    },
    events: {
      findMany: vi.fn(async () => existingEvents)
    },
    // Real transactions roll back on throw; the mock just propagates the error
    // and the assertions check nothing was returned as committed.
    $transaction: vi.fn(async (fn) => fn(tx))
  };
};

describe('previewCycleBootstrap', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('derives event shells only for stages that generate events', async () => {
    const preview = await previewCycleBootstrap({ prisma, name: 'Fall 2026', timeline: validTimeline() });

    expect(preview.valid).toBe(true);
    expect(preview.events.map((e) => e.stageKey)).toEqual([
      'info_session',
      'coffee_chats',
      'round_one',
      'deliberations'
    ]);
    // Milestones (applications open/close, deadlines, offers) never create events.
    expect(preview.events.some((e) => e.stageKey === 'applications_open')).toBe(false);
  });

  it('marks form-bearing events as pending because forms cannot be auto-created', async () => {
    const preview = await previewCycleBootstrap({ prisma, name: 'Fall 2026', timeline: validTimeline() });

    expect(preview.pendingFormCount).toBe(3);
    expect(preview.events.find((e) => e.stageKey === 'deliberations').needsForms).toBe(false);
  });

  it('reports per-field errors for missing required stages and inverted windows', async () => {
    const timeline = validTimeline();
    delete timeline.applications_open;
    timeline.coffee_chats = { start: '2026-09-28', end: '2026-09-25' };

    const preview = await previewCycleBootstrap({ prisma, name: 'Fall 2026', timeline });

    expect(preview.valid).toBe(false);
    expect(preview.validationErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'applications_open', field: 'start' }),
        expect.objectContaining({ stage: 'coffee_chats', field: 'end' })
      ])
    );
  });

  it('flags stages that run out of template order', async () => {
    const timeline = validTimeline();
    timeline.round_one = { start: '2026-09-02', end: '2026-09-03' };

    const preview = await previewCycleBootstrap({ prisma, name: 'Fall 2026', timeline });

    expect(preview.valid).toBe(false);
    expect(preview.validationErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'round_one', field: 'start' })])
    );
  });

  it('rejects a duplicate cycle name', async () => {
    prisma = makePrisma({ existingCycle: { id: 'other', name: 'Fall 2026' } });

    const preview = await previewCycleBootstrap({ prisma, name: 'Fall 2026', timeline: validTimeline() });

    expect(preview.valid).toBe(false);
    expect(preview.validationErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name' })])
    );
  });

  it('emits a public change-set covering only public-facing stages', async () => {
    const preview = await previewCycleBootstrap({ prisma, name: 'Fall 2026', timeline: validTimeline() });

    const stages = preview.publishChangeSet.entries.map((entry) => entry.stage);
    expect(stages).toContain('applications_open');
    expect(stages).not.toContain('round_one');
  });
});

describe('commitCycleBootstrap', () => {
  it('creates the cycle and its events in one transaction with audit fields', async () => {
    const prisma = makePrisma();

    const result = await commitCycleBootstrap({
      prisma,
      name: 'Fall 2026',
      timeline: validTimeline(),
      actorId: 'admin-1'
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.cycle.createdById).toBe('admin-1');
    expect(result.cycle.timelineSnapshot.stages.applications_open.start).toBeTruthy();
    expect(result.cycle.timelineCommittedAt).toBeInstanceOf(Date);
    expect(result.events).toHaveLength(4);
    expect(result.pendingFormCount).toBe(3);
  });

  it('never activates the new cycle implicitly', async () => {
    const prisma = makePrisma();

    const result = await commitCycleBootstrap({ prisma, name: 'Fall 2026', timeline: validTimeline() });

    expect(result.cycle.isActive).toBe(false);
    expect(prisma.tx.recruitingCycle.updateMany).not.toHaveBeenCalled();
    expect(prisma.recruitingCycle.updateMany).not.toHaveBeenCalled();
  });

  it('activates inside the same transaction, never after it', async () => {
    const prisma = makePrisma();

    const result = await commitCycleBootstrap({
      prisma,
      name: 'Fall 2026',
      timeline: validTimeline(),
      activate: true
    });

    expect(result.cycle.isActive).toBe(true);
    expect(prisma.tx.recruitingCycle.updateMany).toHaveBeenCalledWith({
      where: { id: { not: 'cycle-1' }, isActive: true },
      data: { isActive: false }
    });
    // No post-commit writes: a failure after commit can't leave two active cycles.
    expect(prisma.recruitingCycle.updateMany).not.toHaveBeenCalled();
    expect(prisma.recruitingCycle.update).not.toHaveBeenCalled();
  });

  it('does not activate anything when a later event insert fails', async () => {
    const prisma = makePrisma({ failOnEvent: 'round_one' });

    await expect(
      commitCycleBootstrap({
        prisma,
        name: 'Fall 2026',
        timeline: validTimeline(),
        activate: true
      })
    ).rejects.toThrow(/event insert failed/);

    // Activation lives after the event inserts in the same transaction, so the
    // failure aborts it along with the cycle row.
    expect(prisma.tx.recruitingCycle.updateMany).not.toHaveBeenCalled();
    expect(prisma.recruitingCycle.updateMany).not.toHaveBeenCalled();
  });

  it('recovers the original bootstrap when an identical commit is retried', async () => {
    const first = makePrisma();
    const original = await commitCycleBootstrap({
      prisma: first,
      name: 'Fall 2026',
      timeline: validTimeline(),
      actorId: 'admin-1'
    });

    // The retry sees the cycle the first attempt committed.
    const retry = makePrisma({
      existingCycle: {
        id: 'cycle-1',
        name: 'Fall 2026',
        timelineSnapshot: JSON.parse(JSON.stringify(original.cycle.timelineSnapshot)),
        timelineCommittedAt: new Date()
      },
      existingEvents: original.events
    });

    const result = await commitCycleBootstrap({
      prisma: retry,
      name: 'Fall 2026',
      timeline: validTimeline(),
      actorId: 'admin-1'
    });

    expect(retry.$transaction).not.toHaveBeenCalled();
    expect(result.cycle.id).toBe('cycle-1');
    expect(result.events).toHaveLength(4);
    expect(result.pendingFormCount).toBe(3);
  });

  it('rejects the same cycle name with a different timeline', async () => {
    const timeline = validTimeline();
    const prisma = makePrisma({
      existingCycle: {
        id: 'cycle-1',
        name: 'Fall 2026',
        timelineCommittedAt: new Date(),
        timelineSnapshot: { version: 1, stages: { applications_open: { start: '2025-09-01T16:00:00.000Z', end: null } } }
      }
    });

    await expect(commitCycleBootstrap({ prisma, name: 'Fall 2026', timeline })).rejects.toMatchObject({
      name: 'ValidationError'
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers instead of duplicating when it loses a unique-name race', async () => {
    const timeline = validTimeline();
    const reference = await commitCycleBootstrap({ prisma: makePrisma(), name: 'Fall 2026', timeline });

    const prisma = makePrisma({ existingEvents: reference.events });
    let seen = 0;
    prisma.recruitingCycle.findFirst.mockImplementation(async () => {
      // Absent on the pre-flight check, present once the race is lost.
      seen += 1;
      return seen === 1
        ? null
        : {
            id: 'cycle-1',
            name: 'Fall 2026',
            timelineSnapshot: JSON.parse(JSON.stringify(reference.cycle.timelineSnapshot)),
            timelineCommittedAt: new Date()
          };
    });
    prisma.$transaction.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );

    const result = await commitCycleBootstrap({ prisma, name: 'Fall 2026', timeline });

    expect(result.cycle.id).toBe('cycle-1');
    expect(result.events).toHaveLength(4);
  });

  it('keeps same-day event windows with distinct times', async () => {
    const prisma = makePrisma();
    const timeline = validTimeline();
    timeline.info_session = { start: '2026-09-05T18:00', end: '2026-09-05T20:00' };

    const result = await commitCycleBootstrap({ prisma, name: 'Fall 2026', timeline });

    const infoSession = prisma.createdEvents.find((e) => e.generatedFromStage === 'info_session');
    expect(infoSession.eventStartDate.toISOString()).toBe('2026-09-06T01:00:00.000Z');
    expect(infoSession.eventEndDate.toISOString()).toBe('2026-09-06T03:00:00.000Z');
    expect(result.events).toHaveLength(4);
  });

  it('throws a validation error and writes nothing when the timeline is invalid', async () => {
    const prisma = makePrisma();
    const timeline = validTimeline();
    delete timeline.applications_close;

    await expect(
      commitCycleBootstrap({ prisma, name: 'Fall 2026', timeline })
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores client-submitted stages that are not in the timeline', async () => {
    const prisma = makePrisma();

    const result = await commitCycleBootstrap({
      prisma,
      name: 'Fall 2026',
      timeline: validTimeline(),
      events: [
        { stageKey: 'round_two', eventName: 'Injected Event' },
        { stageKey: 'coffee_chats', eventName: 'Coffee Chats (Kerckhoff)', eventLocation: 'Kerckhoff 300' }
      ]
    });

    expect(result.events.map((e) => e.eventName)).not.toContain('Injected Event');
    expect(prisma.createdEvents.find((e) => e.generatedFromStage === 'coffee_chats')).toMatchObject({
      eventName: 'Coffee Chats (Kerckhoff)',
      eventLocation: 'Kerckhoff 300'
    });
  });

  it('backfills the legacy string deadline columns from the timeline', async () => {
    const prisma = makePrisma();

    const result = await commitCycleBootstrap({ prisma, name: 'Fall 2026', timeline: validTimeline() });

    expect(result.cycle.resumeDeadline).toBe('2026-09-20');
    expect(result.cycle.coverLetterDeadline).toBeNull();
  });
});

describe('timelineFromPriorCycle', () => {
  const cycleWith = (start) => ({
    cycles: {
      'old-cycle': {
        id: 'old-cycle',
        name: 'Prior',
        timelineSnapshot: { version: 1, stages: { applications_open: { start, end: null } } }
      }
    }
  });

  it('shifts by calendar year, not 365 days, across a leap year', async () => {
    // 2027-09-01 09:00 LA. A fixed 365-day shift lands on 2028-08-31.
    const prisma = makePrisma(cycleWith('2027-09-01T16:00:00.000Z'));

    const clone = await timelineFromPriorCycle({ prisma, sourceCycleId: 'old-cycle' });

    expect(clone.stages.applications_open.start).toBe('2028-09-01T09:00');
  });

  it('shifts out of a leap year without drifting', async () => {
    // 2028-09-01 09:00 LA -> 2029-09-01, where +365d would give 2029-09-02.
    const prisma = makePrisma(cycleWith('2028-09-01T16:00:00.000Z'));

    const clone = await timelineFromPriorCycle({ prisma, sourceCycleId: 'old-cycle' });

    expect(clone.stages.applications_open.start).toBe('2029-09-01T09:00');
  });

  it('clamps Feb 29 to Feb 28 in a common year', async () => {
    // 2028-02-29 09:00 LA; 2029 has no Feb 29.
    const prisma = makePrisma(cycleWith('2028-02-29T17:00:00.000Z'));

    const clone = await timelineFromPriorCycle({ prisma, sourceCycleId: 'old-cycle' });

    expect(clone.stages.applications_open.start).toBe('2029-02-28T09:00');
  });

  it('preserves the time of day of an event window', async () => {
    const prisma = makePrisma({
      cycles: {
        'old-cycle': {
          id: 'old-cycle',
          name: 'Prior',
          timelineSnapshot: {
            version: 1,
            stages: { info_session: { start: '2027-09-06T01:00:00.000Z', end: '2027-09-06T03:00:00.000Z' } }
          }
        }
      }
    });

    const clone = await timelineFromPriorCycle({ prisma, sourceCycleId: 'old-cycle' });

    expect(clone.stages.info_session).toEqual({
      start: '2028-09-05T18:00',
      end: '2028-09-05T20:00'
    });
  });

  it('shifts a stored snapshot forward and never carries form links', async () => {
    const prisma = makePrisma({
      cycles: {
        'old-cycle': {
          id: 'old-cycle',
          name: 'Fall 2025',
          formUrl: 'https://forms.gle/old',
          timelineSnapshot: {
            version: 1,
            stages: { applications_open: { start: '2025-09-01T16:00:00.000Z', end: null } }
          }
        }
      }
    });

    const clone = await timelineFromPriorCycle({ prisma, sourceCycleId: 'old-cycle' });

    expect(clone.stages.applications_open.start).toBe('2026-09-01T09:00');
    expect(JSON.stringify(clone)).not.toContain('forms.gle');
  });

  it('fails clearly when the source cycle has no stored timeline', async () => {
    const prisma = makePrisma({ cycles: { legacy: { id: 'legacy', name: 'Fall 2024' } } });

    await expect(timelineFromPriorCycle({ prisma, sourceCycleId: 'legacy' })).rejects.toThrow(
      /no stored timeline/
    );
  });
});
