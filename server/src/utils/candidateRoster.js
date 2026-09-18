// Naming the candidates in a session, for the interviewer who has to walk in and
// recognise them.
//
// Its own module because both halves of the same message want it: the email body
// renders it as a line in the details card, and the .ics writes it into the
// calendar entry's description. services/emailNotifications.js is imported *by*
// services/interviewSlotComms.js, so putting it in either one would mean one of
// them importing the other back.
//
// Names only, by design. Firstname, lastname and the rotation label are identity,
// which is exactly what utils/lockedRecords leaves standing on a sealed row -
// nothing here reaches scores, evaluations or anything a candidate wrote.

/**
 * How many candidates to name before summarising the rest.
 *
 * A coffee chat session can hold forty people, and forty names in a calendar
 * entry is not a roster anybody reads - it is a wall. Naming the first dozen and
 * counting the remainder keeps the entry useful; the app stays the real roster.
 */
export const ROSTER_NAME_LIMIT = 12;

/**
 * One candidate as an interviewer sees them.
 *
 * The rotation label leads, because that is what identifies a pair at a coffee
 * chat table - the interviewer asks which group they are, not for an id. Null for
 * first round, where the session is the group, so the name stands on its own.
 */
function describeCandidate({ groupLabel, application } = {}) {
  const name = [application?.firstName, application?.lastName].filter(Boolean).join(' ').trim();
  if (!name) return null;
  return groupLabel ? `${groupLabel}: ${name}` : name;
}

/**
 * The roster as one line, or null when there is nobody on it.
 *
 * Null rather than an empty string so callers can drop the whole "Candidates:"
 * heading: a session staffed before anybody has booked is the normal order of
 * things, not a roster worth printing as blank.
 */
export function describeRoster(candidates) {
  const named = (candidates ?? []).map(describeCandidate).filter(Boolean);
  if (named.length === 0) return null;
  const shown = named.slice(0, ROSTER_NAME_LIMIT);
  const rest = named.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
}
