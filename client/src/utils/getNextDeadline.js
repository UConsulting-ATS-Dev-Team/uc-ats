import { isValid } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

const TIMEZONE = 'America/Los_Angeles';

/**
 * A cycle's application deadline, from RecruitingCycle.applicationDeadline.
 *
 * Not endDate: that is when the whole cycle ends (offers released), weeks after
 * applications close. applicationDeadline is always a stored instant, so it is
 * read as one and shown with its time.
 */
function cycleApplicationDeadline(cycle) {
  const raw = cycle?.applicationDeadline;
  if (!raw) return null;
  const date = new Date(raw);
  if (!isValid(date)) return null;
  return { cutoff: date, date, hasTime: true, raw: String(raw) };
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
 * from each application-linked RecruitingCycle (using cycle.applicationDeadline).
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

    const parsed = cycleApplicationDeadline(cycle);
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

/**
 * The application deadline for one cycle.
 *
 * Separate from getNextDeadline, which answers a different question: that one
 * scans the applications a candidate already submitted and returns the soonest
 * of their deadlines. On a dashboard that is the wrong question. "Application
 * deadline" means when applications close, which is a property of the cycle
 * currently open, not of a cycle this person applied to last time.
 *
 * Returns null when there is no open cycle or its date is unusable, so a caller
 * can render nothing rather than a wrong date.
 */
export function getCycleDeadline(cycle, now = new Date()) {
  if (!cycle) return null;

  const parsed = cycleApplicationDeadline(cycle);
  if (!parsed || parsed.cutoff.getTime() <= now.getTime()) return null;

  return {
    ...parsed,
    label: 'Application deadline',
    cycleName: cycle.name,
    cycleId: cycle.id,
  };
}
