import prisma from '../prismaClient.js';
import { sendMeetingSlotCreated } from './emailNotifications.js';
import { hostMeetingInvite } from './meetingInvites.js';

// Subjects mirror the templates in emailNotifications.js so the log reflects
// what the recipient actually received. Keep in sync if those templates change.
export const MEETING_COMM_SUBJECTS = {
  CONFIRMATION: 'Time Slot Confirmation - Get to Know UC',
  SLOT_CREATED: 'Your Get to Know UC slot is open',
  HOST_NOTIFICATION: (candidateName) => `New GTKUC Signup - ${candidateName} signed up for your slot`,
  CANCELLATION: 'Meeting Cancelled - Get to Know UC',
  CANCELLATION_TO_HOST: 'Get to Know UC - Meeting Cancelled',
  RESCHEDULED: 'Meeting Rescheduled - Get to Know UC',
  RESCHEDULED_TO_HOST: 'Get to Know UC - Meeting Rescheduled',
  REMINDER: 'Reminder - Get to Know UC',
  HOST_REMINDER: 'Tomorrow: your Get to Know UC slot',
};

/**
 * Persist a record of a GTKUC communication. Never throws — logging must not
 * break the primary action (signup, cancellation, etc.).
 */
export async function recordMeetingCommunication({
  slotId,
  signupId = null,
  type,
  recipient,
  subject,
  status = 'SENT',
  error = null,
}) {
  try {
    if (!slotId || !type || !recipient) return null;
    return await prisma.meetingCommunication.create({
      data: {
        slotId,
        signupId,
        type,
        recipient,
        subject: subject || '',
        status,
        error: error ? String(error).slice(0, 1000) : null,
      },
    });
  } catch (e) {
    console.error('[recordMeetingCommunication] failed to log communication:', e);
    return null;
  }
}

/**
 * Run an email send function and log the outcome as a MeetingCommunication.
 * Returns { ok } and swallows send errors (logs FAILED) so callers don't have
 * to wrap each send in try/catch themselves.
 */
export async function sendAndLogMeetingCommunication(sendFn, meta) {
  const { slotId, signupId = null, type, recipient, subject } = meta;
  try {
    await sendFn();
    await recordMeetingCommunication({ slotId, signupId, type, recipient, subject, status: 'SENT' });
    return { ok: true };
  } catch (error) {
    console.error(`[sendAndLogMeetingCommunication] ${type} to ${recipient} failed:`, error);
    await recordMeetingCommunication({
      slotId,
      signupId,
      type,
      recipient,
      subject,
      status: 'FAILED',
      error: error?.message || String(error),
    });
    return { ok: false, error };
  }
}

/**
 * Tell a host their new GTKUC slot exists, with the calendar invite that puts it
 * on their calendar. Later signup and cancellation emails update that entry.
 *
 * Sent whoever created the slot - the host, or an admin on their behalf - since
 * either way it is the host whose time is now committed. Logged as a
 * HOST_NOTIFICATION with no signup, which the admin slot log shows as "Host
 * notified". Never throws: the slot exists whether or not this lands.
 *
 * `host` needs email and fullName.
 */
export async function notifyHostSlotCreated(slot, host) {
  if (!slot?.id || !host?.email) return { ok: false };
  const hostName = host.fullName || 'UC Consulting Member';

  return sendAndLogMeetingCommunication(
    async () => {
      const result = await sendMeetingSlotCreated(host.email, hostName, slot.location, slot.startTime, slot.endTime, {
        invite: hostMeetingInvite({ slot, hostEmail: host.email, hostName, attendeeNames: [] }),
      });
      // The sender resolves { success: false } rather than throwing; turn that
      // back into a throw so the log says FAILED, not SENT.
      if (result && result.success === false) throw new Error(result.error || 'email send failed');
      return result;
    },
    {
      slotId: slot.id,
      signupId: null,
      type: 'HOST_NOTIFICATION',
      recipient: host.email,
      subject: MEETING_COMM_SUBJECTS.SLOT_CREATED,
    }
  );
}
