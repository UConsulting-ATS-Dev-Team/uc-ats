import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendEmail } from './emailNotifications.js';
import { DECISION_OUTCOMES, outcomeLabel, renderDecisionLetter } from './decisionTemplates.js';
import { getRound } from '../utils/roundProgression.js';
import { roundNumberForInterviewType } from '../utils/interviewRounds.js';

// Decision emails, held for human review.
//
// Processing decisions on Staging queues one DecisionMessage per applicant
// (services/decisionProcessing.js). An admin reads each outcome's wording and
// recipient list in Master Communications, sends themselves a test, and
// approves the send - one outcome at a time, so "you're in" and "not this time"
// are never a single click apart. Approving moves the messages to QUEUED; the
// sending itself is decisionSendQueue.js.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const unique = (values) => [...new Set(values.filter(Boolean))];

// Deliberately loose: it catches what cannot be an address at all (a lone "d"
// was queued on 2026-10-03), not every address SES would refuse. The client's
// copy is in DecisionBatchPanel.jsx.
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isDeliverableAddress = (email) => ADDRESS_PATTERN.test(String(email ?? '').trim());

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
  toRound: true,
  nextAttemptAt: true
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

/** What the send worker needs to render one outcome of a batch. */
export async function decisionLetterContext(batchId, outcome, client = prisma) {
  const batch = await loadBatch(batchId, client);
  return { batch, template: templateFor(batch, outcome), context: await renderContext(batch, client) };
}

const emptyCounts = () => ({ PENDING: 0, EXCLUDED: 0, QUEUED: 0, SENDING: 0, SENT: 0, FAILED: 0, UNCONFIRMED: 0 });

/**
 * What SES reported for each message's latest attempt, from the
 * communications log: DELIVERED, BOUNCED and so on. Plain SENT until SES
 * delivery reports are configured (see sesEvents.js).
 */
async function deliveryByMessage(messages, client) {
  const keys = messages
    .filter((message) => message.attempts > 0)
    // Trimmed as sendEmail trims it when it keys the row.
    .map((message) => `decision-message:${message.id}:${message.attempts}|${String(message.email).trim()}`);
  if (keys.length === 0) return new Map();
  const rows = await client.communicationLog.findMany({
    where: { attemptKey: { in: keys } },
    select: { attemptKey: true, status: true, error: true }
  });
  return new Map(rows.map((row) => [row.attemptKey.split(':')[1], { status: row.status, error: row.error }]));
}

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
  const delivery = await deliveryByMessage(messages, client);
  for (const message of messages) {
    message.delivery = delivery.get(message.id) ?? null;
    message.addressOk = isDeliverableAddress(message.email);
  }

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
  const { subject, html } = await renderDecisionLetter(template, recipient, await renderContext(batch, client, { preview: true }), outcome);
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
  const { subject, html } = await renderDecisionLetter(template, recipient, await renderContext(batch, client, { preview: true }), outcome);

  const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ');
  const banner =
    '<div style="background:#fff4e5;border:1px solid #ffb74d;border-radius:6px;padding:12px;margin-bottom:16px;font-family:sans-serif;font-size:13px;color:#663c00;">' +
    `<strong>Test email</strong> - nobody else received this. Merge fields were filled in for ${name || 'a sample recipient'}.` +
    '</div>';

  // Inside <body>, not in front of the document: before a doctype it is
  // invalid markup that some clients drop entirely.
  const withBanner = /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${banner}`) : banner + html;

  const result = await sendEmail(user.email, `[TEST] ${subject}`, withBanner, [], {
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
export async function mintInviteLink(userId, client = prisma) {
  const resetToken = crypto.randomBytes(32).toString('hex');
  await client.user.update({
    where: { id: userId },
    data: { resetToken, resetTokenExpiry: new Date(Date.now() + INVITE_TTL_MS) }
  });
  return `${config.clientUrl}/reset-password?token=${resetToken}`;
}

/**
 * Approve one outcome of a batch: every PENDING message moves to QUEUED and the
 * send worker takes it from there. `expectedCount` is the number the admin
 * approved; if the list has changed since they looked, nothing is queued and
 * they are asked to look again. So is a list holding an address that cannot
 * receive mail, which has to be fixed or left out first.
 */
export async function queueDecisionEmails({ batchId, outcome, expectedCount, sentBy }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  const template = templateFor(batch, outcome);

  const pending = await client.decisionMessage.findMany({
    where: { batchId, outcome, status: 'PENDING' },
    select: { id: true, email: true, firstName: true, lastName: true }
  });

  if (expectedCount !== undefined && expectedCount !== null && pending.length !== Number(expectedCount)) {
    throw httpError(
      409,
      `The recipient list changed since you reviewed it: ${pending.length} ready to send, not ${expectedCount}. Review it again before sending.`
    );
  }
  const unreachable = pending.filter((message) => !isDeliverableAddress(message.email));
  if (unreachable.length > 0) {
    const one = unreachable.length === 1;
    const names = unreachable
      .slice(0, 3)
      .map((message) => `${[message.firstName, message.lastName].filter(Boolean).join(' ')} ("${message.email}")`);
    throw httpError(
      409,
      `${unreachable.length} ${one ? 'address' : 'addresses'} cannot receive email: ${names.join(', ')}` +
        `${unreachable.length > 3 ? ' and more' : ''}. Fix ${one ? 'it' : 'them'} or leave ${one ? 'it' : 'them'} out, then send.`
    );
  }
  if (pending.length === 0) return { queued: 0 };

  const { count } = await client.decisionMessage.updateMany({
    // Only what was reviewed: a message un-excluded since the list was read waits.
    where: { batchId, outcome, status: 'PENDING', id: { in: pending.map((message) => message.id) } },
    data: { status: 'QUEUED', sentById: sentBy, nextAttemptAt: new Date(), error: null }
  });

  if (count > 0) {
    try {
      await client.messageLog.create({
        data: {
          channel: 'email',
          recipientCount: count,
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

  return { queued: count };
}

/** Stop what is still queued for one outcome. Anything already sent stays sent. */
export async function cancelQueuedDecisionEmails({ batchId, outcome }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  templateFor(batch, outcome);
  const { count } = await client.decisionMessage.updateMany({
    where: { batchId, outcome, status: 'QUEUED' },
    data: { status: 'PENDING', nextAttemptAt: null }
  });
  return { stopped: count };
}

/**
 * Put failed messages back to Ready. Sending them again is a separate,
 * explicit approval. Unconfirmed ones are not included: they may have been
 * delivered, so each is settled on its own with resolveUnconfirmedDecisionEmails.
 */
export async function requeueFailedDecisionEmails({ batchId, outcome }, client = prisma) {
  const batch = await loadBatch(batchId, client);
  templateFor(batch, outcome);

  const { count } = await client.decisionMessage.updateMany({
    where: { batchId, outcome, status: 'FAILED' },
    data: { status: 'PENDING', error: null, nextAttemptAt: null }
  });
  return { requeued: count };
}

/**
 * An admin's answer for messages whose send was cut off: MARK_SENT when they
 * know it arrived, SEND_AGAIN to put it back to Ready for an ordinary approved
 * send.
 */
export async function resolveUnconfirmedDecisionEmails({ batchId, messageIds, resolution, resolvedBy }, client = prisma) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) throw httpError(400, 'messageIds is required');
  const where = { batchId, id: { in: messageIds }, status: 'UNCONFIRMED' };

  if (resolution === 'MARK_SENT') {
    const { count } = await client.decisionMessage.updateMany({
      where,
      data: { status: 'SENT', error: null, sentById: resolvedBy }
    });
    return { updated: count };
  }
  if (resolution === 'SEND_AGAIN') {
    const { count } = await client.decisionMessage.updateMany({
      where,
      data: { status: 'PENDING', error: null, nextAttemptAt: null }
    });
    return { updated: count };
  }
  throw httpError(400, 'resolution must be MARK_SENT or SEND_AGAIN');
}

/**
 * Correct the address one unsent message goes to. Only this email changes;
 * the application keeps the address it was submitted with.
 */
export async function updateDecisionMessageEmail({ batchId, messageId, email }, client = prisma) {
  const address = String(email ?? '').trim();
  if (!isDeliverableAddress(address)) throw httpError(400, `"${address}" is not an email address.`);

  const { count } = await client.decisionMessage.updateMany({
    where: { id: messageId, batchId, status: { in: ['PENDING', 'EXCLUDED', 'FAILED'] } },
    data: { email: address }
  });
  if (count === 0) throw httpError(409, 'Only an email that has not been sent can be readdressed.');
  return { email: address };
}
