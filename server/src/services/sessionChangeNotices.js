// Telling the people in an in-person session that its time or place changed.
//
// Editing a session used to save and say nothing: candidates and interviewers
// kept the old room on their calendars and found out at the door. The admin
// now opts in from Edit Interview, and this sends it.
//
// The route decides whether to tell anyone; this decides who and how. It goes
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
