// Who may reach the people booked into a GTKUC slot: its host and any admin,
// never another member.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import { resolveSignupContacts, logSignupContact } from '../services/meetingSignupContacts.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    meetingSlot: { findUnique: vi.fn() },
  },
}));

vi.mock('../services/meetingSignupContacts.js', () => ({
  resolveSignupContacts: vi.fn(),
  logSignupContact: vi.fn(),
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };
const hostMember = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'host@example.com', fullName: 'Host Member' };
const otherMember = { id: 'member-2', role: 'MEMBER', isActive: true, email: 'other@example.com', fullName: 'Other Member' };

const signups = [
  { id: 'signup-1', slotId: 'slot-1', fullName: 'Cand One', email: 'one@ucla.edu' },
  { id: 'signup-2', slotId: 'slot-1', fullName: 'Cand Two', email: 'two@ucla.edu' },
];
const contacts = [{ signupId: 'signup-1', fullName: 'Cand One', email: 'one@ucla.edu', phoneNumber: '+13105551234' }];

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', body } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

beforeAll(async () => {
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
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [adminUser, hostMember, otherMember].find((u) => u.id === id) || null
  );
  prisma.meetingSlot.findUnique.mockResolvedValue({ id: 'slot-1', memberId: hostMember.id, signups });
  resolveSignupContacts.mockResolvedValue(contacts);
  logSignupContact.mockResolvedValue(1);
});

describe('GET /api/member/meeting-slots/:id/contacts', () => {
  it('gives the host everyone in their slot', async () => {
    const res = await request('/api/member/meeting-slots/slot-1/contacts', { user: hostMember });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts });
    expect(resolveSignupContacts).toHaveBeenCalledWith(signups);
  });

  it('lets an admin contact anyone\'s slot', async () => {
    const res = await request('/api/member/meeting-slots/slot-1/contacts', { user: adminUser });
    expect(res.status).toBe(200);
  });

  it('refuses another member', async () => {
    const res = await request('/api/member/meeting-slots/slot-1/contacts', { user: otherMember });
    expect(res.status).toBe(403);
    expect(resolveSignupContacts).not.toHaveBeenCalled();
  });

  it('answers 404 for a slot that does not exist', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(null);
    const res = await request('/api/member/meeting-slots/nope/contacts', { user: hostMember });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/member/meeting-slots/:id/contacts/log', () => {
  it('logs only the people who were in the message and are still in the slot', async () => {
    const res = await request('/api/member/meeting-slots/slot-1/contacts/log', {
      user: hostMember,
      method: 'POST',
      // signup-9 is not in this slot (cancelled, or never was); signup-2 booked
      // after the dialog opened and was not messaged.
      body: { channel: 'imessage', body: 'Meet at the patio', signupIds: ['signup-1', 'signup-9'] },
    });
    expect(res.status).toBe(201);
    expect(resolveSignupContacts).toHaveBeenCalledWith([signups[0]]);
    expect(logSignupContact).toHaveBeenCalledWith({
      channel: 'imessage',
      body: 'Meet at the patio',
      contacts,
      triggeredById: hostMember.id,
    });
  });

  it('passes a refused channel back as its status', async () => {
    logSignupContact.mockRejectedValue(Object.assign(new Error('channel must be one of imessage, email'), { status: 400 }));
    const res = await request('/api/member/meeting-slots/slot-1/contacts/log', {
      user: hostMember,
      method: 'POST',
      body: { channel: 'slack', signupIds: [] },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a log without the list of who was messaged', async () => {
    const res = await request('/api/member/meeting-slots/slot-1/contacts/log', {
      user: hostMember,
      method: 'POST',
      body: { channel: 'email' },
    });
    expect(res.status).toBe(400);
    expect(logSignupContact).not.toHaveBeenCalled();
  });

  it('refuses another member', async () => {
    const res = await request('/api/member/meeting-slots/slot-1/contacts/log', {
      user: otherMember,
      method: 'POST',
      body: { channel: 'email', signupIds: ['signup-1'] },
    });
    expect(res.status).toBe(403);
    expect(logSignupContact).not.toHaveBeenCalled();
  });
});
