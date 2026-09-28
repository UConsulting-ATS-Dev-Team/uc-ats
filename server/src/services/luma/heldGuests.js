// What counts as a Luma guest the sync could not settle.
//
// One definition, because two places ask the question and they must not drift:
// the event list counts held guests per event (admin.js `/events/:id/stats`, so
// a badge can appear without opening a panel per row), and the panel itself
// lists them (routes/lumaAdmin.js).
//
// Two things put a guest on hold, and a guest can be on hold for both at once -
// which is why `holdsFor` returns a list, and why the counts can add up to more
// than the number of guests:
//
//   - **flagged** — the UID answered but the guest's Luma profile name shares no
//     name with the record it points at. The match was made; this asks someone
//     to confirm it was the right one.
//   - **unknownStatus** — Luma sent an approval_status ingestGuests will not
//     read as going or not going, so the guest's RSVP row was left exactly as it
//     was rather than guessed at in either direction.
//
// An UNMATCHED guest is deliberately not a hold. It is someone with no profile
// in the ATS yet, not a question for an admin: form sync links them the moment
// their application arrives (claimLumaGuestsForCandidate).
import { READABLE_APPROVAL_STATUSES } from './ingestGuests.js';

/** A Prisma `where` fragment: either hold. */
export const LUMA_HELD = {
  matchStatus: { not: 'UNMATCHED' },
  OR: [
    { matchNote: { not: null } },
    { approvalStatus: { notIn: READABLE_APPROVAL_STATUSES } }
  ]
};

/** Which holds apply to one guest row, for the panel to explain itself. */
export function holdsFor(guest) {
  const holds = [];
  if (guest.matchStatus === 'UNMATCHED') return holds;
  if (guest.matchNote) holds.push('flagged');
  if (!READABLE_APPROVAL_STATUSES.includes(guest.approvalStatus)) holds.push('unknownStatus');
  return holds;
}
