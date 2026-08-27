import { describe, it, expect } from 'vitest';
import {
  activateCycleExclusively,
  audienceForRole,
  CYCLE_AUDIENCE,
  isActiveCycleConflict,
  resolveCycle,
  resolveCycleForRequest,
  SINGLE_ACTIVE_CYCLE_INDEX,
  SINGLE_ADMIN_ACTIVE_CYCLE_INDEX
} from './activeCycle.js';

// Postgres stand-in with the properties this invariant depends on:
//   * a statement never sees another transaction's uncommitted writes, so two
//     concurrent activations both "deactivate everything" against the same
//     committed state and neither clears the other's row;
//   * the partial unique indexes the migrations create are checked on commit, so the
//     second transaction fails instead of producing a second active cycle.
// Interleaving is explicit (both transactions run their statements before either
// commits), which is what makes the regression deterministic.
const FLAG_INDEX = {
  isActive: SINGLE_ACTIVE_CYCLE_INDEX,
  isAdminActive: SINGLE_ADMIN_ACTIVE_CYCLE_INDEX
};

// The real `where` is `{ id: { not }, OR: [{ isActive: true }, ...] }`. Interpreting OR
// here rather than special-casing one flag is what keeps this fake honest: a guard written
// against `where.isActive` alone silently stops matching and the fake starts writing to
// every row while the assertions still pass.
const matches = (row, where) => {
  if (where.id?.not === row.id) return false;
  if (Array.isArray(where.OR)) {
    return where.OR.some((clause) =>
      Object.entries(clause).every(([field, value]) => row[field] === value)
    );
  }
  return Object.entries(where)
    .filter(([field]) => field !== 'id')
    .every(([field, value]) => row[field] === value);
};

const makeStore = (rows) => {
  const committed = new Map(
    rows.map((row) => [row.id, { isActive: false, isAdminActive: false, ...row }])
  );

  const begin = () => {
    const staged = new Map();
    const view = (id) => staged.get(id) ?? committed.get(id);

    return {
      recruitingCycle: {
        findFirst: async ({ where }) => {
          for (const id of committed.keys()) {
            const row = view(id);
            if (matches(row, where)) return { ...row };
          }
          return null;
        },
        updateMany: async ({ where, data }) => {
          let count = 0;
          for (const id of committed.keys()) {
            if (!matches(view(id), where)) continue;
            staged.set(id, { ...view(id), ...data });
            count += 1;
          }
          return { count };
        },
        update: async ({ where, data }) => {
          const next = { ...view(where.id), ...data };
          staged.set(where.id, next);
          return next;
        }
      },
      commit: () => {
        const snapshot = new Map([...committed].map(([id, row]) => [id, { ...row }]));
        for (const [id, row] of staged) committed.set(id, row);

        for (const [flag, index] of Object.entries(FLAG_INDEX)) {
          if ([...committed.values()].filter((row) => row[flag]).length > 1) {
            committed.clear();
            for (const [id, row] of snapshot) committed.set(id, row);
            throw Object.assign(
              new Error(`Unique constraint failed on the fields: (\`${index}\`)`),
              { code: 'P2002', meta: { target: [index] } }
            );
          }
        }
      }
    };
  };

  const idsWith = (flag) =>
    [...committed.values()].filter((row) => row[flag]).map((row) => row.id);

  return {
    begin,
    activeIds: () => idsWith('isActive'),
    adminActiveIds: () => idsWith('isAdminActive'),
    // A read-only client, for driving resolveCycle against committed state.
    client: {
      recruitingCycle: {
        findFirst: async ({ where }) => {
          for (const row of committed.values()) if (matches(row, where)) return { ...row };
          return null;
        }
      }
    }
  };
};

describe('activateCycleExclusively', () => {
  it('moves the active flag without ever leaving two cycles active', async () => {
    const store = makeStore([{ id: 'a', isActive: true }, { id: 'b', isActive: false }]);

    const tx = store.begin();
    const activated = await activateCycleExclusively(tx, 'b');
    tx.commit();

    expect(activated.isActive).toBe(true);
    expect(store.activeIds()).toEqual(['b']);
  });

  it('activates for both audiences by default', async () => {
    const store = makeStore([{ id: 'a', isActive: true }, { id: 'b' }]);

    const tx = store.begin();
    await activateCycleExclusively(tx, 'b');
    tx.commit();

    expect(store.activeIds()).toEqual(['b']);
    expect(store.adminActiveIds()).toEqual(['b']);
  });

  it('fails the loser of two concurrent activations instead of activating both', async () => {
    const store = makeStore([
      { id: 'current', isActive: true },
      { id: 'b', isActive: false },
      { id: 'c', isActive: false }
    ]);

    const first = store.begin();
    const second = store.begin();

    // Interleaved: both transactions activate before either commits.
    await activateCycleExclusively(first, 'b');
    await activateCycleExclusively(second, 'c');

    first.commit();
    let conflict = null;
    try {
      second.commit();
    } catch (error) {
      conflict = error;
    }

    expect(conflict).not.toBeNull();
    expect(isActiveCycleConflict(conflict)).toBe(true);
    expect(store.activeIds()).toEqual(['b']);
  });

  // The regression guard for the whole feature. If this breaks, "activate for members and
  // candidates only" silently drags admins along, because an unpinned admin audience falls
  // back to isActive.
  it('pins admins to the outgoing cycle when candidates are activated alone', async () => {
    const store = makeStore([
      { id: 'winter', isActive: true },
      { id: 'fall', isActive: false }
    ]);

    const tx = store.begin();
    await activateCycleExclusively(tx, 'fall', [CYCLE_AUDIENCE.CANDIDATE]);
    tx.commit();

    expect(store.activeIds()).toEqual(['fall']);
    expect(store.adminActiveIds()).toEqual(['winter']);
    // And admins genuinely resolve to the outgoing cycle, not just carry a flag.
    await expect(resolveCycle(store.client, CYCLE_AUDIENCE.ADMIN)).resolves.toMatchObject({
      id: 'winter'
    });
  });

  it('does not repoint an admin cycle that was already chosen explicitly', async () => {
    const store = makeStore([
      { id: 'winter', isActive: true, isAdminActive: false },
      { id: 'fall2025', isAdminActive: true },
      { id: 'fall', isActive: false }
    ]);

    const tx = store.begin();
    await activateCycleExclusively(tx, 'fall', [CYCLE_AUDIENCE.CANDIDATE]);
    tx.commit();

    expect(store.activeIds()).toEqual(['fall']);
    expect(store.adminActiveIds()).toEqual(['fall2025']);
  });

  it('leaves the candidate pointer untouched when activating for admins alone', async () => {
    const store = makeStore([
      { id: 'fall', isActive: true },
      { id: 'winter', isActive: false }
    ]);

    const tx = store.begin();
    await activateCycleExclusively(tx, 'winter', [CYCLE_AUDIENCE.ADMIN]);
    tx.commit();

    expect(store.activeIds()).toEqual(['fall']);
    expect(store.adminActiveIds()).toEqual(['winter']);
  });

  it('rejects an empty or unknown audience rather than writing nothing', async () => {
    const store = makeStore([{ id: 'a', isActive: true }]);

    await expect(activateCycleExclusively(store.begin(), 'a', [])).rejects.toThrow(/invalid audiences/);
    await expect(activateCycleExclusively(store.begin(), 'a', ['EVERYONE'])).rejects.toThrow(
      /invalid audiences/
    );
  });
});

describe('resolveCycle', () => {
  it('prefers the pinned admin cycle for the admin audience', async () => {
    const store = makeStore([
      { id: 'fall', isActive: true },
      { id: 'winter', isAdminActive: true }
    ]);

    await expect(resolveCycle(store.client, CYCLE_AUDIENCE.ADMIN)).resolves.toMatchObject({ id: 'winter' });
    await expect(resolveCycle(store.client, CYCLE_AUDIENCE.CANDIDATE)).resolves.toMatchObject({ id: 'fall' });
  });

  it('falls back to the candidate cycle when no admin cycle is pinned', async () => {
    const store = makeStore([{ id: 'winter', isActive: true }]);

    await expect(resolveCycle(store.client, CYCLE_AUDIENCE.ADMIN)).resolves.toMatchObject({ id: 'winter' });
  });

  it('returns null rather than throwing when nothing is active', async () => {
    const store = makeStore([{ id: 'winter' }]);

    await expect(resolveCycle(store.client, CYCLE_AUDIENCE.ADMIN)).resolves.toBeNull();
    await expect(resolveCycle(store.client, CYCLE_AUDIENCE.CANDIDATE)).resolves.toBeNull();
  });

  it('defaults to the candidate audience', async () => {
    const store = makeStore([
      { id: 'fall', isActive: true },
      { id: 'winter', isAdminActive: true }
    ]);

    await expect(resolveCycle(store.client)).resolves.toMatchObject({ id: 'fall' });
  });
});

describe('audienceForRole', () => {
  it('sends only ADMIN to the admin pointer', () => {
    expect(audienceForRole('ADMIN')).toBe(CYCLE_AUDIENCE.ADMIN);
    expect(audienceForRole('MEMBER')).toBe(CYCLE_AUDIENCE.CANDIDATE);
    expect(audienceForRole('USER')).toBe(CYCLE_AUDIENCE.CANDIDATE);
    expect(audienceForRole(undefined)).toBe(CYCLE_AUDIENCE.CANDIDATE);
  });
});

describe('resolveCycleForRequest', () => {
  const store = () =>
    makeStore([
      { id: 'fall', isActive: true },
      { id: 'winter', isAdminActive: true }
    ]);

  it('keys on the role, not on which router the request reached', async () => {
    const s = store();
    await expect(resolveCycleForRequest(s.client, { user: { role: 'ADMIN' } })).resolves.toMatchObject({ id: 'winter' });
    await expect(resolveCycleForRequest(s.client, { user: { role: 'MEMBER' } })).resolves.toMatchObject({ id: 'fall' });
    await expect(resolveCycleForRequest(s.client, { user: { role: 'USER' } })).resolves.toMatchObject({ id: 'fall' });
    // Unauthenticated public routes are candidate-facing.
    await expect(resolveCycleForRequest(s.client, {})).resolves.toMatchObject({ id: 'fall' });
  });

  it('resolves once per request even when a handler asks repeatedly', async () => {
    const s = store();
    let calls = 0;
    const counting = {
      recruitingCycle: {
        findFirst: async (args) => {
          calls += 1;
          return s.client.recruitingCycle.findFirst(args);
        }
      }
    };
    const req = { user: { role: 'MEMBER' } };

    await Promise.all([
      resolveCycleForRequest(counting, req),
      resolveCycleForRequest(counting, req),
      resolveCycleForRequest(counting, req)
    ]);

    expect(calls).toBe(1);
  });
});

describe('isActiveCycleConflict', () => {
  it('claims both single-active indexes', () => {
    for (const index of [SINGLE_ACTIVE_CYCLE_INDEX, SINGLE_ADMIN_ACTIVE_CYCLE_INDEX]) {
      expect(
        isActiveCycleConflict(
          Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            meta: { target: [index] }
          })
        )
      ).toBe(true);
    }
  });

  it('only claims the single-active indexes, not other unique violations', () => {
    expect(
      isActiveCycleConflict(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['recruiting_cycles_name_key'] }
        })
      )
    ).toBe(false);
    expect(isActiveCycleConflict(new Error('boom'))).toBe(false);
    expect(isActiveCycleConflict(undefined)).toBe(false);
  });
});
