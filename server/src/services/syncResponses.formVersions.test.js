// A cycle whose application form was replaced mid-cycle keeps receiving
// applications from both versions: people who opened the old link before the
// switch still submit to it. Sync reads every version, and one it cannot open
// does not stop the rest.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getResponses } from './google/forms.js';
import { transformFormResponse } from '../utils/dataMapper.js';
import { resolveCandidateCycle } from './activeCycle.js';
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

const cycle = {
  id: 'cycle-1',
  name: 'Fall 2026',
  formUrl: 'https://docs.google.com/forms/d/new-form/edit',
  previousFormUrls: ['https://docs.google.com/forms/d/old-form/edit']
};

const responsesByForm = {
  'old-form': [{ responseId: 'old-1' }],
  'new-form': [{ responseId: 'new-1' }]
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  resolveCandidateCycle.mockResolvedValue(cycle);
  getResponses.mockImplementation(async (formId) => responsesByForm[formId] || []);
  transformFormResponse.mockImplementation((response) => ({
    responseID: response.responseId,
    studentId: `uid-${response.responseId}`,
    email: `${response.responseId}@ucla.edu`,
    firstName: 'A',
    lastName: response.responseId
  }));

  prisma.application.findMany.mockResolvedValue([]);
  prisma.application.create.mockImplementation(async ({ data }) => ({ id: `app-${data.responseID}` }));
  prisma.candidate.findUnique.mockResolvedValue(null);
  prisma.candidate.findFirst.mockResolvedValue(null);
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.create.mockImplementation(async ({ data }) => ({ id: `cand-${data.studentId}`, ...data }));
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

const createdResponseIds = () =>
  prisma.application.create.mock.calls.map(([args]) => args.data.responseID).sort();

describe('form sync across form versions', () => {
  it('files applications from the current form and every earlier version', async () => {
    await syncFormResponses();

    expect(getResponses.mock.calls.map(([id]) => id)).toEqual(['new-form', 'old-form']);
    expect(createdResponseIds()).toEqual(['new-1', 'old-1']);
  });

  it('keeps syncing the other versions when one cannot be read', async () => {
    getResponses.mockImplementation(async (formId) => {
      if (formId === 'new-form') throw new Error('The caller does not have permission');
      return responsesByForm[formId];
    });

    await syncFormResponses();

    expect(createdResponseIds()).toEqual(['old-1']);
  });

  it('leaves a response from a form with unmapped questions unsynced, to retry later', async () => {
    transformFormResponse.mockImplementation((response) => (
      response.responseId === 'new-1'
        ? { responseID: 'new-1' }
        : { responseID: response.responseId, studentId: 'uid-old', email: 'old@ucla.edu', firstName: 'A', lastName: 'B' }
    ));

    await syncFormResponses();

    expect(createdResponseIds()).toEqual(['old-1']);
    expect(prisma.candidate.create).toHaveBeenCalledTimes(1);
  });
});
