// Turns Luma guests into ATS event rows.
//
// The hourly sync routine (docs/luma-integration-plan.md) reads guests with the
// Luma MCP connector and hands them here one page at a time, exactly as
// list_guests returns them. Everything that decides *who* a guest is happens in
// this file, deterministically; the routine only relays.
//
// Each guest is reconciled rather than appended: the rows a guest should have
// (an RSVP if approved, attendance if checked in) are made to exist, and any
// Luma row for that guest that should not exist is removed. That is what makes a
// re-run of the same page a no-op, and what lets a declined guest or an undone
// check-in take their row back out. Rows written by the Google Form sync are
// never removed here; a person who answered both counts once.
//
// Because a guest can take rows away as well as add them, an entry this file
// cannot read is rejected rather than interpreted: only a value we recognise is
// allowed to mean "no longer approved" or "no longer checked in".
//
// No ATS confirmation emails go out for these rows: Luma already sent its own.
import prisma from '../../prismaClient.js';

// The UID question is found by its label, because Luma gives every question a
// fresh id per event.
const UID_LABEL = /\buid\b/i;
const UID_DIGITS = /^\d{9}$/;
export const MEMBER_ROLES = ['MEMBER', 'ADMIN'];

// Which approval_status values say the person is coming, and which say they are
// not. The keys are list_guests's own approval_status filter enum, minus
// `session`: that one is real (a guest of an event's session) but not something
// we have established means going or not going, and Luma can add more.
//
// A status that is not here is not a guess to be made in either direction - it
// neither creates an RSVP nor removes one, so the row stays exactly as it is and
// ingestGuests reports the guest in `summary.unknownStatus`. Reading an unknown
// status as "not approved" would delete live RSVPs the first time Luma extended
// the vocabulary; rejecting the whole entry would instead hide the guest, and
// leave any stale row of theirs both wrong and invisible.
const RSVP_FOR_STATUS = new Map([
  ['approved', true],
  ['declined', false],
  ['pending_approval', false],
  ['invited', false],
  ['waitlist', false]
]);

// The statuses above, for callers that need to ask the database which guests
// are being held because their status could not be read (the admin panel).
export const READABLE_APPROVAL_STATUSES = [...RSVP_FOR_STATUS.keys()];

export const MATCH_STATUS = {
  MATCHED_CANDIDATE: 'MATCHED_CANDIDATE',
  CREATED_CANDIDATE: 'CREATED_CANDIDATE',
  MATCHED_MEMBER: 'MATCHED_MEMBER',
  UNMATCHED: 'UNMATCHED'
};

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      label: text(a.label),
      answer: a.answer ?? a.value ?? null,
      questionId: typeof a.question_id === 'string' ? a.question_id : null,
      questionType: typeof a.question_type === 'string' ? a.question_type : null
    }));
}

/**
 * The guest's UID, or why there isn't a usable one. Whatever the guest typed is
 * kept in `raw`, so an admin can see "40512345" and fix it by hand.
 */
export function extractUid(answers) {
  const answer = answers.find((a) => UID_LABEL.test(a.label));
  if (!answer || answer.answer == null || String(answer.answer).trim() === '') {
    return { uid: null, raw: null, problem: 'no UID answer' };
  }
  const raw = String(answer.answer).trim();
  const digits = raw.replace(/\D/g, '');
  if (!UID_DIGITS.test(digits)) {
    return { uid: null, raw, problem: `UID "${raw}" is not 9 digits` };
  }
  return { uid: digits, raw, problem: null };
}

/**
 * Luma only collects first and last names separately on Luma Plus, so most
 * guests have one profile name. Prefer the split fields when Luma has them;
 * otherwise split at the last space. The last name may legitimately be empty.
 */
export function splitName(entry) {
  const first = text(entry.user_first_name);
  if (first) {
    return { firstName: first, lastName: text(entry.user_last_name) };
  }
  const full = text(entry.user_name) || text(entry.name);
  if (!full) {
    const email = text(entry.user_email) || text(entry.email);
    return { firstName: email.split('@')[0], lastName: '' };
  }
  const cut = full.lastIndexOf(' ');
  if (cut === -1) return { firstName: full, lastName: '' };
  return { firstName: full.slice(0, cut).trim(), lastName: full.slice(cut + 1).trim() };
}

/**
 * When the guest was scanned in: a door scan marks the ticket, and the
 * guest-level field is usually set too, so the earliest of either counts.
 *
 * Returns `{ at }` - a Date, or null for a guest nobody scanned - or
 * `{ invalid }`. A time that cannot be read is not the same as an absent one:
 * an absent one removes this guest's attendance row, so a value we failed to
 * parse would take a real check-in back out.
 */
export function checkedInAtOf(entry) {
  const tickets = Array.isArray(entry.event_tickets) ? entry.event_tickets : [];
  const times = [];
  for (const value of [entry.checked_in_at, ...tickets.map((t) => t?.checked_in_at)]) {
    if (value == null || value === '') continue;
    const date = parseDate(value);
    if (!date) return { invalid: String(value) };
    times.push(date);
  }
  times.sort((a, b) => a - b);
  return { at: times[0] ?? null };
}

// The copy kept in luma_guests.raw: everything list_guests sent, minus the
// nested `guest` / `event_ticket` duplicates and the check-in QR link, which
// carries the key that checks the guest in.
function rawCopy(entry) {
  const { guest, event_ticket, check_in_qr_code, ...rest } = entry;
  return rest;
}

/**
 * Validates one list_guests entry and pulls out what matching needs. Unknown
 * fields are ignored. Returns { guest } or { problem }.
 */
export function parseGuest(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { problem: 'not an object' };
  }
  const lumaGuestId = text(entry.api_id) || text(entry.id);
  if (!/^gst-[A-Za-z0-9]+$/.test(lumaGuestId)) {
    return { problem: 'missing or malformed guest id' };
  }
  const email = (text(entry.user_email) || text(entry.email)).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { problem: `guest ${lumaGuestId} has no usable email` };
  }
  const approvalStatus = text(entry.approval_status).toLowerCase();
  if (!approvalStatus) {
    return { problem: `guest ${lumaGuestId} has no approval_status` };
  }
  // A status we do not recognise is kept as Luma sent it and held at
  // reconciliation (RSVP_FOR_STATUS); only a malformed entry is rejected here.
  const checkedIn = checkedInAtOf(entry);
  if (checkedIn.invalid !== undefined) {
    return { problem: `guest ${lumaGuestId} has an unreadable check-in time "${checkedIn.invalid}"` };
  }

  const answers = normalizeAnswers(entry.registration_answers);
  const { firstName, lastName } = splitName(entry);
  const uid = extractUid(answers);

  return {
    guest: {
      lumaGuestId,
      email,
      name: text(entry.user_name) || text(entry.name) || `${firstName} ${lastName}`.trim(),
      firstName,
      lastName,
      approvalStatus,
      registeredAt: parseDate(entry.registered_at),
      checkedInAt: checkedIn.at,
      joinedAt: parseDate(entry.joined_at),
      uid: uid.uid,
      uidProblem: uid.problem,
      rawAnswers: answers,
      raw: rawCopy(entry)
    }
  };
}

const insensitive = (value) => ({ equals: value, mode: 'insensitive' });

// Name pieces, compared with case, spacing and punctuation removed, so
// "O'Brien", "OBrien" and "o brien" are the same piece.
const nameKey = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const nameParts = (...values) => values
  .flatMap((value) => String(value ?? '').split(/\s+/))
  .map(nameKey)
  .filter(Boolean);

/**
 * Whether the Luma profile name corroborates a record found by UID alone, or a
 * note saying it doesn't.
 *
 * The UID is free text the guest types, so it is the one input that can file
 * somebody as someone else. An email the ATS already knows settles who
 * registered (see resolvePerson); where it doesn't, the name is the only second
 * opinion there is. One first or last name in common is enough - a nickname or
 * a handle is not fraud - so a guest whose name says nothing is still matched,
 * but carries a note that the summary and the Phase 3 panel can show.
 */
function uidOnlyNote(guest, person) {
  const theirs = new Set(nameParts(person.firstName, person.lastName, person.fullName));
  if (nameParts(guest.firstName, guest.lastName).some((part) => theirs.has(part))) return null;
  return `matched on the UID ${guest.uid} alone: ${guest.email} is not in the ATS, `
    + `and "${guest.name}" does not look like the record that UID points at`;
}

/**
 * Who this guest is. A match made on an earlier sync (or by an admin, by hand)
 * is kept, so it is only ever decided once; an UNMATCHED guest is retried every
 * time, since they may have applied since.
 *
 * The email is Luma's own - it is the address they registered and were mailed
 * at. The UID is an answer they typed, and nothing stops anyone typing somebody
 * else's. So the email decides wherever the ATS knows it, and the UID answers
 * only for an address the ATS has never seen, which is the case it exists for:
 * most people register with a personal address rather than the one on their
 * application.
 */
async function resolvePerson(tx, guest, previous) {
  if (previous?.userId) {
    return { userId: previous.userId, matchStatus: previous.matchStatus, matchNote: previous.matchNote };
  }
  if (previous?.candidateId) {
    return { candidateId: previous.candidateId, matchStatus: previous.matchStatus, matchNote: previous.matchNote };
  }

  const memberByEmail = await tx.user.findFirst({
    where: { email: insensitive(guest.email), role: { in: MEMBER_ROLES } }
  });
  if (memberByEmail) {
    return { userId: memberByEmail.id, matchStatus: MATCH_STATUS.MATCHED_MEMBER, matchNote: null };
  }

  const candidateByEmail = await tx.candidate.findFirst({ where: { email: insensitive(guest.email) } });
  if (candidateByEmail) {
    return { candidateId: candidateByEmail.id, matchStatus: MATCH_STATUS.MATCHED_CANDIDATE, matchNote: null };
  }

  if (guest.uid) {
    const memberByUid = await tx.user.findFirst({
      where: { studentId: guest.uid, role: { in: MEMBER_ROLES } }
    });
    if (memberByUid) {
      return {
        userId: memberByUid.id,
        matchStatus: MATCH_STATUS.MATCHED_MEMBER,
        matchNote: uidOnlyNote(guest, memberByUid)
      };
    }
    const candidateByUid = await tx.candidate.findUnique({ where: { studentId: guest.uid } });
    if (candidateByUid) {
      return {
        candidateId: candidateByUid.id,
        matchStatus: MATCH_STATUS.MATCHED_CANDIDATE,
        matchNote: uidOnlyNote(guest, candidateByUid)
      };
    }
  }

  // A new Candidate needs a studentId, which is required and unique, so a guest
  // without a usable UID waits for an admin instead of becoming a half-record.
  if (!guest.uid) {
    return { matchStatus: MATCH_STATUS.UNMATCHED, matchNote: `${guest.uidProblem}; no candidate or member with ${guest.email}` };
  }
  const created = await tx.candidate.create({
    data: {
      studentId: guest.uid,
      email: guest.email,
      firstName: guest.firstName,
      lastName: guest.lastName
    }
  });
  return { candidateId: created.id, matchStatus: MATCH_STATUS.CREATED_CANDIDATE, matchNote: null };
}

const isUniqueViolation = (error) => error?.code === 'P2002';

/**
 * Makes sure `person` has a row on this event, and that the row this guest wrote
 * (if any) belongs to them. If some other row already covers the person, a
 * Google Form response for instance, that one stands and nothing is written.
 */
async function ensureRow(model, { eventId, personField, personId, lumaGuestId }) {
  const compoundKey = `eventId_${personField}`;
  const mine = await model.findUnique({ where: { lumaGuestId } });
  if (mine && mine[personField] === personId) return 'unchanged';
  if (mine) await model.delete({ where: { id: mine.id } });

  const existing = await model.findUnique({
    where: { [compoundKey]: { eventId, [personField]: personId } }
  });
  if (existing) return mine ? 'removed' : 'unchanged';

  try {
    await model.create({
      data: { eventId, [personField]: personId, source: 'LUMA', lumaGuestId }
    });
  } catch (error) {
    // Another writer got the same person onto the event in between.
    if (isUniqueViolation(error)) return 'unchanged';
    throw error;
  }
  return 'created';
}

async function removeRow(model, lumaGuestId) {
  const { count } = await model.deleteMany({ where: { lumaGuestId } });
  return count > 0 ? 'removed' : 'unchanged';
}

/**
 * Whether a member is marked present at the door.
 *
 * member_event_attendance predates Luma: it keys on (event, member) with a free
 * text source and has no lumaGuestId, so a row cannot say which guest put it
 * there. It is therefore settled from every guest of this event at once - the
 * member is present if any guest resolving to them is checked in - rather than
 * per guest, which would let a member who registered twice lose their check-in
 * to whichever of the two registrations this page happened to reach last.
 *
 * Only rows marked 'LUMA' are ever removed, so a MANUAL mark from the
 * accountability page is never touched.
 */
async function reconcileMemberAttendance(tx, eventId, memberId) {
  const checkedIn = await tx.lumaGuest.findFirst({
    where: { eventId, userId: memberId, checkedInAt: { not: null } }
  });

  if (!checkedIn) {
    const { count } = await tx.memberEventAttendance.deleteMany({
      where: { eventId, memberId, source: 'LUMA' }
    });
    return count > 0 ? 'removed' : 'unchanged';
  }

  const existing = await tx.memberEventAttendance.findUnique({
    where: { eventId_memberId: { eventId, memberId } }
  });
  if (existing) return 'unchanged';
  try {
    await tx.memberEventAttendance.create({ data: { eventId, memberId, source: 'LUMA' } });
  } catch (error) {
    if (isUniqueViolation(error)) return 'unchanged';
    throw error;
  }
  return 'created';
}

/**
 * Settles one guest's rows from what Luma says about them and who the ATS
 * decided they are. Exported because an admin linking an UNMATCHED guest by
 * hand has to reach the same end state as a sync would (services/luma/linkGuest.js):
 * the rows follow from the match, so changing the match has to re-run this.
 *
 * `guest` needs only lumaGuestId, approvalStatus and checkedInAt, which is what
 * the stored LumaGuest row already carries.
 */
export async function reconcileRows(tx, eventId, guest, person, previous) {
  const lumaGuestId = guest.lumaGuestId;
  const rsvp = RSVP_FOR_STATUS.get(guest.approvalStatus);
  const attended = Boolean(guest.checkedInAt);
  const effects = { rsvp: 'unchanged', attendance: 'unchanged' };
  const record = (key, outcome) => {
    if (outcome !== 'unchanged') effects[key] = outcome;
  };

  // A status that says neither "coming" nor "not coming" leaves the RSVP row as
  // it is. Attendance is unaffected either way: it is a door scan, not a status,
  // so a guest of an unreadable standing who was scanned still counts as there.
  const reconcileRsvp = async (model, target) => {
    if (rsvp === true) return ensureRow(model, target);
    if (rsvp === false) return removeRow(model, lumaGuestId);
    return 'unchanged';
  };

  if (person.candidateId) {
    const target = { eventId, personField: 'candidateId', personId: person.candidateId, lumaGuestId };
    record('rsvp', await reconcileRsvp(tx.eventRsvp, target));
    record('attendance', attended
      ? await ensureRow(tx.eventAttendance, target)
      : await removeRow(tx.eventAttendance, lumaGuestId));
  } else {
    record('rsvp', await removeRow(tx.eventRsvp, lumaGuestId));
    record('attendance', await removeRow(tx.eventAttendance, lumaGuestId));
  }

  // Every member this guest is arriving at or leaving, locked up front and in a
  // fixed order. Up front because the reads below decide from them; in sorted
  // order because a transaction moving a guest from A to B and one moving a
  // guest from B to A would otherwise take the two locks in opposite orders and
  // deadlock. The guest lock is already held, and no transaction ever waits on
  // a guest lock while holding one of these, so the two classes cannot cycle.
  const settling = [...new Set([person.userId, previous?.userId].filter(Boolean))].sort();
  for (const memberId of settling) {
    await lockMemberAttendance(tx, eventId, memberId);
  }

  if (person.userId) {
    const target = { eventId, personField: 'memberId', personId: person.userId, lumaGuestId };
    record('rsvp', await reconcileRsvp(tx.memberEventRsvp, target));
    record('attendance', await reconcileMemberAttendance(tx, eventId, person.userId));
  } else {
    record('rsvp', await removeRow(tx.memberEventRsvp, lumaGuestId));
  }

  // A guest who was matched to a member before leaves no member attendance
  // behind - unless another guest of that member's is checked in, which is what
  // the reconcile re-checks.
  //
  // This runs whenever the member changed, not only when the guest stopped
  // being a member's. member_event_attendance keys on (event, member) and
  // carries no lumaGuestId, so settling the *new* member cannot clear the old
  // one: relinking a checked-in guest from member A to member B would otherwise
  // credit both, and one door scan would show up as two people present.
  if (previous?.userId && previous.userId !== person.userId) {
    const settled = await reconcileMemberAttendance(tx, eventId, previous.userId);
    // Only reported when settling the new person had nothing to say, so a link
    // that credits B is not summarised as a removal because it also cleared A.
    if (effects.attendance === 'unchanged') record('attendance', settled);
  }

  return effects;
}

/**
 * Serialises everything that decides who one Luma guest is.
 *
 * An hourly sync and an admin's hand link otherwise interleave: the sync reads a
 * guest, the admin links them, and the sync then writes the match it decided
 * before the link existed, silently undoing it. Nothing in the reads below takes
 * a lock of its own, and the write that follows is unconditional, so the loser
 * of that race loses the link *and* the rows reconciled from it.
 *
 * Both paths take this lock before their first read, so the later one sees the
 * earlier one's result - and resolvePerson, which reuses an identity that is
 * already there, keeps it.
 *
 * Keyed on the Luma guest id, so guests never wait on each other. It is released
 * when the transaction ends, so callers have to be inside one.
 */
export async function lockGuest(tx, lumaGuestId) {
  const key = `luma_guest_${lumaGuestId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
}

/**
 * Serialises one member's attendance for one event.
 *
 * lockGuest is not enough here. Member attendance is not derived from a single
 * guest - it is the answer to "is any guest of this member's checked in?" - so
 * two *different* guests of the same member settle the same row. Relinking both
 * away at once, each holding only its own guest lock, lets each transaction
 * still see the other's old assignment, conclude the member is present, and
 * leave the row behind: nobody is checked in, but the member stays marked
 * present, and no later sync revisits it.
 *
 * Callers take these in a fixed order (sorted by member id) and always after
 * the guest lock, so two transactions touching the same pair cannot deadlock.
 */
export async function lockMemberAttendance(tx, eventId, memberId) {
  const key = `luma_member_attendance_${eventId}_${memberId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
}

async function ingestOne(tx, eventId, guest) {
  await lockGuest(tx, guest.lumaGuestId);
  const previous = await tx.lumaGuest.findUnique({ where: { lumaGuestId: guest.lumaGuestId } });
  if (previous && previous.eventId !== eventId) {
    throw new Error(`guest ${guest.lumaGuestId} belongs to a different event`);
  }

  const person = await resolvePerson(tx, guest, previous);
  const { uidProblem, ...stored } = guest;
  const data = {
    ...stored,
    eventId,
    candidateId: person.candidateId ?? null,
    userId: person.userId ?? null,
    matchStatus: person.matchStatus,
    matchNote: person.matchNote ?? null
  };
  // Stored before the rows are reconciled, because member attendance is settled
  // by reading this event's guests back - including this one.
  await tx.lumaGuest.upsert({
    where: { lumaGuestId: guest.lumaGuestId },
    create: data,
    update: data
  });

  const effects = await reconcileRows(tx, eventId, guest, person, previous);
  return { matchStatus: person.matchStatus, matchNote: person.matchNote ?? null, effects };
}

/**
 * Ingests one page of list_guests entries for an ATS event.
 *
 * @param {string} eventId  ATS Events.id (not the Luma evt-... id)
 * @param {object[]} entries  list_guests `entries`, untouched
 * @returns a summary: counts per match status, rows created / removed, the
 *   unmatched guests (for the admin panel), the guests matched on something
 *   worth a second look, the guests whose approval_status this code cannot read
 *   as going or not going, and any entries that were rejected.
 */
export async function ingestGuests(eventId, entries, { db = prisma } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const event = await db.events.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw new Error(`Event not found: ${eventId}`);

  const summary = {
    eventId,
    received: entries.length,
    matchStatus: Object.fromEntries(Object.keys(MATCH_STATUS).map((k) => [k, 0])),
    rsvps: { created: 0, removed: 0 },
    attendance: { created: 0, removed: 0 },
    unmatched: [],
    flagged: [],
    unknownStatus: [],
    rejected: [],
    failed: []
  };

  for (const [index, entry] of entries.entries()) {
    const { guest, problem } = parseGuest(entry);
    if (!guest) {
      summary.rejected.push({ index, reason: problem });
      continue;
    }

    let result;
    try {
      result = await db.$transaction((tx) => ingestOne(tx, eventId, guest));
    } catch (error) {
      console.error(`[luma] failed to ingest guest ${guest.lumaGuestId} for event ${eventId}:`, error);
      summary.failed.push({ lumaGuestId: guest.lumaGuestId, reason: error.message });
      continue;
    }

    summary.matchStatus[result.matchStatus] += 1;
    for (const [key, outcome] of [['rsvps', result.effects.rsvp], ['attendance', result.effects.attendance]]) {
      if (outcome !== 'unchanged') summary[key][outcome] += 1;
    }
    const seen = {
      lumaGuestId: guest.lumaGuestId,
      name: guest.name,
      email: guest.email,
      note: result.matchNote
    };
    if (result.matchStatus === MATCH_STATUS.UNMATCHED) {
      summary.unmatched.push(seen);
    } else if (result.matchNote) {
      summary.flagged.push(seen);
    }
    // Stored and left alone rather than acted on; see RSVP_FOR_STATUS.
    if (!RSVP_FOR_STATUS.has(guest.approvalStatus)) {
      summary.unknownStatus.push({ ...seen, approvalStatus: guest.approvalStatus });
    }
  }

  return summary;
}

export default ingestGuests;
