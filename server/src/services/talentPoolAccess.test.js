// Withdrawing someone from the Talent Partner Network on deactivation.
//
// Deactivation is how this app records that a person has left. Two things have
// to follow, and the pool gate only covers the first: no new assignments, and
// no surviving access through assignments already handed out. Assignments are
// snapshots and are never re-derived, so the second needs an explicit
// revocation, which is what this covers.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { revokeTalentPoolAccess } from './talentPoolAccess.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findMany: vi.fn() },
    memberResume: { findMany: vi.fn() },
    externalResume: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
    clientResumeAssignment: { updateMany: vi.fn() },
  },
}));

const leaver = { id: 'user-1', email: 'gone@uc.org', studentId: '405123456' };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([leaver]);
  prisma.memberResume.findMany.mockResolvedValue([]);
  prisma.externalResume.findMany.mockResolvedValue([]);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.clientResumeAssignment.updateMany.mockResolvedValue({ count: 0 });
});

const whereOf = () => prisma.clientResumeAssignment.updateMany.mock.calls[0][0].where;

describe('revoking access', () => {
  it('revokes a member resume that is out with clients', async () => {
    prisma.memberResume.findMany.mockResolvedValue([{ id: 'mr-1' }]);
    prisma.clientResumeAssignment.updateMany.mockResolvedValue({ count: 2 });

    const result = await revokeTalentPoolAccess(['user-1'], 'admin-1');

    expect(result).toEqual({ revoked: 2 });
    expect(whereOf().OR).toContainEqual({ memberResumeId: { in: ['mr-1'] } });
  });

  it('covers all three pools, because one person can be in more than one', async () => {
    // A member who also applied is in the applicant pool through their
    // application and the member pool through their uploaded resume.
    prisma.memberResume.findMany.mockResolvedValue([{ id: 'mr-1' }]);
    prisma.externalResume.findMany.mockResolvedValue([{ id: 'er-1' }]);
    prisma.application.findMany.mockResolvedValue([{ id: 'app-1' }]);

    await revokeTalentPoolAccess(['user-1'], 'admin-1');

    expect(whereOf().OR).toEqual([
      { memberResumeId: { in: ['mr-1'] } },
      { externalResumeId: { in: ['er-1'] } },
      { applicationId: { in: ['app-1'] } },
    ]);
  });

  it('matches applications on email and student ID, since they have no user FK', async () => {
    await revokeTalentPoolAccess(['user-1'], 'admin-1');

    expect(prisma.application.findMany.mock.calls[0][0].where.OR).toEqual([
      { email: leaver.email },
      { candidate: { email: leaver.email } },
      { studentId: leaver.studentId },
      { candidate: { studentId: leaver.studentId } },
    ]);
  });

  it('only touches assignments that are still live', async () => {
    prisma.memberResume.findMany.mockResolvedValue([{ id: 'mr-1' }]);
    await revokeTalentPoolAccess(['user-1'], 'admin-1');

    expect(whereOf().revokedAt).toBeNull();
    expect(prisma.clientResumeAssignment.updateMany.mock.calls[0][0].data).toMatchObject({
      revokedById: 'admin-1',
    });
  });

  it('leaves the consent record alone', async () => {
    // shareConsent and talentPoolOptIn record what the person chose.
    // Overwriting them would mean a reactivated account silently comes back
    // opted out of something they had agreed to.
    prisma.memberResume.findMany.mockResolvedValue([{ id: 'mr-1' }]);
    await revokeTalentPoolAccess(['user-1'], 'admin-1');

    expect(prisma.clientResumeAssignment.updateMany.mock.calls[0][0].data.shareConsent).toBeUndefined();
  });
});

describe('when there is nothing to revoke', () => {
  it('does no work for an empty list', async () => {
    expect(await revokeTalentPoolAccess([], 'admin-1')).toEqual({ revoked: 0 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('does no work for someone with no resume and no application', async () => {
    expect(await revokeTalentPoolAccess(['user-1'], 'admin-1')).toEqual({ revoked: 0 });
    expect(prisma.clientResumeAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('handles a user id that no longer exists', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    expect(await revokeTalentPoolAccess(['ghost'], 'admin-1')).toEqual({ revoked: 0 });
  });
});
