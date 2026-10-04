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

import { randomUUID } from 'node:crypto';
import prisma from '../prismaClient.js';
import { interviewTypesForRound } from '../utils/interviewRounds.js';
import { formatEmailDateTime } from '../utils/timezoneUtils.js';
import { isCandidateBookable } from './interviewSignupPolicy.js';
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
// No {{deadline}}: it is blank whenever a session has no closing time, and the
// default has to read well either way.
export const DEFAULT_SIGNUP_REMINDER_MESSAGE = [
  'Hi {{firstName}},',
  '',
  "You're in **{{round}}** for UConsulting, but you haven't picked a time yet. Sessions fill up, so grab one while there's still a choice.",
].join('\n');

export const SIGNUP_REMINDER_MERGE_FIELDS = ['firstName', 'fullName', 'round', 'deadline'];

const ATTEMPT_PREFIX = 'signup-reminder';

/** The sessions of a round's interviews in this cycle, cancelled interviews excluded. */
const roundSlotsWhere = ({ cycleId, round }) => ({
  interview: {
    cycleId,
    interviewType: { in: interviewTypesForRound(round) },
    status: { notIn: ['CANCELLED'] },
  },
});

/**
 * Everyone in the round with no live signup on any of its sessions, ordered by
 * name. Asked in one query rather than "everyone, minus whoever is placed", so
 * the send can recompute it without loading the whole roster.
 */
export async function findUnbookedApplications({ cycleId, round }, client = prisma) {
  return client.application.findMany({
    where: {
      cycleId,
      currentRound: round,
      status: { notIn: ['REJECTED'] },
      slotSignups: {
        none: {
          status: { in: LIVE_SIGNUP_STATUSES },
          slot: roundSlotsWhere({ cycleId, round }),
        },
      },
    },
    select: { id: true, firstName: true, lastName: true, email: true, major1: true, graduationYear: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
}

/** The round's sessions a candidate could book right now. */
export async function openSignupSessions({ cycleId, round, now = new Date() }, client = prisma) {
  const slots = await client.interviewSlot.findMany({
    where: { ...roundSlotsWhere({ cycleId, round }), candidateCapacity: { not: null } },
    select: { id: true, candidateCapacity: true, signupOpensAt: true, signupClosesAt: true },
  });
  return slots.filter((slot) => isCandidateBookable(slot, now));
}

/**
 * The last moment anyone can book, formatted for an email, or '' when there is
 * no such moment. A session that never closes means there is no deadline to
 * quote, even if every other session has one.
 */
export function signupDeadline(sessions) {
  if (!sessions?.length || sessions.some((s) => !s.signupClosesAt)) return '';
  const latest = sessions.reduce((max, s) => (new Date(s.signupClosesAt) > max ? new Date(s.signupClosesAt) : max), new Date(0));
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
 * three rounds without asking three times. A FAILED send never reached anyone
 * and does not count.
 */
export async function lastRemindedByRound({ cycleId, applicationIds } = {}, client = prisma) {
  const rows = await client.communicationLog.findMany({
    where: {
      category: SIGNUP_REMINDER_CATEGORY,
      cycleId,
      status: { not: 'FAILED' },
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

// Sends in flight at once. /api reaches Render through Vercel's rewrite proxy,
// which cuts a long response off: a coffee chat round of 200-300 people sent
// one at a time outlasts it, the admin sees an error while the sends carry on,
// and the retry they press next mails everyone a second time. Five matches the
// other bulk senders (decisionBatches.js, masterCommunications.js).
const SEND_CONCURRENCY = 5;

/**
 * Email each application its reminder, SEND_CONCURRENCY at a time. Never
 * throws for a single failed send; returns
 * { sent: [applicationId], failed: [{ id, email, error }] }.
 *
 * Every send in one batch shares a sendId, which keeps each attemptKey unique
 * (it is a unique column, so a second reminder must not overwrite the first)
 * while still naming the round and application it was for.
 */
export async function sendSignupReminders(
  applications,
  { subject, message, roundLabel, deadline, signupUrl, cycleId, round, triggeredById }
) {
  const sendId = randomUUID();
  const outcomes = await mapWithConcurrency(
    applications,
    async (application) => {
      try {
        const rendered = await renderSignupReminder(application, { subject, message, roundLabel, deadline, signupUrl });
        const result = await sendEmail(application.email, rendered.subject, rendered.html, [], {
          category: SIGNUP_REMINDER_CATEGORY,
          trigger: 'MANUAL',
          recipientName: reminderValues(application, {}).fullName || null,
          triggeredById,
          cycleId,
          attemptKey: `${ATTEMPT_PREFIX}:${round}:${application.id}:${sendId}`,
        });
        return result?.success ? null : result?.error ?? 'Send failed';
      } catch (error) {
        return error?.message ?? String(error);
      }
    },
    SEND_CONCURRENCY
  );

  const sent = [];
  const failed = [];
  applications.forEach((application, i) => {
    if (outcomes[i] === null) sent.push(application.id);
    else failed.push({ id: application.id, email: application.email, error: outcomes[i] });
  });
  return { sent, failed };
}
