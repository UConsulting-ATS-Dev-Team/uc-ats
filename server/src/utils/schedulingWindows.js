// How late a candidate may change something they booked themselves.
//
// One number, one place. This used to live as a const in routes/candidate.js with
// a second hardcoded copy in the GTKUC page, which is the kind of duplication that
// agrees right up until someone changes one of them. Interview slot signup is the
// second caller, so it moves here rather than becoming a third copy.
//
// Admin overrides deliberately ignore all of this: recruitment rescheduling
// someone the morning of is the normal fix for a problem, not an edge case.

/** Hours before start time after which a candidate can no longer self-modify. */
export const MODIFY_CUTOFF_HOURS = 12;

/** Hours from now until `startTime`. Negative once it is in the past. */
export const hoursUntil = (startTime) =>
  (new Date(startTime).getTime() - Date.now()) / (1000 * 60 * 60);

/**
 * Whether a candidate may still cancel or rebook this booking.
 *
 * Computed server-side and sent to the client as a flag, so the UI never has to
 * know the rule - it just renders what it is told. Re-check this inside the
 * transaction that acts on it: a request can sit in the queue long enough to
 * cross the boundary between the check and the write.
 */
export const canModify = (startTime, cutoffHours = MODIFY_CUTOFF_HOURS) =>
  hoursUntil(startTime) >= cutoffHours;

/** The message a candidate sees when they are inside the window. */
export const cutoffMessage = (noun = 'booking', cutoffHours = MODIFY_CUTOFF_HOURS) =>
  `Your ${noun} is locked in - changes close ${cutoffHours} hours before the start time. ` +
  'Email recruitment if something has come up.';
