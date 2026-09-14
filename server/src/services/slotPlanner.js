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

/** Combine a calendar day and a wall-clock time into an instant. */
export function combine(day, time) {
  if (!day || !time) return null;
  const [hour, minute] = String(time).split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(hour, minute, 0, 0);
  return date;
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
