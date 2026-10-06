// Telling the people in an in-person session that its time or place changed.
//
// Editing a session used to save and say nothing: candidates and interviewers
// kept the old room on their calendars and found out at the door. Saving still
// says nothing, but marks the session (`updatePendingSince`), and the admin
// sends it with Send update in Edit Interview whenever they are ready.
//
// The route decides when to tell anyone; this decides who and how. It goes
// through the same queue as every slot email, so each send is recorded first,
// carries a calendar invite that updates the existing entry, and is held back
// like the rest when SCHEDULING_EMAILS is off.
//
// A virtual coffee chat never reaches here: its time and link are edited from
// its own panel, which emails its people itself.

import prisma from '../prismaClient.js';
import config from '../config.js';
import { renderInterviewSlotEmail } from './emailNotifications.js';
import { flushNotifications, queueNotificationsBulk, slotSubjectFormatter } from './interviewSlotComms.js';
import { queueInterviewerNotices } from './interviewerInvites.js';
import { sameTimeAndPlace } from './interviewSignupPolicy.js';

/** What a candidate or interviewer is told: the session's own room, else the interview's. */
export function sessionWhereabouts(slot) {
  return {
    startTime: slot.startTime,
    endTime: slot.endTime,
    location: slot.location || slot.interview?.location || null,
  };
}

/** True when an edit changed something somebody in the session would act on. */
export function sessionChanged(before, after) {
  return !sameTimeAndPlace(sessionWhereabouts(before), sessionWhereabouts(after));
}

const candidateRender = (notification) =>
  renderInterviewSlotEmail(notification, {
    ctaUrl: `${config.clientUrl}/interview-signup`,
    sessionChanged: true,
  });

/**
 * Email every confirmed candidate and every current interviewer in a session.
 *
 * Waitlisted candidates are left out: they hold a seat in another session and
 * are not coming to this one unless a place opens, which sends its own email.
 *
 * Who is in the session is read here, at save time, never taken from the page:
 * somebody may have booked since the admin opened it.
 *
 * Returns how many of each were queued, and `failed` naming each half that
 * could not be. The two are queued separately so one failing does not hide what
 * the other sent. Sending happens in the background; a send that fails shows on
 * the Interviews page with a Resend button.
 */
export async function notifySessionChanged(slotId) {
  const result = { candidates: 0, interviewers: 0, failed: [] };

  try {
    result.candidates = await queueCandidateNotices(slotId);
  } catch (error) {
    console.error('[sessionChangeNotices] candidate notices failed', error);
    result.failed.push('candidates');
  }

  try {
    const assignments = await prisma.interviewSlotAssignment.findMany({
      where: { slotId, removedAt: null },
      select: { userId: true },
    });
    const ids = await queueInterviewerNotices(
      assignments.map((a) => ({ slotId, userId: a.userId })),
      'INTERVIEWER_MOVED',
      { sessionChanged: true }
    );
    result.interviewers = ids.length;
  } catch (error) {
    console.error('[sessionChangeNotices] interviewer notices failed', error);
    result.failed.push('interviewers');
  }

  return result;
}

/**
 * The write that marks a session as having an update to send, or nothing when
 * the edit leaves its time and place as its people were told.
 *
 * Stamped fresh on every such edit, never kept from an earlier one: a send in
 * progress clears the mark only if it is still the one it read, so an edit
 * landing mid-send keeps a button for the details that send missed.
 */
export function pendingUpdateStamp(before, after) {
  return sessionChanged(before, after) ? { updatePendingSince: new Date() } : {};
}

/**
 * Save an interview, marking the sessions that inherit its location when that
 * changes: they told their people the interview's room, so it is their news
 * too. One transaction, so the location never changes without the marks.
 */
export async function updateInterviewMarkingSessions(interviewId, data) {
  if (data.location === undefined) return prisma.interview.update({ where: { id: interviewId }, data });
  return prisma.$transaction(async (tx) => {
    const before = await tx.interview.findUnique({ where: { id: interviewId }, select: { location: true } });
    const saved = await tx.interview.update({ where: { id: interviewId }, data });
    if (before && (before.location || null) !== (saved.location || null)) {
      await tx.interviewSlot.updateMany({
        where: { interviewId, OR: [{ location: null }, { location: '' }] },
        data: { updatePendingSince: new Date() },
      });
    }
    return saved;
  });
}

/** A claim older than this is a send whose server died; it no longer blocks. */
export const SEND_CLAIM_TTL_MS = 10 * 60 * 1000;

export class SessionUpdateRefused extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Send update: tell a session's people its current time and place, once.
 *
 * Claimed first (`updateSendingSince`, a conditional write) so two admins
 * pressing it at once send once. No transaction is held around the queueing,
 * which this file's senders forbid. The mark is cleared afterwards only if it
 * is still the one read here: a save landing mid-send restamps it, and those
 * details keep a button of their own.
 *
 * The mark stays when nothing was queued and something failed, so the button
 * can be pressed again. A half that did go out is not re-armed, or pressing
 * again would send it twice. A server dying mid-send leaves the mark and a
 * stale claim; after SEND_CLAIM_TTL_MS the button works again, and pressing it
 * may email some people twice, which beats nobody being told.
 *
 * Returns notifySessionChanged's result plus `pending`.
 */
export async function sendSessionUpdate(slotId) {
  const row = await prisma.interviewSlot.findUnique({
    where: { id: slotId },
    select: { updatePendingSince: true, updateSendingSince: true },
  });
  if (!row) throw new SessionUpdateRefused(404, 'NOT_FOUND', 'That session no longer exists');
  if (!row.updatePendingSince) {
    throw new SessionUpdateRefused(409, 'NO_PENDING_UPDATE', 'This update has already been sent');
  }

  // A live claim blocks every send, newer details included: two sends
  // overlapping would both email everyone. Newer details wait for the claim to
  // be released (normally seconds) and go out with the next press.
  const claimedAt = new Date();
  const held = row.updateSendingSince;
  if (held && held > new Date(claimedAt - SEND_CLAIM_TTL_MS)) {
    throw new SessionUpdateRefused(409, 'SEND_IN_PROGRESS', 'Someone is sending this update right now');
  }
  // Compare-and-swap on what was read, so two presses racing claim once.
  const { count } = await prisma.interviewSlot.updateMany({
    where: { id: slotId, updatePendingSince: row.updatePendingSince, updateSendingSince: held },
    data: { updateSendingSince: claimedAt },
  });
  if (count === 0) {
    throw new SessionUpdateRefused(409, 'SEND_IN_PROGRESS', 'Someone is sending this update right now');
  }

  let result;
  try {
    result = await notifySessionChanged(slotId);
  } catch (error) {
    console.error('[sessionChangeNotices] session update failed', error);
    result = { candidates: 0, interviewers: 0, failed: ['candidates', 'interviewers'] };
  }
  let pending = Boolean(result.failed?.length) && result.candidates + result.interviewers === 0;

  // The emails are queued by now, so neither write may fail the request: an
  // answer of "failed" would get them sent again.
  if (!pending) {
    let cleared;
    try {
      cleared = await prisma.interviewSlot.updateMany({
        where: { id: slotId, updatePendingSince: row.updatePendingSince },
        data: { updatePendingSince: null },
      });
    } catch (error) {
      // The mark could not be cleared, though this send did go out. The claim
      // is kept, so another send is refused until it goes stale rather than
      // emailing everyone the same details again. Only a database failing
      // mid-send gets here, and then a short wait beats a duplicate.
      console.error('[sessionChangeNotices] could not clear the pending update', error);
      return { ...result, pending: false };
    }
    // Nothing cleared: a save restamped it mid-send, and those newer details
    // still need sending.
    pending = cleared.count === 0;
  }
  await prisma.interviewSlot
    .updateMany({ where: { id: slotId, updateSendingSince: claimedAt }, data: { updateSendingSince: null } })
    .catch((error) => console.error('[sessionChangeNotices] could not release the send claim', error));
  return { ...result, pending };
}

async function queueCandidateNotices(slotId) {
  const signups = await prisma.interviewSlotSignup.findMany({
    where: { slotId, status: 'CONFIRMED' },
    select: {
      id: true,
      slotId: true,
      application: { select: { email: true } },
      slot: { select: { interview: { select: { title: true } } } },
    },
  });
  const withEmail = signups.filter((s) => s.application?.email);
  if (withEmail.length === 0) return 0;

  const subjectFor = await slotSubjectFormatter('MOVED_BY_ADMIN', { sessionChanged: true });
  const ids = await queueNotificationsBulk(
    withEmail.map((s) => ({
      slotId: s.slotId,
      signupId: s.id,
      type: 'MOVED_BY_ADMIN',
      recipient: s.application.email,
      subject: subjectFor(s.slot.interview.title),
    }))
  );
  flushNotifications(ids, candidateRender).catch((e) => console.error('[sessionChangeNotices] flush failed', e));
  return ids.length;
}
