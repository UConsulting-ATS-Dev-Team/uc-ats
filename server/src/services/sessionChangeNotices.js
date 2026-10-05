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
import { notifyInterviewersBulk } from './interviewerInvites.js';
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
 * Returns how many of each were queued. Sending happens in the background;
 * anything that fails shows on the Interviews page with a Resend button.
 */
export async function notifySessionChanged(slotId) {
  const [signups, assignments] = await Promise.all([
    prisma.interviewSlotSignup.findMany({
      where: { slotId, status: 'CONFIRMED' },
      select: {
        id: true,
        slotId: true,
        application: { select: { email: true } },
        slot: { select: { interview: { select: { title: true } } } },
      },
    }),
    prisma.interviewSlotAssignment.findMany({
      where: { slotId, removedAt: null },
      select: { userId: true },
    }),
  ]);

  let candidates = 0;
  const withEmail = signups.filter((s) => s.application?.email);
  if (withEmail.length > 0) {
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
    candidates = ids.length;
    flushNotifications(ids, candidateRender).catch((e) => console.error('[sessionChangeNotices] flush failed', e));
  }

  const interviewerIds = await notifyInterviewersBulk(
    assignments.map((a) => ({ slotId, userId: a.userId })),
    'INTERVIEWER_MOVED',
    { sessionChanged: true }
  );

  return { candidates, interviewers: interviewerIds.length };
}
