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

/**
 * Turn a refused delivery back into a throw.
 *
 * The senders in emailNotifications catch provider errors themselves and resolve
 * with `{ success: false, error }`. sendAndLogMeetingCommunication only logs
 * FAILED when the function it is given throws, so without this a rejected email
 * would be logged as SENT and counted as a notified recipient, and the edit page
 * would tell the person their candidates had been emailed when none of them had.
 */
const sendOrThrow = async (send) => {
  const result = await send();
  if (result && result.success === false) {
    throw new Error(result.error || 'email send failed');
  }
  return result;
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

  // localInputToUTC returns null for anything that is not exactly
  // YYYY-MM-DDTHH:mm, so the conversion has to be checked rather than assigned.
  // Unchecked, a malformed start is masked by the fallback to the existing start
  // during validation and then fails Prisma's required column as a 500, and a
  // malformed end silently clears the end time instead of being refused.
  if (patch.startTime !== undefined) {
    const startTime = localInputToUTC(patch.startTime);
    if (!startTime) {
      throw new SlotUpdateError(400, 'Invalid start time');
    }
    data.startTime = startTime;
  }
  if (patch.endTime !== undefined) {
    if (patch.endTime) {
      const endTime = localInputToUTC(patch.endTime);
      if (!endTime) {
        throw new SlotUpdateError(400, 'Invalid end time');
      }
      data.endTime = endTime;
    } else {
      data.endTime = null;
    }
  }
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

  // Capacity must not drop below the number of people already holding a place.
  //
  // The row lock serializes this against anything else that takes it, so two
  // simultaneous edits to the same slot cannot both pass the check. It does not
  // make the guard airtight: booking a slot (POST /api/my-meeting-signups) takes
  // no lock and the database has no constraint tying capacity to the signup
  // count, so a booking that commits between this count and the update is still
  // invisible here. That same gap is what lets a slot be overbooked in the first
  // place, and closing it properly means locking the slot on the booking path
  // too. Treat this as a guard against the common case, not a guarantee.
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM meeting_slots WHERE id = ${slotId} FOR UPDATE`;

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

  // Delivered alongside expected, so a page can report a shortfall without
  // knowing any of the rules about who gets mail and when.
  const notified = { candidates: 0, candidatesExpected: 0, host: false, hostExpected: false };

  // Capacity and host changes are invisible to a candidate's calendar, so they
  // are not worth an email. Time and location are the whole point of one.
  if (!timeChanged && !locationChanged) {
    return { slot: updated, notified, changed: { time: false, location: false } };
  }

  const next = { location: updated.location, startTime: updated.startTime, endTime: updated.endTime };
  const previous = { location: existing.location, startTime: existing.startTime, endTime: existing.endTime };
  const hostName = updated.member?.fullName || 'UC Consulting Member';

  const candidateSends = updated.signups.map((signup) =>
    sendAndLogMeetingCommunication(
      () => sendOrThrow(() => sendMeetingRescheduleEmail(signup.email, signup.fullName, hostName, next, previous)),
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
  const shouldNotifyHost = Boolean(updated.member?.email) && updated.memberId !== actorId;
  const hostSend = shouldNotifyHost
    ? sendAndLogMeetingCommunication(
        () => sendOrThrow(() => sendMeetingRescheduleToMember(updated.member.email, hostName, next, previous, {
          signupCount: updated.signups.length,
        })),
        {
          slotId: updated.id,
          signupId: null,
          type: 'RESCHEDULED',
          recipient: updated.member.email,
          subject: MEETING_COMM_SUBJECTS.RESCHEDULED_TO_HOST,
        }
      )
    : null;

  const [candidateResults, hostResult] = await Promise.all([
    Promise.allSettled(candidateSends),
    hostSend ? hostSend.catch(() => ({ ok: false })) : Promise.resolve(null),
  ]);

  // Count what was delivered, not what was attempted. The edit pages report
  // this number back to whoever made the change, so it has to be true.
  notified.candidates = candidateResults.filter((r) => r.status === 'fulfilled' && r.value?.ok).length;
  notified.candidatesExpected = updated.signups.length;
  notified.host = Boolean(hostResult?.ok);
  notified.hostExpected = shouldNotifyHost;

  return { slot: updated, notified, changed: { time: timeChanged, location: locationChanged } };
}
