// The day-before email to a Get to Know UC host: who signed up, and a nudge to
// contact them with exactly where to meet and how to find the host.
//
// Run from a cron in index.js. Each run picks up every slot that starts within
// the next REMINDER_LEAD_HOURS, has at least one signup, and has not had a
// reminder since it came into that window. "Since it came into the window" is
// what keys the dedupe, rather than "ever": a slot moved to a later day gets a
// fresh reminder when the new time comes round, since the earlier one was sent
// before the new window opened.
//
// A slot booked or created inside the window is reminded on the next run, so
// a host who opens a slot for tomorrow morning still hears who is coming.
//
// Every attempt is logged as a MeetingCommunication (type REMINDER, no signup),
// which is what the admin slot log shows. A failed send is retried on later
// runs, up to MAX_ATTEMPTS, so one bad address does not mail every 15 minutes
// for a day.

import prisma from '../prismaClient.js';
import config from '../config.js';
import { sendMeetingHostReminder } from './emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from './meetingComms.js';
import { resolveSignupContacts } from './meetingSignupContacts.js';

export const REMINDER_LEAD_HOURS = 24;
const MAX_ATTEMPTS = 3;
const HOUR_MS = 60 * 60 * 1000;

/** The slots a run should remind, with host, signups and prior reminders. */
export async function findSlotsDueForHostReminder(now = new Date()) {
  const horizon = new Date(now.getTime() + REMINDER_LEAD_HOURS * HOUR_MS);
  const slots = await prisma.meetingSlot.findMany({
    where: {
      startTime: { gt: now, lte: horizon },
      signups: { some: {} },
    },
    include: {
      member: { select: { id: true, fullName: true, email: true, isActive: true } },
      signups: { orderBy: { createdAt: 'asc' } },
      communications: {
        where: { type: 'REMINDER', signupId: null },
        select: { status: true, sentAt: true, recipient: true },
      },
    },
  });

  return slots.filter((slot) => {
    if (!slot.member?.email || slot.member.isActive === false) return false;
    const windowOpened = slot.startTime.getTime() - REMINDER_LEAD_HOURS * HOUR_MS;
    const thisWindow = slot.communications.filter(
      (c) =>
        c.sentAt.getTime() >= windowOpened &&
        c.recipient.toLowerCase() === slot.member.email.toLowerCase()
    );
    if (thisWindow.some((c) => c.status === 'SENT')) return false;
    return thisWindow.length < MAX_ATTEMPTS;
  });
}

/**
 * Who signed up, with numbers where they can be found. A failed number lookup
 * sends the reminder without numbers rather than failing it: names and emails
 * are already on the slot, and a failure here would use up one of the
 * reminder's attempts without an email ever being tried.
 */
async function attendeesFor(slot) {
  try {
    return await resolveSignupContacts(slot.signups);
  } catch (error) {
    console.error(`[gtkuc host reminders] phone lookup failed for slot ${slot.id}; sending without numbers:`, error);
    return slot.signups.map((s) => ({ signupId: s.id, fullName: s.fullName, email: s.email, phoneNumber: null }));
  }
}

/** Send one slot's reminder. Never throws. */
export async function sendHostReminder(slot) {
  const host = slot.member;
  const hostName = host.fullName || 'UC Consulting Member';

  return sendAndLogMeetingCommunication(
    async () => {
      const attendees = await attendeesFor(slot);
      const result = await sendMeetingHostReminder(
        host.email,
        hostName,
        slot.location,
        slot.startTime,
        slot.endTime,
        attendees,
        `${config.clientUrl}/member/meeting-slots`
      );
      // The sender resolves { success: false } rather than throwing; turn that
      // back into a throw so the log says FAILED, not SENT.
      if (result && result.success === false) throw new Error(result.error || 'email send failed');
      return result;
    },
    {
      slotId: slot.id,
      signupId: null,
      type: 'REMINDER',
      recipient: host.email,
      subject: MEETING_COMM_SUBJECTS.HOST_REMINDER,
    }
  );
}

/** One cron tick. Returns how many reminders went out. */
export async function sendDueHostReminders(now = new Date()) {
  const due = await findSlotsDueForHostReminder(now);
  let sent = 0;
  for (const slot of due) {
    const { ok } = await sendHostReminder(slot);
    if (ok) sent += 1;
  }
  return sent;
}
