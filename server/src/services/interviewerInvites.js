// Telling an interviewer they are on, moved between, or off a session - and
// putting it on their calendar.
//
// This lived as a private helper inside routes/interviewSlotsAdmin.js, which is
// why three other ways of joining a roster sent nothing at all: a member signing
// themselves up and a member dropping out both live in routes/interviewSlotsMember.js,
// and the bulk legacy-group conversion could not afford a transaction per person.
// A roster changes in more than one place, so the telling belongs beside the
// queue rather than inside whichever route happened to need it first.
//
// The routes still decide *when* somebody should be told. This decides *how*.
//
// Nothing here throws. An interviewer who was not emailed is a problem with a
// Resend button next to it; a placement that failed because the email did is a
// worse one, and the roster is the record either way.

import prisma from '../prismaClient.js';
import config from '../config.js';
import { renderInterviewSlotEmail } from './emailNotifications.js';
import {
  SLOT_NOTIFICATION_SUBJECTS,
  flushNotifications,
  queueNotifications,
  queueNotificationsBulk,
} from './interviewSlotComms.js';

/** Where an interviewer goes to see what they are running. */
const interviewerCta = () => ({
  ctaUrl: `${config.clientUrl}/assigned-interviews`,
  ctaLabel: 'See my interviews',
});

/**
 * Send whatever was just queued, without making the caller wait for a mail
 * server. The route has already committed the roster change; the email is the
 * slower, less important half.
 */
function flushInBackground(ids, options, label) {
  flushNotifications(ids, (n) => renderInterviewSlotEmail(n, { ...interviewerCta(), ...options })).catch((e) =>
    console.error(`[${label}] flush failed`, e)
  );
}

/**
 * Tell one interviewer they have been put on, moved between, or taken off a session.
 *
 * `selfSignup` changes only the wording: somebody who claimed a session themselves
 * should not be told they "have been placed" in it, which reads like an admin did
 * something to them. The invite is identical either way - it is the thing they
 * actually wanted.
 */
export async function notifyInterviewer(
  slotId,
  userId,
  type,
  { fromSlotName = null, selfSignup = false } = {}
) {
  try {
    const [user, slot] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
      prisma.interviewSlot.findUnique({
        where: { id: slotId },
        select: { id: true, interview: { select: { title: true } } },
      }),
    ]);
    if (!user?.email || !slot) return;

    const ids = await prisma.$transaction((tx) =>
      queueNotifications(tx, [
        {
          slotId,
          type,
          recipient: user.email,
          subject: SLOT_NOTIFICATION_SUBJECTS[type](slot.interview.title),
        },
      ])
    );
    flushInBackground(ids, { fromSlotName, selfSignup }, 'notifyInterviewer');
  } catch (error) {
    // Telling somebody is not worth failing the placement over.
    console.error('[notifyInterviewer]', error);
  }
}

/**
 * The same message for a roster that was filled in one action.
 *
 * Deliberately not a loop over notifyInterviewer: that opens an interactive
 * transaction per person, and converting a round's worth of legacy groups is
 * dozens of sessions times their interviewers. Doing that row by row is what
 * produces P2028 - "transaction not found" - which reads like a Prisma bug and
 * is really a loop that outlasted its own transaction.
 *
 * Takes pairs that already exist in the database; it reads the addresses and
 * titles itself so callers do not have to carry them out of their transaction.
 */
export async function notifyInterviewersBulk(pairs, type = 'INTERVIEWER_ASSIGNED') {
  const wanted = (pairs ?? []).filter((p) => p?.slotId && p?.userId);
  if (wanted.length === 0) return [];

  try {
    const [users, slots] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: [...new Set(wanted.map((p) => p.userId))] } },
        select: { id: true, email: true },
      }),
      prisma.interviewSlot.findMany({
        where: { id: { in: [...new Set(wanted.map((p) => p.slotId))] } },
        select: { id: true, interview: { select: { title: true } } },
      }),
    ]);
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const titleById = new Map(slots.map((s) => [s.id, s.interview?.title]));

    const entries = wanted
      .filter((p) => emailById.get(p.userId) && titleById.get(p.slotId))
      .map((p) => ({
        slotId: p.slotId,
        type,
        recipient: emailById.get(p.userId),
        subject: SLOT_NOTIFICATION_SUBJECTS[type](titleById.get(p.slotId)),
      }));
    if (entries.length === 0) return [];

    const ids = await queueNotificationsBulk(entries);
    flushInBackground(ids, {}, 'notifyInterviewersBulk');
    return ids;
  } catch (error) {
    console.error('[notifyInterviewersBulk]', error);
    return [];
  }
}
