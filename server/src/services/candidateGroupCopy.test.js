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
    $executeRaw: vi.fn(),
    transactions: [],
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

  it('commits an idempotent add-only copy', async () => {
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
    expect(result.copiedByUserId).toBe(adminUser.id);
    expect(result.copiedAt).toBeTruthy();

    const tx = mockPrisma.transactions[0];
    const updateArgs = tx.interview.update.mock.calls[0][0];
    const config = JSON.parse(updateArgs.data.description);
    expect(config.applicationGroups).toHaveLength(1);
    expect(config.applicationGroups[0].applicationIds).toEqual(['app-1', 'app-2']);
    expect(config.applicationGroups[0].copiedFromGroupId).toBe(sourceGroup.id);
    expect(config.applicationGroups[0].copiedByUserId).toBe(adminUser.id);
  });

  it('is idempotent on re-run to the same destination group', async () => {
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
});
