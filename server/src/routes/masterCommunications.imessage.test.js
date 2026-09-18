// iMessage to members from Master Communications.
//
// The message leaves from the admin's own Messages app, so the server's part is
// narrow: say who can be reached, record that a send was opened, and refuse to
// pretend it can deliver or schedule an iMessage itself.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    messageLog: { create: vi.fn() },
    messageSchedule: { create: vi.fn() },
  },
}));

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin One' };
const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member One' };
const ALL = [admin, member];

let server;
let port;

const call = (path, { user, method = 'GET', body } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/master-communications', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => ALL.find((u) => u.id === id) || null);
  prisma.user.findMany.mockResolvedValue([{ ...member, phoneNumber: '+13105551234', profileImage: null }]);
  prisma.messageLog.create.mockResolvedValue({ id: 'log-1' });
});

describe('the member list', () => {
  it('is admin-only', async () => {
    expect((await call('/api/master-communications/imessage/members', { user: member })).status).toBe(403);
  });

  it('asks only for active admins and members, with their phone numbers', async () => {
    const res = await call('/api/master-communications/imessage/members', { user: admin });
    expect(res.status).toBe(200);
    expect((await res.json()).members[0].phoneNumber).toBe('+13105551234');

    const query = prisma.user.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ role: { in: ['ADMIN', 'MEMBER'] }, isActive: true });
    expect(query.select.phoneNumber).toBe(true);
  });
});

describe('logging a send', () => {
  it('writes an imessage log counting each recipient once', async () => {
    const res = await call('/api/master-communications/imessage/log', {
      user: admin,
      method: 'POST',
      body: { recipientIds: ['member-1', 'member-1', 'admin-1'], body: 'GBM tonight', cycleId: 'cycle-1' },
    });
    expect(res.status).toBe(201);
    expect(prisma.messageLog.create.mock.calls[0][0].data).toMatchObject({
      channel: 'imessage',
      recipientCount: 2,
      body: 'GBM tonight',
      sentBy: admin.id,
      cycleId: 'cycle-1',
    });
  });

  it('refuses a log with nobody in it', async () => {
    const res = await call('/api/master-communications/imessage/log', {
      user: admin,
      method: 'POST',
      body: { recipientIds: [], body: 'Hi' },
    });
    expect(res.status).toBe(400);
    expect(prisma.messageLog.create).not.toHaveBeenCalled();
  });

  it('fails loudly when the log write fails', async () => {
    // Messages is already open on the admin's machine by the time this is
    // called, so the log is the only record the send happened. A 201 here
    // would lose it silently.
    prisma.messageLog.create.mockRejectedValueOnce(new Error('log table down'));
    const res = await call('/api/master-communications/imessage/log', {
      user: admin,
      method: 'POST',
      body: { recipientIds: ['member-1'], body: 'GBM tonight' },
    });
    expect(res.status).toBe(500);
  });
});

describe('what the server will not do', () => {
  it('no longer builds the applicant phone packet', async () => {
    const res = await call('/api/master-communications/packet', { user: admin, method: 'POST', body: {} });
    expect(res.status).toBe(404);
  });

  it('does not send an iMessage', async () => {
    const res = await call('/api/master-communications/send', {
      user: admin,
      method: 'POST',
      body: { audience: 'members', channel: 'imessage', body: 'Hi' },
    });
    expect(res.status).toBe(400);
  });

  it('does not schedule an iMessage', async () => {
    const res = await call('/api/master-communications/schedule', {
      user: admin,
      method: 'POST',
      body: { audience: 'members', channel: 'imessage', body: 'Hi', scheduledAt: '2026-10-01T17:00:00Z' },
    });
    expect(res.status).toBe(400);
    expect(prisma.messageSchedule.create).not.toHaveBeenCalled();
  });
});
