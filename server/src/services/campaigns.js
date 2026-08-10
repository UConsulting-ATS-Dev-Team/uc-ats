import crypto from 'crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import jwt from 'jsonwebtoken';
import { sendEmail } from './emailNotifications.js';

const MERGE_FIELDS = [
  'firstName',
  'lastName',
  'name',
  'cycle',
  'stage',
  'status',
];

const escapeHtml = (value) => {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

function interpolateTemplate(text, context) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (context[key] === undefined || context[key] === null) return '';
    return escapeHtml(context[key]);
  });
}

function buildFooter(unsubscribeUrl) {
  return `
    <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px; color: #6b7280; font-size: 12px;">
      <p style="margin: 0 0 8px 0;">UConsulting Application Tracking System</p>
      <p style="margin: 0;">
        <a href="${unsubscribeUrl}" style="color: #6b7280; text-decoration: underline;">Unsubscribe from recruitment emails</a>
      </p>
    </div>
  `;
}

export function renderCampaignBody(template, context) {
  const merged = interpolateTemplate(template.body, context);
  const footer = buildFooter(context.unsubscribeUrl || '#');
  return `${merged}${footer}`;
}

export function renderCampaignSubject(template, context) {
  return interpolateTemplate(template.subject, context);
}

export function generateUnsubscribeToken(email) {
  return jwt.sign({ email, type: 'unsubscribe' }, config.jwtSecret, { expiresIn: '30d' });
}

export function verifyUnsubscribeToken(token) {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (decoded?.type !== 'unsubscribe' || !decoded?.email) return null;
    return decoded.email;
  } catch (error) {
    return null;
  }
}

function buildSubscriberWhere(filters) {
  const where = { consented: true };
  const applicationWhere = {};

  if (filters.cycleId) {
    applicationWhere.cycleId = filters.cycleId;
  }

  if (filters.statuses && filters.statuses.length > 0) {
    applicationWhere.status = { in: filters.statuses };
  }

  if (filters.rounds && filters.rounds.length > 0) {
    applicationWhere.currentRound = { in: filters.rounds };
  }

  if (Object.keys(applicationWhere).length > 0) {
    where.candidate = { applications: { some: applicationWhere } };
  }

  return { where, applicationWhere };
}

function getLatestApplication(applications) {
  if (!applications || applications.length === 0) return null;
  return applications[0];
}

function buildRecipientContext(recipient, send, baseUrl) {
  const candidate = recipient.candidate;
  const application = getLatestApplication(candidate?.applications || []);
  const cycleName = send.cycle?.name || application?.cycle?.name || '';
  const stage = application?.currentRound || '';
  const status = application?.status || '';
  const firstName = recipient.firstName || candidate?.firstName || '';
  const lastName = recipient.lastName || candidate?.lastName || '';
  const token = generateUnsubscribeToken(recipient.email);
  const unsubscribeUrl = `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(recipient.email)}&token=${encodeURIComponent(token)}`;

  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    cycle: cycleName,
    stage,
    status,
    unsubscribeUrl,
  };
}

function serializeSnapshot(recipient) {
  const candidate = recipient.candidate;
  const application = getLatestApplication(candidate?.applications || []);
  return {
    subscriberId: recipient.id,
    candidateId: candidate?.id || null,
    email: recipient.email,
    firstName: recipient.firstName || candidate?.firstName || '',
    lastName: recipient.lastName || candidate?.lastName || '',
    cycle: application?.cycle?.name || '',
    stage: application?.currentRound || '',
    status: application?.status || '',
  };
}

function fingerprintApproval({ templateName, templateVersion, templateSubject, templateBody, audienceFilters, recipientSnapshot, actorId, approvedAt }) {
  const canonical = JSON.stringify({
    templateName,
    templateVersion,
    templateSubject,
    templateBody,
    audienceFilters,
    recipientSnapshot: [...recipientSnapshot]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((r) => ({ email: r.email, candidateId: r.candidateId })),
    actorId,
    approvedAt: approvedAt.toISOString(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export async function resolveAudience(filters, options = {}) {
  const { where } = buildSubscriberWhere(filters);
  const includeApplications = options.includeApplications !== false;

  const subscribers = await prisma.subscriber.findMany({
    where,
    include: {
      candidate: includeApplications
        ? {
            include: {
              applications: {
                where: buildSubscriberWhere(filters).applicationWhere,
                include: { cycle: true },
                orderBy: { submittedAt: 'desc' },
                take: 1,
              },
            },
          }
        : true,
    },
  });

  let result = subscribers;

  if (filters.excludeSuppressed !== false) {
    const emails = subscribers.map((s) => s.email);
    const suppressed = await prisma.suppressedEmail.findMany({
      where: { email: { in: emails } },
    });
    const suppressedSet = new Set(suppressed.map((s) => s.email));
    result = subscribers.filter((s) => !suppressedSet.has(s.email));
  }

  return result;
}

export async function previewAudience(filters) {
  const recipients = await resolveAudience(filters, { includeApplications: false });
  return {
    count: recipients.length,
    sample: recipients.slice(0, 5).map((s) => {
      const candidate = s.candidate;
      return {
        id: s.id,
        email: s.email,
        firstName: s.firstName || candidate?.firstName || '',
        lastName: s.lastName || candidate?.lastName || '',
      };
    }),
  };
}

export async function getSuppressedEmails() {
  return prisma.suppressedEmail.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function addSuppressedEmail({ email, reason, source }) {
  return prisma.suppressedEmail.upsert({
    where: { email },
    update: { reason, source, updatedAt: new Date() },
    create: { email, reason, source },
  });
}

export async function removeSuppressedEmail(email) {
  return prisma.suppressedEmail.deleteMany({ where: { email } });
}

export async function upsertSubscriber({ email, candidateId, firstName, lastName, consented, source, noticeVersion, actorId }) {
  const subscriber = await prisma.subscriber.upsert({
    where: { email },
    update: {
      candidateId: candidateId || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      consented: consented !== undefined ? consented : undefined,
      noticeVersion: noticeVersion || undefined,
      updatedAt: new Date(),
    },
    create: {
      email,
      candidateId: candidateId || null,
      firstName: firstName || null,
      lastName: lastName || null,
      consented: consented !== undefined ? consented : false,
      source: source || null,
      noticeVersion: noticeVersion || null,
    },
  });

  if (consented !== undefined) {
    await prisma.consentEvent.create({
      data: {
        subscriberId: subscriber.id,
        email: subscriber.email,
        consented,
        source: source || 'admin_update',
        noticeVersion: noticeVersion || null,
        actorId: actorId || null,
      },
    });
  }

  return subscriber;
}

export async function createCampaignTemplate(data) {
  return prisma.campaignTemplate.create({ data });
}

export async function updateCampaignTemplate(id, data) {
  const existing = await prisma.campaignTemplate.findUnique({ where: { id } });
  if (!existing) throw new Error('Template not found');

  return prisma.campaignTemplate.update({
    where: { id },
    data: {
      ...data,
      version: { increment: 1 },
    },
  });
}

export async function getCampaignTemplates(options = {}) {
  return prisma.campaignTemplate.findMany({
    where: options.cycleId ? { cycleId: options.cycleId } : undefined,
    include: { cycle: true, creator: { select: { id: true, fullName: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getCampaignTemplateById(id) {
  return prisma.campaignTemplate.findUnique({
    where: { id },
    include: { cycle: true, creator: { select: { id: true, fullName: true } } },
  });
}

export async function deleteCampaignTemplate(id) {
  return prisma.campaignTemplate.delete({ where: { id } });
}

export async function createCampaignAudience(data) {
  return prisma.campaignAudience.create({ data });
}

export async function updateCampaignAudience(id, data) {
  return prisma.campaignAudience.update({ where: { id }, data });
}

export async function getCampaignAudiences(options = {}) {
  return prisma.campaignAudience.findMany({
    where: options.cycleId ? { cycleId: options.cycleId } : undefined,
    include: { cycle: true, creator: { select: { id: true, fullName: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getCampaignAudienceById(id) {
  return prisma.campaignAudience.findUnique({
    where: { id },
    include: { cycle: true, creator: { select: { id: true, fullName: true } } },
  });
}

export async function deleteCampaignAudience(id) {
  return prisma.campaignAudience.delete({ where: { id } });
}

export async function createCampaignSend({ name, cycleId, templateId, audienceId, scheduledAt, sentBy }) {
  return prisma.campaignSend.create({
    data: {
      name,
      cycleId: cycleId || null,
      templateId,
      audienceId,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      sentBy,
      status: 'PENDING_APPROVAL',
    },
  });
}

const IMMUTABLE_SEND_STATUSES = new Set(['SENDING', 'SENT', 'FAILED', 'CANCELLED']);

export async function updateCampaignSend(id, data) {
  const existing = await prisma.campaignSend.findUnique({ where: { id } });
  if (!existing) throw new Error('Send not found');
  if (IMMUTABLE_SEND_STATUSES.has(existing.status)) {
    throw new Error(`Cannot modify a send that is ${existing.status}`);
  }

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.cycleId !== undefined) updateData.cycleId = data.cycleId || null;
  if (data.templateId !== undefined) updateData.templateId = data.templateId;
  if (data.audienceId !== undefined) updateData.audienceId = data.audienceId;
  if (data.scheduledAt !== undefined) {
    updateData.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  }

  if (Object.keys(updateData).length === 0) {
    return existing;
  }

  // Changing the schedule or audience after approval invalidates the approval.
  if (existing.status === 'APPROVED' || existing.status === 'SCHEDULED') {
    updateData.status = 'PENDING_APPROVAL';
    updateData.approvedBy = null;
    updateData.approvedAt = null;
    updateData.approvalFingerprint = null;
  } else if (updateData.scheduledAt && updateData.scheduledAt > new Date()) {
    updateData.status = 'PENDING_APPROVAL';
  }

  return prisma.campaignSend.update({
    where: { id },
    data: updateData,
  });
}

export async function getCampaignSends(options = {}) {
  return prisma.campaignSend.findMany({
    where: options.cycleId ? { cycleId: options.cycleId } : undefined,
    include: {
      template: true,
      audience: true,
      cycle: true,
      sender: { select: { id: true, fullName: true } },
      approver: { select: { id: true, fullName: true } },
      _count: { select: { logs: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getCampaignSendById(id) {
  return prisma.campaignSend.findUnique({
    where: { id },
    include: {
      template: true,
      audience: true,
      cycle: true,
      sender: { select: { id: true, fullName: true } },
      approver: { select: { id: true, fullName: true } },
      logs: { orderBy: { sentAt: 'desc' } },
    },
  });
}

export async function approveCampaignSend({ sendId, actorId }) {
  const send = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { template: true, audience: true, cycle: true },
  });

  if (!send) throw new Error('Campaign send not found');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(send.status)) {
    throw new Error(`Send cannot be approved from status ${send.status}`);
  }

  if (!send.template || !send.audience) {
    throw new Error('Send must have a template and an audience');
  }

  const filters = send.audience.filters || {};
  const recipients = await resolveAudience(filters, { includeApplications: true });

  const snapshot = recipients.map(serializeSnapshot);
  const eligibilityBasis = 'subscriber_consent' + (Object.keys(filters).length > 0 ? ' + audience_filters' : '');

  const firstContext = snapshot.length > 0
    ? buildRecipientContext({ ...recipients[0], ...snapshot[0] }, send, config.baseUrl)
    : { unsubscribeUrl: '#' };
  const renderedPreview = renderCampaignBody(send.template, firstContext);

  const approvedAt = new Date();
  const approvalFingerprint = fingerprintApproval({
    templateName: send.template.name,
    templateVersion: send.template.version,
    templateSubject: send.template.subject,
    templateBody: send.template.body,
    audienceFilters: filters,
    recipientSnapshot: snapshot,
    actorId,
    approvedAt,
  });

  const status = send.scheduledAt && send.scheduledAt > approvedAt ? 'SCHEDULED' : 'APPROVED';

  return prisma.campaignSend.update({
    where: { id: sendId },
    data: {
      status,
      approvedBy: actorId,
      approvedAt,
      approvalFingerprint,
      templateVersion: send.template.version,
      templateName: send.template.name,
      templateSubject: send.template.subject,
      templateBody: send.template.body,
      audienceFilters: filters,
      recipientSnapshot: snapshot,
      renderedPreview,
      eligibilityBasis,
      previewCount: snapshot.length,
    },
  });
}

function isPrismaUniqueViolation(error) {
  return error?.code === 'P2002';
}

async function getNextAttemptNumber(campaignSendId, email) {
  const [agg] = await prisma.$queryRaw`
    SELECT MAX("attemptNumber") as max
    FROM "campaign_send_logs"
    WHERE "campaignSendId" = ${campaignSendId} AND "email" = ${email}
  `;
  return (Number(agg?.max) || 0) + 1;
}

async function deliverOneRecipient({ send, recipient, actorId, attemptNumber }) {
  const context = buildRecipientContext(recipient, send, config.baseUrl);
  const subject = renderCampaignSubject({ subject: send.templateSubject }, context);
  const html = renderCampaignBody({ body: send.templateBody }, context);

  const log = await prisma.campaignSendLog.create({
    data: {
      sendId: send.id,
      campaignSendId: send.id,
      candidateId: recipient.candidateId || null,
      email: recipient.email,
      attemptNumber,
      status: 'PENDING',
      actorId,
      templateName: send.templateName,
      templateVersion: send.templateVersion,
      subject,
      renderedBody: html,
    },
  });

  let result;
  try {
    result = await sendEmail(recipient.email, subject, html);
  } catch (error) {
    result = { success: false, error: error?.message || String(error) };
  }

  await prisma.campaignSendLog.update({
    where: { id: log.id },
    data: {
      status: result.success ? 'SENT' : 'FAILED',
      providerMessageId: result.messageId || null,
      error: result.error ? String(result.error).slice(0, 1000) : null,
      sentAt: new Date(),
    },
  });

  return { success: result.success, error: result.error };
}

async function executeSend({ send, actorId, recipients, attemptBase = 1 }) {
  const suppressed = await prisma.suppressedEmail.findMany({
    where: { email: { in: recipients.map((r) => r.email) } },
  });
  const suppressedSet = new Set(suppressed.map((s) => s.email));

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const recipient of recipients) {
    if (suppressedSet.has(recipient.email)) {
      continue;
    }

    // Re-verify the subscriber still consents at execution time.
    const subscriber = await prisma.subscriber.findUnique({ where: { email: recipient.email } });
    if (!subscriber || !subscriber.consented) {
      continue;
    }

    const attemptNumber = attemptBase === 'auto'
      ? await getNextAttemptNumber(send.id, recipient.email)
      : attemptBase;

    try {
      const outcome = await deliverOneRecipient({ send, recipient, actorId, attemptNumber });
      if (outcome.success) {
        sent++;
      } else {
        failed++;
        if (outcome.error) errors.push(`${recipient.email}: ${outcome.error}`);
      }
    } catch (error) {
      // A unique constraint means another worker already claimed this attempt.
      if (isPrismaUniqueViolation(error)) {
        continue;
      }
      failed++;
      errors.push(`${recipient.email}: ${error.message || String(error)}`);
    }
  }

  return { sent, failed, errors };
}

export async function sendCampaign(sendId, actorId, { force = false } = {}) {
  if (!config.bulkCampaignSendsEnabled) {
    throw new Error('Bulk campaign sends are disabled until policy decisions are recorded.');
  }

  const send = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { template: true, audience: true, cycle: true },
  });

  if (!send) throw new Error('Campaign send not found');

  if (!force && send.status === 'SENT') {
    throw new Error('Campaign already sent. Use force=true to resend.');
  }

  if (!['APPROVED', 'SCHEDULED'].includes(send.status) && !(force && send.status === 'SENT')) {
    throw new Error(`Send must be approved before sending (status: ${send.status})`);
  }

  if (send.status === 'SCHEDULED' && send.scheduledAt && send.scheduledAt > new Date()) {
    throw new Error(`Scheduled send is not due until ${send.scheduledAt.toISOString()}`);
  }

  // Atomic claim on the send so concurrent route and scheduler calls do not
  // both dispatch the same campaign.
  const claim = await prisma.campaignSend.updateMany({
    where: {
      id: sendId,
      status: { in: force && send.status === 'SENT' ? ['SENT'] : ['APPROVED', 'SCHEDULED'] },
    },
    data: { status: 'SENDING' },
  });

  if (claim.count === 0) {
    throw new Error('Campaign is already being sent or was already sent');
  }

  try {
    let recipients = send.recipientSnapshot || [];
    if (recipients.length === 0 && send.audience) {
      recipients = (await resolveAudience(send.audience.filters || {}, { includeApplications: true }))
        .map(serializeSnapshot);
    }

    if (recipients.length === 0) {
      await prisma.campaignSend.update({
        where: { id: sendId },
        data: { status: 'SENT', sentAt: new Date(), recipientCount: 0 },
      });
      return { sendId, sent: 0, failed: 0, total: 0 };
    }

    const { sent, failed, errors } = await executeSend({ send, actorId, recipients });

    const finalStatus = failed === recipients.length ? 'FAILED' : 'SENT';
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: {
        status: finalStatus,
        sentAt: new Date(),
        recipientCount: sent,
        errorLog: errors.length > 0 ? errors.join('\n').slice(0, 4000) : null,
      },
    });

    return { sendId, sent, failed, total: recipients.length };
  } catch (error) {
    // Revert SENDING so a retry can be attempted.
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: { status: send.status === 'SCHEDULED' ? 'SCHEDULED' : 'APPROVED' },
    });
    throw error;
  }
}

export async function retryFailedCampaignSend(sendId, actorId) {
  if (!config.bulkCampaignSendsEnabled) {
    throw new Error('Bulk campaign sends are disabled until policy decisions are recorded.');
  }

  const send = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { template: true, audience: true, cycle: true },
  });

  if (!send) throw new Error('Campaign send not found');
  if (!['SENT', 'FAILED'].includes(send.status)) {
    throw new Error(`Retry is not allowed from status ${send.status}`);
  }

  const claim = await prisma.campaignSend.updateMany({
    where: { id: sendId, status: { in: ['SENT', 'FAILED'] } },
    data: { status: 'SENDING' },
  });
  if (claim.count === 0) {
    throw new Error('Campaign is already being retried');
  }

  try {
    const failedLogs = await prisma.campaignSendLog.findMany({
      where: { campaignSendId: sendId, status: 'FAILED' },
    });

    if (failedLogs.length === 0) {
      await prisma.campaignSend.update({
        where: { id: sendId },
        data: { status: 'SENT' },
      });
      return { sendId, retried: 0, sent: 0, stillFailed: 0 };
    }

    const snapshot = send.recipientSnapshot || [];
    const recipients = failedLogs
      .map((log) => snapshot.find((s) => s.email === log.email) || { email: log.email, candidateId: log.candidateId })
      .filter(Boolean);

    const { sent, failed: stillFailed, errors } = await executeSend({
      send,
      actorId,
      recipients,
      attemptBase: 'auto',
    });

    const remainingFailed = await prisma.campaignSendLog.count({
      where: { campaignSendId: sendId, status: 'FAILED' },
    });

    const finalStatus = remainingFailed === 0 ? 'SENT' : 'FAILED';
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: {
        status: finalStatus,
        sentAt: new Date(),
        recipientCount: sent,
        errorLog: errors.length > 0 ? errors.join('\n').slice(0, 4000) : null,
      },
    });

    return { sendId, retried: failedLogs.length, sent, stillFailed, remainingFailed };
  } catch (error) {
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: { status: send.status },
    });
    throw error;
  }
}

export async function sendScheduledCampaigns() {
  const results = [];

  if (!config.bulkCampaignSendsEnabled) {
    return results;
  }

  const now = new Date();
  const scheduled = await prisma.campaignSend.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { lte: now },
      approvedBy: { not: null },
    },
    select: { id: true, sentBy: true },
  });

  for (const item of scheduled) {
    try {
      const result = await sendCampaign(item.id, item.sentBy);
      results.push({ id: item.id, ...result });
    } catch (error) {
      console.error(`[sendScheduledCampaigns] failed to send ${item.id}:`, error);
      results.push({ id: item.id, error: error.message });
    }
  }

  return results;
}

export async function getCandidateCampaignLogs({ candidateId, email, limit = 100 }) {
  const where = {};
  if (candidateId) where.candidateId = candidateId;
  if (email) where.email = email;

  return prisma.campaignSendLog.findMany({
    where,
    take: limit,
    include: {
      actor: { select: { id: true, fullName: true } },
      campaignSend: {
        include: {
          template: { select: { name: true, subject: true } },
          sender: { select: { id: true, fullName: true } },
          approver: { select: { id: true, fullName: true } },
          cycle: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { sentAt: 'desc' },
  });
}

export async function recordSuppression({ email, reason, source }) {
  if (!email) throw new Error('email is required');
  await addSuppressedEmail({ email, reason, source });
  const subscriber = await prisma.subscriber.findUnique({ where: { email } });
  if (subscriber) {
    await upsertSubscriber({
      email,
      consented: false,
      source: source || 'suppression',
      actorId: null,
    });
  }
  return { ok: true };
}
