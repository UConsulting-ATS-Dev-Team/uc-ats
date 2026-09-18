// The moment a pre-application referral stops being just a name.
//
// A member refers someone who has not applied; the referral sits unclaimed with
// a name key and no candidateId. When that person's application comes through
// form sync, the referral has to attach itself. That wiring is the whole point
// of the feature, so it is asserted here against the real claiming service
// rather than a mock of it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getResponses } from './google/forms.js';
import { transformFormResponse } from '../utils/dataMapper.js';
import { resolveCandidateCycle } from './activeCycle.js';
import syncFormResponses from './syncResponses.js';
import { referralNameKey } from './referrals.js';

vi.mock('../prismaClient.js', () => {
  const client = {
    application: { findMany: vi.fn(), create: vi.fn() },
    candidate: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    referral: { findMany: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn((fn) => fn(client))
  };
  return { default: client };
});
vi.mock('./google/forms.js', () => ({ getResponses: vi.fn() }));
vi.mock('../utils/dataMapper.js', () => ({ transformFormResponse: vi.fn() }));
vi.mock('./activeCycle.js', () => ({ resolveCandidateCycle: vi.fn() }));
vi.mock('../utils/formUtils.js', () => ({
  extractFormIdFromUrl: vi.fn(() => 'form-1')
}));

const activeCycle = { id: 'cycle-1', name: 'Fall 2026', formUrl: 'https://docs.google.com/forms/d/form-1/edit' };

const applicant = {
  studentId: '405123456',
  firstName: "Maria",
  lastName: "O'Brien",
  email: 'maria@ucla.edu'
};

const newCandidate = { id: 'cand-1', ...applicant };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  resolveCandidateCycle.mockResolvedValue(activeCycle);
  getResponses.mockResolvedValue([{ responseId: 'resp-1' }]);
  transformFormResponse.mockReturnValue({ ...applicant, responseID: 'resp-1' });

  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.create.mockResolvedValue({ id: 'app-1' });
  prisma.candidate.findFirst.mockResolvedValue(null);
  prisma.candidate.create.mockResolvedValue(newCandidate);
  // Only this applicant carries that name in the cycle, so claiming is safe.
  prisma.candidate.findMany.mockResolvedValue([newCandidate]);
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.referral.updateMany.mockResolvedValue({ count: 1 });
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('form sync claims pre-application referrals', () => {
  it('attaches a referral left by name to the candidate the application created', async () => {
    prisma.referral.findMany.mockResolvedValue([{ id: 'ref-1' }]);

    await syncFormResponses();

    // Looked for unclaimed referrals under this applicant's normalized name.
    expect(prisma.referral.findMany).toHaveBeenCalledWith({
      where: {
        candidateId: null,
        referredNameKey: referralNameKey('Maria', "O'Brien"),
        OR: [{ cycleId: activeCycle.id }, { cycleId: null }]
      },
      select: { id: true }
    });

    const { where, data } = prisma.referral.updateMany.mock.calls[0][0];
    // Still conditional on being unclaimed, so an admin's own match survives.
    expect(where).toEqual({ id: { in: ['ref-1'] }, candidateId: null });
    expect(data.candidateId).toBe('cand-1');
    expect(data.cycleId).toBe(activeCycle.id);
    expect(data.claimedAt).toBeInstanceOf(Date);

    // And the application still got written.
    expect(prisma.application.create).toHaveBeenCalled();
  });

  it('claims for an applicant who already had a candidate record', async () => {
    const existing = { id: 'cand-existing', ...applicant };
    prisma.candidate.findFirst.mockResolvedValue(existing);
    prisma.candidate.findMany.mockResolvedValue([existing]);
    prisma.referral.findMany.mockResolvedValue([{ id: 'ref-2' }]);

    await syncFormResponses();

    expect(prisma.referral.updateMany.mock.calls[0][0].data.candidateId).toBe('cand-existing');
  });

  it('holds back when a second applicant in the cycle has the same name', async () => {
    prisma.candidate.findMany.mockResolvedValue([
      newCandidate,
      { id: 'cand-twin', firstName: 'Maria', lastName: 'OBrien' }
    ]);
    prisma.referral.findMany.mockResolvedValue([{ id: 'ref-4' }]);

    await syncFormResponses();

    // Better a referral an admin has to place than one silently placed wrong.
    expect(prisma.referral.updateMany).not.toHaveBeenCalled();
    expect(prisma.application.create).toHaveBeenCalled();
  });

  it('writes nothing when nobody referred this applicant', async () => {
    await syncFormResponses();

    expect(prisma.referral.findMany).toHaveBeenCalled();
    expect(prisma.referral.updateMany).not.toHaveBeenCalled();
    expect(prisma.application.create).toHaveBeenCalled();
  });

  it('claims nothing when the application itself failed to save', async () => {
    prisma.referral.findMany.mockResolvedValue([{ id: 'ref-3' }]);
    prisma.application.create.mockRejectedValue(new Error('Argument `phoneNumber` is missing.'));

    await syncFormResponses();

    // Otherwise a referral would record that someone applied while no
    // application exists to show for it.
    expect(prisma.referral.updateMany).not.toHaveBeenCalled();
  });

  it('still records the application when claiming blows up', async () => {
    prisma.candidate.findMany.mockRejectedValue(new Error('referrals lookup is on fire'));

    await syncFormResponses();

    // The referral is a nice-to-have; losing the application is not acceptable.
    expect(prisma.application.create).toHaveBeenCalled();
  });
});
