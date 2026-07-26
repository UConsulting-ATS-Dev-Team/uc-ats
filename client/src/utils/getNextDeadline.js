import { addDays, isValid, parseISO } from 'date-fns';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const TIMEZONE = 'America/Los_Angeles';

/**
 * Parse a cycle's endDate as an application-deadline cutoff.
 *
 * Cycle endDate values are calendar dates collected from an <input type="date">,
 * but Prisma stores them as DateTime (UTC midnight). We therefore treat a plain
 * date or a 00:00:00 timestamp as an all-day deadline ending at the end of the
 * stated calendar day in the organization's timezone (America/Los_Angeles).
 *
 * If a meaningful time is provided (non-midnight) with an explicit offset/Z,
 * we parse it as an absolute instant. Non-midnight times without an offset are
 * interpreted as Los Angeles local time.
 */
function parseApplicationDeadline(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const value = raw.trim();

  // Matches:
  //   2026-10-05
  //   2026-10-05 10:00:00
  //   2026-10-05T10:00:00
  //   2026-10-05T10:00:00.000Z
  //   2026-10-05T10:00:00-07:00
  const isoPattern = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const match = isoPattern.exec(value);
  if (!match) {
    return null;
  }

  const datePart = match[1];
  const timePart = match[2];
  const offset = match[3];

  // A bare date or a midnight timestamp is an all-day deadline in PT.
  if (!timePart || timePart === '00:00:00') {
    const startOfDay = fromZonedTime(datePart, TIMEZONE);
    if (!isValid(startOfDay)) {
      return null;
    }
    const cutoff = addDays(startOfDay, 1);
    // Display as the very end of the deadline day so formatting stays on the
    // correct calendar date while comparisons use the cutoff instant.
    const displayDate = new Date(cutoff.getTime() - 1);
    return { cutoff, date: displayDate, hasTime: false, raw: value };
  }

  const normalized = value.includes(' ') ? value.replace(' ', 'T') : value;
  let parsed;

  if (offset) {
    // Absolute timestamp (Z or explicit offset).
    parsed = parseISO(normalized);
  } else {
    // No offset: interpret as local to the organization's timezone.
    parsed = fromZonedTime(normalized, TIMEZONE);
  }

  if (!isValid(parsed)) {
    return null;
  }

  return { cutoff: parsed, date: parsed, hasTime: true, raw: value };
}

/**
 * Format a deadline in America/Los_Angeles time with an unambiguous timezone label.
 * Includes the time when the original value has a meaningful time component.
 */
export function formatDeadline(date, hasTime) {
  if (!date || !isValid(date)) {
    return '';
  }

  const formatString = hasTime
    ? "MMMM d, yyyy 'at' h:mm a z"
    : "MMMM d, yyyy z";

  return formatInTimeZone(date, TIMEZONE, formatString);
}

/**
 * Given a candidate's applications, return the next future application deadline
 * from each application-linked RecruitingCycle (using cycle.endDate).
 * Returns null when no unambiguous future deadline exists.
 */
export function getNextDeadline(applications, now = new Date()) {
  if (!Array.isArray(applications)) {
    return null;
  }

  const candidates = [];

  for (const application of applications) {
    const cycle = application?.cycle;
    if (!cycle) {
      continue;
    }

    const parsed = parseApplicationDeadline(cycle.endDate);
    if (parsed && parsed.cutoff.getTime() > now.getTime()) {
      candidates.push({
        ...parsed,
        label: 'Application deadline',
        cycleName: cycle.name,
        cycleId: cycle.id,
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.cutoff.getTime() - b.cutoff.getTime());
  return candidates[0];
}
