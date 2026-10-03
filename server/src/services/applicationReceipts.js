import prisma from '../prismaClient.js';
import { sendApplicationReceivedEmail } from './emailNotifications.js';
import { emailIdentityKey } from '../utils/mailingListImport.js';

/**
 * Who gets the "We Received Your Application" email, and sending it once.
 *
 * Form sync and the one-time backfill script both send through here. Neither
 * keeps its own idea of who is still owed one: the communications log is the
 * record. A person is owed a receipt for a cycle until an APPLICATION_RECEIVED
 * row for their address exists that did not fail, or three attempts failed.
 *
 * That is what makes sync's sends safe to lose. Sync sends after it files the
 * applications and does not wait; a deploy that kills the process mid-send
 * leaves the rest unlogged, and the next tick's sweep sends them.
 *
 * Every server runs sync on the same tick, and the backfill can run beside
 * them, so each send takes a transaction-scoped advisory lock on the person
 * and re-reads the log once it holds it - the meetingHostReminders.js pattern.
 * Whoever comes second finds the lock taken or the first one's row.
 *
 * Only applications still waiting on a first decision are owed one. Telling
 * someone already advanced or rejected that they "will hear from us shortly"
 * is wrong, so the backfill reports them instead.
 */

const CATEGORY = 'APPLICATION_RECEIVED';
const WAITING_STATUSES = new Set(['SUBMITTED', 'UNDER_REVIEW']);
const MAX_ATTEMPTS = 3;
// Held until the log row is written, so a slow send cannot release the lock
// early and let another server send too.
const LOCK_TIMEOUT_MS = 60 * 1000;

const isWaiting = (app) => WAITING_STATUSES.has(app.status) && (!app.currentRound || app.currentRound === '1');

const nameOf = (app) => [app.firstName, app.lastName].filter(Boolean).join(' ') || 'Applicant';

/** { [identityKey]: { done, failures } } for one cycle's receipts. */
async function receiptHistory(cycleId, client) {
  const rows = await client.communicationLog.findMany({
    where: { category: CATEGORY, cycleId, channel: 'email' },
    select: { recipient: true, status: true },
  });
  const history = {};
  for (const { recipient, status } of rows) {
    const entry = (history[emailIdentityKey(recipient)] ??= { done: false, failures: 0 });
    if (status === 'FAILED') entry.failures += 1;
    else entry.done = true;
  }
  return history;
}

const stillOwed = (entry) => !entry || (!entry.done && entry.failures < MAX_ATTEMPTS);

/**
 * Who is owed a receipt, one entry per person. `since` limits it to
 * applications submitted from then on; without it, the whole cycle.
 *
 * A person's applications are judged together: the latest one still waiting
 * is the one written to, so an old rejected application does not hide a
 * newer one.
 */
export async function planApplicationReceipts({ cycle, since = null, client = prisma }) {
  const [applications, history] = await Promise.all([
    client.application.findMany({
      where: { cycleId: cycle.id, ...(since ? { submittedAt: { gte: since } } : {}) },
      select: { email: true, firstName: true, lastName: true, status: true, currentRound: true, submittedAt: true },
      orderBy: { submittedAt: 'asc' },
    }),
    receiptHistory(cycle.id, client),
  ]);

  const people = new Map();
  const skipped = [];
  for (const app of applications) {
    const email = (app.email || '').trim();
    if (!email) {
      skipped.push({ name: nameOf(app), email: '(none)', reason: 'no email on the application' });
      continue;
    }
    const key = emailIdentityKey(email);
    const person = people.get(key) ?? { key, apps: [] };
    person.apps.push({ ...app, email });
    people.set(key, person);
  }

  const toSend = [];
  for (const { key, apps } of people.values()) {
    const latest = apps[apps.length - 1];
    const waiting = apps.filter(isWaiting).pop();
    const entry = history[key];
    const skip = (reason) => skipped.push({ name: nameOf(latest), email: latest.email, reason });

    if (entry?.done) skip('already sent');
    else if (!stillOwed(entry)) skip(`gave up after ${MAX_ATTEMPTS} failed attempts`);
    else if (!waiting) skip(`already decided (status ${latest.status}, round ${latest.currentRound ?? '-'})`);
    else toSend.push({ key, email: waiting.email, name: nameOf(waiting) });
  }

  return { toSend, skipped, applicationCount: applications.length };
}

/** Send one person's receipt under a lock on them. Returns { ok, error }. */
async function sendUnderLock(cycle, person) {
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] =
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${`application-received:${cycle.id}:${person.key}`})) AS locked`;
      if (!locked) return { ok: false, skipped: true };

      const history = await receiptHistory(cycle.id, tx);
      if (!stillOwed(history[person.key])) return { ok: false, skipped: true };

      const result = await sendApplicationReceivedEmail(person.email, person.name, cycle.name, { cycleId: cycle.id });
      return result?.success === false ? { ok: false, error: result.error } : { ok: true };
    },
    { maxWait: 10 * 1000, timeout: LOCK_TIMEOUT_MS }
  );
}

/**
 * Send every receipt still owed, one at a time. `pauseMs` spaces a long run
 * out under the SES send rate. Returns what happened, for the caller to report.
 */
export async function sendApplicationReceipts({ cycle, since = null, pauseMs = 0, onProgress = null }) {
  const plan = await planApplicationReceipts({ cycle, since });
  let sent = 0;
  const failed = [];

  for (const [i, person] of plan.toSend.entries()) {
    try {
      const result = await sendUnderLock(cycle, person);
      if (result.ok) sent += 1;
      else if (result.error) failed.push({ ...person, error: result.error });
    } catch (error) {
      // A lock or log read failing for one person must not end the run for the rest.
      console.error(`[application receipts] ${person.email} failed:`, error);
      failed.push({ ...person, error: error.message });
    }
    onProgress?.(i + 1, plan.toSend.length);
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  return { ...plan, sent, failed };
}
