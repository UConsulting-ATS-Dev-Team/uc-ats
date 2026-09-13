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

import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendEmail } from './emailNotifications.js';

const SEND_ATTEMPTS = 3;

export const SLOT_NOTIFICATION_SUBJECTS = {
  CONFIRMATION: (interviewTitle) => `You're confirmed - ${interviewTitle}`,
  WAITLIST_ADDED: (interviewTitle) => `Your spot is booked, and you're on the waitlist - ${interviewTitle}`,
  PROMOTED: (interviewTitle) => `Good news - you got your preferred time for ${interviewTitle}`,
  FALLBACK_RELEASED: (interviewTitle) => `Your time has changed - ${interviewTitle}`,
  CANCELLATION: (interviewTitle) => `Your booking is cancelled - ${interviewTitle}`,
  MOVED_BY_ADMIN: (interviewTitle) => `Your time has been updated - ${interviewTitle}`,
  ADMIN_OVERFLOW_ALERT: (interviewTitle) => `Action needed: a candidate could not be scheduled for ${interviewTitle}`,
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
    created.push(
      await tx.interviewSlotNotification.create({
        data: {
          slotId: entry.slotId,
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
      signup: { include: { application: { select: { firstName: true, lastName: true, email: true } } } },
    },
  });

  try {
    const html = await renderBody(notification);
    let result = { success: false, error: 'Not attempted' };
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      result = await sendEmail(notification.recipient, notification.subject, html);
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
