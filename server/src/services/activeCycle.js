// Which recruiting cycle is "current" is audience-scoped: members, candidates and the
// public pages follow `isActive`, while admins follow `isAdminActive`. They are normally
// the same row and differ only during a handover, where admins finish out the closing
// cycle while the next one opens to candidates.
//
// "At most one active cycle per audience" is a database invariant, enforced by the partial
// unique indexes `recruiting_cycles_single_active` on (isActive) WHERE isActive and
// `recruiting_cycles_single_admin_active` on (isAdminActive) WHERE isAdminActive.
// Application-level "deactivate everything, then activate this one" cannot hold on its own:
// two concurrent requests each read a snapshot without the other's row, so both would end
// up active.
//
// Every write that activates a cycle must go through activateCycleExclusively so the
// ordering is the same everywhere (deactivate others first, activate last — the reverse
// order trips the index within a single request), and must run inside a transaction so a
// losing request leaves nothing behind.
//
// Every *read* must go through resolveCycle/resolveCycleForRequest rather than querying
// either flag directly, so the audience rule lives in exactly one place.

export const CYCLE_AUDIENCE = Object.freeze({
  // Members, candidates, and unauthenticated public pages share one pointer. They are
  // all looking at the cycle that is currently open to applicants.
  CANDIDATE: 'CANDIDATE',
  ADMIN: 'ADMIN'
});

const AUDIENCE_FLAG = Object.freeze({
  [CYCLE_AUDIENCE.CANDIDATE]: 'isActive',
  [CYCLE_AUDIENCE.ADMIN]: 'isAdminActive'
});

export const ALL_AUDIENCES = Object.freeze([CYCLE_AUDIENCE.CANDIDATE, CYCLE_AUDIENCE.ADMIN]);

export const SINGLE_ACTIVE_CYCLE_INDEX = 'recruiting_cycles_single_active';
export const SINGLE_ADMIN_ACTIVE_CYCLE_INDEX = 'recruiting_cycles_single_admin_active';

export const isValidAudience = (value) => Object.hasOwn(AUDIENCE_FLAG, value);

// MEMBER and USER both resolve to the candidate pointer. Keyed on the role rather than on
// which router the request reached, because most /api/member/* routes carry only
// requireAuth and reviewTeams has no router-level guard at all — a candidate's token can
// land on a member route, and must still see the candidate cycle.
export const audienceForRole = (role) =>
  role === 'ADMIN' ? CYCLE_AUDIENCE.ADMIN : CYCLE_AUDIENCE.CANDIDATE;

// `client` is always explicit and never defaults to the module-level prisma: callers inside
// a $transaction must resolve against that transaction, not around it.
export async function resolveCycle(client, audience = CYCLE_AUDIENCE.CANDIDATE) {
  if (audience === CYCLE_AUDIENCE.ADMIN) {
    const pinned = await client.recruitingCycle.findFirst({ where: { isAdminActive: true } });
    // Unpinned means admins have not been split off yet, so they follow the candidate
    // pointer. This fallback is what lets every part of this change deploy as a no-op.
    if (pinned) return pinned;
  }
  return (await client.recruitingCycle.findFirst({ where: { isActive: true } })) || null;
}

export const resolveCandidateCycle = (client) => resolveCycle(client, CYCLE_AUDIENCE.CANDIDATE);
export const resolveAdminCycle = (client) => resolveCycle(client, CYCLE_AUDIENCE.ADMIN);

// Memoised per request (the promise, so concurrent callers share one query) because a
// single handler often needs the cycle several times.
const REQUEST_CYCLE_CACHE = Symbol('resolvedCycleByAudience');

export function resolveCycleForRequest(client, req) {
  const audience = audienceForRole(req?.user?.role);
  if (!req) return resolveCycle(client, audience);

  const cache = (req[REQUEST_CYCLE_CACHE] ??= {});
  cache[audience] ??= resolveCycle(client, audience);
  return cache[audience];
}

export async function activateCycleExclusively(tx, cycleId, audiences = ALL_AUDIENCES) {
  const targets = [...new Set(audiences)];
  if (!targets.length || !targets.every(isValidAudience)) {
    throw new Error(`activateCycleExclusively: invalid audiences ${JSON.stringify(audiences)}`);
  }

  // Splitting the audiences for the first time. While nothing carries isAdminActive,
  // admins are implicitly following isActive (see resolveCycle), so moving isActive below
  // would silently drag them onto the new cycle — the exact opposite of "candidates only".
  // Freeze them onto the cycle they are on now, in this same transaction.
  //
  // Only when nothing is pinned: once an admin cycle exists it is an explicit choice and
  // must never be silently repointed.
  if (targets.includes(CYCLE_AUDIENCE.CANDIDATE) && !targets.includes(CYCLE_AUDIENCE.ADMIN)) {
    const pinned = await tx.recruitingCycle.findFirst({
      where: { isAdminActive: true },
      select: { id: true }
    });
    if (!pinned) {
      const current = await tx.recruitingCycle.findFirst({
        where: { isActive: true },
        select: { id: true }
      });
      if (current && current.id !== cycleId) {
        await tx.recruitingCycle.update({
          where: { id: current.id },
          data: { isAdminActive: true }
        });
      }
    }
  }

  const flags = targets.map((audience) => AUDIENCE_FLAG[audience]);

  await tx.recruitingCycle.updateMany({
    where: { id: { not: cycleId }, OR: flags.map((flag) => ({ [flag]: true })) },
    data: Object.fromEntries(flags.map((flag) => [flag, false]))
  });
  return tx.recruitingCycle.update({
    where: { id: cycleId },
    data: Object.fromEntries(flags.map((flag) => [flag, true]))
  });
}

// A concurrent activation that would have produced a second active cycle fails on the
// index rather than silently winning; callers surface that as a conflict.
export const isActiveCycleConflict = (error) => {
  if (error?.code !== 'P2002') return false;
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target.join(',') : String(target ?? '');
  const haystack = `${targets} ${error.message ?? ''}`;
  return (
    haystack.includes(SINGLE_ACTIVE_CYCLE_INDEX) ||
    haystack.includes(SINGLE_ADMIN_ACTIVE_CYCLE_INDEX)
  );
};

export class ActiveCycleConflictError extends Error {
  constructor() {
    super('Another cycle was activated at the same time. Refresh and try again.');
    this.name = 'ActiveCycleConflictError';
  }
}
