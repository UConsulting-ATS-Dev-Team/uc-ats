// The accountability check-in list shows who RSVP'd, so an admin can mark
// attendance from the RSVP list at the door. Attendance and RSVP are separate
// facts: an RSVP never counts as attendance, and a walk-in with no RSVP can
// still be marked present.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    events: { findUnique: vi.fn(), findMany: vi.fn() },
    recruitingCycle: { findUnique: vi.fn(), findFirst: vi.fn() },
    meetingSlot: { findMany: vi.fn() },
    memberEventAttendance: { findMany: vi.fn() },
    memberEventRsvp: { findMany: vi.fn() }
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Pam Beesly' };
const members = [
  { id: 'm-rsvp-came', fullName: 'Came', email: 'came@uc.org', studentId: '1' },
  { id: 'm-rsvp-noshow', fullName: 'No Show', email: 'noshow@uc.org', studentId: '2' },
  { id: 'm-walkin', fullName: 'Walk In', email: 'walkin@uc.org', studentId: '3' },
  { id: 'm-absent', fullName: 'Absent', email: 'absent@uc.org', studentId: '4' }
];

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const get = (path, user = adminUser) =>
  fetch(`http://localhost:${port}/api/admin${path}`, { headers: { Authorization: `Bearer ${tokenFor(user)}` } });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => [adminUser, memberUser].find((u) => u.id === id) || null);
  prisma.user.findMany.mockResolvedValue(members);
  prisma.events.findUnique.mockResolvedValue({ id: 'evt-1', eventName: 'GM', memberAttendanceForm: null });
  prisma.memberEventAttendance.findMany.mockResolvedValue([
    { memberId: 'm-rsvp-came', source: 'MANUAL' },
    { memberId: 'm-walkin', source: 'MANUAL' }
  ]);
  prisma.memberEventRsvp.findMany.mockResolvedValue([
    { memberId: 'm-rsvp-came', source: 'IN_APP' },
    { memberId: 'm-rsvp-noshow', source: 'LUMA' }
  ]);
});

describe('GET /api/admin/accountability/events/:id/members', () => {
  it('refuses a member', async () => {
    const res = await get('/accountability/events/evt-1/members', memberUser);
    expect(res.status).toBe(403);
  });

  it('reports RSVP and attendance for each member independently', async () => {
    const res = await get('/accountability/events/evt-1/members');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((await res.json()).members.map((m) => [m.id, m]));

    expect(byId['m-rsvp-came']).toMatchObject({ rsvpd: true, rsvpSource: 'IN_APP', attended: true });
    expect(byId['m-rsvp-noshow']).toMatchObject({ rsvpd: true, rsvpSource: 'LUMA', attended: false });
    expect(byId['m-walkin']).toMatchObject({ rsvpd: false, rsvpSource: null, attended: true });
    expect(byId['m-absent']).toMatchObject({ rsvpd: false, attended: false });
  });
});

describe('GET /api/admin/accountability', () => {
  it('carries each event\'s member RSVP count next to its attendance count', async () => {
    prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', name: 'Fall', isActive: true });
    prisma.memberEventAttendance.findMany.mockResolvedValue([]);
    prisma.meetingSlot.findMany.mockResolvedValue([]);
    prisma.events.findMany.mockResolvedValue([
      { id: 'evt-1', eventName: 'GM', _count: { memberEventAttendance: 1, memberEventRsvp: 2 } }
    ]);

    const res = await get('/accountability');
    expect(res.status).toBe(200);
    expect((await res.json()).events[0]).toMatchObject({ memberAttendanceCount: 1, memberRsvpCount: 2 });
  });
});
