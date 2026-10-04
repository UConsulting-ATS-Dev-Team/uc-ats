import { describe, it, expect, vi, beforeEach } from 'vitest';

const prisma = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  externalResume: { findMany: vi.fn(), updateMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('../prismaClient.js', () => ({ default: prisma }));

const { decideMerge, findAccountForSignIn, mergeUclaTwinPair } = await import('./uclaTwinAccounts.js');

const applicant = (over = {}) => ({
  id: 'keep', email: 'james@ucla.edu', role: 'USER', isActive: true, isExternalTalent: false,
  studentId: '206887431', googleId: null, googleLinkedAt: null, emailVerifiedAt: new Date('2026-09-28'), ...over,
});
const talent = (over = {}) => ({
  id: 'retire', email: 'james@g.ucla.edu', role: 'USER', isActive: true, isExternalTalent: true,
  studentId: null, googleId: 'g-1', googleLinkedAt: new Date('2026-10-02'), emailVerifiedAt: new Date('2026-10-02'), ...over,
});
const resume = (id, userId, createdAt, isCurrent = true) => ({ id, userId, isCurrent, createdAt: new Date(createdAt) });

describe('decideMerge', () => {
  it('keeps the applicant account and moves Google and resumes off the talent account', () => {
    const d = decideMerge([talent(), applicant()], [resume('r1', 'retire', '2026-10-02')]);
    expect(d.ok).toBe(true);
    expect(d.keep.id).toBe('keep');
    expect(d.retire.id).toBe('retire');
    expect(d.moveResumeIds).toEqual(['r1']);
    expect(d.moveGoogle).toBe(true);
    expect(d.fillVerified).toBeNull();
  });

  it('keeps a member account over its talent twin', () => {
    const d = decideMerge([applicant({ role: 'MEMBER', studentId: null }), talent()]);
    expect(d.ok).toBe(true);
    expect(d.keep.role).toBe('MEMBER');
  });

  it('leaves only the newest resume current when both accounts have one', () => {
    const d = decideMerge([applicant(), talent()], [
      resume('old', 'keep', '2026-09-01'),
      resume('new', 'retire', '2026-10-01'),
      resume('history', 'retire', '2026-08-01', false),
    ]);
    expect(d.moveResumeIds).toEqual(['new', 'history']);
    expect(d.demoteResumeIds).toEqual(['old']);
  });

  it('carries the verified address over only when the keeper lacks one', () => {
    const verifiedAt = new Date('2026-10-02');
    expect(decideMerge([applicant({ emailVerifiedAt: null }), talent({ emailVerifiedAt: verifiedAt })]).fillVerified).toBe(verifiedAt);
    expect(decideMerge([applicant(), talent()]).fillVerified).toBeNull();
  });

  it('does not move Google when the talent account has none', () => {
    expect(decideMerge([applicant(), talent({ googleId: null })]).moveGoogle).toBe(false);
  });

  it.each([
    ['two real accounts', [applicant(), applicant({ id: 'other', email: 'james@g.ucla.edu' })], 'neither account is a talent account'],
    ['two talent accounts', [talent(), talent({ id: 'other', email: 'james@ucla.edu' })], 'both accounts are talent accounts'],
    ['a deactivated keeper', [applicant({ isActive: false }), talent()], 'the account to keep is deactivated'],
    ['a client keeper', [applicant({ role: 'CLIENT' }), talent()], 'the other account is a Talent Partner Network client'],
    ['different Google accounts', [applicant({ googleId: 'g-2' }), talent()], 'each account is linked to a different Google account'],
    ['different UIDs', [applicant(), talent({ studentId: '999' })], 'the accounts carry different UIDs'],
    ['three accounts', [applicant(), talent(), talent({ id: 'x' })], 'expected 2 accounts, found 3'],
    ['accounts whose addresses no longer match', [applicant({ email: 'someone@ucla.edu' }), talent()], 'the accounts no longer share a UCLA inbox'],
    ['a pair an earlier run merged', [applicant({ googleId: 'g-1' }), talent({ isActive: false, googleId: null })], 'already merged'],
  ])('refuses %s', (_name, users, reason) => {
    expect(decideMerge(users)).toEqual({ ok: false, reason });
  });
});

describe('findAccountForSignIn', () => {
  beforeEach(() => vi.resetAllMocks());

  it('answers with the typed address while it names an active account', async () => {
    prisma.user.findFirst.mockResolvedValue(talent());
    expect((await findAccountForSignIn('james@g.ucla.edu')).id).toBe('retire');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('falls through to the active twin when the typed address was retired by a merge', async () => {
    prisma.user.findFirst.mockResolvedValue(talent({ isActive: false }));
    prisma.user.findMany.mockResolvedValue([applicant()]);
    expect((await findAccountForSignIn('james@g.ucla.edu')).id).toBe('keep');
    expect(prisma.user.findMany.mock.calls[0][0].where.OR).toEqual([
      { email: { equals: 'james@ucla.edu', mode: 'insensitive' } },
    ]);
  });

  it('finds the account under the other spelling when the typed one has none', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([applicant()]);
    expect((await findAccountForSignIn('james@g.ucla.edu')).id).toBe('keep');
  });

  it('still returns a deactivated account when no active twin exists, so it says so', async () => {
    prisma.user.findFirst.mockResolvedValue(talent({ isActive: false }));
    prisma.user.findMany.mockResolvedValue([applicant({ isActive: false })]);
    expect((await findAccountForSignIn('james@g.ucla.edu')).id).toBe('retire');
  });

  it('never looks for a twin outside ucla.edu', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    expect(await findAccountForSignIn('james@gmail.com')).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('mergeUclaTwinPair', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$transaction.mockImplementation((work) => work(prisma));
    prisma.$queryRaw.mockResolvedValue([{ isExternalTalent: true, studentId: null }]);
  });

  it('moves resumes and Google, clearing googleId on the talent row before setting it on the keeper', async () => {
    prisma.user.findMany.mockResolvedValue([applicant(), talent()]);
    prisma.externalResume.findMany.mockResolvedValue([resume('r1', 'retire', '2026-10-02')]);

    const result = await mergeUclaTwinPair('keep', 'retire');

    expect(result.ok).toBe(true);
    expect(prisma.externalResume.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } }, data: { userId: 'keep' } });
    const [retireCall, keepCall] = prisma.user.update.mock.calls.map(([args]) => args);
    expect(retireCall.where.id).toBe('retire');
    expect(retireCall.data).toMatchObject({ isActive: false, googleId: null, googleLinkedAt: null });
    expect(keepCall).toMatchObject({ where: { id: 'keep' }, data: { googleId: 'g-1' } });
  });

  it('demotes the older current resume before moving, so the keeper never holds two current', async () => {
    prisma.user.findMany.mockResolvedValue([applicant(), talent()]);
    prisma.externalResume.findMany.mockResolvedValue([
      resume('old', 'keep', '2026-09-01'),
      resume('new', 'retire', '2026-10-01'),
    ]);

    await mergeUclaTwinPair('keep', 'retire');

    expect(prisma.externalResume.updateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: { in: ['old'] } }, data: { isCurrent: false } },
      { where: { id: { in: ['new'] } }, data: { userId: 'keep' } },
    ]);
  });

  it('writes nothing when the pair no longer qualifies under lock', async () => {
    prisma.user.findMany.mockResolvedValue([applicant({ googleId: 'g-2' }), talent()]);
    prisma.externalResume.findMany.mockResolvedValue([]);

    const result = await mergeUclaTwinPair('keep', 'retire');

    expect(result.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.externalResume.updateMany).not.toHaveBeenCalled();
  });
});
