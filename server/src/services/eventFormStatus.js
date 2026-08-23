// Durable state of the Google Forms shim for timeline-generated events.
//
// Generated events that expect forms are created as PENDING_FORM (no Forms
// write scope, so nothing is auto-created). Readiness rule: an event is
// CONNECTED once it has both an RSVP form and an attendance form, because the
// sync pipeline needs both to record RSVPs and attendance. Clearing either link
// drops it back to PENDING_FORM, so the durable state always matches the links.
//
// Events with a null formStatus are manual/legacy events and stay null.

const hasUrl = (value) => typeof value === 'string' && value.trim().length > 0;

export const isFormReady = ({ rsvpForm, attendanceForm }) =>
  hasUrl(rsvpForm) && hasUrl(attendanceForm);

// Returns the formStatus to persist, or undefined when it must not change.
export const resolveFormStatus = ({ currentStatus, rsvpForm, attendanceForm }) => {
  if (!currentStatus) return undefined;
  const next = isFormReady({ rsvpForm, attendanceForm }) ? 'CONNECTED' : 'PENDING_FORM';
  return next === currentStatus ? undefined : next;
};
