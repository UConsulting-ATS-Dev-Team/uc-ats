// iCalendar (RFC 5545) invitations, attached to the emails that already announce a
// booking.
//
// Why an .ics attachment rather than the Google Calendar API: inviting attendees
// through a service account requires Workspace domain-wide delegation, which this
// deployment does not have (services/google/auth.js does no `subject:` impersonation).
// An attachment needs no Google admin involvement and lands on Apple and Outlook too.
// services/google/calendar.js still exists for publishing an attendee-less copy to a
// shared team calendar; that is a different job from telling one person about one seat.
//
// The contract that makes updates work: a stable UID per (entity, recipient) plus a
// SEQUENCE that only ever increases. Same UID + higher SEQUENCE moves the existing
// entry; a new UID would leave the old one sitting on their calendar. This is what
// makes an admin moving a signup, or a waitlist promotion, behave correctly.

import { formatEmailDateTime, formatEmailTime, TIMEZONE } from '../utils/timezoneUtils.js';

/** Used when a slot carries no end time - MeetingSlot.endTime is nullable. */
const DEFAULT_DURATION_MINUTES = 30;

/** Right-hand side of every UID, so one calendar can hold invites from both. */
const UID_DOMAIN = 'uconsultingats.com';

/**
 * Escape a value for a text property. Backslash first, or it would double-escape the
 * separators added after it. Colons are deliberately not escaped - RFC 5545 only
 * requires it inside structured values, and escaping them breaks Outlook's parser on
 * a LOCATION that contains a URL.
 */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold to 75 octets per RFC 5545. Counted in UTF-8 bytes rather than characters, and
 * never split mid-character: a continuation that begins half an emoji is what makes a
 * calendar client reject the whole file.
 */
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts = [];
  let cursor = 0;
  // 75 for the first line, 74 for continuations - the leading space costs an octet.
  let budget = 75;
  while (cursor < bytes.length) {
    let take = Math.min(budget, bytes.length - cursor);
    // Walk back off a continuation byte (10xxxxxx) so a multi-byte char stays whole.
    while (take > 0 && (bytes[cursor + take] & 0xc0) === 0x80) take -= 1;
    if (take <= 0) take = Math.min(budget, bytes.length - cursor);
    parts.push(bytes.subarray(cursor, cursor + take).toString('utf8'));
    cursor += take;
    budget = 74;
  }
  return parts.join('\r\n ');
}

/** RFC 5545 UTC form: 20260914T173000Z. */
function toIcsUtc(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * SEQUENCE from a row's updatedAt, as whole seconds.
 *
 * Monotonic without a schema column, which matters here: migrations on this project
 * are hand-applied (see CLAUDE.md on the stale DIRECT_URL), so avoiding one is worth
 * something. Every row we build an invite from - InterviewSlotSignup, InterviewSlot,
 * MeetingSlot - has updatedAt.
 */
export function sequenceFrom(updatedAt) {
  if (!updatedAt) return 0;
  const ms = new Date(updatedAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

/** Stable UID for one recipient's view of one scheduled thing. */
export function inviteUid(kind, id) {
  return `${kind}-${id}@${UID_DOMAIN}`;
}

/**
 * Human-readable "when" line, reused in the invite description so the body of the
 * calendar entry says the same thing the email does. Times are rendered in LA, which
 * is the only timezone this system schedules in.
 */
export function describeWhen(start, end) {
  if (!start) return '';
  const opening = formatEmailDateTime(start);
  return end ? `${opening} - ${formatEmailTime(end)}` : opening;
}

/**
 * Build an .ics attachment for nodemailer, or null when there is nothing to describe.
 *
 * Returns null rather than throwing: a booking that succeeded must not be reported as
 * failed because its invite could not be built. The email still goes.
 *
 * @param {object}  args
 * @param {string}  args.uid            Stable per (entity, recipient). See inviteUid.
 * @param {number}  args.sequence       Only ever increases. See sequenceFrom.
 * @param {'REQUEST'|'CANCEL'} args.method
 * @param {Date}    args.start
 * @param {Date}   [args.end]           Defaults to start + DEFAULT_DURATION_MINUTES.
 * @param {string}  args.summary        Calendar entry title.
 * @param {string} [args.description]
 * @param {string} [args.location]
 * @param {string}  args.organizerEmail
 * @param {string} [args.organizerName]
 * @param {string}  args.attendeeEmail
 * @param {string} [args.attendeeName]
 */
export function buildInvite({
  uid,
  sequence = 0,
  method = 'REQUEST',
  start,
  end,
  summary,
  description,
  location,
  organizerEmail,
  organizerName = 'UConsulting',
  attendeeEmail,
  attendeeName,
}) {
  if (!uid || !start || !organizerEmail || !attendeeEmail) return null;

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return null;

  let endDate = end ? new Date(end) : null;
  if (!endDate || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    endDate = new Date(startDate.getTime() + DEFAULT_DURATION_MINUTES * 60_000);
  }

  const cancelling = method === 'CANCEL';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UConsulting//ATS//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(uid)}`,
    `SEQUENCE:${Math.max(0, Math.floor(sequence))}`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(startDate)}`,
    `DTEND:${toIcsUtc(endDate)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];

  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);

  lines.push(
    `ORGANIZER;CN=${escapeText(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=${
      cancelling ? 'FALSE' : 'TRUE'
    }${attendeeName ? `;CN=${escapeText(attendeeName)}` : ''}:mailto:${attendeeEmail}`,
    `STATUS:${cancelling ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  );

  const content = `${lines.map(foldLine).join('\r\n')}\r\n`;

  return {
    filename: 'invite.ics',
    content,
    // The method must appear on the part's content type as well as inside the body,
    // or Gmail renders the file as a download instead of an RSVP card.
    contentType: `text/calendar; charset=utf-8; method=${method}`,
  };
}

/**
 * The address every invite names as its ORGANIZER.
 *
 * A calendar sends RSVP replies (Accepted / Declined) to the organizer. Invites
 * used to name EMAIL_FROM, no-reply@uconsultingats.com, and that domain has no
 * mail server, so every Yes or No a recipient clicked bounced back to them two
 * days later as "Message not delivered". EMAIL_REPLY_TO is the inbox people are
 * already meant to reach us at, so RSVPs land there. EMAIL_FROM is the fallback
 * for a deployment that has no reply-to set.
 */
export function inviteOrganizerEmail() {
  const clean = (value) => (value ?? '').replace(/['"]/g, '').trim();
  return clean(process.env.EMAIL_REPLY_TO) || clean(process.env.EMAIL_FROM);
}

export { DEFAULT_DURATION_MINUTES, TIMEZONE };
