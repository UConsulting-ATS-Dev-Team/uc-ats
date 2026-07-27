import prisma from '../prismaClient.js';
import { sendApplicantFeedbackRequest } from './emailNotifications.js';

export const FEEDBACK_JOB_TYPE = 'FEEDBACK_REQUEST';

export const JOB_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const FEEDBACK_DELAY_MS = 48 * 60 * 60 * 1000;

function isFinalStatus(status) {
  return status === 'ACCEPTED' || status === 'REJECTED';
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function computeDueAt(decisionSentAt) {
  const date = decisionSentAt instanceof Date ? decisionSentAt : new Date(decisionSentAt);
  return new Date(date.getTime() + FEEDBACK_DELAY_MS);
}

export async function scheduleFeedbackRequest(application, cycle, decisionSentAt) {
  if (!application?.id) {
    throw new Error('Application is required to schedule a feedback request');
  }
  if (!isFinalStatus(application.status)) {
    await cancelPendingFeedbackRequest(application.id);
    return null;
  }
  if (!decisionSentAt) {
    throw new Error('decisionSentAt is required to schedule a feedback request');
  }

  const dueAt = computeDueAt(decisionSentAt);

  try {
    const job = await prisma.applicationFeedbackJob.create({
      data: {
        applicationId: application.id,
        cycleId: cycle?.id || null,
        type: FEEDBACK_JOB_TYPE,
        status: JOB_STATUS.PENDING,
        dueAt,
        decisionSentAt: new Date(decisionSentAt),
        feedbackFormUrl: cycle?.feedbackFormUrl || null,
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
  const result = await prisma.applicationFeedbackJob.updateMany({
    where: {
      applicationId,
      type: FEEDBACK_JOB_TYPE,
      status: { in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING, JOB_STATUS.FAILED] },
    },
    data: {
      status: JOB_STATUS.CANCELLED,
      lastError: null,
    },
  });
  return result.count;
}

export async function handleApplicationStatusChange(applicationId, newStatus) {
  if (!isFinalStatus(newStatus)) {
    return cancelPendingFeedbackRequest(applicationId);
  }
  return 0;
}

async function claimJob(jobId) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.applicationFeedbackJob.updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.PENDING,
      },
      data: {
        status: JOB_STATUS.PROCESSING,
        attempts: { increment: 1 },
      },
    });
    if (updated.count === 0) return null;
    return tx.applicationFeedbackJob.findUnique({ where: { id: jobId } });
  });
}

async function processSingleFeedbackJob(job, now = new Date()) {
  const claimed = await claimJob(job.id);
  if (!claimed) {
    return { id: job.id, action: 'skipped', reason: 'already claimed or no longer pending' };
  }

  try {
    const { application, cycle } = job;
    const to = application?.email;
    const candidateName = application ? `${application.firstName} ${application.lastName}` : '';
    const feedbackFormUrl = cycle?.feedbackFormUrl;
    const cycleName = cycle?.name || 'UConsulting';

    let error = null;
    if (!feedbackFormUrl) {
      error = 'Feedback form URL is not configured for this cycle';
    } else if (!isValidEmail(to)) {
      error = `Invalid or missing applicant email: ${to}`;
    }

    if (error) {
      await prisma.applicationFeedbackJob.update({
        where: { id: job.id },
        data: { status: JOB_STATUS.FAILED, lastError: error },
      });
      return { id: job.id, action: 'failed', error };
    }

    const sendResult = await sendApplicantFeedbackRequest(to, candidateName, cycleName, feedbackFormUrl);

    if (sendResult.success) {
      await prisma.applicationFeedbackJob.update({
        where: { id: job.id },
        data: { status: JOB_STATUS.SENT, sentAt: now, lastError: null },
      });
      return { id: job.id, action: 'sent', messageId: sendResult.messageId };
    }

    await prisma.applicationFeedbackJob.update({
      where: { id: job.id },
      data: { status: JOB_STATUS.FAILED, lastError: sendResult.error },
    });
    return { id: job.id, action: 'failed', error: sendResult.error };
  } catch (err) {
    try {
      await prisma.applicationFeedbackJob.update({
        where: { id: job.id },
        data: { status: JOB_STATUS.FAILED, lastError: err.message },
      });
    } catch (updateErr) {
      console.error('[processSingleFeedbackJob] failed to mark job failed:', updateErr);
    }
    return { id: job.id, action: 'failed', error: err.message };
  }
}

export async function processFeedbackJobs(now = new Date()) {
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
          select: { id: true, firstName: true, lastName: true, email: true, status: true },
        },
        cycle: {
          select: { id: true, name: true, feedbackFormUrl: true },
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
    },
  });

  if (updated.count === 0) {
    const existing = await prisma.applicationFeedbackJob.findUnique({ where: { id } });
    if (!existing) throw new Error('Feedback job not found');
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
    data: { status: JOB_STATUS.CANCELLED, lastError: null },
  });

  if (updated.count === 0) {
    const existing = await prisma.applicationFeedbackJob.findUnique({ where: { id } });
    if (!existing) throw new Error('Feedback job not found');
    throw new Error(`Cannot cancel job in status ${existing.status}`);
  }

  return prisma.applicationFeedbackJob.findUnique({ where: { id } });
}
