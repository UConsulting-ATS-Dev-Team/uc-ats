// Durable state of the sign-up links for timeline-generated events.
//
// Generated events that expect forms are created as PENDING_FORM (no Forms
// write scope, so nothing is auto-created). Readiness rule: an event is
// CONNECTED once candidates have somewhere to sign up and something records
// who turned up. Two things satisfy that, and either one is enough:
//
//   - both Google Forms (RSVP and attendance), the original arrangement; or
//   - a Luma event link, which covers both on its own - Luma takes the
//     registration and the door scan, and the hourly sync routine relays them.
//
// Clearing the last of them drops the event back to PENDING_FORM, so the
// durable state always matches the links.
//
// Events with a null formStatus are manual/legacy events and stay null.

const hasUrl = (value) => typeof value === 'string' && value.trim().length > 0;

export const isFormReady = ({ rsvpForm, attendanceForm, lumaUrl }) =>
  hasUrl(lumaUrl) || (hasUrl(rsvpForm) && hasUrl(attendanceForm));

// Returns the formStatus to persist, or undefined when it must not change.
export const resolveFormStatus = ({ currentStatus, rsvpForm, attendanceForm, lumaUrl }) => {
  if (!currentStatus) return undefined;
  const next = isFormReady({ rsvpForm, attendanceForm, lumaUrl }) ? 'CONNECTED' : 'PENDING_FORM';
  return next === currentStatus ? undefined : next;
};
