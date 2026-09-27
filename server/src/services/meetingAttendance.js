// Whether a GTKUC slot's attendance has been taken.
//
// `MeetingSignup.attended` defaults to false, so on its own it cannot tell a
// no-show from someone the host never got round to marking. A slot's
// attendance counts as taken when either:
//   - someone pressed "Attendance done" on it (`attendanceMarkedAt`), which is
//     how a host records no-shows, or
//   - every signup is checked, which needs no extra click.
// Anything else that has ended with signups is outstanding. The automatic
// reminder, the admin's manual reminders and the admin page all read this one
// definition.

import prisma from '../prismaClient.js';

// A slot with no end time is treated as an hour long, as the slot page does.
export const DEFAULT_SLOT_HOURS = 1;
const HOUR_MS = 60 * 60 * 1000;

export const slotEndTime = (slot) =>
  slot.endTime ? new Date(slot.endTime) : new Date(new Date(slot.startTime).getTime() + DEFAULT_SLOT_HOURS * HOUR_MS);

/** Prisma filter for slots whose attendance is still outstanding (end time aside). */
export const ATTENDANCE_OUTSTANDING_WHERE = {
  attendanceMarkedAt: null,
  signups: { some: { attended: false } },
};

/** The same question of a loaded slot (with its signups). */
export function isAttendanceOutstanding(slot, now = new Date()) {
  if (slot.attendanceMarkedAt) return false;
  if (slotEndTime(slot).getTime() > now.getTime()) return false;
  return (slot.signups || []).some((s) => !s.attended);
}

/** Carries the HTTP status the route should answer with. */
export class SlotAttendanceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SlotAttendanceError';
    this.status = status;
  }
}

/**
 * Record (or undo) "attendance for this slot is finished".
 *
 * `hostId`, when given, restricts the change to that host's own slots; the
 * member route passes it, the admin route does not. Allowed once the slot has
 * started, since a host may well tick people off while the meeting is on.
 *
 * The check and the write happen under the row lock a reschedule takes
 * (meetingSlotUpdates.js). Without it, a slot moved into the future between
 * this read and this write would be marked done for a meeting that has not
 * happened, and its host would never be reminded.
 */
export async function setSlotAttendanceComplete({ slotId, complete, actorId, hostId = null, now = new Date() }) {
  if (typeof complete !== 'boolean') {
    throw new SlotAttendanceError(400, 'complete must be true or false');
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM meeting_slots WHERE id = ${slotId} FOR UPDATE`;

    const slot = await tx.meetingSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new SlotAttendanceError(404, 'Meeting slot not found');
    if (hostId && slot.memberId !== hostId) {
      throw new SlotAttendanceError(403, 'Not authorized to update this slot');
    }
    if (complete && new Date(slot.startTime).getTime() > now.getTime()) {
      throw new SlotAttendanceError(409, 'Attendance can be finished once the slot has started');
    }

    return tx.meetingSlot.update({
      where: { id: slotId },
      data: complete
        ? { attendanceMarkedAt: now, attendanceMarkedById: actorId }
        : { attendanceMarkedAt: null, attendanceMarkedById: null },
      select: { id: true, attendanceMarkedAt: true, attendanceMarkedById: true },
    });
  });
}
