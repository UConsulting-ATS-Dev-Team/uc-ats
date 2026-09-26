// A member's own RSVP from the Events page.
//
// The assertions worth having: only staff can RSVP, a started event cannot be
// RSVP'd to or cancelled, a second RSVP is not an error, and cancelling never
// removes an RSVP that came from Luma or a Google Form - the ATS cannot undo
// that registration, so deleting our copy would only make the two disagree.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';
import { sendRSVPConfirmation } from '../services/emailNotifications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    events: { findUnique: vi.fn(), findMany: vi.fn() },
    memberEventRsvp: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() }
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendRSVPConfirmation: vi.fn(() => Promise.resolve({ success: true })),
  sendMeetingCancellationEmail: vi.fn(),
  formatEventDate: vi.fn(() => 'Oct 8')
}));

const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Pam Beesly' };
const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Ada Admin' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'c@uc.org', fullName: 'Applicant' };
const ALL_USERS = [memberUser, adminUser, candidateUser];

const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const past = new Date(Date.now() - 3600 * 1000);
const upcomingEvent = { id: 'evt-1', eventName: 'Info Session', eventStartDate: future, eventLocation: 'Ackerman' };
const startedEvent = { id: 'evt-2', eventName: 'Mixer', eventStartDate: past, eventLocation: null };
const rsvpOffEvent = { id: 'evt-3', eventName: 'Workshop', eventStartDate: future, eventLocation: null, memberRsvpEnabled: false };
const EVENTS = [upcomingEvent, startedEvent, rsvpOffEvent];

// One member's RSVPs, keyed by event, standing in for member_event_rsvp.
let rows;

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET' } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(method === 'PUT' ? { body: '{}' } : {})
  });
};

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => ALL_USERS.find((u) => u.id === id) || null);
  prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', isActive: true });
  prisma.events.findUnique.mockImplementation(({ where: { id } }) => EVENTS.find((e) => e.id === id) || null);
  prisma.events.findMany.mockResolvedValue(EVENTS);
  prisma.memberEventRsvp.create.mockImplementation(({ data }) => {
    if (rows.has(data.eventId)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    rows.set(data.eventId, { ...data });
    return rows.get(data.eventId);
  });
  prisma.memberEventRsvp.findUnique.mockImplementation(({ where }) => rows.get(where.eventId_memberId.eventId) || null);
  prisma.memberEventRsvp.findMany.mockImplementation(() => [...rows.values()]);
  prisma.memberEventRsvp.deleteMany.mockImplementation(({ where }) => {
    const row = rows.get(where.eventId);
    if (row && row.source === where.source) {
      rows.delete(where.eventId);
      return { count: 1 };
    }
    return { count: 0 };
  });
});

describe('PUT /api/member/events/:eventId/rsvp', () => {
  it('refuses a candidate', async () => {
    const res = await request('/api/member/events/evt-1/rsvp', { user: candidateUser, method: 'PUT' });
    expect(res.status).toBe(403);
    expect(prisma.memberEventRsvp.create).not.toHaveBeenCalled();
  });

  it('records an IN_APP RSVP and sends the confirmation with the invite', async () => {
    const res = await request('/api/member/events/evt-1/rsvp', { user: memberUser, method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasMemberRsvpd: true, memberRsvpSource: 'IN_APP' });
    expect(prisma.memberEventRsvp.create).toHaveBeenCalledWith({
      data: { eventId: 'evt-1', memberId: 'member-1', source: 'IN_APP' }
    });
    expect(sendRSVPConfirmation).toHaveBeenCalledWith(
      'm@uc.org', 'Pam Beesly', 'Info Session', 'Oct 8', 'Ackerman', upcomingEvent
    );
  });

  it('lets an admin RSVP for themselves, from Event Management', async () => {
    const res = await request('/api/member/events/evt-1/rsvp', { user: adminUser, method: 'PUT' });
    expect(res.status).toBe(200);
    expect(prisma.memberEventRsvp.create).toHaveBeenCalledWith({
      data: { eventId: 'evt-1', memberId: 'admin-1', source: 'IN_APP' }
    });
  });

  it('treats a second RSVP as done, not as an error, and sends no second email', async () => {
    await request('/api/member/events/evt-1/rsvp', { user: memberUser, method: 'PUT' });
    const res = await request('/api/member/events/evt-1/rsvp', { user: memberUser, method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasMemberRsvpd: true, memberRsvpSource: 'IN_APP' });
    expect(sendRSVPConfirmation).toHaveBeenCalledTimes(1);
  });

  it('reports an existing Luma RSVP rather than writing over it', async () => {
    rows.set('evt-1', { eventId: 'evt-1', memberId: 'member-1', source: 'LUMA' });
    const res = await request('/api/member/events/evt-1/rsvp', { user: memberUser, method: 'PUT' });
    expect(await res.json()).toEqual({ hasMemberRsvpd: true, memberRsvpSource: 'LUMA' });
    expect(sendRSVPConfirmation).not.toHaveBeenCalled();
  });

  it('refuses an event that has started', async () => {
    const res = await request('/api/member/events/evt-2/rsvp', { user: memberUser, method: 'PUT' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('EVENT_STARTED');
    expect(prisma.memberEventRsvp.create).not.toHaveBeenCalled();
  });

  it('404s an unknown event', async () => {
    const res = await request('/api/member/events/nope/rsvp', { user: memberUser, method: 'PUT' });
    expect(res.status).toBe(404);
  });
});

describe('member RSVP turned off for an event', () => {
  it('refuses a new RSVP', async () => {
    const res = await request('/api/member/events/evt-3/rsvp', { user: memberUser, method: 'PUT' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RSVP_DISABLED');
    expect(prisma.memberEventRsvp.create).not.toHaveBeenCalled();
    expect(sendRSVPConfirmation).not.toHaveBeenCalled();
  });

  it('still cancels an in-app RSVP made before it was turned off', async () => {
    rows.set('evt-3', { eventId: 'evt-3', memberId: 'member-1', source: 'IN_APP' });
    const res = await request('/api/member/events/evt-3/rsvp', { user: memberUser, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(rows.has('evt-3')).toBe(false);
  });
});

describe('DELETE /api/member/events/:eventId/rsvp', () => {
  it('cancels an IN_APP RSVP', async () => {
    rows.set('evt-1', { eventId: 'evt-1', memberId: 'member-1', source: 'IN_APP' });
    const res = await request('/api/member/events/evt-1/rsvp', { user: memberUser, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasMemberRsvpd: false, memberRsvpSource: null });
    expect(rows.has('evt-1')).toBe(false);
  });

  it('leaves a Google Form RSVP in place and says why', async () => {
    rows.set('evt-1', { eventId: 'evt-1', memberId: 'member-1', source: 'GOOGLE_FORM' });
    const res = await request('/api/member/events/evt-1/rsvp', { user: memberUser, method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('RSVP_EXTERNAL');
    expect(body.memberRsvpSource).toBe('GOOGLE_FORM');
    expect(rows.has('evt-1')).toBe(true);
  });

  it('refuses to cancel once the event has started', async () => {
    rows.set('evt-2', { eventId: 'evt-2', memberId: 'member-1', source: 'IN_APP' });
    const res = await request('/api/member/events/evt-2/rsvp', { user: memberUser, method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(rows.has('evt-2')).toBe(true);
  });
});

describe('GET /api/member/events', () => {
  it('says where each RSVP came from', async () => {
    rows.set('evt-1', { eventId: 'evt-1', memberId: 'member-1', source: 'LUMA' });
    const res = await request('/api/member/events', { user: memberUser });
    const events = await res.json();
    expect(events.find((e) => e.id === 'evt-1')).toMatchObject({ hasMemberRsvpd: true, memberRsvpSource: 'LUMA' });
    expect(events.find((e) => e.id === 'evt-2')).toMatchObject({ hasMemberRsvpd: false, memberRsvpSource: null });
  });
});
