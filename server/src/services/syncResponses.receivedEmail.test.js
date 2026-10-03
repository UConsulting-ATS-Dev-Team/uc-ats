// Every application form sync files gets a "we received your application"
// email, sent once the application is actually on file.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getResponses } from './google/forms.js';
import { transformFormResponse } from '../utils/dataMapper.js';
import { resolveCandidateCycle } from './activeCycle.js';
import { sendApplicationReceivedEmail } from './emailNotifications.js';
import syncFormResponses from './syncResponses.js';

vi.mock('../prismaClient.js', () => {
  const client = {
    application: { findMany: vi.fn(), create: vi.fn() },
    candidate: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn()
    },
    referral: { findMany: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn((fn) => fn(client))
  };
  return { default: client };
});
vi.mock('./google/forms.js', () => ({ getResponses: vi.fn() }));
vi.mock('../utils/dataMapper.js', () => ({ transformFormResponse: vi.fn() }));
vi.mock('./activeCycle.js', () => ({ resolveCandidateCycle: vi.fn() }));
vi.mock('./emailNotifications.js', () => ({ sendApplicationReceivedEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('./luma/ingestGuests.js', () => ({ claimLumaGuestsForCandidate: vi.fn(async () => []) }));

const cycle = { id: 'cycle-1', name: 'Fall 2026', formUrl: 'https://docs.google.com/forms/d/form-1/edit', previousFormUrls: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  resolveCandidateCycle.mockResolvedValue(cycle);
  getResponses.mockResolvedValue([{ responseId: 'r-1' }]);
  transformFormResponse.mockImplementation((response) => ({
    responseID: response.responseId,
    studentId: '123456789',
    email: ' Maria@ucla.edu ',
    firstName: 'Maria',
    lastName: 'Lopez'
  }));

  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.create.mockImplementation(async ({ data }) => ({ id: `app-${data.responseID}` }));
  prisma.candidate.findUnique.mockResolvedValue(null);
  prisma.candidate.findFirst.mockResolvedValue(null);
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.create.mockImplementation(async ({ data }) => ({ id: 'cand-1', ...data }));
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('application received email', () => {
  it('emails the address on the form once the application is saved', async () => {
    await syncFormResponses();

    expect(sendApplicationReceivedEmail).toHaveBeenCalledTimes(1);
    expect(sendApplicationReceivedEmail).toHaveBeenCalledWith(
      'Maria@ucla.edu', 'Maria Lopez', 'Fall 2026', { cycleId: 'cycle-1' }
    );
    expect(prisma.application.create.mock.invocationCallOrder[0])
      .toBeLessThan(sendApplicationReceivedEmail.mock.invocationCallOrder[0]);
  });

  it('sends nothing when the application fails to save', async () => {
    prisma.application.create.mockRejectedValue(new Error('Unique constraint failed on responseID'));

    await syncFormResponses();

    expect(sendApplicationReceivedEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for a response already on file', async () => {
    prisma.application.findMany.mockResolvedValue([{ responseID: 'r-1' }]);

    await syncFormResponses();

    expect(sendApplicationReceivedEmail).not.toHaveBeenCalled();
  });
});
