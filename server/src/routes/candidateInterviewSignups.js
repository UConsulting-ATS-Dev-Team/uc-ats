// Candidate self-service interview scheduling.
//
// Replaces a shared Google Sheet that candidates raced to edit the moment a
// decision email landed. The race is not really gone - first come still gets the
// slot - but losing it is now harmless: a candidate whose first choice is full
// is booked into the other block immediately and queued for the one they wanted,
// so nobody ends up unscheduled and nobody has to email recruitment to find out
// where they stand.
//
// Identity comes from the JWT and only from the JWT. Nothing here reads a
// candidate identifier out of the request body, so a candidate cannot book,
// move or cancel on behalf of anyone else.
//
// Note on sealed records: lockedRecords.js deliberately does not apply here. Its
// contract is scores, evaluations and comments - evaluation data. A scheduling
// row is not that, and sealing someone's record must not leave them unable to
// book the interview the seal was created for.

import express from 'express';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCandidate } from '../middleware/requireCandidate.js';
import { resolveCandidateCycle } from '../services/activeCycle.js';
import {
  AmbiguousApplicationError,
  findOwnApplication,
} from '../utils/applicationOwnership.js';
import { MODIFY_CUTOFF_HOURS, canModify } from '../utils/schedulingWindows.js';
import { interviewTypesForRound } from '../utils/interviewRounds.js';
import { isCandidateBookable, seatsRemaining } from '../services/interviewSignupPolicy.js';
import { cancelSignup, claimWithFallback, moveSignup } from '../services/interviewSignups.js';
import {
  SLOT_NOTIFICATION_SUBJECTS,
  flushNotifications,
  queueNotifications,
} from '../services/interviewSlotComms.js';
import { renderInterviewSlotEmail } from '../services/emailNotifications.js';

const router = express.Router();
router.use(requireAuth, requireCandidate);

const signupPageUrl = `${config.clientUrl}/interview-signup`;

const renderBody = (notification) =>
  renderInterviewSlotEmail(notification, { ctaUrl: signupPageUrl });

/** Translate a thrown service error into a response without leaking internals. */
function respondToError(res, error, fallbackMessage) {
  if (error instanceof AmbiguousApplicationError) {
    return res.status(409).json({
      error:
        'We found more than one application under your details, so we cannot tell which one to book. Please contact recruitment.',
      code: 'AMBIGUOUS_APPLICATION',
    });
  }
  if (error?.status && error?.message) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[candidateInterviewSignups]', error);
  return res.status(500).json({ error: fallbackMessage });
}

/** The caller's application in the candidate-facing cycle, or a 404-ish null. */
async function resolveOwnApplication(req) {
  const cycle = await resolveCandidateCycle();
  if (!cycle) return { cycle: null, application: null };
  const application = await findOwnApplication(prisma, req.user, cycle.id);
  return { cycle, application };
}

/**
 * Shape one slot for a candidate.
 *
 * Deliberately never includes who else is in it. A seat count is necessary -
 * first-come-first-served is unusable if you cannot see what is left - but the
 * roster is not the candidate's business, the same rule the GTKUC endpoints follow.
 */
const toCandidateSlot = (slot, confirmedCount, ownSignup, now) => ({
  id: slot.id,
  label: slot.label,
  startTime: slot.startTime,
  endTime: slot.endTime,
  location: slot.location,
  capacity: slot.candidateCapacity,
  seatsRemaining: Math.max(0, seatsRemaining(slot, confirmedCount) ?? 0),
  isFull: (seatsRemaining(slot, confirmedCount) ?? 0) <= 0,
  isOpen: isCandidateBookable(slot, now),
  yourStatus: ownSignup?.slotId === slot.id ? ownSignup.status : null,
});

// GET /api/my-interview-signups
// Where the caller currently stands: their seat, their waitlist entry, and
// whether they can still change it.
router.get('/', async (req, res) => {
  try {
    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle || !application) return res.json({ signups: [], modifyCutoffHours: MODIFY_CUTOFF_HOURS });

    const signups = await prisma.interviewSlotSignup.findMany({
      where: {
        applicationId: application.id,
        status: { in: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'] },
      },
      include: {
        slot: { include: { interview: { select: { id: true, title: true, interviewType: true, location: true } } } },
      },
      orderBy: { signedUpAt: 'asc' },
    });

    res.json({
      modifyCutoffHours: MODIFY_CUTOFF_HOURS,
      signups: signups.map((signup) => ({
        id: signup.id,
        status: signup.status,
        interview: signup.slot.interview,
        slot: {
          id: signup.slot.id,
          label: signup.slot.label,
          startTime: signup.slot.startTime,
          endTime: signup.slot.endTime,
          location: signup.slot.location || signup.slot.interview.location,
        },
        // Computed here rather than in the page, so one rule governs both the
        // button state and what the server will actually allow.
        canModify: canModify(signup.slot.startTime),
      })),
    });
  } catch (error) {
    respondToError(res, error, 'Failed to load your interview times');
  }
});

// GET /api/my-interview-signups/options
// The slots this candidate is eligible to book, by interview.
router.get('/options', async (req, res) => {
  try {
    const now = new Date();
    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle || !application) return res.json({ interviews: [] });

    // Eligibility is the round the candidate is sitting in, mapped to the
    // interview types that serve it - a candidate in round 3 books a ROUND_ONE
    // interview, never a coffee chat they have already passed.
    const eligibleTypes = interviewTypesForRound(application.currentRound);
    if (eligibleTypes.length === 0) return res.json({ interviews: [] });

    const interviews = await prisma.interview.findMany({
      where: {
        cycleId: cycle.id,
        interviewType: { in: eligibleTypes },
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
      },
      orderBy: { startDate: 'asc' },
      include: { slots: { orderBy: { startTime: 'asc' } } },
    });

    const slotIds = interviews.flatMap((i) => i.slots.map((s) => s.id));
    const counts = await prisma.interviewSlotSignup.groupBy({
      by: ['slotId'],
      where: { slotId: { in: slotIds }, status: 'CONFIRMED' },
      _count: { _all: true },
    });
    const confirmedBySlot = new Map(counts.map((row) => [row.slotId, row._count._all]));

    const own = await prisma.interviewSlotSignup.findMany({
      where: {
        applicationId: application.id,
        status: { in: ['CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT'] },
      },
      select: { id: true, slotId: true, interviewId: true, status: true },
    });
    const ownByInterview = new Map(own.map((row) => [row.interviewId, row]));

    res.json({
      modifyCutoffHours: MODIFY_CUTOFF_HOURS,
      interviews: interviews
        .filter((interview) => interview.slots.some((slot) => slot.candidateCapacity != null))
        .map((interview) => ({
          id: interview.id,
          title: interview.title,
          interviewType: interview.interviewType,
          location: interview.location,
          yourSignup: ownByInterview.get(interview.id) ?? null,
          slots: interview.slots
            .filter((slot) => slot.candidateCapacity != null)
            .map((slot) =>
              toCandidateSlot(slot, confirmedBySlot.get(slot.id) ?? 0, ownByInterview.get(interview.id), now)
            ),
        })),
    });
  } catch (error) {
    respondToError(res, error, 'Failed to load available interview times');
  }
});

// POST /api/my-interview-signups  { slotId }
// Claim a slot, with automatic fallback and waitlisting.
router.post('/', async (req, res) => {
  try {
    const { slotId } = req.body ?? {};
    if (!slotId) return res.status(400).json({ error: 'A time slot is required' });

    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle) return res.status(409).json({ error: 'There is no open recruiting cycle' });
    if (!application) return res.status(404).json({ error: 'We could not find your application' });

    const result = await claimWithFallback({
      applicationId: application.id,
      slotId,
      cycleId: cycle.id,
    });

    const notificationIds = await queueForClaim(result, application);
    // Fired after the transaction has committed. The seat is real whether or not
    // the mail lands, and an unsent notification is visible to admins.
    flushNotifications(notificationIds, renderBody).catch((e) =>
      console.error('[POST /my-interview-signups] flush failed', e)
    );

    res.status(201).json(describeClaim(result));
  } catch (error) {
    respondToError(res, error, 'Failed to book that time slot');
  }
});

// PATCH /api/my-interview-signups/:id  { slotId }
// Switch to a different time, atomically - never cancel-then-rebook.
router.patch('/:id', async (req, res) => {
  try {
    const { slotId } = req.body ?? {};
    if (!slotId) return res.status(400).json({ error: 'A time slot is required' });

    const { application } = await resolveOwnApplication(req);
    if (!application) return res.status(404).json({ error: 'We could not find your application' });

    const owned = await prisma.interviewSlotSignup.findFirst({
      where: { id: req.params.id, applicationId: application.id },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'That booking is not yours' });

    const result = await moveSignup({ signupId: req.params.id, toSlotId: slotId });
    const ids = await queueForPromotions(result.promotions, result.moved?.id);
    flushNotifications(ids, renderBody).catch((e) => console.error('[PATCH] flush failed', e));

    res.json({ status: 'CONFIRMED', signupId: result.moved.id });
  } catch (error) {
    respondToError(res, error, 'Failed to change your time slot');
  }
});

// DELETE /api/my-interview-signups/:id
router.delete('/:id', async (req, res) => {
  try {
    const { application } = await resolveOwnApplication(req);
    if (!application) return res.status(404).json({ error: 'We could not find your application' });

    const owned = await prisma.interviewSlotSignup.findFirst({
      where: { id: req.params.id, applicationId: application.id },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'That booking is not yours' });

    const result = await cancelSignup({ signupId: req.params.id, actorId: null });
    const ids = await queueForPromotions(result.promotions, null);
    flushNotifications(ids, renderBody).catch((e) => console.error('[DELETE] flush failed', e));

    res.json({ cancelled: true, promoted: result.promotions.length });
  } catch (error) {
    respondToError(res, error, 'Failed to cancel that booking');
  }
});

// ---------------------------------------------------------------------------
// Notification planning. Queued in their own short transaction after the
// booking has committed - never inside it, because a serialisation retry would
// re-run the body and queue the same email twice.
// ---------------------------------------------------------------------------

async function queueForClaim(result, application) {
  const recipient = application.email ?? null;
  const interviewTitle = result.interview?.title ?? 'your interview';

  const entries = [];
  if (result.outcome === 'CONFIRMED') {
    entries.push({
      slotId: result.confirmed.slotId,
      signupId: result.confirmed.id,
      type: 'CONFIRMATION',
      recipient,
      subject: SLOT_NOTIFICATION_SUBJECTS.CONFIRMATION(interviewTitle),
    });
  } else if (result.outcome === 'WAITLISTED') {
    // One email describing both halves, not two arriving together - two sends
    // 200ms apart reads as a bug to the person receiving them.
    entries.push({
      slotId: result.confirmed.slotId,
      signupId: result.waitlisted.id,
      type: 'WAITLIST_ADDED',
      recipient,
      subject: SLOT_NOTIFICATION_SUBJECTS.WAITLIST_ADDED(interviewTitle),
    });
  } else if (result.outcome === 'NEEDS_PLACEMENT') {
    entries.push({
      slotId: result.needsPlacement.slotId,
      signupId: result.needsPlacement.id,
      type: 'ADMIN_OVERFLOW_ALERT',
      recipient: config.recruitmentEmail,
      subject: SLOT_NOTIFICATION_SUBJECTS.ADMIN_OVERFLOW_ALERT(interviewTitle),
    });
  }

  if (entries.length === 0) return [];
  return prisma.$transaction((tx) => queueNotifications(tx, entries));
}

/** Emails owed to anyone the cascade moved. */
async function queueForPromotions(promotions, movedSignupId) {
  if (!promotions?.length && !movedSignupId) return [];

  const rows = await prisma.interviewSlotSignup.findMany({
    where: { id: { in: promotions.map((p) => p.signupId) } },
    include: {
      application: { select: { email: true } },
      slot: { include: { interview: { select: { title: true } } } },
    },
  });

  const entries = rows.map((row) => ({
    slotId: row.slotId,
    signupId: row.id,
    type: 'PROMOTED',
    recipient: row.application?.email,
    subject: SLOT_NOTIFICATION_SUBJECTS.PROMOTED(row.slot.interview.title),
  }));

  if (entries.length === 0) return [];
  return prisma.$transaction((tx) => queueNotifications(tx, entries));
}

const describeClaim = (result) => {
  if (result.outcome === 'CONFIRMED') {
    return { outcome: 'CONFIRMED', signupId: result.confirmed.id, slotId: result.confirmed.slotId };
  }
  if (result.outcome === 'WAITLISTED') {
    return {
      outcome: 'WAITLISTED',
      signupId: result.waitlisted.id,
      waitlistedForSlotId: result.waitlisted.slotId,
      holdingSeatInSlotId: result.confirmed.slotId,
      message:
        'That session was full, so we booked you into the next available one and added you to the waitlist for your first choice. ' +
        'If a spot opens up we will move you automatically.',
    };
  }
  return {
    outcome: 'NEEDS_PLACEMENT',
    signupId: result.needsPlacement.id,
    message:
      'Every session is currently full. We have notified recruitment and someone will be in touch shortly to find you a spot.',
  };
};

export default router;
