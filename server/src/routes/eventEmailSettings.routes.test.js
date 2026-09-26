// The admin switch for Google Form sign-up confirmation emails. Thin over the
// service, so what is tested is the wiring: the actor is recorded, a bad value
// is a 400 rather than a 500, and the path is not swallowed by /events/:id.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';

import prisma from '../prismaClient.js';
import { getEventEmailSetting, setSendSignupConfirmations } from '../services/eventEmailSettings.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    $transaction: vi.fn((ops) => Promise.all(ops))
  }
}));

vi.mock('../services/eventEmailSettings.js', () => ({
  getEventEmailSetting: vi.fn(),
  setSendSignupConfirmations: vi.fn()
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };

let server;
let port;

const call = (method, body) =>
  fetch(`http://localhost:${port}/api/admin/event-email-settings`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

beforeAll(async () => {
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
  prisma.user.findUnique.mockResolvedValue(adminUser);
  getEventEmailSetting.mockResolvedValue({
    sendSignupConfirmations: false,
    updatedAt: null,
    updatedById: null
  });
});

describe('/api/admin/event-email-settings', () => {
  it('reads the current setting, and is not matched as an event id', async () => {
    const res = await call('GET');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sendSignupConfirmations: false });
    expect(getEventEmailSetting).toHaveBeenCalled();
  });

  it('saves a change and records who made it', async () => {
    setSendSignupConfirmations.mockResolvedValue({ sendSignupConfirmations: true });

    const res = await call('PATCH', { sendSignupConfirmations: true });

    expect(res.status).toBe(200);
    expect(setSendSignupConfirmations).toHaveBeenCalledWith(true, 'admin-1');
  });

  it('turns a rejected value into a 400, not a 500', async () => {
    setSendSignupConfirmations.mockRejectedValue(
      Object.assign(new Error('sendSignupConfirmations must be true or false'), {
        code: 'INVALID_EVENT_EMAIL_SETTING'
      })
    );

    const res = await call('PATCH', { sendSignupConfirmations: 'yes' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/true or false/);
  });

  it('does not report a failed save as saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setSendSignupConfirmations.mockRejectedValue(new Error('table is missing'));

    const res = await call('PATCH', { sendSignupConfirmations: true });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to save event email settings');
  });
});
