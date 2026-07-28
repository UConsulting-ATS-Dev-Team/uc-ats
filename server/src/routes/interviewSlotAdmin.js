import express from 'express';
import prisma from '../prismaClient.js';
import { localInputToUTC } from '../utils/timezoneUtils.js';
import { sendInterviewSlotSignupConfirmation } from '../services/emailNotifications.js';

const router = express.Router({ mergeParams: true });

const SUPPORTED_INTERVIEW_TYPES = new Set(['COFFEE_CHAT', 'ROUND_ONE', 'ROUND_TWO']);

function parseSlotTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Explicit timezone offset or Z: parse as ISO
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d) ? null : d;
  }
  // datetime-local input, treat as America/Los_Angeles
  const normalized = trimmed.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    return localInputToUTC(normalized);
  }
  const d = new Date(trimmed);
  return isNaN(d) ? null : d;
}

function formatInterviewType(type) {
  return String(type || 'Interview')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function requireActiveInterviewSlotScope(interviewId) {
  const activeCycle = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
  if (!activeCycle) {
    const err = new Error('No active recruiting cycle');
    err.status = 400;
    throw err;
  }

  const interview = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!interview) {
    const err = new Error('Interview not found');
    err.status = 404;
    throw err;
  }

  if (!SUPPORTED_INTERVIEW_TYPES.has(interview.interviewType)) {
    const err = new Error(`Interview type ${interview.interviewType} does not support slot signups`);
    err.status = 400;
    throw err;
  }

  if (interview.cycleId !== activeCycle.id) {
    const err = new Error('Interview does not belong to the active cycle');
    err.status = 400;
    throw err;
  }

  return { activeCycle, interview };
}

async function findOverlappingSlot(txOrPrisma, interviewId, startTime, endTime, excludeId = null) {
  const where = {
    interviewId,
    AND: [{ startTime: { lt: endTime } }, { endTime: { gt: startTime } }],
  };
  if (excludeId) {
    where.id = { not: excludeId };
  }
  return txOrPrisma.interviewSlot.findFirst({ where });
}

function slotSignupCount(slot) {
  return (slot.signups || []).filter((s) => !s.removedAt).length;
}

// GET /admin/interviews/:id/slots - coverage view for a single interview
router.get('/:id/slots', async (req, res) => {
  try {
    const { id } = req.params;
    const { activeCycle, interview } = await requireActiveInterviewSlotScope(id);

    const slots = await prisma.interviewSlot.findMany({
      where: { interviewId: id },
      orderBy: { startTime: 'asc' },
      include: {
        signups: {
          where: { removedAt: null },
          include: {
            user: { select: { id: true, fullName: true, email: true } },
          },
          orderBy: { signedUpAt: 'asc' },
        },
        _count: {
          select: { signups: { where: { removedAt: null } } },
        },
      },
    });

    const result = {
      interview: {
        id: interview.id,
        title: interview.title,
        interviewType: interview.interviewType,
        cycleId: interview.cycleId,
      },
      activeCycle: { id: activeCycle.id, name: activeCycle.name },
      slots: slots.map((slot) => ({
        ...slot,
        remainingSeats: slot.capacity - (slot._count?.signups || 0),
      })),
    };

    res.json(result);
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id/slots]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to fetch interview slots' });
  }
});

// POST /admin/interviews/:id/slots - create one or more slots
router.post('/:id/slots', async (req, res) => {
  try {
    const { id } = req.params;
    await requireActiveInterviewSlotScope(id);

    const { slots: slotPayloads } = req.body || {};
    const payloads = Array.isArray(slotPayloads) ? slotPayloads : [req.body];
    if (payloads.length === 0 || !payloads[0]) {
      return res.status(400).json({ error: 'At least one slot is required' });
    }

    const created = [];
    for (const payload of payloads) {
      const { startTime, endTime, capacity } = payload || {};
      const start = parseSlotTime(startTime);
      const end = parseSlotTime(endTime);
      const cap = Number(capacity);

      if (!start || !end) {
        return res.status(400).json({ error: 'startTime and endTime are required and must be valid' });
      }
      if (end <= start) {
        return res.status(400).json({ error: 'endTime must be after startTime' });
      }
      if (!Number.isInteger(cap) || cap <= 0) {
        return res.status(400).json({ error: 'capacity must be a positive integer' });
      }

      const overlapping = await findOverlappingSlot(prisma, id, start, end);
      if (overlapping) {
        return res.status(409).json({ error: 'Slot overlaps with an existing time block for this interview' });
      }

      const slot = await prisma.interviewSlot.create({
        data: { interviewId: id, startTime: start, endTime: end, capacity: cap },
      });
      created.push(slot);
    }

    res.status(201).json({ slots: created, count: created.length });
  } catch (error) {
    console.error('[POST /api/admin/interviews/:id/slots]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create interview slots' });
  }
});

// PUT /admin/interviews/slots/:slotId - update a slot
router.put('/slots/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const { startTime, endTime, capacity } = req.body || {};

    const slot = await prisma.interviewSlot.findUnique({
      where: { id: slotId },
      include: {
        interview: true,
        signups: { where: { removedAt: null } },
      },
    });

    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    await requireActiveInterviewSlotScope(slot.interviewId);

    const activeSignups = slot.signups.filter((s) => !s.removedAt).length;
    const updateData = {};

    if (capacity !== undefined) {
      const cap = Number(capacity);
      if (!Number.isInteger(cap) || cap <= 0) {
        return res.status(400).json({ error: 'capacity must be a positive integer' });
      }
      if (cap < activeSignups) {
        return res.status(400).json({ error: 'capacity cannot be lower than the number of active signups' });
      }
      updateData.capacity = cap;
    }

    let start = slot.startTime;
    let end = slot.endTime;
    if (startTime !== undefined) {
      const parsed = parseSlotTime(startTime);
      if (!parsed) {
        return res.status(400).json({ error: 'startTime is invalid' });
      }
      start = parsed;
    }
    if (endTime !== undefined) {
      const parsed = parseSlotTime(endTime);
      if (!parsed) {
        return res.status(400).json({ error: 'endTime is invalid' });
      }
      end = parsed;
    }
    if (end <= start) {
      return res.status(400).json({ error: 'endTime must be after startTime' });
    }

    if (start.getTime() !== slot.startTime.getTime() || end.getTime() !== slot.endTime.getTime()) {
      const overlapping = await findOverlappingSlot(prisma, slot.interviewId, start, end, slotId);
      if (overlapping) {
        return res.status(409).json({ error: 'Updated slot overlaps with an existing time block' });
      }
      updateData.startTime = start;
      updateData.endTime = end;
    }

    const updated = await prisma.interviewSlot.update({
      where: { id: slotId },
      data: updateData,
    });

    res.json(updated);
  } catch (error) {
    console.error('[PUT /api/admin/interviews/slots/:slotId]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update interview slot' });
  }
});

// DELETE /admin/interviews/slots/:slotId - delete a slot and cascade signups
router.delete('/slots/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const slot = await prisma.interviewSlot.findUnique({
      where: { id: slotId },
      include: { interview: true },
    });

    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    await requireActiveInterviewSlotScope(slot.interviewId);

    await prisma.interviewSlot.delete({ where: { id: slotId } });
    res.json({ message: 'Slot deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/admin/interviews/slots/:slotId]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete interview slot' });
  }
});

// DELETE /admin/interviews/signups/:signupId - remove a member from a slot (soft delete)
router.delete('/signups/:signupId', async (req, res) => {
  try {
    const { signupId } = req.params;
    const adminId = req.user?.id;

    const signup = await prisma.interviewSlotSignup.findUnique({
      where: { id: signupId },
      include: {
        slot: { include: { interview: true } },
        user: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!signup || signup.removedAt) {
      return res.status(404).json({ error: 'Signup not found or already removed' });
    }

    await requireActiveInterviewSlotScope(signup.slot.interviewId);

    const removedAt = new Date();
    const updated = await prisma.interviewSlotSignup.update({
      where: { id: signupId },
      data: { removedAt, removedBy: adminId },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        slot: true,
      },
    });

    res.json({
      message: 'Signup removed successfully',
      signup: updated,
      removedBy: adminId,
      removedAt,
    });
  } catch (error) {
    console.error('[DELETE /api/admin/interviews/signups/:signupId]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to remove signup' });
  }
});

// POST /admin/interviews/signups/:signupId/retry-confirmation - resend confirmation email
router.post('/signups/:signupId/retry-confirmation', async (req, res) => {
  try {
    const { signupId } = req.params;

    const signup = await prisma.interviewSlotSignup.findUnique({
      where: { id: signupId },
      include: {
        user: { select: { fullName: true, email: true } },
        slot: { include: { interview: { select: { title: true, interviewType: true } } } },
      },
    });

    if (!signup || signup.removedAt) {
      return res.status(404).json({ error: 'Signup not found or already removed' });
    }

    await requireActiveInterviewSlotScope(signup.slot.interviewId);

    const emailResult = await sendInterviewSlotSignupConfirmation(
      signup.user.email,
      signup.user.fullName,
      signup.slot.interview.title,
      signup.slot.interview.interviewType,
      signup.slot.startTime,
      signup.slot.endTime
    );

    const updated = await prisma.interviewSlotSignup.update({
      where: { id: signupId },
      data: {
        confirmationStatus: emailResult.success ? 'SENT' : 'FAILED',
        confirmationError: emailResult.success ? null : emailResult.error,
        confirmationSentAt: emailResult.success ? new Date() : null,
      },
    });

    res.json({ signup: updated, emailResult });
  } catch (error) {
    console.error('[POST /api/admin/interviews/signups/:signupId/retry-confirmation]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to retry confirmation email' });
  }
});

export default router;
