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

function buildAudienceWhere(filters) {
  const where = {};
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
    where.applications = { some: applicationWhere };
  }

  return { candidateWhere: where, applicationWhere };
}

export async function resolveAudience(filters, options = {}) {
  const { candidateWhere, applicationWhere } = buildAudienceWhere(filters);
  const includeApplications = options.includeApplications !== false;

  const candidates = await prisma.candidate.findMany({
    where: candidateWhere,
    include: includeApplications
      ? {
          applications: {
            where: applicationWhere,
            include: { cycle: true },
            orderBy: { submittedAt: 'desc' },
            take: 1,
          },
        }
      : undefined,
  });

  let result = candidates;

  if (filters.excludeSuppressed !== false) {
    const emails = candidates.map((c) => c.email);
    const suppressed = await prisma.suppressedEmail.findMany({
      where: { email: { in: emails } },
    });
    const suppressedSet = new Set(suppressed.map((s) => s.email));
    result = candidates.filter((c) => !suppressedSet.has(c.email));
  }

  return result;
}

export async function previewAudience(filters) {
  const recipients = await resolveAudience(filters, { includeApplications: false });
  return {
    count: recipients.length,
    sample: recipients.slice(0, 5).map((c) => ({ id: c.id, email: c.email, name: `${c.firstName} ${c.lastName}` })),
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
  const status = scheduledAt && new Date(scheduledAt) > new Date() ? 'SCHEDULED' : 'DRAFT';
  return prisma.campaignSend.create({
    data: {
      name,
      cycleId,
      templateId,
      audienceId,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      sentBy,
      status,
    },
  });
}

export async function updateCampaignSend(id, data) {
  return prisma.campaignSend.update({ where: { id }, data });
}

export async function getCampaignSends(options = {}) {
  return prisma.campaignSend.findMany({
    where: options.cycleId ? { cycleId: options.cycleId } : undefined,
    include: {
      template: true,
      audience: true,
      cycle: true,
      sender: { select: { id: true, fullName: true } },
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
      logs: { orderBy: { sentAt: 'desc' } },
    },
  });
}

export async function getCandidateCampaignLogs({ candidateId, email }) {
  const where = {};
  if (candidateId) where.candidateId = candidateId;
  if (email) where.email = email;

  return prisma.campaignSendLog.findMany({
    where,
    include: {
      actor: { select: { id: true, fullName: true } },
      campaignSend: {
        include: {
          template: { select: { name: true, subject: true } },
          sender: { select: { id: true, fullName: true } },
          cycle: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { sentAt: 'desc' },
  });
}

export async function sendCampaign(sendId, actorId, { force = false } = {}) {
  const campaignSend = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { template: true, audience: true, cycle: true },
  });

  if (!campaignSend) throw new Error('Campaign send not found');
  if (!force && campaignSend.status === 'SENT') {
    throw new Error('Campaign already sent. Use force=true to resend.');
  }

  if (!campaignSend.audience && !campaignSend.template) {
    throw new Error('Campaign send must have a template and audience');
  }

  await prisma.campaignSend.update({
    where: { id: sendId },
    data: { status: 'SENDING', errorLog: null },
  });

  const filters = campaignSend.audience?.filters || {};
  const recipients = await resolveAudience(filters);
  const previewCount = recipients.length;

  await prisma.campaignSend.update({
    where: { id: sendId },
    data: { previewCount },
  });

  if (previewCount === 0) {
    await prisma.campaignSend.update({
      where: { id: sendId },
      data: { status: 'SENT', sentAt: new Date(), recipientCount: 0 },
    });
    return { sendId, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  const fromName = 'UConsulting ATS';

  for (const candidate of recipients) {
    const application = candidate.applications?.[0];
    const cycleName = campaignSend.cycle?.name || application?.cycle?.name || '';
    const stage = application?.currentRound || '';
    const status = application?.status || '';
    const token = generateUnsubscribeToken(candidate.email);
    const unsubscribeUrl = `${config.baseUrl}/api/unsubscribe?email=${encodeURIComponent(candidate.email)}&token=${encodeURIComponent(token)}`;

    const context = {
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      name: `${candidate.firstName} ${candidate.lastName}`.trim(),
      cycle: cycleName,
      stage,
      status,
      unsubscribeUrl,
    };

    const subject = renderCampaignSubject(campaignSend.template, context);
    const html = renderCampaignBody(campaignSend.template, context);

    const result = await sendEmail(candidate.email, subject, html);

    await prisma.campaignSendLog.create({
      data: {
        sendId,
        campaignSendId: sendId,
        candidateId: candidate.id,
        email: candidate.email,
        status: result.success ? 'SENT' : 'FAILED',
        providerMessageId: result.messageId || null,
        error: result.error ? String(result.error).slice(0, 1000) : null,
        sentAt: new Date(),
        actorId,
        templateName: campaignSend.template.name,
        subject,
      },
    });

    if (result.success) {
      sent++;
    } else {
      failed++;
      errors.push(`${candidate.email}: ${result.error}`);
    }
  }

  const finalStatus = failed === previewCount ? 'FAILED' : 'SENT';
  await prisma.campaignSend.update({
    where: { id: sendId },
    data: {
      status: finalStatus,
      sentAt: new Date(),
      recipientCount: sent,
      errorLog: errors.length > 0 ? errors.join('\n').slice(0, 4000) : null,
    },
  });

  return { sendId, sent, failed, total: previewCount };
}

export async function retryFailedCampaignSend(sendId, actorId) {
  const campaignSend = await prisma.campaignSend.findUnique({
    where: { id: sendId },
    include: { template: true, cycle: true },
  });

  if (!campaignSend) throw new Error('Campaign send not found');

  const failedLogs = await prisma.campaignSendLog.findMany({
    where: { campaignSendId: sendId, status: 'FAILED' },
    include: { candidate: { include: { applications: { include: { cycle: true }, orderBy: { submittedAt: 'desc' }, take: 1 } } } },
  });

  let sent = 0;
  let stillFailed = 0;

  for (const log of failedLogs) {
    const candidate = log.candidate;
    if (!candidate) continue;

    const application = candidate.applications?.[0];
    const cycleName = campaignSend.cycle?.name || application?.cycle?.name || '';
    const context = {
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      name: `${candidate.firstName} ${candidate.lastName}`.trim(),
      cycle: cycleName,
      stage: application?.currentRound || '',
      status: application?.status || '',
      unsubscribeUrl: `${config.baseUrl}/api/unsubscribe?email=${encodeURIComponent(candidate.email)}&token=${encodeURIComponent(generateUnsubscribeToken(candidate.email))}`,
    };

    const subject = renderCampaignSubject(campaignSend.template, context);
    const html = renderCampaignBody(campaignSend.template, context);
    const result = await sendEmail(candidate.email, subject, html);

    await prisma.campaignSendLog.update({
      where: { id: log.id },
      data: {
        status: result.success ? 'SENT' : 'FAILED',
        providerMessageId: result.messageId || null,
        error: result.error ? String(result.error).slice(0, 1000) : null,
        sentAt: new Date(),
        actorId,
        subject,
      },
    });

    if (result.success) sent++;
    else stillFailed++;
  }

  return { sendId, retried: failedLogs.length, sent, stillFailed };
}

export async function sendScheduledCampaigns() {
  const now = new Date();
  const scheduled = await prisma.campaignSend.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
    select: { id: true, sentBy: true },
  });

  const results = [];
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
