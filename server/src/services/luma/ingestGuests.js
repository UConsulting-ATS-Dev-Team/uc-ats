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
// No ATS confirmation emails go out for these rows: Luma already sent its own.
import prisma from '../../prismaClient.js';

// The UID question is found by its label, because Luma gives every question a
// fresh id per event.
const UID_LABEL = /\buid\b/i;
const UID_DIGITS = /^\d{9}$/;
const MEMBER_ROLES = ['MEMBER', 'ADMIN'];

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

/** A door scan marks the ticket; the guest-level field is usually set too. */
export function checkedInAtOf(entry) {
  const direct = parseDate(entry.checked_in_at);
  if (direct) return direct;
  const tickets = Array.isArray(entry.event_tickets) ? entry.event_tickets : [];
  const times = tickets
    .map((t) => parseDate(t?.checked_in_at))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return times[0] ?? null;
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
  const approvalStatus = text(entry.approval_status);
  if (!approvalStatus) {
    return { problem: `guest ${lumaGuestId} has no approval_status` };
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
      checkedInAt: checkedInAtOf(entry),
      joinedAt: parseDate(entry.joined_at),
      uid: uid.uid,
      uidProblem: uid.problem,
      rawAnswers: answers,
      raw: rawCopy(entry)
    }
  };
}

const insensitive = (value) => ({ equals: value, mode: 'insensitive' });

async function findMember(tx, guest) {
  if (guest.uid) {
    const byUid = await tx.user.findFirst({
      where: { studentId: guest.uid, role: { in: MEMBER_ROLES } }
    });
    if (byUid) return byUid;
  }
  return tx.user.findFirst({
    where: { email: insensitive(guest.email), role: { in: MEMBER_ROLES } }
  });
}

async function findCandidate(tx, guest) {
  if (guest.uid) {
    const byUid = await tx.candidate.findUnique({ where: { studentId: guest.uid } });
    if (byUid) return byUid;
  }
  return tx.candidate.findFirst({ where: { email: insensitive(guest.email) } });
}

/**
 * Who this guest is. A match made on an earlier sync (or by an admin, by hand)
 * is kept, so it is only ever decided once; an UNMATCHED guest is retried every
 * time, since they may have applied since.
 */
async function resolvePerson(tx, guest, previous) {
  if (previous?.userId) {
    return { userId: previous.userId, matchStatus: previous.matchStatus, matchNote: previous.matchNote };
  }
  if (previous?.candidateId) {
    return { candidateId: previous.candidateId, matchStatus: previous.matchStatus, matchNote: previous.matchNote };
  }

  const member = await findMember(tx, guest);
  if (member) return { userId: member.id, matchStatus: MATCH_STATUS.MATCHED_MEMBER, matchNote: null };

  const candidate = await findCandidate(tx, guest);
  if (candidate) {
    return { candidateId: candidate.id, matchStatus: MATCH_STATUS.MATCHED_CANDIDATE, matchNote: null };
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

// member_event_attendance predates Luma and keys on (event, member) with a free
// text source; the Luma sync owns only the rows it marked 'LUMA', so a MANUAL
// mark from the accountability page is never touched.
async function ensureMemberAttendance(tx, eventId, memberId) {
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

async function removeMemberAttendance(tx, eventId, memberId) {
  const { count } = await tx.memberEventAttendance.deleteMany({
    where: { eventId, memberId, source: 'LUMA' }
  });
  return count > 0 ? 'removed' : 'unchanged';
}

async function reconcileRows(tx, eventId, guest, person, previous) {
  const lumaGuestId = guest.lumaGuestId;
  const rsvp = guest.approvalStatus === 'approved';
  const attended = Boolean(guest.checkedInAt);
  const effects = { rsvp: 'unchanged', attendance: 'unchanged' };
  const record = (key, outcome) => {
    if (outcome !== 'unchanged') effects[key] = outcome;
  };

  if (person.candidateId) {
    const target = { eventId, personField: 'candidateId', personId: person.candidateId, lumaGuestId };
    record('rsvp', rsvp ? await ensureRow(tx.eventRsvp, target) : await removeRow(tx.eventRsvp, lumaGuestId));
    record('attendance', attended
      ? await ensureRow(tx.eventAttendance, target)
      : await removeRow(tx.eventAttendance, lumaGuestId));
  } else {
    record('rsvp', await removeRow(tx.eventRsvp, lumaGuestId));
    record('attendance', await removeRow(tx.eventAttendance, lumaGuestId));
  }

  if (person.userId) {
    const target = { eventId, personField: 'memberId', personId: person.userId, lumaGuestId };
    record('rsvp', rsvp
      ? await ensureRow(tx.memberEventRsvp, target)
      : await removeRow(tx.memberEventRsvp, lumaGuestId));
    record('attendance', attended
      ? await ensureMemberAttendance(tx, eventId, person.userId)
      : await removeMemberAttendance(tx, eventId, person.userId));
  } else {
    record('rsvp', await removeRow(tx.memberEventRsvp, lumaGuestId));
    // A guest who was matched to a member before (and has since been relinked)
    // leaves no member attendance behind.
    if (previous?.userId) {
      record('attendance', await removeMemberAttendance(tx, eventId, previous.userId));
    }
  }

  return effects;
}

async function ingestOne(tx, eventId, guest) {
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
 *   unmatched guests (for the admin panel) and any entries that were rejected.
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
    if (result.matchStatus === MATCH_STATUS.UNMATCHED) {
      summary.unmatched.push({
        lumaGuestId: guest.lumaGuestId,
        name: guest.name,
        email: guest.email,
        note: result.matchNote
      });
    }
  }

  return summary;
}

export default ingestGuests;
