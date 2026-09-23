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
import { interviewTypesForRound, roundNumberForInterviewType } from '../utils/interviewRounds.js';
import { getRound } from '../utils/roundProgression.js';
import { parseLegacyConfig } from '../services/interviewRoster.js';
import { combine, planSessions } from '../services/slotPlanner.js';
import {
  conflictsWithAvailability,
  coverageByTime,
  whoCanCover,
} from '../services/interviewerAvailability.js';
import { SlotTransactionError } from '../utils/withSerializableTransaction.js';
import { moveSignup, cancelSignup, placeCandidate, promoteFromWaitlist } from '../services/interviewSignups.js';
import { sameTimeAndPlace } from '../services/interviewSignupPolicy.js';
import {
  slotNotificationSubject,
  slotSubjectFormatter,
  flushNotifications,
  queueNotifications,
  queueNotificationsBulk,
} from '../services/interviewSlotComms.js';
import { renderInterviewSlotEmail } from '../services/emailNotifications.js';
import { notifyInterviewer, notifyInterviewersBulk } from '../services/interviewerInvites.js';
import config from '../config.js';
import { formatEmailDateTime, formatEmailTime } from '../utils/timezoneUtils.js';

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

/// The rounds candidates schedule themselves into, in order. Shown always, so a
/// round can be set up before anybody reaches it.
const SCHEDULABLE_ROUNDS = ['2', '3', '4'];

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
        groupSize: slot.groupSize,
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
          groupLabel: signup.groupLabel,
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

// GET /api/admin/scheduling/overview
//
// The whole cycle's scheduling picture in one request, grouped by ROUND rather
// than by interview. That grouping is the point: recruitment runs a coffee chat
// day as two Interview rows ("Round 1" morning, "Round 2" afternoon), and
// booking treats them as one pool, so an admin needs to see them as one pool
// too. Looking at them one interview at a time is what made this impossible to
// follow.
router.get('/scheduling/overview', async (req, res) => {
  try {
    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.json({ cycle: null, rounds: [] });

    const interviews = await prisma.interview.findMany({
      where: { cycleId: cycle.id, status: { notIn: ['CANCELLED'] } },
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        title: true,
        interviewType: true,
        location: true,
        startDate: true,
        status: true,
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
              include: { user: { select: { id: true, fullName: true } } },
            },
          },
        },
      },
    });

    // Every schedulable round, whether or not an interview exists for it yet.
    //
    // Building the tabs from the interviews that happen to exist meant a cycle
    // with only a coffee chat showed only coffee chats, and there was nowhere
    // to set up first round before reaching it. Recruitment plans the whole
    // cycle up front; the page has to let them.
    const byRound = new Map();
    for (const round of SCHEDULABLE_ROUNDS) byRound.set(round, []);
    for (const interview of interviews) {
      const round = roundNumberForInterviewType(interview.interviewType);
      if (!round) continue;
      byRound.set(round, [...(byRound.get(round) ?? []), interview]);
    }

    const applicationsByRound = await prisma.application.groupBy({
      by: ['currentRound'],
      where: { cycleId: cycle.id, status: { notIn: ['REJECTED'] } },
      _count: { _all: true },
    });
    const eligibleCount = new Map(applicationsByRound.map((row) => [row.currentRound, row._count._all]));

    const rounds = [];
    for (const [round, roundInterviews] of [...byRound.entries()].sort()) {
      const slots = roundInterviews.flatMap((interview) =>
        interview.slots.map((slot) => {
          const confirmed = slot.signups.filter((s) => s.status === 'CONFIRMED');
          return {
            id: slot.id,
            // Carried so a merged view can say which interview a session is in.
            interviewId: interview.id,
            interviewTitle: interview.title,
            label: slot.label,
            startTime: slot.startTime,
            endTime: slot.endTime,
            location: slot.location || interview.location,
            candidateCapacity: slot.candidateCapacity,
            interviewerCapacity: slot.interviewerCapacity,
            groupSize: slot.groupSize,
            confirmedCount: confirmed.length,
            isOverCapacity: slot.candidateCapacity != null && confirmed.length > slot.candidateCapacity,
            isBookable: slot.candidateCapacity != null,
            signups: slot.signups.map((signup) => ({
              id: signup.id,
              status: signup.status,
              applicationId: signup.applicationId,
              slotId: signup.slotId,
              waitlistedAt: signup.waitlistedAt,
              groupLabel: signup.groupLabel,
              heldSeatId: signup.heldSeatId,
              movedById: signup.movedById,
              candidate: signup.application,
            })),
            interviewers: slot.assignments.map((a) => ({ id: a.id, user: a.user })),
          };
        })
      );

      const placed = new Set(slots.flatMap((s) => s.signups.map((x) => x.applicationId)));
      const unassigned = await prisma.application.findMany({
        where: {
          cycleId: cycle.id,
          currentRound: round,
          status: { notIn: ['REJECTED'] },
          id: { notIn: [...placed] },
        },
        select: { id: true, firstName: true, lastName: true, email: true, major1: true, graduationYear: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      });

      const allSignups = slots.flatMap((s) => s.signups);
      const bookable = slots.filter((s) => s.isBookable);
      rounds.push({
        round,
        // Taken from ROUNDS rather than guessed from the interview type, which
        // got the final round wrong: anything that was not a coffee chat came
        // back labelled "First Round Interviews".
        label: getRound(round)?.label ?? `Round ${round}`,
        // The type a new interview for this round should be created as, taken
        // from the mapping rather than from an interview that may not exist.
        // ROUND_TWO is a legacy alias of FINAL_ROUND that both map to round 4;
        // a new interview should be created under the name people use.
        interviewType:
          roundInterviews[0]?.interviewType ??
          interviewTypesForRound(round).find((type) => type !== 'ROUND_TWO') ??
          interviewTypesForRound(round)[0] ??
          null,
        interviews: roundInterviews.map((i) => ({ id: i.id, title: i.title, startDate: i.startDate, status: i.status })),
        slots,
        unassigned,
        stats: {
          eligible: eligibleCount.get(round) ?? 0,
          sessions: slots.length,
          bookableSessions: bookable.length,
          seats: bookable.reduce((n, s) => n + (s.candidateCapacity ?? 0), 0),
          confirmed: allSignups.filter((s) => s.status === 'CONFIRMED').length,
          waitlisted: allSignups.filter((s) => s.status === 'WAITLISTED').length,
          needsPlacement: allSignups.filter((s) => s.status === 'NEEDS_PLACEMENT').length,
          unassigned: unassigned.length,
          interviewers: slots.reduce((n, s) => n + s.interviewers.length, 0),
        },
      });
    }

    // Email health, so "did anyone actually get told" is answerable on the page.
    const notifications = await prisma.interviewSlotNotification.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    res.json({
      cycle: { id: cycle.id, name: cycle.name },
      rounds,
      notifications: Object.fromEntries(notifications.map((row) => [row.status, row._count._all])),
      emailsEnabled: config.schedulingEmailsEnabled,
    });
  } catch (error) {
    fail(res, error, 'Failed to load the scheduling overview');
  }
});

// PATCH /api/admin/scheduling/rounds/:round/signup-window   { opensAt, closesAt }
// Open or close candidate signup for a whole round at once. Doing this session
// by session across three interviews is how a block gets left shut by mistake.
router.patch('/scheduling/rounds/:round/signup-window', async (req, res) => {
  try {
    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.status(409).json({ error: 'There is no active cycle' });

    const types = interviewTypesForRound(req.params.round);
    if (types.length === 0) return res.status(400).json({ error: 'Not a scheduling round' });

    const opensAt = req.body?.opensAt === null ? null : parseTime(req.body?.opensAt);
    const closesAt = req.body?.closesAt === null ? null : parseTime(req.body?.closesAt);
    if (opensAt === undefined || closesAt === undefined) {
      return res.status(400).json({ error: 'Those dates are not valid' });
    }

    const interviews = await prisma.interview.findMany({
      where: { cycleId: cycle.id, interviewType: { in: types } },
      select: { id: true },
    });

    const { count } = await prisma.interviewSlot.updateMany({
      where: { interviewId: { in: interviews.map((i) => i.id) } },
      data: {
        ...(req.body?.opensAt !== undefined ? { signupOpensAt: opensAt } : {}),
        ...(req.body?.closesAt !== undefined ? { signupClosesAt: closesAt } : {}),
      },
    });
    res.json({ updated: count });
  } catch (error) {
    fail(res, error, 'Failed to update the signup window');
  }
});

// POST /api/admin/interviews/:id/adopt-sessions
//
// Turn this interview's hand-built groups into real sessions.
//
// The point is to end the two-mode split. Final round and past cycles kept the
// old JSON group editor purely because they had no slots, which meant two
// different screens for the same job and a permanent "which page do I use"
// question. Adopting converts a group into a session with its candidates, after
// which one screen handles everything.
//
// Sessions are created closed to signup (no seat count). An existing roster is
// not an invitation to let candidates rebook it - opening signup is a separate,
// deliberate act.
router.post('/interviews/:id/adopt-sessions', async (req, res) => {
  try {
    const { id } = req.params;
    const interview = await prisma.interview.findUnique({
      where: { id },
      select: { id: true, description: true, startDate: true, endDate: true, createdAt: true,
        slots: { select: { legacyGroupId: true } } },
    });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const config = parseLegacyConfig(interview);
    const groups = config.applicationGroups ?? [];
    if (groups.length === 0) {
      return res.status(409).json({ error: 'This interview has no groups to convert', code: 'NO_GROUPS' });
    }

    // Invert groupAssignments so a group can find its interviewers.
    const membersByGroup = new Map();
    for (const [memberGroupId, appGroupIds] of Object.entries(config.groupAssignments ?? {})) {
      const memberGroup = (config.memberGroups ?? []).find((g) => g.id === memberGroupId);
      if (!memberGroup) continue;
      for (const appGroupId of appGroupIds ?? []) {
        membersByGroup.set(appGroupId, [
          ...(membersByGroup.get(appGroupId) ?? []),
          ...(memberGroup.memberIds ?? []),
        ]);
      }
    }

    const already = new Set(interview.slots.map((s) => s.legacyGroupId).filter(Boolean));
    let created = 0;
    // Collected across the per-group transactions and sent once they have all
    // committed. Queueing inside them would re-send every interviewer's invite
    // on a serialisation retry, and a converted group is a roster being
    // finalised - the moment the calendar entry is actually worth having.
    const staffed = [];

    try {
      for (const group of groups) {
        if (already.has(group.id)) continue;
        const applicationIds = [...new Set(group.applicationIds ?? [])];
        const memberIds = [...new Set(membersByGroup.get(group.id) ?? [])];

        await prisma.$transaction(async (tx) => {
          const slot = await tx.interviewSlot.create({
            data: {
              interviewId: id,
              legacyGroupId: group.id,
              label: group.name || 'Session',
              notes: group.notes || null,
              startTime: interview.startDate,
              endTime: interview.endDate,
              candidateCapacity: null,
            },
          });
          for (const applicationId of applicationIds) {
            // The partial unique index would reject a second confirmed seat, and a
            // group listing someone twice is an artefact rather than an intent.
            const existing = await tx.interviewSlotSignup.findFirst({
              where: { interviewId: id, applicationId, status: 'CONFIRMED' },
              select: { id: true },
            });
            if (existing) continue;
            await tx.interviewSlotSignup.create({
              data: {
                slotId: slot.id,
                interviewId: id,
                applicationId,
                status: 'CONFIRMED',
                signedUpAt: interview.createdAt,
                placedById: req.user.id,
              },
            });
          }
          for (const userId of memberIds) {
            await tx.interviewSlotAssignment.create({
              data: { slotId: slot.id, interviewId: id, userId },
            });
            staffed.push({ slotId: slot.id, userId });
          }
          created += 1;
        });
      }
    } finally {
      // Whatever committed before a later group threw is real, and a retry skips
      // it - `already` matches on legacyGroupId, so those sessions are never
      // built again and their interviewers would never be told. Sending here
      // covers the partial run. notifyInterviewersBulk swallows its own errors,
      // so this cannot mask the failure that brought us here.
      await notifyInterviewersBulk(staffed);
    }

    res.json({ created, skipped: groups.length - created });
  } catch (error) {
    fail(res, error, 'Failed to convert those groups');
  }
});

// POST /api/admin/interviews/with-sessions
//
// Create an interview and the sessions it runs, in one go.
//
// Separately was the wrong shape: an interview with no sessions is not a thing
// anybody wants, and making it in two steps meant creating one and then hunting
// for where sessions live. Doing both in one transaction also means a bad
// schedule fails before an empty interview exists.
router.post('/interviews/with-sessions', async (req, res) => {
  try {
    const { title, interviewType, location, dresscode, day, sessions } = req.body ?? {};
    if (!title || !interviewType || !location || !day) {
      return res.status(400).json({ error: 'A title, round, day and location are required' });
    }

    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.status(409).json({ error: 'There is no active cycle' });

    let rows;
    try {
      rows = planSessions({ day, ...(sessions ?? {}) });
    } catch (planError) {
      // The schedule is the part people get wrong, so its complaint is the
      // one worth showing verbatim.
      return res.status(400).json({ error: planError.message });
    }

    // The interview spans its sessions. With none, it spans the range the admin
    // gave - and that range is load-bearing, not cosmetic: it is exactly what
    // the member availability form turns into hour ticks, and what the coverage
    // grid counts across. A first round created as "we will be running 8 to 5,
    // groups later" has to keep 8 to 5.
    const range = sessions?.range ?? {};
    const startDate = rows.length
      ? new Date(Math.min(...rows.map((r) => r.startTime)))
      : combine(day, range.start || '09:00');
    const endDate = rows.length
      ? new Date(Math.max(...rows.map((r) => r.endTime)))
      : combine(day, range.end || '17:00');
    if (!rows.length && !(endDate > startDate)) {
      return res.status(400).json({ error: 'The end of the day must come after the start' });
    }

    const interview = await prisma.interview.create({
      data: {
        title,
        interviewType,
        location,
        dresscode: dresscode || null,
        startDate,
        endDate,
        cycleId: cycle.id,
        createdBy: req.user.id,
        slots: { create: rows },
      },
      include: { slots: { orderBy: { startTime: 'asc' } } },
    });

    res.status(201).json(interview);
  } catch (error) {
    fail(res, error, 'Failed to create that interview');
  }
});

// POST /api/admin/interviews/slot-assignments/:id/move   { slotId }
//
// Move an interviewer from one session to another.
//
// Not remove-then-add. That fires two contradictory emails a minute apart
// ("you are off the 10am", "you are on the 11am") and throws away signedUpAt,
// so somebody who volunteered on day one looks like a late addition. Updating
// slotId in place keeps the row, its history, and sends one email that says
// what actually happened.
//
// Availability is not consulted. An admin moving somebody usually knows
// something the form does not - they asked in person, or the member's plans
// changed - and the coverage grid already reports placements that sit outside
// what a person said, which is the honest way to surface it.
router.post('/interviews/slot-assignments/:id/move', async (req, res) => {
  try {
    const { slotId } = req.body ?? {};
    if (!slotId) return res.status(400).json({ error: 'A destination session is required' });

    const assignment = await prisma.interviewSlotAssignment.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, slotId: true, interviewId: true, userId: true, removedAt: true,
        // Read the session they are leaving now - once slotId is updated there
        // is no way back to it, and the email is the one place it still matters.
        slot: { select: { label: true, startTime: true, endTime: true } },
      },
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.slotId === slotId) return res.json({ moved: false, unchanged: true });

    const target = await prisma.interviewSlot.findUnique({
      where: { id: slotId },
      select: { id: true, interviewId: true, startTime: true, endTime: true },
    });
    if (!target) return res.status(404).json({ error: 'That session no longer exists' });
    // The composite FK is on (slotId, interviewId), so a cross-interview move
    // would write a row that does not join. Moving somebody between interviews
    // is a different act anyway - take them off one and add them to the other.
    if (target.interviewId !== assignment.interviewId) {
      return res.status(400).json({ error: 'That session belongs to a different interview' });
    }

    // Already on the destination under an older row: fold into it rather than
    // leaving two live assignments for one person on one session.
    const existing = await prisma.interviewSlotAssignment.findFirst({
      where: { slotId, userId: assignment.userId, id: { not: assignment.id } },
      select: { id: true, removedAt: true },
    });

    const moved = await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.interviewSlotAssignment.update({
          where: { id: assignment.id },
          data: { removedAt: new Date(), removedBy: req.user.id },
        });
        return tx.interviewSlotAssignment.update({
          where: { id: existing.id },
          data: { removedAt: null, removedBy: null },
        });
      }
      return tx.interviewSlotAssignment.update({
        where: { id: assignment.id },
        data: { slotId, removedAt: null, removedBy: null },
      });
    });

    // Somebody else's session at the same time as this one. Reported, never
    // blocked - but an admin who has just double-booked a person should see it
    // before they close the page.
    const clash = await prisma.interviewSlotAssignment.findFirst({
      where: {
        userId: assignment.userId,
        removedAt: null,
        id: { not: moved.id },
        slot: { startTime: { lt: target.endTime }, endTime: { gt: target.startTime } },
      },
      select: { slot: { select: { id: true, label: true, startTime: true, endTime: true } } },
    });

    await notifyInterviewer(slotId, assignment.userId, 'INTERVIEWER_MOVED', {
      // First-round sessions usually have no name, so the time is what
      // identifies the one they are coming off.
      fromSlotName:
        assignment.slot?.label ||
        (assignment.slot
          ? `${formatEmailDateTime(assignment.slot.startTime)} - ${formatEmailTime(assignment.slot.endTime)}`
          : null),
    });
    res.json({ moved: true, assignment: moved, clash: clash?.slot ?? null });
  } catch (error) {
    fail(res, error, 'Failed to move that member');
  }
});

// POST /api/admin/interviews/slots/:slotId/interviewers   { userId, role }
// Put a member on a session. First round is the case that needs it: an
// interviewer assigned to a session sees those candidates and no others.
//
// Any active member can be placed here, whether or not they sent availability.
// Availability is a convenience for the admin building the day, not a gate on
// who may be put in a room.
router.post('/interviews/slots/:slotId/interviewers', async (req, res) => {
  try {
    const { slotId } = req.params;
    const { userId, role } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'A member is required' });

    const slot = await prisma.interviewSlot.findUnique({
      where: { id: slotId },
      select: { id: true, interviewId: true },
    });
    if (!slot) return res.status(404).json({ error: 'Session not found' });

    // Re-activate a previous assignment rather than stacking a second row, so
    // removing and re-adding somebody does not litter the audit trail.
    const existing = await prisma.interviewSlotAssignment.findFirst({
      where: { slotId, userId },
      select: { id: true, removedAt: true },
    });
    if (existing) {
      if (!existing.removedAt) return res.status(409).json({ error: 'They are already on this session' });
      const revived = await prisma.interviewSlotAssignment.update({
        where: { id: existing.id },
        data: { removedAt: null, removedBy: null, role: role || 'INTERVIEWER' },
      });
      await notifyInterviewer(slotId, userId, 'INTERVIEWER_ASSIGNED');
      return res.json(revived);
    }

    const assignment = await prisma.interviewSlotAssignment.create({
      data: { slotId, interviewId: slot.interviewId, userId, role: role || 'INTERVIEWER' },
    });
    await notifyInterviewer(slotId, userId, 'INTERVIEWER_ASSIGNED');
    res.status(201).json(assignment);
  } catch (error) {
    fail(res, error, 'Failed to assign that member');
  }
});

// DELETE /api/admin/interviews/slot-assignments/:id
router.delete('/interviews/slot-assignments/:id', async (req, res) => {
  try {
    const existing = await prisma.interviewSlotAssignment.findUnique({
      where: { id: req.params.id },
      select: { slotId: true, userId: true, removedAt: true },
    });
    await prisma.interviewSlotAssignment.update({
      where: { id: req.params.id },
      // Soft delete: who was meant to run a session, and who came off it, is
      // worth keeping when one turns out to have been unstaffed.
      data: { removedAt: new Date(), removedBy: req.user.id },
    });
    // Somebody who was told they were interviewing has to be told they are not.
    if (existing && !existing.removedAt) {
      await notifyInterviewer(existing.slotId, existing.userId, 'INTERVIEWER_REMOVED');
    }
    res.json({ removed: true });
  } catch (error) {
    fail(res, error, 'Failed to remove that member');
  }
});

// PATCH /api/admin/interviews/:id
// Edit the interview itself. Dates, location, title - all of it changes, and
// usually after everything else has been built around it.
router.patch('/interviews/:id', async (req, res) => {
  try {
    const body = req.body ?? {};
    const data = {};
    for (const field of ['title', 'location', 'dresscode', 'interviewType', 'status']) {
      if (body[field] !== undefined) data[field] = body[field] || null;
    }
    for (const field of ['startDate', 'endDate']) {
      if (body[field] === undefined) continue;
      const parsed = parseTime(body[field]);
      if (parsed === undefined) return res.status(400).json({ error: `${field} is not a valid date` });
      data[field] = parsed;
    }
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      return res.status(400).json({ error: 'The end time must be after the start time' });
    }

    const interview = await prisma.interview.update({ where: { id: req.params.id }, data });

    // Moving the interview does not move its sessions: those carry their own
    // times and are what candidates actually booked. Say so rather than
    // silently doing one or the other.
    const sessions = await prisma.interviewSlot.count({ where: { interviewId: interview.id } });
    res.json({ ...interview, sessionCount: sessions });
  } catch (error) {
    fail(res, error, 'Failed to update that interview');
  }
});

// POST /api/admin/interviews/:id/reschedule   { day, shiftMinutes }
// Move every session of an interview at once - the "it is a week later now"
// case, which is otherwise editing twenty sessions by hand.
router.post('/interviews/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { day, shiftMinutes } = req.body ?? {};
    const slots = await prisma.interviewSlot.findMany({ where: { interviewId: id } });
    if (slots.length === 0) return res.status(409).json({ error: 'This interview has no sessions to move' });

    const shift = (date) => {
      if (Number.isFinite(Number(shiftMinutes)) && Number(shiftMinutes) !== 0) {
        return new Date(date.getTime() + Number(shiftMinutes) * 60000);
      }
      if (!day) return date;
      // Keep the wall-clock time, change the date: "same schedule, next Tuesday".
      const target = new Date(`${day}T00:00:00`);
      if (Number.isNaN(target.getTime())) return null;
      target.setHours(date.getHours(), date.getMinutes(), 0, 0);
      return target;
    };

    const updates = [];
    for (const slot of slots) {
      const startTime = shift(slot.startTime);
      const endTime = shift(slot.endTime);
      if (!startTime || !endTime) return res.status(400).json({ error: 'That day is not valid' });
      updates.push(prisma.interviewSlot.update({ where: { id: slot.id }, data: { startTime, endTime } }));
    }
    await prisma.$transaction(updates);

    const moved = await prisma.interviewSlot.findMany({ where: { interviewId: id }, orderBy: { startTime: 'asc' } });
    await prisma.interview.update({
      where: { id },
      data: {
        startDate: moved[0].startTime,
        endDate: moved[moved.length - 1].endTime,
      },
    });
    res.json({ moved: moved.length });
  } catch (error) {
    fail(res, error, 'Failed to reschedule that interview');
  }
});

// POST /api/admin/interviews/slots/:slotId/groups   { size }
//
// Split a session's candidates into rotation groups - 1A, 1B, 2A - which is how
// a coffee chat actually runs. Pairs move between tables together, and at a
// table the interviewer asks for the group rather than for names.
router.post('/interviews/slots/:slotId/groups', async (req, res) => {
  try {
    const { slotId } = req.params;
    const slot = await prisma.interviewSlot.findUnique({
      where: { id: slotId },
      select: { groupSize: true },
    });
    if (!slot) return res.status(404).json({ error: 'Session not found' });
    const size = Math.max(1, Number(req.body?.size ?? slot.groupSize ?? 2));

    // Remember it, so bookings that arrive afterwards keep the same shape
    // instead of reverting to pairs.
    if (size !== slot.groupSize) {
      await prisma.interviewSlot.update({ where: { id: slotId }, data: { groupSize: size } });
    }

    const signups = await prisma.interviewSlotSignup.findMany({
      where: { slotId, status: 'CONFIRMED' },
      orderBy: { signedUpAt: 'asc' },
      select: { id: true },
    });
    if (signups.length === 0) return res.status(409).json({ error: 'Nobody is in this session yet' });

    // 1A 1B / 2A 2B: the number is the table rotation, the letter the pair
    // within it. Both are said out loud, so both stay short.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const updates = signups.map((signup, index) => {
      const round = Math.floor(index / (size * 2)) + 1;
      const withinRound = Math.floor((index % (size * 2)) / size);
      return prisma.interviewSlotSignup.update({
        where: { id: signup.id },
        data: { groupLabel: `${round}${letters[withinRound] ?? 'A'}` },
      });
    });
    await prisma.$transaction(updates);

    const grouped = await prisma.interviewSlotSignup.groupBy({
      by: ['groupLabel'],
      where: { slotId, status: 'CONFIRMED' },
      _count: { _all: true },
    });
    res.json({ groups: grouped.length, size, labels: grouped.map((g) => g.groupLabel).sort() });
  } catch (error) {
    fail(res, error, 'Failed to make groups');
  }
});

// PATCH /api/admin/interviews/slot-signups/:signupId/group   { groupLabel }
//
// Move one candidate between rotation groups, or out of grouping entirely.
// Groups do not always divide evenly - a session of nine in pairs leaves one
// over - so the last word belongs to a person, not to the arithmetic.
router.patch('/interviews/slot-signups/:signupId/group', async (req, res) => {
  try {
    const raw = req.body?.groupLabel;
    const groupLabel = raw == null || raw === '' ? null : String(raw).trim().toUpperCase();
    if (groupLabel && !/^[0-9]{1,2}[A-Z]$/.test(groupLabel)) {
      return res.status(400).json({ error: 'A group is a number and a letter, like 1A' });
    }
    const signup = await prisma.interviewSlotSignup.update({
      where: { id: req.params.signupId },
      data: { groupLabel },
      select: { id: true, groupLabel: true, slotId: true },
    });
    res.json(signup);
  } catch (error) {
    fail(res, error, 'Failed to change that group');
  }
});

// DELETE /api/admin/interviews/slots/:slotId/groups
router.delete('/interviews/slots/:slotId/groups', async (req, res) => {
  try {
    const { count } = await prisma.interviewSlotSignup.updateMany({
      where: { slotId: req.params.slotId },
      data: { groupLabel: null },
    });
    res.json({ cleared: count });
  } catch (error) {
    fail(res, error, 'Failed to clear those groups');
  }
});

// GET /api/admin/interviews/:id/availability?minutes=60&per=2
//
// Who said they can interview, and what that means for the day.
//
// The coverage grid is the point: it answers "how many panels can we run at
// 10:00" before anybody builds the schedule, which is the question that decides
// whether first round needs one room at a time or four.
router.get('/interviews/:id/availability', async (req, res) => {
  try {
    const interview = await prisma.interview.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, title: true, interviewType: true, startDate: true, endDate: true, cycleId: true,
        slots: {
          orderBy: { startTime: 'asc' },
          select: {
            id: true, label: true, startTime: true, endTime: true, interviewerCapacity: true,
            assignments: {
              where: { removedAt: null },
              select: { id: true, userId: true, user: { select: { id: true, fullName: true, email: true } } },
            },
          },
        },
      },
    });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const [windows, staff] = await Promise.all([
      prisma.interviewerAvailability.findMany({
        where: { interviewId: interview.id },
        include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
        orderBy: [{ userId: 'asc' }, { startTime: 'asc' }],
      }),
      prisma.user.findMany({
        where: { isActive: true, role: { in: ['MEMBER', 'ADMIN'] } },
        select: { id: true, fullName: true, email: true, role: true },
        orderBy: { fullName: 'asc' },
      }),
    ]);
    const answeredIds = new Set(windows.map((w) => w.userId));

    const minutes = Number(req.query.minutes) || 60;
    const perSession = Number(req.query.per) || 2;
    const grid = coverageByTime(windows, {
      start: interview.startDate,
      end: interview.endDate,
      minutes,
      interviewersPerSession: perSession,
    });

    const byUser = new Map();
    for (const window of windows) {
      const entry = byUser.get(window.userId) ?? { user: window.user, windows: [] };
      entry.windows.push({ id: window.id, startTime: window.startTime, endTime: window.endTime, note: window.note });
      byUser.set(window.userId, entry);
    }

    // Who is already placed where, and whether that contradicts what they said.
    // Reported rather than blocked: an admin may know something the form does
    // not, and somebody who can suddenly make 4pm should not have to re-submit
    // a form before being put there.
    const placements = interview.slots.flatMap((slot) =>
      slot.assignments.map((assignment) => ({
        assignmentId: assignment.id,
        slotId: slot.id,
        slotLabel: slot.label,
        startTime: slot.startTime,
        endTime: slot.endTime,
        user: assignment.user,
        conflict: conflictsWithAvailability(windows, assignment.userId, slot.startTime, slot.endTime),
      }))
    );

    res.json({
      interview: {
        id: interview.id, title: interview.title, interviewType: interview.interviewType,
        startDate: interview.startDate, endDate: interview.endDate, cycleId: interview.cycleId,
      },
      cadence: { minutes, interviewersPerSession: perSession },
      coverage: grid,
      interviewers: [...byUser.values()].sort((a, b) =>
        (a.user.fullName ?? '').localeCompare(b.user.fullName ?? '')
      ),
      sessions: interview.slots.map((slot) => ({
        id: slot.id,
        label: slot.label,
        startTime: slot.startTime,
        endTime: slot.endTime,
        interviewerCapacity: slot.interviewerCapacity,
        // Who could staff this session, so an admin placing somebody is choosing
        // from people who said yes rather than from the whole roster.
        canCover: whoCanCover(windows, slot.startTime, slot.endTime),
        assigned: slot.assignments.map((a) => a.user),
      })),
      placements,
      // Everybody who could be put on a session, not just the people who
      // answered. Availability ranks the list; it does not decide who is on it.
      // Recruitment routinely places somebody who never filled the form in -
      // they said yes in a meeting, or they are exec and were always going to
      // be there - and a picker that cannot express that sends admins back to
      // the spreadsheet this feature exists to replace.
      staff: staff.map((user) => ({ ...user, responded: answeredIds.has(user.id) })),
    });
  } catch (error) {
    fail(res, error, 'Failed to load interviewer availability');
  }
});

// POST /api/admin/interviews/:id/request-availability
//
// Ask the people who might interview when they are free. Sent before the
// schedule exists, because it is what the schedule is built from.
//
// Defaults to everybody who has not answered yet, so pressing it twice chases
// the stragglers rather than nagging the people who already did their bit.
router.post('/interviews/:id/request-availability', async (req, res) => {
  try {
    const { id } = req.params;
    const interview = await prisma.interview.findUnique({
      where: { id },
      select: { id: true, title: true, startDate: true, location: true },
    });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const staff = await prisma.user.findMany({
      where: { isActive: true, role: { in: ['MEMBER', 'ADMIN'] } },
      select: { id: true, email: true, fullName: true },
    });

    const answered = new Set(
      (
        await prisma.interviewerAvailability.findMany({
          where: { interviewId: id },
          select: { userId: true },
          distinct: ['userId'],
        })
      ).map((row) => row.userId)
    );

    const everyone = req.body?.everyone === true;
    const recipients = staff.filter((user) => user.email && (everyone || !answered.has(user.id)));

    if (recipients.length === 0) {
      return res.json({
        queued: 0,
        alreadyAnswered: answered.size,
        message: everyone ? 'Nobody to email.' : 'Everybody has already sent their availability.',
      });
    }

    const subject = await slotNotificationSubject('AVAILABILITY_REQUEST', interview.title);
    const entries = recipients.map((user) => ({
      interviewId: id,
      type: 'AVAILABILITY_REQUEST',
      recipient: user.email,
      subject,
    }));
    const ids = await queueNotificationsBulk(entries);
    flushNotifications(ids, (n) =>
      renderInterviewSlotEmail(n, {
        ctaUrl: `${config.clientUrl}/assigned-interviews`,
        ctaLabel: 'Add my availability',
      })
    ).catch((e) => console.error('[request-availability] flush failed', e));

    res.json({
      queued: ids.length,
      alreadyAnswered: answered.size,
      emailsEnabled: config.schedulingEmailsEnabled,
    });
  } catch (error) {
    fail(res, error, 'Failed to ask for availability');
  }
});

// GET /api/admin/interviews/staff
// Members and admins who can be put on a session.
router.get('/interviews/staff', async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: { isActive: true, role: { in: ['MEMBER', 'ADMIN'] } },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { fullName: 'asc' },
    });
    res.json(staff);
  } catch (error) {
    fail(res, error, 'Failed to load members');
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
    if (body.groupSize !== undefined) {
      data.groupSize = body.groupSize == null || body.groupSize === '' ? null : Number(body.groupSize);
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

// POST /api/admin/interviews/slot-signups/:signupId/promote   { force }
// Give somebody the session they are waiting for, even if it is full.
router.post('/interviews/slot-signups/:signupId/promote', async (req, res) => {
  try {
    const result = await promoteFromWaitlist({
      signupId: req.params.signupId,
      actorId: req.user.id,
      force: req.body?.force === true,
    });
    await notifyPromotions([{ signupId: result.promoted.id }, ...result.promotions]);
    res.json({ promoted: true, overCapacity: result.overCapacity, alsoPromoted: result.promotions.length });
  } catch (error) {
    fail(res, error, 'Failed to move that candidate off the waitlist');
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

/**
 * Tell a candidate their time changed - and only then.
 *
 * A candidate's email is about a time slot, never about a group. Coffee chat
 * rotation groups (1A, 1B) live inside a sitting: shuffling somebody from 1A to
 * 1B does not move them by a minute, and mailing "your time has been updated"
 * for it makes people re-check a booking that has not changed. Group changes go
 * through the group endpoint, which sends nothing at all; this guard covers the
 * other way of arriving at the same place - a move between two slots that hold
 * the same time, such as parallel groups at one hour.
 */
async function notifyMoved(result) {
  // A move that changes nothing a candidate would act on, for somebody who
  // already held a confirmed seat, is not news. Someone coming off a waitlist
  // still hears, because their status genuinely changed.
  if (result.fromStatus === 'CONFIRMED' && sameTimeAndPlace(result.fromSlot, result.target)) {
    const promotionIds = await notifyPromotions(result.promotions, { flush: false });
    flushNotifications(promotionIds, renderBody).catch((e) =>
      console.error('[interviewSlotsAdmin] flush failed', e)
    );
    return;
  }

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
      subject: await slotNotificationSubject('MOVED_BY_ADMIN', moved.slot.interview.title),
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
  const subjectFor = await slotSubjectFormatter('PROMOTED');
  const entries = rows
    .filter((row) => row.application?.email)
    .map((row) => ({
      slotId: row.slotId,
      signupId: row.id,
      type: 'PROMOTED',
      recipient: row.application.email,
      subject: subjectFor(row.slot.interview.title),
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
