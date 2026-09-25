// The after-the-meeting email to a Get to Know UC host: an hour after the slot
// ends, a nudge to mark who showed up, with a button that opens that slot in
// the ATS.
//
// Run from a cron in index.js. Each run picks up every slot that ended at least
// ATTENDANCE_DELAY_HOURS ago, but no more than LOOKBACK_HOURS before that, has
// a signup not yet marked attended, and has not been reminded since it ended.
// The lookback is what stops the first run after a deploy from mailing every
// host about every slot they have ever held.
//
// `attended` defaults to false, so "not marked yet" and "marked as a no-show"
// look the same. A slot where every signup is marked attended is skipped; any
// other slot is reminded once, which a host who already marked the no-shows
// can ignore.
//
// "Since it ended" rather than "ever" keys the dedupe: a slot moved to a later
// time after its reminder gets a fresh one once the new time is over.
//
// Every attempt is logged as a MeetingCommunication (type ATTENDANCE_REMINDER,
// no signup). A failed send is retried on later runs, up to MAX_ATTEMPTS.

import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendMeetingAttendanceReminder } from './emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from './meetingComms.js';

export const ATTENDANCE_DELAY_HOURS = 1;
const LOOKBACK_HOURS = 24;
// A slot with no end time is treated as an hour long, as the slot page does.
const DEFAULT_SLOT_HOURS = 1;
const MAX_ATTEMPTS = 3;
const HOUR_MS = 60 * 60 * 1000;

export const slotEndTime = (slot) =>
  slot.endTime ? new Date(slot.endTime) : new Date(new Date(slot.startTime).getTime() + DEFAULT_SLOT_HOURS * HOUR_MS);

/** Where the email's button lands: the host's slot page, scrolled to this slot. */
export const attendanceUrlFor = (slotId) =>
  `${config.clientUrl}/member/meeting-slots?slot=${encodeURIComponent(slotId)}`;

const REMINDER_LOG = { type: 'ATTENDANCE_REMINDER', signupId: null };

/** Whether a slot's reminder log still calls for a send. */
function stillDue(slot, communications) {
  const ended = slotEndTime(slot).getTime();
  const sinceEnded = communications.filter(
    (c) =>
      c.sentAt.getTime() >= ended &&
      c.recipient.toLowerCase() === slot.member.email.toLowerCase()
  );
  if (sinceEnded.some((c) => c.status === 'SENT')) return false;
  return sinceEnded.length < MAX_ATTEMPTS;
}

/**
 * The slots a run should remind, with host, signups and prior reminders.
 * Pass `slotId` to ask the same question of one slot.
 */
export async function findSlotsDueForAttendanceReminder(now = new Date(), slotId = null) {
  const latestEnd = new Date(now.getTime() - ATTENDANCE_DELAY_HOURS * HOUR_MS);
  const earliestEnd = new Date(latestEnd.getTime() - LOOKBACK_HOURS * HOUR_MS);
  const slots = await prisma.meetingSlot.findMany({
    where: {
      ...(slotId ? { id: slotId } : {}),
      OR: [
        { endTime: { gt: earliestEnd, lte: latestEnd } },
        {
          endTime: null,
          startTime: {
            gt: new Date(earliestEnd.getTime() - DEFAULT_SLOT_HOURS * HOUR_MS),
            lte: new Date(latestEnd.getTime() - DEFAULT_SLOT_HOURS * HOUR_MS),
          },
        },
      ],
      signups: { some: { attended: false } },
    },
    include: {
      member: { select: { id: true, fullName: true, email: true, isActive: true } },
      signups: { orderBy: { createdAt: 'asc' } },
      communications: {
        where: REMINDER_LOG,
        select: { status: true, sentAt: true, recipient: true },
      },
    },
  });

  return slots.filter((slot) => {
    if (!slot.member?.email || slot.member.isActive === false) return false;
    return stillDue(slot, slot.communications);
  });
}

/** Send one slot's reminder. Never throws. */
export async function sendAttendanceReminder(slot) {
  const host = slot.member;
  const hostName = host.fullName || 'UC Consulting Member';

  return sendAndLogMeetingCommunication(
    async () => {
      const result = await sendMeetingAttendanceReminder(
        host.email,
        hostName,
        slot.location,
        slot.startTime,
        slot.endTime,
        slot.signups.map((s) => ({ fullName: s.fullName, email: s.email, attended: s.attended })),
        attendanceUrlFor(slot.id)
      );
      // The sender resolves { success: false } rather than throwing; turn that
      // back into a throw so the log says FAILED, not SENT.
      if (result && result.success === false) throw new Error(result.error || 'email send failed');
      return result;
    },
    {
      slotId: slot.id,
      signupId: null,
      type: 'ATTENDANCE_REMINDER',
      recipient: host.email,
      subject: MEETING_COMM_SUBJECTS.ATTENDANCE_REMINDER,
    }
  );
}

/**
 * Send one slot's reminder under a lock on that slot. Returns { ok }.
 *
 * The in-process flag in index.js only stops a run overlapping itself. During
 * a deploy the old and new instances both run the cron for a moment, and both
 * can pick the same slot before either has logged it. So each send takes a
 * transaction-scoped advisory lock on the slot and asks whether it is due all
 * over again once it holds it: whoever comes second either finds the lock
 * taken or finds the first one's SENT row. Re-asking also catches a slot that
 * was fully marked or moved since the batch was read, and sends the slot as
 * it is now. The lock covers one email, so a long batch never holds a
 * transaction open.
 */
async function sendUnderSlotLock(slot, now) {
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] =
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${`gtkuc-attendance-reminder:${slot.id}`})) AS locked`;
      if (!locked) return { ok: false };

      const [current] = await findSlotsDueForAttendanceReminder(now, slot.id);
      if (!current) return { ok: false };

      return sendAttendanceReminder(current);
    },
    { timeout: 60 * 1000 }
  );
}

/** One cron tick. Returns how many reminders went out. */
export async function sendDueAttendanceReminders(now = new Date()) {
  const due = await findSlotsDueForAttendanceReminder(now);
  let sent = 0;
  for (const slot of due) {
    try {
      const { ok } = await sendUnderSlotLock(slot, now);
      if (ok) sent += 1;
    } catch (error) {
      // A lock or log read failing for one slot must not end the run for the rest.
      console.error(`[gtkuc attendance reminders] slot ${slot.id} failed:`, error);
    }
  }
  return sent;
}
