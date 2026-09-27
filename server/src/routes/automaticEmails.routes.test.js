import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    automaticEmail: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    automaticEmailSend: { groupBy: vi.fn(), findMany: vi.fn() },
    savedAudience: { findMany: vi.fn(), findUnique: vi.fn() },
    emailSignature: { findMany: vi.fn(), findUnique: vi.fn() },
    emailTheme: { findUnique: vi.fn() },
    emailTemplateStyle: { findMany: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class {}, SendEmailCommand: class {} }));

import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import routes from './automaticEmails.js';

const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin', createdAt: new Date().toISOString() };
const member = { ...admin, id: 'member-1', role: 'MEMBER', email: 'member@example.com' };
const token = (u) => jwt.sign({ userId: u.id }, process.env.JWT_SECRET);

const EMAIL = {
  name: 'Welcome',
  trigger: 'RECORD_CREATED',
  triggerConfig: { record: 'ACCOUNT' },
  subject: 'Welcome, {{firstName}}',
  body: 'Hi {{firstName}}',
};

describe('/api/admin/automatic-emails', () => {
  let server;
  const call = (path, u, init = {}) =>
    fetch(`http://localhost:${server.address().port}/api/admin/automatic-emails${path}`, {
      ...init,
      headers: { ...(u ? { Authorization: `Bearer ${token(u)}` } : {}), 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(() => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/automatic-emails', requireAuth, requireAdmin, routes);
    server = app.listen(0);
    return new Promise((resolve) => server.on('listening', resolve));
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => [admin, member].find((u) => u.id === id) ?? null);
    prisma.automaticEmail.findMany.mockResolvedValue([]);
    prisma.automaticEmailSend.groupBy.mockResolvedValue([]);
    prisma.automaticEmailSend.findMany.mockResolvedValue([]);
    prisma.savedAudience.findMany.mockResolvedValue([]);
    prisma.emailSignature.findMany.mockResolvedValue([]);
    prisma.emailTheme.findUnique.mockResolvedValue(null);
    prisma.emailTemplateStyle.findMany.mockResolvedValue([]);
    sendMail.mockResolvedValue({ messageId: 'm' });
  });

  it('is admin-only', async () => {
    expect((await call('', member)).status).toBe(403);
    expect((await call('', null)).status).toBe(401);
    expect((await call('/preview', member, { method: 'POST', body: { email: EMAIL } })).status).toBe(403);
  });

  it('previews without saving or sending anything', async () => {
    const res = await call('/preview', admin, { method: 'POST', body: { email: EMAIL } });

    expect(res.status).toBe(200);
    expect((await res.json()).subject).toBe('Welcome, Jordan');
    expect(prisma.automaticEmail.create).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason for an email it cannot save', async () => {
    const res = await call('', admin, { method: 'POST', body: { email: { ...EMAIL, body: 'Hi {{eventName}}' } } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\{\{eventName\}\}/);
  });

  it('sends a test only to the admin asking', async () => {
    const res = await call('/test', admin, { method: 'POST', body: { email: EMAIL } });
    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe(admin.email);
  });

  it('lists the options the editor offers', async () => {
    const body = await (await call('/options', admin)).json();
    expect(body.triggers.map((t) => t.id)).toEqual(['APPLICATION_STATUS', 'RECORD_CREATED', 'EVENT_TIME', 'INTERVIEW_TIME', 'CYCLE_DATE']);
  });
});
