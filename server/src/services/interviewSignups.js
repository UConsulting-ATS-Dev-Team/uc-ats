// Booking, cancelling and moving a candidate's place in an interview slot.
//
// Capacity cannot be enforced by checking and then writing, because two requests
// for the last seat both check successfully. So every operation here that
// changes who holds a seat first locks the round's sessions (lockRoundSlots /
// lockRoundOfSlot), then reads every fact that decides the outcome, then writes,
// all in one transaction. Holding the lock, it is the only writer in that round,
// and under Read Committed each read after the lock sees everything the
// previous holder committed.
//
// The GTKUC booking route (routes/candidate.js) does check-then-write at Read
// Committed and can overbook. It predates this and is worth fixing separately;
// do not copy it.
//
// Nothing in here sends email. Transaction bodies return a plan, the caller
// commits, and only then does anything leave the building - because a retried
// transaction runs its body again, and an email sent inside one goes twice.

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../prismaClient.js';
import { createKeyedBatchQueue } from '../utils/keyedBatchQueue.js';
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
 * lockRoundSlots for the round a slot belongs to, found and locked in one
 * statement.
 *
 * Every write that changes who holds a seat - booking, cancelling, moving,
 * promoting, placing - takes this lock first. Capacity is a count over rows
 * none of them can lock individually, and Serialisable cannot referee between
 * a Serialisable writer and the Read Committed booking batch: SSI only sees
 * transactions that are themselves Serialisable. So they all queue on the same
 * rows instead, and each reads only after it holds them.
 *
 * It must be the transaction's first statement. Under Read Committed each
 * statement after it reads what is committed by then, which is everything the
 * previous holder wrote.
 */
async function lockRoundOfSlot(tx, slotId) {
  await tx.$queryRaw`
    SELECT s.id
    FROM interview_slots s
    JOIN interviews i ON i.id = s."interviewId"
    JOIN (
      SELECT ri."cycleId", ri."interviewType"
      FROM interview_slots rs
      JOIN interviews ri ON ri.id = rs."interviewId"
      WHERE rs.id = ${slotId}
    ) target ON target."cycleId" = i."cycleId" AND target."interviewType" = i."interviewType"
    WHERE i.status NOT IN ('CANCELLED', 'COMPLETED')
    ORDER BY s.id
    FOR UPDATE OF s`;
}

/** lockRoundOfSlot, starting from a signup rather than a slot. */
async function lockRoundOfSignup(tx, signupId) {
  await tx.$queryRaw`
    SELECT s.id
    FROM interview_slots s
    JOIN interviews i ON i.id = s."interviewId"
    JOIN (
      SELECT ri."cycleId", ri."interviewType"
      FROM interview_slot_signups su
      JOIN interview_slots rs ON rs.id = su."slotId"
      JOIN interviews ri ON ri.id = rs."interviewId"
      WHERE su.id = ${signupId}
    ) target ON target."cycleId" = i."cycleId" AND target."interviewType" = i."interviewType"
    WHERE i.status NOT IN ('CANCELLED', 'COMPLETED')
    ORDER BY s.id
    FOR UPDATE OF s`;
}

/**
 * Transaction options for anything that holds the round lock. Read Committed,
 * because the lock is doing the work: under Serialisable a writer that queued
 * on the lock still reads from a snapshot taken before it got it, and aborts.
 */
const ROUND_LOCKED = { isolationLevel: 'ReadCommitted', maxRetries: 5, timeout: 20000, maxWait: 15000 };

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

      // Conditional claim. The round lock already rules out a concurrent writer,
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
  if (slot.interview.status === 'CANCELLED') {
    throw new SlotTransactionError(409, 'That interview has been cancelled');
  }
  return slot;
}

/**
 * Every booking-relevant fact about one round, read once under the round lock.
 *
 * A round spans sibling interviews. Recruitment models a coffee chat day as two
 * Interview rows - "Coffee Chat - Round 1" in the morning and "Round 2" in the
 * afternoon - rather than as two sittings of one interview, so "the other
 * session a full candidate falls back into" has to be able to cross an
 * interview boundary. Sibling means: same cycle, same interviewType, not
 * cancelled or completed. The round lock is also the only thing enforcing "one
 * seat per candidate per round", since a unique index cannot span interviews.
 *
 * One read per kind of fact rather than one per candidate: the confirmed count
 * and the group labels come out of a single groupBy, and the existing signups of
 * every candidate in the batch come out of one query. What a batch costs in
 * round trips no longer grows with how many people are in it.
 */
async function loadRoundState(tx, round, applicationIds) {
  const interviews = await tx.interview.findMany({
    where: {
      cycleId: round.cycleId,
      interviewType: round.interviewType,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    select: { id: true, cycleId: true, title: true, interviewType: true, status: true, location: true },
  });
  const interviewIds = interviews.map((row) => row.id);
  if (interviewIds.length === 0) return { slots: [], existing: [], latestAt: 0 };

  const slotRows = await tx.interviewSlot.findMany({
    where: { interviewId: { in: interviewIds } },
    orderBy: { startTime: 'asc' },
  });
  const confirmedRows = await tx.interviewSlotSignup.groupBy({
    by: ['slotId', 'groupLabel'],
    where: { interviewId: { in: interviewIds }, status: 'CONFIRMED' },
    _count: { _all: true },
  });
  const existing = await tx.interviewSlotSignup.findMany({
    where: { interviewId: { in: interviewIds }, applicationId: { in: applicationIds }, status: { in: LIVE_STATUSES } },
    select: SIGNUP_SELECT,
  });
  const latest = await tx.interviewSlotSignup.aggregate({
    where: { interviewId: { in: interviewIds } },
    _max: { signedUpAt: true, waitlistedAt: true },
  });
  const latestAt = Math.max(
    latest._max.signedUpAt?.getTime() ?? 0,
    latest._max.waitlistedAt?.getTime() ?? 0
  );

  const interviewById = new Map(interviews.map((row) => [row.id, row]));
  const slots = slotRows.map((slot) => {
    const rows = confirmedRows.filter((row) => row.slotId === slot.id);
    return {
      ...slot,
      interview: interviewById.get(slot.interviewId),
      confirmedCount: rows.reduce((sum, row) => sum + row._count._all, 0),
      // The shape nextLabelFrom reads. Kept current as the batch seats people.
      labelCounts: rows
        .filter((row) => row.groupLabel != null)
        .map((row) => ({ groupLabel: row.groupLabel, count: row._count._all })),
    };
  });
  return { slots, existing, latestAt };
}

/** Seat someone in `slot` in memory, returning the group label they get. */
function takeSeat(slot) {
  const groupLabel = nextLabelFrom(slot.labelCounts, slot.groupSize);
  slot.confirmedCount += 1;
  if (groupLabel) {
    const row = slot.labelCounts.find((entry) => entry.groupLabel === groupLabel);
    if (row) row.count += 1;
    else slot.labelCounts.push({ groupLabel, count: 1 });
  }
  return groupLabel;
}

/** A row about to be inserted, and the SIGNUP_SELECT view of it callers get back. */
function plannedSignup(data) {
  const row = { id: randomUUID(), groupLabel: null, waitlistedAt: null, heldSeatId: null, ...data };
  const view = {
    id: row.id,
    slotId: row.slotId,
    interviewId: row.interviewId,
    applicationId: row.applicationId,
    status: row.status,
    signedUpAt: row.signedUpAt,
    waitlistedAt: row.waitlistedAt,
    heldSeatId: row.heldSeatId,
    promotedAt: null,
  };
  return { row, view };
}

/**
 * Decide one claim against the in-memory round state, mutating it.
 *
 * The same checks and the same three outcomes as before batching; only where
 * the facts come from changed. Throws SlotTransactionError for a refusal, which
 * fails this claim alone.
 */
function decideClaim(claim, state, now, rows) {
  const { applicationId, slotId, at } = claim;
  const slot = state.slots.find((s) => s.id === slotId);
  if (!slot) {
    // Present when the claim was queued, gone now: the slot was deleted, or its
    // interview was cancelled or completed while the claim waited.
    throw new SlotTransactionError(409, 'That interview is no longer taking signups.');
  }
  const { interview } = slot;
  if (!isCandidateBookable(slot, now)) {
    throw new SlotTransactionError(409, 'Signup is not open for that time slot');
  }
  if (!canModify(slot.startTime)) {
    throw new SlotTransactionError(409, `Signup closes ${MODIFY_CUTOFF_HOURS} hours before a slot starts`);
  }

  // Sibling interviews of the same round count as one pool, so a candidate
  // cannot hold a seat in "Coffee Chat - Round 1" and another in "Round 2".
  const existing = state.existing.filter((row) => row.applicationId === applicationId);
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

  const keep = (planned) => {
    rows.push(planned.row);
    state.existing.push(planned.view);
    return planned.view;
  };

  if (hasRoom(slot, slot.confirmedCount)) {
    const confirmed = keep(
      plannedSignup({
        slotId,
        interviewId: interview.id,
        applicationId,
        status: 'CONFIRMED',
        groupLabel: takeSeat(slot),
        signedUpAt: at,
      })
    );
    return { outcome: 'CONFIRMED', confirmed, waitlisted: null, slot, interview };
  }

  const fallback = chooseFallbackSlot(state.slots, slotId, now);

  if (!fallback) {
    const needsPlacement = keep(
      plannedSignup({ slotId, interviewId: interview.id, applicationId, status: 'NEEDS_PLACEMENT', signedUpAt: at })
    );
    return { outcome: 'NEEDS_PLACEMENT', needsPlacement, slot, interview };
  }

  // The fallback may live in a sibling interview, so the seat is filed against
  // that one - the composite foreign key would reject it otherwise.
  const confirmed = keep(
    plannedSignup({
      slotId: fallback.id,
      interviewId: fallback.interviewId,
      applicationId,
      status: 'CONFIRMED',
      groupLabel: takeSeat(fallback),
      signedUpAt: at,
    })
  );
  const waitlisted = keep(
    plannedSignup({
      slotId,
      interviewId: interview.id,
      applicationId,
      status: 'WAITLISTED',
      signedUpAt: at,
      // FCFS for promotion. Each claim's own time, never the batch's: a shared
      // timestamp would leave nextInLine ordering a batch by random id.
      waitlistedAt: at,
      heldSeatId: confirmed.id,
    })
  );
  return { outcome: 'WAITLISTED', confirmed, waitlisted, slot, fallbackSlot: fallback, interview };
}

/**
 * Book a batch of claims for one round in one transaction.
 *
 * Takes the round lock, reads the round once, decides every claim in arrival
 * order against that state, and writes every row in one insert. Under the lock
 * that is a fixed handful of round trips however large the batch.
 *
 * Read Committed, with the row lock doing the work. Serialisable here aborts
 * nearly every claim in a burst: at 200 simultaneous claims it failed 137, and
 * adding the lock on top made it 162, because a queued transaction whose
 * snapshot went stale aborts regardless. Under Read Committed a waiter simply
 * re-reads after acquiring the lock.
 */
async function runClaimBatch(round, claims) {
  return withSerializableTransaction(
    prisma,
    async (tx) => {
      const now = new Date();
      // Take the round's sessions under a row lock before reading anything
      // about who is in them. Another server instance has its own queue, so
      // this lock is what keeps two instances' batches apart.
      await lockRoundSlots(tx, round);
      const state = await loadRoundState(tx, round, [...new Set(claims.map((claim) => claim.applicationId))]);

      // Timestamps follow the order seats are handed out in: this batch after
      // everything already in the round, and claims within it in arrival
      // order, a millisecond apart. Taken from the round rather than from each
      // server's clock, so two instances whose batches interleave, or whose
      // clocks disagree, still leave signedUpAt and waitlistedAt in the order
      // the lock decided.
      const firstAt = Math.max(now.getTime(), state.latestAt + 1);

      const rows = [];
      const outcomes = claims.map((claim, i) => {
        try {
          return { value: decideClaim({ ...claim, at: new Date(firstAt + i) }, state, now, rows) };
        } catch (error) {
          if (error instanceof SlotTransactionError) return { error };
          throw error;
        }
      });
      // Held seats sit before the waitlist rows that point at them, though
      // Postgres checks the self-reference at the end of the statement anyway.
      if (rows.length > 0) await tx.interviewSlotSignup.createMany({ data: rows });
      return outcomes;
    },
    ROUND_LOCKED
  );
}

// Failures that say the database is unreachable or overloaded, not that any one
// claim is wrong. withSerializableTransaction has already retried them; going
// round again claim by claim would hold the whole round's queue through a
// timeout per claim.
const DATABASE_UNAVAILABLE = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

/** Could running each claim alone get past this error? Only if a claim caused it. */
const isClaimSpecific = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError && !DATABASE_UNAVAILABLE.has(error.code);

/**
 * The batch runner the queue calls. A batch that fails on something a claim
 * caused - say, a unique index tripped by an admin placing that candidate at the
 * same moment - is retried one claim at a time, so the bad claim fails only
 * itself. A batch that fails because the database is down fails every claim at
 * once.
 */
async function runClaimBatchIsolatingFailures(_key, claims) {
  const { round } = claims[0];
  try {
    return await runClaimBatch(round, claims);
  } catch (error) {
    if (claims.length === 1 || !isClaimSpecific(error)) return claims.map(() => ({ error }));
    console.error(`[claimWithFallback] batch of ${claims.length} failed; retrying one at a time`, error);
    const outcomes = [];
    for (const claim of claims) {
      try {
        outcomes.push((await runClaimBatch(round, [claim]))[0]);
      } catch (single) {
        outcomes.push({ error: single });
      }
    }
    return outcomes;
  }
}

const enqueueClaim = createKeyedBatchQueue(runClaimBatchIsolatingFailures);

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
 *
 * Claims for the same round wait their turn in memory and are booked together
 * (runClaimBatch). Every claim in a round serialises on the round lock anyway,
 * so a decision email landing in ninety inboxes used to mean ninety
 * transactions in single file, each holding a pooled connection while it waited
 * and each paying several network round trips under the lock. Batched, the same
 * burst is a few transactions.
 */
export async function claimWithFallback({ applicationId, slotId, cycleId }) {
  // Read outside any transaction: this only decides which queue the claim
  // joins. Everything that decides the outcome is re-read under the lock.
  // Asked of the interview rather than the slot: a nested select is a second
  // query, and against a database 25ms away each one is felt.
  const interview = await prisma.interview.findFirst({
    where: { slots: { some: { id: slotId } } },
    select: { cycleId: true, interviewType: true, status: true },
  });
  if (!interview) throw new SlotTransactionError(404, 'That time slot no longer exists');
  if (cycleId && interview.cycleId !== cycleId) {
    throw new SlotTransactionError(400, 'That interview belongs to a different recruiting cycle');
  }
  if (interview.status === 'CANCELLED') {
    throw new SlotTransactionError(409, 'That interview has been cancelled');
  }

  const round = { cycleId: interview.cycleId, interviewType: interview.interviewType };
  return enqueueClaim(`${round.cycleId}:${round.interviewType}`, { applicationId, slotId, round });
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
    await lockRoundOfSignup(tx, signupId);
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
  }, ROUND_LOCKED);
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
    // The booking's round. A target in another round is refused below, so this
    // is the only round a move can change.
    await lockRoundOfSignup(tx, signupId);
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
    let releasedPromotions = [];
    if (signup.heldSeatId) {
      const released = await tx.interviewSlotSignup.update({
        where: { id: signup.heldSeatId },
        data: { status: 'RELEASED', cancelledAt: now },
        select: { id: true, slotId: true },
      });
      releasedSeatId = released.id;
      // Returned with the rest: somebody promoted into the released seat is
      // owed the same email as somebody promoted into the vacated one.
      releasedPromotions = await drainWaitlist(tx, released.slotId, now);
    }

    const promotions = [...(await drainWaitlist(tx, vacatedSlotId, now)), ...releasedPromotions];

    // fromSlot travels with the result so callers can tell a real change of
    // time from a reshuffle that lands on the same one - the difference between
    // an email a candidate needs and one that worries them for nothing.
    return { moved, vacatedSlotId, releasedSeatId, promotions, overCapacity, target, fromSlot: signup.slot, fromStatus: signup.status };
  }, ROUND_LOCKED);
}

/**
 * Give a waitlisted candidate the session they were waiting for, now.
 *
 * The move endpoint cannot do this: their row already sits on that session, so
 * "move" is a no-op and gets refused. What actually has to happen is a
 * promotion out of order - release the seat they were holding elsewhere, then
 * confirm them here, over capacity if an admin says so.
 *
 * This is the answer to "she is on the morning waitlist and I want her in the
 * morning", which previously had no button at all.
 */
export async function promoteFromWaitlist({ signupId, actorId, force = false }) {
  const now = new Date();

  return withSerializableTransaction(prisma, async (tx) => {
    await lockRoundOfSignup(tx, signupId);
    const signup = await tx.interviewSlotSignup.findUnique({
      where: { id: signupId },
      include: { slot: true },
    });
    if (!signup) throw new SlotTransactionError(404, 'That booking no longer exists');
    if (!['WAITLISTED', 'NEEDS_PLACEMENT'].includes(signup.status)) {
      throw new SlotTransactionError(409, 'That candidate is not waiting for this session');
    }

    const confirmed = await countConfirmed(tx, signup.slotId);
    const overCapacity =
      signup.slot.candidateCapacity != null && confirmed >= signup.slot.candidateCapacity;
    if (overCapacity && !force) throw new SlotTransactionError(409, 'OVER_CAPACITY');

    // Release before confirming: for the instant between, they would hold two
    // confirmed seats in one interview, which the partial unique index rejects.
    let releasedSlotId = null;
    if (signup.heldSeatId) {
      const released = await tx.interviewSlotSignup.update({
        where: { id: signup.heldSeatId },
        data: { status: 'RELEASED', cancelledAt: now },
        select: { id: true, slotId: true },
      });
      releasedSlotId = released.slotId;
    }

    const promoted = await tx.interviewSlotSignup.update({
      where: { id: signupId },
      data: {
        status: 'CONFIRMED',
        promotedAt: now,
        waitlistedAt: null,
        heldSeatId: null,
        movedById: actorId,
        movedAt: now,
        groupLabel: await nextGroupLabel(tx, signup.slot),
      },
      select: SIGNUP_SELECT,
    });

    // The seat they gave up may be what somebody else was waiting for.
    const promotions = releasedSlotId ? await drainWaitlist(tx, releasedSlotId, now) : [];

    return { promoted, releasedSlotId, promotions, overCapacity };
  }, ROUND_LOCKED);
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
    await lockRoundOfSlot(tx, slotId);
    const slot = await loadSlotForBooking(tx, slotId);
    if (slot.interviewId !== interviewId) {
      throw new SlotTransactionError(400, 'That slot belongs to a different interview');
    }

    // Searched across the whole round, not just this interview. Sibling
    // interviews share one pool (see loadRoundState), so somebody holding a seat
    // in the morning block, or in a virtual coffee chat, would otherwise be
    // given a second seat here.
    const existing = await tx.interviewSlotSignup.findMany({
      where: {
        applicationId,
        status: { in: LIVE_STATUSES },
        slot: {
          interview: {
            cycleId: slot.interview.cycleId,
            interviewType: slot.interview.interviewType,
            status: { notIn: ['CANCELLED', 'COMPLETED'] },
          },
        },
      },
      select: SIGNUP_SELECT,
    });

    // Already somewhere in this round: that is a move, and moving keeps the
    // audit trail and the waitlist bookkeeping intact. A waitlist row is the one
    // to move when there is one: moving it confirms them here and releases the
    // seat it was holding. Moving the held seat instead would leave the waitlist
    // entry behind, and its later promotion would pull them back out of here.
    const live =
      existing.find((row) => row.status === 'WAITLISTED') ??
      existing.find((row) => row.status === 'CONFIRMED') ??
      existing[0];
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
  }, ROUND_LOCKED);
}

/**
 * Mark an interview CANCELLED while holding its round lock, and return the seats
 * still live in it.
 *
 * Under the lock no placement or move can be half-done, and every one after it
 * reads CANCELLED in loadSlotForBooking and is refused. So the seats returned
 * here are all the seats there will ever be, and releasing them leaves nobody
 * booked into a cancelled interview.
 *
 * Repeatable. On an interview that is already CANCELLED it changes nothing and
 * returns whatever is still live, which is how a cancellation that stopped part
 * way gets finished. Returns null only for a COMPLETED interview.
 */
export async function closeInterviewToBookings({ interviewId, slotId }) {
  return withSerializableTransaction(prisma, async (tx) => {
    await lockRoundOfSlot(tx, slotId);
    const current = await tx.interview.findUnique({ where: { id: interviewId }, select: { status: true } });
    if (!current || current.status === 'COMPLETED') return null;
    if (current.status !== 'CANCELLED') {
      await tx.interview.update({ where: { id: interviewId }, data: { status: 'CANCELLED' } });
    }
    return tx.interviewSlotSignup.findMany({
      where: { interviewId, status: { in: LIVE_STATUSES } },
      select: { id: true },
    });
  }, ROUND_LOCKED);
}

export { drainWaitlist, isClaimSpecific, loadSlotsWithCounts, LIVE_STATUSES };
