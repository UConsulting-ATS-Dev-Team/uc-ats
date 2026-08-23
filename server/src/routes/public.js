import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth } from '../middleware/auth.js';
import { sendMeetingSignupConfirmation, sendMeetingSignupNotification, sendMeetingCancellationToMember } from '../services/emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from '../services/meetingComms.js';
import { toCandidateCard } from '../utils/gtkucProfile.js';

const router = express.Router();

// Public: list available meeting slots with remaining capacity and signups
router.get('/meeting-slots', async (req, res) => {
  try {
    const slots = await prisma.meetingSlot.findMany({
      orderBy: { startTime: 'asc' },
      include: {
        member: {
          select: {
            id: true,
            fullName: true,
            email: true,
            profileImage: true,
            graduationClass: true,
            gtkucProfile: true
          }
        },
        signups: {
          select: { id: true }
        }
      }
    });

    // Slots hosted by a member an admin hid from GTKUC are not offered at all.
    const visibleSlots = slots.filter(slot => !slot.member?.gtkucProfile?.hiddenFromGtkuc);

    const formatted = visibleSlots.map(slot => ({
      id: slot.id,
      memberName: slot.member?.fullName || 'Member',
      memberEmail: slot.member?.email || null,
      // Only candidate-visible, complete profiles are exposed; never employers.
      memberProfile: toCandidateCard(slot.member),
      location: slot.location,
      startTime: slot.startTime,
      endTime: slot.endTime,
      capacity: slot.capacity,
      taken: slot.signups.length,
      remaining: Math.max(0, slot.capacity - slot.signups.length)
    }));

    res.json(formatted);
  } catch (error) {
    console.error('[GET /api/meeting-slots]', error);
    res.status(500).json({ error: 'Failed to fetch meeting slots' });
  }
});

// Sign up for a meeting slot. Requires an account: identity comes from the
// authenticated user, not the request body, so candidates can't book on behalf
// of someone else. The /meet page stays public to browse; booking is gated.
router.post('/meeting-slots/:id/signup', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Identity is taken from the signed-in account. studentId falls back to the
    // request body only if the account doesn't have one on file.
    const fullName = req.user.fullName;
    const email = req.user.email;
    const studentId = req.user.studentId || (req.body?.studentId || '').trim() || null;

    if (!fullName || !email || !studentId) {
      return res.status(400).json({ error: 'Your account is missing a name, email, or student ID. Please complete your profile before signing up.' });
    }

    // Get the active recruiting cycle to check for cycle-specific signups
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });

    // Check if user has already signed up for a meeting slot in the current cycle
    if (activeCycle && (activeCycle.startDate || activeCycle.endDate)) {
      const cycleStartDate = activeCycle.startDate ? new Date(activeCycle.startDate) : null;
      const cycleEndDate = activeCycle.endDate ? new Date(activeCycle.endDate) : null;

      // Find existing signups for this email
      const existingSignups = await prisma.meetingSignup.findMany({
        where: { email },
        include: { slot: true }
      });

      // Check if any existing signup falls within the current cycle's date range
      const existingSignupInCycle = existingSignups.find(signup => {
        const slotDate = new Date(signup.slot.startTime);
        const isAfterStart = !cycleStartDate || slotDate >= cycleStartDate;
        const isBeforeEnd = !cycleEndDate || slotDate <= cycleEndDate;
        return isAfterStart && isBeforeEnd;
      });

      if (existingSignupInCycle) {
        return res.status(400).json({ 
          error: `You have already signed up for a meeting on ${new Date(existingSignupInCycle.slot.startTime).toLocaleDateString()}. You can only sign up for one meeting slot per cycle.` 
        });
      }
    } else {
      // If no active cycle or no date range, fall back to checking all signups
      // (for backwards compatibility)
      const existingSignup = await prisma.meetingSignup.findFirst({
        where: { email },
        include: { slot: true }
      });

      if (existingSignup) {
        return res.status(400).json({ 
          error: `You have already signed up for a meeting on ${new Date(existingSignup.slot.startTime).toLocaleDateString()}. You can only sign up for one meeting slot.` 
        });
      }
    }

    // Check if user exists in the system (has an account)
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    const slot = await prisma.meetingSlot.findUnique({
      where: { id },
      include: { 
        signups: true,
        member: {
          select: { fullName: true, email: true }
        }
      }
    });

    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    if (slot.signups.length >= slot.capacity) {
      return res.status(400).json({ error: 'This time slot is full' });
    }

    const signup = await prisma.meetingSignup.create({
      data: {
        slotId: id,
        fullName,
        email,
        studentId
      }
    });

    // Send confirmation email to candidate (and log the communication)
    await sendAndLogMeetingCommunication(
      () => sendMeetingSignupConfirmation(
        email,
        fullName,
        slot.member?.fullName || 'UC Consulting Member',
        slot.location,
        slot.startTime,
        slot.endTime
      ),
      {
        slotId: slot.id,
        signupId: signup.id,
        type: 'CONFIRMATION',
        recipient: email,
        subject: MEETING_COMM_SUBJECTS.CONFIRMATION,
      }
    );

    // Send notification email to member (and log the communication)
    if (slot.member?.email) {
      await sendAndLogMeetingCommunication(
        () => sendMeetingSignupNotification(
          slot.member.email,
          slot.member.fullName || 'UC Consulting Member',
          fullName,
          email,
          studentId,
          slot.location,
          slot.startTime,
          slot.endTime
        ),
        {
          slotId: slot.id,
          signupId: signup.id,
          type: 'HOST_NOTIFICATION',
          recipient: slot.member.email,
          subject: MEETING_COMM_SUBJECTS.HOST_NOTIFICATION(fullName),
        }
      );
    }

    res.json({ 
      success: true, 
      signup,
      needsAccount: !existingUser,
      message: existingUser 
        ? 'Successfully signed up! You will receive a confirmation email shortly.'
        : 'Successfully signed up! You will receive a confirmation email shortly. We recommend creating an account to track your application status.'
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'You are already signed up for this slot' });
    }
    console.error('[POST /api/meeting-slots/:id/signup]', error);
    res.status(500).json({ error: 'Failed to create signup' });
  }
});

// Authenticated: list the signed-in user's own meeting signups (matched by
// account email) with slot + host details, so the /meet page can show and
// cancel their booking.
router.get('/meeting-signups/mine', requireAuth, async (req, res) => {
  try {
    const signups = await prisma.meetingSignup.findMany({
      where: { email: { equals: req.user.email, mode: 'insensitive' } },
      include: {
        slot: {
          include: { member: { select: { fullName: true, email: true } } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(signups);
  } catch (error) {
    console.error('[GET /api/meeting-signups/mine]', error);
    res.status(500).json({ error: 'Failed to fetch your signups' });
  }
});

// Authenticated: cancel your own meeting signup. Notifies the host member that
// the spot reopened and logs the communication.
router.delete('/meeting-signups/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const signup = await prisma.meetingSignup.findUnique({
      where: { id },
      include: { slot: { include: { member: { select: { fullName: true, email: true } } } } }
    });

    if (!signup) {
      return res.status(404).json({ error: 'Signup not found' });
    }

    // Ownership: a user may only cancel a signup made under their own email.
    if (signup.email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).json({ error: 'You can only cancel your own signup' });
    }

    const memberName = signup.slot.member?.fullName || 'UC Consulting Member';

    // Notify the host member their slot spot reopened (and log it).
    if (signup.slot.member?.email) {
      await sendAndLogMeetingCommunication(
        () => sendMeetingCancellationToMember(
          signup.slot.member.email,
          memberName,
          signup.slot.location,
          signup.slot.startTime,
          signup.slot.endTime,
          { candidateName: signup.fullName }
        ),
        {
          slotId: signup.slotId,
          signupId: signup.id,
          type: 'CANCELLATION',
          recipient: signup.slot.member.email,
          subject: MEETING_COMM_SUBJECTS.CANCELLATION_TO_HOST,
        }
      );
    }

    await prisma.meetingSignup.delete({ where: { id } });

    res.json({ message: 'Your signup has been cancelled.' });
  } catch (error) {
    console.error('[DELETE /api/meeting-signups/:id]', error);
    res.status(500).json({ error: 'Failed to cancel signup' });
  }
});

// Get all active events for candidates with RSVP status
router.get('/events', async (req, res) => {
  try {
    const userEmail = req.query.userEmail; // Get user email from query parameter
    
    const events = await prisma.events.findMany({
      where: {
        showToCandidates: true // Only show events that are meant to be visible to candidates
      },
      include: {
        cycle: true,
        eventRsvp: {
          include: {
            candidate: true
          }
        },
        eventAttendance: {
          include: {
            candidate: true
          }
        }
      },
      orderBy: {
        eventStartDate: 'asc'
      }
    });

    // Filter to only show events from active cycles
    const activeEvents = events.filter(event => event.cycle?.isActive);

    // Find the user by email to get their studentId (if provided)
    let user = null;
    if (userEmail) {
      user = await prisma.user.findUnique({
        where: { email: userEmail }
      });
    }

    // Add RSVP and attendance status for each event
    const eventsWithStatus = activeEvents.map(event => {
      let hasRsvpd = false;
      let hasAttended = false;
      
      if (user && user.studentId) {
        // Check if user has RSVP'd by looking for a candidate with matching studentId
        hasRsvpd = event.eventRsvp.some(rsvp => 
          rsvp.candidate.studentId === user.studentId
        );
        
        // Check if user has attended by looking for a candidate with matching studentId
        hasAttended = event.eventAttendance.some(attendance => 
          attendance.candidate.studentId === user.studentId
        );
      }

      return {
        ...event,
        hasRsvpd,
        hasAttended,
        rsvpCount: event.eventRsvp.length,
        eventRsvp: undefined, // Remove the full RSVP data from response
        eventAttendance: undefined // Remove the full attendance data from response
      };
    });

    res.json(eventsWithStatus);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get all events from active cycle for member timeline (no candidate visibility filter)
router.get('/member/events', async (req, res) => {
  try {
    const events = await prisma.events.findMany({
      include: {
        cycle: true
      },
      orderBy: {
        eventStartDate: 'asc'
      }
    });

    // Filter to only show events from active cycles
    const activeEvents = events.filter(event => event.cycle?.isActive);

    // Ensure memberRsvpUrl is included in the response
    const eventsWithMemberRsvp = activeEvents.map(event => ({
      ...event,
      memberRsvpUrl: event.memberRsvpUrl || null
    }));

    res.json(eventsWithMemberRsvp);
  } catch (error) {
    console.error('Error fetching member events:', error);
    res.status(500).json({ error: 'Failed to fetch member events' });
  }
});

// Public: get active recruiting cycle (for filtering meeting slots by cycle)
router.get('/active-cycle', async (req, res) => {
  try {
    const active = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    res.json(active || null);
  } catch (error) {
    console.error('[GET /api/active-cycle]', error);
    res.json(null);
  }
});

export default router;
