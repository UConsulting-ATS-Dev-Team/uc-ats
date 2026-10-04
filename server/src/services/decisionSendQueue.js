import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { renderDecisionLetter } from './decisionTemplates.js';
import { decisionLetterContext, mintInviteLink } from './decisionBatches.js';

/**
 * Sends approved decision emails. Nothing here decides who gets one: an admin
 * approved each message in Master Communications (decisionBatches.js), which
 * moved it to QUEUED. This only delivers what is queued, and finishes what a
 * restart interrupted.
 *
 * It runs every minute from the cron block in index.js, and right away when a
 * send is approved. The approving request returns as soon as the messages are
 * queued, so a long send no longer depends on one HTTP request (which the
 * Vercel proxy cuts off) or on the process staying up: on 2026-10-03 a restart
 * under load killed a send mid-batch and left it for someone to reconstruct
 * from the database. Now the next tick, on whichever server, carries on.
 *
 * Every server runs the cron, so each message is claimed with a conditional
 * update (QUEUED -> SENDING) and only the claimer sends it.
 *
 * The communications log row is written *before* the send, as a SENDING claim
 * that sendEmail overwrites through the same attemptKey with how the send
 * ended (the applicationReceipts.js pattern). That makes an interrupted send
 * answerable afterwards:
 *   - no log row: the claim never committed, so SES was never called. Queued again.
 *   - SENT (or anything SES reported later): it went out. Marked SENT.
 *   - FAILED: it did not go out. Retried, up to MAX_ATTEMPTS.
 *   - still SENDING: cut off while SES was being asked. It may have gone out,
 *     and a second decision letter is worse than a late one, so it becomes
 *     UNCONFIRMED and an admin chooses.
 *
 * The same reasoning applies while the process is alive: a send SES refused
 * (it answered with an error) is retried, and one that got no answer at all
 * (a timeout, a dropped connection) becomes UNCONFIRMED rather than retried.
 */

const SEND_CONCURRENCY = 5;
// Quick retries inside one attempt, for a dropped connection to SES.
const TRANSPORT_TRIES = 3;
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60 * 1000;
// A SENDING message older than this was interrupted. One send takes seconds;
// under last night's load the slowest took 18.
export const STUCK_SENDING_MS = 10 * 60 * 1000;
const PAGE_SIZE = 50;

export const UNCONFIRMED_NOTE =
  'Interrupted while sending. It may or may not have been delivered: mark it sent, or send it again.';

// Statuses SES (or sendEmail) can leave on a log row once the message was accepted.
const ACCEPTED_LOG_STATUSES = new Set(['SENT', 'DELIVERED', 'DELAYED', 'CLICKED', 'BOUNCED', 'COMPLAINED']);

const attemptKeyFor = (message) => `decision-message:${message.id}:${message.attempts}`;
// sendEmail trims the address when it keys its log row, so the claim does too.
const addressOf = (message) => String(message.email ?? '').trim();
export const logKeyFor = (message) => `${attemptKeyFor(message)}|${addressOf(message)}`;
const nameOf = (message) => [message.firstName, message.lastName].filter(Boolean).join(' ') || null;

/** A failed attempt is retried later, until MAX_ATTEMPTS, then left FAILED for an admin. */
function failureUpdate(message, error) {
  return message.attempts < MAX_ATTEMPTS
    ? { status: 'QUEUED', error, nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS * message.attempts) }
    : { status: 'FAILED', error };
}

/**
 * Settles messages left SENDING by a process that stopped. Each update is
 * conditional on the message still being in the state that was read, so two
 * servers recovering at once settle it once.
 */
export async function recoverInterruptedSends(client = prisma, now = new Date()) {
  const stuck = await client.decisionMessage.findMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
  });
  if (stuck.length === 0) return { recovered: 0 };

  const logs = await client.communicationLog.findMany({
    where: { attemptKey: { in: stuck.map(logKeyFor) } },
    select: { attemptKey: true, status: true, sentAt: true, providerMessageId: true, error: true },
  });
  const logByKey = new Map(logs.map((row) => [row.attemptKey, row]));

  let recovered = 0;
  for (const message of stuck) {
    const log = logByKey.get(logKeyFor(message));
    let data;
    if (log && ACCEPTED_LOG_STATUSES.has(log.status)) {
      data = { status: 'SENT', sentAt: log.sentAt, providerMessageId: log.providerMessageId ?? null, error: null };
    } else if (log?.status === 'FAILED') {
      data = failureUpdate(message, log.error || 'Send failed');
    } else if (!log && message.nextAttemptAt) {
      // Claimed by this worker, which writes the log row before calling SES.
      // No row means SES was never asked.
      data = { status: 'QUEUED', nextAttemptAt: now };
    } else {
      // Still SENDING in the log, or a send from before the worker existed
      // (logged only after SES answered, so no row proves nothing).
      data = { status: 'UNCONFIRMED', error: UNCONFIRMED_NOTE };
    }

    const { count } = await client.decisionMessage.updateMany({
      where: { id: message.id, status: 'SENDING', attempts: message.attempts },
      data,
    });
    recovered += count;
  }
  return { recovered };
}

/** One message: claim, write the log claim, send, record. Never throws. */
async function sendOne(messageId, contextFor, client) {
  const { count } = await client.decisionMessage.updateMany({
    where: { id: messageId, status: 'QUEUED' },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });
  if (count === 0) return { messageId, skipped: true };

  const message = await client.decisionMessage.findUnique({ where: { id: messageId } });
  let rendered;
  try {
    const { batch, template, context } = await contextFor(message);
    const setPasswordLink = message.needsInvite && message.userId ? await mintInviteLink(message.userId, client) : null;
    rendered = { batch, ...(await renderDecisionLetter(template, message, { ...context, setPasswordLink }, message.outcome)) };

    // Committed before SES is called; see the top of this file.
    await client.communicationLog.create({
      data: {
        channel: 'email',
        category: 'DECISION_BATCH',
        trigger: 'MANUAL',
        status: 'SENDING',
        recipient: addressOf(message),
        recipientName: nameOf(message),
        subject: rendered.subject,
        triggeredById: message.sentById,
        cycleId: batch.cycleId,
        attemptKey: logKeyFor(message),
      },
    });
  } catch (error) {
    // Nothing reached SES. Try again on a later tick.
    await client.decisionMessage.update({ where: { id: messageId }, data: failureUpdate(message, error.message) });
    return { messageId, success: false, error: error.message };
  }

  let result = { success: false, error: 'Not attempted' };
  for (let attempt = 1; attempt <= TRANSPORT_TRIES; attempt++) {
    result = await sendEmail(addressOf(message), rendered.subject, rendered.html, [], {
      // Same key as the claim above, so the send overwrites it.
      attemptKey: attemptKeyFor(message),
      category: 'DECISION_BATCH',
      trigger: 'MANUAL',
      recipientName: nameOf(message),
      triggeredById: message.sentById,
      cycleId: rendered.batch.cycleId,
    });
    // Only a refusal is safe to try again. Without an answer SES may have
    // taken it, and a second try could be a second letter.
    if (result.success || !result.rejected) break;
    if (attempt < TRANSPORT_TRIES) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }

  let data;
  if (result.success) {
    data = { status: 'SENT', sentAt: new Date(), providerMessageId: result.messageId ?? null, error: null };
  } else if (result.rejected) {
    data = failureUpdate(message, result.error || 'Send failed');
  } else {
    data = { status: 'UNCONFIRMED', error: `${UNCONFIRMED_NOTE} (${result.error || 'no answer from SES'})` };
  }

  // If this write fails the message stays SENDING, and recovery reads the
  // outcome back from the log row sendEmail just wrote.
  try {
    await client.decisionMessage.update({ where: { id: messageId }, data });
  } catch (error) {
    console.error(`[decision send queue] could not record the outcome for ${messageId}:`, error);
  }
  return result.success ? { messageId, success: true } : { messageId, success: false, error: result.error };
}

/** Batch, wording and render context, read once per batch and outcome per run. */
function contextLoader(client) {
  const cache = new Map();
  return (message) => {
    const key = `${message.batchId}:${message.outcome}`;
    if (!cache.has(key)) cache.set(key, decisionLetterContext(message.batchId, message.outcome, client));
    return cache.get(key);
  };
}

/** Recover, then send everything due. Returns what happened. */
export async function processDecisionQueue(client = prisma) {
  const { recovered } = await recoverInterruptedSends(client);
  const contextFor = contextLoader(client);
  const totals = { recovered, sent: 0, failed: 0, skipped: 0 };

  // Page by page until nothing is due. A message is tried at most once per run,
  // so one whose claim keeps failing waits for the next tick instead of being
  // fetched again forever.
  const tried = [];
  for (;;) {
    const due = await client.decisionMessage.findMany({
      where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() }, ...(tried.length ? { id: { notIn: tried } } : {}) },
      orderBy: { nextAttemptAt: 'asc' },
      select: { id: true },
      take: PAGE_SIZE,
    });
    if (due.length === 0) break;

    const queue = due.map((row) => row.id);
    tried.push(...queue);
    const results = [];
    await Promise.all(
      Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const messageId = queue.shift();
          // A database error claiming or reading one message must not end the
          // run for the rest. A message left SENDING without its log claim is
          // queued again by recovery.
          results.push(
            await sendOne(messageId, contextFor, client).catch((error) => {
              console.error(`[decision send queue] ${messageId} failed before sending:`, error);
              return { messageId, success: false, error: error.message };
            })
          );
        }
      })
    );
    totals.sent += results.filter((r) => r.success).length;
    totals.failed += results.filter((r) => r.success === false).length;
    totals.skipped += results.filter((r) => r.skipped).length;
  }
  return totals;
}

let running = null;

/**
 * Starts a run unless this process already has one going; a run picks up
 * messages queued while it works, so a second one would only compete with it.
 * Never rejects.
 */
export function drainDecisionQueue() {
  if (!running) {
    running = processDecisionQueue()
      .then((totals) => {
        if (totals.sent || totals.failed || totals.recovered) console.log('[decision send queue]', totals);
        return totals;
      })
      .catch((error) => {
        console.error('[decision send queue] run failed:', error);
        return null;
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}
