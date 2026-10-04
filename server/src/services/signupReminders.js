// Reminding the people in an interview round who have not booked a session.
//
// "Not booked" is the same question the scheduling overview has always asked of
// a round - eligible, and holding no live signup on any session of it - so it
// lives here once and both the page and the send read it.
//
// There is no table of reminders. A reminder is an email, every email is a
// communication_logs row, and the attemptKey on that row carries the round and
// the application it was for. That is enough to answer "when did we last chase
// this person for this round", which is all the page needs, without a schema
// change.
//
// The same rows make a send safe to repeat. Each person's reminder is claimed
// first - a SENDING row written under an advisory lock on (round, person), the
// applicationReceipts.js pattern - and a claim is refused while a reminder for
// that round went to them within REMINDER_COOLDOWN_MS. A retry after the proxy
// cut the response off, or a second admin pressing send at the same moment,
// finds the first one's row and skips.

import { randomUUID } from 'node:crypto';
import prisma from '../prismaClient.js';
import { interviewTypesForRound } from '../utils/interviewRounds.js';
import { formatEmailDateTime } from '../utils/timezoneUtils.js';
import { CLOSED_INTERVIEW_STATUSES, isSelfBookableNow, selfBookingClosesAt } from './interviewSignupPolicy.js';
import { sendEmail } from './emailNotifications.js';
import { composeEmail, part } from './emailLayout.js';
import { copySubject } from './emailCopyRender.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

export const SIGNUP_REMINDER_CATEGORY = 'SIGNUP_REMINDER';

// The copy key for composeEmail. Deliberately not registered with Automatic
// Emails: the wording is typed per send, so there is nothing to edit there, and
// an unregistered key renders with the shipped Designed style.
const TEMPLATE_KEY = 'interview-signup-reminder';

// The statuses that mean a person has somewhere to be. CANCELLED is the only
// other one, and a cancelled booking is exactly who this reminder is for.
const LIVE_SIGNUP_STATUSES = ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'];

export const DEFAULT_SIGNUP_REMINDER_SUBJECT = 'Pick your {{round}} time';
// No {{deadline}}: an admin can quote it, but the default has to read well
// even if it were blank.
export const DEFAULT_SIGNUP_REMINDER_MESSAGE = [
  'Hi {{firstName}},',
  '',
  "You're in **{{round}}** for UConsulting, but you haven't picked a time yet. Sessions fill up, so grab one while there's still a choice.",
].join('\n');

export const SIGNUP_REMINDER_MERGE_FIELDS = ['firstName', 'fullName', 'round', 'deadline'];

const ATTEMPT_PREFIX = 'signup-reminder';

/// How long after a reminder another one to the same person for the same round
/// is refused. Long enough to absorb a retry or a double press; short enough
/// that a deliberate second nudge later in the day still goes.
export const REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

// Statuses that mean the reminder never reached the person.
//
// SENDING is deliberately NOT here. A SENDING row that stays SENDING means the
// process died between the claim and sendEmail recording how the send ended
// (every failure we can see is turned into FAILED; see sendSignupReminders).
// From the row alone there is no telling whether SES got the message, and a
// double send is worse than a missed one, so it counts as reminded: the person
// is skipped for the cooldown and the page shows it as their last reminder.
const NOT_DELIVERED = ['FAILED', 'BOUNCED', 'COMPLAINED'];

const attemptPrefixFor = (round, applicationId) => `${ATTEMPT_PREFIX}:${round}:${applicationId}:`;

/**
 * The sessions of a round's interviews in this cycle, cancelled interviews
 * excluded. A completed interview still counts: a signup on it means the
 * person sat it, which is booked.
 */
const roundSlotsWhere = ({ cycleId, round }) => ({
  interview: {
    cycleId,
    interviewType: { in: interviewTypesForRound(round) },
    status: { notIn: ['CANCELLED'] },
  },
});

/** In the round, not rejected, and no live signup on any session of it. */
const unbookedWhere = ({ cycleId, round }) => ({
  cycleId,
  currentRound: round,
  status: { notIn: ['REJECTED'] },
  slotSignups: {
    none: {
      status: { in: LIVE_SIGNUP_STATUSES },
      slot: roundSlotsWhere({ cycleId, round }),
    },
  },
});

/**
 * Everyone in the round with no live signup on any of its sessions, ordered by
 * name. Asked in one query rather than "everyone, minus whoever is placed", so
 * the send can recompute it without loading the whole roster.
 */
export async function findUnbookedApplications({ cycleId, round }, client = prisma) {
  return client.application.findMany({
    where: unbookedWhere({ cycleId, round }),
    select: { id: true, firstName: true, lastName: true, email: true, major1: true, graduationYear: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
}

/**
 * The round's sessions a candidate could book right now, by the same rule the
 * booking path refuses on (isSelfBookableNow): open interview, inside the
 * signup window, and not within the cutoff before it starts.
 */
export async function openSignupSessions({ cycleId, round, now = new Date() }, client = prisma) {
  const slots = await client.interviewSlot.findMany({
    where: {
      interview: { cycleId, interviewType: { in: interviewTypesForRound(round) }, status: { notIn: CLOSED_INTERVIEW_STATUSES } },
      candidateCapacity: { not: null },
    },
    select: {
      id: true,
      startTime: true,
      candidateCapacity: true,
      signupOpensAt: true,
      signupClosesAt: true,
      interview: { select: { status: true } },
    },
  });
  return slots.filter((slot) => isSelfBookableNow(slot, slot.interview, now));
}

/**
 * The last moment anyone can book one of `sessions`, formatted for an email,
 * or '' when there are none. Each session closes at its signupClosesAt or at
 * the self-booking cutoff, whichever comes first.
 */
export function signupDeadline(sessions) {
  if (!sessions?.length) return '';
  const latest = sessions.reduce((max, s) => {
    const closes = selfBookingClosesAt(s);
    return closes > max ? closes : max;
  }, new Date(0));
  return formatEmailDateTime(latest);
}

/**
 * `signup-reminder:<round>:<applicationId>:<sendId>|<recipient>` back into its
 * round and application. sendEmail appends the recipient; anything that does
 * not have this shape is somebody else's key and is ignored.
 */
export function parseAttemptKey(attemptKey) {
  const [key] = String(attemptKey ?? '').split('|');
  const [prefix, round, applicationId, sendId] = key.split(':');
  if (prefix !== ATTEMPT_PREFIX || !round || !applicationId || !sendId) return null;
  return { round, applicationId };
}

/**
 * Map(round -> Map(applicationId -> Date)) of the latest reminder each person
 * was sent, for every round at once. One query, so the overview can label
 * three rounds without asking three times. A send that failed, bounced or drew
 * a complaint never reached anyone and does not count; see NOT_DELIVERED for
 * why SENDING does.
 */
export async function lastRemindedByRound({ cycleId, applicationIds } = {}, client = prisma) {
  const rows = await client.communicationLog.findMany({
    where: {
      category: SIGNUP_REMINDER_CATEGORY,
      cycleId,
      status: { notIn: NOT_DELIVERED },
      attemptKey: { startsWith: `${ATTEMPT_PREFIX}:` },
    },
    select: { attemptKey: true, sentAt: true },
  });
  const wanted = applicationIds ? new Set(applicationIds) : null;
  const byRound = new Map();
  for (const row of rows) {
    const parsed = parseAttemptKey(row.attemptKey);
    if (!parsed || (wanted && !wanted.has(parsed.applicationId))) continue;
    if (!byRound.has(parsed.round)) byRound.set(parsed.round, new Map());
    const latest = byRound.get(parsed.round);
    const at = new Date(row.sentAt);
    if (!latest.has(parsed.applicationId) || latest.get(parsed.applicationId) < at) {
      latest.set(parsed.applicationId, at);
    }
  }
  return byRound;
}

/** Map(applicationId -> Date) of the latest reminder for this one round. */
export async function lastRemindedAt({ cycleId, round, applicationIds }, client = prisma) {
  const byRound = await lastRemindedByRound({ cycleId, applicationIds }, client);
  return byRound.get(String(round)) ?? new Map();
}

function reminderValues(application, { roundLabel, deadline }) {
  const firstName = (application.firstName || '').trim();
  return {
    firstName: firstName || 'there',
    fullName: [application.firstName, application.lastName].map((s) => (s || '').trim()).filter(Boolean).join(' '),
    round: roundLabel || '',
    deadline: deadline || '',
  };
}

/** Subject and HTML for one person's reminder. */
export async function renderSignupReminder(
  application,
  { subject = DEFAULT_SIGNUP_REMINDER_SUBJECT, message = DEFAULT_SIGNUP_REMINDER_MESSAGE, roundLabel, deadline, signupUrl }
) {
  const values = reminderValues(application, { roundLabel, deadline });
  const filledSubject = copySubject(subject, values);
  const { html } = await composeEmail(TEMPLATE_KEY, {
    subject: filledSubject,
    values,
    brand: 'UConsulting',
    parts: [part.copy(message), part.button(signupUrl, 'Pick a time'), part.link(signupUrl)],
  });
  return { subject: filledSubject, html };
}

/**
 * Decide, under a lock on (round, application), whether this person gets a
 * reminder now, and if so write the SENDING row that claims it.
 *
 * Returns 'CLAIMED', or the reason to skip: 'BUSY' (another send holds the
 * lock), 'BOOKED' (no longer unbooked in this round - booked since the list was
 * read, rejected, or moved on), 'RECENT' (reminded within the cooldown).
 *
 * The claim is written inside the transaction and committed with it, before
 * sendEmail runs. Once committed it is visible to whoever takes the lock next,
 * so the lock only has to cover the check and the write, not the send.
 * sendEmail then overwrites the row through the same attemptKey with how the
 * send ended.
 */
// sendEmail scopes the key to the address with `|recipient`, trimmed; the
// claim has to match it exactly for the send to overwrite it.
const claimKeyFor = (attemptKey, application) => `${attemptKey}|${String(application.email).trim()}`;

/**
 * Turn a claim that will never be overwritten into FAILED, so the person is
 * not skipped for an hour over a send that never happened. Only a row still
 * SENDING is touched: if sendEmail did record an outcome, that stands.
 * Best-effort; a failure here is logged, never thrown.
 */
async function releaseClaim(claimKey, error, client) {
  try {
    await client.communicationLog.updateMany({
      where: { attemptKey: claimKey, status: 'SENDING' },
      data: { status: 'FAILED', error: String(error?.message ?? error).slice(0, 2000) },
    });
  } catch (e) {
    console.error('[signupReminders] could not release a reminder claim:', e);
  }
}

async function claimReminder({ application, cycleId, round, attemptKey, triggeredById, now }, client) {
  return client.$transaction(
    async (tx) => {
      const [{ locked }] =
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${attemptPrefixFor(round, application.id)})) AS locked`;
      if (!locked) return 'BUSY';

      const stillUnbooked = await tx.application.count({
        where: { ...unbookedWhere({ cycleId, round }), id: application.id },
      });
      if (!stillUnbooked) return 'BOOKED';

      const recent = await tx.communicationLog.findFirst({
        where: {
          category: SIGNUP_REMINDER_CATEGORY,
          cycleId,
          status: { notIn: NOT_DELIVERED },
          attemptKey: { startsWith: attemptPrefixFor(round, application.id) },
          sentAt: { gte: new Date(now.getTime() - REMINDER_COOLDOWN_MS) },
        },
        select: { id: true },
      });
      if (recent) return 'RECENT';

      const recipient = String(application.email).trim();
      await tx.communicationLog.create({
        data: {
          channel: 'email',
          category: SIGNUP_REMINDER_CATEGORY,
          trigger: 'MANUAL',
          status: 'SENDING',
          recipient,
          recipientName: reminderValues(application, {}).fullName || null,
          triggeredById: triggeredById ?? null,
          cycleId,
          attemptKey: claimKeyFor(attemptKey, application),
        },
      });
      return 'CLAIMED';
    },
    { maxWait: 10 * 1000, timeout: 10 * 1000 }
  );
}

// Sends in flight at once. /api reaches Render through Vercel's rewrite proxy,
// which cuts a long response off: a coffee chat round of 200-300 people sent
// one at a time outlasts it, the admin sees an error while the sends carry on,
// and the retry they press next mails everyone a second time. Five matches the
// other bulk senders (decisionBatches.js, masterCommunications.js). The claim
// above is what makes that retry harmless if it happens anyway.
const SEND_CONCURRENCY = 5;

/**
 * Email each application its reminder, SEND_CONCURRENCY at a time, each one
 * claimed first (claimReminder). Never throws for a single person; returns
 * { sent: [applicationId], skipped: [applicationId], failed: [{ id, email, error }] }.
 *
 * Every send in one batch shares a sendId, which keeps each attemptKey unique
 * (it is a unique column, so a second reminder must not overwrite the first)
 * while still naming the round and application it was for.
 */
export async function sendSignupReminders(
  applications,
  { subject, message, roundLabel, deadline, signupUrl, cycleId, round, triggeredById, now = new Date() },
  client = prisma
) {
  const sendId = randomUUID();
  const outcomes = await mapWithConcurrency(
    applications,
    async (application) => {
      const attemptKey = `${attemptPrefixFor(round, application.id)}${sendId}`;
      let claimed = false;
      try {
        // Rendered before claiming, so an email that cannot be drawn never
        // leaves a claim behind to block the next attempt.
        const rendered = await renderSignupReminder(application, { subject, message, roundLabel, deadline, signupUrl });
        const claim = await claimReminder({ application, cycleId, round, attemptKey, triggeredById, now }, client);
        if (claim !== 'CLAIMED') return { skipped: true };
        claimed = true;

        // sendEmail never rejects in practice and records its own outcome over
        // the claim. If it does throw, it may not have, which the catch covers.
        const result = await sendEmail(application.email, rendered.subject, rendered.html, [], {
          category: SIGNUP_REMINDER_CATEGORY,
          trigger: 'MANUAL',
          recipientName: reminderValues(application, {}).fullName || null,
          triggeredById,
          cycleId,
          attemptKey,
        });
        return result?.success ? { sent: true } : { error: result?.error ?? 'Send failed' };
      } catch (error) {
        if (claimed) await releaseClaim(claimKeyFor(attemptKey, application), error, client);
        return { error: error?.message ?? String(error) };
      }
    },
    SEND_CONCURRENCY
  );

  const sent = [];
  const skipped = [];
  const failed = [];
  applications.forEach((application, i) => {
    const outcome = outcomes[i];
    if (outcome.sent) sent.push(application.id);
    else if (outcome.skipped) skipped.push(application.id);
    else failed.push({ id: application.id, email: application.email, error: outcome.error });
  });
  return { sent, skipped, failed };
}
