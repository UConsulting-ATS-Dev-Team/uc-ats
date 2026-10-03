// What a candidate took part in during a cycle, read for Application Detail and
// the review team deliberation card. What matters: Get to Know UC counts only
// inside the cycle's dates (and never without a start date), RSVPs and
// attendance are two queries however many events there are, and referrals come
// back in the order and shape the referrals route has always sent.
import { describe, it, expect, vi } from 'vitest';
import {
  getCycleEventParticipation,
  getCycleReferrals,
  loadParticipationPoints,
  participationPoints
} from './applicationParticipation.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));

const EVENTS = [
  { id: 'e1', eventName: 'Info Sesh', eventStartDate: new Date('2026-09-20T18:00:00Z'), eventEndDate: null, eventLocation: 'Ackerman' },
  { id: 'e2', eventName: 'Case Workshop', eventStartDate: new Date('2026-09-25T18:00:00Z'), eventEndDate: null, eventLocation: 'Bunche' }
];

const SIGNUP = {
  id: 'signup-1',
  slot: {
    startTime: new Date('2026-09-22T17:00:00Z'),
    endTime: new Date('2026-09-22T17:30:00Z'),
    location: 'Kerckhoff',
    member: { fullName: 'Mia Member', profileImage: null }
  }
};

function fakeClient({ events = EVENTS, signup = null, rsvps = [], attendance = [], referrals = [] } = {}) {
  return {
    events: { findMany: vi.fn(async () => events) },
    // Honours the date window, so a test can tell what was asked for.
    meetingSignup: {
      findFirst: vi.fn(async ({ where }) => {
        if (!signup) return null;
        const { gte, lte } = where.slot.startTime;
        const at = signup.slot.startTime;
        return at >= gte && (!lte || at <= lte) ? signup : null;
      })
    },
    eventRsvp: { findMany: vi.fn(async () => rsvps.map((eventId) => ({ eventId }))) },
    eventAttendance: { findMany: vi.fn(async () => attendance.map((eventId) => ({ eventId }))) },
    referral: { findMany: vi.fn(async () => referrals) }
  };
}

const facts = (extra = {}) => ({
  cycleId: 'cycle-1',
  candidateId: 'cand-1',
  studentId: '123456789',
  cycleStartDate: new Date('2026-09-01T00:00:00Z'),
  cycleEndDate: new Date('2026-12-15T00:00:00Z'),
  ...extra
});

describe('getCycleEventParticipation', () => {
  it('marks each event attended or not, with RSVPs, a point per attendance', async () => {
    const client = fakeClient({ rsvps: ['e1', 'e2'], attendance: ['e1'] });
    const result = await getCycleEventParticipation({ client, ...facts() });

    expect(result.events.map((event) => [event.id, event.rsvpStatus, event.attendanceStatus, event.points])).toEqual([
      ['e1', 'RSVPed', 'Attended', 1],
      ['e2', 'RSVPed', 'Not Attended', 0]
    ]);
    expect(result.totalPoints).toBe(1);
    expect(result.events[0]).toMatchObject({ eventName: 'Info Sesh', eventLocation: 'Ackerman' });
  });

  it('asks for RSVPs and attendance once each, by the event ids', async () => {
    const client = fakeClient();
    await getCycleEventParticipation({ client, ...facts() });
    const expected = { where: { candidateId: 'cand-1', eventId: { in: ['e1', 'e2'] } }, select: { eventId: true } };
    expect(client.eventRsvp.findMany).toHaveBeenCalledTimes(1);
    expect(client.eventRsvp.findMany).toHaveBeenCalledWith(expected);
    expect(client.eventAttendance.findMany).toHaveBeenCalledWith(expected);
  });

  it('adds Get to Know UC when they came to a meeting inside the cycle', async () => {
    const client = fakeClient({ signup: SIGNUP });
    const result = await getCycleEventParticipation({ client, ...facts() });

    expect(result.events.at(-1)).toEqual({
      id: 'meeting-signup-1',
      eventName: 'Get to Know UC',
      eventStartDate: SIGNUP.slot.startTime,
      eventEndDate: SIGNUP.slot.endTime,
      eventLocation: 'Kerckhoff',
      rsvpStatus: 'RSVPed',
      attendanceStatus: 'Attended',
      points: 1,
      isMeeting: true,
      memberName: 'Mia Member'
    });
    expect(result.totalPoints).toBe(1);
    expect(client.meetingSignup.findFirst.mock.calls[0][0].where).toMatchObject({ studentId: '123456789', attended: true });
  });

  it('leaves out a meeting outside the cycle dates', async () => {
    const client = fakeClient({ signup: SIGNUP });
    const result = await getCycleEventParticipation({
      client,
      ...facts({ cycleStartDate: new Date('2026-10-01T00:00:00Z') })
    });
    expect(result.events.some((event) => event.isMeeting)).toBe(false);

    const ended = await getCycleEventParticipation({
      client,
      ...facts({ cycleStartDate: new Date('2026-08-01T00:00:00Z'), cycleEndDate: new Date('2026-09-01T00:00:00Z') })
    });
    expect(ended.events.some((event) => event.isMeeting)).toBe(false);
  });

  it('counts no meeting at all when the cycle has no start date', async () => {
    const client = fakeClient({ signup: SIGNUP });
    const result = await getCycleEventParticipation({ client, ...facts({ cycleStartDate: null }) });
    expect(result.events.some((event) => event.isMeeting)).toBe(false);
    expect(client.meetingSignup.findFirst).not.toHaveBeenCalled();
  });

  it('looks for no meeting without a UID, rather than matching anyone', async () => {
    const client = fakeClient({ signup: SIGNUP });
    for (const studentId of [undefined, null, '']) {
      const result = await getCycleEventParticipation({ client, ...facts({ studentId }) });
      expect(result.events.some((event) => event.isMeeting)).toBe(false);
    }
    expect(client.meetingSignup.findFirst).not.toHaveBeenCalled();
  });

  it('reads nothing without a cycle or a candidate, and nothing more without events', async () => {
    const client = fakeClient();
    expect(await getCycleEventParticipation({ client, ...facts({ candidateId: null }) })).toEqual({ events: [], totalPoints: 0 });
    expect(await getCycleEventParticipation({ client, ...facts({ cycleId: null }) })).toEqual({ events: [], totalPoints: 0 });
    expect(client.events.findMany).not.toHaveBeenCalled();

    const empty = fakeClient({ events: [] });
    expect(await getCycleEventParticipation({ client: empty, ...facts() })).toEqual({ events: [], totalPoints: 0 });
    expect(empty.eventRsvp.findMany).not.toHaveBeenCalled();
  });
});

describe('getCycleReferrals', () => {
  it("returns the candidate's referrals in the cycle, oldest first, with the submitting member", async () => {
    const rows = [
      { id: 'r1', source: 'MANUAL', referrerName: 'Pat Alum', relationship: 'Classmate', reason: null, referredBy: null },
      { id: 'r2', source: 'PRE_APPLICATION', referrerName: 'Mia', relationship: 'Roommate', reason: 'Sharp', referredBy: { id: 'm1', fullName: 'Mia Member', email: 'mia@ucla.edu' } }
    ];
    const client = fakeClient({ referrals: rows });

    expect(await getCycleReferrals({ client, candidateId: 'cand-1', cycleId: 'cycle-1' })).toBe(rows);
    expect(client.referral.findMany).toHaveBeenCalledWith({
      where: { candidateId: 'cand-1', cycleId: 'cycle-1' },
      orderBy: { createdAt: 'asc' },
      include: { referredBy: { select: { id: true, fullName: true, email: true } } }
    });
  });
});

describe('participationPoints', () => {
  it('is a point per event and one for Get to Know UC, capped at 3', () => {
    expect(participationPoints(0, false)).toBe(0);
    expect(participationPoints(1, true)).toBe(2);
    expect(participationPoints(3, false)).toBe(3);
    expect(participationPoints(3, true)).toBe(3);
  });
});

describe('loadParticipationPoints', () => {
  const bulkClient = ({ cycle = { startDate: new Date('2026-09-01'), endDate: null }, attendance = [], meetings = [] } = {}) => ({
    recruitingCycle: { findUnique: vi.fn(async () => cycle) },
    eventAttendance: { findMany: vi.fn(async () => attendance) },
    meetingSignup: { findMany: vi.fn(async () => meetings) }
  });

  it('counts distinct events and a meeting per candidate, in two queries', async () => {
    const client = bulkClient({
      attendance: [
        { candidateId: 'c1', eventId: 'e1' }, { candidateId: 'c1', eventId: 'e1' }, { candidateId: 'c1', eventId: 'e2' },
        { candidateId: 'c2', eventId: 'e1' }, { candidateId: 'c2', eventId: 'e2' }, { candidateId: 'c2', eventId: 'e3' }
      ],
      meetings: [{ studentId: '111' }, { studentId: '222' }]
    });
    const points = await loadParticipationPoints({
      client,
      cycleId: 'cycle-1',
      candidates: [
        { candidateId: 'c1', studentId: '111' },
        { candidateId: 'c2', studentId: '222' },
        { candidateId: 'c3', studentId: null },
        { candidateId: 'c4', studentId: '444' }
      ]
    });

    expect(Object.fromEntries(points)).toEqual({ c1: 3, c2: 3, c3: 0, c4: 0 });
    expect(client.eventAttendance.findMany).toHaveBeenCalledWith({
      where: { candidateId: { in: ['c1', 'c2', 'c3', 'c4'] }, event: { cycleId: 'cycle-1' } },
      select: { candidateId: true, eventId: true }
    });
    expect(client.meetingSignup.findMany.mock.calls[0][0].where).toEqual({
      studentId: { in: ['111', '222', '444'] },
      attended: true,
      slot: { startTime: { gte: new Date('2026-09-01') } }
    });
  });

  it('counts no meeting when the cycle has no start date', async () => {
    const client = bulkClient({ cycle: { startDate: null, endDate: null }, attendance: [{ candidateId: 'c1', eventId: 'e1' }] });
    const points = await loadParticipationPoints({ client, cycleId: 'cycle-1', candidates: [{ candidateId: 'c1', studentId: '111' }] });
    expect(points.get('c1')).toBe(1);
    expect(client.meetingSignup.findMany).not.toHaveBeenCalled();
  });

  it('reads nothing for nobody', async () => {
    const client = bulkClient();
    expect((await loadParticipationPoints({ client, cycleId: 'cycle-1', candidates: [] })).size).toBe(0);
    expect(client.recruitingCycle.findUnique).not.toHaveBeenCalled();
  });
});
