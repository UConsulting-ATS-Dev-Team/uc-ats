// Column sorting for the admin Get to Know UC tables. The page already holds
// every slot and signup in memory, so sorting happens here rather than on the
// server.

const STATUS_ORDER = { active: 0, upcoming: 1, past: 2 };

export const slotStatus = (slot, now = new Date()) => {
  const startTime = new Date(slot.startTime);
  const endTime = slot.endTime ? new Date(slot.endTime) : new Date(startTime.getTime() + 60 * 60 * 1000);
  if (now < startTime) return 'upcoming';
  if (now > endTime) return 'past';
  return 'active';
};

const time = (value) => (value ? new Date(value).getTime() : null);
const text = (value) => (value ? String(value).toLowerCase() : null);
const attendedCount = (slot) => (slot.signups || []).filter((s) => s.attended).length;

// Each column maps a row to the value it sorts by. A null sorts last in both
// directions, so rows missing a value never crowd the top of the list.
export const SLOT_SORT_KEYS = {
  host: (slot) => text(slot.member?.fullName),
  location: (slot) => text(slot.location),
  start: (slot) => time(slot.startTime),
  status: (slot, now) => STATUS_ORDER[slotStatus(slot, now)],
  signups: (slot) => (slot.signups || []).length,
  openSpots: (slot) => Math.max((slot.capacity || 0) - (slot.signups || []).length, 0),
  attended: attendedCount
};

export const ATTENDANCE_SORT_KEYS = {
  present: (row) => (row.attended ? 1 : 0),
  candidate: (row) => text(row.fullName),
  email: (row) => text(row.email),
  studentId: (row) => text(row.studentId),
  host: (row) => text(row.slot?.member?.fullName),
  slot: (row) => time(row.slot?.startTime),
  signedUp: (row) => time(row.createdAt)
};

const compareValues = (a, b) => {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, undefined, { numeric: true });
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

// Stable: rows that tie keep their incoming order. Ties fall back to `tiebreak`
// (always ascending) so equal hosts still read in time order.
export const sortRows = (rows, keys, { field, dir }, { tiebreak, now = new Date() } = {}) => {
  const primary = keys[field];
  if (!primary) return rows;
  const secondary = tiebreak && tiebreak !== field ? keys[tiebreak] : null;
  const sign = dir === 'desc' ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, a: primary(row, now), b: secondary ? secondary(row, now) : null }))
    .sort((x, y) => {
      const xMissing = x.a === null || x.a === undefined;
      const yMissing = y.a === null || y.a === undefined;
      if (xMissing !== yMissing) return xMissing ? 1 : -1;
      if (!xMissing) {
        const c = compareValues(x.a, y.a);
        if (c !== 0) return c * sign;
      }
      if (secondary && x.b !== null && y.b !== null) {
        const c = compareValues(x.b, y.b);
        if (c !== 0) return c;
      }
      return x.index - y.index;
    })
    .map(({ row }) => row);
};

// Counts are more useful biggest-first, so these start descending.
const DESC_FIRST = new Set(['signups', 'openSpots', 'attended', 'present']);

// Clicking the active column flips it; clicking a new one starts in its
// natural direction.
export const nextSort = (current, field) =>
  current.field === field
    ? { field, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { field, dir: DESC_FIRST.has(field) ? 'desc' : 'asc' };
