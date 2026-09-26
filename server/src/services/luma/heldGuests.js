// What counts as a Luma guest the sync could not settle.
//
// One definition, because two places ask the question and they must not drift:
// the event list counts held guests per event (admin.js `/events/:id/stats`, so
// a badge can appear without opening a panel per row), and the panel itself
// lists them (routes/lumaAdmin.js).
//
// Three things put a guest on hold, and a guest can be on hold for more than one
// at a time - which is why `holdsFor` returns a list, and why the counts add up
// to more than the number of guests:
//
//   - **unmatched** — no candidate or member has that email and there was no
//     usable UID, so the ATS does not know who came. Nothing was written for
//     them at all.
//   - **flagged** — the UID answered but the guest's Luma profile name shares no
//     name with the record it points at. The match was made; this asks someone
//     to confirm it was the right one.
//   - **unknownStatus** — Luma sent an approval_status ingestGuests will not
//     read as going or not going, so the guest's RSVP row was left exactly as it
//     was rather than guessed at in either direction.
import { READABLE_APPROVAL_STATUSES } from './ingestGuests.js';

/** A Prisma `where` fragment: any one of the three holds. */
export const LUMA_HELD = {
  OR: [
    { matchStatus: 'UNMATCHED' },
    { matchNote: { not: null } },
    { approvalStatus: { notIn: READABLE_APPROVAL_STATUSES } }
  ]
};

/** Which of the three apply to one guest row, for the panel to explain itself. */
export function holdsFor(guest) {
  const holds = [];
  if (guest.matchStatus === 'UNMATCHED') holds.push('unmatched');
  if (guest.matchNote) holds.push('flagged');
  if (!READABLE_APPROVAL_STATUSES.includes(guest.approvalStatus)) holds.push('unknownStatus');
  return holds;
}
