// The matching and reconciliation rules for Luma guests, run against the real
// list_guests response captured from the private test event
// (__fixtures__/testEventGuests.json): one guest RSVP'd only, one checked in at
// the door.
//
// The database is an in-memory stand-in that enforces the same unique keys as
// the migration, so "re-ingesting changes nothing" and "a person counts once"
// are checked against constraints rather than against mocked return values.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('../../prismaClient.js', () => ({ default: {} }));

const { ingestGuests, extractUid, splitName, checkedInAtOf, parseGuest } = await import('./ingestGuests.js');

const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/testEventGuests.json', import.meta.url), 'utf8'));
const [rsvpOnly, checkedIn] = fixture.entries;
const clone = (value) => structuredClone(value);

const EVENT_ID = 'event-1';

// --- a Prisma-shaped in-memory store -------------------------------------

function matches(row, where) {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) return condition.in.includes(value);
      if ('not' in condition) {
        return condition.not === null ? value != null : value !== condition.not;
      }
      if ('equals' in condition) {
        return condition.mode === 'insensitive'
          ? String(value ?? '').toLowerCase() === String(condition.equals).toLowerCase()
          : value === condition.equals;
      }
    }
    return value === condition;
  });
}

// { eventId_candidateId: { eventId, candidateId } } -> { eventId, candidateId }
function flattenUnique(where) {
  const [key, value] = Object.entries(where)[0];
  return key.includes('_') && value && typeof value === 'object' ? value : where;
}

function uniqueError(target) {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });
}

function model(uniques, defaults = {}) {
  const rows = [];
  let next = 1;
  const check = (candidate, ignoreId) => {
    for (const fields of uniques) {
      const clash = rows.find((row) => row.id !== ignoreId
        && fields.every((f) => candidate[f] != null && row[f] === candidate[f]));
      if (clash) throw uniqueError(fields.join(','));
    }
  };
  const api = {
    rows,
    async findUnique({ where }) {
      return rows.find((row) => matches(row, flattenUnique(where))) ?? null;
    },
    async findFirst({ where }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async create({ data }) {
      const row = { id: `${defaults.prefix ?? 'row'}-${next++}`, ...defaults.values, ...data };
      check(row);
      rows.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = await api.findUnique({ where });
      if (!row) throw new Error('Record to update not found');
      check({ ...row, ...data }, row.id);
      Object.assign(row, data);
      return row;
    },
    async upsert({ where, create, update }) {
      const row = await api.findUnique({ where });
      return row ? api.update({ where, data: update }) : api.create({ data: create });
    },
    async delete({ where }) {
      const row = await api.findUnique({ where });
      if (!row) throw new Error('Record to delete does not exist');
      rows.splice(rows.indexOf(row), 1);
      return row;
    },
    async deleteMany({ where }) {
      const doomed = rows.filter((row) => matches(row, where));
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return { count: doomed.length };
    }
  };
  return api;
}

function fakeDb() {
  const db = {
    events: model([['id']]),
    user: model([['email'], ['studentId']], { prefix: 'user' }),
    candidate: model([['email'], ['studentId']], { prefix: 'cand' }),
    lumaGuest: model([['lumaGuestId']], { prefix: 'lg' }),
    eventRsvp: model([['responseId'], ['lumaGuestId'], ['eventId', 'candidateId']], { values: { source: 'GOOGLE_FORM' } }),
    eventAttendance: model([['responseId'], ['lumaGuestId'], ['eventId', 'candidateId']], { values: { source: 'GOOGLE_FORM' } }),
    memberEventRsvp: model([['responseId'], ['lumaGuestId'], ['eventId', 'memberId']], { values: { source: 'GOOGLE_FORM' } }),
    memberEventAttendance: model([['responseId'], ['eventId', 'memberId']], { values: { source: 'MANUAL' } }),
    $transaction: async (fn) => fn(db)
  };
  db.events.rows.push({ id: EVENT_ID });
  return db;
}

// A deep snapshot of every table, to prove a second run wrote nothing.
const snapshot = (db) => JSON.stringify(
  Object.fromEntries(Object.entries(db).filter(([, m]) => m.rows).map(([k, m]) => [k, m.rows]))
);

function withAnswers(entry, answers) {
  const copy = clone(entry);
  copy.registration_answers = answers;
  return copy;
}

function withUid(entry, value, label = 'UCLA UID (9 digits)') {
  return withAnswers(entry, [
    ...entry.registration_answers.filter((a) => !/uid/i.test(a.label)),
    { label, value, answer: value, question_id: 'q-other', question_type: 'text' }
  ]);
}

let db;
beforeEach(() => {
  db = fakeDb();
});

// --- the helpers ----------------------------------------------------------

describe('field extraction', () => {
  it('finds the UID by label, whatever the question id, and strips punctuation', () => {
    const answers = [{ label: 'Your UCLA uid', answer: '405-123-456' }];
    expect(extractUid(answers)).toMatchObject({ uid: '405123456', problem: null });
  });

  it('does not take a label that merely contains the letters "uid"', () => {
    expect(extractUid([{ label: 'Guidance counselor', answer: '405123456' }]).uid).toBeNull();
  });

  it('rejects a UID that is not exactly 9 digits and says why', () => {
    expect(extractUid([{ label: 'UID', answer: '40512345' }])).toMatchObject({
      uid: null,
      problem: 'UID "40512345" is not 9 digits'
    });
    expect(extractUid([]).problem).toBe('no UID answer');
  });

  it('splits a single profile name when Luma has no separate first/last', () => {
    expect(splitName({ user_first_name: '', user_name: 'Mary Jane Watson' }))
      .toEqual({ firstName: 'Mary Jane', lastName: 'Watson' });
    expect(splitName({ user_first_name: 'Testguest', user_last_name: '' }))
      .toEqual({ firstName: 'Testguest', lastName: '' });
    expect(splitName({ user_name: 'Cher' })).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('falls back to the ticket check-in time when the guest field is empty', () => {
    const entry = clone(rsvpOnly);
    entry.event_tickets = [
      { checked_in_at: '2026-09-22T01:00:00.000Z' },
      { checked_in_at: '2026-09-22T00:30:00.000Z' }
    ];
    expect(checkedInAtOf(entry)).toEqual({ at: new Date('2026-09-22T00:30:00.000Z') });
    expect(checkedInAtOf(rsvpOnly)).toEqual({ at: null });
  });

  it('says a check-in time is unreadable rather than calling it absent', () => {
    const entry = clone(rsvpOnly);
    entry.checked_in_at = 'yesterday';
    expect(checkedInAtOf(entry)).toEqual({ invalid: 'yesterday' });
  });

  it('drops the check-in QR link and the nested duplicates from the stored copy', () => {
    const { guest } = parseGuest(rsvpOnly);
    expect(guest.raw).not.toHaveProperty('check_in_qr_code');
    expect(guest.raw).not.toHaveProperty('guest');
    expect(guest.raw).not.toHaveProperty('event_ticket');
    expect(guest.raw.event_tickets).toHaveLength(1);
  });
});

// --- ingesting --------------------------------------------------------------

describe('ingestGuests', () => {
  it('turns the test event into one RSVP-only guest and one checked-in guest', async () => {
    const summary = await ingestGuests(EVENT_ID, fixture.entries, { db });

    expect(summary.matchStatus.CREATED_CANDIDATE).toBe(2);
    expect(summary.rsvps).toEqual({ created: 2, removed: 0 });
    expect(summary.attendance).toEqual({ created: 1, removed: 0 });

    const organizer = db.candidate.rows.find((c) => c.studentId === '123456789');
    const guest = db.candidate.rows.find((c) => c.studentId === '123456788');
    expect(organizer).toMatchObject({ firstName: 'UConsulting', lastName: 'UCLA', email: 'uconsultingla@gmail.com' });
    // A one-word Luma profile name: the last name really is empty.
    expect(guest).toMatchObject({ firstName: 'Testguest', lastName: '', email: 'test.guest@example.com' });

    expect(db.eventRsvp.rows.map((r) => r.candidateId).sort()).toEqual([organizer.id, guest.id].sort());
    expect(db.eventRsvp.rows.every((r) => r.source === 'LUMA' && r.lumaGuestId)).toBe(true);
    expect(db.eventAttendance.rows).toEqual([
      expect.objectContaining({ candidateId: guest.id, source: 'LUMA', lumaGuestId: checkedIn.api_id })
    ]);

    const stored = db.lumaGuest.rows.find((g) => g.lumaGuestId === checkedIn.api_id);
    expect(stored.checkedInAt).toEqual(new Date('2026-09-22T00:37:34.889Z'));
    expect(stored.uid).toBe('123456788');
  });

  it('changes nothing when the same page arrives again', async () => {
    await ingestGuests(EVENT_ID, fixture.entries, { db });
    const before = snapshot(db);

    const again = await ingestGuests(EVENT_ID, clone(fixture.entries), { db });

    expect(again.rsvps).toEqual({ created: 0, removed: 0 });
    expect(again.attendance).toEqual({ created: 0, removed: 0 });
    // The first run's decision sticks, so the created candidates stay "created".
    expect(again.matchStatus.CREATED_CANDIDATE).toBe(2);
    expect(snapshot(db)).toBe(before);
  });

  it('matches by email case-insensitively, and by UID when the email is unknown', async () => {
    const byUid = await db.candidate.create({
      data: { studentId: '123456789', email: 'someone.else@ucla.edu', firstName: 'A', lastName: 'B' }
    });
    const byEmail = await db.candidate.create({
      data: { studentId: '999999999', email: 'Test.Guest@Example.com', firstName: 'T', lastName: 'G' }
    });
    const noUid = withAnswers(checkedIn, []);

    const summary = await ingestGuests(EVENT_ID, [rsvpOnly, noUid], { db });

    expect(summary.matchStatus.MATCHED_CANDIDATE).toBe(2);
    expect(db.candidate.rows).toHaveLength(2);
    expect(db.eventRsvp.rows.find((r) => r.lumaGuestId === rsvpOnly.api_id).candidateId).toBe(byUid.id);
    expect(db.eventAttendance.rows[0].candidateId).toBe(byEmail.id);
    // The UID is all that named the first guest, and their profile name says
    // nothing either way, so the match is reported for a second look.
    expect(summary.flagged).toEqual([expect.objectContaining({
      lumaGuestId: rsvpOnly.api_id,
      note: expect.stringContaining('matched on the UID 123456789 alone')
    })]);
  });

  it("files a guest under the email's owner when the UID they typed is someone else's", async () => {
    const impersonated = await db.candidate.create({
      data: { studentId: '123456789', email: 'real.person@ucla.edu', firstName: 'Real', lastName: 'Person' }
    });
    const whoRegistered = await db.candidate.create({
      data: { studentId: '405999999', email: 'uconsultingla@gmail.com', firstName: 'U', lastName: 'C' }
    });

    // The guest typed 123456789, which is the other candidate's UID. Luma is
    // the authority on the address the guest registered and was mailed at, and
    // a typed answer is not, so the address decides.
    const summary = await ingestGuests(EVENT_ID, [rsvpOnly], { db });

    expect(db.eventRsvp.rows).toEqual([expect.objectContaining({ candidateId: whoRegistered.id })]);
    expect(db.eventRsvp.rows.some((r) => r.candidateId === impersonated.id)).toBe(false);
    expect(summary.flagged).toEqual([]);
  });

  it('does not flag a UID match the profile name corroborates', async () => {
    await db.candidate.create({
      data: { studentId: '123456789', email: 'someone.else@ucla.edu', firstName: 'UConsulting', lastName: 'Bruin' }
    });

    const summary = await ingestGuests(EVENT_ID, [rsvpOnly], { db });

    expect(summary.matchStatus.MATCHED_CANDIDATE).toBe(1);
    expect(summary.flagged).toEqual([]);
  });

  it('leaves a guest with no match and no usable UID for an admin', async () => {
    const summary = await ingestGuests(EVENT_ID, [withUid(checkedIn, '12345')], { db });

    expect(summary.matchStatus.UNMATCHED).toBe(1);
    expect(summary.unmatched).toEqual([expect.objectContaining({
      lumaGuestId: checkedIn.api_id,
      email: 'test.guest@example.com',
      note: 'UID "12345" is not 9 digits; no candidate or member with test.guest@example.com'
    })]);
    expect(db.candidate.rows).toHaveLength(0);
    expect(db.eventRsvp.rows).toHaveLength(0);
    expect(db.eventAttendance.rows).toHaveLength(0);
    // Kept, with what they typed, for the unmatched-guests panel.
    expect(db.lumaGuest.rows[0]).toMatchObject({ matchStatus: 'UNMATCHED', uid: null });
  });

  it('retries an unmatched guest on the next sync', async () => {
    const guest = withUid(rsvpOnly, 'n/a');
    await ingestGuests(EVENT_ID, [guest], { db });
    await db.candidate.create({
      data: { studentId: '405000000', email: 'uconsultingla@gmail.com', firstName: 'U', lastName: 'C' }
    });

    const summary = await ingestGuests(EVENT_ID, [guest], { db });

    expect(summary.matchStatus.MATCHED_CANDIDATE).toBe(1);
    expect(db.eventRsvp.rows).toHaveLength(1);
  });

  it('takes the RSVP back out when a guest declines', async () => {
    await ingestGuests(EVENT_ID, [rsvpOnly], { db });
    const declined = clone(rsvpOnly);
    declined.approval_status = 'declined';

    const summary = await ingestGuests(EVENT_ID, [declined], { db });

    expect(summary.rsvps).toEqual({ created: 0, removed: 1 });
    expect(db.eventRsvp.rows).toHaveLength(0);
  });

  it('takes attendance back out when a check-in is undone at the door', async () => {
    await ingestGuests(EVENT_ID, [checkedIn], { db });
    const undone = clone(checkedIn);
    undone.checked_in_at = null;
    undone.event_tickets.forEach((t) => { t.checked_in_at = null; });

    const summary = await ingestGuests(EVENT_ID, [undone], { db });

    expect(summary.attendance).toEqual({ created: 0, removed: 1 });
    expect(db.eventAttendance.rows).toHaveLength(0);
    expect(db.eventRsvp.rows).toHaveLength(1);
  });

  it('rejects an unknown approval status instead of reading it as "not approved"', async () => {
    await ingestGuests(EVENT_ID, [rsvpOnly], { db });
    const odd = clone(rsvpOnly);
    odd.approval_status = 'approved_pending_review';

    const summary = await ingestGuests(EVENT_ID, [odd], { db });

    expect(summary.rejected).toEqual([expect.objectContaining({
      index: 0,
      reason: expect.stringContaining('unknown approval_status')
    })]);
    expect(db.eventRsvp.rows).toHaveLength(1);
  });

  it('reads a known approval status whatever its case', async () => {
    const shouty = clone(rsvpOnly);
    shouty.approval_status = 'Approved';

    const summary = await ingestGuests(EVENT_ID, [shouty], { db });

    expect(summary.rejected).toEqual([]);
    expect(db.eventRsvp.rows).toHaveLength(1);
  });

  it('rejects an unreadable check-in time instead of reading it as "not checked in"', async () => {
    await ingestGuests(EVENT_ID, [checkedIn], { db });
    const broken = clone(checkedIn);
    broken.checked_in_at = 'not a date';

    const summary = await ingestGuests(EVENT_ID, [broken], { db });

    expect(summary.rejected).toEqual([expect.objectContaining({
      reason: expect.stringContaining('unreadable check-in time')
    })]);
    expect(db.eventAttendance.rows).toHaveLength(1);
  });

  it('does not count a Google Form responder twice, and never removes their form row', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '123456789', email: 'uconsultingla@gmail.com', firstName: 'U', lastName: 'C' }
    });
    await db.eventRsvp.create({ data: { eventId: EVENT_ID, candidateId: candidate.id, responseId: 'form-resp-1' } });

    const first = await ingestGuests(EVENT_ID, [rsvpOnly], { db });
    const declined = clone(rsvpOnly);
    declined.approval_status = 'declined';
    await ingestGuests(EVENT_ID, [declined], { db });

    expect(first.rsvps.created).toBe(0);
    expect(db.eventRsvp.rows).toEqual([
      expect.objectContaining({ responseId: 'form-resp-1', source: 'GOOGLE_FORM' })
    ]);
  });

  it('files a member under member RSVP and member attendance, not as a candidate', async () => {
    const member = await db.user.create({
      data: { email: 'member@ucla.edu', studentId: '123456788', role: 'MEMBER', fullName: 'M' }
    });

    const summary = await ingestGuests(EVENT_ID, [checkedIn], { db });

    expect(summary.matchStatus.MATCHED_MEMBER).toBe(1);
    expect(db.candidate.rows).toHaveLength(0);
    expect(db.eventRsvp.rows).toHaveLength(0);
    expect(db.memberEventRsvp.rows).toEqual([
      expect.objectContaining({ memberId: member.id, source: 'LUMA', lumaGuestId: checkedIn.api_id })
    ]);
    expect(db.memberEventAttendance.rows).toEqual([
      expect.objectContaining({ memberId: member.id, source: 'LUMA' })
    ]);
  });

  it('does not treat an applicant login (role USER) as a member', async () => {
    await db.user.create({
      data: { email: 'test.guest@example.com', studentId: null, role: 'USER', fullName: 'T' }
    });

    const summary = await ingestGuests(EVENT_ID, [checkedIn], { db });

    expect(summary.matchStatus.CREATED_CANDIDATE).toBe(1);
    expect(db.memberEventRsvp.rows).toHaveLength(0);
  });

  it('keeps a member checked in however their two registrations are ordered', async () => {
    // member_event_attendance has no lumaGuestId, so a row cannot say which
    // guest put it there. Settling it per guest would let the unscanned
    // registration delete the scanned one's row whenever it came second.
    const notScanned = clone(rsvpOnly);
    notScanned.user_email = 'member@ucla.edu';

    for (const page of [[checkedIn, notScanned], [notScanned, checkedIn]]) {
      db = fakeDb();
      const member = await db.user.create({
        data: { email: 'member@ucla.edu', studentId: '123456788', role: 'MEMBER', fullName: 'M' }
      });

      await ingestGuests(EVENT_ID, clone(page), { db });

      expect(db.memberEventAttendance.rows).toEqual([
        expect.objectContaining({ memberId: member.id, source: 'LUMA' })
      ]);
    }
  });

  it("takes a member's attendance out once no registration of theirs is scanned", async () => {
    await db.user.create({
      data: { email: 'member@ucla.edu', studentId: '123456788', role: 'MEMBER', fullName: 'M' }
    });
    const notScanned = clone(rsvpOnly);
    notScanned.user_email = 'member@ucla.edu';
    await ingestGuests(EVENT_ID, [checkedIn, notScanned], { db });

    const undone = clone(checkedIn);
    undone.checked_in_at = null;
    undone.event_tickets.forEach((t) => { t.checked_in_at = null; });
    await ingestGuests(EVENT_ID, [undone, notScanned], { db });

    expect(db.memberEventAttendance.rows).toHaveLength(0);
  });

  it("leaves a member's MANUAL attendance mark alone when Luma shows no check-in", async () => {
    const member = await db.user.create({
      data: { email: 'uconsultingla@gmail.com', role: 'ADMIN', fullName: 'Club' }
    });
    await db.memberEventAttendance.create({ data: { eventId: EVENT_ID, memberId: member.id, source: 'MANUAL' } });

    await ingestGuests(EVENT_ID, [rsvpOnly], { db });

    expect(db.memberEventAttendance.rows).toEqual([expect.objectContaining({ source: 'MANUAL' })]);
  });

  it('keeps a hand-made link instead of matching again', async () => {
    const linked = await db.candidate.create({
      data: { studentId: '405111111', email: 'real.person@ucla.edu', firstName: 'R', lastName: 'P' }
    });
    const unmatched = withUid(checkedIn, 'none');
    await ingestGuests(EVENT_ID, [unmatched], { db });
    // What the Phase 3 panel will do.
    Object.assign(db.lumaGuest.rows[0], { candidateId: linked.id, matchStatus: 'MATCHED_CANDIDATE' });

    await ingestGuests(EVENT_ID, [unmatched], { db });

    expect(db.eventAttendance.rows).toEqual([expect.objectContaining({ candidateId: linked.id })]);
  });

  it('rejects malformed entries without stopping the page', async () => {
    const noId = clone(rsvpOnly);
    delete noId.api_id;
    delete noId.id;
    const noEmail = clone(checkedIn);
    noEmail.user_email = '';
    noEmail.email = null;

    const summary = await ingestGuests(EVENT_ID, [noId, 'junk', noEmail, rsvpOnly], { db });

    expect(summary.rejected.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(summary.matchStatus.CREATED_CANDIDATE).toBe(1);
  });

  it('refuses a guest that was already ingested for a different event', async () => {
    await ingestGuests(EVENT_ID, [rsvpOnly], { db });
    db.events.rows.push({ id: 'event-2' });

    const summary = await ingestGuests('event-2', [rsvpOnly], { db });

    expect(summary.failed).toEqual([expect.objectContaining({ lumaGuestId: rsvpOnly.api_id })]);
    expect(db.eventRsvp.rows.every((r) => r.eventId === EVENT_ID)).toBe(true);
  });

  it('throws for an event the ATS does not have', async () => {
    await expect(ingestGuests('nope', fixture.entries, { db })).rejects.toThrow('Event not found');
  });
});
