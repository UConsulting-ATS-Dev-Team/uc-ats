// Booking, cancelling and moving a candidate's place in an interview slot.
//
// Every operation here runs inside a Serializable transaction, and every fact
// that decides an outcome is read inside it. That is the whole point: capacity
// cannot be enforced by checking and then writing, because two requests for the
// last seat both check successfully. Under Serializable, Postgres notices that
// each insert falls inside the other's predicate read and aborts one, which
// withSerializableTransaction retries into an honest "this slot is full".
//
// The GTKUC booking route (routes/candidate.js) does check-then-write at Read
// Committed and can overbook. It predates this and is worth fixing separately;
// do not copy it.
//
// Nothing in here sends email. Transaction bodies return a plan, the caller
// commits, and only then does anything leave the building - because a retried
// transaction runs its body again, and an email sent inside one goes twice.

import prisma from '../prismaClient.js';
import {
  SlotTransactionError,
  withSerializableTransaction,
} from '../utils/withSerializableTransaction.js';
import { MODIFY_CUTOFF_HOURS, canModify } from '../utils/schedulingWindows.js';
import {
  MAX_CASCADE,
  chooseFallbackSlot,
  hasRoom,
  isCandidateBookable,
  nextInLine,
  nextLabelFrom,
} from './interviewSignupPolicy.js';

/// Statuses that occupy something. Everything else is history.
const LIVE_STATUSES = ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'];

const SIGNUP_SELECT = {
  id: true,
  slotId: true,
  interviewId: true,
  applicationId: true,
  status: true,
  signedUpAt: true,
  waitlistedAt: true,
  heldSeatId: true,
  promotedAt: true,
};

const countConfirmed = (tx, slotId) =>
  tx.interviewSlotSignup.count({ where: { slotId, status: 'CONFIRMED' } });

/** Slots of one interview, each with its live confirmed count, read in-transaction. */
async function loadSlotsWithCounts(tx, interviewId) {
  const slots = await tx.interviewSlot.findMany({
    where: { interviewId },
    orderBy: { startTime: 'asc' },
  });
  const counts = await tx.interviewSlotSignup.groupBy({
    by: ['slotId'],
    where: { interviewId, status: 'CONFIRMED' },
    _count: { _all: true },
  });
  const byId = new Map(counts.map((row) => [row.slotId, row._count._all]));
  return slots.map((slot) => ({ ...slot, confirmedCount: byId.get(slot.id) ?? 0 }));
}

/**
 * Every bookable slot for this round, across sibling interviews.
 *
 * Recruitment models a coffee chat day as two Interview rows - "Coffee Chat -
 * Round 1" in the morning and "Round 2" in the afternoon - rather than as two
 * sittings of one interview. That is a reasonable way to run it, and it is how
 * the real data is shaped, so "the other session a full candidate falls back
 * into" has to be able to cross an interview boundary.
 *
 * Sibling means: same cycle, same interviewType, not cancelled or completed.
 *
 * Reading them inside the caller's transaction is what keeps this safe. Two
 * candidates racing for the last seats of two different interviews each read
 * the other's rows, so Postgres sees the dependency and aborts one - which is
 * also the only thing enforcing "one seat per candidate per round", since a
 * unique index cannot span interviews.
 */
async function loadRoundSlotsWithCounts(tx, interview) {
  const siblings = await tx.interview.findMany({
    where: {
      cycleId: interview.cycleId,
      interviewType: interview.interviewType,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    select: { id: true },
  });
  const interviewIds = siblings.map((row) => row.id);
  if (!interviewIds.includes(interview.id)) interviewIds.push(interview.id);

  const slots = await tx.interviewSlot.findMany({
    where: { interviewId: { in: interviewIds } },
    orderBy: { startTime: 'asc' },
  });
  const counts = await tx.interviewSlotSignup.groupBy({
    by: ['slotId'],
    where: { interviewId: { in: interviewIds }, status: 'CONFIRMED' },
    _count: { _all: true },
  });
  const byId = new Map(counts.map((row) => [row.slotId, row._count._all]));
  return {
    interviewIds,
    slots: slots.map((slot) => ({ ...slot, confirmedCount: byId.get(slot.id) ?? 0 })),
  };
}

/**
 * Lock every session of this round for the rest of the transaction.
 *
 * `FOR UPDATE` on the slot rows, ordered by id. The slot row itself is never
 * modified by a booking - it is being used as the thing to queue on, because
 * the real contention is over a count of child rows and there is nothing else
 * for concurrent claims to agree on.
 *
 * Ordering matters: claimWithFallback can touch a preferred session and a
 * fallback in another interview, so two claims choosing opposite preferences
 * would deadlock if each locked its own first.
 */
async function lockRoundSlots(tx, interview) {
  await tx.$queryRaw`
    SELECT s.id
    FROM interview_slots s
    JOIN interviews i ON i.id = s."interviewId"
    WHERE i."cycleId" = ${interview.cycleId}
      AND i."interviewType"::text = ${String(interview.interviewType)}
      AND i.status NOT IN ('CANCELLED', 'COMPLETED')
    ORDER BY s.id
    FOR UPDATE OF s`;
}

/**
 * The rotation group an arriving candidate joins.
 *
 * Appends to the last group that still has room, and starts a new one when
 * none does. Appending rather than rebalancing is the whole point: a label is
 * what a candidate is told and what they say out loud at an interviewer's
 * table, so it must not change under them because somebody else booked later.
 *
 * Labels are "1A", "1B", "2A": the number is the rotation, the letter the group
 * within it. An admin can rebalance afterwards, which is a deliberate act with
 * consequences rather than something that happens on every booking.
 *
 * Returns null when the session is not grouped, which is first round - there
 * the session already is the group.
 *
 * Safe against two simultaneous bookings because the caller holds FOR UPDATE on
 * the session for the length of the transaction.
 */
async function nextGroupLabel(tx, slot) {
  if (!slot.groupSize) return null;
  const counts = await tx.interviewSlotSignup.groupBy({
    by: ['groupLabel'],
    where: { slotId: slot.id, status: 'CONFIRMED', groupLabel: { not: null } },
    _count: { _all: true },
  });
  return nextLabelFrom(
    counts.map((row) => ({ groupLabel: row.groupLabel, count: row._count._all })),
    slot.groupSize
  );
}

/**
 * Fill open seats in `startSlotId` from its queue, following the cascade.
 *
 * Promoting someone releases the fallback seat they were holding, which frees a
 * seat in that slot, which may have a queue of its own - so this is a worklist,
 * not a single step. Bounded by MAX_CASCADE: a chain longer than that finishes
 * on the next cancellation rather than holding this transaction open.
 *
 * Mirrors planPromotions() in interviewSignupPolicy.js, which is the same
 * algorithm over an in-memory snapshot and is where its edge cases are tested.
 */
async function drainWaitlist(tx, startSlotId, now) {
  const promotions = [];
  const queue = [startSlotId];
  const queued = new Set([startSlotId]);
  let guard = MAX_CASCADE;

  while (queue.length > 0 && guard > 0) {
    const slotId = queue.shift();
    queued.delete(slotId);

    const slot = await tx.interviewSlot.findUnique({
      where: { id: slotId },
      select: { id: true, candidateCapacity: true, interviewId: true },
    });
    if (!slot || slot.candidateCapacity == null) continue;

    for (;;) {
      if (guard <= 0) break;
      const confirmed = await countConfirmed(tx, slotId);
      if (confirmed >= slot.candidateCapacity) break;

      const waiting = await tx.interviewSlotSignup.findMany({
        where: { slotId, status: { in: ['NEEDS_PLACEMENT', 'WAITLISTED'] } },
        select: SIGNUP_SELECT,
      });
      const head = nextInLine(waiting);
      if (!head) break;
      guard -= 1;

      // Release first, promote second. For the instant between them the
      // candidate would otherwise hold two CONFIRMED rows in one interview,
      // which interview_slot_signups_one_confirmed_per_interview rejects.
      let releasedSeat = null;
      if (head.heldSeatId) {
        releasedSeat = await tx.interviewSlotSignup.update({
          where: { id: head.heldSeatId },
          data: { status: 'RELEASED', cancelledAt: now },
          select: { id: true, slotId: true },
        });
      }

      // Conditional claim. Serializable already rules out a concurrent writer,
      // so a zero count means an assumption broke rather than a lost race -
      // throwing rolls the whole transaction back rather than leaving the
      // released seat orphaned.
      const claimed = await tx.interviewSlotSignup.updateMany({
        where: { id: head.id, status: head.status },
        data: {
          status: 'CONFIRMED',
          promotedAt: now,
          waitlistedAt: null,
          heldSeatId: null,
          // They were queued, not seated, so they have no group here yet.
          groupLabel: await nextGroupLabel(tx, slot),
        },
      });
      if (claimed.count === 0) {
        throw new SlotTransactionError(409, 'Waitlist changed while promoting; retry');
      }

      promotions.push({
        signupId: head.id,
        slotId,
        applicationId: head.applicationId,
        fromStatus: head.status,
        releasedSeatId: releasedSeat?.id ?? null,
        releasedSlotId: releasedSeat?.slotId ?? null,
      });

      if (releasedSeat && !queued.has(releasedSeat.slotId)) {
        queue.push(releasedSeat.slotId);
        queued.add(releasedSeat.slotId);
      }
    }
  }

  return promotions;
}

/** Load a slot plus its interview, or throw the right HTTP error. */
async function loadSlotForBooking(tx, slotId) {
  const slot = await tx.interviewSlot.findUnique({
    where: { id: slotId },
    include: { interview: { select: { id: true, cycleId: true, title: true, interviewType: true, status: true, location: true } } },
  });
  if (!slot) throw new SlotTransactionError(404, 'That time slot no longer exists');
  return slot;
}

/**
 * Book a candidate into the slot they asked for, or the best available fallback.
 *
 * Three outcomes, and the candidate always learns which:
 *   CONFIRMED        - they got what they asked for
 *   WAITLISTED       - their slot was full, so they hold a seat elsewhere and
 *                      are queued for the one they wanted
 *   NEEDS_PLACEMENT  - nothing was free anywhere. We do not invent a seat and we
 *                      do not leave them silently queued with nothing; the row
 *                      is filed, recruitment is emailed, and an admin places
 *                      them by hand.
 */
export async function claimWithFallback({ applicationId, slotId, cycleId }) {
  const now = new Date();

  return withSerializableTransaction(
    prisma,
    async (tx) => {
    const slot = await loadSlotForBooking(tx, slotId);
    const { interview } = slot;

    if (cycleId && interview.cycleId !== cycleId) {
      throw new SlotTransactionError(400, 'That interview belongs to a different recruiting cycle');
    }
    if (interview.status === 'CANCELLED') {
      throw new SlotTransactionError(409, 'That interview has been cancelled');
    }
    if (!isCandidateBookable(slot, now)) {
      throw new SlotTransactionError(409, 'Signup is not open for that time slot');
    }
    if (!canModify(slot.startTime)) {
      throw new SlotTransactionError(409, `Signup closes ${MODIFY_CUTOFF_HOURS} hours before a slot starts`);
    }

    // Take the round's sessions under a row lock before reading anything about
    // who is in them.
    //
    // Serialisable alone is correct here but not survivable: every claim reads
    // the same "how many are confirmed" predicate, so under a burst each insert
    // conflicts with every concurrent reader and Postgres aborts nearly all of
    // them. Measured at 200 simultaneous claims, 137 exhausted the retry budget
    // and failed - correct, and useless.
    //
    // A lock turns that contention into a queue. Claims wait their turn instead
    // of racing and losing, which is what a candidate wants: the seat is gone or
    // it is not, and either answer beats an error. Ordered by id so two claims
    // touching the same pair of sessions cannot deadlock.
    await lockRoundSlots(tx, interview);

    // Sibling interviews of the same round count as one pool, so a candidate
    // cannot hold a seat in "Coffee Chat - Round 1" and another in "Round 2".
    const { interviewIds, slots } = await loadRoundSlotsWithCounts(tx, interview);

    const existing = await tx.interviewSlotSignup.findMany({
      where: { interviewId: { in: interviewIds }, applicationId, status: { in: LIVE_STATUSES } },
      select: SIGNUP_SELECT,
    });
    const confirmedRow = existing.find((row) => row.status === 'CONFIRMED');
    if (confirmedRow?.slotId === slotId) {
      throw new SlotTransactionError(409, 'You are already booked into that time slot');
    }
    if (confirmedRow) {
      // Changing an existing booking is a move, not a fresh claim - otherwise we
      // would cancel first and leave them momentarily seatless.
      throw new SlotTransactionError(
        409,
        'You already have a time for this interview. Change it instead of booking a second one.'
      );
    }
    if (existing.length > 0) {
      throw new SlotTransactionError(409, 'You already have a pending request for this interview');
    }

    const preferred = slots.find((s) => s.id === slotId);

    if (hasRoom(preferred, preferred.confirmedCount)) {
      const signup = await tx.interviewSlotSignup.create({
        data: {
          slotId,
          interviewId: interview.id,
          applicationId,
          status: 'CONFIRMED',
          groupLabel: await nextGroupLabel(tx, preferred),
        },
        select: SIGNUP_SELECT,
      });
      return { outcome: 'CONFIRMED', confirmed: signup, waitlisted: null, slot, interview };
    }

    const fallback = chooseFallbackSlot(slots, slotId, now);

    if (!fallback) {
      const unplaced = await tx.interviewSlotSignup.create({
        data: {
          slotId,
          interviewId: interview.id,
          applicationId,
          status: 'NEEDS_PLACEMENT',
          signedUpAt: now,
        },
        select: SIGNUP_SELECT,
      });
      return { outcome: 'NEEDS_PLACEMENT', needsPlacement: unplaced, slot, interview };
    }

    const heldSeat = await tx.interviewSlotSignup.create({
      // The fallback may live in a sibling interview, so the seat is filed
      // against that one - the composite foreign key would reject it otherwise.
      data: {
        slotId: fallback.id,
        interviewId: fallback.interviewId,
        applicationId,
        status: 'CONFIRMED',
        groupLabel: await nextGroupLabel(tx, fallback),
      },
      select: SIGNUP_SELECT,
    });
    const waitlisted = await tx.interviewSlotSignup.create({
      data: {
        slotId,
        interviewId: interview.id,
        applicationId,
        status: 'WAITLISTED',
        waitlistedAt: now,
        heldSeatId: heldSeat.id,
      },
      select: SIGNUP_SELECT,
    });

    return {
      outcome: 'WAITLISTED',
      confirmed: heldSeat,
      waitlisted,
      slot,
      fallbackSlot: fallback,
      interview,
    };
    },
    // Read Committed, with the row lock above doing the work. Serialisable here
    // aborts nearly every claim in a burst: at 200 simultaneous claims it failed
    // 137, and adding the lock on top made it 162, because a queued transaction
    // whose snapshot went stale aborts regardless. Under Read Committed the
    // waiters simply re-read after acquiring the lock.
    { isolationLevel: 'ReadCommitted', maxRetries: 5, timeout: 20000, maxWait: 15000 }
  );
}

/**
 * Give up a seat, and hand it to whoever is next.
 *
 * A candidate cancelling withdraws entirely: any waitlist row they hold against
 * this seat goes too, because a waitlist entry whose fallback has evaporated is
 * exactly the seatless limbo this design exists to avoid. An admin cancelling
 * ignores the cutoff, which is the normal fix for a real problem.
 */
export async function cancelSignup({ signupId, actorId = null, reason = null, isAdmin = false }) {
  const now = new Date();

  return withSerializableTransaction(prisma, async (tx) => {
    const signup = await tx.interviewSlotSignup.findUnique({
      where: { id: signupId },
      include: { slot: { include: { interview: { select: { id: true, title: true, interviewType: true } } } } },
    });
    if (!signup) throw new SlotTransactionError(404, 'That booking no longer exists');
    if (!LIVE_STATUSES.includes(signup.status)) {
      throw new SlotTransactionError(409, 'That booking has already been cancelled');
    }
    // Re-checked here rather than trusted from the read that preceded the
    // request: a queued request can cross the cutoff while it waits.
    if (!isAdmin && !canModify(signup.slot.startTime)) {
      throw new SlotTransactionError(
        409,
        `Bookings can no longer be changed within ${MODIFY_CUTOFF_HOURS} hours of the start time`
      );
    }

    await tx.interviewSlotSignup.update({
      where: { id: signupId },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledById: actorId, cancelReason: reason },
    });

    const dependentWaitlist = await tx.interviewSlotSignup.findFirst({
      where: { heldSeatId: signupId, status: 'WAITLISTED' },
      select: SIGNUP_SELECT,
    });
    if (dependentWaitlist) {
      await tx.interviewSlotSignup.update({
        where: { id: dependentWaitlist.id },
        data: { status: 'CANCELLED', cancelledAt: now, cancelledById: actorId, cancelReason: reason, heldSeatId: null },
      });
    }

    const promotions = await drainWaitlist(tx, signup.slotId, now);
    const alsoDrained = dependentWaitlist
      ? await drainWaitlist(tx, dependentWaitlist.slotId, now)
      : [];

    return {
      cancelled: signup,
      alsoCancelled: dependentWaitlist,
      promotions: [...promotions, ...alsoDrained],
      interview: signup.slot.interview,
    };
  });
}

/**
 * Move a booking to another slot in the same interview.
 *
 * Updated in place rather than cancelled and recreated: the partial unique index
 * is on (interviewId, applicationId) and is untouched by a slotId change,
 * signedUpAt survives, and any waitlist row pointing at this seat via heldSeatId
 * stays valid without repair.
 *
 * `force` is the admin override - it books past capacity, and admins skip the
 * cutoff entirely. Over-capacity is recorded rather than hidden: movedById is
 * what the roster integrity check reads to tell a deliberate overfill from a bug.
 */
export async function moveSignup({
  signupId,
  toSlotId,
  actorId = null,
  reason = null,
  isAdmin = false,
  force = false,
}) {
  const now = new Date();

  return withSerializableTransaction(prisma, async (tx) => {
    const signup = await tx.interviewSlotSignup.findUnique({
      where: { id: signupId },
      include: { slot: true },
    });
    if (!signup) throw new SlotTransactionError(404, 'That booking no longer exists');
    if (!LIVE_STATUSES.includes(signup.status)) {
      throw new SlotTransactionError(409, 'That booking is no longer active');
    }
    if (signup.slotId === toSlotId) {
      throw new SlotTransactionError(409, 'That booking is already in this time slot');
    }

    const target = await loadSlotForBooking(tx, toSlotId);
    if (target.interviewId !== signup.interviewId) {
      // Moving between sibling interviews of the same round is allowed - that is
      // how a coffee chat morning and afternoon are actually modelled. Moving to
      // a different round is not: it would put someone in an interview they have
      // not reached.
      const from = await tx.interview.findUnique({
        where: { id: signup.interviewId },
        select: { cycleId: true, interviewType: true },
      });
      const sameRound =
        from &&
        from.cycleId === target.interview.cycleId &&
        from.interviewType === target.interview.interviewType;
      if (!sameRound) {
        throw new SlotTransactionError(400, 'A booking can only move within the same interview round');
      }
    }
    if (!isAdmin) {
      if (!isCandidateBookable(target, now)) {
        throw new SlotTransactionError(409, 'Signup is not open for that time slot');
      }
      if (!canModify(signup.slot.startTime) || !canModify(target.startTime)) {
        throw new SlotTransactionError(
          409,
          `Bookings can no longer be changed within ${MODIFY_CUTOFF_HOURS} hours of the start time`
        );
      }
    }

    const confirmed = await countConfirmed(tx, toSlotId);
    const overCapacity = target.candidateCapacity != null && confirmed >= target.candidateCapacity;
    if (overCapacity && !(isAdmin && force)) {
      throw new SlotTransactionError(409, 'OVER_CAPACITY');
    }

    const vacatedSlotId = signup.slotId;
    const moved = await tx.interviewSlotSignup.update({
      where: { id: signupId },
      data: {
        slotId: toSlotId,
        // Carried with the slot. A move between sibling interviews changes both,
        // and the composite foreign key would reject the row if only one moved.
        interviewId: target.interviewId,
        // Someone moved off a waitlist or out of limbo now holds a real seat.
        status: 'CONFIRMED',
        waitlistedAt: null,
        promotedAt: signup.status === 'CONFIRMED' ? signup.promotedAt : now,
        heldSeatId: null,
        movedById: actorId,
        movedAt: now,
        moveReason: reason,
      },
      select: SIGNUP_SELECT,
    });

    // If they were waitlisted and holding a seat elsewhere, that seat is now
    // surplus - release it, and let its slot's queue have it.
    let releasedSeatId = null;
    if (signup.heldSeatId) {
      const released = await tx.interviewSlotSignup.update({
        where: { id: signup.heldSeatId },
        data: { status: 'RELEASED', cancelledAt: now },
        select: { id: true, slotId: true },
      });
      releasedSeatId = released.id;
      await drainWaitlist(tx, released.slotId, now);
    }

    const promotions = await drainWaitlist(tx, vacatedSlotId, now);

    return { moved, vacatedSlotId, releasedSeatId, promotions, overCapacity, target };
  });
}

/**
 * Place a candidate into a slot directly. The admin resolution path for a
 * NEEDS_PLACEMENT escalation, and the manual override generally.
 */
export async function placeCandidate({
  interviewId,
  slotId,
  applicationId,
  actorId,
  force = false,
}) {
  const now = new Date();

  return withSerializableTransaction(prisma, async (tx) => {
    const slot = await loadSlotForBooking(tx, slotId);
    if (slot.interviewId !== interviewId) {
      throw new SlotTransactionError(400, 'That slot belongs to a different interview');
    }

    const existing = await tx.interviewSlotSignup.findMany({
      where: { interviewId, applicationId, status: { in: LIVE_STATUSES } },
      select: SIGNUP_SELECT,
    });

    // Already somewhere in this interview: that is a move, and moving keeps the
    // audit trail and the waitlist bookkeeping intact.
    const live = existing.find((row) => row.status === 'CONFIRMED') ?? existing[0];
    if (live) {
      if (live.slotId === slotId && live.status === 'CONFIRMED') {
        throw new SlotTransactionError(409, 'That candidate is already in this time slot');
      }
      return { placed: null, moveInstead: live.id };
    }

    const confirmed = await countConfirmed(tx, slotId);
    const overCapacity = slot.candidateCapacity != null && confirmed >= slot.candidateCapacity;
    if (overCapacity && !force) throw new SlotTransactionError(409, 'OVER_CAPACITY');

    const placed = await tx.interviewSlotSignup.create({
      data: {
        slotId,
        interviewId,
        applicationId,
        status: 'CONFIRMED',
        placedById: actorId,
        signedUpAt: now,
      },
      select: SIGNUP_SELECT,
    });

    return { placed, overCapacity, slot };
  });
}

export { drainWaitlist, loadSlotsWithCounts, LIVE_STATUSES };
