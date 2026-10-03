// One application per candidate per cycle. Someone who submits the form a
// second time (a replaced form, or the same one twice) is folded into the
// application they already have instead of becoming a second Staging row.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getResponses } from './google/forms.js';
import { transformFormResponse } from '../utils/dataMapper.js';
import { resolveCandidateCycle } from './activeCycle.js';
import { sendApplicationReceipts } from './applicationReceipts.js';
import { claimLumaGuestsForCandidate } from './luma/ingestGuests.js';
import syncFormResponses from './syncResponses.js';

vi.mock('../prismaClient.js', () => {
  const client = {
    application: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    candidate: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn()
    },
    resumeUpload: { count: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
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
const candidate = { id: 'cand-1', studentId: '123456789', email: 'maria@ucla.edu', firstName: 'Maria', lastName: 'Lopez', recordsLockedAt: null };

const response = (responseId, createTime) => ({ responseId, createTime });

// An in-memory applications table the mocked client reads and writes, so a
// create early in a run is visible to a lookup later in the same run.
let applications;

const existingApp = (overrides = {}) => ({
  id: 'app-1',
  responseID: 'old-1',
  supersededResponseIds: [],
  submittedAt: new Date('2026-09-20T10:00:00Z'),
  resumeUrl: '/api/files/old-resume/pdf',
  candidateId: candidate.id,
  cycleId: cycle.id,
  status: 'SUBMITTED',
  currentRound: '1',
  approved: null,
  resumeDecision: null,
  coffeeChatDecision: null,
  firstRoundDecision: null,
  finalRoundDecision: null,
  ...overrides
});

const matches = (row, where) => Object.entries(where).every(([key, value]) => {
  if (key === 'NOT' || key === 'AND') return true;
  return row[key] === value;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  applications = [];
  resolveCandidateCycle.mockResolvedValue(cycle);
  transformFormResponse.mockImplementation((r) => ({
    responseID: r.responseId,
    submittedAt: new Date(r.createTime),
    rawResponses: {},
    studentId: candidate.studentId,
    email: candidate.email,
    firstName: 'Maria',
    lastName: 'Lopez',
    resumeUrl: `/api/files/resume-${r.responseId}/pdf`
  }));

  prisma.application.findMany.mockImplementation(async ({ where } = {}) =>
    applications.filter((row) => !where || matches(row, where)).map((row) => ({ ...row })));
  prisma.application.create.mockImplementation(async ({ data }) => {
    const row = { id: `app-${data.responseID}`, supersededResponseIds: [], status: 'SUBMITTED', approved: null, ...data };
    applications.push(row);
    return row;
  });
  prisma.application.updateMany.mockImplementation(async ({ where, data }) => {
    const row = applications.find((r) => r.id === where.id && (!where.responseID || r.responseID === where.responseID));
    if (!row) return { count: 0 };
    const { supersededResponseIds, ...rest } = data;
    Object.assign(row, rest);
    if (Array.isArray(supersededResponseIds)) row.supersededResponseIds = supersededResponseIds;
    else if (supersededResponseIds?.push) row.supersededResponseIds = [...row.supersededResponseIds, supersededResponseIds.push];
    return { count: 1 };
  });
  prisma.candidate.findUnique.mockImplementation(async ({ where }) =>
    (where.studentId === candidate.studentId || where.email === candidate.email ? { ...candidate } : null));
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.resumeUpload.count.mockResolvedValue(0);
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('form sync with a resubmission', () => {
  it('replaces the answers on the existing application instead of creating a second one', async () => {
    applications.push(existingApp());
    getResponses.mockResolvedValue([response('new-1', '2026-09-25T10:00:00Z')]);

    await syncFormResponses();

    expect(prisma.application.create).not.toHaveBeenCalled();
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      id: 'app-1',
      responseID: 'new-1',
      resumeUrl: '/api/files/resume-new-1/pdf',
      supersededResponseIds: ['old-1']
    });
  });

  it('does not count a resubmission as a newly filed application for the receipt sweep', async () => {
    applications.push(existingApp());
    getResponses.mockResolvedValue([response('new-1', '2026-09-25T10:00:00Z')]);

    await syncFormResponses();

    expect(sendApplicationReceipts).toHaveBeenCalledTimes(1);
    expect(sendApplicationReceipts.mock.calls[0][0].responseIDs).toEqual([]);
    // The claims ran for the first submission; there is nothing new to claim.
    expect(claimLumaGuestsForCandidate).not.toHaveBeenCalled();
    expect(prisma.referral.findMany).not.toHaveBeenCalled();
  });

  it('only records a resubmission once review has started', async () => {
    applications.push(existingApp({ resumeDecision: 'yes' }));
    getResponses.mockResolvedValue([response('new-1', '2026-09-25T10:00:00Z')]);

    await syncFormResponses();

    expect(prisma.application.create).not.toHaveBeenCalled();
    expect(applications[0]).toMatchObject({
      responseID: 'old-1',
      resumeUrl: '/api/files/old-resume/pdf',
      supersededResponseIds: ['new-1']
    });
  });

  it('never processes a response some application already superseded', async () => {
    applications.push(existingApp({ supersededResponseIds: ['new-1'] }));
    getResponses.mockResolvedValue([response('new-1', '2026-09-25T10:00:00Z')]);

    await syncFormResponses();

    expect(transformFormResponse).not.toHaveBeenCalled();
    expect(prisma.application.create).not.toHaveBeenCalled();
    expect(prisma.application.updateMany).not.toHaveBeenCalled();
  });

  it('folds two unseen submissions from one person in submit-time order', async () => {
    // Handed back newest first, as two form versions read one after the other can.
    getResponses.mockResolvedValue([
      response('second', '2026-09-25T10:00:00Z'),
      response('first', '2026-09-20T10:00:00Z')
    ]);

    await syncFormResponses();

    expect(prisma.application.create).toHaveBeenCalledTimes(1);
    expect(prisma.application.create.mock.calls[0][0].data.responseID).toBe('first');
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({ responseID: 'second', supersededResponseIds: ['first'] });
    expect(prisma.application.create.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.application.updateMany.mock.invocationCallOrder[0]);
  });

  it('still creates a first-time applicant exactly as before', async () => {
    getResponses.mockResolvedValue([response('only-1', '2026-09-20T10:00:00Z')]);

    await syncFormResponses();

    expect(prisma.application.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.application.create.mock.calls[0][0];
    expect(data).toMatchObject({ responseID: 'only-1', candidateId: candidate.id, cycleId: cycle.id, currentRound: '1' });
    expect(data).not.toHaveProperty('supersededResponseIds');
    expect(prisma.application.updateMany).not.toHaveBeenCalled();
    expect(sendApplicationReceipts.mock.calls[0][0].responseIDs).toEqual(['only-1']);
    expect(claimLumaGuestsForCandidate).toHaveBeenCalledTimes(1);
  });
});
