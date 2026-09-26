// A Prisma-shaped in-memory database for the Luma service tests.
//
// It enforces the same unique keys as the migration, so "re-ingesting changes
// nothing" and "a person counts once" are checked against constraints rather
// than against mocked return values. Shared by ingestGuests.test.js and
// linkGuest.test.js, which have to agree about what the database does.

export const EVENT_ID = 'event-1';

function matches(row, where) {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) return condition.in.includes(value);
      if ('not' in condition) {
        return condition.not === null ? value != null : value !== condition.not;
      }
      if ('equals' in condition) {
        return condition.mode === 'insensitive'
          ? String(value ?? '').toLowerCase() === String(condition.equals).toLowerCase()
          : value === condition.equals;
      }
    }
    return value === condition;
  });
}

// { eventId_candidateId: { eventId, candidateId } } -> { eventId, candidateId }
function flattenUnique(where) {
  const [key, value] = Object.entries(where)[0];
  return key.includes('_') && value && typeof value === 'object' ? value : where;
}

function uniqueError(target) {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });
}

// Prisma hands back plain objects read out of the database, not handles on it.
// Returning the stored row itself would let a caller holding a "before" copy
// watch it change under them when something else updates it - which is exactly
// the state reconcileRows compares against, so a fixture that shared references
// would quietly agree with a bug that loses the old value.
const detach = (row) => (row ? { ...row } : row);

export function model(uniques, defaults = {}) {
  const rows = [];
  let next = 1;
  const check = (candidate, ignoreId) => {
    for (const fields of uniques) {
      const clash = rows.find((row) => row.id !== ignoreId
        && fields.every((f) => candidate[f] != null && row[f] === candidate[f]));
      if (clash) throw uniqueError(fields.join(','));
    }
  };
  const api = {
    rows,
    async findUnique({ where }) {
      return detach(rows.find((row) => matches(row, flattenUnique(where)))) ?? null;
    },
    async findFirst({ where }) {
      return detach(rows.find((row) => matches(row, where))) ?? null;
    },
    async create({ data }) {
      const row = { id: `${defaults.prefix ?? 'row'}-${next++}`, ...defaults.values, ...data };
      check(row);
      rows.push(row);
      return detach(row);
    },
    async update({ where, data }) {
      const stored = rows.find((row) => matches(row, flattenUnique(where)));
      if (!stored) throw new Error('Record to update not found');
      check({ ...stored, ...data }, stored.id);
      Object.assign(stored, data);
      return detach(stored);
    },
    async upsert({ where, create, update }) {
      const row = await api.findUnique({ where });
      return row ? api.update({ where, data: update }) : api.create({ data: create });
    },
    async delete({ where }) {
      const stored = rows.find((row) => matches(row, flattenUnique(where)));
      if (!stored) throw new Error('Record to delete does not exist');
      rows.splice(rows.indexOf(stored), 1);
      return detach(stored);
    },
    async deleteMany({ where }) {
      const doomed = rows.filter((row) => matches(row, where));
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return { count: doomed.length };
    }
  };
  return api;
}

export function fakeDb() {
  const db = {
    events: model([['id']]),
    user: model([['email'], ['studentId']], { prefix: 'user' }),
    candidate: model([['email'], ['studentId']], { prefix: 'cand' }),
    lumaGuest: model([['lumaGuestId']], { prefix: 'lg' }),
    eventRsvp: model([['responseId'], ['lumaGuestId'], ['eventId', 'candidateId']], { values: { source: 'GOOGLE_FORM' } }),
    eventAttendance: model([['responseId'], ['lumaGuestId'], ['eventId', 'candidateId']], { values: { source: 'GOOGLE_FORM' } }),
    memberEventRsvp: model([['responseId'], ['lumaGuestId'], ['eventId', 'memberId']], { values: { source: 'GOOGLE_FORM' } }),
    memberEventAttendance: model([['responseId'], ['eventId', 'memberId']], { values: { source: 'MANUAL' } }),
    // Every raw statement the services run, as SQL text with its parameters, so
    // a test can assert the per-guest advisory lock was taken. Nothing here
    // emulates locking: these tests are single-threaded, and what is worth
    // checking is that the lock is asked for before the first read.
    raw: [],
    $executeRaw: async (strings, ...values) => {
      db.raw.push({ sql: strings.join('?'), values });
      return 0;
    },
    $transaction: async (fn) => fn(db)
  };
  db.events.rows.push({ id: EVENT_ID });
  return db;
}

// A deep snapshot of every table, to prove a second run wrote nothing.
export const snapshot = (db) => JSON.stringify(
  Object.fromEntries(Object.entries(db).filter(([, m]) => m.rows).map(([k, m]) => [k, m.rows]))
);

