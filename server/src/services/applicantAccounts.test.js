import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  candidate: { findMany: vi.fn(), findUnique: vi.fn() },
  application: { findMany: vi.fn() },
  externalResume: { count: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('../prismaClient.js', () => ({ default: prisma }));
vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const {
  resolveApplicantForEmail,
  adoptApplicantAccount,
  linkTalentAccountToUid,
  claimUid,
  confirmUidCode,
  planTalentAccountLinks,
  normalizeUid,
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

// What the hand-over transaction reads under its locks: the talent account's
// row, then the candidate row and its applications. Defaults to `onFile`.
let onFile;
const givenOnFile = (candidate) => {
  onFile = candidate;
};

const hash = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

beforeEach(() => {
  vi.resetAllMocks();
  givenOnFile(applicant());
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.findUnique.mockResolvedValue(null);
  prisma.externalResume.count.mockResolvedValue(0);
  prisma.$queryRaw.mockImplementation((strings) => {
    const sql = strings.join('');
    if (sql.includes('FROM candidates')) {
      return Promise.resolve(onFile ? [{ id: 'cand-1', email: onFile.email }] : []);
    }
    return Promise.resolve([{ isExternalTalent: true, studentId: null }]);
  });
  prisma.application.findMany.mockImplementation(() => Promise.resolve(onFile?.applications ?? []));
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

describe('linkTalentAccountToUid', () => {
  it('re-reads the addresses under the UID with the candidate row locked', async () => {
    const user = await linkTalentAccountToUid('u-1', UID, { addressKey: 'candidate' });

    expect(user).toMatchObject({ isExternalTalent: false, studentId: UID, claimedStudentId: null });
    const candidateLock = prisma.$queryRaw.mock.calls.map(([s]) => s.join('')).find((sql) => sql.includes('candidates'));
    expect(candidateLock).toContain('FOR UPDATE');
  });

  it('stops when an application from another address arrived after the proof', async () => {
    givenOnFile(applicant('diya@g.ucla.edu', ['diya@g.ucla.edu', 'someone@gmail.com']));
    expect(await linkTalentAccountToUid('u-1', UID, { addressKey: 'candidate' })).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('links without an address check only when no proof is named (an admin linking by hand)', async () => {
    givenOnFile(null);
    expect(await linkTalentAccountToUid('u-1', UID)).toMatchObject({ studentId: UID });
  });
});

describe('adoptApplicantAccount (password sign-in and email verification)', () => {
  it('turns a verified talent account into its applicant account', async () => {
    prisma.candidate.findMany.mockResolvedValue([applicant('diyaanne9@gmail.com')]);
    givenOnFile(applicant('diyaanne9@gmail.com'));
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

  it('signs the person in as they were when the link fails', async () => {
    prisma.candidate.findMany.mockRejectedValue(new Error('database down'));
    const account = talent();
    expect(await adoptApplicantAccount(account)).toBe(account);
  });
});

describe('claimUid (the UID typed on the talent profile)', () => {
  const sendCode = vi.fn();
  beforeEach(() => {
    sendCode.mockReset();
    sendCode.mockResolvedValue({ success: true });
  });

  it('refuses anything that is not nine digits without using up the try', async () => {
    expect(await claimUid(talent(), '12345', { sendCode })).toEqual({ status: 'INVALID' });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(normalizeUid('306-917-258')).toBe(UID);
  });

  it('sends a code to the address the applicant applied from, and never says which', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diya@g.ucla.edu'));

    const result = await claimUid(talent(), UID, { sendCode });

    expect(result).toEqual({ status: 'CODE_SENT' });
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
    givenOnFile(applicant('diyaanne9@gmail.com'));

    const result = await claimUid(talent(), UID, { sendCode });

    expect(result.status).toBe('LINKED');
    expect(result.user).toMatchObject({ isExternalTalent: false, studentId: UID });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('says another account holds the UID without naming it', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'other' });
    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'TAKEN' });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('sends nothing when the applications under the UID came from different addresses', async () => {
    prisma.candidate.findUnique.mockResolvedValue(applicant('diya@g.ucla.edu', ['diya@g.ucla.edu', 'someone@gmail.com']));
    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'NEEDS_ADMIN' });
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('keeps the UID for later when nobody has applied under it', async () => {
    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'SAVED' });
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ claimedStudentId: UID });
  });

  it('allows one try a minute, whatever the answer, taken in one conditional write', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    expect(await claimUid(talent(), UID, { sendCode })).toEqual({ status: 'TOO_SOON' });

    const { where } = prisma.user.updateMany.mock.calls[0][0];
    expect(where.id).toBe('u-1');
    expect(where.OR).toHaveLength(2);
    expect(prisma.candidate.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
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

  it('spends an attempt before checking the guess, only while some are left', async () => {
    prisma.user.findUnique.mockResolvedValue(pending({ uidCodeAttempts: 3 }));

    expect(await confirmUidCode('u-1', '00000000')).toEqual({ status: 'WRONG', attemptsLeft: 1 });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u-1', uidCodeHash: hash('u-1', '12345678'), uidCodeAttempts: { lt: 5 } },
      data: { uidCodeAttempts: { increment: 1 } },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses even the right code when a parallel guess spent the last attempt', async () => {
    prisma.user.findUnique.mockResolvedValue(pending({ uidCodeAttempts: 4 }));
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    expect(await confirmUidCode('u-1', '12345678')).toEqual({ status: 'EXPIRED' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses even the right code once it has expired', async () => {
    prisma.user.findUnique.mockResolvedValue(pending({ uidCodeExpiresAt: new Date(Date.now() - 1) }));
    expect(await confirmUidCode('u-1', '12345678')).toEqual({ status: 'EXPIRED' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses the right code when an application from another address arrived after it was sent', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(where.studentId ? null : pending()));
    givenOnFile(applicant('diya@g.ucla.edu', ['diya@g.ucla.edu', 'someone@gmail.com']));

    expect(await confirmUidCode('u-1', '12345678')).toEqual({ status: 'NEEDS_ADMIN' });
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
