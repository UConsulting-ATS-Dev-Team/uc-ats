import prisma from '../prismaClient.js';

// Subjects mirror the templates in emailNotifications.js so the log reflects
// what the recipient actually received. Keep in sync if those templates change.
export const MEETING_COMM_SUBJECTS = {
  CONFIRMATION: 'Time Slot Confirmation - Get to Know UC',
  HOST_NOTIFICATION: (candidateName) => `New GTKUC Signup - ${candidateName} signed up for your slot`,
  CANCELLATION: 'Meeting Cancelled - Get to Know UC',
  CANCELLATION_TO_HOST: 'Get to Know UC - Meeting Cancelled',
  REMINDER: 'Reminder - Get to Know UC',
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
