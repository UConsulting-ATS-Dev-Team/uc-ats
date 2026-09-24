import { marked } from 'marked';
import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { sendSlackMessage } from './slackService.js';
import { recordCommunications } from './communicationLog.js';
import { resolveAudience, summarizeSources } from './audiences/audiencePeople.js';
import { normalizeAudienceTree } from './audiences/audienceFilters.js';
import { getSavedAudience, markSavedAudienceUsed } from './audiences/savedAudiences.js';
import { applySuppressions, unsubscribeFooterHtml, unsubscribeUrls } from './emailSuppression.js';

// Channels the server delivers itself. iMessage is absent on purpose: it leaves
// from the admin's Messages app, so it can be neither sent nor scheduled here.
const SERVER_SENT_CHANNELS = ['email', 'slack'];

function assertServerSentChannel(channel) {
  if (SERVER_SENT_CHANNELS.includes(channel)) return;
  const err = new Error(
    channel === 'imessage'
      ? 'iMessage is sent from the Messages app, not by the server'
      : `Unsupported channel: ${channel}`
  );
  err.status = 400;
  throw err;
}

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
  const sorted = [...applications].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  for (const a of sorted) {
    const key = a.candidateId || a.email.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, a);
    }
  }
  return [...seen.values()];
}

const PERSON_MERGE_FIELDS = {
  firstName: (r) => r.firstName || '',
  lastName: (r) => r.lastName || '',
  fullName: (r) => r.fullName,
  email: (r) => r.email,
};

const MERGE_FIELDS = {
  // Anyone reached through a filtered audience (audiences/audiencePeople.js).
  person: PERSON_MERGE_FIELDS,
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
  'mailing-list': {
    firstName: (r) => r.firstName || '',
    lastName: (r) => r.lastName || '',
    fullName: (r) => r.fullName,
    email: (r) => r.email,
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

async function sendBulkEmails({ recipients, baseSubject, baseBody, concurrency = 5, retries = 2, meta = {} }) {
  return withConcurrency(
    recipients,
    async (r) => {
      const subject = renderMessage(baseSubject, r);
      const body = renderMessage(baseBody, r);
      // Marketing mail - anything to someone who is not active staff - carries
      // an unsubscribe link in the footer and in the headers. applySuppressions
      // has already held back whoever used one.
      const unsubscribe = r.marketing ? unsubscribeUrls(r.email) : null;
      const htmlBody = markdownToHtml(body) + (unsubscribe ? unsubscribeFooterHtml(unsubscribe.page) : '');
      let lastError = 'Unknown error';

      for (let attempt = 0; attempt <= retries; attempt++) {
        const result = await sendEmail(r.email, subject, htmlBody, [], {
          ...meta,
          listUnsubscribeUrl: unsubscribe?.oneClick ?? null,
          recipientName: r.fullName || null,
          // Stable across this recipient's retries, so three attempts leave one
          // row showing how the send ended, not three showing how it went.
          attemptKey: meta.messageLogId ? `campaign:${meta.messageLogId}:${r.id}` : null,
        });
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
    await sendSlackMessage({ text }, { category: 'MASTER_COMMUNICATION' });
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
  // The filter builder: any mix of sources and rules, combined with AND, OR and
  // NOT (audiences/audienceFilters.js). The other audiences below predate it
  // and stay for Slack, iMessage and the drafts and schedules saved with them.
  if (audience === 'custom') {
    const { recipients } = await resolveAudience(filters);
    return recipients;
  }

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
        submittedAt: true,
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
      // Deactivated accounts are excluded. They are people who have left -
      // graduated members, removed admins - and without this a send to
      // "members" reached all 55 accounts rather than the 45 active ones,
      // putting org mail in the inboxes of ten people who are no longer here.
      where: { role: { in: roles }, isActive: true },
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
      // Same rule as the members branch above.
      where: { role: 'ADMIN', isActive: true },
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

  // People imported from the retired recruiting-interest mailing list. They
  // have no account and no application, so no filter applies to them.
  if (audience === 'mailing-list') {
    const contacts = await prisma.mailingListContact.findMany({
      select: { id: true, email: true, firstName: true, lastName: true },
      orderBy: { createdAt: 'asc' },
    });
    return contacts.map((c) => ({
      id: c.id,
      email: c.email,
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName: fullName(c.firstName, c.lastName),
      audience: 'mailing-list',
    }));
  }

  const err = new Error(`Unsupported audience: ${audience}`);
  err.status = 400;
  throw err;
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

/**
 * What a send is addressed to. A saved audience wins over whatever filters came
 * with the request: it is read fresh, so a draft or schedule that points at one
 * reaches whoever matches it now, not whoever matched when it was written.
 */
async function resolveAudienceSpec({ audience, filters, savedAudienceId }) {
  if (savedAudienceId) {
    const saved = await getSavedAudience(savedAudienceId);
    return { audience: 'custom', filters: saved.filters, savedAudience: saved };
  }
  if (audience === 'custom') {
    return { audience, filters: normalizeAudienceTree(filters), savedAudience: null };
  }
  return { audience, filters: filters || {}, savedAudience: null };
}

export async function previewMasterCommunication({ audience, filters, savedAudienceId }) {
  const spec = await resolveAudienceSpec({ audience, filters, savedAudienceId });
  const resolved = await resolveRecipients(spec);
  const { deliver, skipped } = await applySuppressions(resolved);
  return {
    audience: spec.audience,
    count: deliver.length,
    // Held back because they unsubscribed. Shown rather than silently dropped,
    // so the count on the send button can be reconciled with the filters.
    skipped: skipped.length,
    // How many will get the unsubscribe footer; the rest are staff.
    marketing: deliver.filter((r) => r.marketing).length,
    sources: spec.audience === 'custom' ? summarizeSources(deliver) : null,
    savedAudience: spec.savedAudience
      ? { id: spec.savedAudience.id, lastUsedAt: spec.savedAudience.lastUsedAt, lastUsedCount: spec.savedAudience.lastUsedCount }
      : null,
    sample: deliver.slice(0, 10).map((r) => ({
      id: r.id,
      fullName: r.fullName,
      email: r.email,
      phoneNumber: r.phoneNumber,
      sources: r.sources,
    })),
  };
}

// iMessage is sent from the admin's own Messages app (an sms:// link opened in
// the browser), so the server never delivers it. It only lists who can be
// reached and records that a send happened.

export async function listImessageMembers() {
  return prisma.user.findMany({
    // Same active-staff rule as the members audience in resolveRecipients.
    where: { role: { in: ['ADMIN', 'MEMBER'] }, isActive: true },
    select: { id: true, fullName: true, email: true, role: true, profileImage: true, phoneNumber: true },
    orderBy: { fullName: 'asc' },
  });
}

export async function logImessageSend({ recipientIds, body, templateId, cycleId, sentBy }) {
  if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
    const err = new Error('recipientIds must be a non-empty array');
    err.status = 400;
    throw err;
  }
  if (!body || typeof body !== 'string') {
    const err = new Error('body is required');
    err.status = 400;
    throw err;
  }
  const logId = await logMessage({
    templateId: templateId || null,
    channel: 'imessage',
    recipientCount: new Set(recipientIds).size,
    body,
    sentBy,
    cycleId: cycleId || null,
  });
  // logMessage swallows its own write failure and answers null, which is right
  // for email: the mail already went out and failing the request would be a lie
  // in the other direction. iMessage is the opposite. The client has already
  // opened Messages by the time it calls this, so the log is the only record
  // the send ever happened, and a silent 201 loses it for good.
  if (logId == null) {
    const err = new Error('Messages opened, but the send could not be logged');
    err.status = 500;
    throw err;
  }

  // A row per person, so a search for someone's name or number turns up the
  // iMessage alongside their email. Status is OPENED rather than SENT for the
  // reason the campaign log already gives: Messages is not ours to observe.
  const members = await prisma.user.findMany({
    where: { id: { in: [...new Set(recipientIds)] } },
    select: { id: true, fullName: true, email: true, phoneNumber: true },
  });
  await recordCommunications(
    members.map((m) => ({
      channel: 'imessage',
      category: 'MASTER_COMMUNICATION',
      trigger: 'MANUAL',
      status: 'OPENED',
      recipient: m.phoneNumber || m.email,
      recipientName: m.fullName,
      body,
      triggeredById: sentBy,
      cycleId: cycleId || null,
      messageLogId: logId,
    }))
  );

  return { logId };
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
  savedAudienceId,
}) {
  assertServerSentChannel(channel);

  const spec = await resolveAudienceSpec({ audience, filters, savedAudienceId });
  if (channel === 'slack' && spec.audience === 'custom') {
    const err = new Error('Slack messages can only be sent to members or admins');
    err.status = 400;
    throw err;
  }
  const resolved = await resolveRecipients(spec);

  if (channel === 'slack') {
    const recipients = resolved;
    const hasNonUser = recipients.some((r) => r.audience !== 'user');
    if (hasNonUser) {
      const err = new Error('Slack messages can only be sent to users');
      err.status = 400;
      throw err;
    }
    // Sent before it is logged, unlike the email path below. sendSlackMessage
    // throws when the webhook rejects, and a campaign row written first would
    // survive that throw and claim a broadcast that never happened. One Slack
    // post is one message, so nothing here needs a campaign id to point at.
    await sendSlackMessage(
      { text: body },
      {
        category: 'MASTER_COMMUNICATION',
        trigger: 'MANUAL',
        subject,
        triggeredById: sentBy,
        cycleId: cycleId || null,
      }
    );
    const logId = await logMessage({ templateId, channel, recipientCount: recipients.length, subject, body, sentBy, cycleId });
    return { channel, audience, sent: recipients.length, failed: 0, total: recipients.length, logId };
  }

  const { deliver: recipients, skipped } = await applySuppressions(resolved);

  // Written before the send, not after it, so each per-recipient row in
  // communication_logs can name the campaign it belonged to. recipientCount is
  // the size of the audience either way - sendBulkEmails returns one result per
  // recipient whether or not the mail got through.
  const logId = await logMessage({ templateId, channel, recipientCount: recipients.length, subject, body, sentBy, cycleId });

  const results = await sendBulkEmails({
    recipients,
    baseSubject: subject,
    baseBody: body,
    concurrency: 5,
    retries: 2,
    meta: {
      category: 'MASTER_COMMUNICATION',
      trigger: 'MANUAL',
      triggeredById: sentBy,
      cycleId: cycleId || null,
      messageLogId: logId,
    },
  });

  const sent = results.filter((r) => r.success).length;
  const failed = results.length - sent;

  await notifyFailures({ channel, audience: spec.savedAudience?.name || spec.audience, failed, total: results.length, results });
  if (spec.savedAudience) await markSavedAudienceUsed(spec.savedAudience.id, recipients.length);

  return {
    channel,
    audience: spec.audience,
    sent,
    failed,
    total: results.length,
    skipped: skipped.length,
    results,
    logId,
  };
}

export async function scheduleMessage({
  channel,
  audience,
  filters,
  subject,
  body,
  cycleId,
  templateId,
  savedAudienceId,
  sentBy,
  scheduledAt,
}) {
  if (!scheduledAt) {
    const err = new Error('scheduledAt is required');
    err.status = 400;
    throw err;
  }
  assertServerSentChannel(channel);
  // Checked now rather than when it fires: a schedule that can only fail is
  // better refused while the admin is still looking at it.
  const spec = await resolveAudienceSpec({ audience, filters, savedAudienceId });
  return prisma.messageSchedule.create({
    data: {
      channel,
      audience: spec.audience,
      // A copy of the saved audience's filters, used if it is deleted before
      // this fires.
      filters: spec.filters,
      savedAudienceId: spec.savedAudience?.id || null,
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
      savedAudience: { select: { id: true, name: true } },
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
        savedAudienceId: s.savedAudienceId,
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

// Sends the composed message to whoever pressed the button, so an admin can see
// the real thing — merge fields resolved, markdown rendered — before it goes to
// hundreds of people. Deliberately not logged to messageLog: a test is not a send.
export async function sendTestCommunication({ audience, filters, savedAudienceId, subject, body, user }) {
  if (!user?.email) {
    const err = new Error('No email address on the requesting account');
    err.status = 400;
    throw err;
  }
  if (!subject || !body) {
    const err = new Error('subject and body are required');
    err.status = 400;
    throw err;
  }

  // Render against a real recipient so merge fields show what the audience will
  // actually receive; fall back to the sender when the filters match nobody.
  const spec = await resolveAudienceSpec({ audience, filters, savedAudienceId });
  const { deliver: recipients } = await applySuppressions(await resolveRecipients(spec));
  const sample = recipients[0] || null;
  const nameParts = (user.fullName || '').split(' ');
  const mergeSource = sample || {
    id: user.id,
    email: user.email,
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' '),
    fullName: user.fullName || user.email,
    phoneNumber: '',
    role: user.role,
    audience: spec.audience === 'custom' ? 'person' : spec.audience === 'applicants' ? 'applicant' : 'user',
  };
  // Shows the footer the audience will see. The link is the sender's own, not
  // the sample recipient's: clicking it in a test must not unsubscribe a real
  // person, and staff are exempt, so it does nothing to the sender either.
  const footer = recipients.some((r) => r.marketing) ? unsubscribeFooterHtml(unsubscribeUrls(user.email).page) : '';

  const renderedSubject = renderMessage(subject, mergeSource);
  const renderedBody = renderMessage(body, mergeSource);

  const banner =
    `<div style="background:#fff4e5;border:1px solid #ffb74d;border-radius:6px;padding:12px;margin-bottom:16px;font-family:sans-serif;font-size:13px;color:#663c00;">` +
    `<strong>Test email</strong> — nobody else received this. Merge fields were filled in from ` +
    `${sample ? `a matching recipient (${mergeSource.fullName || mergeSource.email})` : 'your own account, because no recipient matched the current filters'}.` +
    `</div>`;

  const result = await sendEmail(
    user.email,
    `[TEST] ${renderedSubject}`,
    banner + markdownToHtml(renderedBody) + footer,
    [],
    {
      category: 'TEST',
      trigger: 'MANUAL',
      recipientName: user.fullName || null,
      triggeredById: user.id,
    }
  );

  if (!result.success) {
    const err = new Error(result.error || 'Failed to send test email');
    err.status = 502;
    throw err;
  }

  return {
    sentTo: user.email,
    recipientCount: recipients.length,
    mergeSource: { fullName: mergeSource.fullName, email: mergeSource.email },
    usedFallback: !sample,
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------
// An unsent message, kept whole: channel, audience, filters, subject and body,
// so reopening one puts the composer back exactly as it was left. Shared across
// admins, so every read carries who wrote it and who touched it last - the
// thing you want to know before sending someone else's work.

const DRAFT_SELECT = {
  id: true,
  name: true,
  channel: true,
  audience: true,
  filters: true,
  subject: true,
  body: true,
  cycleId: true,
  savedAudienceId: true,
  savedAudience: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
  creator: { select: { id: true, fullName: true, email: true } },
  editor: { select: { id: true, fullName: true, email: true } },
};

export async function listDrafts({ cycleId, limit = 100 }) {
  // Most recently touched first: a draft list is a to-finish list.
  return prisma.messageDraft.findMany({
    where: cycleId ? { cycleId } : {},
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: DRAFT_SELECT,
  });
}

export async function createDraft({ name, channel, audience, filters, subject, body, cycleId, savedAudienceId, createdById }) {
  if (!name || !channel || !audience || !createdById) {
    const err = new Error('name, channel, and audience are required');
    err.status = 400;
    throw err;
  }

  return prisma.messageDraft.create({
    // A body is deliberately not required. The point of a draft is to save
    // something unfinished, and refusing an empty one would mean losing the
    // audience and filters somebody just spent time assembling.
    data: {
      name,
      channel,
      audience,
      filters: filters ?? undefined,
      subject: subject || '',
      body: body || '',
      cycleId: cycleId || null,
      savedAudienceId: savedAudienceId || null,
      createdById,
    },
    select: DRAFT_SELECT,
  });
}

export async function updateDraft({ id, updatedById, ...fields }) {
  if (!id || !updatedById) {
    const err = new Error('id and updatedById are required');
    err.status = 400;
    throw err;
  }

  const existing = await prisma.messageDraft.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    const err = new Error('Draft not found');
    err.status = 404;
    throw err;
  }

  const data = { updatedById };
  for (const key of ['name', 'channel', 'audience', 'subject', 'body']) {
    if (fields[key] !== undefined) data[key] = fields[key];
  }
  if (fields.filters !== undefined) data.filters = fields.filters ?? undefined;
  if (fields.cycleId !== undefined) data.cycleId = fields.cycleId || null;
  if (fields.savedAudienceId !== undefined) data.savedAudienceId = fields.savedAudienceId || null;

  return prisma.messageDraft.update({ where: { id }, data, select: DRAFT_SELECT });
}

export async function deleteDraft({ id }) {
  const existing = await prisma.messageDraft.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    const err = new Error('Draft not found');
    err.status = 404;
    throw err;
  }
  await prisma.messageDraft.delete({ where: { id } });
  return { id };
}
