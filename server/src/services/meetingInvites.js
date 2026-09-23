// Calendar invites for Get to Know UC meetings, attached to the emails in
// emailNotifications.js that already announce a signup, a move or a cancellation.
//
// Two calendar entries exist per slot, and they are keyed differently on purpose.
//
// The candidate's entry is keyed on (slot, their address) - the same pair
// MeetingSignup is unique on - so a reschedule moves the entry they already have
// and a cancellation removes it.
//
// The host's entry is keyed on the slot alone. A slot seats more than one
// candidate (capacity defaults to 2), and the host is at one meeting, not two.
// So each signup re-sends the same entry with the attendee list updated, and a
// single candidate cancelling only removes it when nobody else is still booked -
// otherwise the host would lose the meeting from their calendar while someone is
// still coming. hostMeetingInvite decides that from `attendeeNames`.
//
// SEQUENCE is the send time, as eventInvites.js does it. MeetingSignup has no
// updatedAt, and a signup or cancellation changes the host's entry without
// touching the slot row, so slot.updatedAt would not always increase.
//
// Known gaps, all because no email goes out to the host to carry an update: a
// host moving or deleting their own slot, or removing one of their own signups,
// leaves their entry as it was, and an admin reassigning a slot to another host
// moves nothing.

import { buildInvite, inviteUid, describeWhen } from './calendarInvite.js';

const SUMMARY = 'Get to Know UC';

function organizerEmail() {
  return (process.env.EMAIL_FROM ?? '').replace(/['"]/g, '').trim();
}

function sequenceNow() {
  return Math.floor(Date.now() / 1000);
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
export function candidateMeetingInvite({ slot, candidateEmail, candidateName, hostName, method = 'REQUEST' }) {
  try {
    const organizer = organizerEmail();
    if (!slot?.id || !slot.startTime || !candidateEmail || !organizer) return null;

    const when = describeWhen(slot.startTime, slot.endTime);
    return buildInvite({
      uid: inviteUid('gtkuc', `${slot.id}-${String(candidateEmail).toLowerCase()}`),
      sequence: sequenceNow(),
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
 * `attendeeNames` is everyone still booked after the change being announced. An
 * empty list turns a REQUEST into a CANCEL, which is what makes "the last
 * candidate cancelled" clear the entry and "one of two cancelled" keep it.
 * Pass method 'CANCEL' directly when the slot itself is gone.
 */
export function hostMeetingInvite({ slot, hostEmail, hostName, attendeeNames = [], method = 'REQUEST' }) {
  try {
    const organizer = organizerEmail();
    if (!slot?.id || !slot.startTime || !hostEmail || !organizer) return null;

    const names = attendeeNames.filter(Boolean);
    const cancelling = method === 'CANCEL' || names.length === 0;
    const when = describeWhen(slot.startTime, slot.endTime);

    return buildInvite({
      uid: inviteUid('gtkuc-host', slot.id),
      sequence: sequenceNow(),
      method: cancelling ? 'CANCEL' : 'REQUEST',
      start: slot.startTime,
      end: slot.endTime,
      summary: names.length ? `${SUMMARY}: ${names.join(', ')}` : SUMMARY,
      description: joinLines([
        names.length ? `Candidates: ${names.join(', ')}` : null,
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
