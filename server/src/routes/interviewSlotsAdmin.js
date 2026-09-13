// Admin slot management and the interview roster.
//
// Mounted under /api/admin, which already applies requireAuth + requireAdmin.
//
// The roster endpoint is what the gallery renders: every slot, who is in it,
// who is waiting, and who is in the round but nowhere at all. That last group
// is the thing the old page could not answer - membership lived in a JSON blob
// with no notion of "everyone eligible", so an admin had no way to see who they
// had forgotten.
//
// Admin moves deliberately bypass both guards a candidate gets: the 12-hour
// cutoff, and capacity. Recruitment rescheduling someone the morning of is the
// normal fix for a real problem, and squeezing a fifth candidate into a group of
// four is a call a person should be allowed to make. Both are recorded rather
// than hidden - movedById is what tells a deliberate overfill from a bug.

import express from 'express';
import prisma from '../prismaClient.js';
import { resolveAdminCycle } from '../services/activeCycle.js';
import { roundNumberForInterviewType } from '../utils/interviewRounds.js';
import { SlotTransactionError } from '../utils/withSerializableTransaction.js';
import { moveSignup, cancelSignup, placeCandidate } from '../services/interviewSignups.js';
import {
  SLOT_NOTIFICATION_SUBJECTS,
  flushNotifications,
  queueNotifications,
} from '../services/interviewSlotComms.js';
import { renderInterviewSlotEmail } from '../services/emailNotifications.js';
import config from '../config.js';

const router = express.Router();

const renderBody = (notification) =>
  renderInterviewSlotEmail(notification, { ctaUrl: `${config.clientUrl}/interview-signup` });

const fail = (res, error, fallback) => {
  if (error instanceof SlotTransactionError || (error?.status && error?.message)) {
    // OVER_CAPACITY is a decision point, not a failure: the gallery turns it
    // into "this session is full, move anyway?" and retries with force.
    const code = error.message === 'OVER_CAPACITY' ? 'OVER_CAPACITY' : undefined;
    return res.status(error.status).json({ error: error.message, code });
  }
  console.error('[interviewSlotsAdmin]', error);
  return res.status(500).json({ error: fallback });
};

const parseTime = (value) => {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date; // undefined => invalid
};

// GET /api/admin/interviews/:id/roster
// Everything the gallery draws, in one request.
router.get('/interviews/:id/roster', async (req, res) => {
  try {
    const { id } = req.params;
    const interview = await prisma.interview.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        interviewType: true,
        location: true,
        startDate: true,
        endDate: true,
        cycleId: true,
        slots: {
          orderBy: { startTime: 'asc' },
          include: {
            signups: {
              where: { status: { in: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'] } },
              orderBy: [{ waitlistedAt: 'asc' }, { signedUpAt: 'asc' }],
              include: {
                application: {
                  select: { id: true, firstName: true, lastName: true, email: true, major1: true, graduationYear: true },
                },
              },
            },
            assignments: {
              where: { removedAt: null },
              include: { user: { select: { id: true, fullName: true, email: true } } },
            },
          },
        },
      },
    });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    // Anyone in this interview's round who is not in a slot. Derived from the
    // round mapping rather than stored, so it cannot drift out of date.
    const round = roundNumberForInterviewType(interview.interviewType);
    const placedIds = new Set(
      interview.slots.flatMap((slot) => slot.signups.map((signup) => signup.applicationId))
    );
    const eligible = round
      ? await prisma.application.findMany({
          where: { cycleId: interview.cycleId, currentRound: round, status: { notIn: ['REJECTED'] } },
          select: { id: true, firstName: true, lastName: true, email: true, major1: true, graduationYear: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        })
      : [];

    const slots = interview.slots.map((slot) => {
      const confirmed = slot.signups.filter((s) => s.status === 'CONFIRMED');
      return {
        id: slot.id,
        label: slot.label,
        startTime: slot.startTime,
        endTime: slot.endTime,
        location: slot.location || interview.location,
        candidateCapacity: slot.candidateCapacity,
        interviewerCapacity: slot.interviewerCapacity,
        signupOpensAt: slot.signupOpensAt,
        signupClosesAt: slot.signupClosesAt,
        notes: slot.notes,
        confirmedCount: confirmed.length,
        // Surfaced rather than inferred: an admin who forced a move past
        // capacity should see the consequence every time they open the page.
        isOverCapacity: slot.candidateCapacity != null && confirmed.length > slot.candidateCapacity,
        signups: slot.signups.map((signup) => ({
          id: signup.id,
          status: signup.status,
          applicationId: signup.applicationId,
          signedUpAt: signup.signedUpAt,
          waitlistedAt: signup.waitlistedAt,
          // The cross-column relationship the two-block view most needs to make
          // legible: this person is waiting here but holds a seat over there.
          heldSeatId: signup.heldSeatId,
          movedById: signup.movedById,
          placedById: signup.placedById,
          candidate: signup.application,
        })),
        interviewers: slot.assignments.map((assignment) => ({
          id: assignment.id,
          role: assignment.role,
          user: assignment.user,
        })),
      };
    });

    res.json({
      interview: {
        id: interview.id,
        title: interview.title,
        interviewType: interview.interviewType,
        location: interview.location,
        startDate: interview.startDate,
        endDate: interview.endDate,
        round,
      },
      slots,
      unassigned: eligible.filter((application) => !placedIds.has(application.id)),
      needsPlacement: slots.flatMap((slot) =>
        slot.signups.filter((s) => s.status === 'NEEDS_PLACEMENT').map((s) => ({ ...s, slotId: slot.id }))
      ),
    });
  } catch (error) {
    fail(res, error, 'Failed to load the interview roster');
  }
});

// POST /api/admin/interviews/:id/slots
router.post('/interviews/:id/slots', async (req, res) => {
  try {
    const { id } = req.params;
    const { label, startTime, endTime, location, candidateCapacity, interviewerCapacity, notes } = req.body ?? {};

    const start = parseTime(startTime);
    const end = parseTime(endTime);
    if (!start || !end) return res.status(400).json({ error: 'A valid start and end time are required' });
    if (end <= start) return res.status(400).json({ error: 'The end time must be after the start time' });

    const interview = await prisma.interview.findUnique({ where: { id }, select: { id: true } });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const slot = await prisma.interviewSlot.create({
      data: {
        interviewId: id,
        label: label || null,
        startTime: start,
        endTime: end,
        location: location || null,
        candidateCapacity: candidateCapacity == null ? null : Number(candidateCapacity),
        interviewerCapacity: interviewerCapacity == null ? null : Number(interviewerCapacity),
        notes: notes || null,
      },
    });
    res.status(201).json(slot);
  } catch (error) {
    fail(res, error, 'Failed to create that time slot');
  }
});

// POST /api/admin/interviews/:id/slots/generate
// Two named blocks for a coffee chat day, or a cadence of group interviews.
router.post('/interviews/:id/slots/generate', async (req, res) => {
  try {
    const { id } = req.params;
    const { blocks, cadence } = req.body ?? {};

    const interview = await prisma.interview.findUnique({
      where: { id },
      select: { id: true, interviewType: true, startDate: true, endDate: true },
    });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const rows = [];

    // Named blocks: the coffee chat shape, where the block is the unit.
    for (const block of blocks ?? []) {
      const start = parseTime(block.startTime);
      const end = parseTime(block.endTime);
      if (!start || !end || end <= start) {
        return res.status(400).json({ error: `Block "${block.label ?? ''}" has an invalid time range` });
      }
      rows.push({
        interviewId: id,
        label: block.label || null,
        startTime: start,
        endTime: end,
        candidateCapacity: block.candidateCapacity == null ? null : Number(block.candidateCapacity),
      });
    }

    // Cadence: the first round shape - back-to-back sittings of N minutes.
    if (cadence) {
      const start = parseTime(cadence.startTime);
      const end = parseTime(cadence.endTime);
      const minutes = Number(cadence.minutes);
      const capacity = cadence.candidateCapacity == null ? null : Number(cadence.candidateCapacity);
      if (!start || !end || end <= start) {
        return res.status(400).json({ error: 'The cadence needs a valid time range' });
      }
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return res.status(400).json({ error: 'The cadence needs a positive length in minutes' });
      }
      // Bounded so a typo in the range cannot ask for ten thousand rows.
      const maxSlots = 200;
      for (let cursor = start; cursor < end && rows.length < maxSlots; ) {
        const next = new Date(cursor.getTime() + minutes * 60000);
        if (next > end) break;
        rows.push({
          interviewId: id,
          label: null,
          startTime: cursor,
          endTime: next,
          candidateCapacity: capacity,
        });
        cursor = next;
      }
    }

    if (rows.length === 0) return res.status(400).json({ error: 'Nothing to generate' });

    await prisma.interviewSlot.createMany({ data: rows });
    const slots = await prisma.interviewSlot.findMany({
      where: { interviewId: id },
      orderBy: { startTime: 'asc' },
    });
    res.status(201).json({ created: rows.length, slots });
  } catch (error) {
    fail(res, error, 'Failed to generate time slots');
  }
});

// PATCH /api/admin/interviews/slots/:slotId
router.patch('/interviews/slots/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const body = req.body ?? {};
    const data = {};

    for (const [field, value] of Object.entries({ startTime: body.startTime, endTime: body.endTime })) {
      if (value === undefined) continue;
      const parsed = parseTime(value);
      // A malformed timestamp is rejected rather than quietly ignored - silently
      // keeping the old value looks like a successful edit that did nothing.
      if (parsed === undefined) return res.status(400).json({ error: `${field} is not a valid date` });
      data[field] = parsed;
    }
    if (body.label !== undefined) data.label = body.label || null;
    if (body.location !== undefined) data.location = body.location || null;
    if (body.notes !== undefined) data.notes = body.notes || null;
    if (body.candidateCapacity !== undefined) {
      data.candidateCapacity = body.candidateCapacity == null ? null : Number(body.candidateCapacity);
    }
    if (body.interviewerCapacity !== undefined) {
      data.interviewerCapacity = body.interviewerCapacity == null ? null : Number(body.interviewerCapacity);
    }
    if (body.signupOpensAt !== undefined) data.signupOpensAt = parseTime(body.signupOpensAt) ?? null;
    if (body.signupClosesAt !== undefined) data.signupClosesAt = parseTime(body.signupClosesAt) ?? null;

    const slot = await prisma.interviewSlot.update({ where: { id: slotId }, data });
    if (slot.endTime <= slot.startTime) {
      return res.status(400).json({ error: 'The end time must be after the start time' });
    }
    res.json(slot);
  } catch (error) {
    fail(res, error, 'Failed to update that time slot');
  }
});

// DELETE /api/admin/interviews/slots/:slotId
router.delete('/interviews/slots/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const live = await prisma.interviewSlotSignup.count({
      where: { slotId, status: { in: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'] } },
    });
    // Refuse rather than cascade. Deleting the slot would delete its signups,
    // and the candidates in them would find out by turning up to nothing.
    if (live > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        error: `${live} candidate${live === 1 ? ' is' : 's are'} in this session. Move them first, or delete with force.`,
        code: 'SLOT_NOT_EMPTY',
        count: live,
      });
    }
    await prisma.interviewSlot.delete({ where: { id: slotId } });
    res.json({ deleted: true });
  } catch (error) {
    fail(res, error, 'Failed to delete that time slot');
  }
});

// POST /api/admin/interviews/:id/slot-signups   { slotId, applicationId, force }
// Place a candidate by hand - the resolution path for a NEEDS_PLACEMENT alert.
router.post('/interviews/:id/slot-signups', async (req, res) => {
  try {
    const { slotId, applicationId, force } = req.body ?? {};
    if (!slotId || !applicationId) {
      return res.status(400).json({ error: 'A slot and a candidate are required' });
    }

    const result = await placeCandidate({
      interviewId: req.params.id,
      slotId,
      applicationId,
      actorId: req.user.id,
      force: force === true,
    });

    // Already in this interview: a move keeps the audit trail and the waitlist
    // bookkeeping intact, so say so rather than creating a second row.
    if (result.moveInstead) {
      const moved = await moveSignup({
        signupId: result.moveInstead,
        toSlotId: slotId,
        actorId: req.user.id,
        isAdmin: true,
        force: force === true,
        reason: 'Placed by an admin',
      });
      await notifyMoved(moved);
      return res.json({ moved: true, signupId: moved.moved.id });
    }

    res.status(201).json({ placed: true, signupId: result.placed.id, overCapacity: result.overCapacity });
  } catch (error) {
    fail(res, error, 'Failed to place that candidate');
  }
});

// POST /api/admin/interviews/slot-signups/:signupId/move   { toSlotId, force, reason }
router.post('/interviews/slot-signups/:signupId/move', async (req, res) => {
  try {
    const { toSlotId, force, reason } = req.body ?? {};
    if (!toSlotId) return res.status(400).json({ error: 'A destination time slot is required' });

    const result = await moveSignup({
      signupId: req.params.signupId,
      toSlotId,
      actorId: req.user.id,
      reason: reason || null,
      isAdmin: true,
      force: force === true,
    });

    await notifyMoved(result);
    res.json({
      moved: true,
      signupId: result.moved.id,
      promoted: result.promotions.length,
      overCapacity: result.overCapacity,
    });
  } catch (error) {
    fail(res, error, 'Failed to move that candidate');
  }
});

// DELETE /api/admin/interviews/slot-signups/:signupId
router.delete('/interviews/slot-signups/:signupId', async (req, res) => {
  try {
    const result = await cancelSignup({
      signupId: req.params.signupId,
      actorId: req.user.id,
      reason: req.body?.reason || null,
      isAdmin: true,
    });
    await notifyPromotions(result.promotions);
    res.json({ cancelled: true, promoted: result.promotions.length });
  } catch (error) {
    fail(res, error, 'Failed to remove that candidate');
  }
});

// POST /api/admin/interview-slot-notifications/:id/resend
router.post('/interview-slot-notifications/:id/resend', async (req, res) => {
  try {
    const notification = await prisma.interviewSlotNotification.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    const [result] = await flushNotifications([notification.id], renderBody);
    res.json(result ?? { skipped: true });
  } catch (error) {
    fail(res, error, 'Failed to resend that email');
  }
});

// GET /api/admin/interviews/:id/roster/integrity
// The invariants, checked against live data. Same assertions the concurrency
// suite makes, exposed so production can be inspected without a shell.
router.get('/interviews/:id/roster/integrity', async (req, res) => {
  try {
    const { id } = req.params;
    const slots = await prisma.interviewSlot.findMany({
      where: { interviewId: id },
      include: { signups: true },
    });

    const problems = [];
    const confirmedByApplication = new Map();

    for (const slot of slots) {
      const confirmed = slot.signups.filter((s) => s.status === 'CONFIRMED');
      const waiting = slot.signups.filter((s) => s.status === 'WAITLISTED');

      if (slot.candidateCapacity != null && confirmed.length > slot.candidateCapacity) {
        const deliberate = confirmed.filter((s) => s.movedById || s.placedById).length > 0;
        problems.push({
          severity: deliberate ? 'info' : 'error',
          slotId: slot.id,
          message: `${confirmed.length} confirmed in a session of ${slot.candidateCapacity}` +
            (deliberate ? ' (an admin placed someone over capacity)' : ''),
        });
      }
      if (waiting.length > 0 && slot.candidateCapacity != null && confirmed.length < slot.candidateCapacity) {
        problems.push({
          severity: 'error',
          slotId: slot.id,
          message: 'This session has empty seats and a waitlist - the waitlist was not drained',
        });
      }
      for (const signup of confirmed) {
        const seen = confirmedByApplication.get(signup.applicationId) ?? [];
        confirmedByApplication.set(signup.applicationId, [...seen, slot.id]);
      }
      for (const signup of waiting) {
        if (!signup.heldSeatId) {
          problems.push({
            severity: 'error',
            slotId: slot.id,
            signupId: signup.id,
            message: 'Waitlisted without holding a seat anywhere',
          });
        }
      }
    }

    for (const [applicationId, slotIds] of confirmedByApplication) {
      if (slotIds.length > 1) {
        problems.push({
          severity: 'error',
          message: `One candidate holds ${slotIds.length} confirmed seats in this interview`,
          applicationId,
          slotIds,
        });
      }
    }

    res.json({ ok: problems.filter((p) => p.severity === 'error').length === 0, problems });
  } catch (error) {
    fail(res, error, 'Failed to check the roster');
  }
});

// ---------------------------------------------------------------------------

async function notifyMoved(result) {
  const entries = [];
  const moved = await prisma.interviewSlotSignup.findUnique({
    where: { id: result.moved.id },
    include: {
      application: { select: { email: true } },
      slot: { include: { interview: { select: { title: true } } } },
    },
  });
  if (moved?.application?.email) {
    entries.push({
      slotId: moved.slotId,
      signupId: moved.id,
      type: 'MOVED_BY_ADMIN',
      recipient: moved.application.email,
      subject: SLOT_NOTIFICATION_SUBJECTS.MOVED_BY_ADMIN(moved.slot.interview.title),
    });
  }
  const ids = entries.length ? await prisma.$transaction((tx) => queueNotifications(tx, entries)) : [];
  const promotionIds = await notifyPromotions(result.promotions, { flush: false });
  flushNotifications([...ids, ...promotionIds], renderBody).catch((e) =>
    console.error('[interviewSlotsAdmin] flush failed', e)
  );
}

async function notifyPromotions(promotions, { flush = true } = {}) {
  if (!promotions?.length) return [];
  const rows = await prisma.interviewSlotSignup.findMany({
    where: { id: { in: promotions.map((p) => p.signupId) } },
    include: {
      application: { select: { email: true } },
      slot: { include: { interview: { select: { title: true } } } },
    },
  });
  const entries = rows
    .filter((row) => row.application?.email)
    .map((row) => ({
      slotId: row.slotId,
      signupId: row.id,
      type: 'PROMOTED',
      recipient: row.application.email,
      subject: SLOT_NOTIFICATION_SUBJECTS.PROMOTED(row.slot.interview.title),
    }));
  if (entries.length === 0) return [];

  const ids = await prisma.$transaction((tx) => queueNotifications(tx, entries));
  if (flush) {
    flushNotifications(ids, renderBody).catch((e) =>
      console.error('[interviewSlotsAdmin] flush failed', e)
    );
  }
  return ids;
}

export default router;
