// Who can interview when, and what that means for how the day is built.
//
// The order matters and is the reason this exists. Recruitment cannot decide
// whether first round runs two panels at 10:00 or four until it knows how many
// interviewers can be there at 10:00 - so availability is collected first, from
// people, and the schedule is designed against it afterwards.
//
// The arithmetic is pure and lives here: a window overlapping a time, how many
// windows cover it, how many panels that supports. All of it is provable
// without a database, which matters because an off-by-one in coverage puts a
// candidate in a room with nobody in it.

/** Do two ranges share any time at all? Touching ends do not count. */
export const overlaps = (aStart, aEnd, bStart, bEnd) =>
  new Date(aStart) < new Date(bEnd) && new Date(aEnd) > new Date(bStart);

/**
 * Whether somebody's stated availability covers a proposed session.
 *
 * Containment, not overlap. Being free from 9 to 10 does not mean you can run
 * a session from 9:30 to 10:30 - you would have to leave halfway through, and
 * a half-covered session is an unstaffed one.
 */
export const covers = (window, startTime, endTime) =>
  new Date(window.startTime) <= new Date(startTime) && new Date(window.endTime) >= new Date(endTime);

/**
 * Merge one person's overlapping or touching windows.
 *
 * Somebody who says 9-11 and then 11-1 is free 9-1, and counting them twice at
 * 11:00 would claim coverage that does not exist.
 */
export function mergeWindows(windows) {
  const sorted = [...(windows ?? [])]
    .map((w) => ({ ...w, startTime: new Date(w.startTime), endTime: new Date(w.endTime) }))
    .filter((w) => w.endTime > w.startTime)
    .sort((a, b) => a.startTime - b.startTime);

  const merged = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startTime <= last.endTime) {
      last.endTime = new Date(Math.max(last.endTime, window.endTime));
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * Who could staff a session at this time.
 *
 * `availability` is [{ userId, startTime, endTime }]. One entry per person, so
 * somebody with three windows counts once.
 */
export function whoCanCover(availability, startTime, endTime) {
  const byUser = new Map();
  for (const window of availability ?? []) {
    byUser.set(window.userId, [...(byUser.get(window.userId) ?? []), window]);
  }

  const able = [];
  for (const [userId, windows] of byUser) {
    if (mergeWindows(windows).some((w) => covers(w, startTime, endTime))) able.push(userId);
  }
  return able;
}

/**
 * How the day could run, given who said they are free.
 *
 * Walks the interview's own window at the given cadence and, for each sitting,
 * reports how many interviewers could cover it and therefore how many panels
 * could run at once. That last number is the answer recruitment is actually
 * after: it is what decides whether 10:00 needs one room or four.
 *
 * Reported rather than applied. A quiet hour might mean moving people rather
 * than shrinking the schedule, and that is a judgement call.
 */
export function coverageByTime(availability, { start, end, minutes, interviewersPerSession = 2 }) {
  const rows = [];
  const from = new Date(start);
  const to = new Date(end);
  const step = Number(minutes) * 60000;
  if (!(step > 0) || !(to > from)) return rows;

  const MAX = 60;
  for (let cursor = from; cursor < to && rows.length < MAX; cursor = new Date(cursor.getTime() + step)) {
    const next = new Date(cursor.getTime() + step);
    if (next > to) break;
    const able = whoCanCover(availability, cursor, next);
    rows.push({
      startTime: cursor,
      endTime: next,
      availableInterviewers: able.length,
      userIds: able,
      // Integer division on purpose: three people cannot run two panels of two.
      possibleSessions: interviewersPerSession > 0 ? Math.floor(able.length / interviewersPerSession) : 0,
    });
  }
  return rows;
}

/**
 * Whether a placement contradicts what somebody said.
 *
 * Not enforced - an admin may know something the form does not, and a member
 * who can suddenly make 4pm should not have to re-submit a form before being
 * put there. Reported, so the disagreement is visible rather than silent.
 */
export function conflictsWithAvailability(availability, userId, startTime, endTime) {
  const mine = (availability ?? []).filter((w) => w.userId === userId);
  if (mine.length === 0) return 'NO_AVAILABILITY_GIVEN';
  return mergeWindows(mine).some((w) => covers(w, startTime, endTime)) ? null : 'OUTSIDE_AVAILABILITY';
}
