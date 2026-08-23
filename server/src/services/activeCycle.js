// "At most one active recruiting cycle" is a database invariant, enforced by the
// partial unique index `recruiting_cycles_single_active` on (isActive) WHERE
// isActive. Application-level "deactivate everything, then activate this one"
// cannot hold on its own: two concurrent requests each read a snapshot without
// the other's row, so both would end up active.
//
// Every write that activates a cycle must go through this helper so the ordering
// is the same everywhere (deactivate others first, activate last — the reverse
// order trips the index within a single request), and must run inside a
// transaction so a losing request leaves nothing behind.

export const SINGLE_ACTIVE_CYCLE_INDEX = 'recruiting_cycles_single_active';

export async function activateCycleExclusively(tx, cycleId) {
  await tx.recruitingCycle.updateMany({
    where: { id: { not: cycleId }, isActive: true },
    data: { isActive: false }
  });
  return tx.recruitingCycle.update({
    where: { id: cycleId },
    data: { isActive: true }
  });
}

// A concurrent activation that would have produced a second active cycle fails
// on the index rather than silently winning; callers surface that as a conflict.
export const isActiveCycleConflict = (error) => {
  if (error?.code !== 'P2002') return false;
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return `${targets} ${error.message ?? ''}`.includes(SINGLE_ACTIVE_CYCLE_INDEX);
};

export class ActiveCycleConflictError extends Error {
  constructor() {
    super('Another cycle was activated at the same time. Refresh and try again.');
    this.name = 'ActiveCycleConflictError';
  }
}
