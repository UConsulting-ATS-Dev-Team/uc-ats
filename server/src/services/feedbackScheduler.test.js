import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import config from '../config.js';

vi.mock('../prismaClient.js', () => {
  function uid(prefix = 'id') {
    return `${prefix}-${++state.idCounter}`;
  }

  function datesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return new Date(a).getTime() === new Date(b).getTime();
  }

  function matches(record, where) {
    if (!where) return true;

    for (const [key, value] of Object.entries(where)) {
      if (key === 'OR') {
        if (!value.some((cond) => matches(record, cond))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!value.every((cond) => matches(record, cond))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (matches(record, value)) return false;
        continue;
      }
      if (key === 'applicationId_type_decisionSentAt') {
        const w = value;
        if (
          record.applicationId !== w.applicationId ||
          record.type !== w.type ||
          !datesEqual(record.decisionSentAt, w.decisionSentAt)
        ) {
          return false;
        }
        continue;
      }
      if (key === 'id') {
        if (typeof value === 'string' && record.id !== value) return false;
        if (value?.in && !value.in.includes(record.id)) return false;
        continue;
      }
      if (key === 'jobId') {
        if (typeof value === 'string' && record.jobId !== value) return false;
        if (value?.in && !value.in.includes(record.jobId)) return false;
        continue;
      }
      if (key === 'status') {
        if (value?.in && !value.in.includes(record.status)) return false;
        if (!value?.in && record.status !== value) return false;
        continue;
      }
      if (key === 'dueAt' && value?.lte !== undefined) {
        const rec = record.dueAt ? new Date(record.dueAt).getTime() : null;
        if (rec === null || rec > new Date(value.lte).getTime()) return false;
        continue;
      }
      if (key === 'claimedAt') {
        if (value === null && record.claimedAt !== null) return false;
        if (value?.lte !== undefined) {
          const rec = record.claimedAt ? new Date(record.claimedAt).getTime() : -Infinity;
          if (rec > new Date(value.lte).getTime()) return false;
        }
        continue;
      }
      if (key === 'decisionSentAt' && value?.lte !== undefined) {
        const rec = record.decisionSentAt ? new Date(record.decisionSentAt).getTime() : null;
        if (rec === null || rec > new Date(value.lte).getTime()) return false;
        continue;
      }
      if (key === 'attemptedAt' && value?.lte !== undefined) {
        const rec = record.attemptedAt ? new Date(record.attemptedAt).getTime() : null;
        if (rec === null || rec > new Date(value.lte).getTime()) return false;
        continue;
      }
      if (record[key] !== value) return false;
    }

    return true;
  }

  function applyData(record, data) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        record[key] = (record[key] || 0) + value.increment;
      } else if (['dueAt', 'sentAt', 'decisionSentAt', 'claimedAt', 'attemptedAt', 'createdAt', 'updatedAt'].includes(key)) {
        record[key] = value ? new Date(value) : null;
      } else {
        record[key] = value;
      }
    }
    if ('updatedAt' in record) record.updatedAt = new Date();
  }

  function applyInclude(record, include) {
    if (!include) return record;
    const copy = { ...record };
    if (include.application) copy.application = state.applications.find((a) => a.id === record.applicationId) || null;
    if (include.cycle) copy.cycle = state.cycles.find((c) => c.id === record.cycleId) || null;
    if (include.deliveryAttempts) {
      copy.deliveryAttempts = state.attempts
        .filter((a) => a.jobId === record.id)
        .sort((a, b) => new Date(b.attemptedAt).getTime() - new Date(a.attemptedAt).getTime());
    }
    if (include.job) copy.job = state.jobs.find((j) => j.id === record.jobId) || null;
    return copy;
  }

  function queryStore(store, { where, orderBy, skip, take, include, select } = {}) {
    let result = store.filter((r) => matches(r, where));
    if (orderBy) {
      const [key, dir] = Object.entries(orderBy)[0];
      result = result.slice().sort((a, b) => {
        const av = a[key] ? new Date(a[key]).getTime() : (dir === 'asc' ? -Infinity : Infinity);
        const bv = b[key] ? new Date(b[key]).getTime() : (dir === 'asc' ? -Infinity : Infinity);
        return dir === 'asc' ? av - bv : bv - av;
      });
    }
    if (skip) result = result.slice(skip);
    if (take !== undefined) result = result.slice(0, take);
    return result.map((r) => applyInclude(r, include));
  }

  function createStoreMethods(store, { defaults = {}, uniqueKeys = [] } = {}) {
    return {
      create: vi.fn(async ({ data }) => {
        for (const keys of uniqueKeys) {
          if (keys.every((k) => data[k] !== undefined) && store.some((r) => keys.every((k) => {
            const a = r[k];
            const b = data[k];
            if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
            return a === b;
          }))) {
            const error = new Error('Unique constraint failed');
            error.code = 'P2002';
            error.meta = { target: keys };
            throw error;
          }
        }

        const record = {
          id: data.id || uid(store === state.jobs ? 'job' : store === state.attempts ? 'attempt' : 'record'),
          ...defaults,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        if (record.decisionSentAt) record.decisionSentAt = new Date(record.decisionSentAt);
        if (record.dueAt) record.dueAt = new Date(record.dueAt);
        if (record.sentAt) record.sentAt = new Date(record.sentAt);
        if (record.claimedAt) record.claimedAt = new Date(record.claimedAt);
        if (record.attemptedAt) record.attemptedAt = new Date(record.attemptedAt);
        store.push(record);
        return { ...record };
      }),
      findUnique: vi.fn(async ({ where, include }) => {
        let record;
        if (where.id) {
          record = store.find((r) => r.id === where.id);
        } else if (where.feedbackToken) {
          record = store.find((r) => r.feedbackToken === where.feedbackToken);
        } else if (where.applicationId_type_decisionSentAt) {
          record = store.find((r) => matches(r, where));
        }
        return record ? applyInclude(record, include) : null;
      }),
      findMany: vi.fn(async (args = {}) => queryStore(store, args)),
      findFirst: vi.fn(async (args = {}) => queryStore(store, args)[0] || null),
      count: vi.fn(async ({ where } = {}) => store.filter((r) => matches(r, where)).length),
      update: vi.fn(async ({ where, data, include }) => {
        const record = store.find((r) => r.id === where.id);
        if (!record) throw new Error('Record not found');
        applyData(record, data);
        return applyInclude(record, include);
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const matchesArr = store.filter((r) => matches(r, where));
        matchesArr.forEach((r) => applyData(r, data));
        return { count: matchesArr.length };
      }),
      deleteMany: vi.fn(async ({ where } = {}) => {
        const before = store.length;
        const remaining = store.filter((r) => !matches(r, where));
        store.length = 0;
        store.push(...remaining);
        return { count: before - store.length };
      }),
    };
  }

  const state = {
    idCounter: 0,
    jobs: [],
    attempts: [],
    applications: [],
    cycles: [],
    feedbackResponses: [],
    reset: () => {
      state.idCounter = 0;
      state.jobs.length = 0;
      state.attempts.length = 0;
      state.applications.length = 0;
      state.cycles.length = 0;
      state.feedbackResponses.length = 0;
    },
  };

  const p = {
    __state: state,
    applicationFeedbackJob: createStoreMethods(state.jobs, {
      uniqueKeys: [['applicationId', 'type', 'decisionSentAt'], ['feedbackToken']],
    }),
    applicationFeedbackDeliveryAttempt: createStoreMethods(state.attempts),
    application: createStoreMethods(state.applications),
    recruitingCycle: createStoreMethods(state.cycles),
    feedbackResponse: createStoreMethods(state.feedbackResponses),
  };

  p.$transaction = vi.fn((arg) => {
    if (Array.isArray(arg)) return Promise.all(arg.map((promise) => Promise.resolve(promise)));
    return Promise.resolve(arg(p));
  });

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
  reconcileFeedbackJob,
  JOB_STATUS,
  ATTEMPT_STATUS,
  FEEDBACK_JOB_TYPE,
} from './feedbackScheduler.js';

const FEEDBACK_DELAY_MS = 48 * 60 * 60 * 1000;

function resetState() {
  prisma.__state.reset();
  vi.clearAllMocks();
  process.env.BASE_URL = 'http://localhost:3001';
  config.clientUrl = 'http://localhost:3001';
}

function applicationFixture(overrides = {}) {
  return {
    status: 'REJECTED',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    decisionSentAt: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides,
  };
}

function cycleFixture(overrides = {}) {
  return {
    name: 'Fall 2026',
    feedbackEnabled: true,
    feedbackPrivacyPolicy: 'Responses are confidential and retained for 12 months for recruiting improvement.',
    feedbackRetentionDays: 365,
    ...overrides,
  };
}

async function seedApplication(overrides = {}) {
  return prisma.application.create({ data: applicationFixture(overrides) });
}

async function seedCycle(overrides = {}) {
  return prisma.recruitingCycle.create({ data: cycleFixture(overrides) });
}

async function seedJob(overrides = {}) {
  const app = overrides.application || (await seedApplication());
  const cycle = overrides.cycle || (await seedCycle());
  const decisionSentAt = overrides.decisionSentAt || new Date('2026-07-27T10:00:00.000Z');
  const feedbackToken = overrides.feedbackToken || randomUUID();
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
  const feedbackFormUrl = overrides.feedbackFormUrl || `${baseUrl}/feedback/${feedbackToken}`;
  return prisma.applicationFeedbackJob.create({
    data: {
      applicationId: app.id,
      cycleId: cycle.id,
      type: FEEDBACK_JOB_TYPE,
      status: JOB_STATUS.PENDING,
      dueAt: new Date(decisionSentAt.getTime() + FEEDBACK_DELAY_MS),
      decisionSentAt,
      feedbackToken,
      feedbackFormUrl,
      feedbackPrompt: cycle?.feedbackPrompt ?? null,
      feedbackQuestions: cycle?.feedbackQuestions ?? null,
      ...overrides,
    },
  });
}

describe('scheduleFeedbackRequest', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a PENDING feedback job due 48 hours after decisionSentAt for REJECTED', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle();
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');

    const job = await scheduleFeedbackRequest(app, cycle, decisionSentAt);

    expect(job.status).toBe(JOB_STATUS.PENDING);
    expect(job.applicationId).toBe(app.id);
    expect(job.feedbackToken).toBeTruthy();
    expect(job.feedbackFormUrl).toMatch(/^http:\/\/localhost:3001\/feedback\/.+/);
    expect(job.dueAt.getTime()).toBe(decisionSentAt.getTime() + FEEDBACK_DELAY_MS);
    expect(prisma.__state.jobs).toHaveLength(1);
  });

  it('builds the candidate feedback link from config.clientUrl with /feedback/:token', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle();
    config.clientUrl = 'http://localhost:5173';

    const job = await scheduleFeedbackRequest(app, cycle, new Date());

    expect(job.feedbackFormUrl).toMatch(/^http:\/\/localhost:5173\/feedback\/.+/);
  });

  it('creates a PENDING feedback job for REJECTED', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle();

    const job = await scheduleFeedbackRequest(app, cycle, new Date());

    expect(job.status).toBe(JOB_STATUS.PENDING);
  });

  it('creates a FAILED job when the generated feedback URL is invalid', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    config.clientUrl = 'ftp://invalid';

    const job = await scheduleFeedbackRequest(app, cycle, new Date());

    expect(job.status).toBe(JOB_STATUS.FAILED);
    expect(job.lastError).toMatch(/missing or not allowed/);
  });

  it('cancels pending jobs and returns null for non-final status', async () => {
    const app = await seedApplication({ status: 'UNDER_REVIEW' });
    const existing = await seedJob({ applicationId: app.id, status: JOB_STATUS.PENDING });

    const result = await scheduleFeedbackRequest(app, await seedCycle(), new Date());

    expect(result).toBeNull();
    const cancelled = prisma.__state.jobs.find((j) => j.id === existing.id);
    expect(cancelled.status).toBe(JOB_STATUS.CANCELLED);
  });

  it('returns the existing job when the same decisionSend is scheduled twice', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');

    const first = await scheduleFeedbackRequest(app, cycle, decisionSentAt);
    const second = await scheduleFeedbackRequest(app, cycle, decisionSentAt);

    expect(prisma.__state.jobs).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('uses the cycle cadence to compute dueAt', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle({ feedbackCadenceHours: 24 });
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');

    const job = await scheduleFeedbackRequest(app, cycle, decisionSentAt);

    expect(job.status).toBe(JOB_STATUS.PENDING);
    expect(job.dueAt.getTime()).toBe(decisionSentAt.getTime() + 24 * 60 * 60 * 1000);
  });

  it('clamps an overdue dueAt to the current time', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle({ feedbackCadenceHours: 24 });
    const decisionSentAt = new Date('2026-07-25T10:00:00.000Z');

    const job = await scheduleFeedbackRequest(app, cycle, decisionSentAt);
    const now = new Date();

    expect(job.status).toBe(JOB_STATUS.PENDING);
    expect(job.dueAt.getTime()).toBe(now.getTime());
  });

  it('does not schedule a job when feedback is disabled for the cycle', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle({ feedbackEnabled: false });

    const result = await scheduleFeedbackRequest(app, cycle, new Date());

    expect(result).toBeNull();
    expect(prisma.__state.jobs).toHaveLength(0);
  });
});

describe('handleApplicationStatusChange', () => {
  beforeEach(() => {
    resetState();
  });

  it('cancels pending jobs and clears decisionSentAt when status changes away from final', async () => {
    const decisionSentAt = new Date('2026-07-27T10:00:00.000Z');
    const app = await seedApplication({ status: 'WAITLISTED', decisionSentAt });
    const job = await seedJob({ applicationId: app.id, status: JOB_STATUS.PENDING });
    await prisma.applicationFeedbackDeliveryAttempt.create({
      data: { jobId: job.id, status: ATTEMPT_STATUS.PENDING, feedbackFormUrl: job.feedbackFormUrl },
    });

    await handleApplicationStatusChange(app.id, 'WAITLISTED');

    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.CANCELLED);
    expect(updated.claimToken).toBeNull();
    const attempt = prisma.__state.attempts.find((a) => a.jobId === job.id);
    expect(attempt.status).toBe(ATTEMPT_STATUS.CANCELLED);
    const updatedApp = prisma.__state.applications.find((a) => a.id === app.id);
    expect(updatedApp.decisionSentAt).toBeNull();
  });

  it('does nothing for rejected status', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    await seedJob({ applicationId: app.id });
    await handleApplicationStatusChange(app.id, 'REJECTED');
    expect(prisma.__state.jobs[0].status).toBe(JOB_STATUS.PENDING);
  });
});

describe('processFeedbackJobs', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    sendApplicantFeedbackRequest.mockResolvedValue({ success: true, messageId: 'msg-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes overdue PENDING jobs and sends the feedback email', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).toHaveBeenCalledWith(
      'jane@example.com',
      'Jane Doe',
      'Fall 2026',
      job.feedbackFormUrl,
      expect.any(String)
    );
    expect(results[0].action).toBe('sent');
    expect(results[0].messageId).toBe('msg-1');

    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.SENT);
    expect(updated.messageId).toBe('msg-1');

    const attempts = prisma.__state.attempts.filter((a) => a.jobId === job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(ATTEMPT_STATUS.SENT);
    expect(attempts[0].messageId).toBe('msg-1');
    expect(attempts[0].feedbackFormUrl).toBe(job.feedbackFormUrl);
  });

  it('uses the immutable feedbackFormUrl snapshot even if the cycle config changes', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      dueAt: new Date('2026-07-26T10:00:00.000Z'),
      feedbackFormUrl: 'https://snapshot.example.com/feedback',
    });

    // Change the cycle config after scheduling.
    await prisma.recruitingCycle.update({
      where: { id: cycle.id },
      data: { feedbackFormUrl: 'https://new.example.com/feedback' },
    });

    await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).toHaveBeenCalledWith(
      'jane@example.com',
      'Jane Doe',
      'Fall 2026',
      'https://snapshot.example.com/feedback',
      expect.any(String)
    );

    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.SENT);
  });

  it('records a FAILED job when the applicant email is invalid', async () => {
    const app = await seedApplication({ email: 'not-an-email' });
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results[0].action).toBe('failed');
    expect(results[0].error).toMatch(/Invalid or missing applicant email/);

    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.FAILED);
    const attempts = prisma.__state.attempts.filter((a) => a.jobId === job.id);
    expect(attempts[0].status).toBe(ATTEMPT_STATUS.FAILED);
  });

  it('records a FAILED job when the provider fails', async () => {
    sendApplicantFeedbackRequest.mockResolvedValue({ success: false, error: 'SES timeout' });
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).toHaveBeenCalled();
    expect(results[0].action).toBe('failed');
    expect(results[0].error).toBe('SES timeout');

    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.FAILED);
    expect(updated.lastError).toBe('SES timeout');
  });

  it('cancels the send when the application status is reversed before the send boundary', async () => {
    const app = await seedApplication({ status: 'WAITLISTED' });
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results[0].action).toBe('cancelled');
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.CANCELLED);
    expect(updated.lastError).toMatch(/eligibility changed/);
  });

  it('reconciles a PROCESSING job with a SENT delivery attempt without resending', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      dueAt: new Date('2026-07-26T10:00:00.000Z'),
      status: JOB_STATUS.PROCESSING,
      claimToken: 'token-1',
      claimedAt: new Date('2026-07-25T10:00:00.000Z'),
    });
    await prisma.applicationFeedbackDeliveryAttempt.create({
      data: {
        jobId: job.id,
        claimToken: 'token-1',
        status: ATTEMPT_STATUS.SENT,
        messageId: 'msg-2',
        attemptedAt: new Date('2026-07-25T10:01:00.000Z'),
        feedbackFormUrl: job.feedbackFormUrl,
      },
    });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.SENT);
    expect(updated.messageId).toBe('msg-2');
  });

  it('resets a stale PROCESSING job without a SENT attempt back to PENDING', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      dueAt: new Date('2026-07-26T10:00:00.000Z'),
      status: JOB_STATUS.PROCESSING,
      claimToken: 'token-1',
      claimedAt: new Date('2026-07-25T10:00:00.000Z'),
    });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).toHaveBeenCalled();
    expect(results[0].action).toBe('sent');
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.SENT);
  });

  it('reconciles a SENT delivery attempt when the job SENT state write fails after provider success', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const originalUpdateMany = prisma.applicationFeedbackJob.updateMany;
    prisma.applicationFeedbackJob.updateMany = vi.fn(async (args) => {
      if (args?.data?.status === JOB_STATUS.SENT) {
        throw new Error('Simulated job SENT state write failure');
      }
      return originalUpdateMany(args);
    });

    const first = await processFeedbackJobs();
    expect(first[0].action).toBe('sent');
    expect(first[0].note).toMatch(/delivery attempt persisted|reconcil/i);

    // Restore and run reconciliation; the durable SENT attempt should keep the email from being retried.
    prisma.applicationFeedbackJob.updateMany = originalUpdateMany;
    const second = await processFeedbackJobs();
    expect(second).toEqual([]);

    expect(sendApplicantFeedbackRequest).toHaveBeenCalledTimes(1);
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.SENT);
    expect(updated.messageId).toBe('msg-1');
  });

  it('marks provider-success-before-delivery-attempt-state-write as UNKNOWN and does not resend', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const originalUpdateMany = prisma.applicationFeedbackDeliveryAttempt.updateMany;
    prisma.applicationFeedbackDeliveryAttempt.updateMany = vi.fn(async (args) => {
      if (args?.data?.status === ATTEMPT_STATUS.SENT) {
        throw new Error('Simulated delivery attempt SENT write failure');
      }
      return originalUpdateMany(args);
    });

    const first = await processFeedbackJobs();
    expect(first[0].action).toBe('unknown');
    expect(first[0].note).toMatch(/operator reconciliation/);

    // Restore and run the worker again; the UNKNOWN outcome should not trigger another provider call.
    prisma.applicationFeedbackDeliveryAttempt.updateMany = originalUpdateMany;
    const second = await processFeedbackJobs();
    expect(second).toEqual([]);

    expect(sendApplicantFeedbackRequest).toHaveBeenCalledTimes(1);
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.UNKNOWN);
    expect(updated.lastError).toMatch(/Post-send state write failed/);
    const attempts = prisma.__state.attempts.filter((a) => a.jobId === job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(ATTEMPT_STATUS.UNKNOWN);
  });

  it('cancels the send when the application status is reversed at the delivery boundary', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle();
    // The job is due, but the applicant status flips before the SENDING intent is written.
    prisma.__state.applications.find((a) => a.id === app.id).status = 'WAITLISTED';
    await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results[0].action).toBe('cancelled');
    expect(results[0].reason).toMatch(/eligibility changed/);
  });

  it('cancels the send when the application status is reversed after the SENDING intent is written but before the provider call', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, dueAt: new Date('2026-07-26T10:00:00.000Z') });

    let findUniqueCalls = 0;
    const originalFindUnique = prisma.application.findUnique;
    prisma.application.findUnique = vi.fn(async (args) => {
      const record = prisma.__state.applications.find((a) => a.id === args.where.id);
      if (!record) return record;
      findUniqueCalls += 1;
      // The first read (inside prepareSend) sees REJECTED; the second read (the
      // post-prepareSend eligibility check) simulates a concurrent status reversal.
      if (findUniqueCalls >= 2) {
        record.status = 'WAITLISTED';
      }
      return { ...record };
    });

    const results = await processFeedbackJobs();
    prisma.application.findUnique = originalFindUnique;

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results[0].action).toBe('cancelled');
    expect(results[0].reason).toMatch(/eligibility changed.*at send boundary/);
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.CANCELLED);
  });

  it('does not falsely reconcile a pre-provider crash as SENT and requires operator reconciliation', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      dueAt: new Date('2026-07-26T10:00:00.000Z'),
      status: JOB_STATUS.PROCESSING,
      claimToken: 'pre-provider-crash-token',
      claimedAt: new Date('2026-07-25T10:00:00.000Z'),
    });
    await prisma.applicationFeedbackDeliveryAttempt.create({
      data: {
        jobId: job.id,
        claimToken: 'pre-provider-crash-token',
        status: ATTEMPT_STATUS.SENDING,
        messageId: job.feedbackToken,
        attemptedAt: new Date('2026-07-25T10:01:00.000Z'),
        feedbackFormUrl: job.feedbackFormUrl,
      },
    });

    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));

    const results = await processFeedbackJobs();

    expect(sendApplicantFeedbackRequest).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.UNKNOWN);
    expect(updated.lastError).toMatch(/Worker lease expired before delivery was confirmed/);
    const attempts = prisma.__state.attempts.filter((a) => a.jobId === job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(ATTEMPT_STATUS.UNKNOWN);
    expect(attempts[0].messageId).toBe(job.feedbackToken);
  });

  it('cancels a SENDING attempt on status reversal without undefined Prisma status arrays', async () => {
    const app = await seedApplication({ status: 'REJECTED' });
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      dueAt: new Date('2026-07-26T10:00:00.000Z'),
      status: JOB_STATUS.PROCESSING,
      claimToken: 'cancel-token',
      claimedAt: new Date('2026-07-28T09:00:00.000Z'),
    });
    await prisma.applicationFeedbackDeliveryAttempt.create({
      data: {
        jobId: job.id,
        claimToken: 'cancel-token',
        status: ATTEMPT_STATUS.SENDING,
        messageId: job.feedbackToken,
        attemptedAt: new Date('2026-07-28T09:01:00.000Z'),
        feedbackFormUrl: job.feedbackFormUrl,
      },
    });

    const cancelled = await handleApplicationStatusChange(app.id, 'WAITLISTED');

    expect(cancelled).toBe(1);
    const updated = prisma.__state.jobs.find((j) => j.id === job.id);
    expect(updated.status).toBe(JOB_STATUS.CANCELLED);
    const attempts = prisma.__state.attempts.filter((a) => a.jobId === job.id);
    expect(attempts[0].status).toBe(ATTEMPT_STATUS.CANCELLED);
    const appUpdated = prisma.__state.applications.find((a) => a.id === app.id);
    expect(appUpdated.decisionSentAt).toBeNull();
  });
});

describe('getFeedbackJobs', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns paginated jobs filtered by cycle and status with attempts', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id });
    await prisma.applicationFeedbackDeliveryAttempt.create({
      data: { jobId: job.id, status: ATTEMPT_STATUS.PENDING, feedbackFormUrl: job.feedbackFormUrl },
    });

    const result = await getFeedbackJobs({ cycleId: cycle.id, status: JOB_STATUS.PENDING, page: 1, limit: 10 });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(job.id);
    expect(result.jobs[0].deliveryAttempts).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
  });
});

describe('retryFeedbackJob', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets a FAILED job to PENDING with dueAt now while preserving the immutable form URL snapshot', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      status: JOB_STATUS.FAILED,
      lastError: 'old error',
      feedbackFormUrl: 'https://old.example.com/feedback',
    });

    await prisma.recruitingCycle.update({
      where: { id: cycle.id },
      data: { feedbackFormUrl: 'https://new.example.com/feedback' },
    });

    const result = await retryFeedbackJob(job.id);

    expect(result.status).toBe(JOB_STATUS.PENDING);
    expect(result.dueAt.getTime()).toBe(new Date('2026-07-28T10:00:00.000Z').getTime());
    expect(result.lastError).toBeNull();
    expect(result.feedbackFormUrl).toBe('https://old.example.com/feedback');
  });

  it('throws when retrying a SENT job', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, status: JOB_STATUS.SENT });
    await expect(retryFeedbackJob(job.id)).rejects.toThrow(/Cannot retry job in status SENT/);
  });
});

describe('reconcileFeedbackJob', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles an UNKNOWN job to SENT with a provider message id and audits the actor', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      status: JOB_STATUS.UNKNOWN,
      lastError: 'Lease expired',
    });

    const result = await reconcileFeedbackJob(job.id, { status: JOB_STATUS.SENT, messageId: 'msg-123', actor: 'test-admin' });

    expect(result.status).toBe(JOB_STATUS.SENT);
    expect(result.lastError).toBeNull();
    expect(result.reconciledBy).toBe('test-admin');
    expect(result.reconciledFromStatus).toBe(JOB_STATUS.UNKNOWN);
    expect(result.deliveryAttempts).toHaveLength(1);
    expect(result.deliveryAttempts[0].status).toBe(ATTEMPT_STATUS.SENT);
    expect(result.deliveryAttempts[0].messageId).toBe('msg-123');
    expect(result.deliveryAttempts[0].reconciledBy).toBe('test-admin');
    expect(result.deliveryAttempts[0].priorStatus).toBe(JOB_STATUS.UNKNOWN);
  });

  it('reconciles an UNKNOWN job to FAILED with a reason and audits the actor', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      status: JOB_STATUS.UNKNOWN,
    });

    const result = await reconcileFeedbackJob(job.id, { status: JOB_STATUS.FAILED, reason: 'Bounced by provider', actor: 'test-admin' });

    expect(result.status).toBe(JOB_STATUS.FAILED);
    expect(result.lastError).toBe('Bounced by provider');
    expect(result.reconciledBy).toBe('test-admin');
    expect(result.reconciledFromStatus).toBe(JOB_STATUS.UNKNOWN);
    expect(result.deliveryAttempts[0].status).toBe(ATTEMPT_STATUS.FAILED);
    expect(result.deliveryAttempts[0].error).toBe('Bounced by provider');
    expect(result.deliveryAttempts[0].reconciledBy).toBe('test-admin');
    expect(result.deliveryAttempts[0].priorStatus).toBe(JOB_STATUS.UNKNOWN);
  });

  it('reconciles a stale PROCESSING job to SENT', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({
      applicationId: app.id,
      cycleId: cycle.id,
      status: JOB_STATUS.PROCESSING,
      claimToken: 'stale-token',
      claimedAt: new Date('2026-07-28T09:00:00.000Z'),
    });

    const result = await reconcileFeedbackJob(job.id, { status: JOB_STATUS.SENT, messageId: 'msg-456', actor: 'test-admin' });

    expect(result.status).toBe(JOB_STATUS.SENT);
    expect(result.reconciledFromStatus).toBe(JOB_STATUS.PROCESSING);
    expect(result.deliveryAttempts[0].priorStatus).toBe(JOB_STATUS.PROCESSING);
  });

  it('throws when reconciling to SENT without a message id', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, status: JOB_STATUS.UNKNOWN });
    await expect(reconcileFeedbackJob(job.id, { status: JOB_STATUS.SENT, actor: 'test-admin' })).rejects.toThrow(/messageId is required/);
  });

  it('throws when actor is missing', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, status: JOB_STATUS.UNKNOWN });
    await expect(reconcileFeedbackJob(job.id, { status: JOB_STATUS.SENT, messageId: 'msg-123' })).rejects.toThrow(/Actor is required/);
  });

  it('throws when reconciling from a confirmed SENT job', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, status: JOB_STATUS.SENT });
    await expect(reconcileFeedbackJob(job.id, { status: JOB_STATUS.FAILED, actor: 'test-admin' })).rejects.toThrow(/Cannot reconcile job in status SENT/);
  });

  it('throws when reconciling from a PENDING job', async () => {
    const app = await seedApplication();
    const cycle = await seedCycle();
    const job = await seedJob({ applicationId: app.id, cycleId: cycle.id, status: JOB_STATUS.PENDING });
    await expect(reconcileFeedbackJob(job.id, { status: JOB_STATUS.FAILED, actor: 'test-admin' })).rejects.toThrow(/Cannot reconcile job in status PENDING/);
  });
});
