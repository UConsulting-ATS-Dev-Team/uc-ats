import { addDays } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';

export const MEETING_TIMEZONE = 'America/Los_Angeles';

/**
 * Convert a UTC Date (typically a RecruitingCycle startDate/endDate) into the
 * start of that calendar day in the meeting timezone (America/Los_Angeles).
 *
 * Cycle dates are stored as UTC timestamps, but conceptually represent whole
 * days in LA. Using the UTC date part as the LA date keeps the server's
 * eligibility semantics aligned with the raw date values operators see in the
 * admin UI and API.
 */
function toZonedDayStart(date, timeZone) {
  if (!date) return null;
  const datePart = new Date(date).toISOString().slice(0, 10);
  return fromZonedTime(`${datePart}T00:00:00`, timeZone);
}

/**
 * Return the inclusive start and exclusive end boundaries for an active
 * recruiting cycle. The end boundary is the start of the day *after* the cycle
 * end date in the meeting timezone, so slots on the end date are included.
 *
 * Returns null if the cycle has neither startDate nor endDate.
 */
export function getActiveCycleBoundaries(activeCycle, timeZone = MEETING_TIMEZONE) {
  if (!activeCycle || (!activeCycle.startDate && !activeCycle.endDate)) {
    return null;
  }

  const start = activeCycle.startDate ? toZonedDayStart(activeCycle.startDate, timeZone) : null;

  let endExclusive = null;
  if (activeCycle.endDate) {
    const endPart = new Date(activeCycle.endDate).toISOString().slice(0, 10);
    const nextDayUTC = addDays(new Date(`${endPart}T00:00:00`), 1);
    const nextDayPart = nextDayUTC.toISOString().slice(0, 10);
    endExclusive = fromZonedTime(`${nextDayPart}T00:00:00`, timeZone);
  }

  return { start, endExclusive };
}

/**
 * Check whether a slot's start time falls within the active recruiting cycle
 * date boundaries.
 */
export function isSlotStartInActiveCycle(slotStart, activeCycle, timeZone = MEETING_TIMEZONE) {
  if (!activeCycle || !slotStart) return false;

  const boundaries = getActiveCycleBoundaries(activeCycle, timeZone);
  if (!boundaries) return false;

  const { start, endExclusive } = boundaries;
  const startTime = new Date(slotStart);

  if (start && startTime < start) return false;
  if (endExclusive && startTime >= endExclusive) return false;
  return true;
}

/**
 * Check whether a slot's start time is in the future (>= now).
 */
export function isSlotStartFuture(slotStart, now = new Date()) {
  return new Date(slotStart) >= new Date(now);
}

/**
 * Full public eligibility check: the slot must be in the active cycle, in the
 * future, and have available capacity.
 */
export function isSlotPubliclyAvailable(slot, activeCycle, timeZone = MEETING_TIMEZONE, now = new Date()) {
  if (!slot || !activeCycle) return false;

  const taken = Array.isArray(slot.signups) ? slot.signups.length : 0;
  const remaining = Math.max(0, (slot.capacity || 0) - taken);

  return (
    remaining > 0 &&
    isSlotStartInActiveCycle(slot.startTime, activeCycle, timeZone) &&
    isSlotStartFuture(slot.startTime, now)
  );
}
