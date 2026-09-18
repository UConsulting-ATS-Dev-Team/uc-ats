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

vi.mock('../prismaClient.js', () => ({
  default: {
    application: { findMany: vi.fn(), create: vi.fn() },
    candidate: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    referral: { findMany: vi.fn(), updateMany: vi.fn() }
  }
}));
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
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.referral.updateMany.mockResolvedValue({ count: 0 });
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
    expect(where).toEqual({ id: { in: ['ref-1'] } });
    expect(data.candidateId).toBe('cand-1');
    expect(data.cycleId).toBe(activeCycle.id);
    expect(data.claimedAt).toBeInstanceOf(Date);

    // And the application still got written.
    expect(prisma.application.create).toHaveBeenCalled();
  });

  it('claims for an applicant who already had a candidate record', async () => {
    prisma.candidate.findFirst.mockResolvedValue({ id: 'cand-existing', ...applicant });
    prisma.referral.findMany.mockResolvedValue([{ id: 'ref-2' }]);

    await syncFormResponses();

    expect(prisma.referral.updateMany.mock.calls[0][0].data.candidateId).toBe('cand-existing');
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
    prisma.referral.findMany.mockRejectedValue(new Error('referrals table is on fire'));

    await syncFormResponses();

    // The referral is a nice-to-have; losing the application is not acceptable.
    expect(prisma.application.create).toHaveBeenCalled();
  });
});
