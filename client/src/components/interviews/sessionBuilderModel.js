import { formatTimeRange, fromPacificInput } from '../../utils/scheduleFormat';

/**
 * The arithmetic behind the session builder, kept out of the component so it
 * can be tested without rendering a dialog.
 *
 * A draft row holds what the form shows: a Pacific day ("YYYY-MM-DD"), Pacific
 * start and end ("HH:mm"), and the numbers as typed. Nothing becomes an instant
 * until the payload is built, and then only through fromPacificInput, so a
 * laptop set to another zone cannot shift a session by the hours between them.
 */

export const SESSION_LENGTHS = [20, 30, 45, 60, 90, 120];
export const MAX_ROOMS = 8;
/** The most sessions the server creates in one request. */
export const MAX_SESSIONS = 100;

export const FREE = 'Free at this time';
export const BUSY = 'Said they are busy then';
export const SILENT = 'Never sent availability';
const GROUP_ORDER = [FREE, BUSY, SILENT];

const isCoffeeChat = (type) => type === 'COFFEE_CHAT';

/**
 * What a new session of each type looks like. Coffee chats are long sittings
 * that a crowd rotates through in small groups; first round is a short panel
 * of a few candidates. The numbers are the ones the old setup form and the
 * edit dialog already used, so nothing an admin is used to changes.
 */
export const typeDefaults = (interviewType) =>
  isCoffeeChat(interviewType)
    ? { minutes: 120, candidateCapacity: 40, groupSize: 2, interviewerCapacity: 4 }
    : { minutes: 60, candidateCapacity: 4, groupSize: '', interviewerCapacity: 2 };

export const toMinutes = (time) => {
  const match = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Minutes past midnight as "HH:mm", held inside the day rather than wrapping past midnight. */
export const fromMinutes = (minutes) => {
  const clamped = Math.max(0, Math.min(minutes, 23 * 60 + 59));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
};

const MIDNIGHT = 24 * 60;

/**
 * Whether an end of "00:00" means midnight at the close of the day, so a
 * 23:00-00:00 hour can be drafted. Only after a start later than 00:00:
 * 00:00-00:00 is a session of no length, not one of a whole day. Validation
 * and the instants both read this, so a row that passes the check is one the
 * server will take.
 */
export const endsAtMidnight = (start, end) => end === '00:00' && (toMinutes(start) ?? 0) > 0;

/** An end time in minutes past the start's midnight (see endsAtMidnight). Any other end at or before the start is refused. */
export const endMinutes = (start, end) => (endsAtMidnight(start, end) ? MIDNIGHT : toMinutes(end));

/** An end in minutes as "HH:mm", with midnight written "00:00" (see endMinutes). */
const endFromMinutes = (minutes) => (minutes >= MIDNIGHT ? '00:00' : fromMinutes(minutes));

/** "YYYY-MM-DD" plus whole days, by calendar date rather than by clock. */
const addDays = (day, days) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
};

let keySeed = 0;
const nextKey = () => {
  keySeed += 1;
  return `draft-${keySeed}`;
};

/** A complete draft row: type defaults, then the context, then whatever was passed in. */
export const makeRow = (partial = {}, { interviewType, location = '', day = '' } = {}) => {
  const defaults = typeDefaults(interviewType);
  const start = partial.start ?? '09:00';
  return {
    label: '',
    day,
    start,
    end: endFromMinutes((toMinutes(start) ?? 9 * 60) + defaults.minutes),
    location,
    candidateCapacity: defaults.candidateCapacity,
    groupSize: defaults.groupSize,
    interviewerCapacity: defaults.interviewerCapacity,
    interviewerIds: [],
    pristine: false,
    ...partial,
    key: nextKey(),
  };
};

const lengthOf = (row, fallback) => {
  const length = (endMinutes(row.start, row.end) ?? 0) - (toMinutes(row.start) ?? 0);
  return length > 0 ? length : fallback;
};

/**
 * The row "Add session" appends: starting where the last one ends, the same
 * length, in the same place with the same seats, and nobody on it yet - the
 * people free at 10:00 are rarely the people free at 11:00.
 */
export const nextRow = (rows, context = {}) => {
  const defaults = typeDefaults(context.interviewType);
  const last = rows[rows.length - 1];
  if (!last) return makeRow({ start: '09:00', day: context.day ?? '' }, context);
  // After a session that runs to midnight, the next one starts the next day.
  const pastMidnight = endsAtMidnight(last.start, last.end) && last.day;
  const start = pastMidnight ? 0 : (toMinutes(last.end) ?? 9 * 60);
  return makeRow(
    {
      day: pastMidnight ? addDays(last.day, 1) : last.day,
      start: fromMinutes(start),
      end: endFromMinutes(start + lengthOf(last, defaults.minutes)),
      location: last.location,
      candidateCapacity: last.candidateCapacity,
      groupSize: last.groupSize,
      interviewerCapacity: last.interviewerCapacity,
    },
    context
  );
};

/**
 * A copy at the same time, which is how a parallel room starts. The people are
 * left off: the copy needs different ones, and keeping them would only open it
 * with everyone double-booked.
 */
export const duplicateRow = (row) => makeRow({ ...row, interviewerIds: [], pristine: false });

/** How many start times and rooms a fill covers, before any rows are made. */
export const fillShape = ({ start, end, minutes, rooms = 1 }) => {
  const from = toMinutes(start);
  const to = endMinutes(start, end);
  const length = Number(minutes);
  const roomCount = Math.max(1, Math.min(MAX_ROOMS, Number(rooms) || 1));
  const times = from == null || to == null || !(length > 0) || to <= from ? 0 : Math.floor((to - from) / length);
  return { times, rooms: roomCount, total: times * roomCount };
};

/**
 * Back-to-back sessions across a range, `rooms` of them at each time. A range
 * that does not divide evenly stops at the last session that fits; a session
 * running past "last end" would be one nobody asked for.
 */
export const fillRange = ({ day, start, end, minutes, rooms = 1, seats }, context = {}) => {
  const from = toMinutes(start);
  const to = endMinutes(start, end);
  const length = Number(minutes);
  const roomCount = Math.max(1, Math.min(MAX_ROOMS, Number(rooms) || 1));
  if (from == null || to == null || !(length > 0)) return [];

  const rows = [];
  for (let at = from; at + length <= to; at += length) {
    for (let room = 0; room < roomCount; room += 1) {
      rows.push(
        makeRow(
          {
            day,
            start: fromMinutes(at),
            end: endFromMinutes(at + length),
            ...(seats !== undefined && seats !== '' ? { candidateCapacity: seats } : {}),
          },
          context
        )
      );
    }
  }
  return rows;
};

/**
 * Adds rows to the draft. The single untouched row the dialog opens with is a
 * placeholder, not a decision, so it gives way to the first real batch rather
 * than sitting at 9:00 in front of it.
 */
export const appendRows = (rows, added) => {
  const kept = rows.length === 1 && rows[0].pristine ? [] : rows;
  return [...kept, ...added];
};

/** The row's start and end as instants, or null for either half that is not filled in. */
export const rowInstants = (row) => {
  const endDay = row.day && endsAtMidnight(row.start, row.end) ? addDays(row.day, 1) : row.day;
  return {
    start: row.day && row.start ? fromPacificInput(`${row.day}T${row.start}`) : null,
    end: row.day && row.end ? fromPacificInput(`${endDay}T${row.end}`) : null,
  };
};

/**
 * One person's windows with any that overlap or touch joined into one, the
 * rule mergeWindows in server/src/services/interviewerAvailability.js uses for
 * the coverage grid. Somebody who said 9-10 and 10-11 is free 9-11.
 */
export const mergeWindows = (windows) => {
  const sorted = (windows ?? [])
    .map((w) => ({ startTime: new Date(w.startTime), endTime: new Date(w.endTime) }))
    .filter((w) => w.endTime > w.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  const merged = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startTime <= last.endTime) {
      last.endTime = new Date(Math.max(last.endTime, window.endTime));
    } else {
      merged.push(window);
    }
  }
  return merged;
};

/**
 * Whether someone said they are free for the whole of a session, once their
 * windows are merged. Containment, not overlap, as on the server: somebody free
 * until 10:30 is not free for a 10-11 panel, and offering them first would put
 * a half-present interviewer on it.
 */
export const isFreeAt = (windows, start, end) => {
  if (!start || !end) return false;
  return mergeWindows(windows).some((w) => w.startTime <= start && w.endTime >= end);
};

/** Which heading someone sits under in a row's picker. Availability ranks the list; it never removes anyone. */
export const pickerGroup = (user, windows, start, end) => {
  if (isFreeAt(windows, start, end)) return FREE;
  return user.responded || (windows ?? []).length > 0 ? BUSY : SILENT;
};

/** Staff ordered for a row's picker: free first, then busy, then silent; by name within each. */
export const pickerOptions = (staff, windowsByUser, start, end) =>
  (staff ?? [])
    .map((user) => ({ user, group: pickerGroup(user, windowsByUser.get(user.id), start, end) }))
    .sort(
      (a, b) =>
        GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
        (a.user.fullName ?? '').localeCompare(b.user.fullName ?? '')
    );

const overlaps = (a, b) => a.start && a.end && b.start && b.end && a.start < b.end && a.end > b.start;

/**
 * Everyone picked for two things at once, per row: `{ [rowKey]: { [userId]: [what else] } }`.
 * Checked against the other draft rows and against sessions the person is
 * already on. A warning, not a refusal - an admin may know somebody is leaving
 * one room to cover the end of another.
 */
export const findClashes = (rows, existingSessions = []) => {
  const timed = rows.map((row, index) => ({ row, index, ...rowInstants(row) }));
  const existing = existingSessions.map((s) => ({
    session: s,
    start: new Date(s.startTime),
    end: new Date(s.endTime),
  }));
  const clashes = {};
  const note = (rowKey, userId, what) => {
    clashes[rowKey] ??= {};
    (clashes[rowKey][userId] ??= []).push(what);
  };

  for (const a of timed) {
    for (const userId of a.row.interviewerIds) {
      for (const b of timed) {
        if (b === a || !b.row.interviewerIds.includes(userId) || !overlaps(a, b)) continue;
        note(a.row.key, userId, `new session ${b.index + 1}`);
      }
      for (const e of existing) {
        if (!overlaps(a, e) || !(e.session.assigned ?? []).some((u) => u.id === userId)) continue;
        note(a.row.key, userId, e.session.label || formatTimeRange(e.session.startTime, e.session.endTime));
      }
    }
  }
  return clashes;
};

const placeKey = (location, fallback) => ((location ?? '').trim() || (fallback ?? '').trim()).toLowerCase();

/**
 * Rows that run at the same time in the same place as another row, or as a
 * session that already exists. A blank location is the interview's own, on
 * either side. Parallel rooms are the point of the builder, and a fill with
 * three rooms starts every one of them in the default location until somebody
 * types "YRL 1", "YRL 2". Saying so beats inventing room names nobody can find.
 */
export const sharedRooms = (rows, existingSessions = [], defaultLocation = '') => {
  const timed = rows.map((row) => ({ row, place: placeKey(row.location, defaultLocation), ...rowInstants(row) }));
  const existing = existingSessions.map((s) => ({
    place: placeKey(s.location, defaultLocation),
    start: new Date(s.startTime),
    end: new Date(s.endTime),
  }));
  const shared = new Set();
  for (const a of timed) {
    if (!a.place) continue;
    const clash = (b) => b !== a && a.place === b.place && overlaps(a, b);
    if (timed.some(clash) || existing.some(clash)) shared.add(a.row.key);
  }
  return shared;
};

const isCount = (value, min = 0) =>
  value === '' || value == null || (Number.isInteger(Number(value)) && Number(value) >= min);

/** What is wrong with a row, field by field. An empty object means it can be sent. */
export const validateRow = (row) => {
  const errors = {};
  if (!row.day) errors.day = 'Pick a day';
  if (!row.start) errors.start = 'Pick a start';
  if (!row.end) errors.end = 'Pick an end';
  if (row.start && row.end && endMinutes(row.start, row.end) <= toMinutes(row.start)) errors.end = 'Must end after it starts';
  if (!isCount(row.candidateCapacity)) errors.candidateCapacity = 'Whole number';
  if (!isCount(row.interviewerCapacity)) errors.interviewerCapacity = 'Whole number';
  if (!isCount(row.groupSize, 1)) errors.groupSize = 'Whole number';
  return errors;
};

export const validateRows = (rows) => {
  const errors = {};
  for (const row of rows) {
    const rowErrors = validateRow(row);
    if (Object.keys(rowErrors).length > 0) errors[row.key] = rowErrors;
  }
  return errors;
};

const countOrNull = (value) => (value === '' || value == null ? null : Number(value));

const samePlace = (a, b) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * The request body for POST /slots/generate. Assumes validateRows passed.
 *
 * A row still showing the interview's own location sends null, so the session
 * inherits it and follows the interview when its room changes later. Only a
 * location somebody actually typed is stored on the session.
 */
export const buildPayload = (rows, { interviewType, location: defaultLocation = '' } = {}) => ({
  sessions: rows.map((row) => {
    const { start, end } = rowInstants(row);
    const location = row.location?.trim() || null;
    return {
      label: row.label?.trim() || null,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      location: location && samePlace(location, defaultLocation) ? null : location,
      candidateCapacity: countOrNull(row.candidateCapacity),
      // Group size is a coffee chat idea; a first round row never sends one.
      groupSize: isCoffeeChat(interviewType) ? countOrNull(row.groupSize) : null,
      interviewerCapacity: countOrNull(row.interviewerCapacity),
      interviewerIds: row.interviewerIds,
    };
  }),
});

export const summarize = (rows) => ({
  sessions: rows.length,
  seats: rows.reduce((n, row) => n + (Number(row.candidateCapacity) || 0), 0),
  placements: rows.reduce((n, row) => n + row.interviewerIds.length, 0),
});
