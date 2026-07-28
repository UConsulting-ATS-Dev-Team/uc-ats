import { randomUUID } from 'node:crypto';
import prisma from '../prismaClient.js';
import { sendApplicantFeedbackRequest } from './emailNotifications.js';

export const FEEDBACK_JOB_TYPE = 'FEEDBACK_REQUEST';
export const LEASE_TIMEOUT_MS = 5 * 60 * 1000;

export const JOB_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

export const ATTEMPT_STATUS = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const FEEDBACK_DELAY_MS = 48 * 60 * 60 * 1000;

function isRejectedStatus(status) {
  return status === 'REJECTED';
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAllowedFeedbackFormUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!parsed.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

function generateClaimToken() {
  return randomUUID();
}

function generateFeedbackToken() {
  return randomUUID();
}

function buildFeedbackUrl(token) {
  const base = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/feedback/${token}`;
}

function datesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

export function computeDueAt(decisionSentAt) {
  const date = decisionSentAt instanceof Date ? decisionSentAt : new Date(decisionSentAt);
  return new Date(date.getTime() + FEEDBACK_DELAY_MS);
}

export async function scheduleFeedbackRequest(application, cycle, decisionSentAt) {
  if (!application?.id) {
    throw new Error('Application is required to schedule a feedback request');
  }
  // Feedback requests are only sent to rejected candidates.
  if (!isRejectedStatus(application.status)) {
    await cancelPendingFeedbackRequest(application.id);
    return null;
  }
  if (!decisionSentAt) {
    throw new Error('decisionSentAt is required to schedule a feedback request');
  }

  const feedbackToken = generateFeedbackToken();
  const feedbackFormUrl = buildFeedbackUrl(feedbackToken);
  const dueAt = computeDueAt(decisionSentAt);

  if (!isAllowedFeedbackFormUrl(feedbackFormUrl)) {
    return prisma.applicationFeedbackJob.create({
      data: {
        applicationId: application.id,
        cycleId: cycle?.id || null,
        type: FEEDBACK_JOB_TYPE,
        status: JOB_STATUS.FAILED,
        dueAt,
        decisionSentAt: new Date(decisionSentAt),
        feedbackToken,
        feedbackFormUrl,
        lastError: `Feedback form URL is missing or not allowed: ${feedbackFormUrl}`,
      },
    });
  }

  try {
    const job = await prisma.applicationFeedbackJob.create({
      data: {
        applicationId: application.id,
        cycleId: cycle?.id || null,
        type: FEEDBACK_JOB_TYPE,
        status: JOB_STATUS.PENDING,
        dueAt,
        decisionSentAt: new Date(decisionSentAt),
        feedbackToken,
        feedbackFormUrl,
      },
    });
    return job;
  } catch (error) {
    if (error.code === 'P2002') {
      const existing = await prisma.applicationFeedbackJob.findUnique({
        where: {
          applicationId_type_decisionSentAt: {
            applicationId: application.id,
            type: FEEDBACK_JOB_TYPE,
            decisionSentAt: new Date(decisionSentAt),
          },
        },
      });
      return existing;
    }
    throw error;
  }
}

export async function cancelPendingFeedbackRequest(applicationId) {
  const jobs = await prisma.applicationFeedbackJob.findMany({
    where: {
      applicationId,
      type: FEEDBACK_JOB_TYPE,
      status: { in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING, JOB_STATUS.FAILED] },
    },
    select: { id: true },
  });

  if (jobs.length === 0) return 0;

  const ids = jobs.map((job) => job.id);

  await prisma.$transaction([
    prisma.applicationFeedbackJob.updateMany({
      where: { id: { in: ids } },
      data: {
        status: JOB_STATUS.CANCELLED,
        claimToken: null,
        claimedAt: null,
        lastError: null,
      },
    }),
    prisma.applicationFeedbackDeliveryAttempt.updateMany({
      where: {
        jobId: { in: ids },
        status: { in: [ATTEMPT_STATUS.PENDING, ATTEMPT_STATUS.PROCESSING] },
      },
      data: { status: ATTEMPT_STATUS.CANCELLED, error: 'Job cancelled by status change' },
    }),
  ]);

  return jobs.length;
}

export async function handleApplicationStatusChange(applicationId, newStatus) {
  // Only rejected candidates should receive a feedback request, so any
  // transition away from REJECTED cancels pending/processing/failed jobs.
  if (!isRejectedStatus(newStatus)) {
    return cancelPendingFeedbackRequest(applicationId);
  }
  return 0;
}

async function claimJob(job, token, now) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.applicationFeedbackJob.updateMany({
      where: {
        id: job.id,
        status: JOB_STATUS.PENDING,
      },
      data: {
        status: JOB_STATUS.PROCESSING,
        claimToken: token,
        claimedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (updated.count === 0) return null;

    const [currentJob] = await Promise.all([
      tx.applicationFeedbackJob.findUnique({ where: { id: job.id } }),
      tx.applicationFeedbackDeliveryAttempt.create({
        data: {
          jobId: job.id,
          claimToken: token,
          status: ATTEMPT_STATUS.PENDING,
          feedbackFormUrl: job.feedbackFormUrl,
        },
      }),
    ]);

    return currentJob;
  });
}

async function verifySendEligibility(job, token, now) {
  return prisma.$transaction(async (tx) => {
    const [currentJob, currentApp] = await Promise.all([
      tx.applicationFeedbackJob.findUnique({ where: { id: job.id } }),
      tx.application.findUnique({ where: { id: job.applicationId } }),
    ]);

    if (!currentJob || currentJob.status !== JOB_STATUS.PROCESSING || currentJob.claimToken !== token) {
      return { ok: false, reason: 'Job claim lost or token mismatch' };
    }

    if (!currentApp || !isRejectedStatus(currentApp.status) || !datesEqual(currentApp.decisionSentAt, currentJob.decisionSentAt)) {
      const error = 'Application eligibility changed or final decision was reversed';
      await Promise.all([
        tx.applicationFeedbackJob.updateMany({
          where: { id: job.id, claimToken: token },
          data: {
            status: JOB_STATUS.CANCELLED,
            claimToken: null,
            claimedAt: null,
            lastError: error,
          },
        }),
        tx.applicationFeedbackDeliveryAttempt.updateMany({
          where: { jobId: job.id, claimToken: token },
          data: { status: ATTEMPT_STATUS.CANCELLED, error },
        }),
      ]);
      return { ok: false, reason: error };
    }

    return { ok: true };
  });
}

async function markJobFailed(job, token, error) {
  await prisma.$transaction([
    prisma.applicationFeedbackDeliveryAttempt.updateMany({
      where: { jobId: job.id, claimToken: token },
      data: { status: ATTEMPT_STATUS.FAILED, error },
    }),
    prisma.applicationFeedbackJob.updateMany({
      where: { id: job.id, claimToken: token },
      data: {
        status: JOB_STATUS.FAILED,
        lastError: error,
        claimToken: null,
        claimedAt: null,
      },
    }),
  ]);
}

async function processSingleFeedbackJob(job, now = new Date()) {
  const token = generateClaimToken();
  const claimed = await claimJob(job, token, now);

  if (!claimed) {
    return { id: job.id, action: 'skipped', reason: 'already claimed or no longer pending' };
  }

  const eligible = await verifySendEligibility(job, token, now);
  if (!eligible.ok) {
    return { id: job.id, action: 'cancelled', reason: eligible.reason };
  }

  const { application, cycle } = job;
  const to = application?.email;
  const candidateName = application ? `${application.firstName} ${application.lastName}` : '';
  const feedbackFormUrl = job.feedbackFormUrl;
  const cycleName = cycle?.name || 'UConsulting';

  let validationError = null;
  if (!isAllowedFeedbackFormUrl(feedbackFormUrl)) {
    validationError = `Feedback form URL is missing or not allowed: ${feedbackFormUrl || '(none)'}`;
  } else if (!isValidEmail(to)) {
    validationError = `Invalid or missing applicant email: ${to}`;
  }

  if (validationError) {
    await markJobFailed(job, token, validationError);
    return { id: job.id, action: 'failed', error: validationError };
  }

  try {
    const sendResult = await sendApplicantFeedbackRequest(
      to,
      candidateName,
      cycleName,
      feedbackFormUrl
    );

    if (sendResult.success) {
      const [attemptUpdate, jobUpdate] = await prisma.$transaction([
        prisma.applicationFeedbackDeliveryAttempt.updateMany({
          where: { jobId: job.id, claimToken: token },
          data: { status: ATTEMPT_STATUS.SENT, messageId: sendResult.messageId },
        }),
        prisma.applicationFeedbackJob.updateMany({
          where: { id: job.id, claimToken: token, status: JOB_STATUS.PROCESSING },
          data: {
            status: JOB_STATUS.SENT,
            sentAt: now,
            messageId: sendResult.messageId,
            claimToken: null,
            claimedAt: null,
            lastError: null,
          },
        }),
      ]);

      if (attemptUpdate.count === 0) {
        return { id: job.id, action: 'sent', messageId: sendResult.messageId, note: 'delivery attempt record not updated' };
      }
      if (jobUpdate.count === 0) {
        return { id: job.id, action: 'sent', messageId: sendResult.messageId, note: 'job state changed after delivery' };
      }

      return { id: job.id, action: 'sent', messageId: sendResult.messageId };
    }

    await markJobFailed(job, token, sendResult.error);
    return { id: job.id, action: 'failed', error: sendResult.error };
  } catch (err) {
    await markJobFailed(job, token, err.message);
    return { id: job.id, action: 'failed', error: err.message };
  }
}

async function reconcileStalledJobs(now = new Date()) {
  // Reconcile PROCESSING jobs that already have a SENT delivery attempt recorded.
  // This covers the provider-success -> job-state-write-failure case.
  const sentAttempts = await prisma.applicationFeedbackDeliveryAttempt.findMany({
    where: { status: ATTEMPT_STATUS.SENT },
    include: { job: true },
  });

  for (const attempt of sentAttempts) {
    if (attempt.job && attempt.job.status === JOB_STATUS.PROCESSING) {
      await prisma.applicationFeedbackJob.update({
        where: { id: attempt.job.id },
        data: {
          status: JOB_STATUS.SENT,
          sentAt: attempt.attemptedAt,
          messageId: attempt.messageId,
          claimToken: null,
          claimedAt: null,
          lastError: null,
        },
      });
    }
  }

  // Reset PROCESSING jobs whose lease has expired without a confirmed SENT attempt.
  const leaseExpiry = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  const stuckJobs = await prisma.applicationFeedbackJob.findMany({
    where: {
      status: JOB_STATUS.PROCESSING,
      OR: [
        { claimedAt: { lte: leaseExpiry } },
        { claimedAt: null },
      ],
    },
  });

  for (const job of stuckJobs) {
    const sentAttempt = await prisma.applicationFeedbackDeliveryAttempt.findFirst({
      where: { jobId: job.id, status: ATTEMPT_STATUS.SENT },
      orderBy: { attemptedAt: 'desc' },
    });

    if (!sentAttempt) {
      await prisma.applicationFeedbackJob.update({
        where: { id: job.id },
        data: {
          status: JOB_STATUS.PENDING,
          claimToken: null,
          claimedAt: null,
          lastError: 'Processing lease expired without confirmed delivery',
        },
      });
    }
  }

  return sentAttempts.length + stuckJobs.length;
}

export async function processFeedbackJobs(now = new Date()) {
  await reconcileStalledJobs(now);

  const dueJobs = await prisma.applicationFeedbackJob.findMany({
    where: {
      status: JOB_STATUS.PENDING,
      dueAt: { lte: now },
    },
    orderBy: { dueAt: 'asc' },
    include: {
      application: true,
      cycle: true,
    },
  });

  const results = [];
  for (const job of dueJobs) {
    const result = await processSingleFeedbackJob(job, now);
    results.push(result);
  }
  return results;
}

export async function getFeedbackJobs({ cycleId, status, applicationId, page = 1, limit = 50 } = {}) {
  const where = { type: FEEDBACK_JOB_TYPE };
  if (cycleId) where.cycleId = cycleId;
  if (status) where.status = status;
  if (applicationId) where.applicationId = applicationId;

  const skip = (page - 1) * limit;
  const [jobs, total] = await Promise.all([
    prisma.applicationFeedbackJob.findMany({
      where,
      orderBy: { dueAt: 'asc' },
      skip,
      take: limit,
      include: {
        application: {
          select: { id: true, firstName: true, lastName: true, email: true, status: true, decisionSentAt: true },
        },
        cycle: {
          select: { id: true, name: true, feedbackFormUrl: true },
        },
        response: {
          select: { id: true, submittedAt: true },
        },
        deliveryAttempts: {
          orderBy: { attemptedAt: 'desc' },
        },
      },
    }),
    prisma.applicationFeedbackJob.count({ where }),
  ]);

  return {
    jobs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function retryFeedbackJob(id) {
  const existing = await prisma.applicationFeedbackJob.findUnique({
    where: { id },
    include: { cycle: true },
  });

  if (!existing) throw new Error('Feedback job not found');

  const updated = await prisma.applicationFeedbackJob.updateMany({
    where: {
      id,
      type: FEEDBACK_JOB_TYPE,
      status: { in: [JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.PENDING] },
    },
    data: {
      status: JOB_STATUS.PENDING,
      dueAt: new Date(),
      lastError: null,
      claimToken: null,
      claimedAt: null,
      respondedAt: null,
    },
  });

  if (updated.count === 0) {
    throw new Error(`Cannot retry job in status ${existing.status}`);
  }

  return prisma.applicationFeedbackJob.findUnique({ where: { id } });
}

export async function cancelFeedbackJob(id) {
  const updated = await prisma.applicationFeedbackJob.updateMany({
    where: {
      id,
      type: FEEDBACK_JOB_TYPE,
      status: { in: [JOB_STATUS.PENDING, JOB_STATUS.FAILED, JOB_STATUS.PROCESSING] },
    },
    data: { status: JOB_STATUS.CANCELLED, claimToken: null, claimedAt: null, lastError: null },
  });

  if (updated.count === 0) {
    const existing = await prisma.applicationFeedbackJob.findUnique({ where: { id } });
    if (!existing) throw new Error('Feedback job not found');
    throw new Error(`Cannot cancel job in status ${existing.status}`);
  }

  return prisma.applicationFeedbackJob.findUnique({ where: { id } });
}
