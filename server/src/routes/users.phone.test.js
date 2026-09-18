// A phone number on a User is a destination the org messages, not a profile
// field its owner asserts. An admin picks iMessage recipients by name and never
// sees the number behind them, so whoever can write that field decides where an
// admin's message lands.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import routes from './users.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
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
  app.use('/api/users', routes);
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
  prisma.user.update.mockImplementation(({ data }) => ({ ...member, ...data }));
});

describe('changing a phone number', () => {
  it('refuses a member setting one on their own record', async () => {
    // Otherwise a member points this at a third party and the next admin
    // message addressed to their name goes to that third party instead.
    const res = await call('/api/users/member-1', {
      user: member,
      method: 'PATCH',
      body: { phoneNumber: '310-555-9999' },
    });
    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('lets an admin set one', async () => {
    const res = await call('/api/users/member-1', {
      user: admin,
      method: 'PATCH',
      body: { phoneNumber: '310-555-9999' },
    });
    expect(res.status).toBe(200);
    expect(prisma.user.update.mock.calls[0][0].data.phoneNumber).toBe('+13105559999');
  });

  it('still lets a member edit the rest of their own profile', async () => {
    const res = await call('/api/users/member-1', {
      user: member,
      method: 'PATCH',
      body: { fullName: 'Member Renamed' },
    });
    expect(res.status).toBe(200);
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ fullName: 'Member Renamed' });
  });
});
