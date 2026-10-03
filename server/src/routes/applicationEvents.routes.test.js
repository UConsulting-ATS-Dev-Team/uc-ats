// GET /api/applications/:id/events - an applicant's events for their cycle, with
// RSVP and attendance. It used to run two queries per event; this pins both the
// response and the number of queries, which must not grow with the event count.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import applicationsRoutes from './applications.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    application: { findUnique: vi.fn() },
    events: { findMany: vi.fn() },
    eventRsvp: { findFirst: vi.fn(), findMany: vi.fn() },
    eventAttendance: { findFirst: vi.fn(), findMany: vi.fn() },
    meetingSignup: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  }
}));

// The sealed-record guard runs on `:id` before the handler and is unchanged here;
// it has its own suite. Every application in this one is unsealed.
vi.mock('../utils/lockedRecords.js', () => ({
  applicationParamGuard: (req, res, next) => next(),
  redactLockedApplications: (rows) => rows,
}));

const admin = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' };

const CYCLE = { id: 'cycle-1', isActive: true, startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-12-01T00:00:00Z') };
const application = {
  cycleId: CYCLE.id,
  candidateId: 'cand-1',
  studentId: '123456789',
  candidate: { studentId: '123456789' },
  cycle: CYCLE,
};

const meeting = {
  id: 'signup-1',
  slot: {
    startTime: new Date('2026-09-20T18:00:00Z'),
    endTime: new Date('2026-09-20T18:30:00Z'),
    location: 'Kerckhoff',
    member: { fullName: 'Host Member', profileImage: null },
  },
};

// N events in the cycle (plus one in another cycle that must not appear). The
// candidate RSVPed to every even event and attended every third; another
// candidate's rows sit on the same events and must not count.
function seed(n) {
  const events = Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    cycleId: CYCLE.id,
    eventName: `Event ${i}`,
    eventStartDate: new Date(Date.UTC(2026, 8, 2 + i)),
    eventEndDate: new Date(Date.UTC(2026, 8, 2 + i, 2)),
    eventLocation: i % 2 ? 'Ackerman' : null,
  }));
  events.push({ ...events[0], id: 'ev-other', cycleId: 'cycle-0' });
  const rsvps = [];
  const attendance = [];
  events.forEach((ev, i) => {
    if (i % 2 === 0) rsvps.push({ id: `r-${i}`, eventId: ev.id, candidateId: 'cand-1' });
    if (i % 3 === 0) attendance.push({ id: `a-${i}`, eventId: ev.id, candidateId: 'cand-1' });
    rsvps.push({ id: `r-x-${i}`, eventId: ev.id, candidateId: 'cand-2' });
    attendance.push({ id: `a-x-${i}`, eventId: ev.id, candidateId: 'cand-2' });
  });
  return { events, rsvps, attendance };
}

// The response as the route has always shaped it, written out by hand.
function expectedResponse({ events, rsvps, attendance }) {
  const has = (rows, eventId) => rows.some((r) => r.eventId === eventId && r.candidateId === 'cand-1');
  const rows = events
    .filter((ev) => ev.cycleId === CYCLE.id)
    .map(({ id, eventName, eventStartDate, eventEndDate, eventLocation }) => ({
      id, eventName, eventStartDate, eventEndDate, eventLocation,
      rsvpStatus: has(rsvps, id) ? 'RSVPed' : 'Not RSVPed',
      attendanceStatus: has(attendance, id) ? 'Attended' : 'Not Attended',
      points: has(attendance, id) ? 1 : 0,
    }));
  rows.push({
    id: 'meeting-signup-1',
    eventName: 'Get to Know UC',
    eventStartDate: meeting.slot.startTime,
    eventEndDate: meeting.slot.endTime,
    eventLocation: 'Kerckhoff',
    rsvpStatus: 'RSVPed',
    attendanceStatus: 'Attended',
    points: 1,
    isMeeting: true,
    memberName: 'Host Member',
  });
  return JSON.stringify({ events: rows, totalPoints: rows.reduce((s, r) => s + r.points, 0) });
}

const pick = (row, select) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;

// An in-memory stand-in that answers both the old per-event lookups and a
// batched read, so the same fixture can be served to either implementation.
function install({ events, rsvps, attendance }) {
  const byCycle = (cycleId) => events.filter((ev) => ev.cycleId === cycleId);
  const matches = (where) => (row) => {
    if (where.candidateId && row.candidateId !== where.candidateId) return false;
    if (typeof where.eventId === 'string' && row.eventId !== where.eventId) return false;
    if (where.eventId?.in && !where.eventId.in.includes(row.eventId)) return false;
    if (where.event?.cycleId && !byCycle(where.event.cycleId).some((ev) => ev.id === row.eventId)) return false;
    return true;
  };
  prisma.application.findUnique.mockResolvedValue(application);
  prisma.events.findMany.mockImplementation(async ({ where, select }) =>
    byCycle(where.cycleId)
      .sort((a, b) => a.eventStartDate - b.eventStartDate)
      .map((ev) => pick(ev, select)));
  for (const [model, rows] of [[prisma.eventRsvp, rsvps], [prisma.eventAttendance, attendance]]) {
    model.findFirst.mockImplementation(async ({ where }) => rows.find(matches(where)) ?? null);
    model.findMany.mockImplementation(async ({ where, select }) => rows.filter(matches(where)).map((r) => pick(r, select)));
  }
  prisma.meetingSignup.findFirst.mockResolvedValue(meeting);
}

// Every data query the route made; the auth middleware's user lookup is not one.
function queryCount() {
  return [
    prisma.application.findUnique, prisma.events.findMany,
    prisma.eventRsvp.findFirst, prisma.eventRsvp.findMany,
    prisma.eventAttendance.findFirst, prisma.eventAttendance.findMany,
    prisma.meetingSignup.findFirst,
  ].reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

describe('GET /api/applications/:id/events', () => {
  let server;
  let port;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const app = express();
    app.use('/api/applications', applicationsRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(admin);
  });

  const get = () =>
    fetch(`http://localhost:${port}/api/applications/app-1/events`, {
      headers: { Authorization: `Bearer ${jwt.sign({ userId: admin.id }, process.env.JWT_SECRET)}` },
    });

  const counts = {};

  it.each([1, 10, 50])('answers byte-for-byte as before with %i events', async (n) => {
    const fixture = seed(n);
    install(fixture);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expectedResponse(fixture));
    counts[n] = queryCount();
  });

  it('makes the same number of queries whatever the event count', () => {
    console.log(`queries per request by event count: ${JSON.stringify(counts)}`);
    expect(new Set(Object.values(counts)).size).toBe(1);
    expect(counts[50]).toBeLessThanOrEqual(5);
  });

  it('answers an empty list for an application with no candidate, as before', async () => {
    install(seed(3));
    prisma.application.findUnique.mockResolvedValue({ ...application, candidateId: null });
    const res = await get();
    expect(await res.json()).toEqual({ events: [], totalPoints: 0 });
  });

  it('skips Get to Know UC when the cycle has no start date', async () => {
    const fixture = seed(2);
    install(fixture);
    prisma.application.findUnique.mockResolvedValue({ ...application, cycle: { ...CYCLE, startDate: null } });
    const body = await (await get()).json();
    expect(body.events.map((e) => e.id)).toEqual(['ev-0', 'ev-1']);
    expect(prisma.meetingSignup.findFirst).not.toHaveBeenCalled();
  });
});
