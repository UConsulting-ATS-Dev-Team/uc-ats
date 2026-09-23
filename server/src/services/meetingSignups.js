// Booking and moving a candidate's Get to Know UC meeting.
//
// The rule: one booking per candidate per recruiting cycle. Once they hold one,
// the way to a different time is to move it, not to book a second.
//
// Two routes book - POST /api/meeting-slots/:id/signup (the /meet page) and
// POST /api/my-meeting-signups (the candidate portal) - and each used to run its
// own copy of "look for an existing booking, check capacity, insert". Nothing
// held a lock across those steps, so two requests at once (a double-click, two
// tabs) both saw no booking and both inserted, and two candidates could both
// take the last seat. The email match was also exact, so a booking made with
// different capitalisation did not count.
//
// Both routes now come through here, and every booking and move runs inside a
// transaction holding two locks:
//   - an advisory lock on the candidate's lower-cased email, which serialises
//     everything one person does, so the one-per-cycle check and the insert
//     cannot interleave with their own second request;
//   - a row lock on the target slot, which serialises everyone taking a seat in
//     it, so the capacity check and the insert cannot interleave either.
// Both are transaction-scoped, which is also what makes them work through the
// pgbouncer transaction pooler on port 6543.

import prisma from '../prismaClient.js';
import { resolveCandidateCycle } from './activeCycle.js';
import {
  sendMeetingSignupConfirmation,
  sendMeetingSignupNotification,
  sendMeetingCancellationToMember,
  sendMeetingRescheduleEmail,
  sendMeetingCancellationEmail,
} from './emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from './meetingComms.js';
import { candidateMeetingInvite, hostMeetingInvite, bookedNames } from './meetingInvites.js';
import { MODIFY_CUTOFF_HOURS, canModify, cutoffMessage } from '../utils/schedulingWindows.js';

/** Carries the HTTP status and a machine-readable code for the route. */
export class BookingError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.name = 'BookingError';
    this.status = status;
    this.code = code;
  }
}

const HOST_FALLBACK = 'UC Consulting Member';

const formatDay = (date) =>
  new Date(date).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric' });

async function lockCandidate(tx, email) {
  const key = `gtkuc-booking:${String(email).toLowerCase()}`;
  // pg_advisory_xact_lock returns void, which Prisma cannot deserialise, so
  // select a constant from it instead.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${key}))`;
}

async function lockSlot(tx, slotId) {
  await tx.$queryRaw`SELECT id FROM meeting_slots WHERE id = ${slotId} FOR UPDATE`;
}

const inCycle = (startTime, cycle) => {
  if (!cycle || (!cycle.startDate && !cycle.endDate)) return true;
  const t = new Date(startTime).getTime();
  if (cycle.startDate && t < new Date(cycle.startDate).getTime()) return false;
  if (cycle.endDate && t > new Date(cycle.endDate).getTime()) return false;
  return true;
};

/**
 * The candidate's existing booking this cycle, if any. With no cycle dates to
 * scope by, any booking at all counts - the rule the routes have always used.
 */
async function findBookingThisCycle(tx, email, cycle, { excludingSignupId = null } = {}) {
  const signups = await tx.meetingSignup.findMany({
    where: {
      email: { equals: email, mode: 'insensitive' },
      ...(excludingSignupId ? { id: { not: excludingSignupId } } : {}),
    },
    include: { slot: { select: { startTime: true } } },
  });
  return signups.find((s) => inCycle(s.slot.startTime, cycle)) ?? null;
}

/** Lock the slot, then refuse it if it is gone, past, out of cycle or full. */
async function claimSeat(tx, slotId, cycle) {
  await lockSlot(tx, slotId);
  const slot = await tx.meetingSlot.findUnique({
    where: { id: slotId },
    include: { member: { select: { id: true, fullName: true, email: true } } },
  });
  if (!slot) throw new BookingError(404, 'Slot not found');
  if (new Date(slot.startTime).getTime() <= Date.now()) {
    throw new BookingError(400, 'This meeting has already started.');
  }
  if (!inCycle(slot.startTime, cycle)) {
    throw new BookingError(400, 'This slot is not open for booking this cycle.');
  }
  const taken = await tx.meetingSignup.count({ where: { slotId } });
  if (taken >= slot.capacity) throw new BookingError(409, 'This time slot is full', 'SLOT_FULL');
  return slot;
}

/**
 * Book `slotId` for the signed-in account. Throws BookingError; the route maps
 * it to a response. Emails are the caller's job, after this resolves - see
 * notifyMeetingBooked - so a send can never happen inside a transaction that
 * might still roll back.
 */
export async function bookMeetingSlot({ slotId, fullName, email, studentId }) {
  return prisma.$transaction(async (tx) => {
    await lockCandidate(tx, email);
    const cycle = await resolveCandidateCycle(tx);

    const existing = await findBookingThisCycle(tx, email, cycle);
    if (existing) {
      throw new BookingError(
        409,
        `You already have a meeting booked on ${formatDay(existing.slot.startTime)}. ` +
          'You can hold one per cycle - change the time of that one instead.',
        'ALREADY_BOOKED'
      );
    }

    const slot = await claimSeat(tx, slotId, cycle);
    const signup = await tx.meetingSignup.create({ data: { slotId, fullName, email, studentId } });
    return { signup, slot };
  });
}

/**
 * Move the caller's booking to another slot. The seat they hold is kept until
 * the new one is secured, so a full target leaves them exactly where they were.
 * `account` is req.user; ownership is checked here, not trusted from the route.
 */
export async function moveMeetingSignup({ signupId, slotId, account }) {
  if (!slotId) throw new BookingError(400, 'Pick a new time');

  return prisma.$transaction(async (tx) => {
    await lockCandidate(tx, account.email);

    const signup = await tx.meetingSignup.findUnique({
      where: { id: signupId },
      include: { slot: { include: { member: { select: { id: true, fullName: true, email: true } } } } },
    });
    if (!signup) throw new BookingError(404, 'Booking not found');
    if (signup.email.toLowerCase() !== String(account.email).toLowerCase()) {
      throw new BookingError(403, 'You can only change your own booking');
    }
    if (signup.slotId === slotId) throw new BookingError(400, 'You are already booked at that time.');
    // Checked inside the transaction: a request can queue across the boundary.
    if (!canModify(signup.slot.startTime, MODIFY_CUTOFF_HOURS)) {
      throw new BookingError(400, cutoffMessage('meeting'), 'CUTOFF');
    }

    const cycle = await resolveCandidateCycle(tx);
    // A booking left over from an earlier cycle could otherwise be moved in
    // beside the one they already hold this cycle.
    const other = await findBookingThisCycle(tx, account.email, cycle, { excludingSignupId: signupId });
    if (other) {
      throw new BookingError(
        409,
        `You already have a meeting booked on ${formatDay(other.slot.startTime)}. Change that one instead.`,
        'ALREADY_BOOKED'
      );
    }

    const to = await claimSeat(tx, slotId, cycle);
    const moved = await tx.meetingSignup.update({ where: { id: signupId }, data: { slotId } });
    return { signup: moved, from: signup.slot, to };
  });
}

/**
 * Cancel the caller's own booking, under the same candidate lock as booking and
 * moving. Without it a cancel could read the signup, lose the race to a move,
 * and then delete the moved row while telling the old slot's host.
 * Returns the deleted signup with the slot it was in.
 */
export async function cancelOwnMeetingSignup({ signupId, account }) {
  return prisma.$transaction(async (tx) => {
    await lockCandidate(tx, account.email);

    const signup = await tx.meetingSignup.findUnique({
      where: { id: signupId },
      include: { slot: { include: { member: { select: { id: true, fullName: true, email: true } } } } },
    });
    if (!signup) throw new BookingError(404, 'Booking not found');
    if (signup.email.toLowerCase() !== String(account.email).toLowerCase()) {
      throw new BookingError(403, 'You can only cancel your own booking');
    }
    if (!canModify(signup.slot.startTime, MODIFY_CUTOFF_HOURS)) {
      throw new BookingError(400, cutoffMessage('meeting'), 'CUTOFF');
    }

    await tx.meetingSignup.delete({ where: { id: signupId } });
    return signup;
  });
}

/**
 * Turn a refused delivery back into a throw, so sendAndLogMeetingCommunication
 * logs it FAILED rather than SENT. The senders resolve { success: false }.
 */
const sendOrThrow = async (send) => {
  const result = await send();
  if (result && result.success === false) throw new Error(result.error || 'email send failed');
  return result;
};

/** Confirmation to the candidate and a heads-up to the host, each logged. */
export async function notifyMeetingBooked({ signup, slot }) {
  const hostName = slot.member?.fullName || HOST_FALLBACK;

  await sendAndLogMeetingCommunication(
    () => sendOrThrow(() => sendMeetingSignupConfirmation(
      signup.email, signup.fullName, hostName, slot.location, slot.startTime, slot.endTime,
      {
        invite: candidateMeetingInvite({
          slot, signupId: signup.id, candidateEmail: signup.email, candidateName: signup.fullName, hostName,
        }),
      }
    )),
    { slotId: slot.id, signupId: signup.id, type: 'CONFIRMATION', recipient: signup.email, subject: MEETING_COMM_SUBJECTS.CONFIRMATION }
  );

  if (slot.member?.email) {
    const attendees = await bookedNames(slot.id);
    await sendAndLogMeetingCommunication(
      () => sendOrThrow(() => sendMeetingSignupNotification(
        slot.member.email, hostName, signup.fullName, signup.email, signup.studentId,
        slot.location, slot.startTime, slot.endTime,
        { invite: hostMeetingInvite({ slot, hostEmail: slot.member.email, hostName, attendeeNames: attendees }) }
      )),
      {
        slotId: slot.id, signupId: signup.id, type: 'HOST_NOTIFICATION', recipient: slot.member.email,
        subject: MEETING_COMM_SUBJECTS.HOST_NOTIFICATION(signup.fullName),
      }
    );
  }
}

/**
 * After a move: the candidate gets the reschedule notice, whose invite moves
 * their existing calendar entry (it is keyed on the signup, which a move keeps);
 * the old host hears the seat opened; the new host hears who is coming.
 */
export async function notifyMeetingMoved({ signup, from, to }) {
  const toHost = to.member?.fullName || HOST_FALLBACK;
  const fromHost = from.member?.fullName || HOST_FALLBACK;
  const meeting = (slot) => ({ location: slot.location, startTime: slot.startTime, endTime: slot.endTime });

  await sendAndLogMeetingCommunication(
    () => sendOrThrow(() => sendMeetingRescheduleEmail(
      signup.email, signup.fullName, toHost, meeting(to), meeting(from),
      {
        invite: candidateMeetingInvite({
          slot: to, signupId: signup.id, candidateEmail: signup.email, candidateName: signup.fullName, hostName: toHost,
        }),
      }
    )),
    { slotId: to.id, signupId: signup.id, type: 'RESCHEDULED', recipient: signup.email, subject: MEETING_COMM_SUBJECTS.RESCHEDULED }
  );

  if (from.member?.email) {
    const remaining = await bookedNames(from.id);
    await sendAndLogMeetingCommunication(
      () => sendOrThrow(() => sendMeetingCancellationToMember(
        from.member.email, fromHost, from.location, from.startTime, from.endTime,
        {
          candidateName: signup.fullName,
          invite: hostMeetingInvite({ slot: from, hostEmail: from.member.email, hostName: fromHost, attendeeNames: remaining }),
        }
      )),
      { slotId: from.id, signupId: null, type: 'CANCELLATION', recipient: from.member.email, subject: MEETING_COMM_SUBJECTS.CANCELLATION_TO_HOST }
    );
  }

  if (to.member?.email) {
    const attendees = await bookedNames(to.id);
    await sendAndLogMeetingCommunication(
      () => sendOrThrow(() => sendMeetingSignupNotification(
        to.member.email, toHost, signup.fullName, signup.email, signup.studentId,
        to.location, to.startTime, to.endTime,
        { invite: hostMeetingInvite({ slot: to, hostEmail: to.member.email, hostName: toHost, attendeeNames: attendees }) }
      )),
      {
        slotId: to.id, signupId: signup.id, type: 'HOST_NOTIFICATION', recipient: to.member.email,
        subject: MEETING_COMM_SUBJECTS.HOST_NOTIFICATION(signup.fullName),
      }
    );
  }
}

/**
 * After a candidate cancels: they get the cancellation, whose invite removes
 * their calendar entry, and the host hears the seat opened. Logged against the
 * slot; the signup row is gone, so the logs carry no signupId.
 */
export async function notifyMeetingCancelled({ signup }) {
  const { slot } = signup;
  const hostName = slot.member?.fullName || HOST_FALLBACK;

  await sendAndLogMeetingCommunication(
    () => sendOrThrow(() => sendMeetingCancellationEmail(
      signup.email, signup.fullName, hostName, slot.location, slot.startTime, slot.endTime,
      {
        invite: candidateMeetingInvite({
          slot, signupId: signup.id, candidateEmail: signup.email, candidateName: signup.fullName, hostName,
          method: 'CANCEL',
        }),
      }
    )),
    { slotId: slot.id, signupId: null, type: 'CANCELLATION', recipient: signup.email, subject: MEETING_COMM_SUBJECTS.CANCELLATION }
  );

  if (slot.member?.email) {
    const remaining = await bookedNames(slot.id);
    await sendAndLogMeetingCommunication(
      () => sendOrThrow(() => sendMeetingCancellationToMember(
        slot.member.email, hostName, slot.location, slot.startTime, slot.endTime,
        {
          candidateName: signup.fullName,
          invite: hostMeetingInvite({ slot, hostEmail: slot.member.email, hostName, attendeeNames: remaining }),
        }
      )),
      { slotId: slot.id, signupId: null, type: 'CANCELLATION', recipient: slot.member.email, subject: MEETING_COMM_SUBJECTS.CANCELLATION_TO_HOST }
    );
  }
}
