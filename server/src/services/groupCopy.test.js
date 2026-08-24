import { describe, it, expect, vi } from 'vitest';
import {
  previewCopyCandidateGroupToInterview,
  commitCopyCandidateGroupToInterview,
  REQUIRED_APPLICATION_FIELDS,
} from './groupCopy.js';

describe('groupCopy service', () => {
  const cycleId = 'cycle-1';
  const interviewId = 'interview-1';
  const sourceGroupId = 'group-1';
  const actorId = 'admin-1';

  function makeApplication(overrides = {}) {
    return {
      id: 'app-1',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Anderson',
      studentId: '12345678',
      phoneNumber: '555-0001',
      graduationYear: '2026',
      cumulativeGpa: '3.50',
      major1: 'Computer Science',
      resumeUrl: 'https://example.com/resume.pdf',
      headshotUrl: 'https://example.com/headshot.jpg',
      cycleId,
      submittedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function makeCandidate(overrides = {}) {
    return {
      id: 'candidate-1',
      studentId: '12345678',
      firstName: 'Alice',
      lastName: 'Anderson',
      applications: [makeApplication()],
      ...overrides,
    };
  }

  function makeSourceGroup(overrides = {}) {
    return {
      id: sourceGroupId,
      name: 'Team A',
      cycleId,
      assignedCandidates: [makeCandidate()],
      ...overrides,
    };
  }

  function makeInterview(description = {}) {
    return {
      id: interviewId,
      title: 'Coffee Chat 1',
      cycleId,
      description: JSON.stringify(description),
    };
  }

  function createMockPrisma() {
    const mockPrisma = {
      interview: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      groups: {
        findUnique: vi.fn(),
      },
      $executeRaw: vi.fn(),
      $transaction: vi.fn((cb) => cb(mockPrisma)),
    };
    return mockPrisma;
  }

  it('documents the required application fields', () => {
    const labels = REQUIRED_APPLICATION_FIELDS.map((f) => f.label);
    expect(labels).toContain('Email');
    expect(labels).toContain('Resume');
    expect(labels).toContain('Cumulative GPA');
  });

  it('previews a copy into a new interview group', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue(makeInterview());
    prisma.groups.findUnique.mockResolvedValue(makeSourceGroup());

    const preview = await previewCopyCandidateGroupToInterview({
      prisma,
      interviewId,
      sourceGroupId,
      mode: 'add',
    });

    expect(preview.sourceGroup.id).toBe(sourceGroupId);
    expect(preview.targetGroup.name).toBe('Team A (Interview)');
    expect(preview.additions).toHaveLength(1);
    expect(preview.additions[0].firstName).toBe('Alice');
    expect(preview.counts.additions).toBe(1);
    expect(preview.counts.duplicates).toBe(0);
    expect(preview.counts.skipped).toBe(0);
    expect(preview.targetGroup.postCopyApplicationCount).toBe(1);
  });

  it('previews skipped candidates with missing applications and missing data', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue(makeInterview());
    prisma.groups.findUnique.mockResolvedValue(
      makeSourceGroup({
        assignedCandidates: [
          makeCandidate({ id: 'candidate-2', studentId: '999', applications: [] }),
          makeCandidate({
            id: 'candidate-3',
            studentId: '888',
            applications: [makeApplication({ id: 'app-2', resumeUrl: '' })],
          }),
        ],
      })
    );

    const preview = await previewCopyCandidateGroupToInterview({
      prisma,
      interviewId,
      sourceGroupId,
      mode: 'add',
    });

    expect(preview.counts.skipped).toBe(2);
    expect(preview.skipped[0].reason).toBe('no_application');
    expect(preview.skipped[1].reason).toBe('missing_required_data');
    expect(preview.skipped[1].missingFields).toContain('Resume');
    expect(preview.additions).toHaveLength(0);
  });

  it('commits a copy and persists the audit in interview description', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue(makeInterview());
    prisma.groups.findUnique.mockResolvedValue(makeSourceGroup());
    prisma.interview.update.mockResolvedValue({ id: interviewId });

    const result = await commitCopyCandidateGroupToInterview({
      prisma,
      interviewId,
      sourceGroupId,
      mode: 'add',
      actorId,
    });

    expect(result.config.applicationGroups).toHaveLength(1);
    expect(result.config.applicationGroups[0].applicationIds).toHaveLength(1);
    expect(result.config.copyAudits).toHaveLength(1);
    expect(result.config.copyAudits[0].copiedBy).toBe(actorId);
    expect(result.config.copyAudits[0].additionsCount).toBe(1);
    expect(result.audit.copiedBy).toBe(actorId);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: interviewId },
        data: expect.objectContaining({
          description: expect.stringContaining(result.config.applicationGroups[0].id),
        }),
      })
    );
  });

  it('adds only new applications in add mode and preserves existing assignments', async () => {
    const prisma = createMockPrisma();
    const existingGroupId = 'existing-app-group';
    const existingAppId = 'existing-app';
    prisma.interview.findUnique.mockResolvedValue(
      makeInterview({
        applicationGroups: [
          { id: existingGroupId, name: 'Existing Group', applicationIds: [existingAppId], notes: '' },
        ],
      })
    );
    prisma.groups.findUnique.mockResolvedValue(
      makeSourceGroup({
        assignedCandidates: [
          makeCandidate({ applications: [makeApplication({ id: existingAppId })] }),
          makeCandidate({
            id: 'candidate-4',
            studentId: '777',
            firstName: 'Charlie',
            lastName: 'Chaplin',
            applications: [makeApplication({ id: 'app-new' })],
          }),
        ],
      })
    );

    const preview = await previewCopyCandidateGroupToInterview({
      prisma,
      interviewId,
      sourceGroupId,
      targetGroupId: existingGroupId,
      mode: 'add',
    });

    expect(preview.additions).toHaveLength(1);
    expect(preview.additions[0].applicationId).toBe('app-new');
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0].applicationId).toBe(existingAppId);
    expect(preview.targetGroup.postCopyApplicationCount).toBe(2);
  });

  it('is idempotent when re-running add mode', async () => {
    const prisma = createMockPrisma();
    const existingGroupId = 'existing-app-group';
    const existingAppId = 'existing-app';
    prisma.interview.findUnique.mockResolvedValue(
      makeInterview({
        applicationGroups: [
          { id: existingGroupId, name: 'Existing Group', applicationIds: [existingAppId], notes: '' },
        ],
      })
    );
    prisma.groups.findUnique.mockResolvedValue(
      makeSourceGroup({
        assignedCandidates: [makeCandidate({ applications: [makeApplication({ id: existingAppId })] })],
      })
    );

    const preview = await previewCopyCandidateGroupToInterview({
      prisma,
      interviewId,
      sourceGroupId,
      targetGroupId: existingGroupId,
      mode: 'add',
    });

    expect(preview.additions).toHaveLength(0);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.targetGroup.postCopyApplicationCount).toBe(1);
  });

  it('replaces group contents and reports removals', async () => {
    const prisma = createMockPrisma();
    const existingGroupId = 'existing-app-group';
    prisma.interview.findUnique.mockResolvedValue(
      makeInterview({
        applicationGroups: [
          { id: existingGroupId, name: 'Existing Group', applicationIds: ['app-old', 'app-also-old'], notes: '' },
        ],
      })
    );
    prisma.groups.findUnique.mockResolvedValue(
      makeSourceGroup({
        assignedCandidates: [
          makeCandidate({ applications: [makeApplication({ id: 'app-old' })] }),
          makeCandidate({
            id: 'candidate-5',
            studentId: '666',
            firstName: 'Dana',
            lastName: 'Doe',
            applications: [makeApplication({ id: 'app-new' })],
          }),
        ],
      })
    );

    const result = await commitCopyCandidateGroupToInterview({
      prisma,
      interviewId,
      sourceGroupId,
      targetGroupId: existingGroupId,
      mode: 'replace',
      actorId,
    });

    const group = result.config.applicationGroups.find((g) => g.id === existingGroupId);
    expect(group.applicationIds).toEqual(['app-old', 'app-new']);
    expect(result.preview.removals).toHaveLength(1);
    expect(result.preview.removals[0].applicationId).toBe('app-also-old');
    expect(result.preview.counts.additions).toBe(1);
    expect(result.preview.counts.duplicates).toBe(1);
  });

  it('rejects cross-cycle source groups', async () => {
    const prisma = createMockPrisma();
    prisma.interview.findUnique.mockResolvedValue(makeInterview());
    prisma.groups.findUnique.mockResolvedValue(makeSourceGroup({ cycleId: 'cycle-2' }));

    await expect(
      previewCopyCandidateGroupToInterview({
        prisma,
        interviewId,
        sourceGroupId,
        mode: 'add',
      })
    ).rejects.toThrow('same recruiting cycle');
  });

  it('rejects an invalid mode', async () => {
    const prisma = createMockPrisma();
    await expect(
      previewCopyCandidateGroupToInterview({
        prisma,
        interviewId,
        sourceGroupId,
        mode: 'merge',
      })
    ).rejects.toThrow("Mode must be 'add' or 'replace'");
  });
});
