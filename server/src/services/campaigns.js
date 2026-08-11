import crypto from 'crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendEmail } from './emailNotifications.js';

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
  return crypto.createHmac('sha256', config.jwtSecret).update(email).digest('hex');
}

export function verifyUnsubscribeToken(token, email) {
  const expected = generateUnsubscribeToken(email);
  if (token !== expected) {
    throw new Error('Invalid unsubscribe token');
  }
  return email;
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
  const cycleName = recipient.cycle || send?.cycle?.name || application?.cycle?.name || '';
  const stage = recipient.stage || application?.currentRound || '';
  const status = recipient.status || application?.status || '';
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

function buildRenderedSnapshot(recipients, template, baseUrl) {
  const subjectTpl = template.templateSubject || template.subject || '';
  const bodyTpl = template.templateBody || template.body || '';
  return recipients
    .map((recipient) => {
      const snap = serializeSnapshot(recipient);
      const context = buildRecipientContext({ ...recipient, ...snap }, null, baseUrl);
      return {
        ...snap,
        renderedSubject: renderCampaignSubject({ subject: subjectTpl }, context),
        renderedBody: renderCampaignBody({ body: bodyTpl }, context),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

function buildApprovalBase({ templateName, templateVersion, templateSubject, templateBody, audienceFilters, recipientSnapshot }) {
  return JSON.stringify({
    templateName,
    templateVersion,
    templateSubject,
    templateBody,
    audienceFilters,
    recipientSnapshot: [...recipientSnapshot]
      .sort((a, b) => a.email.localeCompare(b.email)),
  });
}

function buildPreviewFingerprint({ templateName, templateVersion, templateSubject, templateBody, audienceFilters, recipientSnapshot }) {
  return crypto.createHash('sha256').update(buildApprovalBase({
    templateName, templateVersion, templateSubject, templateBody, audienceFilters, recipientSnapshot,
  })).digest('hex');
}

function fingerprintApproval({ templateName, templateVersion, templateSubject, templateBody, audienceFilters, recipientSnapshot, actorId, approvedAt }) {
  const base = buildApprovalBase({ templateName, templateVersion, templateSubject, templateBody, audienceFilters, recipientSnapshot });
  const canonical = JSON.stringify({
    base,
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

export async function approveCampaignSend({ sendId, actorId, approvalFingerprint: suppliedFingerprint }) {
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

  if (!suppliedFingerprint) {
    throw new Error('approvalFingerprint is required; preview the send first');
  }

  const filters = send.audience.filters || {};
  const recipients = await resolveAudience(filters, { includeApplications: true });

  const template = {
    templateSubject: send.templateSubject || send.template?.subject,
    templateBody: send.templateBody || send.template?.body,
  };
  const snapshot = buildRenderedSnapshot(recipients, template, config.baseUrl);
  const eligibilityBasis = 'subscriber_consent' + (Object.keys(filters).length > 0 ? ' + audience_filters' : '');

  const previewFingerprint = buildPreviewFingerprint({
    templateName: send.template.name,
    templateVersion: send.template.version,
    templateSubject: template.templateSubject,
    templateBody: template.templateBody,
    audienceFilters: filters,
    recipientSnapshot: snapshot,
  });

  if (previewFingerprint !== suppliedFingerprint) {
    throw new Error('Preview is stale or does not match the current audience/template. Please review the preview again.');
  }

  const renderedPreview = snapshot.length > 0 ? snapshot[0].renderedBody : '';

  const approvedAt = new Date();
  const approvalFingerprint = fingerprintApproval({
    templateName: send.template.name,
    templateVersion: send.template.version,
    templateSubject: template.templateSubject,
    templateBody: template.templateBody,
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
      templateSubject: template.templateSubject,
      templateBody: template.templateBody,
      audienceFilters: filters,
      recipientSnapshot: snapshot,
      renderedPreview,
      eligibilityBasis,
      previewCount: snapshot.length,
    },
  });
}

export async function previewCampaignSend({ sendId }) {
  const send = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { template: true, audience: true, cycle: true },
  });

  if (!send) throw new Error('Campaign send not found');
  if (!send.template || !send.audience) {
    throw new Error('Send must have a template and an audience');
  }

  const filters = send.audience.filters || {};
  const recipients = await resolveAudience(filters, { includeApplications: true });

  const template = {
    templateSubject: send.templateSubject || send.template?.subject,
    templateBody: send.templateBody || send.template?.body,
  };
  const snapshot = buildRenderedSnapshot(recipients, template, config.baseUrl);
  const renderedPreview = snapshot.length > 0 ? snapshot[0].renderedBody : '';

  const approvalFingerprint = buildPreviewFingerprint({
    templateName: send.template.name,
    templateVersion: send.template.version,
    templateSubject: template.templateSubject,
    templateBody: template.templateBody,
    audienceFilters: filters,
    recipientSnapshot: snapshot,
  });

  return {
    sendId,
    count: snapshot.length,
    sample: snapshot.slice(0, 10),
    renderedPreview,
    recipientSnapshot: snapshot,
    approvalFingerprint,
  };
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
  const subject = recipient.renderedSubject || renderCampaignSubject({ subject: send.templateSubject }, context);
  const html = recipient.renderedBody || renderCampaignBody({ body: send.templateBody }, context);

  // The PENDING log acts as a durable intent/outbox record. Its unique
  // (campaignSendId, email, attemptNumber) constraint ensures only one SES
  // effect per recipient per attempt, even when routes and the scheduler race.
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

  try {
    await prisma.campaignSendLog.update({
      where: { id: log.id },
      data: {
        status: result.success ? 'SENT' : 'FAILED',
        providerMessageId: result.messageId || null,
        error: result.error ? String(result.error).slice(0, 1000) : null,
        sentAt: new Date(),
      },
    });
  } catch (updateError) {
    console.error(`[deliverOneRecipient] failed to persist outcome for ${recipient.email}:`, updateError);
    // If the provider accepted the message but the audit log update failed, the
    // PENDING intent record remains. Try to mark it AMBIGUOUS so a later
    // reconciliation run can surface it. If that also fails, return an explicit
    // ambiguous outcome without a second SES effect.
    if (result.success) {
      try {
        await prisma.campaignSendLog.update({
          where: { id: log.id },
          data: {
            status: 'AMBIGUOUS',
            providerMessageId: result.messageId || null,
            error: String(updateError).slice(0, 1000),
          },
        });
      } catch {
        // ignored
      }
      return { success: true, ambiguous: true, messageId: result.messageId, error: String(updateError).slice(0, 1000) };
    }
    return { success: false, error: result.error };
  }

  return { success: result.success, error: result.error };
}

function getLatestLogByEmail(logs) {
  const latestByEmail = new Map();
  for (const log of logs) {
    const existing = latestByEmail.get(log.email);
    if (!existing || log.attemptNumber > existing.attemptNumber) {
      latestByEmail.set(log.email, log);
    }
  }
  return latestByEmail;
}

function computeCampaignSendStatus(outcomes) {
  const hasPendingOrAmbiguous = outcomes.some((s) => ['PENDING', 'AMBIGUOUS'].includes(s));
  const hasFailed = outcomes.some((s) => s === 'FAILED');
  const hasSent = outcomes.some((s) => s === 'SENT');
  if (hasPendingOrAmbiguous) return 'SENDING';
  if (hasFailed) return hasSent ? 'SENT' : 'FAILED';
  return 'SENT';
}

async function recomputeCampaignSendStatus(sendId) {
  if (!sendId) return;
  const send = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { logs: true },
  });
  if (!send) return;

  const latestByEmail = getLatestLogByEmail(send.logs || []);
  const latest = Array.from(latestByEmail.values());
  const status = computeCampaignSendStatus(latest.map((l) => l.status));

  if (status !== send.status) {
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: {
        status,
        sentAt: status === 'SENT' ? new Date() : send.sentAt,
        recipientCount: latest.filter((l) => l.status === 'SENT').length,
      },
    });
  }
}

async function executeSend({ send, actorId, recipients, attemptBase = 1 }) {
  const suppressed = await prisma.suppressedEmail.findMany({
    where: { email: { in: recipients.map((r) => r.email) } },
  });
  const suppressedSet = new Set(suppressed.map((s) => s.email));

  let sent = 0;
  let failed = 0;
  let ambiguous = 0;
  const errors = [];
  const outcomes = [];

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
        if (outcome.ambiguous) {
          ambiguous++;
          errors.push(`${recipient.email}: provider accepted but audit log write failed`);
          outcomes.push({ email: recipient.email, status: 'AMBIGUOUS' });
        } else {
          outcomes.push({ email: recipient.email, status: 'SENT' });
        }
      } else {
        failed++;
        if (outcome.error) errors.push(`${recipient.email}: ${outcome.error}`);
        outcomes.push({ email: recipient.email, status: 'FAILED' });
      }
    } catch (error) {
      // A unique constraint means another worker already claimed this attempt.
      if (isPrismaUniqueViolation(error)) {
        continue;
      }
      failed++;
      errors.push(`${recipient.email}: ${error.message || String(error)}`);
      outcomes.push({ email: recipient.email, status: 'FAILED' });
    }
  }

  return { sent, failed, ambiguous, errors, outcomes };
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
      recipients = buildRenderedSnapshot(
        await resolveAudience(send.audience.filters || {}, { includeApplications: true }),
        send,
        config.baseUrl,
      );
    }

    if (recipients.length === 0) {
      await prisma.campaignSend.update({
        where: { id: sendId },
        data: { status: 'SENT', sentAt: new Date(), recipientCount: 0 },
      });
      return { sendId, sent: 0, failed: 0, total: 0 };
    }

    const { sent, failed, ambiguous, errors, outcomes } = await executeSend({ send, actorId, recipients });
    const resolvedSent = outcomes.filter((o) => o.status === 'SENT').length;
    const finalStatus = computeCampaignSendStatus(outcomes.map((o) => o.status));

    await prisma.campaignSend.update({
      where: { id: sendId },
      data: {
        status: finalStatus,
        sentAt: finalStatus === 'SENDING' ? undefined : new Date(),
        recipientCount: resolvedSent,
        errorLog: errors.length > 0 ? errors.join('\n').slice(0, 4000) : null,
      },
    });

    return { sendId, sent, failed, ambiguous, total: recipients.length };
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
    const allLogs = await prisma.campaignSendLog.findMany({
      where: { campaignSendId: sendId },
      orderBy: { attemptNumber: 'asc' },
    });

    // Only retry a recipient whose latest attempt is FAILED. A later SENT log
    // means the recipient was already delivered successfully.
    const latestByEmail = getLatestLogByEmail(allLogs);
    const failedLogs = Array.from(latestByEmail.values()).filter((log) => log.status === 'FAILED');

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

    const { sent, failed: stillFailed, errors, outcomes } = await executeSend({
      send,
      actorId,
      recipients,
      attemptBase: 'auto',
    });

    // Apply the new attempt outcomes to compute each recipient's latest status.
    for (const outcome of outcomes) {
      latestByEmail.set(outcome.email, { ...latestByEmail.get(outcome.email), status: outcome.status });
    }

    const latest = Array.from(latestByEmail.values());
    const resolvedSent = latest.filter((log) => log.status === 'SENT').length;
    const remainingFailed = latest.filter((log) => log.status === 'FAILED').length;

    const finalStatus = computeCampaignSendStatus(latest.map((log) => log.status));
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: {
        status: finalStatus,
        sentAt: finalStatus === 'SENDING' ? send.sentAt : new Date(),
        recipientCount: resolvedSent,
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

export async function reconcileCampaignLogs({ olderThanMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const cutoff = new Date(now - olderThanMs);

  const pending = await prisma.campaignSendLog.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
    },
  });

  const results = [];
  const sendIds = new Set();
  for (const log of pending) {
    try {
      await prisma.campaignSendLog.update({
        where: { id: log.id },
        data: { status: 'AMBIGUOUS', sentAt: new Date() },
      });
      results.push({ id: log.id, status: 'AMBIGUOUS' });
      if (log.campaignSendId) sendIds.add(log.campaignSendId);
    } catch (error) {
      results.push({ id: log.id, error: error.message });
    }
  }

  for (const sendId of sendIds) {
    try {
      await recomputeCampaignSendStatus(sendId);
    } catch (error) {
      console.error(`[reconcileCampaignLogs] failed to recompute send ${sendId}:`, error);
    }
  }

  return results;
}

export async function resolveCampaignLog({ logId, actorId, status, reason }) {
  if (!['SENT', 'FAILED'].includes(status)) {
    throw new Error('Resolution status must be SENT or FAILED');
  }

  const result = await prisma.$transaction(async (tx) => {
    const log = await tx.campaignSendLog.findUnique({
      where: { id: logId },
      select: { id: true, status: true, sentAt: true, campaignSendId: true },
    });
    if (!log) throw new Error('Campaign send log not found');
    if (!['PENDING', 'AMBIGUOUS'].includes(log.status)) {
      throw new Error(`Log status ${log.status} cannot be resolved`);
    }

    const updateResult = await tx.campaignSendLog.updateMany({
      where: {
        id: logId,
        status: { in: ['PENDING', 'AMBIGUOUS'] },
      },
      data: {
        status,
        sentAt: status === 'SENT' ? new Date() : log.sentAt,
      },
    });
    if (updateResult.count === 0) {
      throw new Error('Log is not resolvable or already resolved');
    }

    await tx.campaignSendLogResolution.create({
      data: {
        logId,
        status,
        reason: reason || null,
        actorId,
      },
    });

    return { ...log, status, sentAt: status === 'SENT' ? new Date() : log.sentAt };
  });

  if (result.campaignSendId) {
    await recomputeCampaignSendStatus(result.campaignSendId);
  }

  return result;
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
