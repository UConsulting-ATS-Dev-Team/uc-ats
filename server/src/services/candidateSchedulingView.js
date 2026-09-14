// What one candidate sees on the scheduling page.
//
// Extracted so there is exactly one answer to that question. The candidate route
// serves it to the candidate, and the admin preview serves the same function for
// a chosen applicant - if these were two queries they would drift, and a preview
// that lies is worse than no preview at all.
//
// Nothing here takes the caller's identity into account. It answers "what does
// THIS application see", and the routes decide who is allowed to ask.

import prisma from '../prismaClient.js';
import { MODIFY_CUTOFF_HOURS, canModify } from '../utils/schedulingWindows.js';
import { interviewTypesForRound } from '../utils/interviewRounds.js';
import { isCandidateBookable, seatsRemaining } from './interviewSignupPolicy.js';

const LIVE = ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'];

/**
 * One slot as a candidate sees it.
 *
 * Never includes who else is in it. A seat count is necessary - first come
 * first served is unusable if you cannot see what is left - but the roster is
 * not the candidate's business, the same rule the GTKUC endpoints follow.
 */
const toCandidateSlot = (slot, confirmedCount, ownSignup, now) => ({
  id: slot.id,
  label: slot.label,
  startTime: slot.startTime,
  endTime: slot.endTime,
  location: slot.location,
  capacity: slot.candidateCapacity,
  seatsRemaining: Math.max(0, seatsRemaining(slot, confirmedCount) ?? 0),
  isFull: (seatsRemaining(slot, confirmedCount) ?? 0) <= 0,
  isOpen: isCandidateBookable(slot, now),
  yourStatus: ownSignup?.slotId === slot.id ? ownSignup.status : null,
});

/** Where this application currently stands. */
export async function getOwnSignups(applicationId, client = prisma) {
  const signups = await client.interviewSlotSignup.findMany({
    where: { applicationId, status: { in: LIVE } },
    include: {
      slot: { include: { interview: { select: { id: true, title: true, interviewType: true, location: true } } } },
    },
    orderBy: { signedUpAt: 'asc' },
  });

  return {
    modifyCutoffHours: MODIFY_CUTOFF_HOURS,
    signups: signups.map((signup) => ({
      id: signup.id,
      status: signup.status,
      interview: signup.slot.interview,
      slot: {
        id: signup.slot.id,
        label: signup.slot.label,
        startTime: signup.slot.startTime,
        endTime: signup.slot.endTime,
        location: signup.slot.location || signup.slot.interview.location,
      },
      // Computed here rather than in the page, so one rule governs both the
      // button state and what the server will actually allow.
      canModify: canModify(signup.slot.startTime),
    })),
  };
}

/**
 * What this application can book.
 *
 * Eligibility is the round they are sitting in, mapped to the interview types
 * that serve it - someone who has passed coffee chats is never offered one.
 */
export async function getBookingOptions(application, cycleId, client = prisma) {
  const now = new Date();

  // Rejected candidates are not scheduling anything. Eligibility used to be
  // decided on currentRound alone, which left somebody who had just been turned
  // down still looking at a booking page for the round they were cut from -
  // and, if they booked, sitting in an interviewer's roster.
  if (application.status === 'REJECTED') {
    return { modifyCutoffHours: MODIFY_CUTOFF_HOURS, interviews: [], reason: 'NOT_ADVANCING' };
  }

  const eligibleTypes = interviewTypesForRound(application.currentRound);
  if (eligibleTypes.length === 0) {
    return { modifyCutoffHours: MODIFY_CUTOFF_HOURS, interviews: [], reason: 'NOT_IN_A_SCHEDULING_ROUND' };
  }

  const interviews = await client.interview.findMany({
    where: { cycleId, interviewType: { in: eligibleTypes }, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
    orderBy: { startDate: 'asc' },
    include: { slots: { orderBy: { startTime: 'asc' } } },
  });

  const slotIds = interviews.flatMap((i) => i.slots.map((s) => s.id));
  const counts = slotIds.length
    ? await client.interviewSlotSignup.groupBy({
        by: ['slotId'],
        where: { slotId: { in: slotIds }, status: 'CONFIRMED' },
        _count: { _all: true },
      })
    : [];
  const confirmedBySlot = new Map(counts.map((row) => [row.slotId, row._count._all]));

  const own = await client.interviewSlotSignup.findMany({
    where: { applicationId: application.id, status: { in: LIVE } },
    select: { id: true, slotId: true, interviewId: true, status: true },
  });
  const ownByInterview = new Map(own.map((row) => [row.interviewId, row]));

  const visible = interviews.filter((interview) =>
    interview.slots.some((slot) => slot.candidateCapacity != null)
  );

  return {
    modifyCutoffHours: MODIFY_CUTOFF_HOURS,
    // Why the list is empty, so an admin previewing it is told rather than left
    // guessing between "no interviews", "no seats configured" and "wrong round".
    reason:
      visible.length > 0
        ? null
        : interviews.length > 0
          ? 'NO_BOOKABLE_SESSIONS'
          : 'NO_INTERVIEWS_FOR_ROUND',
    interviews: visible.map((interview) => ({
      id: interview.id,
      title: interview.title,
      interviewType: interview.interviewType,
      location: interview.location,
      yourSignup: ownByInterview.get(interview.id) ?? null,
      slots: interview.slots
        .filter((slot) => slot.candidateCapacity != null)
        .map((slot) =>
          toCandidateSlot(slot, confirmedBySlot.get(slot.id) ?? 0, ownByInterview.get(interview.id), now)
        ),
    })),
  };
}

export const EMPTY_REASONS = {
  NOT_ADVANCING:
    'This candidate is not moving forward in the cycle, so they are not offered any interview times.',
  NOT_IN_A_SCHEDULING_ROUND:
    'This candidate is not in a round that has interview scheduling. Only coffee chat and first round candidates see anything here.',
  NO_INTERVIEWS_FOR_ROUND: 'No interview has been created for this round in the active cycle.',
  NO_BOOKABLE_SESSIONS:
    'The interviews for this round have no sessions with a seat count, so nothing is open to candidates yet.',
};
