import { describe, it, expect, vi, beforeEach } from 'vitest';

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  candidate: { findMany: vi.fn() },
  externalResume: { count: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../prismaClient.js', () => ({ default: prisma }));
vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const { resolveGoogleUser } = await import('./googleAuth.js');

const profile = { googleId: 'g-1', email: 'naina@g.ucla.edu', fullName: 'Naina D' };

describe('resolveGoogleUser and applicants', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.user.findMany.mockResolvedValue([]);
    prisma.externalResume.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops) => Promise.all(ops));
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'u-new', ...data }));
    prisma.user.update.mockImplementation(({ data }) => Promise.resolve({ id: 'u-1', ...data }));
  });

  it('gives a first-time applicant an applicant account with their UID', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.candidate.findMany.mockResolvedValue([{ studentId: '306917258' }]);

    const { user, isNewAccount } = await resolveGoogleUser(profile);

    expect(isNewAccount).toBe(true);
    expect(user.isExternalTalent).toBe(false);
    expect(user.studentId).toBe('306917258');
    const where = JSON.stringify(prisma.candidate.findMany.mock.calls[0][0].where);
    expect(where).toContain('naina@ucla.edu');
    expect(where).toContain('naina@g.ucla.edu');
  });

  it('still makes a talent account for someone who never applied', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.candidate.findMany.mockResolvedValue([]);

    const { user } = await resolveGoogleUser(profile);

    expect(user.isExternalTalent).toBe(true);
    expect(user.studentId).toBeUndefined();
  });

  it('makes a talent account when the UID already belongs to another account', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.studentId ? { id: 'someone-else' } : null));
    prisma.user.findMany.mockResolvedValue([]);
    prisma.candidate.findMany.mockResolvedValue([{ studentId: '306917258' }]);

    const { user } = await resolveGoogleUser(profile);

    expect(user.isExternalTalent).toBe(true);
  });

  it('turns an existing talent account into the applicant it belongs to', async () => {
    const talent = {
      id: 'u-1', email: 'naina@g.ucla.edu', role: 'USER', isActive: true,
      isExternalTalent: true, studentId: null, emailVerifiedAt: new Date(),
    };
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.googleId ? talent : null));
    prisma.candidate.findMany.mockResolvedValue([{ studentId: '306917258' }]);

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { isExternalTalent: false, studentId: '306917258' },
    });
    expect(user.isExternalTalent).toBe(false);
  });

  it('leaves a talent account alone when two candidates share the address', async () => {
    const talent = {
      id: 'u-1', email: 'naina@g.ucla.edu', role: 'USER', isActive: true,
      isExternalTalent: true, studentId: null, emailVerifiedAt: new Date(),
    };
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.googleId ? talent : null));
    prisma.candidate.findMany.mockResolvedValue([{ studentId: '1' }, { studentId: '2' }]);

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(user.isExternalTalent).toBe(true);
  });

  it('moves Google from an empty talent account onto the applicant account under the other UCLA spelling', async () => {
    const talent = {
      id: 'talent-1', email: 'buggy47@g.ucla.edu', role: 'USER', isActive: true,
      isExternalTalent: true, studentId: null, googleId: 'g-1', emailVerifiedAt: new Date(),
    };
    const applicant = {
      id: 'applicant-1', email: 'buggy47@ucla.edu', role: 'USER', isActive: true,
      isExternalTalent: false, studentId: '706875336', googleId: null, emailVerifiedAt: new Date(),
    };
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.googleId ? talent : null));
    prisma.user.findMany.mockResolvedValue([applicant]);
    prisma.user.update.mockImplementation(({ where, data }) =>
      Promise.resolve({ ...(where.id === applicant.id ? applicant : talent), ...data }));

    const { user } = await resolveGoogleUser({ ...profile, email: 'buggy47@g.ucla.edu' });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'talent-1' },
      data: { googleId: null, googleLinkedAt: null },
    });
    expect(user.id).toBe('applicant-1');
    expect(user.googleId).toBe('g-1');
    expect(JSON.stringify(prisma.user.findMany.mock.calls[0][0].where)).toContain('buggy47@ucla.edu');
  });

  it('links a first Google sign-in to the account under the other UCLA spelling instead of making a new one', async () => {
    const applicant = {
      id: 'applicant-1', email: 'buggy47@ucla.edu', role: 'USER', isActive: true,
      isExternalTalent: false, studentId: '706875336', googleId: null, emailVerifiedAt: new Date(),
    };
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockImplementation(({ where }) =>
      Promise.resolve(JSON.stringify(where).includes('buggy47@ucla.edu') ? [applicant] : []));
    prisma.user.update.mockImplementation(({ data }) => Promise.resolve({ ...applicant, ...data }));

    const { user, isNewAccount } = await resolveGoogleUser({ ...profile, email: 'buggy47@g.ucla.edu' });

    expect(isNewAccount).toBe(false);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(user.id).toBe('applicant-1');
  });

  describe('review fixes', () => {
    const talentFor = (email) => ({
      id: 'u-1', email, role: 'USER', isActive: true,
      isExternalTalent: true, studentId: null, googleId: 'g-1', emailVerifiedAt: new Date(),
    });

    it('ignores a stored address that is not the one Google verified', async () => {
      prisma.user.findUnique.mockImplementation(({ where }) =>
        Promise.resolve(where.googleId ? talentFor('victim@ucla.edu') : null));
      prisma.candidate.findMany.mockResolvedValue([{ studentId: '306917258' }]);

      const { user } = await resolveGoogleUser({ ...profile, email: 'attacker@g.ucla.edu' });

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(user.isExternalTalent).toBe(true);
    });

    it('leaves a talent account that holds a portal resume as it is', async () => {
      prisma.user.findUnique.mockImplementation(({ where }) =>
        Promise.resolve(where.googleId ? talentFor('naina@g.ucla.edu') : null));
      prisma.candidate.findMany.mockResolvedValue([{ studentId: '306917258' }]);
      prisma.externalResume.count.mockResolvedValue(1);

      const { user } = await resolveGoogleUser(profile);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(user.isExternalTalent).toBe(true);
    });

    it('matches applicants on the candidate address only, never an application address', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.candidate.findMany.mockResolvedValue([]);

      await resolveGoogleUser(profile);

      expect(JSON.stringify(prisma.candidate.findMany.mock.calls[0][0].where)).not.toContain('applications');
    });

    it('falls back to a talent account when the UID is taken between the check and the create', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.candidate.findMany.mockResolvedValue([{ studentId: '306917258' }]);
      prisma.user.create
        .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['studentId'] } }))
        .mockImplementationOnce(({ data }) => Promise.resolve({ id: 'u-new', ...data }));

      const { user } = await resolveGoogleUser(profile);

      expect(prisma.user.create).toHaveBeenCalledTimes(2);
      expect(user.isExternalTalent).toBe(true);
      expect(user.studentId).toBeUndefined();
    });

    it('moves Google between the two accounts in one transaction', async () => {
      const applicant = {
        id: 'applicant-1', email: 'naina@ucla.edu', role: 'USER', isActive: true,
        isExternalTalent: false, studentId: '306917258', googleId: null, emailVerifiedAt: new Date(),
      };
      prisma.user.findUnique.mockImplementation(({ where }) =>
        Promise.resolve(where.googleId ? talentFor('naina@g.ucla.edu') : null));
      prisma.user.findMany.mockResolvedValue([applicant]);
      prisma.user.update.mockImplementation(({ where, data }) =>
        Promise.resolve({ ...(where.id === applicant.id ? applicant : talentFor('naina@g.ucla.edu')), ...data }));

      const { user } = await resolveGoogleUser(profile);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
      expect(user.id).toBe('applicant-1');
    });
  });
});
