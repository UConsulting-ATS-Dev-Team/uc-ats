import { describe, it, expect, vi } from 'vitest';
import { previewCandidateGroupCopy, commitCandidateGroupCopy } from './candidateGroupCopy.js';

const adminUser = { id: 'admin-1', role: 'ADMIN' };
const candidateUser = { id: 'candidate-user-1', role: 'USER' };

const cycleId = 'cycle-1';

const sourceGroup = {
  id: 'group-1',
  name: 'Team Alpha',
  cycleId,
  assignedCandidates: [
    {
      id: 'candidate-1',
      studentId: '12345',
      firstName: 'Alice',
      lastName: 'Anderson',
      email: 'alice@example.com',
      applications: [
        {
          id: 'app-1',
          firstName: 'Alice',
          lastName: 'Anderson',
          email: 'alice@example.com',
          studentId: '12345',
          submittedAt: new Date('2026-01-01'),
        },
      ],
    },
    {
      id: 'candidate-2',
      studentId: '67890',
      firstName: 'Bob',
      lastName: 'Baker',
      email: 'bob@example.com',
      applications: [
        {
          id: 'app-2',
          firstName: 'Bob',
          lastName: 'Baker',
          email: 'bob@example.com',
          studentId: '67890',
          submittedAt: new Date('2026-01-02'),
        },
      ],
    },
    {
      id: 'candidate-3',
      studentId: '11111',
      firstName: 'Carol',
      lastName: 'Chen',
      email: 'carol@example.com',
      applications: [],
    },
  ],
};

const interview = {
  id: 'iv-1',
  title: 'Coffee Chat',
  cycleId,
  description: JSON.stringify({
    memberGroups: [],
    applicationGroups: [
      {
        id: 'dest-group-1',
        name: 'Existing Group',
        applicationIds: ['app-1'],
      },
    ],
    groupAssignments: {},
  }),
};

function createMockPrisma({ group = sourceGroup, iv = interview } = {}) {
  // Deep-clone fixtures so mutations in one test do not leak to others.
  iv = JSON.parse(JSON.stringify(iv));
  group = JSON.parse(JSON.stringify(group));
  const copyEvents = [];

  function makeCandidateGroupCopyEvent(client) {
    return {
      findUnique: vi.fn(({ where }) => {
        const key = where?.interviewId_operationKey;
        const found = key
          ? copyEvents.find(
              (e) => e.interviewId === key.interviewId && e.operationKey === key.operationKey
            )
          : null;
        return Promise.resolve(found || null);
      }),
      findMany: vi.fn(({ where } = {}) => {
        const found = where?.interviewId
          ? copyEvents.filter((e) => e.interviewId === where.interviewId)
          : copyEvents;
        return Promise.resolve([...found]);
      }),
      create: vi.fn(({ data }) => {
        const event = { ...data, id: `copy-event-${copyEvents.length + 1}` };
        copyEvents.push(event);
        return Promise.resolve(event);
      }),
    };
  }

  const candidateGroupCopyEvent = makeCandidateGroupCopyEvent();
  const mockPrisma = {
    interview: {
      findUnique: vi.fn().mockResolvedValue(iv),
      update: vi.fn().mockImplementation(({ where, data }) =>
        Promise.resolve({
          id: where.id,
          title: iv.title,
          cycleId: iv.cycleId,
          description: data.description,
        })
      ),
    },
    groups: {
      findUnique: vi.fn().mockResolvedValue(group),
    },
    candidateGroupCopyEvent,
    $executeRaw: vi.fn(),
    transactions: [],
    copyEvents,
    group,
    iv,
    $transaction: vi.fn((cb) => {
      const tx = {
        interview: {
          findUnique: vi.fn().mockResolvedValue(iv),
          update: vi.fn().mockImplementation(({ where, data }) => {
            iv.description = data.description;
            return Promise.resolve({
              id: where.id,
              title: iv.title,
              cycleId: iv.cycleId,
              description: data.description,
            });
          }),
        },
        groups: {
          findUnique: vi.fn().mockResolvedValue(group),
        },
        candidateGroupCopyEvent: makeCandidateGroupCopyEvent(),
        $executeRaw: vi.fn(),
      };
      mockPrisma.transactions.push(tx);
      return cb(tx);
    }),
  };
  return mockPrisma;
}

describe('candidateGroupCopy service', () => {
  it('previews additions, duplicates, and missing candidates', async () => {
    const mockPrisma = createMockPrisma();

    const preview = await previewCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      destinationGroupId: 'dest-group-1',
    });

    expect(preview.sourceGroup.id).toBe(sourceGroup.id);
    expect(preview.destinationInterview.id).toBe(interview.id);
    expect(preview.destinationGroup.existingApplicationCount).toBe(1);

    expect(preview.additions).toHaveLength(1);
    expect(preview.additions[0].applicationId).toBe('app-2');

    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0].applicationId).toBe('app-1');

    expect(preview.skipped).toHaveLength(1);
    expect(preview.skipped[0].candidateId).toBe('candidate-3');
    expect(preview.skipped[0].reason).toBe('no_application_in_cycle');

    expect(preview.additionCount).toBe(1);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.skippedCount).toBe(1);
  });

  it('creates a new destination group when none is provided', async () => {
    const mockPrisma = createMockPrisma();

    const preview = await previewCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
    });

    expect(preview.destinationGroup.isNew).toBe(true);
    expect(preview.destinationGroup.existingApplicationCount).toBe(0);
    expect(preview.additions).toHaveLength(2);
    expect(preview.duplicates).toHaveLength(0);
    expect(preview.skipped).toHaveLength(1);
  });

  it('throws when the source group and interview are in different cycles', async () => {
    const mockPrisma = createMockPrisma({
      group: { ...sourceGroup, cycleId: 'other-cycle' },
    });

    await expect(
      previewCandidateGroupCopy({
        prisma: mockPrisma,
        sourceGroupId: sourceGroup.id,
        destinationInterviewId: interview.id,
      })
    ).rejects.toThrow('same recruiting cycle');
  });

  it('throws when the destination interview does not exist', async () => {
    const mockPrisma = createMockPrisma({ iv: null });

    await expect(
      previewCandidateGroupCopy({
        prisma: mockPrisma,
        sourceGroupId: sourceGroup.id,
        destinationInterviewId: interview.id,
      })
    ).rejects.toThrow('Interview not found');
  });

  it('commits an add-only copy and records an append-only audit event', async () => {
    const mockPrisma = createMockPrisma();

    const result = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      destinationGroupId: 'dest-group-1',
      actorId: adminUser.id,
    });

    expect(result.additionCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.destinationGroup.newCount).toBe(2);
    expect(result.copyEvent).toBeTruthy();
    expect(result.copyEvent.sourceGroupId).toBe(sourceGroup.id);
    expect(result.copyEvent.actorId).toBe(adminUser.id);
    expect(result.copyEvent.additionCount).toBe(1);
    expect(result.copyEvent.skippedCount).toBe(1);
    expect(result.copiedByUserId).toBe(adminUser.id);
    expect(result.copiedAt).toBeTruthy();

    const tx = mockPrisma.transactions[0];
    const updateArgs = tx.interview.update.mock.calls[0][0];
    const config = JSON.parse(updateArgs.data.description);
    expect(config.applicationGroups).toHaveLength(1);
    expect(config.applicationGroups[0].applicationIds).toEqual(['app-1', 'app-2']);
    expect(config.applicationGroups[0].copiedFromGroupId).toBeUndefined();
    expect(config.applicationGroups[0].copiedByUserId).toBeUndefined();
  });

  it('is idempotent on re-run to the same destination group and does not duplicate audit events', async () => {
    const mockPrisma = createMockPrisma();

    await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      destinationGroupId: 'dest-group-1',
      actorId: adminUser.id,
    });

    const second = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      destinationGroupId: 'dest-group-1',
      actorId: adminUser.id,
    });

    expect(second.additionCount).toBe(0);
    expect(second.duplicateCount).toBe(2);
    expect(second.skippedCount).toBe(1);
    expect(second.copyEvent.id).toBe(mockPrisma.copyEvents[0].id);
    expect(mockPrisma.copyEvents).toHaveLength(1);
  });

  it('rejects unsupported replace mode', async () => {
    const mockPrisma = createMockPrisma();

    await expect(
      commitCandidateGroupCopy({
        prisma: mockPrisma,
        sourceGroupId: sourceGroup.id,
        destinationInterviewId: interview.id,
        mode: 'replace',
      })
    ).rejects.toThrow('Only add-only mode is supported');
  });

  it('flags a candidate with missing required application data as skipped', async () => {
    const groupWithBadApp = {
      ...sourceGroup,
      assignedCandidates: [
        {
          ...sourceGroup.assignedCandidates[0],
          applications: [
            {
              id: 'bad-app',
              firstName: '',
              lastName: 'Anderson',
              email: 'alice@example.com',
            },
          ],
        },
      ],
    };
    const mockPrisma = createMockPrisma({ group: groupWithBadApp });

    const preview = await previewCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
    });

    expect(preview.skipped).toHaveLength(1);
    expect(preview.skipped[0].reason).toBe('missing_required_data');
  });

  it('create-new commit is idempotent on identical retries and records only one audit event', async () => {
    const emptyInterview = {
      ...interview,
      description: JSON.stringify({ memberGroups: [], applicationGroups: [], groupAssignments: {} }),
    };
    const mockPrisma = createMockPrisma({ iv: emptyInterview });

    const first = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      actorId: adminUser.id,
    });

    expect(first.additionCount).toBe(2);
    expect(first.config.applicationGroups).toHaveLength(1);
    expect(first.copyEvent).toBeTruthy();

    const second = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      actorId: adminUser.id,
    });

    expect(second.additionCount).toBe(0);
    expect(second.duplicateCount).toBe(2);
    expect(second.skippedCount).toBe(1);
    expect(second.destinationGroup.id).toBe(first.destinationGroup.id);
    expect(second.copyEvent.id).toBe(first.copyEvent.id);
    expect(mockPrisma.copyEvents).toHaveLength(1);

    const tx = mockPrisma.transactions[0];
    const updateArgs = tx.interview.update.mock.calls[0][0];
    const config = JSON.parse(updateArgs.data.description);
    expect(config.applicationGroups).toHaveLength(1);
  });

  it('preview for create-new becomes an existing group after commit', async () => {
    const mockPrisma = createMockPrisma();

    const previewBefore = await previewCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
    });

    expect(previewBefore.destinationGroup.isNew).toBe(true);
    expect(previewBefore.destinationGroup.id).toBeTruthy();

    await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      actorId: adminUser.id,
    });

    const previewAfter = await previewCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
    });

    expect(previewAfter.destinationGroup.isNew).toBeFalsy();
    expect(previewAfter.destinationGroup.existingApplicationCount).toBe(2);
    expect(previewAfter.additionCount).toBe(0);
    expect(previewAfter.duplicateCount).toBe(2);
  });

  it('throws when an explicit destinationGroupId is not found', async () => {
    const mockPrisma = createMockPrisma();

    await expect(
      previewCandidateGroupCopy({
        prisma: mockPrisma,
        sourceGroupId: sourceGroup.id,
        destinationInterviewId: interview.id,
        destinationGroupId: 'missing-group-id',
      })
    ).rejects.toThrow('Destination group not found in interview');

    await expect(
      commitCandidateGroupCopy({
        prisma: mockPrisma,
        sourceGroupId: sourceGroup.id,
        destinationInterviewId: interview.id,
        destinationGroupId: 'missing-group-id',
        actorId: adminUser.id,
      })
    ).rejects.toThrow('Destination group not found in interview');
  });

  it('returns the authoritative committed config and an append-only audit event', async () => {
    const mockPrisma = createMockPrisma({
      iv: {
        ...interview,
        description: JSON.stringify({
          memberGroups: [{ id: 'keep', name: 'Keep Me' }],
          applicationGroups: [],
          groupAssignments: { g1: ['a1'] },
        }),
      },
    });

    const result = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: sourceGroup.id,
      destinationInterviewId: interview.id,
      actorId: adminUser.id,
    });

    expect(result.config).toBeTruthy();
    expect(result.config.memberGroups).toEqual([{ id: 'keep', name: 'Keep Me' }]);
    expect(result.config.groupAssignments).toEqual({ g1: ['a1'] });
    expect(result.config.applicationGroups[0].copiedFromGroupId).toBeUndefined();
    expect(result.config.applicationGroups[0].copiedByUserId).toBeUndefined();
    expect(result.destinationGroup.copiedFromGroupId).toBeUndefined();
    expect(result.copyEvent).toBeTruthy();
    expect(result.copyEvent.sourceGroupId).toBe(sourceGroup.id);
    expect(result.copyEvent.actorId).toBe(adminUser.id);
    expect(result.copyEvent.additions).toHaveLength(2);
    expect(result.copyEvent.skipped).toHaveLength(1);
  });

  it('appends a second audit event when a different source is copied to the same destination', async () => {
    const emptyInterview = {
      ...interview,
      description: JSON.stringify({ memberGroups: [], applicationGroups: [], groupAssignments: {} }),
    };
    const mockPrisma = createMockPrisma({ iv: emptyInterview });

    const firstSource = sourceGroup;
    const secondSource = {
      ...sourceGroup,
      id: 'group-2',
      name: 'Team Beta',
      assignedCandidates: [
        {
          ...sourceGroup.assignedCandidates[0],
          id: 'candidate-4',
          applications: [{ id: 'app-4', firstName: 'Dana', lastName: 'Doe', email: 'dana@example.com', studentId: '44444', submittedAt: new Date() }],
        },
      ],
    };

    const first = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: firstSource.id,
      destinationInterviewId: interview.id,
      actorId: 'admin-a',
    });

    // Copy a second source into the same deterministic destination group.
    Object.assign(mockPrisma.group, JSON.parse(JSON.stringify(secondSource)));

    const second = await commitCandidateGroupCopy({
      prisma: mockPrisma,
      sourceGroupId: secondSource.id,
      destinationInterviewId: interview.id,
      destinationGroupId: first.destinationGroup.id,
      actorId: 'admin-b',
    });

    expect(second.additionCount).toBe(1);
    expect(second.copyEvent.sourceGroupId).toBe('group-2');
    expect(second.copyEvent.actorId).toBe('admin-b');
    expect(mockPrisma.copyEvents).toHaveLength(2);
    expect(mockPrisma.copyEvents[0].actorId).toBe('admin-a');
    expect(mockPrisma.copyEvents[1].actorId).toBe('admin-b');
  });
});
