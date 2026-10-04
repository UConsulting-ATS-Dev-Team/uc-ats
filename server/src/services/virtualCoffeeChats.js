// Virtual coffee chats: video calls recruitment schedules by hand.
//
// Each one is a COFFEE_CHAT Interview with isVirtual set and exactly one
// session (InterviewSlot). Modelling it as an ordinary coffee chat interview is
// what makes everything downstream work unchanged: the interviewer's My
// Interviews page, evaluations, decision processing, accountability credit and
// the round's one-seat-per-candidate pool all read interviews and sessions, and
// a virtual chat is both.
//
// What makes it virtual is who decides. Nobody signs up:
//   - the session has no candidate capacity, so the booking paths already
//     refuse it (isCandidateBookable) and the candidate's options never list it;
//   - members cannot claim it (routes/interviewSlotsMember.js);
//   - a candidate placed in one cannot move or cancel it themselves
//     (routes/candidateInterviewSignups.js), and is not offered in-person times
//     while they hold it (candidateSchedulingView.js).
// Only admins add and remove applicants and interviewers, through here.
//
// A chat can hold one applicant or many, and one interviewer or several. The
// meeting link lives in Interview.location, so every place that already shows
// "where" shows the link: the emails, the calendar invite, My Interviews.
//
// Seats are placed through placeCandidate / moveSignup, never written directly:
// they take the round lock, and an applicant already holding an in-person seat
// is moved out of it rather than given a second one.

import prisma from '../prismaClient.js';
import config from '../config.js';
import { SlotTransactionError } from '../utils/withSerializableTransaction.js';
import { isCandidateEligibleForInterview, roundNumberForInterviewType } from '../utils/interviewRounds.js';
import { combine } from './slotPlanner.js';
import {
  cancelSignup,
  closeInterviewToBookings,
  moveSignup,
  placeCandidate,
  LIVE_STATUSES,
} from './interviewSignups.js';
import {
  flushNotifications,
  queueNotificationsBulk,
  slotSubjectFormatter,
} from './interviewSlotComms.js';
import { renderInterviewSlotEmail } from './emailNotifications.js';
import { notifyInterviewer, notifyInterviewersBulk } from './interviewerInvites.js';

export const DEFAULT_TITLE = 'Virtual Coffee Chat';
/// Stored as the location until an admin has a link, so the emails say
/// something true rather than nothing.
export const NO_LINK_YET = 'Video call, link to follow';

const COFFEE_CHAT_ROUND = roundNumberForInterviewType('COFFEE_CHAT');
const MAX_TITLE = 120;
const MAX_NOTES = 1000;
const MAX_LINK = 500;

const bad = (message) => new SlotTransactionError(400, message);

const candidateRender = (notification) =>
  renderInterviewSlotEmail(notification, { ctaUrl: `${config.clientUrl}/interview-signup` });

/**
 * Validate and normalise what an admin typed. `partial` allows an edit that
 * leaves fields out; the time fields still travel as a set.
 *
 * Times arrive as a day and two wall-clock times in Los Angeles, the same shape
 * the session planner takes, and go through the same helper. A virtual chat
 * at 7pm is 7pm Pacific whatever zone the server runs in.
 */
export function parseChatDetails(body = {}, { partial = false } = {}) {
  const out = {};

  if (body.title !== undefined || !partial) {
    const title = String(body.title ?? '').trim() || DEFAULT_TITLE;
    if (title.length > MAX_TITLE) throw bad(`The title can be at most ${MAX_TITLE} characters`);
    out.title = title;
  }

  if (body.meetingUrl !== undefined || !partial) {
    const link = String(body.meetingUrl ?? '').trim();
    if (link.length > MAX_LINK) throw bad('That meeting link is too long');
    // Only a web link. It is rendered as a button in every email, and a
    // javascript: or mailto: "link" there is either broken or worse.
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      throw bad('The meeting link must be a full web address starting with https://');
    }
    out.location = link || NO_LINK_YET;
  }

  if (body.notes !== undefined) {
    const notes = String(body.notes ?? '').trim();
    if (notes.length > MAX_NOTES) throw bad(`Notes can be at most ${MAX_NOTES} characters`);
    out.notes = notes || null;
  }

  const timeGiven = ['day', 'start', 'end'].some((key) => body[key] !== undefined);
  if (timeGiven || !partial) {
    if (!body.day || !body.start || !body.end) throw bad('A day, a start time and an end time are required');
    const startTime = combine(body.day, body.start);
    const endTime = combine(body.day, body.end);
    if (!startTime || !endTime || Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      throw bad('That day or time is not valid');
    }
    if (endTime <= startTime) throw bad('The chat must end after it starts');
    out.startTime = startTime;
    out.endTime = endTime;
  }

  return out;
}

/**
 * Load a virtual chat by its interview id, or throw 404 / 409.
 *
 * Scoped to the admin cycle the request is working in, the same cycle the list
 * comes from. A tab left open across a cycle change must not be able to edit,
 * staff or cancel last cycle's chats and email the people in them.
 */
async function loadChat(chatId, cycleId, { allowCancelled = false } = {}) {
  if (!cycleId) throw new SlotTransactionError(409, 'There is no active cycle');
  const interview = await prisma.interview.findFirst({
    where: { id: chatId, isVirtual: true, cycleId },
    include: { slots: { orderBy: { startTime: 'asc' } } },
  });
  if (!interview) throw new SlotTransactionError(404, 'That virtual coffee chat no longer exists');
  const closed = interview.status === 'COMPLETED' || (interview.status === 'CANCELLED' && !allowCancelled);
  if (closed) {
    throw new SlotTransactionError(409, 'That virtual coffee chat has been cancelled or completed');
  }
  const slot = interview.slots[0];
  if (!slot) throw new SlotTransactionError(409, 'That virtual coffee chat has no session');
  return { interview, slot };
}

const CHAT_INCLUDE = {
  slots: {
    orderBy: { startTime: 'asc' },
    include: {
      signups: {
        where: { status: { in: LIVE_STATUSES } },
        orderBy: { signedUpAt: 'asc' },
        include: {
          application: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
      assignments: {
        where: { removedAt: null },
        orderBy: { signedUpAt: 'asc' },
        include: { user: { select: { id: true, fullName: true, email: true } } },
      },
    },
  },
  _count: { select: { evaluations: true } },
};

function toChat(interview) {
  const slot = interview.slots[0] ?? null;
  return {
    id: interview.id,
    slotId: slot?.id ?? null,
    title: interview.title,
    status: interview.status,
    startTime: slot?.startTime ?? interview.startDate,
    endTime: slot?.endTime ?? interview.endDate,
    meetingUrl: interview.location === NO_LINK_YET ? null : interview.location,
    notes: slot?.notes ?? null,
    evaluationCount: interview._count?.evaluations ?? 0,
    applicants: (slot?.signups ?? []).map((signup) => ({
      signupId: signup.id,
      status: signup.status,
      applicationId: signup.applicationId,
      firstName: signup.application?.firstName ?? '',
      lastName: signup.application?.lastName ?? '',
      email: signup.application?.email ?? null,
    })),
    interviewers: (slot?.assignments ?? []).map((assignment) => ({
      assignmentId: assignment.id,
      user: assignment.user,
    })),
  };
}

/** One chat in the shape the admin page renders. */
export async function getVirtualCoffeeChat(chatId) {
  const interview = await prisma.interview.findFirst({
    where: { id: chatId, isVirtual: true },
    include: CHAT_INCLUDE,
  });
  return interview ? toChat(interview) : null;
}

/** Every live virtual chat in a cycle, soonest first. */
export async function listVirtualCoffeeChats(cycleId) {
  const interviews = await prisma.interview.findMany({
    // A cancelled chat that still holds a seat stays listed: something went
    // wrong part way through, and cancelling it again is the fix.
    where: {
      cycleId,
      isVirtual: true,
      OR: [
        { status: { not: 'CANCELLED' } },
        { slots: { some: { signups: { some: { status: { in: LIVE_STATUSES } } } } } },
      ],
    },
    orderBy: { startDate: 'asc' },
    include: CHAT_INCLUDE,
  });
  return interviews.map(toChat);
}

/**
 * Who can be put in a virtual chat: everyone in the coffee chat round who is
 * still in the running, each with where they currently are. The picker uses it
 * to say "this moves them out of the Morning Block" before anybody clicks.
 */
export async function listEligibleApplicants(cycleId) {
  const applications = await prisma.application.findMany({
    where: { cycleId, currentRound: COFFEE_CHAT_ROUND, status: { notIn: ['REJECTED'] } },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  if (applications.length === 0) return [];

  const seats = await prisma.interviewSlotSignup.findMany({
    where: {
      applicationId: { in: applications.map((a) => a.id) },
      status: { in: LIVE_STATUSES },
      slot: { interview: { cycleId, interviewType: 'COFFEE_CHAT', status: { notIn: ['CANCELLED', 'COMPLETED'] } } },
    },
    select: {
      applicationId: true,
      status: true,
      slot: {
        select: {
          label: true,
          startTime: true,
          interview: { select: { id: true, title: true, isVirtual: true } },
        },
      },
    },
  });
  // A waitlisted candidate also holds a confirmed seat; the confirmed one is
  // where they will actually be.
  const seatByApplication = new Map();
  for (const seat of seats) {
    const current = seatByApplication.get(seat.applicationId);
    if (!current || (seat.status === 'CONFIRMED' && current.status !== 'CONFIRMED')) {
      seatByApplication.set(seat.applicationId, seat);
    }
  }

  return applications.map((application) => {
    const seat = seatByApplication.get(application.id);
    return {
      ...application,
      placement: seat
        ? {
            interviewId: seat.slot.interview.id,
            title: seat.slot.interview.title,
            isVirtual: seat.slot.interview.isVirtual,
            label: seat.slot.label,
            startTime: seat.slot.startTime,
            status: seat.status,
          }
        : null,
    };
  });
}

/** Every requested id marked SKIPPED with the error, for a step that failed outright. */
function failedFor(ids, key, error) {
  if (!(error?.status && error?.message)) console.error('[virtualCoffeeChats] create step failed', error);
  const reason = error?.status && error?.message ? error.message : 'Could not be added; try again from the chat';
  return [...new Set(ids ?? [])].map((id) => ({ [key]: id, outcome: 'SKIPPED', reason }));
}

/**
 * Create a chat, and optionally fill it in the same action. Returns the chat
 * plus a per-person outcome for everyone asked for, so a partial result is
 * reported rather than silently half-applied.
 */
export async function createVirtualCoffeeChat({ cycleId, actorId, body = {} }) {
  const details = parseChatDetails(body);
  const interview = await prisma.interview.create({
    data: {
      title: details.title,
      interviewType: 'COFFEE_CHAT',
      isVirtual: true,
      location: details.location,
      startDate: details.startTime,
      endDate: details.endTime,
      cycleId,
      createdBy: actorId,
      slots: {
        create: [
          {
            startTime: details.startTime,
            endTime: details.endTime,
            // Null is what keeps candidates out: not "full", not self-service.
            candidateCapacity: null,
            notes: details.notes ?? null,
          },
        ],
      },
    },
    select: { id: true },
  });

  // The chat exists from here on. A failure filling it is reported per person
  // rather than thrown: an error response would leave the form open, and a
  // retry would create a second chat beside this one.
  const interviewers = await addInterviewers(interview.id, body.interviewerIds ?? [], { cycleId }).catch((error) =>
    failedFor(body.interviewerIds, 'userId', error)
  );
  const applicants = await addApplicants(interview.id, body.applicationIds ?? [], actorId, { cycleId }).catch(
    (error) => failedFor(body.applicationIds, 'applicationId', error)
  );
  return { chat: await getVirtualCoffeeChat(interview.id), interviewers, applicants };
}

/**
 * Edit the title, time, link or notes. A new time or link is emailed to
 * everyone in the chat. A title or notes edit is not.
 */
export async function updateVirtualCoffeeChat(chatId, body = {}, { cycleId } = {}) {
  const { interview, slot } = await loadChat(chatId, cycleId);
  const details = parseChatDetails(body, { partial: true });

  const interviewData = {};
  const slotData = {};
  if (details.title !== undefined) interviewData.title = details.title;
  if (details.location !== undefined) interviewData.location = details.location;
  if (details.startTime) {
    interviewData.startDate = details.startTime;
    interviewData.endDate = details.endTime;
    slotData.startTime = details.startTime;
    slotData.endTime = details.endTime;
  }
  if (details.notes !== undefined) slotData.notes = details.notes;

  await prisma.$transaction([
    prisma.interview.update({ where: { id: interview.id }, data: interviewData }),
    prisma.interviewSlot.update({ where: { id: slot.id }, data: slotData }),
  ]);

  const timeChanged =
    details.startTime &&
    (details.startTime.getTime() !== slot.startTime.getTime() ||
      details.endTime.getTime() !== slot.endTime.getTime());
  const linkChanged = details.location !== undefined && details.location !== interview.location;

  if (timeChanged || linkChanged) {
    const chat = await getVirtualCoffeeChat(interview.id);
    await notifyCandidates(
      chat.applicants
        .filter((a) => a.status === 'CONFIRMED')
        .map((a) => ({ signupId: a.signupId, type: 'MOVED_BY_ADMIN' }))
    );
    await notifyInterviewersBulk(
      chat.interviewers.map((i) => ({ slotId: slot.id, userId: i.user.id })),
      'INTERVIEWER_MOVED'
    );
  }

  return getVirtualCoffeeChat(interview.id);
}

/**
 * Put applicants in a chat. One at a time, because each takes the round lock -
 * a virtual chat holds a handful of people, so this is a few short
 * transactions, not a bulk job.
 *
 * Outcomes per applicant:
 *   PLACED       new seat here
 *   MOVED        taken out of another coffee chat session (named in `from`)
 *   ALREADY_HERE nothing to do
 *   SKIPPED      not in the coffee chat round, rejected, or not found (`reason`)
 */
export async function addApplicants(chatId, applicationIds, actorId, { cycleId } = {}) {
  const ids = [...new Set((applicationIds ?? []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return [];
  const { interview, slot } = await loadChat(chatId, cycleId);

  const applications = await prisma.application.findMany({
    where: { id: { in: ids } },
    select: { id: true, cycleId: true, currentRound: true, status: true },
  });
  const byId = new Map(applications.map((a) => [a.id, a]));

  const outcomes = [];
  const toNotify = [];
  for (const applicationId of ids) {
    const application = byId.get(applicationId);
    // Placement bypasses the candidate-side eligibility check, so it is
    // repeated here: the ids arrive in a request body.
    const reason = !application
      ? 'Application not found'
      : application.cycleId !== interview.cycleId
        ? 'Applied in a different cycle'
        : application.status === 'REJECTED'
          ? 'Not advancing'
          : !isCandidateEligibleForInterview(application.currentRound, 'COFFEE_CHAT')
            ? 'Not in the coffee chat round'
            : null;
    if (reason) {
      outcomes.push({ applicationId, outcome: 'SKIPPED', reason });
      continue;
    }

    try {
      const placed = await placeCandidate({
        interviewId: interview.id,
        slotId: slot.id,
        applicationId,
        actorId,
        force: true,
      });
      if (placed.placed) {
        outcomes.push({ applicationId, outcome: 'PLACED', signupId: placed.placed.id });
        toNotify.push({ signupId: placed.placed.id, type: 'CONFIRMATION' });
        continue;
      }

      const moved = await moveSignup({
        signupId: placed.moveInstead,
        toSlotId: slot.id,
        actorId,
        isAdmin: true,
        force: true,
        reason: 'Moved to a virtual coffee chat',
      });
      // The move has committed. Queue its emails before anything else can
      // fail, and treat naming the old session as a nicety: a failed lookup
      // must not report a moved applicant as skipped.
      toNotify.push({ signupId: moved.moved.id, type: 'MOVED_BY_ADMIN' });
      // Their old seat may have let somebody off a waitlist.
      for (const promotion of moved.promotions ?? []) {
        toNotify.push({ signupId: promotion.signupId, type: 'PROMOTED' });
      }
      const from =
        moved.fromSlot.label ||
        (
          await prisma.interview
            .findUnique({ where: { id: moved.fromSlot.interviewId }, select: { title: true } })
            .catch(() => null)
        )?.title ||
        null;
      outcomes.push({ applicationId, outcome: 'MOVED', signupId: moved.moved.id, from });
    } catch (error) {
      if (error?.status === 409 && /already in this time slot/i.test(error.message)) {
        outcomes.push({ applicationId, outcome: 'ALREADY_HERE' });
        continue;
      }
      if (error?.status && error?.message) {
        outcomes.push({ applicationId, outcome: 'SKIPPED', reason: error.message });
        continue;
      }
      // Kept to this applicant. Throwing would report everyone as not added,
      // including the people already seated above, and skip their emails.
      console.error('[virtualCoffeeChats] could not place an applicant', error);
      outcomes.push({ applicationId, outcome: 'SKIPPED', reason: 'Could not be added; try again' });
    }
  }

  await notifyCandidates(toNotify);
  return outcomes;
}

/** Take one applicant out of a chat, and tell them. */
export async function removeApplicant(chatId, signupId, actorId, { cycleId } = {}) {
  const { slot } = await loadChat(chatId, cycleId);
  const signup = await prisma.interviewSlotSignup.findFirst({
    where: { id: signupId, slotId: slot.id },
    select: { id: true },
  });
  if (!signup) throw new SlotTransactionError(404, 'That applicant is not in this chat');

  await cancelSignup({ signupId, actorId, isAdmin: true, reason: 'Removed from a virtual coffee chat' });
  await notifyCandidates([{ signupId, type: 'CANCELLATION' }]);
  return { removed: true };
}

/**
 * Put members on a chat. Re-activates an earlier assignment rather than adding
 * a second row, as the session staffing endpoint does. Overlap with another
 * session is not refused: an admin scheduling a call by hand knows more than
 * the calendar does, and the coverage view already reports clashes.
 */
export async function addInterviewers(chatId, userIds, { cycleId } = {}) {
  const ids = [...new Set((userIds ?? []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return [];
  const { slot } = await loadChat(chatId, cycleId);

  const staff = await prisma.user.findMany({
    where: { id: { in: ids }, role: { in: ['MEMBER', 'ADMIN'] }, isActive: true },
    select: { id: true },
  });
  const staffIds = new Set(staff.map((u) => u.id));

  const outcomes = await prisma.$transaction(async (tx) => {
    // Holding the interview row while writing means a cancellation is either
    // already visible here, or waits and then sees these rows to take back.
    const [row] = await tx.$queryRaw`SELECT status FROM interviews WHERE id = ${slot.interviewId} FOR UPDATE`;
    if (!row || ['CANCELLED', 'COMPLETED'].includes(row.status)) {
      throw new SlotTransactionError(409, 'That virtual coffee chat has been cancelled or completed');
    }

    const existing = await tx.interviewSlotAssignment.findMany({
      where: { slotId: slot.id, userId: { in: ids } },
      select: { id: true, userId: true, removedAt: true },
    });
    const existingByUser = new Map(existing.map((r) => [r.userId, r]));

    const result = [];
    for (const userId of ids) {
      if (!staffIds.has(userId)) {
        result.push({ userId, outcome: 'SKIPPED', reason: 'Not an active member' });
        continue;
      }
      const prior = existingByUser.get(userId);
      if (prior && !prior.removedAt) {
        result.push({ userId, outcome: 'ALREADY_HERE' });
        continue;
      }
      if (prior) {
        await tx.interviewSlotAssignment.update({
          where: { id: prior.id },
          data: { removedAt: null, removedBy: null },
        });
      } else {
        await tx.interviewSlotAssignment.create({
          data: { slotId: slot.id, interviewId: slot.interviewId, userId },
        });
      }
      result.push({ userId, outcome: 'ASSIGNED' });
    }
    return result;
  });

  await notifyInterviewersBulk(
    outcomes.filter((o) => o.outcome === 'ASSIGNED').map((o) => ({ slotId: slot.id, userId: o.userId })),
    'INTERVIEWER_ASSIGNED'
  );
  return outcomes;
}

/** Take a member off a chat, and tell them. */
export async function removeInterviewer(chatId, assignmentId, actorId, { cycleId } = {}) {
  const { slot } = await loadChat(chatId, cycleId);
  const assignment = await prisma.interviewSlotAssignment.findFirst({
    where: { id: assignmentId, slotId: slot.id, removedAt: null },
    select: { id: true, userId: true },
  });
  if (!assignment) throw new SlotTransactionError(404, 'That member is not on this chat');

  await prisma.interviewSlotAssignment.update({
    where: { id: assignment.id },
    data: { removedAt: new Date(), removedBy: actorId },
  });
  await notifyInterviewer(slot.id, assignment.userId, 'INTERVIEWER_REMOVED');
  return { removed: true };
}

/**
 * Call a chat off. Everyone in it is told, and the interview is marked
 * CANCELLED rather than deleted, so any evaluation already written survives.
 *
 * Closed first, under the round lock, and only then is the roster read. Any
 * placement racing this one has either finished (and its seat is in the list)
 * or will see CANCELLED and be refused, so nobody is left booked into a call
 * that is not happening.
 */
export async function cancelVirtualCoffeeChat(chatId, actorId, { cycleId } = {}) {
  // An already-cancelled chat is let through: cancelling again finishes one
  // that stopped part way.
  const { interview, slot } = await loadChat(chatId, cycleId, { allowCancelled: true });

  const seats = await closeInterviewToBookings({ interviewId: interview.id, slotId: slot.id });
  if (!seats) throw new SlotTransactionError(409, 'That virtual coffee chat has already happened');

  // One seat failing must not stop the rest being released, and the ones that
  // were released are emailed either way.
  const cancelled = [];
  let failed = 0;
  for (const seat of seats) {
    try {
      await cancelSignup({ signupId: seat.id, actorId, isAdmin: true, reason: 'Virtual coffee chat cancelled' });
      cancelled.push({ signupId: seat.id, type: 'CANCELLATION' });
    } catch (error) {
      if (error?.status === 409 || error?.status === 404) continue;
      failed += 1;
      console.error('[virtualCoffeeChats] could not release a seat while cancelling', error);
    }
  }

  // Read after the status change, which waited on any interviewer add holding
  // the interview row, so this sees every assignment there will be.
  const staffed = await prisma.interviewSlotAssignment.findMany({
    where: { slotId: slot.id, removedAt: null },
    select: { userId: true },
  });
  await prisma.interviewSlotAssignment.updateMany({
    where: { slotId: slot.id, removedAt: null },
    data: { removedAt: new Date(), removedBy: actorId },
  });

  await notifyCandidates(cancelled);
  await notifyInterviewersBulk(
    staffed.map((row) => ({ slotId: slot.id, userId: row.userId })),
    'INTERVIEWER_REMOVED'
  );
  if (failed > 0) {
    throw new SlotTransactionError(
      500,
      `${failed} applicant${failed === 1 ? ' is' : 's are'} still booked into this cancelled chat. Cancel it again to finish.`
    );
  }
  return { cancelled: true, applicants: cancelled.length, interviewers: staffed.length };
}

/**
 * Queue and send candidate emails for signups that already exist. Best effort:
 * the seat is real whether or not the mail lands, and an unsent notification
 * shows up on the Interviews page with a Resend button.
 */
async function notifyCandidates(items) {
  if (!items?.length) return;
  try {
    const rows = await prisma.interviewSlotSignup.findMany({
      where: { id: { in: items.map((i) => i.signupId) } },
      select: {
        id: true,
        slotId: true,
        application: { select: { email: true } },
        slot: { select: { interview: { select: { title: true } } } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const formatters = new Map();
    const entries = [];
    for (const item of items) {
      const row = byId.get(item.signupId);
      if (!row?.application?.email) continue;
      if (!formatters.has(item.type)) formatters.set(item.type, await slotSubjectFormatter(item.type));
      entries.push({
        slotId: row.slotId,
        signupId: row.id,
        type: item.type,
        recipient: row.application.email,
        subject: formatters.get(item.type)(row.slot.interview.title),
      });
    }
    const ids = await queueNotificationsBulk(entries);
    flushNotifications(ids, candidateRender).catch((e) =>
      console.error('[virtualCoffeeChats] flush failed', e)
    );
  } catch (error) {
    console.error('[virtualCoffeeChats] notify failed', error);
  }
}
