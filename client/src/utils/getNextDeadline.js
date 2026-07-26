import { parseISO, isValid } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';

const TIMEZONE = 'America/Los_Angeles';

/**
 * Parse a machine-orderable deadline string and return a Date if it is unambiguous.
 * Only ISO-8601-ish strings (YYYY-MM-DD, with optional time/timezone) are accepted.
 * Free-text values like "Oct 4th, Morning" are intentionally rejected.
 */
function parseMachineDeadline(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const value = raw.trim();

  // Matches:
  //   2026-10-04
  //   2026-10-04T10:00
  //   2026-10-04 10:00:00
  //   2026-10-04T10:00:00-07:00
  //   2026-10-04T10:00:00Z
  const machineDeadlinePattern = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!machineDeadlinePattern.test(value)) {
    return null;
  }

  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = value.includes(' ') ? value.replace(' ', 'T') : value;

  // Date-only and no-offset values are interpreted as Los Angeles time so that
  // an admin entering "2026-10-05" means October 5th in the organization's zone.
  // Explicit offsets/Z are parsed as absolute timestamps.
  let parsed;
  if (hasExplicitOffset) {
    parsed = parseISO(normalized);
  } else {
    parsed = fromZonedTime(normalized, TIMEZONE);
  }

  if (!isValid(parsed)) {
    return null;
  }

  const hasTime = /[T\s]\d{2}:\d{2}/.test(value);
  return { date: parsed, hasTime, raw: value };
}

/**
 * Format a deadline in America/Los_Angeles time.
 * Includes time and timezone abbreviation when the original string specified a time.
 */
export function formatDeadline(date, hasTime) {
  if (!date || !isValid(date)) {
    return '';
  }

  const options = {
    timeZone: TIMEZONE,
    dateStyle: 'long',
  };

  if (hasTime) {
    options.timeStyle = 'short';
  }

  return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * Given a candidate's applications, return the next future, parseable deadline
 * from each application-linked RecruitingCycle.
 * Returns null when no unambiguous future deadline exists.
 */
export function getNextDeadline(applications, now = new Date()) {
  if (!Array.isArray(applications)) {
    return null;
  }

  const deadlineFields = [
    { key: 'resumeDeadline', label: 'Resume' },
    { key: 'coverLetterDeadline', label: 'Cover Letter' },
    { key: 'videoDeadline', label: 'Video' },
  ];

  const candidates = [];

  for (const application of applications) {
    const cycle = application?.cycle;
    if (!cycle) {
      continue;
    }

    for (const { key, label } of deadlineFields) {
      const parsed = parseMachineDeadline(cycle[key]);
      if (parsed && parsed.date.getTime() > now.getTime()) {
        candidates.push({
          ...parsed,
          label,
          cycleName: cycle.name,
          cycleId: cycle.id,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  return candidates[0];
}
