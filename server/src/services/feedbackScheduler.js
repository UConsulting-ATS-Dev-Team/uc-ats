import { randomUUID } from 'node:crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
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
  SENDING: 'SENDING',
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
  const base = (config.clientUrl || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/feedback/${token}`;
}

function datesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

export function computeDueAt(decisionSentAt, hours = 48) {
  const date = decisionSentAt instanceof Date ? decisionSentAt : new Date(decisionSentAt);
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
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

  if (cycle?.feedbackEnabled === false) {
    await cancelPendingFeedbackRequest(application.id);
    return null;
  }

  const feedbackToken = generateFeedbackToken();
  const feedbackFormUrl = buildFeedbackUrl(feedbackToken);
  const cadenceHours = Number.isFinite(cycle?.feedbackCadenceHours) ? cycle.feedbackCadenceHours : 48;
  const dueAt = computeDueAt(decisionSentAt, cadenceHours);

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
        feedbackPrompt: cycle?.feedbackPrompt ?? null,
        feedbackQuestions: cycle?.feedbackQuestions ?? null,
        lastError: `Feedback form URL is missing or not allowed: ${feedbackFormUrl}`,
      },
    });
  }

  // If cadence was reduced so the due time is already past, process immediately.
  const adjustedDueAt = dueAt < new Date() ? new Date() : dueAt;

  try {
    const job = await prisma.applicationFeedbackJob.create({
      data: {
        applicationId: application.id,
        cycleId: cycle?.id || null,
        type: FEEDBACK_JOB_TYPE,
        status: JOB_STATUS.PENDING,
        dueAt: adjustedDueAt,
        decisionSentAt: new Date(decisionSentAt),
        feedbackToken,
        feedbackFormUrl,
        feedbackPrompt: cycle?.feedbackPrompt ?? null,
        feedbackQuestions: cycle?.feedbackQuestions ?? null,
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
  // transition away from REJECTED cancels pending/processing/failed jobs
  // and clears any prior final-decision timestamp so a new final decision
  // can be processed idempotently.
  if (!isRejectedStatus(newStatus)) {
    const cancelled = await cancelPendingFeedbackRequest(applicationId);
    await prisma.application.update({
      where: { id: applicationId },
      data: { decisionSentAt: null },
    });
    return cancelled;
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

async function prepareSend(job, token, messageId, now) {
  return prisma.$transaction(async (tx) => {
    const [currentJob, currentApp] = await Promise.all([
      tx.applicationFeedbackJob.findUnique({ where: { id: job.id } }),
      tx.application.findUnique({ where: { id: job.applicationId } }),
    ]);

    if (!currentJob || currentJob.status !== JOB_STATUS.PROCESSING || currentJob.claimToken !== token) {
      return { ok: false, reason: 'Job claim lost or token mismatch', cancelled: false };
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
      return { ok: false, reason: error, cancelled: true };
    }

    // Persist a durable SENDING intent before calling the provider. This is the
    // delivery boundary: if this write succeeds, the send is committed and the
    // provider key (feedbackToken) makes the attempt idempotent on retry.
    const result = await tx.applicationFeedbackDeliveryAttempt.updateMany({
      where: { jobId: job.id, claimToken: token, status: ATTEMPT_STATUS.PENDING },
      data: { status: ATTEMPT_STATUS.SENDING, messageId, attemptedAt: now },
    });
    if (result.count === 0) {
      return { ok: false, reason: 'Delivery attempt not found for claim token', cancelled: false };
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

async function cancelClaimedJob(job, token, reason) {
  await prisma.$transaction([
    prisma.applicationFeedbackDeliveryAttempt.updateMany({
      where: { jobId: job.id, claimToken: token },
      data: { status: ATTEMPT_STATUS.CANCELLED, error: reason },
    }),
    prisma.applicationFeedbackJob.updateMany({
      where: { id: job.id, claimToken: token },
      data: {
        status: JOB_STATUS.CANCELLED,
        lastError: reason,
        claimToken: null,
        claimedAt: null,
      },
    }),
  ]);
}

async function markAttemptSent(job, token, messageId, now) {
  const result = await prisma.applicationFeedbackDeliveryAttempt.updateMany({
    where: { jobId: job.id, claimToken: token, status: ATTEMPT_STATUS.SENDING },
    data: {
      status: ATTEMPT_STATUS.SENT,
      messageId,
      attemptedAt: now,
    },
  });
  if (result.count === 0) {
    throw new Error('Delivery attempt not in SENDING state for claim token');
  }
}

async function markJobSent(job, now, messageId, token) {
  const result = await prisma.applicationFeedbackJob.updateMany({
    where: { id: job.id, claimToken: token, status: JOB_STATUS.PROCESSING },
    data: {
      status: JOB_STATUS.SENT,
      sentAt: now,
      messageId,
      claimToken: null,
      claimedAt: null,
      lastError: null,
    },
  });
  if (result.count === 0) {
    throw new Error('Job state changed after delivery or claim token mismatch');
  }
}

async function reconcileJobSent(job, now, messageId) {
  const result = await prisma.applicationFeedbackJob.updateMany({
    where: { id: job.id, status: { in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING] } },
    data: {
      status: JOB_STATUS.SENT,
      sentAt: now,
      messageId,
      claimToken: null,
      claimedAt: null,
      lastError: null,
    },
  });
  if (result.count === 0) {
    throw new Error('Job already reconciled or not eligible for reconciliation');
  }
}

async function processSingleFeedbackJob(job, now = new Date()) {
  // If a previous run already committed a send intent (SENDING) or a confirmed
  // delivery (SENT), do not call the provider again. This is the durable
  // outbox boundary that survives provider success -> persistence failures.
  const existingDurableAttempt = await prisma.applicationFeedbackDeliveryAttempt.findFirst({
    where: { jobId: job.id, status: { in: [ATTEMPT_STATUS.SENT, ATTEMPT_STATUS.SENDING] } },
    orderBy: { attemptedAt: 'desc' },
  });
  if (existingDurableAttempt) {
    const messageId = existingDurableAttempt.messageId || existingDurableAttempt.claimToken;
    try {
      await reconcileJobSent(job, now, messageId);
    } catch {
      // The durable delivery attempt already records the external effect.
    }
    return { id: job.id, action: 'sent', messageId, note: 'reconciled from durable delivery attempt' };
  }

  const token = generateClaimToken();
  const claimed = await claimJob(job, token, now);

  if (!claimed) {
    return { id: job.id, action: 'skipped', reason: 'already claimed or no longer pending' };
  }

  // A concurrent worker may have committed a SENDING/SENT attempt while we
  // were claiming; reconcile instead of sending.
  const concurrentDurableAttempt = await prisma.applicationFeedbackDeliveryAttempt.findFirst({
    where: { jobId: job.id, status: { in: [ATTEMPT_STATUS.SENT, ATTEMPT_STATUS.SENDING] } },
    orderBy: { attemptedAt: 'desc' },
  });
  if (concurrentDurableAttempt) {
    await cancelClaimedJob(claimed, token, 'Reconciled with a durable delivery attempt from another worker');
    const messageId = concurrentDurableAttempt.messageId || concurrentDurableAttempt.claimToken;
    try { await reconcileJobSent(claimed, now, messageId); } catch {}
    return { id: job.id, action: 'sent', messageId, note: 'reconciled from durable delivery attempt' };
  }

  // Use the freshly claimed job record for immutable snapshots and the
  // originally included relations for application/cycle data.
  const currentJob = claimed;
  const { application, cycle } = job;

  if (cycle?.feedbackEnabled === false) {
    await cancelClaimedJob(currentJob, token, 'Feedback disabled for this recruiting cycle');
    return { id: job.id, action: 'cancelled', reason: 'Feedback disabled for this recruiting cycle' };
  }

  const to = application?.email;
  const candidateName = application ? `${application.firstName} ${application.lastName}` : '';
  const feedbackFormUrl = currentJob.feedbackFormUrl;
  const cycleName = cycle?.name || 'UConsulting';

  let validationError = null;
  if (!isAllowedFeedbackFormUrl(feedbackFormUrl)) {
    validationError = `Feedback form URL is missing or not allowed: ${feedbackFormUrl || '(none)'}`;
  } else if (!isValidEmail(to)) {
    validationError = `Invalid or missing applicant email: ${to}`;
  }

  if (validationError) {
    await markJobFailed(currentJob, token, validationError);
    return { id: job.id, action: 'failed', error: validationError };
  }

  // The feedback token is a durable provider/outbox key for this job.
  const messageKey = currentJob.feedbackToken || token;

  // The delivery boundary: eligibility and a durable SENDING intent are written
  // in one transaction before the provider is invoked. If this transaction
  // aborts (e.g. a status reversal), the provider is never called.
  const prepared = await prepareSend(currentJob, token, messageKey, now);
  if (!prepared.ok) {
    if (prepared.cancelled) {
      return { id: job.id, action: 'cancelled', reason: prepared.reason };
    }
    await markJobFailed(currentJob, token, prepared.reason || 'Send preparation failed');
    return { id: job.id, action: 'failed', error: prepared.reason || 'Send preparation failed' };
  }

  let sendResult;
  try {
    sendResult = await sendApplicantFeedbackRequest(
      to,
      candidateName,
      cycleName,
      feedbackFormUrl,
      messageKey
    );
  } catch (sendErr) {
    await markJobFailed(currentJob, token, sendErr.message);
    return { id: job.id, action: 'failed', error: sendErr.message };
  }

  if (!sendResult.success) {
    await markJobFailed(currentJob, token, sendResult.error);
    return { id: job.id, action: 'failed', error: sendResult.error };
  }

  const messageId = sendResult.messageId || messageKey;

  try {
    await markAttemptSent(currentJob, token, messageId, now);
    await markJobSent(currentJob, now, messageId, token);
    return { id: job.id, action: 'sent', messageId };
  } catch (postSendErr) {
    // The SENDING intent is durable. Do not mark the job FAILED; the attempt
    // and job state will be reconciled on the next run.
    return { id: job.id, action: 'sent', messageId, note: 'delivery attempt is durable and will be reconciled' };
  }
}

async function reconcileStalledJobs(now = new Date()) {
  // Reconcile any job that already has a durable SENDING or confirmed SENT
  // delivery attempt recorded. This covers the provider-success -> persistence-
  // failure cases and prevents duplicate provider calls on retry.
  const durableAttempts = await prisma.applicationFeedbackDeliveryAttempt.findMany({
    where: { status: { in: [ATTEMPT_STATUS.SENT, ATTEMPT_STATUS.SENDING] } },
    include: { job: true },
  });

  for (const attempt of durableAttempts) {
    if (attempt.job && attempt.job.status !== JOB_STATUS.SENT) {
      await prisma.applicationFeedbackJob.updateMany({
        where: { id: attempt.job.id, status: { in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING] } },
        data: {
          status: JOB_STATUS.SENT,
          sentAt: attempt.attemptedAt,
          messageId: attempt.messageId,
          claimToken: null,
          claimedAt: null,
          lastError: null,
        },
      });
      if (attempt.status === ATTEMPT_STATUS.SENDING) {
        await prisma.applicationFeedbackDeliveryAttempt.updateMany({
          where: { id: attempt.id },
          data: { status: ATTEMPT_STATUS.SENT },
        });
      }
    }
  }

  // Reset PROCESSING jobs whose lease has expired without a durable attempt.
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
    const durableAttempt = await prisma.applicationFeedbackDeliveryAttempt.findFirst({
      where: { jobId: job.id, status: { in: [ATTEMPT_STATUS.SENT, ATTEMPT_STATUS.SENDING] } },
      orderBy: { attemptedAt: 'desc' },
    });

    if (!durableAttempt) {
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

  return durableAttempts.length + stuckJobs.length;
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
          select: { id: true, name: true, feedbackEnabled: true, feedbackCadenceHours: true, feedbackPrompt: true, feedbackQuestions: true },
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
