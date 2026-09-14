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
import { MODIFY_CUTOFF_HOURS } from '../utils/schedulingWindows.js';
import { checkCanBookSlot, getBookingOptions, getOwnSignups } from '../services/candidateSchedulingView.js';
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
  const cycle = await resolveCandidateCycle(prisma);
  if (!cycle) return { cycle: null, application: null };
  const application = await findOwnApplication(prisma, req.user, cycle.id);
  return { cycle, application };
}

// GET /api/my-interview-signups
// Where the caller currently stands, and what they can book. Both answers come
// from services/candidateSchedulingView.js, which the admin preview also calls -
// so what an admin is shown is literally what the candidate is served.
router.get('/', async (req, res) => {
  try {
    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle || !application) return res.json({ signups: [], modifyCutoffHours: MODIFY_CUTOFF_HOURS });
    res.json(await getOwnSignups(application.id));
  } catch (error) {
    respondToError(res, error, 'Failed to load your interview times');
  }
});

// GET /api/my-interview-signups/options
router.get('/options', async (req, res) => {
  try {
    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle || !application) return res.json({ interviews: [] });
    res.json(await getBookingOptions(application, cycle.id));
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
    // The page only offers times for the round they are in, but the slotId
    // arrives in the request body - so the round has to be enforced here, not
    // just displayed. A stale tab, a replayed request or a guessed id all land
    // on this line.
    const denied = await checkCanBookSlot(application, slotId, cycle.id);
    if (denied) return res.status(denied.status).json({ error: denied.error });

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

    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle) return res.status(409).json({ error: 'There is no open recruiting cycle' });
    if (!application) return res.status(404).json({ error: 'We could not find your application' });

    const owned = await prisma.interviewSlotSignup.findFirst({
      where: { id: req.params.id, applicationId: application.id },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'That booking is not yours' });

    // Switching times is booking a different slot, so it gets the same guard.
    const denied = await checkCanBookSlot(application, slotId, cycle.id);
    if (denied) return res.status(denied.status).json({ error: denied.error });

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
    const { cycle, application } = await resolveOwnApplication(req);
    if (!cycle) return res.status(409).json({ error: 'There is no open recruiting cycle' });
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
