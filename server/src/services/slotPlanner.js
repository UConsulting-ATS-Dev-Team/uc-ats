// Turning "how the day runs" into sessions.
//
// Recruitment describes an interview day in two different ways, and both are
// right for the round they belong to:
//
//   Coffee chats   two named sittings - a morning and an afternoon - each
//                  holding a lot of people. The name is the thing candidates
//                  recognise, so it is what they pick.
//   First round    a schedule. Doors open at 8, groups of four every hour
//                  until 5, with a break for lunch. Nobody names those; the
//                  time is the name.
//
// Asking for one shape and making people fake the other is what produced group
// names like "3-4pm G12" in the old data - a time encoded into a string because
// there was nowhere to put it.
//
// Pure on purpose: the times are the part that goes subtly wrong, and they
// should be provable without a database.

import { randomUUID } from 'node:crypto';
import { localInputToUTC } from '../utils/timezoneUtils.js';

/**
 * Combine a calendar day and a wall-clock time into an instant.
 *
 * The time is Los Angeles time, which is what the admin typed. Not the
 * server's own zone: Render runs in UTC, so setHours() there turned "9:00"
 * into 9:00 UTC, which every page then showed as 2 AM.
 */
export function combine(day, time) {
  if (!day || !time) return null;
  const [hour, minute] = String(time).split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return localInputToUTC(`${day}T${pad(hour)}:${pad(minute)}`);
}

const overlaps = (startA, endA, startB, endB) => startA < endB && endA > startB;

/**
 * Named sittings. The coffee chat shape.
 *
 * Each block is its own session with its own capacity; there is no cadence,
 * because a block is one long sitting rather than a series of short ones.
 */
export function planBlocks(day, blocks = []) {
  const rows = [];
  for (const [index, block] of blocks.entries()) {
    const startTime = combine(day, block.start);
    const endTime = combine(day, block.end);
    if (!startTime || !endTime) {
      throw new Error(`Session ${index + 1} needs a start and an end time.`);
    }
    if (endTime <= startTime) {
      throw new Error(`"${block.label || `Session ${index + 1}`}" ends before it starts.`);
    }
    rows.push({
      label: block.label?.trim() || null,
      startTime,
      endTime,
      candidateCapacity: block.capacity == null || block.capacity === '' ? null : Number(block.capacity),
      interviewerCapacity: block.interviewers == null || block.interviewers === '' ? null : Number(block.interviewers),
      // Named sittings are the coffee chat shape, and a coffee chat runs in
      // rotation groups. Defaulting to pairs means bookings are labelled from
      // the first one, rather than arriving unlabelled until somebody notices
      // the setting.
      groupSize: block.groupSize == null || block.groupSize === '' ? 2 : Number(block.groupSize),
    });
  }
  return rows;
}

/**
 * A day's schedule. The first round shape.
 *
 * Back-to-back sessions of a fixed length between two times, skipping anything
 * that would run into a break. Sessions are unnamed - the time range is what
 * identifies them, and inventing "Session 7" would be noise.
 *
 * Bounded at 60, which is more sittings than a day can hold; a spec that asks
 * for more is a typo in the times rather than an intention.
 */
export function planCadence(day, cadence = {}) {
  const start = combine(day, cadence.start);
  const end = combine(day, cadence.end);
  const minutes = Number(cadence.minutes);
  const capacity = cadence.capacity == null || cadence.capacity === '' ? null : Number(cadence.capacity);
  const interviewers =
    cadence.interviewers == null || cadence.interviewers === '' ? null : Number(cadence.interviewers);

  if (!start || !end) throw new Error('The day needs a start and an end time.');
  if (end <= start) throw new Error('The day ends before it starts.');
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Each session needs a length in minutes.');

  // How many run side by side at each time.
  const parallel = Math.max(1, Math.min(12, Number(cadence.parallel ?? 1) || 1));
  const roomNames = (cadence.rooms ?? []).map((name) => String(name).trim()).filter(Boolean);

  const breaks = (cadence.breaks ?? [])
    .map((b) => ({ start: combine(day, b.start), end: combine(day, b.end) }))
    .filter((b) => b.start && b.end && b.end > b.start);

  const rows = [];
  // Bounded on sittings rather than rows, so asking for four parallel rooms
  // does not quietly cut the day short.
  const MAX_SITTINGS = 60;
  let sittings = 0;
  let cursor = start;
  while (cursor < end && sittings < MAX_SITTINGS) {
    const next = new Date(cursor.getTime() + minutes * 60000);
    if (next > end) break;

    const clash = breaks.find((b) => overlaps(cursor, next, b.start, b.end));
    if (clash) {
      // Resume at the end of the break rather than stepping forward by one
      // session, so a 30 minute lunch does not shift every later session by an
      // arbitrary amount.
      cursor = clash.end;
      continue;
    }

    // More than one interview can run at the same hour - different rooms, or
    // simply several panels going at once. Each is its own session, because
    // each has its own four candidates and its own interviewers; sharing one
    // session between two rooms would put eight people in a room built for four.
    for (let room = 0; room < parallel; room += 1) {
      rows.push({
        label: parallel > 1 ? `${roomNames[room] ?? `Room ${room + 1}`}` : null,
        startTime: cursor,
        endTime: next,
        candidateCapacity: capacity,
        interviewerCapacity: interviewers,
      });
    }
    sittings += 1;
    cursor = next;
  }

  if (rows.length === 0) throw new Error('That schedule produces no sessions.');
  return rows;
}

/**
 * Whichever shape was given. `spec` carries `day` plus `blocks` or `cadence`.
 * Returning [] is legitimate: an interview may be created before anyone has
 * decided how the day runs.
 */
export function planSessions(spec = {}) {
  const { day, blocks, cadence } = spec;
  if (Array.isArray(blocks) && blocks.length > 0) return planBlocks(day, blocks);
  if (cadence && (cadence.start || cadence.end)) return planCadence(day, cadence);
  return [];
}

/**
 * Sessions an admin built one by one, usually off the availability grid.
 *
 * The third shape, and the one the other two cannot express: once members have
 * said when they are free, each session ends up with its own time, room, seat
 * count and the people running it. Times arrive as instants rather than
 * day-plus-wall-clock, because the client already resolved them against the
 * grid and re-deriving them here would be a second chance to get the zone
 * wrong.
 *
 * Bounded at 100. A day of first-round panels in several rooms is a few dozen;
 * a request for more is a client stuck in a loop, not a schedule.
 */
export const MAX_CUSTOM_SESSIONS = 100;

const blankToNull = (value) => (value === '' || value === undefined ? null : value);

const trimmedOrNull = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
};

// A count that is either unset or a whole number at least `min`. Numeric
// strings are accepted because form inputs hand them over that way; "2.5" and
// "four" are not quietly rounded or dropped, since either would build a session
// that differs from what the admin typed without telling them.
const countOrNull = (value, min, row, what) => {
  const raw = blankToNull(value);
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min) {
    const floor = min === 0 ? 'zero or more' : `at least ${min}`;
    throw new Error(`Session ${row}: ${what} must be a whole number, ${floor}.`);
  }
  return n;
};

const instant = (value) => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function planCustomSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('Add at least one session.');
  }
  if (sessions.length > MAX_CUSTOM_SESSIONS) {
    throw new Error(`At most ${MAX_CUSTOM_SESSIONS} sessions can be created at once.`);
  }

  return sessions.map((session, index) => {
    const row = index + 1;
    if (!session || typeof session !== 'object') throw new Error(`Session ${row} is empty.`);

    const startTime = instant(session.startTime);
    const endTime = instant(session.endTime);
    if (!startTime || !endTime) throw new Error(`Session ${row}: a valid start and end time are required`);
    if (endTime <= startTime) throw new Error(`Session ${row}: the end time must be after the start time`);

    // Deduped because the unique thing about an assignment is the person: the
    // same id twice would put one member on a session twice and email them twice.
    const interviewerIds = [
      ...new Set((Array.isArray(session.interviewerIds) ? session.interviewerIds : []).filter(
        (id) => typeof id === 'string' && id.trim() !== ''
      )),
    ];

    return {
      slot: {
        label: trimmedOrNull(session.label),
        startTime,
        endTime,
        // Null inherits the interview's location, which is what most sessions want.
        location: trimmedOrNull(session.location),
        candidateCapacity: countOrNull(session.candidateCapacity, 0, row, 'seats'),
        // A group of zero is not "no grouping"; null is. Zero would make the
        // labeller divide every booking into nothing.
        groupSize: countOrNull(session.groupSize, 1, row, 'group size'),
        interviewerCapacity: countOrNull(session.interviewerCapacity, 0, row, 'interviewers wanted'),
      },
      interviewerIds,
    };
  });
}

/**
 * The rows to write for planned sessions: each slot with its id and interview,
 * and one INTERVIEWER assignment per person on it.
 *
 * Ids are made here rather than by the database so the slots and their
 * assignments can go in as two createMany calls in one batch transaction.
 * Creating slots one at a time to learn their ids means an interactive
 * transaction with a round trip per session, which at a hundred sessions from
 * Render to Supabase is the P2028 timeout notifyInterviewersBulk's comment
 * describes. `makeId` is a parameter so tests can predict the ids.
 */
export function assignIds(customSessions, interviewId, makeId = randomUUID) {
  const slots = [];
  const assignments = [];
  for (const { slot, interviewerIds } of customSessions) {
    const row = { ...slot, id: makeId(), interviewId };
    slots.push(row);
    for (const userId of interviewerIds) {
      assignments.push({ slotId: row.id, interviewId, userId, role: 'INTERVIEWER' });
    }
  }
  return { slots, assignments };
}

/**
 * The interview's range grown to cover `slots`.
 *
 * The range is what the member availability form turns into hour ticks and
 * what the coverage grid counts across (see the with-sessions route), so a
 * session outside it would be invisible on the grid it was built from. It
 * never shrinks: a range set wider than today's sessions is still the window
 * members were asked about. `changed` says whether there is anything to write.
 */
export function widenRange({ startDate, endDate }, slots) {
  if (!slots?.length) return { startDate, endDate, changed: false };
  const earliest = Math.min(...slots.map((s) => s.startTime.getTime()));
  const latest = Math.max(...slots.map((s) => s.endTime.getTime()));
  const nextStart = earliest < startDate.getTime() ? new Date(earliest) : startDate;
  const nextEnd = latest > endDate.getTime() ? new Date(latest) : endDate;
  return { startDate: nextStart, endDate: nextEnd, changed: nextStart !== startDate || nextEnd !== endDate };
}

/** What the form should offer for a round, before anyone changes it. */
export function defaultSpecFor(interviewType) {
  if (interviewType === 'COFFEE_CHAT') {
    return {
      mode: 'blocks',
      blocks: [
        { label: 'Morning Session', start: '09:00', end: '11:00', capacity: 20, interviewers: 4 },
        { label: 'Afternoon Session', start: '14:00', end: '16:00', capacity: 20, interviewers: 4 },
      ],
    };
  }
  // First round and final round start as a time frame and nothing else.
  //
  // The sequence recruitment actually runs is: say which hours the day covers,
  // ask members when they can be there, and only then cut the day into groups -
  // because how many groups run at once is decided by how many interviewers
  // turn out to be free. Generating thirteen unnamed hourly sessions at
  // creation puts that decision first, before the information that settles it,
  // and leaves an admin filling in seats and interviewers for sessions that may
  // not survive contact with the availability grid. The schedule mode below is
  // still there for anyone who already knows their shape.
  if (interviewType === 'ROUND_ONE' || interviewType === 'FINAL_ROUND') {
    return { mode: 'range', range: { start: '08:00', end: '17:00' } };
  }
  return {
    mode: 'cadence',
    cadence: {
      start: '08:00',
      end: '17:00',
      minutes: 60,
      capacity: interviewType === 'ROUND_ONE' ? 4 : 1,
      interviewers: 2,
      parallel: 1,
      breaks: [{ start: '12:00', end: '13:00' }],
    },
  };
}
