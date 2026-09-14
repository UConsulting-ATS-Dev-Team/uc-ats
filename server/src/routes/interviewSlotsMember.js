// Members signing up to staff interview slots (issue #63).
//
// The mirror of the candidate side, on the same slot model. That sharing is the
// point: issue #82 was explicit that coffee chat and first round must not grow
// two separate capacity implementations, and staffing is the third caller of the
// same one.
//
// Differences from the candidate side, all deliberate:
//   - interviewerCapacity is a target, not a cap. A session wanting two
//     interviewers and getting three is over-staffed, which is a good problem;
//     a session with four candidates and five is a room that does not fit.
//     So this warns rather than refuses.
//   - Overlap IS refused. A member cannot be in two rooms at once, and unlike
//     capacity that is a physical fact rather than a preference.
//   - Members see who else is staffing a session. They are colleagues running it
//     together, not candidates who should not see each other's names.

import express from 'express';
import prisma from '../prismaClient.js';
import { resolveAdminCycle } from '../services/activeCycle.js';
import {
  SlotTransactionError,
  withSerializableTransaction,
} from '../utils/withSerializableTransaction.js';

const router = express.Router();

const STAFF_ROLES = new Set(['MEMBER', 'ADMIN']);

const fail = (res, error, fallback) => {
  if (error instanceof SlotTransactionError || (error?.status && error?.message)) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[interviewSlotsMember]', error);
  return res.status(500).json({ error: fallback });
};

// GET /api/member/interviews/open-for-availability
//
// Interviews this member can be asked "when are you free?" about.
//
// Deliberately NOT filtered to what they are already assigned to. Availability
// is collected before anybody is placed - that is its whole purpose, since how
// many interviews run at once is decided by how many people can be there - so
// gating the list on placement is circular: nobody is assigned yet, so nobody
// sees the form, so nobody ever gets assigned. Recruitment emails all sixty
// members and the question has to be answerable by all sixty.
//
// Coffee chats are excluded. Their sittings already exist and members claim
// them outright, so availability would be the same question asked twice.
router.get('/interviews/open-for-availability', async (req, res) => {
  try {
    if (!STAFF_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Member access required' });
    }
    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.json([]);

    const interviews = await prisma.interview.findMany({
      where: {
        cycleId: cycle.id,
        interviewType: { in: ['ROUND_ONE', 'ROUND_TWO', 'FINAL_ROUND'] },
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
      },
      select: { id: true, title: true, interviewType: true, startDate: true, endDate: true },
      orderBy: { startDate: 'asc' },
    });
    res.json(interviews);
  } catch (error) {
    fail(res, error, 'Failed to load interviews to give availability for');
  }
});

// GET /api/member/interview-slots
// Sessions in the active cycle, with who is staffing them and whether the caller is.
router.get('/interview-slots', async (req, res) => {
  try {
    if (!STAFF_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Member access required' });
    }
    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.json({ interviews: [] });

    const interviews = await prisma.interview.findMany({
      where: { cycleId: cycle.id, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
      orderBy: { startDate: 'asc' },
      include: {
        slots: {
          orderBy: { startTime: 'asc' },
          include: {
            assignments: {
              where: { removedAt: null },
              include: { user: { select: { id: true, fullName: true, email: true } } },
            },
            _count: { select: { signups: { where: { status: 'CONFIRMED' } } } },
          },
        },
      },
    });

    res.json({
      interviews: interviews
        .filter((interview) => interview.slots.length > 0)
        .map((interview) => ({
          id: interview.id,
          title: interview.title,
          interviewType: interview.interviewType,
          location: interview.location,
          slots: interview.slots.map((slot) => ({
            id: slot.id,
            label: slot.label,
            startTime: slot.startTime,
            endTime: slot.endTime,
            location: slot.location || interview.location,
            interviewerCapacity: slot.interviewerCapacity,
            candidateCount: slot._count.signups,
            interviewers: slot.assignments.map((assignment) => ({
              id: assignment.id,
              role: assignment.role,
              user: assignment.user,
            })),
            yourAssignmentId:
              slot.assignments.find((assignment) => assignment.userId === req.user.id)?.id ?? null,
          })),
        })),
    });
  } catch (error) {
    fail(res, error, 'Failed to load interview slots');
  }
});

// POST /api/member/interview-slots/:id/claim
router.post('/interview-slots/:id/claim', async (req, res) => {
  try {
    if (!STAFF_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Member access required' });
    }
    const userId = req.user.id;
    const { id } = req.params;

    const result = await withSerializableTransaction(prisma, async (tx) => {
      const slot = await tx.interviewSlot.findUnique({
        where: { id },
        include: { interview: { select: { id: true, cycleId: true, status: true } } },
      });
      if (!slot) throw new SlotTransactionError(404, 'That session no longer exists');
      if (slot.interview.status === 'CANCELLED') {
        throw new SlotTransactionError(409, 'That interview has been cancelled');
      }

      const existing = await tx.interviewSlotAssignment.findFirst({
        where: { slotId: id, userId, removedAt: null },
        select: { id: true },
      });
      if (existing) throw new SlotTransactionError(409, 'You are already staffing this session');

      // A member cannot be in two rooms at once. Read inside the transaction so
      // two simultaneous claims for overlapping sessions cannot both succeed.
      const overlapping = await tx.interviewSlotAssignment.findFirst({
        where: {
          userId,
          removedAt: null,
          slot: {
            interview: { cycleId: slot.interview.cycleId },
            startTime: { lt: slot.endTime },
            endTime: { gt: slot.startTime },
          },
        },
        include: { slot: { select: { label: true, startTime: true } } },
      });
      if (overlapping) {
        throw new SlotTransactionError(409, 'You are already staffing a session that overlaps this one');
      }

      const staffed = await tx.interviewSlotAssignment.count({
        where: { slotId: id, removedAt: null },
      });

      const assignment = await tx.interviewSlotAssignment.create({
        data: { slotId: id, interviewId: slot.interviewId, userId },
        select: { id: true },
      });

      return {
        assignmentId: assignment.id,
        // Reported, not enforced: an extra interviewer is a good problem.
        overStaffed: slot.interviewerCapacity != null && staffed + 1 > slot.interviewerCapacity,
      };
    });

    res.status(201).json(result);
  } catch (error) {
    fail(res, error, 'Failed to sign up for that session');
  }
});

// DELETE /api/member/interview-slot-assignments/:id
router.delete('/interview-slot-assignments/:id', async (req, res) => {
  try {
    const assignment = await prisma.interviewSlotAssignment.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true, removedAt: true },
    });
    if (!assignment) return res.status(404).json({ error: 'That signup no longer exists' });

    // A member drops their own; an admin can drop anyone's.
    const isOwner = assignment.userId === req.user.id;
    if (!isOwner && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'That signup is not yours' });
    }
    if (assignment.removedAt) return res.json({ removed: true });

    await prisma.interviewSlotAssignment.update({
      where: { id: assignment.id },
      // Soft delete: who was meant to run a session, and who pulled out, is
      // worth keeping when an interview turns out to have been unstaffed.
      data: { removedAt: new Date(), removedBy: req.user.id },
    });
    res.json({ removed: true });
  } catch (error) {
    fail(res, error, 'Failed to cancel that signup');
  }
});

// GET /api/member/interviews/:id/availability
// What this member has already said, plus the sessions if any exist yet.
router.get('/interviews/:id/availability', async (req, res) => {
  try {
    if (!STAFF_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Member access required' });
    }
    const interview = await prisma.interview.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, title: true, interviewType: true, location: true, startDate: true, endDate: true,
        slots: {
          orderBy: { startTime: 'asc' },
          select: { id: true, label: true, startTime: true, endTime: true, interviewerCapacity: true },
        },
      },
    });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const windows = await prisma.interviewerAvailability.findMany({
      where: { interviewId: interview.id, userId: req.user.id },
      orderBy: { startTime: 'asc' },
    });
    const assignments = await prisma.interviewSlotAssignment.findMany({
      where: { interviewId: interview.id, userId: req.user.id, removedAt: null },
      select: { id: true, slotId: true },
    });

    res.json({ interview, windows, assignments });
  } catch (error) {
    fail(res, error, 'Failed to load your availability');
  }
});

// PUT /api/member/interviews/:id/availability   { windows: [{start, end, note}] }
//
// Replaces this member's windows wholesale. A form that says "here is when I am
// free" is a statement about the whole day, so merging it with what was said
// before would quietly keep a time somebody had just removed.
router.put('/interviews/:id/availability', async (req, res) => {
  try {
    if (!STAFF_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Member access required' });
    }
    const { id } = req.params;
    const interview = await prisma.interview.findUnique({ where: { id }, select: { id: true } });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const rows = [];
    for (const [index, window] of (req.body?.windows ?? []).entries()) {
      const startTime = new Date(window.startTime);
      const endTime = new Date(window.endTime);
      if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        return res.status(400).json({ error: `Window ${index + 1} has an invalid time` });
      }
      if (endTime <= startTime) {
        return res.status(400).json({ error: `Window ${index + 1} ends before it starts` });
      }
      rows.push({
        interviewId: id,
        userId: req.user.id,
        startTime,
        endTime,
        note: window.note?.trim() || null,
      });
    }

    await prisma.$transaction([
      prisma.interviewerAvailability.deleteMany({ where: { interviewId: id, userId: req.user.id } }),
      ...(rows.length ? [prisma.interviewerAvailability.createMany({ data: rows })] : []),
    ]);

    const windows = await prisma.interviewerAvailability.findMany({
      where: { interviewId: id, userId: req.user.id },
      orderBy: { startTime: 'asc' },
    });
    res.json({ windows });
  } catch (error) {
    fail(res, error, 'Failed to save your availability');
  }
});

export default router;
