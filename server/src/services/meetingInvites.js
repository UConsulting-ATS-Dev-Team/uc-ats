// Calendar invites for Get to Know UC meetings, attached to the emails in
// emailNotifications.js that announce a new slot, a signup, a move or a
// cancellation.
//
// Two calendar entries exist per slot, and they are keyed differently on purpose.
//
// The candidate's entry is keyed on their signup. A slot reschedule, and a
// candidate moving their booking to another slot (which keeps the signup row and
// changes its slotId), both move the entry they already have; a cancellation
// removes it. Invites sent before this keyed on (slot, address) instead, and a
// later change to one of those bookings adds a new entry beside the old one.
//
// The host's entry is keyed on the slot alone. It is created when the slot is
// (the "slot opened" email) and stands for the time the host has set aside, so
// it lives exactly as long as the slot does: each signup or cancellation re-sends
// it with the current attendee list, an empty list included, and only deleting
// the slot cancels it. A slot seats more than one candidate (capacity defaults
// to 2), and the host is at one meeting, not two.
//
// SEQUENCE is the send time in seconds, bumped past the last one issued so two
// changes to the same entry inside one second still order correctly.
// MeetingSignup has no updatedAt, and a signup or cancellation changes the
// host's entry without touching the slot row, so slot.updatedAt would not always
// increase. Seconds rather than milliseconds because RFC 5545 INTEGER is 32-bit.
//
// The host's attendee list is read from the database at send time, not from the
// slot the route loaded before its write, so a booking that lands in between is
// not dropped from it.
//
// Known gaps, all because no email goes out to the host to carry an update: a
// host moving or deleting their own slot, or removing one of their own signups,
// leaves their entry as it was, and an admin reassigning a slot to another host
// moves nothing. Slots opened before the "slot opened" email existed have no
// host entry until their first signup.

import prisma from '../prismaClient.js';
import { buildInvite, inviteUid, describeWhen, inviteOrganizerEmail } from './calendarInvite.js';

const SUMMARY = 'Get to Know UC';

let lastSequence = 0;

function nextSequence() {
  lastSequence = Math.max(Math.floor(Date.now() / 1000), lastSequence + 1);
  return lastSequence;
}

function joinLines(lines) {
  return lines.filter(Boolean).join('\n');
}

/**
 * The candidate's invite to one GTKUC slot, or null when it cannot be built.
 *
 * Never throws: a signup that was recorded must not be reported as failed because
 * its invite could not be assembled. The email still goes without it.
 */
export function candidateMeetingInvite({ slot, signupId, candidateEmail, candidateName, hostName, method = 'REQUEST' }) {
  try {
    const organizer = inviteOrganizerEmail();
    if (!slot?.id || !slot.startTime || !signupId || !candidateEmail || !organizer) return null;

    const when = describeWhen(slot.startTime, slot.endTime);
    return buildInvite({
      uid: inviteUid('gtkuc-signup', signupId),
      sequence: nextSequence(),
      method,
      start: slot.startTime,
      end: slot.endTime,
      summary: hostName ? `${SUMMARY} with ${hostName}` : SUMMARY,
      description: joinLines([
        hostName ? `Meeting with: ${hostName}` : null,
        when ? `When: ${when}` : null,
        slot.location ? `Where: ${slot.location}` : null,
        'Manage your booking at https://uconsultingats.com',
      ]),
      location: slot.location ?? null,
      organizerEmail: organizer,
      attendeeEmail: candidateEmail,
      attendeeName: candidateName,
    });
  } catch (error) {
    console.warn('[candidateMeetingInvite] could not build a calendar invite; sending without one', {
      slotId: slot?.id,
      error: error?.message,
    });
    return null;
  }
}

/**
 * The host's invite to one GTKUC slot, or null when it cannot be built.
 *
 * `attendeeNames` is everyone still booked after the change being announced -
 * read it with bookedNames. null (a failed read) means no invite. An empty list
 * is an open slot and still a REQUEST: the host set that time aside whether or
 * not anyone has booked it. Only method 'CANCEL', for a deleted slot, removes it.
 */
export function hostMeetingInvite({ slot, hostEmail, hostName, attendeeNames = [], method = 'REQUEST' }) {
  try {
    const organizer = inviteOrganizerEmail();
    if (!slot?.id || !slot.startTime || !hostEmail || !organizer || !attendeeNames) return null;

    const names = attendeeNames.filter(Boolean);
    const cancelling = method === 'CANCEL';
    const when = describeWhen(slot.startTime, slot.endTime);

    return buildInvite({
      uid: inviteUid('gtkuc-host', slot.id),
      sequence: nextSequence(),
      method: cancelling ? 'CANCEL' : 'REQUEST',
      start: slot.startTime,
      end: slot.endTime,
      summary: names.length ? `${SUMMARY}: ${names.join(', ')}` : `${SUMMARY} (open slot)`,
      description: joinLines([
        names.length ? `Candidates: ${names.join(', ')}` : 'No candidates booked yet.',
        when ? `When: ${when}` : null,
        slot.location ? `Where: ${slot.location}` : null,
        'Mark attendance afterwards at https://uconsultingats.com',
      ]),
      location: slot.location ?? null,
      organizerEmail: organizer,
      attendeeEmail: hostEmail,
      attendeeName: hostName,
    });
  } catch (error) {
    console.warn('[hostMeetingInvite] could not build a calendar invite; sending without one', {
      slotId: slot?.id,
      error: error?.message,
    });
    return null;
  }
}

/**
 * Names of everyone booked on a slot right now, for hostMeetingInvite.
 *
 * `excludingSignupId` drops a signup that is being cancelled but not yet deleted -
 * the cancellation routes email before they delete. Returns null on a failed read,
 * which callers pass straight through: better no invite than a CANCEL built from
 * a roster we could not see.
 */
export async function bookedNames(slotId, { excludingSignupId = null } = {}) {
  try {
    const signups = await prisma.meetingSignup.findMany({
      where: { slotId, ...(excludingSignupId ? { id: { not: excludingSignupId } } : {}) },
      select: { fullName: true },
      orderBy: { createdAt: 'asc' },
    });
    return signups.map((s) => s.fullName);
  } catch (error) {
    console.warn('[bookedNames] could not read the slot roster; sending without a host invite', {
      slotId,
      error: error?.message,
    });
    return null;
  }
}
