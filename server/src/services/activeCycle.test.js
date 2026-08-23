import { describe, it, expect } from 'vitest';
import { activateCycleExclusively, isActiveCycleConflict, SINGLE_ACTIVE_CYCLE_INDEX } from './activeCycle.js';

// Postgres stand-in with the two properties this invariant depends on:
//   * a statement never sees another transaction's uncommitted writes, so two
//     concurrent activations both "deactivate everything" against the same
//     committed state and neither clears the other's row;
//   * the partial unique index the migration creates is checked on commit, so the
//     second transaction fails instead of producing a second active cycle.
// Interleaving is explicit (both transactions run their statements before either
// commits), which is what makes the regression deterministic.
const makeStore = (rows) => {
  const committed = new Map(rows.map((row) => [row.id, { ...row }]));

  const begin = () => {
    const staged = new Map();
    const view = (id) => staged.get(id) ?? committed.get(id);

    return {
      recruitingCycle: {
        updateMany: async ({ where, data }) => {
          let count = 0;
          for (const id of committed.keys()) {
            if (where.id?.not === id) continue;
            if (where.isActive === true && !committed.get(id).isActive) continue;
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

        if ([...committed.values()].filter((row) => row.isActive).length > 1) {
          committed.clear();
          for (const [id, row] of snapshot) committed.set(id, row);
          throw Object.assign(new Error(`Unique constraint failed on the fields: (\`${SINGLE_ACTIVE_CYCLE_INDEX}\`)`), {
            code: 'P2002',
            meta: { target: [SINGLE_ACTIVE_CYCLE_INDEX] }
          });
        }
      }
    };
  };

  return { begin, activeIds: () => [...committed.values()].filter((row) => row.isActive).map((row) => row.id) };
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
});

describe('isActiveCycleConflict', () => {
  it('only claims the single-active index, not other unique violations', () => {
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
