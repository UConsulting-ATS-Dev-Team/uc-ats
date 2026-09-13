// Who gets a seat, and who gets it next.
//
// Pure functions over plain objects, deliberately knowing nothing about Prisma.
// The interesting bugs in slot allocation are ordering and priority bugs, and
// those should be provable without a database, a transaction, or a mock of
// either - the abandoned issue-63 branch tested its allocation through a faked
// $transaction, which made the isolation level a no-op and proved nothing.
//
// The transactional half lives in interviewSignups.js and calls into here.

/// A cascade is bounded rather than run to exhaustion. Promoting someone
/// releases the fallback seat they were holding, which can free a seat in
/// another slot, which can have its own waitlist. The chain terminates in
/// practice, but a bound means one pathological cycle cannot hold a transaction
/// open indefinitely. A chain longer than this finishes on the next cancellation.
export const MAX_CASCADE = 25;

/**
 * Whether a slot is open to candidates picking it themselves.
 *
 * A null candidateCapacity means "not self-service" - an interviewer-only
 * sitting, or a round still scheduled by hand - which is different from a
 * capacity of zero, which means "self-service, and full".
 */
export function isCandidateBookable(slot, now = new Date()) {
  if (!slot || slot.candidateCapacity == null) return false;
  if (slot.signupOpensAt && new Date(slot.signupOpensAt) > now) return false;
  if (slot.signupClosesAt && new Date(slot.signupClosesAt) < now) return false;
  return true;
}

export const seatsRemaining = (slot, confirmedCount) =>
  slot.candidateCapacity == null ? null : slot.candidateCapacity - confirmedCount;

export const hasRoom = (slot, confirmedCount) =>
  slot.candidateCapacity != null && confirmedCount < slot.candidateCapacity;

/**
 * The slot a candidate is parked in when the one they wanted is full.
 *
 * Earliest start time first, which is arbitrary but predictable - and being
 * predictable is what lets an admin explain the outcome to a candidate who
 * asks. Excludes the slot they actually wanted, and anything not open to
 * self-service.
 *
 * `slots` carries a confirmedCount per slot, counted inside the same
 * transaction as the caller so that the cross-slot race is covered too: without
 * that, two candidates could both be told the same last fallback seat was free.
 */
export function chooseFallbackSlot(slots, preferredSlotId, now = new Date()) {
  const candidates = (slots || [])
    .filter((slot) => slot.id !== preferredSlotId)
    .filter((slot) => isCandidateBookable(slot, now))
    .filter((slot) => hasRoom(slot, slot.confirmedCount ?? 0));

  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    const byStart = new Date(a.startTime) - new Date(b.startTime);
    return byStart !== 0 ? byStart : String(a.id).localeCompare(String(b.id));
  })[0];
}

/**
 * Who takes a freed seat in this slot.
 *
 * NEEDS_PLACEMENT outranks WAITLISTED, and that ordering is a fairness call
 * worth stating plainly: a waitlisted candidate is already holding a confirmed
 * seat in another block, while a NEEDS_PLACEMENT candidate signed up when every
 * block was full and has nothing at all. Giving the seat to the person who has
 * none, before the person upgrading from one they already have, is the only
 * order that does not leave someone unscheduled while a seat sits empty.
 *
 * Within each tier, oldest first - waitlistedAt for the waitlist, signedUpAt for
 * the unplaced, with id as a deterministic tiebreak so two rows written in the
 * same millisecond still order consistently across reads.
 */
export function nextInLine(entries) {
  const rank = { NEEDS_PLACEMENT: 0, WAITLISTED: 1 };
  const eligible = (entries || []).filter((e) => e.status in rank);
  if (eligible.length === 0) return null;

  return eligible.sort((a, b) => {
    const byTier = rank[a.status] - rank[b.status];
    if (byTier !== 0) return byTier;
    const aAt = new Date(a.waitlistedAt ?? a.signedUpAt).getTime();
    const bAt = new Date(b.waitlistedAt ?? b.signedUpAt).getTime();
    if (aAt !== bAt) return aAt - bAt;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

/**
 * The promotions a freed seat sets off, as a list of operations.
 *
 * Modelled over an in-memory snapshot so the cascade - including the
 * release-frees-another-seat chain and the MAX_CASCADE bound - can be tested
 * exhaustively without a database. interviewSignups.js runs the same shape
 * against real rows; this is the specification it is checked against.
 *
 * `snapshot` is a Map of slotId -> { capacity, confirmed: n, queue: [entry] },
 * where each entry has { id, status, applicationId, waitlistedAt, signedUpAt,
 * heldSeatId, heldSeatSlotId }.
 */
export function planPromotions(snapshot, startSlotId, { maxCascade = MAX_CASCADE } = {}) {
  const operations = [];
  const queue = [startSlotId];
  let guard = maxCascade;

  while (queue.length > 0 && guard > 0) {
    const slotId = queue.shift();
    const slot = snapshot.get(slotId);
    if (!slot || slot.capacity == null) continue;

    while (slot.confirmed < slot.capacity && guard > 0) {
      const head = nextInLine(slot.queue);
      if (!head) break;
      guard -= 1;

      // The held seat is given up before the promotion is applied, never after:
      // for the instant in between, the candidate would hold two confirmed seats
      // in one interview, which the partial unique index forbids outright.
      if (head.heldSeatId && head.heldSeatSlotId) {
        operations.push({ type: 'RELEASE', signupId: head.heldSeatId, slotId: head.heldSeatSlotId });
        const source = snapshot.get(head.heldSeatSlotId);
        if (source) {
          source.confirmed -= 1;
          if (!queue.includes(head.heldSeatSlotId)) queue.push(head.heldSeatSlotId);
        }
      }

      operations.push({
        type: 'PROMOTE',
        signupId: head.id,
        slotId,
        applicationId: head.applicationId,
        fromStatus: head.status,
      });

      slot.queue = slot.queue.filter((entry) => entry.id !== head.id);
      slot.confirmed += 1;
    }
  }

  return operations;
}
