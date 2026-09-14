// Calendar invites for recruitment events - info session, GTKUC, and the rest of the
// Events table.
//
// Events differ from interview sittings in two ways that shape what is possible here.
//
// First, the RSVP is not an app action. It is a Google Form, pulled in by the
// */5 * * * * cron in index.js, so the invite arrives minutes after somebody submits
// rather than on their request. That is fine for an invite - the time on it is what
// matters, not when it landed.
//
// Second, and more limiting: EventRsvp rows carry only createdAt, and nothing emails
// anyone when an admin edits or deletes an event. So this sends the first REQUEST and
// has no path to move or cancel it. The UID below is stable so that a future update
// path can amend the entry rather than duplicate it, but that path does not exist yet.

import { buildInvite, inviteUid } from './calendarInvite.js';

/** Events have no duration when eventEndDate is missing; treat them as an hour. */
const DEFAULT_EVENT_MINUTES = 60;

/**
 * Build an .ics for one person's place at one event, or null when there is nothing
 * to describe.
 *
 * Keyed on the event and the recipient, so a resent confirmation - the admin resend
 * button, or the sync seeing a response twice - amends the entry they already have
 * instead of adding a second.
 *
 * Deliberately audience-neutral: it knows an address and a name, not whether they
 * belong to a Candidate or a User. Only the candidate RSVP path calls it today,
 * because members get no event confirmation email yet. When the integrated member
 * RSVP form lands, hooking it up is one call with a member's address - see the note
 * beside memberEventRsvp.create in syncEventResponses.js. Nothing here needs to
 * change for that, and the UID scheme already keeps the two audiences apart, since
 * it keys on the address.
 *
 * Never throws. An RSVP that was recorded must not be reported as failed because its
 * invite could not be assembled.
 */
export function eventInviteFor({ event, recipientEmail, recipientName, method = 'REQUEST' }) {
  try {
    if (!event?.id || !event.eventStartDate || !recipientEmail) return null;

    const organizerEmail = (process.env.EMAIL_FROM ?? '').replace(/['"]/g, '').trim();
    if (!organizerEmail) return null;

    const start = new Date(event.eventStartDate);
    if (Number.isNaN(start.getTime())) return null;

    let end = event.eventEndDate ? new Date(event.eventEndDate) : null;
    if (!end || Number.isNaN(end.getTime()) || end <= start) {
      end = new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60_000);
    }

    return buildInvite({
      uid: inviteUid('event', `${event.id}-${String(recipientEmail).toLowerCase()}`),
      // Events have no updatedAt to key a sequence on, so use send time. Each resend
      // outranks the last, which is what a later amendment would need.
      sequence: Math.floor(Date.now() / 1000),
      method,
      start,
      end,
      summary: event.eventName ?? 'UConsulting Event',
      description: [
        event.eventName ? `UConsulting: ${event.eventName}` : null,
        event.eventLocation ? `Where: ${event.eventLocation}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      location: event.eventLocation ?? null,
      organizerEmail,
      attendeeEmail: recipientEmail,
      attendeeName: recipientName,
    });
  } catch (error) {
    console.warn('[eventInviteFor] could not build an event invite; sending without one', {
      eventId: event?.id,
      error: error?.message,
    });
    return null;
  }
}

export { DEFAULT_EVENT_MINUTES };
