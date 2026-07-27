import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../prismaClient.js', () => {
  const p = {
    applicationFeedbackJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  p.$transaction = vi.fn((callback) => callback(p));
  return { default: p };
});

vi.mock('./emailNotifications.js', () => ({
  sendApplicantFeedbackRequest: vi.fn(),
}));

import prisma from '../prismaClient.js';
import { sendApplicantFeedbackRequest } from './emailNotifications.js';
import {
  scheduleFeedbackRequest,
  cancelPendingFeedbackRequest,
  handleApplicationStatusChange,
  processFeedbackJobs,
  getFeedbackJobs,
  retryFeedbackJob,
  JOB_STATUS,
  FEEDBACK_JOB_TYPE,
} from './feedbackScheduler.js';

const FEEDBACK_DELAY_MS = 48 * 60 * 60 * 1000;

function applicationFixture(overrides = {}) {
  return {
    id: 'app-1',
    status: 'ACCEPTED',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    ...overrides,
  };
}

function cycleFixture(overrides = {}) {
  return {
    id: 'cycle-1',
    name: 'Fall 2026',
    feedbackFormUrl: 'https://forms.example.com/feedback',
    ...overrides,
  };
}

function jobFixture(overrides = {}) {
  return {
    id: 'job-1',
    type: FEEDBACK_JOB_TYPE,
    status: JOB_STATUS.PENDING,
    dueAt: new Date('2026-07-25T10:00:00.000Z'),
    attempts: 0,
    application: applicationFixture(),
    cycle: cycleFixture(),
    ...overrides,
  };
}

describe('scheduleFeedbackRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a PENDING feedback job due 48 hours after decisionSentAt for ACCEPTED', async () => {
    const application = applicationFixture({ status: 'ACCEPTED' });
    const cycle = cycleFixture();
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');
    prisma.applicationFeedbackJob.create.mockResolvedValue({ id: 'job-1' });

    await scheduleFeedbackRequest(application, cycle, decisionSentAt);

    expect(prisma.applicationFeedbackJob.create).toHaveBeenCalledTimes(1);
    const data = prisma.applicationFeedbackJob.create.mock.calls[0][0].data;
    expect(data.applicationId).toBe('app-1');
    expect(data.cycleId).toBe('cycle-1');
    expect(data.type).toBe(FEEDBACK_JOB_TYPE);
    expect(data.status).toBe(JOB_STATUS.PENDING);
    expect(data.feedbackFormUrl).toBe(cycle.feedbackFormUrl);
    expect(data.dueAt.getTime()).toBe(decisionSentAt.getTime() + FEEDBACK_DELAY_MS);
    expect(data.decisionSentAt.getTime()).toBe(decisionSentAt.getTime());
  });

  it('creates a PENDING feedback job for REJECTED', async () => {
    const application = applicationFixture({ status: 'REJECTED' });
    const cycle = cycleFixture();
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');
    prisma.applicationFeedbackJob.create.mockResolvedValue({ id: 'job-2' });

    await scheduleFeedbackRequest(application, cycle, decisionSentAt);

    expect(prisma.applicationFeedbackJob.create).toHaveBeenCalledTimes(1);
    expect(prisma.applicationFeedbackJob.create.mock.calls[0][0].data.status).toBe(JOB_STATUS.PENDING);
  });

  it('cancels pending jobs and returns null when status is not final', async () => {
    const application = applicationFixture({ status: 'UNDER_REVIEW' });
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });

    const result = await scheduleFeedbackRequest(application, cycleFixture(), new Date());

    expect(result).toBeNull();
    expect(prisma.applicationFeedbackJob.updateMany).toHaveBeenCalledWith({
      where: {
        applicationId: 'app-1',
        type: FEEDBACK_JOB_TYPE,
        status: { in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING, JOB_STATUS.FAILED] },
      },
      data: { status: JOB_STATUS.CANCELLED, lastError: null },
    });
  });

  it('returns the existing job when the same decisionSend is scheduled twice', async () => {
    const application = applicationFixture();
    const cycle = cycleFixture();
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');
    const existing = { id: 'job-3' };

    prisma.applicationFeedbackJob.create
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockRejectedValueOnce({ code: 'P2002' });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue(existing);

    const first = await scheduleFeedbackRequest(application, cycle, decisionSentAt);
    const second = await scheduleFeedbackRequest(application, cycle, decisionSentAt);

    expect(prisma.applicationFeedbackJob.create).toHaveBeenCalledTimes(2);
    expect(second).toBe(existing);
    expect(first).toBe(existing);
  });
});

describe('handleApplicationStatusChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels pending jobs when status changes away from final', async () => {
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });
    await handleApplicationStatusChange('app-1', 'WAITLISTED');
    expect(prisma.applicationFeedbackJob.updateMany).toHaveBeenCalledWith({
      where: {
        applicationId: 'app-1',
        type: FEEDBACK_JOB_TYPE,
        status: { in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING, JOB_STATUS.FAILED] },
      },
      data: { status: JOB_STATUS.CANCELLED, lastError: null },
    });
  });

  it('does nothing for final statuses', async () => {
    await handleApplicationStatusChange('app-1', 'ACCEPTED');
    expect(prisma.applicationFeedbackJob.updateMany).not.toHaveBeenCalled();
  });
});

describe('processFeedbackJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes overdue PENDING jobs and sends the feedback email', async () => {
    const job = jobFixture();
    prisma.applicationFeedbackJob.findMany.mockResolvedValue([job]);
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue(job);
    sendApplicantFeedbackRequest.mockResolvedValue({ success: true, messageId: 'msg-1' });

    const results = await processFeedbackJobs();

    expect(prisma.applicationFeedbackJob.findMany).toHaveBeenCalledWith({
      where: { status: JOB_STATUS.PENDING, dueAt: { lte: new Date('2026-07-28T10:00:00.000Z') } },
      orderBy: { dueAt: 'asc' },
      include: { application: true, cycle: true },
    });
    expect(prisma.applicationFeedbackJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JOB_STATUS.PENDING },
      data: { status: JOB_STATUS.PROCESSING, attempts: { increment: 1 } },
    });
    expect(sendApplicantFeedbackRequest).toHaveBeenCalledWith(
      'jane@example.com',
      'Jane Doe',
      'Fall 2026',
      'https://forms.example.com/feedback'
    );
    expect(prisma.applicationFeedbackJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: JOB_STATUS.SENT, sentAt: new Date('2026-07-28T10:00:00.000Z'), lastError: null },
    });
    expect(results).toEqual([{ id: 'job-1', action: 'sent', messageId: 'msg-1' }]);
  });

  it('skips a job already claimed by another worker instance', async () => {
    const job = jobFixture();
    prisma.applicationFeedbackJob.findMany.mockResolvedValue([job]);
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 0 });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(prisma.applicationFeedbackJob.update).not.toHaveBeenCalled();
    expect(results).toEqual([{ id: 'job-1', action: 'skipped', reason: 'already claimed or no longer pending' }]);
  });

  it('records a FAILED job when the feedback form URL is missing', async () => {
    const job = jobFixture({ cycle: cycleFixture({ feedbackFormUrl: null }) });
    prisma.applicationFeedbackJob.findMany.mockResolvedValue([job]);
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue(job);

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(prisma.applicationFeedbackJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: JOB_STATUS.FAILED, lastError: 'Feedback form URL is not configured for this cycle' },
    });
    expect(results[0].action).toBe('failed');
  });

  it('records a FAILED job when the applicant email is invalid', async () => {
    const job = jobFixture({ application: applicationFixture({ email: 'not-an-email' }) });
    prisma.applicationFeedbackJob.findMany.mockResolvedValue([job]);
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue(job);

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results[0].action).toBe('failed');
    expect(results[0].error).toMatch(/Invalid or missing applicant email/);
  });

  it('records a FAILED job and does not crash when the provider fails', async () => {
    const job = jobFixture();
    prisma.applicationFeedbackJob.findMany.mockResolvedValue([job]);
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue(job);
    sendApplicantFeedbackRequest.mockResolvedValue({ success: false, error: 'SES timeout' });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).toHaveBeenCalled();
    expect(prisma.applicationFeedbackJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: JOB_STATUS.FAILED, lastError: 'SES timeout' },
    });
    expect(results[0].action).toBe('failed');
  });

  it('processes only jobs whose dueAt has passed', async () => {
    vi.setSystemTime(new Date('2026-07-24T10:00:00.000Z'));
    const job = jobFixture({ dueAt: new Date('2026-07-25T10:00:00.000Z') });
    prisma.applicationFeedbackJob.findMany.mockResolvedValue([]);

    await processFeedbackJobs();

    const where = prisma.applicationFeedbackJob.findMany.mock.calls[0][0].where;
    expect(where.dueAt.lte.getTime()).toBe(new Date('2026-07-24T10:00:00.000Z').getTime());
    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
  });
});

describe('getFeedbackJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated jobs filtered by cycle and status', async () => {
    const jobs = [{ id: 'job-1' }];
    prisma.applicationFeedbackJob.findMany.mockResolvedValue(jobs);
    prisma.applicationFeedbackJob.count.mockResolvedValue(1);

    const result = await getFeedbackJobs({ cycleId: 'cycle-1', status: 'PENDING', page: 1, limit: 10 });

    expect(prisma.applicationFeedbackJob.findMany).toHaveBeenCalledWith({
      where: { type: FEEDBACK_JOB_TYPE, cycleId: 'cycle-1', status: 'PENDING' },
      orderBy: { dueAt: 'asc' },
      skip: 0,
      take: 10,
      include: {
        application: { select: { id: true, firstName: true, lastName: true, email: true, status: true } },
        cycle: { select: { id: true, name: true, feedbackFormUrl: true } },
      },
    });
    expect(result).toEqual({ jobs, total: 1, page: 1, limit: 10, totalPages: 1 });
  });
});

describe('retryFeedbackJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets a FAILED job to PENDING with dueAt now', async () => {
    const job = { id: 'job-1', type: FEEDBACK_JOB_TYPE, status: JOB_STATUS.FAILED };
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue(job);

    const result = await retryFeedbackJob('job-1');

    expect(prisma.applicationFeedbackJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        type: FEEDBACK_JOB_TYPE,
        status: { in: [JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.PENDING] },
      },
      data: { status: JOB_STATUS.PENDING, dueAt: new Date('2026-07-28T10:00:00.000Z'), lastError: null },
    });
    expect(result).toBe(job);
  });

  it('throws when retrying a SENT job', async () => {
    prisma.applicationFeedbackJob.updateMany.mockResolvedValue({ count: 0 });
    prisma.applicationFeedbackJob.findUnique.mockResolvedValue({ id: 'job-1', status: JOB_STATUS.SENT });

    await expect(retryFeedbackJob('job-1')).rejects.toThrow(/Cannot retry job in status SENT/);
  });
});
