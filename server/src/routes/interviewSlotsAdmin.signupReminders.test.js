// POST /scheduling/rounds/:round/signup-reminders, and the reminder fields the
// scheduling overview carries for the page that sends them.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { sendEmail } from '../services/emailNotifications.js';
import interviewSlotsAdminRoutes from './interviewSlotsAdmin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    application: { findMany: vi.fn(), groupBy: vi.fn() },
    interviewSlot: { findMany: vi.fn() },
    interview: { findMany: vi.fn() },
    interviewSlotNotification: { groupBy: vi.fn() },
    communicationLog: { findMany: vi.fn() },
  },
}));
vi.mock('../services/activeCycle.js', () => ({
  resolveAdminCycle: vi.fn(async () => ({ id: 'cycle-1', name: 'Fall 2026' })),
}));
vi.mock('../services/emailNotifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendEmail: vi.fn(async () => ({ success: true })),
}));
vi.mock('../services/emailTheme.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveEmailTheme: vi.fn(async () => ({ ...actual.THEME_DEFAULTS })) };
});

let server;
let port;

const request = (path, { method = 'POST', body } = {}) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });

const openSession = { id: 'slot-1', candidateCapacity: 20, signupOpensAt: null, signupClosesAt: null };
const person = (id, extra = {}) => ({ id, firstName: id, lastName: 'Test', email: `${id}@example.com`, major1: null, graduationYear: null, ...extra });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (req, res, next) => {
    req.user = { id: 'admin-1', role: 'ADMIN' };
    next();
  });
  app.use('/api/admin', interviewSlotsAdminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.interviewSlot.findMany.mockResolvedValue([openSession]);
  prisma.application.findMany.mockResolvedValue([]);
});

describe('POST /scheduling/rounds/:round/signup-reminders', () => {
  it('refuses a round nobody books', async () => {
    const res = await request('/scheduling/rounds/1/signup-reminders');
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a merge field it cannot fill', async () => {
    const res = await request('/scheduling/rounds/2/signup-reminders', { body: { message: 'Hi {{nickname}}' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown merge field in message: {{nickname}}');
  });

  it('refuses applicationIds that are not a list of ids', async () => {
    const res = await request('/scheduling/rounds/2/signup-reminders', { body: { applicationIds: [1, 2] } });
    expect(res.status).toBe(400);
  });

  it('refuses to send when no session in the round is open', async () => {
    prisma.interviewSlot.findMany.mockResolvedValue([
      { ...openSession, signupClosesAt: new Date(Date.now() - 60_000) },
    ]);
    prisma.application.findMany.mockResolvedValue([person('a1')]);

    const res = await request('/scheduling/rounds/2/signup-reminders');

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_OPEN_SESSIONS');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends only to the requested people still unbooked, and counts the rest as skipped', async () => {
    // a2 booked since the page loaded, so it is no longer in the unbooked list;
    // a3 has no address.
    prisma.application.findMany.mockResolvedValue([person('a1'), person('a3', { email: null }), person('a4')]);

    const res = await request('/scheduling/rounds/2/signup-reminders', {
      body: { applicationIds: ['a1', 'a2', 'a3'], subject: 'Book {{round}}, {{firstName}}' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: [], skipped: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, attachments, meta] = sendEmail.mock.calls[0];
    expect(to).toBe('a1@example.com');
    expect(subject).toBe('Book Coffee Chats, a1');
    expect(html).toContain('/interview-signup');
    expect(attachments).toEqual([]);
    expect(meta).toEqual({
      category: 'SIGNUP_REMINDER',
      trigger: 'MANUAL',
      recipientName: 'a1 Test',
      triggeredById: 'admin-1',
      cycleId: 'cycle-1',
      attemptKey: expect.stringMatching(/^signup-reminder:2:a1:[\w-]+$/),
    });

    // Unbooked is recomputed for this round of this cycle at send time.
    const { where } = prisma.application.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ cycleId: 'cycle-1', currentRound: '2' });
  });

  it('sends to everyone unbooked when no ids are given', async () => {
    prisma.application.findMany.mockResolvedValue([person('a1'), person('a4')]);

    const res = await request('/scheduling/rounds/3/signup-reminders');

    expect(await res.json()).toEqual({ sent: 2, failed: [], skipped: 0 });
    expect(sendEmail.mock.calls.map((c) => c[0])).toEqual(['a1@example.com', 'a4@example.com']);
    expect(sendEmail.mock.calls[0][1]).toBe('Pick your First Round Interviews time');
  });
});

describe('GET /scheduling/overview', () => {
  it('adds lastRemindedAt per unbooked person, read once, and the reminder defaults', async () => {
    prisma.interview.findMany.mockResolvedValue([]);
    prisma.application.groupBy.mockResolvedValue([{ currentRound: '2', _count: { _all: 2 } }]);
    prisma.application.findMany.mockImplementation(async ({ where }) =>
      where.currentRound === '2' ? [person('a1'), person('a2')] : []
    );
    prisma.communicationLog.findMany.mockResolvedValue([
      { attemptKey: 'signup-reminder:2:a1:s1|a1@example.com', sentAt: new Date('2026-10-01T10:00:00Z') },
      { attemptKey: 'signup-reminder:3:a2:s1|a2@example.com', sentAt: new Date('2026-10-01T10:00:00Z') },
    ]);
    prisma.interviewSlotNotification.groupBy.mockResolvedValue([]);

    const res = await request('/scheduling/overview', { method: 'GET' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(prisma.communicationLog.findMany).toHaveBeenCalledTimes(1);
    const coffee = body.rounds.find((r) => r.round === '2');
    expect(coffee.unassigned.map((u) => [u.id, u.lastRemindedAt])).toEqual([
      ['a1', '2026-10-01T10:00:00.000Z'],
      // Reminded for a different round, which does not count here.
      ['a2', null],
    ]);
    expect(coffee.stats.unassigned).toBe(2);
    expect(body.reminderDefaults).toEqual({
      subject: expect.any(String),
      message: expect.not.stringContaining('{{deadline}}'),
      mergeFields: ['firstName', 'fullName', 'round', 'deadline'],
    });
  });
});
