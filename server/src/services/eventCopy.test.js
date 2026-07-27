import { describe, it, expect, vi } from 'vitest';
import { previewCycleEventCopy, commitCycleEventCopy, PORTABLE_EVENT_FIELDS } from './eventCopy.js';

describe('eventCopy service', () => {
  const sourceCycle = { id: 'source-1', name: 'Fall 2025' };
  const targetCycle = { id: 'target-1', name: 'Fall 2026' };

  const sourceEvent = {
    id: 'event-1',
    eventName: 'Info Session',
    eventStartDate: new Date('2025-09-01T18:00:00.000Z'),
    eventEndDate: new Date('2025-09-01T20:00:00.000Z'),
    eventLocation: 'Room A',
    rsvpForm: 'https://forms.gle/rsvp',
    attendanceForm: 'https://forms.gle/attendance',
    memberRsvpUrl: 'https://forms.gle/member-rsvp',
    showToCandidates: true,
    cycleId: sourceCycle.id,
  };

  function createMockPrisma({ targetEvents = [] } = {}) {
    const events = {
      findMany: vi.fn(),
      create: vi.fn(),
    };
    const recruitingCycle = {
      findUnique: vi.fn(),
    };

    const mockPrisma = {
      recruitingCycle,
      events,
      $transaction: vi.fn((cb) => {
        const tx = { events: { create: events.create } };
        return cb(tx);
      }),
    };

    recruitingCycle.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === sourceCycle.id) return sourceCycle;
      if (id === targetCycle.id) return targetCycle;
      return null;
    });

    events.findMany.mockImplementation(({ where }) => {
      if (where.cycleId === sourceCycle.id) return [sourceEvent];
      if (where.cycleId === targetCycle.id) return targetEvents;
      return [];
    });

    return mockPrisma;
  }

  it('documents the approved portable event fields', () => {
    const names = PORTABLE_EVENT_FIELDS.map((f) => f.name);
    expect(names).toEqual([
      'eventName',
      'eventStartDate',
      'eventEndDate',
      'eventLocation',
      'showToCandidates',
      'rsvpForm',
      'attendanceForm',
      'memberRsvpUrl',
    ]);
  });

  it('previews events from the source cycle with target cycle metadata', async () => {
    const mockPrisma = createMockPrisma();

    const result = await previewCycleEventCopy({
      prisma: mockPrisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
    });

    expect(result.sourceCycle).toEqual({ id: sourceCycle.id, name: sourceCycle.name });
    expect(result.targetCycle).toEqual({ id: targetCycle.id, name: targetCycle.name });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].sourceEventId).toBe(sourceEvent.id);
    expect(result.events[0].eventName).toBe(sourceEvent.eventName);
    expect(result.events[0].alreadyExists).toBe(false);
  });

  it('flags events that already exist in the target cycle', async () => {
    const targetEvents = [{ id: 'event-existing', eventName: 'Info Session', eventStartDate: new Date() }];
    const mockPrisma = createMockPrisma({ targetEvents });

    const result = await previewCycleEventCopy({
      prisma: mockPrisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
    });

    expect(result.events[0].alreadyExists).toBe(true);
  });

  it('throws when source and target cycles are the same', async () => {
    const mockPrisma = createMockPrisma();
    await expect(
      previewCycleEventCopy({ prisma: mockPrisma, sourceCycleId: sourceCycle.id, targetCycleId: sourceCycle.id })
    ).rejects.toThrow('different');
  });

  it('throws when the source cycle does not exist', async () => {
    const mockPrisma = createMockPrisma();
    await expect(
      previewCycleEventCopy({ prisma: mockPrisma, sourceCycleId: 'missing', targetCycleId: targetCycle.id })
    ).rejects.toThrow('Source recruiting cycle not found');
  });

  it('commits a copy with explicit date and location edits', async () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.events.create.mockResolvedValue({ id: 'new-event-1' });

    const events = [
      {
        sourceEventId: sourceEvent.id,
        eventName: 'Info Session Copy',
        eventStartDate: '2026-09-01T18:00:00.000Z',
        eventEndDate: '2026-09-01T20:00:00.000Z',
        eventLocation: 'Room B',
        showToCandidates: true,
        rsvpForm: 'https://forms.gle/new-rsvp',
        attendanceForm: '',
        memberRsvpUrl: '',
      },
    ];

    const result = await commitCycleEventCopy({
      prisma: mockPrisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
      events,
    });

    expect(result.copiedCount).toBe(1);
    expect(result.created[0]).toEqual({ id: 'new-event-1' });
    expect(mockPrisma.events.create).toHaveBeenCalledWith({
      data: {
        cycleId: targetCycle.id,
        eventName: 'Info Session Copy',
        eventStartDate: new Date('2026-09-01T18:00:00.000Z'),
        eventEndDate: new Date('2026-09-01T20:00:00.000Z'),
        eventLocation: 'Room B',
        showToCandidates: true,
        rsvpForm: 'https://forms.gle/new-rsvp',
        attendanceForm: null,
        memberRsvpUrl: null,
      },
      select: expect.any(Object),
    });
  });

  it('does not copy rsvp/attendance/member-rsvp source records', async () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.events.create.mockResolvedValue({ id: 'new-event-1' });

    const events = [
      {
        sourceEventId: sourceEvent.id,
        eventName: 'Info Session Copy',
        eventStartDate: '2026-09-01T18:00:00.000Z',
        eventEndDate: '2026-09-01T20:00:00.000Z',
        eventLocation: 'Room B',
        showToCandidates: false,
        rsvpForm: '',
        attendanceForm: '',
        memberRsvpUrl: '',
      },
    ];

    await commitCycleEventCopy({
      prisma: mockPrisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
      events,
    });

    const createData = mockPrisma.events.create.mock.calls[0][0].data;
    expect(createData.rsvpForm).toBeNull();
    expect(createData.attendanceForm).toBeNull();
    expect(createData.memberRsvpUrl).toBeNull();
  });

  it('rejects commits with invalid dates or end before start', async () => {
    const mockPrisma = createMockPrisma();

    const events = [
      {
        sourceEventId: sourceEvent.id,
        eventName: 'Bad Dates',
        eventStartDate: '2026-09-01T20:00:00.000Z',
        eventEndDate: '2026-09-01T18:00:00.000Z',
        eventLocation: 'Room B',
        showToCandidates: false,
      },
    ];

    await expect(
      commitCycleEventCopy({
        prisma: mockPrisma,
        sourceCycleId: sourceCycle.id,
        targetCycleId: targetCycle.id,
        events,
      })
    ).rejects.toThrow('Validation failed');
  });

  it('rejects duplicate event names in the target cycle unless force is set', async () => {
    const targetEvents = [{ id: 'event-existing', eventName: 'Info Session' }];
    const mockPrisma = createMockPrisma({ targetEvents });

    const events = [
      {
        sourceEventId: sourceEvent.id,
        eventName: 'Info Session',
        eventStartDate: '2026-09-01T18:00:00.000Z',
        eventEndDate: '2026-09-01T20:00:00.000Z',
        eventLocation: 'Room B',
        showToCandidates: false,
      },
    ];

    await expect(
      commitCycleEventCopy({
        prisma: mockPrisma,
        sourceCycleId: sourceCycle.id,
        targetCycleId: targetCycle.id,
        events,
      })
    ).rejects.toThrow('Validation failed');
  });

  it('skips duplicates and creates remaining events when force is set', async () => {
    const targetEvents = [{ id: 'event-existing', eventName: 'Info Session' }];
    const mockPrisma = createMockPrisma({ targetEvents });
    mockPrisma.events.create.mockResolvedValue({ id: 'new-event-2' });

    const events = [
      {
        sourceEventId: sourceEvent.id,
        eventName: 'Info Session',
        eventStartDate: '2026-09-01T18:00:00.000Z',
        eventEndDate: '2026-09-01T20:00:00.000Z',
        eventLocation: 'Room B',
        showToCandidates: false,
      },
      {
        sourceEventId: 'event-2',
        eventName: 'New Event',
        eventStartDate: '2026-09-02T18:00:00.000Z',
        eventEndDate: '2026-09-02T20:00:00.000Z',
        eventLocation: 'Room C',
        showToCandidates: true,
      },
    ];

    const result = await commitCycleEventCopy({
      prisma: mockPrisma,
      sourceCycleId: sourceCycle.id,
      targetCycleId: targetCycle.id,
      events,
      force: true,
    });

    expect(result.skippedCount).toBe(1);
    expect(result.copiedCount).toBe(1);
    expect(result.created[0]).toEqual({ id: 'new-event-2' });
  });
});
