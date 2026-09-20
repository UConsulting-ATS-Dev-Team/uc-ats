import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendEmail } from './emailNotifications.js';
import { DECISION_OUTCOMES, outcomeLabel, renderDecisionEmail } from './decisionTemplates.js';
import { getRound } from '../utils/roundProgression.js';
import { roundNumberForInterviewType } from '../utils/interviewRounds.js';

// Decision emails, held for human review.
//
// Processing decisions on Staging queues one DecisionMessage per applicant
// (services/decisionProcessing.js). Nothing here runs on a timer: an admin reads
// each outcome's wording and recipient list in Master Communications, sends
// themselves a test, and approves the send - one outcome at a time, so "you're
// in" and "not this time" are never a single click apart.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEND_CONCURRENCY = 5;
const SEND_ATTEMPTS = 3;
// A message still SENDING after this long was interrupted, e.g. by a restart.
const STUCK_SENDING_MS = 15 * 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const unique = (values) => [...new Set(values.filter(Boolean))];

const MESSAGE_SELECT = {
  id: true,
  applicationId: true,
  email: true,
  firstName: true,
  lastName: true,
  outcome: true,
  status: true,
  needsInvite: true,
  userId: true,
  attempts: true,
  sentAt: true,
  error: true,
  toRound: true
};

// Stands in for a recipient when an outcome has none left to render against.
const PREVIEW_SAMPLE = { firstName: 'Joe', lastName: 'Bruin', email: 'joe.bruin@example.com', needsInvite: false, userId: 'sample' };

async function loadBatch(batchId, client) {
  const batch = await client.decisionBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw httpError(404, 'Decision batch not found');
  return batch;
}

function templateFor(batch, outcome) {
  const template = batch.templates?.[outcome];
  if (!template) throw httpError(400, `This batch has no ${String(outcome).toLowerCase()} emails.`);
  return template;
}

/**
 * Which rounds in this cycle have somewhere for a candidate to book.
 *
 * Keyed by the round a recipient is moving *to*, which is what
 * DecisionMessage.toRound holds. A round only earns a link if one of its
 * interviews actually has a slot open to candidate signup - linking someone to
 * an empty page is worse than the "details are on their way" sentence the link
 * replaces, so schedulingLink() falls back to that wording when a key is absent.
 *
 * One query for the whole batch. This is cycle-wide context built once; anything
 * per-recipient has to happen in sendOne.
 */
async function schedulingLinksByRound(batch, client) {
  const interviews = await client.interview.findMany({
    where: {
      cycleId: batch.cycleId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
      slots: { some: { candidateCapacity: { not: null } } }
    },
    select: { interviewType: true }
  });

  const links = {};
  for (const interview of interviews) {
    const round = roundNumberForInterviewType(interview.interviewType);
    if (round) links[round] = `${config.clientUrl}/interview-signup`;
  }
  return links;
}

async function renderContext(batch, client, extra = {}) {
  const cycle = await client.recruitingCycle.findUnique({ where: { id: batch.cycleId }, select: { name: true } });
  return {
    cycleName: cycle?.name || '',
    round: batch.round,
    loginUrl: `${config.clientUrl}/login`,
    schedulingLinksByRound: await schedulingLinksByRound(batch, client),
    ...extra
  };
}

const emptyCounts = () => ({ PENDING: 0, EXCLUDED: 0, SENDING: 0, SENT: 0, FAILED: 0 });

export async function listDecisionBatches({ cycleId } = {}, client = prisma) {
  const batches = await client.decisionBatch.findMany({
    where: cycleId ? { cycleId } : {},
    orderBy: { processedAt: 'desc' },
    take: 50
  });
  if (!batches.length) return [];

  const [tallies, users, cycles] = await Promise.all([
    client.decisionMessage.groupBy({
      by: ['batchId', 'status'],
      where: { batchId: { in: batches.map((batch) => batch.id) } },
      _count: { _all: true }
    }),
    client.user.findMany({
      where: { id: { in: unique(batches.map((batch) => batch.processedById)) } },
      select: { id: true, fullName: true }
    }),
    client.recruitingCycle.findMany({
      where: { id: { in: unique(batches.map((batch) => batch.cycleId)) } },
      select: { id: true, name: true }
    })
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const cyclesById = new Map(cycles.map((cycle) => [cycle.id, cycle]));

  return batches.map((batch) => {
    const counts = emptyCounts();
    for (const tally of tallies) {
      if (tally.batchId === batch.id) counts[tally.status] = tally._count._all;
    }
    return {
      id: batch.id,
      round: batch.round,
      roundLabel: getRound(batch.round)?.label ?? `Round ${batch.round}`,
      cycle: cyclesById.get(batch.cycleId) ?? null,
      processedAt: batch.processedAt,
      processedBy: usersById.get(batch.processedById) ?? null,
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0)
    };
  });
}

export async function getDecisionBatch(batchId, client = prisma) {
  const batch = await loadBatch(batchId, client);
  const [messages, cycle, processedBy] = await Promise.all([
    client.decisionMessage.findMany({
      where: { batchId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: MESSAGE_SELECT
    }),
    client.recruitingCycle.findUnique({ where: { id: batch.cycleId }, select: { id: true, name: true } }),
    client.user.findUnique({ where: { id: batch.processedById }, select: { id: true, fullName: true } })
  ]);

  return {
    id: batch.id,
    round: batch.round,
    roundLabel: getRound(batch.round)?.label ?? `Round ${batch.round}`,
    cycle,
    processedAt: batch.processedAt,
    processedBy,
    groups: DECISION_OUTCOMES
      .filter((outcome) => batch.templates?.[outcome])
      .map((outcome) => ({
        outcome,
        label: outcomeLabel(outcome, batch.round),
        template: batch.templates[outcome],
        messages: messages.filter((message) => message.outcome === outcome)
      }))
  };
}

export async function updateDecisionTemplate({ batchId, outcome, subject, body }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  templateFor(batch, outcome);
  if (!subject?.trim() || !body?.trim()) {
    throw httpError(400, 'Both a subject and a message are required.');
  }

  const templates = { ...batch.templates, [outcome]: { subject: subject.trim(), body } };
  await client.decisionBatch.update({ where: { id: batchId }, data: { templates } });
  return templates[outcome];
}

export async function setMessagesExcluded({ batchId, messageIds, excluded }, client = prisma) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw httpError(400, 'messageIds is required');
  }
  const { count } = await client.decisionMessage.updateMany({
    // Only unsent messages move: nobody can be un-emailed.
    where: { batchId, id: { in: messageIds }, status: excluded ? 'PENDING' : 'EXCLUDED' },
    data: { status: excluded ? 'EXCLUDED' : 'PENDING' }
  });
  return { updated: count };
}

async function sampleRecipient(batchId, outcome, messageId, client) {
  const message = await client.decisionMessage.findFirst({
    where: { batchId, outcome, ...(messageId ? { id: messageId } : {}) },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: MESSAGE_SELECT
  });
  return message || PREVIEW_SAMPLE;
}

export async function previewDecisionEmail({ batchId, outcome, messageId }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  const template = templateFor(batch, outcome);
  const recipient = await sampleRecipient(batchId, outcome, messageId, client);
  const { subject, html } = renderDecisionEmail(template, recipient, await renderContext(batch, client, { preview: true }));
  return {
    subject,
    html,
    recipient: {
      id: recipient.id ?? null,
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      email: recipient.email,
      needsInvite: recipient.needsInvite
    }
  };
}

// The real email, rendered for a real recipient, sent only to whoever asked.
// Not logged: a test is not a send.
export async function sendDecisionTest({ batchId, outcome, user }, client = prisma) {
  if (!user?.email) throw httpError(400, 'No email address on the requesting account');

  const batch = await loadBatch(batchId, client);
  const template = templateFor(batch, outcome);
  const recipient = await sampleRecipient(batchId, outcome, null, client);
  const { subject, html } = renderDecisionEmail(template, recipient, await renderContext(batch, client, { preview: true }));

  const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ');
  const banner =
    '<div style="background:#fff4e5;border:1px solid #ffb74d;border-radius:6px;padding:12px;margin-bottom:16px;font-family:sans-serif;font-size:13px;color:#663c00;">' +
    `<strong>Test email</strong> - nobody else received this. Merge fields were filled in for ${name || 'a sample recipient'}.` +
    '</div>';

  const result = await sendEmail(user.email, `[TEST] ${subject}`, banner + html, [], {
    category: 'TEST',
    trigger: 'MANUAL',
    recipientName: user.fullName || null,
    triggeredById: user.id,
    cycleId: batch.cycleId,
  });
  if (!result.success) throw httpError(502, result.error || 'Failed to send test email');
  return { sentTo: user.email, sample: { name, email: recipient.email } };
}

// Minted at send time, not when the batch was made, so a batch that waited a
// week for review still delivers a working link. Reuses the password-reset flow.
async function mintInviteLink(userId, client) {
  const resetToken = crypto.randomBytes(32).toString('hex');
  await client.user.update({
    where: { id: userId },
    data: { resetToken, resetTokenExpiry: new Date(Date.now() + INVITE_TTL_MS) }
  });
  return `${config.clientUrl}/reset-password?token=${resetToken}`;
}

async function sendOne(messageId, { template, context, sentBy, cycleId }, client) {
  // Claim the message first. Only one sender can move it out of PENDING, so a
  // double click, or two admins sending at once, cannot email anyone twice.
  const { count } = await client.decisionMessage.updateMany({
    where: { id: messageId, status: 'PENDING' },
    data: { status: 'SENDING', attempts: { increment: 1 } }
  });
  if (count === 0) return { messageId, skipped: true };

  const message = await client.decisionMessage.findUnique({ where: { id: messageId } });

  try {
    const setPasswordLink = message.needsInvite && message.userId ? await mintInviteLink(message.userId, client) : null;
    const { subject, html } = renderDecisionEmail(template, message, { ...context, setPasswordLink });

    let result = { success: false, error: 'Not attempted' };
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      result = await sendEmail(message.email, subject, html, [], {
        attemptKey: `decision-message:${messageId}`,
        category: 'DECISION_BATCH',
        trigger: 'MANUAL',
        recipientName: [message.firstName, message.lastName].filter(Boolean).join(' ') || null,
        triggeredById: sentBy,
        cycleId,
      });
      if (result.success) break;
      if (attempt < SEND_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }

    if (result.success) {
      await client.decisionMessage.update({
        where: { id: messageId },
        data: { status: 'SENT', sentAt: new Date(), sentById: sentBy, providerMessageId: result.messageId ?? null, error: null }
      });
      return { messageId, success: true };
    }

    await client.decisionMessage.update({
      where: { id: messageId },
      data: { status: 'FAILED', error: result.error || 'Send failed' }
    });
    return { messageId, success: false, error: result.error };
  } catch (error) {
    await client.decisionMessage.update({ where: { id: messageId }, data: { status: 'FAILED', error: error.message } });
    return { messageId, success: false, error: error.message };
  }
}

/**
 * Send every PENDING message for one outcome of a batch. `expectedCount` is the
 * number the admin approved; if the list has changed since they looked, nothing
 * is sent and they are asked to look again.
 */
export async function sendDecisionEmails({ batchId, outcome, expectedCount, sentBy }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  const template = templateFor(batch, outcome);

  const pending = await client.decisionMessage.findMany({
    where: { batchId, outcome, status: 'PENDING' },
    select: { id: true }
  });

  if (expectedCount !== undefined && expectedCount !== null && pending.length !== Number(expectedCount)) {
    throw httpError(
      409,
      `The recipient list changed since you reviewed it: ${pending.length} ready to send, not ${expectedCount}. Review it again before sending.`
    );
  }
  if (pending.length === 0) return { sent: 0, failed: 0, skipped: 0, total: 0 };

  const shared = { template, context: await renderContext(batch, client), sentBy, cycleId: batch.cycleId };
  const queue = pending.map((message) => message.id);
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        results.push(await sendOne(queue.shift(), shared, client));
      }
    })
  );

  const sent = results.filter((result) => result.success).length;
  const failed = results.filter((result) => result.success === false).length;
  const skipped = results.filter((result) => result.skipped).length;

  if (sent > 0) {
    try {
      await client.messageLog.create({
        data: {
          channel: 'email',
          recipientCount: sent,
          subject: template.subject,
          body: template.body,
          sentBy,
          cycleId: batch.cycleId
        }
      });
    } catch (error) {
      console.error('[decisionBatches] failed to log send:', error);
    }
  }

  return { sent, failed, skipped, total: results.length };
}

/**
 * Put failed messages back in the queue. Sending them again is a separate,
 * explicit approval. A message stuck in SENDING - the server stopped mid-send -
 * is marked failed first, with a note that it may already have been delivered.
 */
export async function requeueFailedDecisionEmails({ batchId, outcome }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  templateFor(batch, outcome);

  await client.decisionMessage.updateMany({
    where: { batchId, outcome, status: 'SENDING', updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) } },
    data: { status: 'FAILED', error: 'Interrupted while sending - it may or may not have been delivered.' }
  });
  const { count } = await client.decisionMessage.updateMany({
    where: { batchId, outcome, status: 'FAILED' },
    data: { status: 'PENDING', error: null }
  });
  return { requeued: count };
}
