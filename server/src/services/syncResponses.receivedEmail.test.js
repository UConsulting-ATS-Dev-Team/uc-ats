// Form sync hands "we received your application" to applicationReceipts.js
// once its applications are filed, without waiting for the mail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getResponses } from './google/forms.js';
import { transformFormResponse } from '../utils/dataMapper.js';
import { resolveCandidateCycle } from './activeCycle.js';
import { sendApplicationReceipts } from './applicationReceipts.js';
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
vi.mock('./applicationReceipts.js', () => ({ sendApplicationReceipts: vi.fn(async () => ({})) }));
vi.mock('./luma/ingestGuests.js', () => ({ claimLumaGuestsForCandidate: vi.fn(async () => []) }));

const cycle = { id: 'cycle-1', name: 'Fall 2026', formUrl: 'https://docs.google.com/forms/d/form-1/edit', previousFormUrls: [] };
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  resolveCandidateCycle.mockResolvedValue(cycle);
  getResponses.mockResolvedValue([{ responseId: 'r-1' }, { responseId: 'r-2' }]);
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

describe('application received email from form sync', () => {
  it('sweeps the last week of the cycle once every application is filed', async () => {
    const before = Date.now();
    await syncFormResponses();

    expect(sendApplicationReceipts).toHaveBeenCalledTimes(1);
    const [{ cycle: sweptCycle, since }] = sendApplicationReceipts.mock.calls[0];
    expect(sweptCycle).toBe(cycle);
    expect(before - since.getTime()).toBeGreaterThanOrEqual(7 * DAY_MS - 1000);
    expect(before - since.getTime()).toBeLessThanOrEqual(7 * DAY_MS + 1000);

    const lastCreate = Math.max(...prisma.application.create.mock.invocationCallOrder);
    expect(lastCreate).toBeLessThan(sendApplicationReceipts.mock.invocationCallOrder[0]);
  });

  it('returns without waiting for the mail', async () => {
    sendApplicationReceipts.mockImplementation(() => new Promise(() => {}));

    await expect(syncFormResponses()).resolves.toBeUndefined();
  });

  it('a failed sweep does not fail the sync', async () => {
    sendApplicationReceipts.mockRejectedValue(new Error('database went away'));

    await expect(syncFormResponses()).resolves.toBeUndefined();
    expect(prisma.application.create).toHaveBeenCalledTimes(2);
  });
});
