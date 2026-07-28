import express from 'express';
import prisma from '../prismaClient.js';
import { localInputToUTC } from '../utils/timezoneUtils.js';
import { sendInterviewSlotSignupConfirmation } from '../services/emailNotifications.js';
import { requireAuth } from '../middleware/auth.js';
import {
  withSerializableTransaction,
  SlotTransactionError,
} from '../utils/withSerializableTransaction.js';

const router = express.Router({ mergeParams: true });

const SUPPORTED_INTERVIEW_TYPES = new Set(['COFFEE_CHAT', 'ROUND_ONE', 'ROUND_TWO']);
const ALLOWED_SIGNUP_ROLES = new Set(['MEMBER', 'ADMIN']);

function parseSlotTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d) ? null : d;
  }
  const normalized = trimmed.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    return localInputToUTC(normalized);
  }
  const d = new Date(trimmed);
  return isNaN(d) ? null : d;
}

async function getActiveCycleAndSlot(slotId) {
  const activeCycle = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
  if (!activeCycle) {
    const err = new Error('No active recruiting cycle');
    err.status = 400;
    throw err;
  }

  const slot = await prisma.interviewSlot.findUnique({
    where: { id: slotId },
    include: { interview: true },
  });

  if (!slot) {
    const err = new Error('Slot not found');
    err.status = 404;
    throw err;
  }

  if (!SUPPORTED_INTERVIEW_TYPES.has(slot.interview.interviewType)) {
    const err = new Error('This interview round is not open for member signups');
    err.status = 400;
    throw err;
  }

  if (slot.interview.cycleId !== activeCycle.id) {
    const err = new Error('Slot does not belong to the active cycle');
    err.status = 400;
    throw err;
  }

  return { activeCycle, slot };
}

// GET /member/interviews/slots - list active cycle slots grouped by interview
router.get('/slots', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const activeCycle = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!activeCycle) {
      return res.json({ activeCycle: null, groups: [] });
    }

    const interviews = await prisma.interview.findMany({
      where: {
        cycleId: activeCycle.id,
        interviewType: { in: Array.from(SUPPORTED_INTERVIEW_TYPES) },
      },
      orderBy: { startDate: 'asc' },
      include: {
        slots: {
          orderBy: { startTime: 'asc' },
          include: {
            signups: {
              where: { removedAt: null },
              include: {
                user: { select: { id: true, fullName: true, email: true } },
              },
            },
            _count: {
              select: { signups: { where: { removedAt: null } } },
            },
          },
        },
      },
    });

    const groups = interviews.map((interview) => ({
      interview: {
        id: interview.id,
        title: interview.title,
        interviewType: interview.interviewType,
        startDate: interview.startDate,
        endDate: interview.endDate,
      },
      slots: interview.slots.map((slot) => {
        const signupCount = slot._count?.signups || 0;
        const remainingSeats = slot.capacity - signupCount;
        const userSignup = slot.signups.find((s) => s.userId === userId) || null;
        return {
          id: slot.id,
          startTime: slot.startTime,
          endTime: slot.endTime,
          capacity: slot.capacity,
          remainingSeats,
          isFull: remainingSeats <= 0,
          userSignup,
          signups: slot.signups,
        };
      }),
    }));

    res.json({ activeCycle: { id: activeCycle.id, name: activeCycle.name }, groups });
  } catch (error) {
    console.error('[GET /api/member/interviews/slots]', error);
    res.status(500).json({ error: 'Failed to fetch interview slots' });
  }
});

// POST /member/interviews/slots/:id/signup - sign up for a slot
router.post('/slots/:id/signup', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!ALLOWED_SIGNUP_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'Member or admin access required to sign up' });
    }

    const { activeCycle, slot } = await getActiveCycleAndSlot(id);
    const interview = slot.interview;

    let signup;
    try {
      signup = await withSerializableTransaction(
        prisma,
        async (tx) => {
          const slotForUpdate = await tx.interviewSlot.findUnique({
            where: { id },
            include: { interview: true },
          });

          if (!slotForUpdate) {
            throw new SlotTransactionError(404, 'Slot not found');
          }

          if (slotForUpdate.interview.cycleId !== activeCycle.id) {
            throw new SlotTransactionError(400, 'Slot does not belong to the active cycle');
          }

          const activeSignups = await tx.interviewSlotSignup.count({
            where: { slotId: id, removedAt: null },
          });
          if (activeSignups >= slotForUpdate.capacity) {
            throw new SlotTransactionError(409, 'This slot is full');
          }

          const overlapping = await tx.interviewSlotSignup.findFirst({
            where: {
              userId,
              removedAt: null,
              slot: {
                interview: { cycleId: activeCycle.id },
                startTime: { lt: slotForUpdate.endTime },
                endTime: { gt: slotForUpdate.startTime },
              },
            },
            include: { slot: true },
          });

          if (overlapping) {
            throw new SlotTransactionError(409, 'You already have a slot that overlaps this time');
          }

          return tx.interviewSlotSignup.create({
            data: { slotId: id, userId },
            include: {
              user: { select: { id: true, fullName: true, email: true } },
              slot: { include: { interview: { select: { title: true, interviewType: true } } } },
            },
          });
        },
        { maxRetries: 3, baseDelayMs: 50 }
      );
    } catch (error) {
      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'You are already signed up for this slot' });
      }
      if (error instanceof SlotTransactionError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    // Send confirmation outside of the transaction
    const emailResult = await sendInterviewSlotSignupConfirmation(
      signup.user.email,
      signup.user.fullName,
      signup.slot.interview.title,
      signup.slot.interview.interviewType,
      slot.startTime,
      slot.endTime
    );

    const updatedSignup = await prisma.interviewSlotSignup.update({
      where: { id: signup.id },
      data: {
        confirmationStatus: emailResult.success ? 'SENT' : 'FAILED',
        confirmationError: emailResult.success ? null : emailResult.error,
        confirmationSentAt: emailResult.success ? new Date() : null,
      },
      include: {
        slot: { include: { interview: { select: { title: true, interviewType: true } } } },
        user: { select: { id: true, fullName: true, email: true } },
      },
    });

    res.status(201).json({ signup: updatedSignup, emailResult });
  } catch (error) {
    console.error('[POST /api/member/interviews/slots/:id/signup]', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to sign up for slot' });
  }
});

// DELETE /member/interviews/signups/:id - cancel own signup
router.delete('/signups/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const signup = await prisma.interviewSlotSignup.findUnique({
      where: { id },
      include: { slot: true },
    });

    if (!signup || signup.removedAt) {
      return res.status(404).json({ error: 'Signup not found' });
    }

    if (signup.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to cancel this signup' });
    }

    await prisma.interviewSlotSignup.delete({ where: { id } });
    res.json({ message: 'Signup cancelled successfully' });
  } catch (error) {
    console.error('[DELETE /api/member/interviews/signups/:id]', error);
    res.status(500).json({ error: 'Failed to cancel signup' });
  }
});

export default router;
