import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  candidate: { findMany: vi.fn(), findUnique: vi.fn() },
  externalResume: { count: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('../prismaClient.js', () => ({ default: prisma }));
vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const {
  resolveApplicantForEmail,
  adoptApplicantAccount,
  claimUid,
  confirmUidCode,
  planTalentAccountLinks,
  normalizeUid,
  maskEmail,
  UID_CODE_TTL_MS,
} = await import('./applicantAccounts.js');

const UID = '306917258';

const talent = (overrides = {}) => ({
  id: 'u-1', email: 'diyaanne9@gmail.com', fullName: 'Diya Anne', role: 'USER', isActive: true,
  isExternalTalent: true, studentId: null, emailVerifiedAt: new Date(), ...overrides,
});

// An applicant whose record and applications are all under `email`.
const applicant = (email = 'diya@g.ucla.edu', applicationEmails = [email]) => ({
  studentId: UID, email, firstName: 'Diya', lastName: 'Anne',
  applications: applicationEmails.map((address) => ({ email: address })),
});

const hash = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

beforeEach(() => {
  vi.resetAllMocks();
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.findUnique.mockResolvedValue(null);
  prisma.externalResume.count.mockResolvedValue(0);
  prisma.$queryRaw.mockResolvedValue([{ isExternalTalent: true, studentId: null }]);
  prisma.$transaction.mockImplementation((work) => work(prisma));
});

describe('resolveApplicantForEmail', () => {
  it('hands over the UID when every address under it is this one, in either UCLA spelling', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant('diya@ucla.edu', ['diya@g.ucla.edu'])]);
    expect(await resolveApplicantForEmail('diya@g.ucla.edu')).toEqual({ studentId: UID });
  });

  it('says why when an application under the UID came from another address', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant('diya@g.ucla.edu', ['diya@g.ucla.edu', 'x@gmail.com'])]);
    expect(await resolveApplicantForEmail('diya@g.ucla.edu')).toMatchObject({ reason: 'ADDRESS_MISMATCH', uid: UID });
  });

  it('names the account already holding the UID', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant()]);
    prisma.user.findUnique.mockResolvedValue({ id: 'other', email: 'diya@g.ucla.edu' });
    expect(await resolveApplicantForEmail('diya@g.ucla.edu')).toMatchObject({ reason: 'UID_HELD', holder: { id: 'other' } });
  });
});

describe('adoptApplicantAccount (password sign-in and email verification)', () => {
  it('turns a verified talent account into its applicant account', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant('diyaanne9@gmail.com')]);
    const user = await adoptApplicantAccount(talent());
    expect(user).toMatchObject({ isExternalTalent: false, studentId: UID });
  });

  it('leaves an unverified account alone: its stored address proves nothing', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant('diyaanne9@gmail.com')]);
    const account = talent({ emailVerifiedAt: null });
    expect(await adoptApplicantAccount(account)).toBe(account);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('leaves an account holding a talent-portal resume alone, checked under the lock', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant('diyaanne9@gmail.com')]);
    prisma.externalResume.count.mockResolvedValue(1);
    const account = talent();
    expect(await adoptApplicantAccount(account)).toBe(account);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('never touches a candidate or staff account', async () => {
    const candidate = talent({ isExternalTalent: false, studentId: UID });
    expect(await adoptApplicantAccount(candidate)).toBe(candidate);
    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
  });
});

describe('claimUid (the UID typed on the talent profile)', () => {
  const sendCode = vi.fn();
  beforeEach(() => {
    sendCode.mockReset();
    sendCode.mockResolvedValue({ success: true });
  });

  it('refuses anything that is not nine digits, and accepts one typed with dashes', async () => {
    expect(await claimUid(talent(), '12345', { sendCode })).toEqual({ status: 'INVALID' });
    expect(normalizeUid('306-917-258')).toBe(UID);
  });

  it('sends a code to the address the applicant applied from, never to the account', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diya@g.ucla.edu'));

    const result = await claimUid(talent(), UID, { sendCode });

    expect(result).toEqual({ status: 'CODE_SENT', sentTo: 'd***@g.ucla.edu' });
    expect(sendCode).toHaveBeenCalledWith(expect.objectContaining({ to: 'diya@g.ucla.edu' }));
    const { code } = sendCode.mock.calls[0][0];
    expect(code).toMatch(/^\d{8}$/);
    // Stored as a claim with a hash of the code; studentId is untouched.
    const { data } = prisma.user.update.mock.calls[0][0];
    expect(data).toMatchObject({ claimedStudentId: UID, uidCodeHash: hash('u-1', code), uidCodeAttempts: 0 });
    expect(data).not.toHaveProperty('studentId');
  });

  it('links at once when the account already verified the address the applicant used', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diyaanne9@gmail.com'));

    const result = await claimUid(talent(), UID, { sendCode });

    expect(result.status).toBe('LINKED');
    expect(result.user).toMatchObject({ isExternalTalent: false, studentId: UID });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('points to the existing account when another one holds the UID', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'other', email: 'diya@g.ucla.edu' });
    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'TAKEN', sentTo: 'd***@g.ucla.edu' });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('sends nothing when the applications under the UID came from different addresses', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diya@g.ucla.edu', ['diya@g.ucla.edu', 'someone@gmail.com']));
    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'NEEDS_ADMIN' });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('keeps the UID for later when nobody has applied under it', async () => {
    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'SAVED' });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ claimedStudentId: UID, uidCodeHash: null });
  });

  it('holds back a second code within a minute', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diya@g.ucla.edu'));
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.id ? { uidCodeExpiresAt: new Date(Date.now() + UID_CODE_TTL_MS - 10_000) } : null));

    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'TOO_SOON' });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('clears the code when the email could not be sent, so a retry is not held back', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diya@g.ucla.edu'));
    sendCode.mockResolvedValue({ success: false });

    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'SEND_FAILED' });
    expect(prisma.user.update.mock.calls.at(-1)[0].data).toMatchObject({ uidCodeHash: null, uidCodeExpiresAt: null });
  });
});

describe('confirmUidCode', () => {
  const pending = (overrides = {}) => ({
    claimedStudentId: UID, uidCodeHash: hash('u-1', '12345678'),
    uidCodeExpiresAt: new Date(Date.now() + 60_000), uidCodeAttempts: 0, ...overrides,
  });

  it('links the account and clears the code when it matches', async () => {
    prisma.user.findUnique.mockResolvedValue(pending());

    const result = await confirmUidCode('u-1', '1234 5678');

    expect(result.status).toBe('LINKED');
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      isExternalTalent: false, studentId: UID, claimedStudentId: null, uidCodeHash: null,
    });
  });

  it('counts a wrong code against this code only', async () => {
    prisma.user.findUnique.mockResolvedValue(pending({ uidCodeAttempts: 3 }));

    expect(await confirmUidCode('u-1', '00000000')).toEqual({ status: 'WRONG', attemptsLeft: 1 });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u-1', uidCodeHash: hash('u-1', '12345678') },
      data: { uidCodeAttempts: { increment: 1 } },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses even the right code once it has expired or run out of tries', async () => {
    prisma.user.findUnique.mockResolvedValue(pending({ uidCodeExpiresAt: new Date(Date.now() - 1) }));
    expect(await confirmUidCode('u-1', '12345678')).toEqual({ status: 'EXPIRED' });

    prisma.user.findUnique.mockResolvedValue(pending({ uidCodeAttempts: 5 }));
    expect(await confirmUidCode('u-1', '12345678')).toEqual({ status: 'EXPIRED' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('reports TAKEN when another account got the UID before the code was entered', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.studentId ? { id: 'other' } : pending()));
    prisma.$transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    expect(await confirmUidCode('u-1', '12345678')).toEqual({ status: 'TAKEN' });
  });
});

describe('planTalentAccountLinks (the sweep)', () => {
  it('links the safe ones and only hints at a same-name applicant under another address', async () => {
    prisma.user.findMany.mockResolvedValue([
      talent({ id: 'safe', email: 'sam@g.ucla.edu', fullName: 'Sam Lee', _count: { externalResumes: 0 } }),
      talent({ _count: { externalResumes: 0 } }),
    ]);
    prisma.candidate.findMany.mockImplementation(({ where }) => {
      if (!where) return Promise.resolve([
        { studentId: UID, firstName: 'Diya', lastName: 'Anne', email: 'diya@g.ucla.edu' },
      ]);
      const asked = JSON.stringify(where);
      return Promise.resolve(asked.includes('sam@') ? [{ ...applicant('sam@g.ucla.edu'), studentId: '111111111' }] : []);
    });

    const plan = await planTalentAccountLinks();

    expect(plan[0].decision).toEqual({ link: '111111111' });
    expect(plan[1].decision).toEqual({ reason: 'NO_APPLICANT' });
    expect(plan[1].nameMatches).toEqual([expect.objectContaining({ studentId: UID })]);
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('diyaanne9@gmail.com')).toBe('d***@gmail.com');
  });
});
