// Scheduling email, recorded before it is sent.
//
// The shape is deliberately different from meetingComms.js, which logs a row
// after a send succeeds or fails. That cannot distinguish "we never tried" from
// "the process died between committing the booking and sending the mail" - and
// the second one is the case that produces a candidate with a confirmed seat and
// no idea it exists.
//
// So: rows are written QUEUED inside the transaction that caused them, and
// flipped to SENT or FAILED afterwards. Anything still QUEUED is a visible
// problem with a Resend button next to it, rather than silence.
//
// Nothing in here may be called from inside a transaction body. A serialisation
// retry re-runs the body, and a send that happened there would happen twice.

import { randomUUID } from 'node:crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendEmail } from './emailNotifications.js';
import { buildInvite, inviteUid, sequenceFrom, describeWhen } from './calendarInvite.js';
import { describeRoster } from '../utils/candidateRoster.js';

const SEND_ATTEMPTS = 3;

/**
 * Which notification types carry a calendar invite, and which way round.
 *
 * Absent from this table means no invite at all, and each absence is deliberate:
 * ADMIN_OVERFLOW_ALERT is about a candidate who could not be placed, so there is no
 * time to send; AVAILABILITY_REQUEST is sent before any session exists, which is the
 * whole reason InterviewSlotNotification.slotId is nullable.
 */
const INVITE_METHODS = {
  CONFIRMATION: 'REQUEST',
  WAITLIST_ADDED: 'REQUEST',
  PROMOTED: 'REQUEST',
  MOVED_BY_ADMIN: 'REQUEST',
  INTERVIEWER_ASSIGNED: 'REQUEST',
  INTERVIEWER_MOVED: 'REQUEST',
  REMINDER: 'REQUEST',
  FALLBACK_RELEASED: 'CANCEL',
  CANCELLATION: 'CANCEL',
  INTERVIEWER_REMOVED: 'CANCEL',
};

/**
 * Notifications addressed to an interviewer rather than a candidate.
 *
 * These are the ones that carry the candidate roster: an interviewer needs to
 * know who they are seeing, and a candidate must never learn who else is in the
 * round. Read as a set rather than by checking for a `signupId`, because a
 * missing signup also describes a message that simply has no candidate.
 */
export const INTERVIEWER_NOTIFICATION_TYPES = new Set([
  'INTERVIEWER_ASSIGNED',
  'INTERVIEWER_MOVED',
  'INTERVIEWER_REMOVED',
]);

/**
 * The stable identity of "this person's seat at this thing", which is what decides
 * whether a later invite moves the existing calendar entry or adds a second one.
 *
 * Candidates key on the signup, because a move updates slotId on that same row - so
 * the seat survives being moved and the entry follows it.
 *
 * Interviewers have no assignment id on the notification, so they key on the
 * interview plus their address. That is exactly right for a move, which
 * /slot-assignments/:id/move restricts to one interview ("Moving somebody between
 * interviews is a different act anyway"), so the new time lands on the entry they
 * already have. Known limitation: one interviewer staffing two sittings of the same
 * interview collapses to a single entry. Fixing that properly means persisting the
 * assignment id on the notification row.
 */
function calendarKeyFor(notification) {
  if (notification.signupId) return inviteUid('signup', notification.signupId);
  const interviewId = notification.interviewId ?? notification.slot?.interviewId;
  if (!interviewId) return null;
  return inviteUid('interviewer', `${interviewId}-${notification.recipient.toLowerCase()}`);
}

/**
 * Build the .ics for one notification, or null when this one does not carry a time.
 *
 * Never throws: a booking that already committed must not be reported as failed
 * because its invite could not be assembled. The email still goes without it.
 *
 * Note this reads the time from notification.slot rather than the rendered body -
 * the CANCELLATION and INTERVIEWER_REMOVED templates deliberately strip the details
 * card, but a CANCEL still has to name the event it is cancelling.
 */
export function inviteFor(notification) {
  try {
    const method = INVITE_METHODS[notification.type];
    const slot = notification.slot;
    if (!method || !slot?.startTime) return null;

    const uid = calendarKeyFor(notification);
    if (!uid) return null;

    const interview = slot.interview ?? notification.interview;
    const organizerEmail = (process.env.EMAIL_FROM ?? '').replace(/['"]/g, '').trim();
    if (!organizerEmail) return null;

    const where = slot.location || interview?.location || null;
    const when = describeWhen(slot.startTime, slot.endTime);
    const application = notification.signup?.application;
    // Who this interviewer is seeing. Only on a REQUEST: a CANCEL exists to
    // remove an entry, and listing candidates on the way out tells somebody who
    // is no longer running the session who was going to be in it.
    const roster =
      method === 'REQUEST' && INTERVIEWER_NOTIFICATION_TYPES.has(notification.type)
        ? describeRoster(notification.candidateRoster)
        : null;

    return buildInvite({
      uid,
      // Every notification is a fresh row, so queuedAt strictly increases per event.
      // That makes it a better sequence source than any entity's updatedAt: an
      // interviewer move changes the assignment, not the slot it points at.
      sequence: sequenceFrom(notification.queuedAt),
      method,
      start: slot.startTime,
      end: slot.endTime,
      summary: interview?.title ?? 'UConsulting Interview',
      description: [
        slot.label ? `Session: ${slot.label}` : null,
        when ? `When: ${when}` : null,
        where ? `Where: ${where}` : null,
        roster ? `Candidates: ${roster}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      location: where,
      organizerEmail,
      attendeeEmail: notification.recipient,
      attendeeName: application ? `${application.firstName} ${application.lastName}`.trim() : undefined,
    });
  } catch (error) {
    console.warn('[inviteFor] could not build a calendar invite; sending without one', {
      notificationId: notification?.id,
      type: notification?.type,
      error: error?.message,
    });
    return null;
  }
}

export const SLOT_NOTIFICATION_SUBJECTS = {
  CONFIRMATION: (interviewTitle) => `You're confirmed - ${interviewTitle}`,
  WAITLIST_ADDED: (interviewTitle) => `Your spot is booked, and you're on the waitlist - ${interviewTitle}`,
  PROMOTED: (interviewTitle) => `Good news - you got your preferred time for ${interviewTitle}`,
  FALLBACK_RELEASED: (interviewTitle) => `Your time has changed - ${interviewTitle}`,
  CANCELLATION: (interviewTitle) => `Your booking is cancelled - ${interviewTitle}`,
  MOVED_BY_ADMIN: (interviewTitle) => `Your time has been updated - ${interviewTitle}`,
  ADMIN_OVERFLOW_ALERT: (interviewTitle) => `Action needed: a candidate could not be scheduled for ${interviewTitle}`,
  AVAILABILITY_REQUEST: (interviewTitle) => `When can you interview? - ${interviewTitle}`,
  INTERVIEWER_ASSIGNED: (interviewTitle) => `You're interviewing - ${interviewTitle}`,
  INTERVIEWER_REMOVED: (interviewTitle) => `You've been taken off a session - ${interviewTitle}`,
  REMINDER: (interviewTitle) => `Reminder - ${interviewTitle}`,
};

/**
 * Record notifications as QUEUED. Call inside the transaction that caused them,
 * passing its `tx`, so a rolled-back booking cannot leave an email behind.
 */
export async function queueNotifications(tx, entries) {
  if (!entries?.length) return [];
  const created = [];
  for (const entry of entries) {
    // A booking that worked must not fail because we could not work out who to
    // tell. Skipping leaves no row, which is honest - there was never a message
    // to send - and the seat still stands.
    if ((!entry.slotId && !entry.interviewId) || !entry.recipient) {
      console.warn('[queueNotifications] skipped a notification with no slot or recipient', {
        type: entry.type,
        slotId: entry.slotId ?? null,
        hasRecipient: Boolean(entry.recipient),
      });
      continue;
    }
    created.push(
      await tx.interviewSlotNotification.create({
        data: {
          slotId: entry.slotId ?? null,
          interviewId: entry.interviewId ?? null,
          signupId: entry.signupId ?? null,
          type: entry.type,
          recipient: entry.recipient,
          subject: entry.subject ?? '',
          status: 'QUEUED',
        },
        select: { id: true },
      })
    );
  }
  return created.map((row) => row.id);
}

/**
 * Queue many notifications at once, outside a transaction.
 *
 * The per-row version holds an interactive transaction open for the length of
 * the loop, which is right when a booking has to queue its own confirmation
 * atomically. Asking eighty members for their availability is not that: it is a
 * bulk send with nothing to roll back, and doing it row by row inside one
 * transaction blows the timeout - measured as P2028, "transaction not found",
 * which reads like a bug in Prisma and is really a loop that took too long.
 */
export async function queueNotificationsBulk(entries) {
  const rows = (entries ?? [])
    .filter((entry) => (entry.slotId || entry.interviewId) && entry.recipient)
    .map((entry) => ({
      id: randomUUID(),
      slotId: entry.slotId ?? null,
      interviewId: entry.interviewId ?? null,
      signupId: entry.signupId ?? null,
      type: entry.type,
      recipient: entry.recipient,
      subject: entry.subject ?? '',
      status: 'QUEUED',
    }));
  if (rows.length === 0) return [];

  await prisma.interviewSlotNotification.createMany({ data: rows, skipDuplicates: true });
  return rows.map((row) => row.id);
}

/**
 * The confirmed candidates in a session, for an interviewer's invite and email.
 *
 * A separate read rather than an include on the notification, because it is only
 * ever wanted by the three interviewer notifications: folding it into the main
 * query would make every candidate's own confirmation drag the whole session's
 * roster along behind it.
 *
 * Names only. Firstname, lastname and the rotation label are identity, which is
 * exactly what utils/lockedRecords leaves standing on a sealed row - nothing
 * here touches scores, evaluations or anything the person wrote.
 *
 * Never throws: an invite missing its roster is worth sending, and an interviewer
 * with no email at all is not the better outcome.
 */
export async function loadCandidateRoster(notification, client = prisma) {
  if (!INTERVIEWER_NOTIFICATION_TYPES.has(notification?.type)) return [];
  const slotId = notification.slotId ?? notification.slot?.id;
  if (!slotId) return [];
  try {
    return await client.interviewSlotSignup.findMany({
      where: { slotId, status: 'CONFIRMED' },
      orderBy: [{ groupLabel: 'asc' }, { application: { lastName: 'asc' } }],
      select: {
        groupLabel: true,
        application: { select: { firstName: true, lastName: true } },
      },
    });
  } catch (error) {
    console.warn('[loadCandidateRoster] could not read the roster; sending without it', {
      slotId,
      error: error?.message,
    });
    return [];
  }
}

/**
 * Send one queued notification and record the outcome.
 *
 * Claims the row first with a conditional update, the same idiom
 * decisionBatches.sendOne uses: two concurrent flushes, or a flush racing an
 * admin pressing Resend, cannot both send the same message.
 */
async function sendOne(notificationId, renderBody) {
  // The kill switch. Recorded rather than silent: the row stays, marked
  // SUPPRESSED, so the roster shows exactly who would have been emailed and can
  // send it for real once config.schedulingEmailsEnabled is turned on.
  if (!config.schedulingEmailsEnabled) {
    await prisma.interviewSlotNotification.updateMany({
      where: { id: notificationId, status: { in: ['QUEUED', 'FAILED'] } },
      data: { status: 'SUPPRESSED', error: 'Scheduling emails are switched off (SCHEDULING_EMAILS)' },
    });
    return { notificationId, suppressed: true };
  }

  const { count } = await prisma.interviewSlotNotification.updateMany({
    where: { id: notificationId, status: { in: ['QUEUED', 'FAILED', 'SUPPRESSED'] } },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });
  if (count === 0) return { notificationId, skipped: true };

  const notification = await prisma.interviewSlotNotification.findUnique({
    where: { id: notificationId },
    include: {
      slot: { include: { interview: { select: { title: true, location: true, interviewType: true } } } },
      interview: { select: { title: true, location: true, interviewType: true } },
      signup: { include: { application: { select: { firstName: true, lastName: true, email: true } } } },
    },
  });

  // Read once and hung on the notification, so the email body and the .ics name
  // the same people rather than querying for them twice.
  notification.candidateRoster = await loadCandidateRoster(notification);

  try {
    const html = await renderBody(notification);
    // Built once, outside the retry loop: it carries a DTSTAMP, and rebuilding it per
    // attempt would send three subtly different files for one booking.
    const invite = inviteFor(notification);
    let result = { success: false, error: 'Not attempted' };
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      result = await sendEmail(
        notification.recipient,
        notification.subject,
        html,
        invite ? [invite] : []
      );
      if (result.success) break;
      if (attempt < SEND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }

    if (result.success) {
      await prisma.interviewSlotNotification.update({
        where: { id: notificationId },
        data: { status: 'SENT', sentAt: new Date(), error: null },
      });
      return { notificationId, success: true };
    }

    await prisma.interviewSlotNotification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', error: String(result.error).slice(0, 1000) },
    });
    return { notificationId, success: false, error: result.error };
  } catch (error) {
    await prisma.interviewSlotNotification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', error: String(error?.message ?? error).slice(0, 1000) },
    });
    return { notificationId, success: false, error: error?.message };
  }
}

/**
 * Send everything queued by a just-committed transaction.
 *
 * Never throws. A booking that succeeded must not be reported as a failure
 * because the mail server was unreachable - the seat is real either way, and the
 * candidate can see it in the portal. The unsent row is what gets chased.
 */
export async function flushNotifications(notificationIds, renderBody) {
  if (!notificationIds?.length) return [];
  const results = [];
  for (const id of notificationIds) {
    try {
      results.push(await sendOne(id, renderBody));
    } catch (error) {
      console.error('[flushNotifications] unexpected failure', id, error);
      results.push({ notificationId: id, success: false, error: error?.message });
    }
  }
  return results;
}

/** Un-stick anything left SENDING by a crashed process, so Resend can pick it up. */
export async function requeueStalledNotifications(olderThanMs = 15 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { count } = await prisma.interviewSlotNotification.updateMany({
    where: { status: 'SENDING', queuedAt: { lt: cutoff } },
    data: { status: 'FAILED', error: 'Sender stopped before recording an outcome' },
  });
  return count;
}

export { sendOne };
