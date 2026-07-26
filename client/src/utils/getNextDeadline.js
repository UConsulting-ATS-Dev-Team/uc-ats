import { isValid } from 'date-fns';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const TIMEZONE = 'America/Los_Angeles';

/**
 * Parse a cycle's endDate as an application deadline.
 *
 * Cycle endDate values are calendar dates collected from an <input type="date">,
 * but are stored as DateTime (usually UTC midnight). We therefore treat the
 * date portion as a day in the organization's timezone (America/Los_Angeles).
 * If a non-midnight timestamp is provided, we fall back to parsing it as an
 * absolute instant.
 */
function parseApplicationDeadline(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const value = raw.trim();

  // Date-only values or explicit UTC midnights from Prisma DateTime.
  const calendarDayPattern = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.\d+)?Z?)?$/;
  const match = calendarDayPattern.exec(value);

  let parsed;
  if (match) {
    parsed = fromZonedTime(match[1], TIMEZONE);
  } else {
    parsed = fromZonedTime(value, TIMEZONE);
  }

  if (!isValid(parsed)) {
    return null;
  }

  return { date: parsed, hasTime: false, raw: value };
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
    if (parsed && parsed.date.getTime() > now.getTime()) {
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

  candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  return candidates[0];
}
