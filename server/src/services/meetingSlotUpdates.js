// Editing a GTKUC slot that people have already booked.
//
// A member editing their own slot and an admin editing anyone's slot differ only
// in what they are allowed to touch (the host) and whether they need telling
// afterwards (you don't email someone about their own edit). Everything else -
// validation, the write, and who hears about it - is the same, and lived in two
// route handlers that had already drifted: the member route refused to change
// the time at all once a slot had signups, and the admin route changed it
// silently, leaving candidates holding a calendar entry for a meeting that had
// moved. One service so there is one answer.

import prisma from '../prismaClient.js';
import {
  sendMeetingRescheduleEmail,
  sendMeetingRescheduleToMember,
} from './emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from './meetingComms.js';
import { localInputToUTC } from '../utils/timezoneUtils.js';

/** Carries the HTTP status the route should answer with. */
export class SlotUpdateError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SlotUpdateError';
    this.status = status;
  }
}

const SLOT_INCLUDE = {
  member: {
    select: { id: true, fullName: true, email: true, profileImage: true, graduationClass: true, role: true },
  },
  signups: { orderBy: { createdAt: 'asc' } },
  communications: { orderBy: { sentAt: 'desc' } },
};

/** Compare two nullable timestamps that may arrive as Date or string. */
const sameInstant = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
};

/**
 * Apply an edit to a GTKUC slot, then tell everyone whose plans just changed.
 *
 * `patch` holds only the fields the caller sent; anything absent is left alone,
 * which is what lets one function serve a location-only tweak and a full
 * reschedule. Times arrive as the LA-local strings the datetime inputs produce
 * and are converted here, the same way the create routes do it.
 *
 * `actorId` is the user making the change - used only to decide whether the
 * host needs an email, never for authorization. The routes own that.
 */
export async function updateMeetingSlot({ slotId, patch = {}, actorId = null, allowHostChange = false }) {
  const existing = await prisma.meetingSlot.findUnique({
    where: { id: slotId },
    include: { signups: true, member: { select: { id: true, fullName: true, email: true } } },
  });

  if (!existing) {
    throw new SlotUpdateError(404, 'Meeting slot not found');
  }

  const data = {};
  if (patch.location !== undefined) data.location = patch.location;
  if (patch.startTime !== undefined) data.startTime = localInputToUTC(patch.startTime);
  if (patch.endTime !== undefined) data.endTime = patch.endTime ? localInputToUTC(patch.endTime) : null;
  if (patch.capacity !== undefined) {
    data.capacity = Number.isInteger(patch.capacity) ? patch.capacity : existing.capacity;
  }

  if (allowHostChange && patch.memberId !== undefined && patch.memberId !== existing.memberId) {
    const host = await prisma.user.findUnique({ where: { id: patch.memberId } });
    if (!host) {
      throw new SlotUpdateError(400, 'Host member not found');
    }
    data.memberId = patch.memberId;
  }

  const nextStart = data.startTime ?? existing.startTime;
  const nextEnd = data.endTime !== undefined ? data.endTime : existing.endTime;
  const nextLocation = data.location ?? existing.location;
  const nextCapacity = data.capacity ?? existing.capacity;

  if (Number.isNaN(new Date(nextStart).getTime())) {
    throw new SlotUpdateError(400, 'Invalid start time');
  }
  if (nextEnd && new Date(nextEnd).getTime() <= new Date(nextStart).getTime()) {
    throw new SlotUpdateError(400, 'End time must be after the start time');
  }

  const timeChanged = !sameInstant(existing.startTime, nextStart) || !sameInstant(existing.endTime, nextEnd);
  const locationChanged = existing.location !== nextLocation;

  // Only guard the past on an actual move. Correcting the location of a slot
  // that has already happened is a fix, not a reschedule, and blocking it would
  // be the kind of rule that only ever gets in the way.
  if (timeChanged && new Date(nextStart).getTime() < Date.now()) {
    throw new SlotUpdateError(400, 'A meeting cannot be rescheduled into the past');
  }

  // Count signups inside the transaction: a booking landing between the check
  // and the write is exactly how capacity ends up below the number of people
  // already holding a place.
  const updated = await prisma.$transaction(async (tx) => {
    const signupCount = await tx.meetingSignup.count({ where: { slotId } });
    if (nextCapacity < signupCount) {
      throw new SlotUpdateError(
        409,
        `Capacity cannot be lower than the ${signupCount} candidate(s) already signed up. ` +
        'Cancel a signup first.'
      );
    }

    return tx.meetingSlot.update({ where: { id: slotId }, data, include: SLOT_INCLUDE });
  });

  const notified = { candidates: 0, host: false };

  // Capacity and host changes are invisible to a candidate's calendar, so they
  // are not worth an email. Time and location are the whole point of one.
  if (!timeChanged && !locationChanged) {
    return { slot: updated, notified, changed: { time: false, location: false } };
  }

  const next = { location: updated.location, startTime: updated.startTime, endTime: updated.endTime };
  const previous = { location: existing.location, startTime: existing.startTime, endTime: existing.endTime };
  const hostName = updated.member?.fullName || 'UC Consulting Member';

  const sends = updated.signups.map((signup) =>
    sendAndLogMeetingCommunication(
      () => sendMeetingRescheduleEmail(signup.email, signup.fullName, hostName, next, previous),
      {
        slotId: updated.id,
        signupId: signup.id,
        type: 'RESCHEDULED',
        recipient: signup.email,
        subject: MEETING_COMM_SUBJECTS.RESCHEDULED,
      }
    )
  );

  // The host hears about it only when somebody else moved their slot. A member
  // rescheduling their own does not need mail telling them what they just did.
  const notifyHost = Boolean(updated.member?.email) && updated.memberId !== actorId;
  if (notifyHost) {
    sends.push(
      sendAndLogMeetingCommunication(
        () => sendMeetingRescheduleToMember(updated.member.email, hostName, next, previous, {
          signupCount: updated.signups.length,
        }),
        {
          slotId: updated.id,
          signupId: null,
          type: 'RESCHEDULED',
          recipient: updated.member.email,
          subject: MEETING_COMM_SUBJECTS.RESCHEDULED_TO_HOST,
        }
      )
    );
  }

  await Promise.allSettled(sends);

  notified.candidates = updated.signups.length;
  notified.host = notifyHost;

  return { slot: updated, notified, changed: { time: timeChanged, location: locationChanged } };
}
