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

    if (filters.cycleId) where.cycleId = filters.cycleId;
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
      },
    });

    return applications.map((a) => ({
      id: a.id,
      email: a.email,
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
    await prisma.messageLog.create({
      data: { templateId, channel, recipientCount, subject, body, sentBy, cycleId },
    });
  } catch (e) {
    console.error('[masterCommunications] failed to log message:', e);
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
    await logMessage({ templateId, channel, recipientCount: recipients.length, subject, body, sentBy, cycleId });
    return { channel, audience, sent: recipients.length, failed: 0, total: recipients.length };
  }

  const results = await Promise.all(
    recipients.map(async (r) => {
      const result = await sendEmail(r.email, subject, body);
      return { recipientId: r.id, ...result };
    })
  );

  const sent = results.filter((r) => r.success).length;
  const failed = results.length - sent;

  await logMessage({ templateId, channel, recipientCount: results.length, subject, body, sentBy, cycleId });

  return { channel, audience, sent, failed, total: results.length, results };
}
