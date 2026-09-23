import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth } from '../middleware/auth.js';
import {
  BookingError,
  bookMeetingSlot,
  cancelOwnMeetingSignup,
  notifyMeetingBooked,
  notifyMeetingCancelled,
} from '../services/meetingSignups.js';
import { toCandidateCard } from '../utils/gtkucProfile.js';
// A candidate may cancel or rebook only up to MODIFY_CUTOFF_HOURS before the
// start time. Shared with interview slot signup so there is one rule, not two.
import { MODIFY_CUTOFF_HOURS, canModify } from '../utils/schedulingWindows.js';

const router = express.Router();

// GET /api/my-meeting-signups
// Returns the logged-in candidate's upcoming GTKUC signups. Intentionally returns
// only the member name plus date/time/location — never the other candidates on the
// shared slot or the slot's capacity.
router.get('/my-meeting-signups', requireAuth, async (req, res) => {
  try {
    const signups = await prisma.meetingSignup.findMany({
      where: { email: { equals: req.user.email, mode: 'insensitive' } },
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
        canModify: canModify(signup.slot.startTime),
        // Sent so the page can render the rule instead of hardcoding its own copy.
        modifyCutoffHours: MODIFY_CUTOFF_HOURS,
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

    const { signup, slot } = await bookMeetingSlot({ slotId, fullName, email, studentId });
    await notifyMeetingBooked({ signup, slot });

    res.json({ success: true, signup, message: 'Successfully signed up! You will receive a confirmation email shortly.' });
  } catch (error) {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
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
    // Locked, owner- and cutoff-checked in the service, so it cannot interleave
    // with a move of the same booking.
    const signup = await cancelOwnMeetingSignup({ signupId: req.params.id, account: req.user });
    await notifyMeetingCancelled({ signup });
    res.json({ success: true, message: 'Your meeting has been cancelled.' });
  } catch (error) {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('[DELETE /api/my-meeting-signups/:id]', error);
    res.status(500).json({ error: 'Failed to cancel signup' });
  }
});

export default router;
