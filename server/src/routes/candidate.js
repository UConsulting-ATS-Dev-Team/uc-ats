import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth } from '../middleware/auth.js';
import {
  sendMeetingSignupConfirmation,
  sendMeetingSignupNotification,
  sendMeetingCancellationEmail,
  sendMeetingCancellationToMember,
} from '../services/emailNotifications.js';
import { toCandidateCard } from '../utils/gtkucProfile.js';
// Candidate-facing: always the candidate pointer, never the caller's role.
import { resolveCandidateCycle } from '../services/activeCycle.js';

const router = express.Router();

// A candidate may cancel or rebook their GTKUC slot only up to this many hours
// before the slot start time. Inside this window, the booking is locked.
const MODIFY_CUTOFF_HOURS = 12;

const hoursUntil = (startTime) => (new Date(startTime).getTime() - Date.now()) / (1000 * 60 * 60);

// GET /api/my-meeting-signups
// Returns the logged-in candidate's upcoming GTKUC signups. Intentionally returns
// only the member name plus date/time/location — never the other candidates on the
// shared slot or the slot's capacity.
router.get('/my-meeting-signups', requireAuth, async (req, res) => {
  try {
    const signups = await prisma.meetingSignup.findMany({
      where: { email: req.user.email },
      include: {
        slot: {
          include: {
            member: {
              select: {
                fullName: true,
                profileImage: true,
                graduationClass: true,
                gtkucProfile: true,
              },
            },
          },
        },
      },
    });

    const now = Date.now();
    const upcoming = signups
      .filter((signup) => new Date(signup.slot.startTime).getTime() >= now)
      .sort((a, b) => new Date(a.slot.startTime) - new Date(b.slot.startTime))
      .map((signup) => ({
        id: signup.id,
        memberName: signup.slot.member?.fullName || 'UC Consulting Member',
        memberProfile: toCandidateCard(signup.slot.member),
        location: signup.slot.location,
        startTime: signup.slot.startTime,
        endTime: signup.slot.endTime,
        canModify: hoursUntil(signup.slot.startTime) >= MODIFY_CUTOFF_HOURS,
      }));

    res.json(upcoming);
  } catch (error) {
    console.error('[GET /api/my-meeting-signups]', error);
    res.status(500).json({ error: 'Failed to fetch your meeting signups' });
  }
});

// POST /api/my-meeting-signups
// Book a slot as the logged-in candidate. Identity is derived from req.user, never
// from the request body. Used for both initial booking and rebooking.
router.post('/my-meeting-signups', requireAuth, async (req, res) => {
  try {
    const { slotId } = req.body || {};
    if (!slotId) {
      return res.status(400).json({ error: 'A slot is required' });
    }

    const { fullName, email, studentId } = req.user;
    if (!studentId) {
      return res.status(400).json({ error: 'Your account is missing a student ID. Please contact us to update your profile.' });
    }

    // Enforce one signup per active recruiting cycle (mirrors public signup route).
    const activeCycle = await resolveCandidateCycle(prisma);

    if (activeCycle && (activeCycle.startDate || activeCycle.endDate)) {
      const cycleStartDate = activeCycle.startDate ? new Date(activeCycle.startDate) : null;
      const cycleEndDate = activeCycle.endDate ? new Date(activeCycle.endDate) : null;

      const existingSignups = await prisma.meetingSignup.findMany({
        where: { email },
        include: { slot: true },
      });

      const existingSignupInCycle = existingSignups.find((signup) => {
        const slotDate = new Date(signup.slot.startTime);
        const isAfterStart = !cycleStartDate || slotDate >= cycleStartDate;
        const isBeforeEnd = !cycleEndDate || slotDate <= cycleEndDate;
        return isAfterStart && isBeforeEnd;
      });

      if (existingSignupInCycle) {
        return res.status(400).json({
          error: `You have already signed up for a meeting on ${new Date(existingSignupInCycle.slot.startTime).toLocaleDateString()}. You can only sign up for one meeting slot per cycle.`,
        });
      }
    } else {
      const existingSignup = await prisma.meetingSignup.findFirst({
        where: { email },
        include: { slot: true },
      });

      if (existingSignup) {
        return res.status(400).json({
          error: `You have already signed up for a meeting on ${new Date(existingSignup.slot.startTime).toLocaleDateString()}. You can only sign up for one meeting slot.`,
        });
      }
    }

    const slot = await prisma.meetingSlot.findUnique({
      where: { id: slotId },
      include: {
        signups: true,
        member: { select: { fullName: true, email: true } },
      },
    });

    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    if (slot.signups.length >= slot.capacity) {
      return res.status(400).json({ error: 'This time slot is full' });
    }

    const signup = await prisma.meetingSignup.create({
      data: { slotId, fullName, email, studentId },
    });

    // Confirmation email to candidate.
    try {
      await sendMeetingSignupConfirmation(
        email,
        fullName,
        slot.member?.fullName || 'UC Consulting Member',
        slot.location,
        slot.startTime,
        slot.endTime
      );
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }

    // Notification email to member.
    try {
      if (slot.member?.email) {
        await sendMeetingSignupNotification(
          slot.member.email,
          slot.member.fullName || 'UC Consulting Member',
          fullName,
          email,
          studentId,
          slot.location,
          slot.startTime,
          slot.endTime
        );
      }
    } catch (emailError) {
      console.error('Failed to send notification email to member:', emailError);
    }

    res.json({ success: true, signup, message: 'Successfully signed up! You will receive a confirmation email shortly.' });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'You are already signed up for this slot' });
    }
    console.error('[POST /api/my-meeting-signups]', error);
    res.status(500).json({ error: 'Failed to create signup' });
  }
});

// DELETE /api/my-meeting-signups/:id
// Cancel the logged-in candidate's own signup, enforcing the 12-hour cutoff.
router.delete('/my-meeting-signups/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const signup = await prisma.meetingSignup.findUnique({
      where: { id },
      include: {
        slot: {
          include: { member: { select: { fullName: true, email: true } } },
        },
      },
    });

    if (!signup) {
      return res.status(404).json({ error: 'Signup not found' });
    }

    // Ownership: candidates may only cancel their own signup.
    if (signup.email !== req.user.email) {
      return res.status(403).json({ error: 'You can only cancel your own signup' });
    }

    // Cutoff: cannot modify within MODIFY_CUTOFF_HOURS of the slot start.
    if (hoursUntil(signup.slot.startTime) < MODIFY_CUTOFF_HOURS) {
      return res.status(400).json({
        error: `Meetings can no longer be changed within ${MODIFY_CUTOFF_HOURS} hours of the start time.`,
      });
    }

    await prisma.meetingSignup.delete({ where: { id } });

    const memberName = signup.slot.member?.fullName || 'UC Consulting Member';

    // Notify the candidate their meeting is cancelled.
    try {
      await sendMeetingCancellationEmail(
        signup.email,
        signup.fullName,
        memberName,
        signup.slot.location,
        signup.slot.startTime,
        signup.slot.endTime
      );
    } catch (emailError) {
      console.error('Failed to send cancellation email to candidate:', emailError);
    }

    // Notify the member the slot opened back up.
    try {
      if (signup.slot.member?.email) {
        await sendMeetingCancellationToMember(
          signup.slot.member.email,
          memberName,
          signup.slot.location,
          signup.slot.startTime,
          signup.slot.endTime,
          { candidateName: signup.fullName }
        );
      }
    } catch (emailError) {
      console.error('Failed to send cancellation notification to member:', emailError);
    }

    res.json({ success: true, message: 'Your meeting has been cancelled.' });
  } catch (error) {
    console.error('[DELETE /api/my-meeting-signups/:id]', error);
    res.status(500).json({ error: 'Failed to cancel signup' });
  }
});

export default router;
