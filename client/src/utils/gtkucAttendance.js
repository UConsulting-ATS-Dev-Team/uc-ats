// Whether a GTKUC slot's attendance has been taken - the client's copy of
// server/src/services/meetingAttendance.js, which the reminders use.
//
// `attended` defaults to false, so a no-show and an unmarked signup look the
// same. A slot is done when a host pressed "Attendance done" or everyone is
// checked; one that has ended with anyone unchecked and no such press is
// outstanding.

// A slot with no end time is an hour long, as everywhere else on these pages.
const slotEnd = (slot) =>
  slot.endTime ? new Date(slot.endTime) : new Date(new Date(slot.startTime).getTime() + 60 * 60 * 1000);

export const attendanceState = (slot, now = new Date()) => {
  const signups = slot.signups || [];
  if (signups.length === 0 || now < slotEnd(slot)) return 'none';
  if (slot.attendanceMarkedAt || signups.every((s) => s.attended)) return 'done';
  return 'outstanding';
};

export const isOutstanding = (slot, now) => attendanceState(slot, now) === 'outstanding';

// Past slots whose host can finish attendance: started, with signups.
export const canFinishAttendance = (slot, now = new Date()) =>
  (slot.signups || []).length > 0 && now >= new Date(slot.startTime);

/** The reminders a host has actually been sent for this slot, newest first. */
export const attendanceReminders = (slot) =>
  (slot.communications || [])
    .filter((c) => c.type === 'ATTENDANCE_REMINDER' && c.status === 'SENT')
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

/** "2d ago", "3h ago", "just now". */
export const timeAgo = (value, now = new Date()) => {
  const mins = Math.floor((now.getTime() - new Date(value).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
