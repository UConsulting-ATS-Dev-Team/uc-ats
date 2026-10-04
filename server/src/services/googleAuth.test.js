import { describe, it, expect, vi, beforeEach } from 'vitest';

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  candidate: { findMany: vi.fn() },
  externalResume: { count: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('../prismaClient.js', () => ({ default: prisma }));
vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const { resolveGoogleUser } = await import('./googleAuth.js');

const profile = { googleId: 'g-1', email: 'naina@g.ucla.edu', fullName: 'Naina D' };
const UID = '306917258';

// A candidate whose address and applications are all this person's.
const candidate = (email = 'naina@ucla.edu', applicationEmails = [email]) => ({
  studentId: UID, email, applications: applicationEmails.map((address) => ({ email: address })),
});

const talentFor = (email = 'naina@g.ucla.edu') => ({
  id: 'u-1', email, role: 'USER', isActive: true,
  isExternalTalent: true, studentId: null, googleId: 'g-1', emailVerifiedAt: new Date(),
});

const applicantAccount = (email = 'naina@ucla.edu') => ({
  id: 'applicant-1', email, role: 'USER', isActive: true,
  isExternalTalent: false, studentId: UID, googleId: null, emailVerifiedAt: new Date(),
});

// Stands in for Postgres: writes inside a failed transaction are undone.
function withRollback() {
  prisma.$transaction.mockImplementation(async (work) => {
    const writes = [];
    const tx = {
      ...prisma,
      user: {
        ...prisma.user,
        update: (args) => { writes.push(['update', args]); return prisma.user.update(args); },
        updateMany: (args) => { writes.push(['updateMany', args]); return prisma.user.updateMany(args); },
      },
    };
    try {
      return await work(tx);
    } catch (error) {
      writes.length = 0;
      throw error;
    } finally {
      prisma.committedWrites = writes;
    }
  });
}

describe('resolveGoogleUser and applicants', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.committedWrites = [];
    prisma.user.findMany.mockResolvedValue([]);
    prisma.candidate.findMany.mockResolvedValue([]);
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'u-new', ...data }));
    prisma.user.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.externalResume.count.mockResolvedValue(0);
    prisma.$queryRaw.mockResolvedValue([{ isExternalTalent: true, studentId: null }]);
    withRollback();
  });

  it('gives a first-time applicant an applicant account with their UID', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.candidate.findMany.mockResolvedValue([candidate()]);

    const { user, isNewAccount } = await resolveGoogleUser(profile);

    expect(isNewAccount).toBe(true);
    expect(user.isExternalTalent).toBe(false);
    expect(user.studentId).toBe(UID);
    const where = JSON.stringify(prisma.candidate.findMany.mock.calls[0][0].where);
    expect(where).toContain('naina@ucla.edu');
    expect(where).toContain('naina@g.ucla.edu');
    expect(where).not.toContain('applications');
  });

  it('still makes a talent account for someone who never applied', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const { user } = await resolveGoogleUser(profile);

    expect(user.isExternalTalent).toBe(true);
    expect(user.studentId).toBeUndefined();
  });

  it('withholds the UID when an application under it carries someone else\'s address', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.candidate.findMany.mockResolvedValue([candidate('naina@ucla.edu', ['naina@ucla.edu', 'owner@ucla.edu'])]);

    const { user } = await resolveGoogleUser(profile);

    expect(user.isExternalTalent).toBe(true);
    expect(user.studentId).toBeUndefined();
  });

  it('withholds the UID from a candidate with no application', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.candidate.findMany.mockResolvedValue([candidate('naina@ucla.edu', [])]);

    const { user } = await resolveGoogleUser(profile);

    expect(user.isExternalTalent).toBe(true);
  });

  it('makes a talent account when the UID already belongs to another account', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.studentId ? { id: 'someone-else' } : null));
    prisma.candidate.findMany.mockResolvedValue([candidate()]);

    const { user } = await resolveGoogleUser(profile);

    expect(user.isExternalTalent).toBe(true);
  });

  it('falls back to a talent account when the UID is taken between the check and the create', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.candidate.findMany.mockResolvedValue([candidate()]);
    prisma.user.create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['studentId'] } }))
      .mockImplementationOnce(({ data }) => Promise.resolve({ id: 'u-new', ...data }));

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.user.create).toHaveBeenCalledTimes(2);
    expect(user.isExternalTalent).toBe(true);
    expect(user.studentId).toBeUndefined();
  });

  it('turns an existing talent account into the applicant it belongs to, under a row lock', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(where.googleId ? talentFor() : null));
    prisma.candidate.findMany.mockResolvedValue([candidate()]);

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { isExternalTalent: false, studentId: UID },
    });
    expect(user.isExternalTalent).toBe(false);
  });

  it('leaves a talent account alone when two candidates share the address', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(where.googleId ? talentFor() : null));
    prisma.candidate.findMany.mockResolvedValue([candidate(), { ...candidate(), studentId: '2' }]);

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(user.isExternalTalent).toBe(true);
  });

  it('ignores a stored address that is not the one Google verified', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.googleId ? talentFor('victim@ucla.edu') : null));
    prisma.candidate.findMany.mockResolvedValue([candidate('attacker@ucla.edu')]);

    const { user } = await resolveGoogleUser({ ...profile, email: 'attacker@g.ucla.edu' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(user.isExternalTalent).toBe(true);
  });

  it('leaves a talent account that holds a portal resume, checked under the lock', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(where.googleId ? talentFor() : null));
    prisma.candidate.findMany.mockResolvedValue([candidate()]);
    prisma.externalResume.count.mockResolvedValue(1);

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(user.isExternalTalent).toBe(true);
  });

  it('moves Google from an empty talent account onto the account under the other UCLA spelling', async () => {
    const applicant = applicantAccount();
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.googleId) return Promise.resolve(talentFor());
      if (where.id === applicant.id) return Promise.resolve({ ...applicant, googleId: 'g-1' });
      return Promise.resolve(null);
    });
    prisma.user.findMany.mockResolvedValue([applicant]);

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { googleId: null, googleLinkedAt: null },
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'applicant-1', googleId: null },
    }));
    expect(prisma.committedWrites).toHaveLength(2);
    expect(user.id).toBe('applicant-1');
    expect(user.googleId).toBe('g-1');
    expect(JSON.stringify(prisma.user.findMany.mock.calls[0][0].where)).toContain('naina@ucla.edu');
  });

  it('rolls the move back when the other account was linked first, leaving Google where it was', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(where.googleId ? talentFor() : null));
    prisma.user.findMany.mockResolvedValue([applicantAccount()]);
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    const { user } = await resolveGoogleUser(profile);

    expect(prisma.committedWrites).toHaveLength(0);
    expect(user.id).toBe('u-1');
  });

  it('links a first Google sign-in to the account under the other UCLA spelling instead of making a new one', async () => {
    const applicant = applicantAccount();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockImplementation(({ where }) =>
      Promise.resolve(JSON.stringify(where).includes('naina@ucla.edu') ? [applicant] : []));

    const { user, isNewAccount } = await resolveGoogleUser(profile);

    expect(isNewAccount).toBe(false);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(user.id).toBe('applicant-1');
  });
});
