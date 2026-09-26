// Linking a held Luma guest by hand, against the same in-memory database the
// ingest tests use (__fixtures__/fakeDb.js) — so what a link leaves behind is
// checked against the real unique keys, and against what a following sync does
// with it, rather than against mocked return values.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('../../prismaClient.js', () => ({ default: {} }));

const { linkLumaGuest, LinkError } = await import('./linkGuest.js');
const { ingestGuests } = await import('./ingestGuests.js');
const { fakeDb, EVENT_ID } = await import('./__fixtures__/fakeDb.js');

const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/testEventGuests.json', import.meta.url), 'utf8'));
const [rsvpOnly, checkedIn] = fixture.entries;
const clone = (value) => structuredClone(value);

// Strips the UID answer so the guest can match on nothing and lands UNMATCHED,
// which is the state this whole file is about.
function withoutUid(entry) {
  const copy = clone(entry);
  copy.registration_answers = copy.registration_answers.filter((a) => !/uid/i.test(a.label));
  return copy;
}

let db;
let guestId;

beforeEach(async () => {
  db = fakeDb();
  const summary = await ingestGuests(EVENT_ID, [withoutUid(rsvpOnly)], { db });
  expect(summary.unmatched).toHaveLength(1);
  guestId = summary.unmatched[0].lumaGuestId;
});

const guestRow = () => db.lumaGuest.rows.find((row) => row.lumaGuestId === guestId);

describe('linking an unmatched guest', () => {
  it('files them as a candidate and writes the RSVP the status implies', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '405000001', email: 'jo@example.com', firstName: 'Jo', lastName: 'Ng' }
    });

    const result = await linkLumaGuest(
      { lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id, actorId: 'admin-1' },
      { db }
    );

    expect(result).toMatchObject({ matchStatus: 'MATCHED_CANDIDATE', candidateId: candidate.id });
    expect(guestRow()).toMatchObject({ candidateId: candidate.id, matchStatus: 'MATCHED_CANDIDATE', matchNote: null });
    expect(db.eventRsvp.rows).toHaveLength(1);
    expect(db.eventRsvp.rows[0]).toMatchObject({ eventId: EVENT_ID, candidateId: candidate.id, lumaGuestId: guestId });
  });

  it('files them as a member on the member tables instead', async () => {
    const member = await db.user.create({
      data: { email: 'mem@ucla.edu', role: 'MEMBER', studentId: '405000002', firstName: 'Mem' }
    });

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, userId: member.id }, { db });

    expect(guestRow()).toMatchObject({ userId: member.id, candidateId: null, matchStatus: 'MATCHED_MEMBER' });
    expect(db.memberEventRsvp.rows).toHaveLength(1);
    expect(db.memberEventRsvp.rows[0]).toMatchObject({ memberId: member.id, lumaGuestId: guestId });
    expect(db.eventRsvp.rows).toHaveLength(0);
  });

  it('gives a checked-in guest their attendance too, not just the RSVP', async () => {
    const summary = await ingestGuests(EVENT_ID, [withoutUid(checkedIn)], { db });
    const scannedId = summary.unmatched[0].lumaGuestId;
    const candidate = await db.candidate.create({
      data: { studentId: '405000003', email: 'door@example.com', firstName: 'Door', lastName: 'Scan' }
    });

    await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    expect(db.eventAttendance.rows).toHaveLength(1);
    expect(db.eventAttendance.rows[0]).toMatchObject({ candidateId: candidate.id, lumaGuestId: scannedId });
  });

  it('does not take a row that another source already wrote for that person', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '405000004', email: 'both@example.com', firstName: 'Both', lastName: 'Ways' }
    });
    // A Google Form response for the same person on the same event.
    await db.eventRsvp.create({
      data: { responseId: 'form-1', eventId: EVENT_ID, candidateId: candidate.id }
    });

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    expect(db.eventRsvp.rows).toHaveLength(1);
    expect(db.eventRsvp.rows[0]).toMatchObject({ responseId: 'form-1', source: 'GOOGLE_FORM' });
  });
});

describe('the link sticks', () => {
  it('survives a later sync of the same guest, which would otherwise rematch them', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '405000005', email: 'sticky@example.com', firstName: 'Stick', lastName: 'Ee' }
    });
    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    // The same page again, still with nothing on it that would match.
    const summary = await ingestGuests(EVENT_ID, [withoutUid(rsvpOnly)], { db });

    expect(summary.unmatched).toHaveLength(0);
    expect(summary.flagged).toHaveLength(0);
    expect(guestRow()).toMatchObject({ candidateId: candidate.id, matchStatus: 'MATCHED_CANDIDATE' });
    expect(db.eventRsvp.rows).toHaveLength(1);
  });

  it('clears the note that put a flagged guest in front of an admin', async () => {
    const row = guestRow();
    row.matchNote = 'matched on the UID alone';
    const candidate = await db.candidate.create({
      data: { studentId: '405000006', email: 'noted@example.com', firstName: 'No', lastName: 'Ted' }
    });

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    expect(guestRow().matchNote).toBeNull();
  });
});

describe('unlinking', () => {
  it('puts a guest back to UNMATCHED and takes their rows away again', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '405000007', email: 'undo@example.com', firstName: 'Un', lastName: 'Do' }
    });
    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id }, { db });
    expect(db.eventRsvp.rows).toHaveLength(1);

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID }, { db });

    expect(guestRow()).toMatchObject({ candidateId: null, userId: null, matchStatus: 'UNMATCHED' });
    expect(db.eventRsvp.rows).toHaveLength(0);
  });

  it('leaves a row another source wrote for that person where it is', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '405000008', email: 'keep@example.com', firstName: 'Keep', lastName: 'It' }
    });
    await db.eventRsvp.create({ data: { responseId: 'form-2', eventId: EVENT_ID, candidateId: candidate.id } });
    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID }, { db });

    expect(db.eventRsvp.rows).toHaveLength(1);
    expect(db.eventRsvp.rows[0]).toMatchObject({ responseId: 'form-2' });
  });
});

describe('what it refuses', () => {
  const failsWith = async (args, status, match) => {
    await expect(linkLumaGuest(args, { db })).rejects.toThrow(LinkError);
    await expect(linkLumaGuest(args, { db })).rejects.toMatchObject({ status });
    if (match) await expect(linkLumaGuest(args, { db })).rejects.toThrow(match);
  };

  it('refuses a guest it has never heard of', async () => {
    await failsWith({ lumaGuestId: 'gst-nope', eventId: EVENT_ID, candidateId: 'x' }, 404);
  });

  it('refuses a guest that belongs to a different event', async () => {
    await failsWith({ lumaGuestId: guestId, eventId: 'event-2', candidateId: 'x' }, 404, /different event/);
  });

  it('refuses a candidate and a member at once', async () => {
    await failsWith({ lumaGuestId: guestId, candidateId: 'c', userId: 'u' }, 400);
  });

  it('refuses a candidate or member that does not exist', async () => {
    await failsWith({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: 'gone' }, 404, /candidate/);
    await failsWith({ lumaGuestId: guestId, eventId: EVENT_ID, userId: 'gone' }, 404, /member/);
  });

  it('refuses a user who is not a member', async () => {
    const applicant = await db.user.create({
      data: { email: 'applicant@example.com', role: 'USER', studentId: '405000009' }
    });
    await failsWith({ lumaGuestId: guestId, eventId: EVENT_ID, userId: applicant.id }, 404);
  });

  it('refuses a sealed candidate rather than filing activity on a locked record', async () => {
    const sealed = await db.candidate.create({
      data: {
        studentId: '405000010',
        email: 'sealed@example.com',
        firstName: 'Se',
        lastName: 'Aled',
        recordsLockedAt: new Date()
      }
    });
    await failsWith({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: sealed.id }, 409, /sealed/);
  });

  it('writes nothing when it refuses', async () => {
    await expect(
      linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: 'gone' }, { db })
    ).rejects.toThrow();
    expect(guestRow()).toMatchObject({ candidateId: null, matchStatus: 'UNMATCHED' });
    expect(db.eventRsvp.rows).toHaveLength(0);
  });
});

// member_event_attendance keys on (event, member) and carries no lumaGuestId, so
// it cannot be settled by pointing at the guest that caused it - it is worked out
// from every guest of the event at once. Relinking therefore has to re-settle the
// member the guest is *leaving* as well as the one it arrives at. Nothing else
// ever will: a match that exists is never re-decided, so a stale credit left here
// stays for good.
describe('relinking a checked-in guest from one member to another', () => {
  let scannedId;
  let alice;
  let bob;

  const member = (email, studentId, firstName) =>
    db.user.create({ data: { email, role: 'MEMBER', studentId, firstName } });

  beforeEach(async () => {
    const summary = await ingestGuests(EVENT_ID, [withoutUid(checkedIn)], { db });
    scannedId = summary.unmatched[0].lumaGuestId;
    alice = await member('alice@ucla.edu', '405000101', 'Alice');
    bob = await member('bob@ucla.edu', '405000102', 'Bob');

    await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, userId: alice.id }, { db });
    expect(db.memberEventAttendance.rows).toMatchObject([{ memberId: alice.id, source: 'LUMA' }]);
  });

  it('moves the attendance rather than crediting both members', async () => {
    await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, userId: bob.id }, { db });

    expect(db.memberEventAttendance.rows).toMatchObject([{ memberId: bob.id, source: 'LUMA' }]);
    expect(db.memberEventRsvp.rows).toMatchObject([{ memberId: bob.id, lumaGuestId: scannedId }]);
  });

  it('reports what the link did, not the cleanup it also had to do', async () => {
    const result = await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, userId: bob.id }, { db });

    expect(result.effects.attendance).toBe('created');
  });

  it('leaves the first member credited when another guest of theirs is still checked in', async () => {
    // Alice registered twice and was scanned on both, so relinking one of the two
    // says nothing about whether she was there.
    const second = clone(checkedIn);
    for (const row of [second, second.guest]) {
      row.api_id = 'gst-secondRegistration';
      row.id = 'gst-secondRegistration';
      row.email = 'alice@ucla.edu';
      row.user_email = 'alice@ucla.edu';
    }
    // Matched to Alice on her email, so this is her second scan, not a new person.
    const again = await ingestGuests(EVENT_ID, [second], { db });
    expect(again.matchStatus.MATCHED_MEMBER).toBe(1);
    expect(db.memberEventAttendance.rows).toMatchObject([{ memberId: alice.id }]);

    await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, userId: bob.id }, { db });

    expect(db.memberEventAttendance.rows.map((row) => row.memberId).sort())
      .toEqual([alice.id, bob.id].sort());
  });

  // The guest lock does not cover this: member attendance is settled across all
  // of an event's guests, so two *different* guests of the same member settle
  // the same row and would each see the other's old assignment.
  it('locks every member it is settling, in a fixed order', async () => {
    db.raw.length = 0;

    await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, userId: bob.id }, { db });

    const memberLocks = db.raw
      .map((statement) => statement.values[0])
      .filter((key) => String(key).startsWith('luma_member_attendance_'));
    // Both of them - the one being credited and the one being cleared - and in
    // sorted order, so a transaction moving a guest the other way takes the same
    // two locks in the same order and waits rather than deadlocking.
    expect(memberLocks).toEqual([
      `luma_member_attendance_${EVENT_ID}_${alice.id}`,
      `luma_member_attendance_${EVENT_ID}_${bob.id}`
    ].sort());
  });

  it('takes the credit away entirely when the guest turns out to be a candidate', async () => {
    const candidate = await db.candidate.create({
      data: { studentId: '405000103', email: 'notamember@example.com', firstName: 'Not', lastName: 'Member' }
    });

    await linkLumaGuest({ lumaGuestId: scannedId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    expect(db.memberEventAttendance.rows).toHaveLength(0);
    expect(db.memberEventRsvp.rows).toHaveLength(0);
    expect(db.eventAttendance.rows).toMatchObject([{ candidateId: candidate.id, lumaGuestId: scannedId }]);
  });
});

// A sync and a hand link both read the guest, decide, and write every match
// field unconditionally. Without a lock the loser of that race writes over the
// winner, and the link - plus the rows reconciled from it - is silently undone.
describe('the per-guest lock', () => {
  const locks = () => db.raw
    .filter((statement) => statement.sql.includes('pg_advisory_xact_lock'))
    .map((statement) => statement.values.join(','));

  it('is taken by a sync, keyed on the guest', () => {
    // The beforeEach above ingested one guest.
    expect(locks()).toEqual([`luma_guest_${guestId}`]);
  });

  it('is taken by a hand link too, on the same key, or the two would not exclude each other', async () => {
    db.raw.length = 0;
    const candidate = await db.candidate.create({
      data: { studentId: '405000104', email: 'locked@example.com', firstName: 'Lock', lastName: 'Ed' }
    });

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID, candidateId: candidate.id }, { db });

    expect(locks()).toEqual([`luma_guest_${guestId}`]);
  });

  it('is taken before the guest is read, not after the decision is made', async () => {
    db.raw.length = 0;
    const reads = [];
    const findUnique = db.lumaGuest.findUnique;
    db.lumaGuest.findUnique = async (args) => {
      reads.push(db.raw.length);
      return findUnique(args);
    };

    await linkLumaGuest({ lumaGuestId: guestId, eventId: EVENT_ID }, { db });

    db.lumaGuest.findUnique = findUnique;
    // Every read of the guest happened with the lock already held.
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads)).toBe(1);
  });
});

