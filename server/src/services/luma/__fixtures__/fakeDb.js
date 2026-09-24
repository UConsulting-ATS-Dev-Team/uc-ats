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
      return rows.find((row) => matches(row, flattenUnique(where))) ?? null;
    },
    async findFirst({ where }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async create({ data }) {
      const row = { id: `${defaults.prefix ?? 'row'}-${next++}`, ...defaults.values, ...data };
      check(row);
      rows.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = await api.findUnique({ where });
      if (!row) throw new Error('Record to update not found');
      check({ ...row, ...data }, row.id);
      Object.assign(row, data);
      return row;
    },
    async upsert({ where, create, update }) {
      const row = await api.findUnique({ where });
      return row ? api.update({ where, data: update }) : api.create({ data: create });
    },
    async delete({ where }) {
      const row = await api.findUnique({ where });
      if (!row) throw new Error('Record to delete does not exist');
      rows.splice(rows.indexOf(row), 1);
      return row;
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
    $transaction: async (fn) => fn(db)
  };
  db.events.rows.push({ id: EVENT_ID });
  return db;
}

// A deep snapshot of every table, to prove a second run wrote nothing.
export const snapshot = (db) => JSON.stringify(
  Object.fromEntries(Object.entries(db).filter(([, m]) => m.rows).map(([k, m]) => [k, m.rows]))
);

