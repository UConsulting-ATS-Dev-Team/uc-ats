import { marked } from 'marked';
import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { sendSlackMessage } from './slackService.js';

const VALID_CHANNELS = ['email', 'slack', 'imessage'];

const ROUND_DECISION_FIELDS = {
  COFFEE_CHAT: 'coffeeChatDecision',
  ROUND_ONE: 'firstRoundDecision',
  FINAL_ROUND: 'finalRoundDecision',
};

function fullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim();
}

function resolveDecisionField(round) {
  return ROUND_DECISION_FIELDS[round] || null;
}

function dedupeApplicants(applications) {
  const seen = new Map();
  const sorted = [...applications].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const a of sorted) {
    const key = a.candidateId || a.email.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, a);
    }
  }
  return [...seen.values()];
}

const MERGE_FIELDS = {
  applicant: {
    firstName: (r) => r.firstName || '',
    lastName: (r) => r.lastName || '',
    fullName: (r) => r.fullName,
    email: (r) => r.email,
    phoneNumber: (r) => r.phoneNumber || '',
  },
  user: {
    firstName: (r) => r.fullName?.split(' ')[0] || '',
    lastName: (r) => r.fullName?.split(' ').slice(1).join(' ') || '',
    fullName: (r) => r.fullName,
    email: (r) => r.email,
    role: (r) => r.role || '',
  },
};

function renderMessage(text, recipient) {
  if (!text) return text;
  const fields = MERGE_FIELDS[recipient.audience] || MERGE_FIELDS.user;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const resolver = fields[key];
    return resolver ? resolver(recipient) : match;
  });
}

async function withConcurrency(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const workers = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const { item, index } = queue.shift();
          results[index] = await fn(item);
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}

function markdownToHtml(text) {
  if (!text) return text;
  return marked.parse(text, { breaks: true });
}

async function sendBulkEmails({ recipients, baseSubject, baseBody, concurrency = 5, retries = 2 }) {
  return withConcurrency(
    recipients,
    async (r) => {
      const subject = renderMessage(baseSubject, r);
      const body = renderMessage(baseBody, r);
      const htmlBody = markdownToHtml(body);
      let lastError = 'Unknown error';

      for (let attempt = 0; attempt <= retries; attempt++) {
        const result = await sendEmail(r.email, subject, htmlBody);
        if (result.success) {
          return { recipientId: r.id, ...result };
        }
        lastError = result.error || 'Send failed';
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }

      return { recipientId: r.id, success: false, error: lastError };
    },
    concurrency
  );
}

async function notifyFailures({ channel, audience, failed, total, results }) {
  if (failed === 0) return;
  try {
    const failures = results.filter((r) => !r.success).slice(0, 5);
    const sample = failures
      .map((r) => `• ${r.recipientId}${r.error ? ` — ${r.error}` : ''}`)
      .join('\n');
    const text = `⚠️ Master Communications bulk send finished for ${channel} to ${audience}.\n` +
      `Delivered: ${total - failed} / ${total}\nFailed: ${failed}\nSample failures:\n${sample}`;
    await sendSlackMessage({ text });
  } catch (e) {
    console.error('[masterCommunications] Slack failure notification failed:', e);
  }
}

export async function listTemplates({ cycleId }) {
  const where = cycleId ? { cycleId } : {};
  return prisma.messageTemplate.findMany({
    where,
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      subject: true,
      body: true,
      channel: true,
      cycleId: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function createTemplate({ name, subject, body, channel, cycleId, createdBy }) {
  if (!name || !body || !channel || !cycleId || !createdBy) {
    const err = new Error('name, body, channel, cycleId, and createdBy are required');
    err.status = 400;
    throw err;
  }
  return prisma.messageTemplate.create({
    data: {
      name,
      subject: subject || '',
      body,
      channel,
      cycleId,
      createdBy,
    },
    select: {
      id: true,
      name: true,
      subject: true,
      body: true,
      channel: true,
      cycleId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function listLogs({ cycleId, limit = 50 }) {
  const where = cycleId ? { cycleId } : {};
  return prisma.messageLog.findMany({
    where,
    orderBy: { sentAt: 'desc' },
    take: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
    include: {
      template: { select: { id: true, name: true } },
      sender: { select: { id: true, fullName: true } },
      cycle: { select: { id: true, name: true } },
    },
  });
}

export async function resolveRecipients({ audience, filters = {} }) {
  if (audience === 'applicants') {
    const where = {};

    if (filters.cycleIds?.length > 0) where.cycleId = { in: filters.cycleIds };
    if (filters.applicationStatus) where.status = filters.applicationStatus;

    const candidateWhere = {};
    if (filters.eventRsvpId) candidateWhere.eventRsvp = { some: { eventId: filters.eventRsvpId } };
    if (filters.eventAttendedId) candidateWhere.eventAttendance = { some: { eventId: filters.eventAttendedId } };
    if (Object.keys(candidateWhere).length > 0) where.candidate = candidateWhere;

    if (filters.interviewRound && filters.decision) {
      const decisionField = resolveDecisionField(filters.interviewRound);
      if (!decisionField) {
        const err = new Error(`Unsupported interview round: ${filters.interviewRound}`);
        err.status = 400;
        throw err;
      }
      where[decisionField] = filters.decision;
    }

    const applications = await prisma.application.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        cycleId: true,
        candidateId: true,
        createdAt: true,
      },
    });

    const unique = dedupeApplicants(applications);

    return unique.map((a) => ({
      id: a.id,
      email: a.email,
      firstName: a.firstName || '',
      lastName: a.lastName || '',
      fullName: fullName(a.firstName, a.lastName),
      phoneNumber: a.phoneNumber,
      audience: 'applicant',
      cycleId: a.cycleId,
    }));
  }

  if (audience === 'members' || audience === 'users') {
    const roles = filters.roles?.length ? filters.roles : ['MEMBER'];
    const users = await prisma.user.findMany({
      where: { role: { in: roles } },
      select: { id: true, email: true, fullName: true, role: true },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      audience: 'user',
      role: u.role,
    }));
  }

  if (audience === 'admins') {
    const users = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, email: true, fullName: true, role: true },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      audience: 'user',
      role: u.role,
    }));
  }

  const err = new Error(`Unsupported audience: ${audience}`);
  err.status = 400;
  throw err;
}

function formatImessagePacket(recipients) {
  return recipients
    .filter((r) => r.phoneNumber)
    .map((r) => ({ fullName: r.fullName, phoneNumber: r.phoneNumber, label: `${r.fullName} — ${r.phoneNumber}` }));
}

async function logMessage({ templateId, channel, recipientCount, subject, body, sentBy, cycleId }) {
  try {
    const log = await prisma.messageLog.create({
      data: { templateId, channel, recipientCount, subject, body, sentBy, cycleId },
    });
    return log.id;
  } catch (e) {
    console.error('[masterCommunications] failed to log message:', e);
    return null;
  }
}

export async function previewMasterCommunication({ audience, filters }) {
  const recipients = await resolveRecipients({ audience, filters });
  return {
    audience,
    count: recipients.length,
    sample: recipients.slice(0, 10).map((r) => ({
      id: r.id,
      fullName: r.fullName,
      email: r.email,
      phoneNumber: r.phoneNumber,
    })),
  };
}

export async function buildImessagePacket({ filters }) {
  const recipients = await resolveRecipients({ audience: 'applicants', filters });
  const withPhone = recipients.filter((r) => r.phoneNumber);
  return { count: withPhone.length, recipients: formatImessagePacket(withPhone) };
}

export async function sendMasterCommunication({
  audience,
  channel,
  filters,
  subject,
  body,
  sentBy,
  cycleId,
  templateId,
}) {
  if (!VALID_CHANNELS.includes(channel)) {
    const err = new Error(`Unsupported channel: ${channel}`);
    err.status = 400;
    throw err;
  }

  const recipients = await resolveRecipients({ audience, filters });

  if (channel === 'imessage') {
    const withPhone = recipients.filter((r) => r.phoneNumber);
    return { channel, audience, count: withPhone.length, recipients: formatImessagePacket(withPhone) };
  }

  if (channel === 'slack') {
    const hasNonUser = recipients.some((r) => r.audience !== 'user');
    if (hasNonUser) {
      const err = new Error('Slack messages can only be sent to users');
      err.status = 400;
      throw err;
    }
    await sendSlackMessage({ text: body });
    const logId = await logMessage({ templateId, channel, recipientCount: recipients.length, subject, body, sentBy, cycleId });
    return { channel, audience, sent: recipients.length, failed: 0, total: recipients.length, logId };
  }

  const results = await sendBulkEmails({
    recipients,
    baseSubject: subject,
    baseBody: body,
    concurrency: 5,
    retries: 2,
  });

  const sent = results.filter((r) => r.success).length;
  const failed = results.length - sent;

  const logId = await logMessage({ templateId, channel, recipientCount: results.length, subject, body, sentBy, cycleId });

  await notifyFailures({ channel, audience, failed, total: results.length, results });

  return { channel, audience, sent, failed, total: results.length, results, logId };
}

export async function scheduleMessage({
  channel,
  audience,
  filters,
  subject,
  body,
  cycleId,
  templateId,
  sentBy,
  scheduledAt,
}) {
  if (!scheduledAt) {
    const err = new Error('scheduledAt is required');
    err.status = 400;
    throw err;
  }
  return prisma.messageSchedule.create({
    data: {
      channel,
      audience,
      filters,
      subject,
      body,
      cycleId,
      templateId,
      sentBy,
      scheduledAt: new Date(scheduledAt),
      status: 'PENDING',
    },
    select: {
      id: true,
      channel: true,
      audience: true,
      scheduledAt: true,
      status: true,
      cycleId: true,
      templateId: true,
    },
  });
}

export async function listScheduledMessages({ cycleId, status, limit = 50 }) {
  const where = {};
  if (cycleId) where.cycleId = cycleId;
  if (status) where.status = status;
  return prisma.messageSchedule.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    take: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
    select: {
      id: true,
      channel: true,
      audience: true,
      scheduledAt: true,
      status: true,
      subject: true,
      body: true,
      cycleId: true,
      templateId: true,
      createdAt: true,
    },
  });
}

export async function cancelScheduledMessage({ id, sentBy }) {
  const schedule = await prisma.messageSchedule.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!schedule) {
    const err = new Error('Scheduled message not found');
    err.status = 404;
    throw err;
  }
  if (schedule.status !== 'PENDING') {
    const err = new Error('Only pending messages can be cancelled');
    err.status = 400;
    throw err;
  }
  return prisma.messageSchedule.update({
    where: { id },
    data: { status: 'CANCELLED' },
    select: { id: true, status: true },
  });
}

export async function processScheduledMessages() {
  const now = new Date();
  const pending = await prisma.messageSchedule.findMany({
    where: { status: 'PENDING', scheduledAt: { lte: now } },
    orderBy: { scheduledAt: 'asc' },
  });

  for (const s of pending) {
    try {
      const result = await sendMasterCommunication({
        audience: s.audience,
        channel: s.channel,
        filters: s.filters || {},
        subject: s.subject,
        body: s.body,
        sentBy: s.sentBy,
        cycleId: s.cycleId,
        templateId: s.templateId,
      });
      await prisma.messageSchedule.update({
        where: { id: s.id },
        data: { status: 'SENT', messageLogId: result.logId },
      });
    } catch (e) {
      console.error('[masterCommunications] scheduled send failed:', e);
      await prisma.messageSchedule.update({
        where: { id: s.id },
        data: { status: 'FAILED' },
      });
    }
  }

  return pending.length;
}
