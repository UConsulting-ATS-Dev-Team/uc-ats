// The admin side of accountability points: the summary carries every member's
// points, admins edit what each type is worth and tag events, and reminders go
// only to members who are still under the target when the send happens.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import { sendEmail } from '../services/emailNotifications.js';
import adminRoutes from './admin.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => {
  const empty = () => vi.fn(async () => []);
  return {
    default: {
      user: { findUnique: vi.fn(), findMany: vi.fn() },
      events: { findMany: empty(), update: vi.fn() },
      recruitingCycle: { findUnique: vi.fn(), findFirst: vi.fn() },
      accountabilityPointValue: { findMany: empty(), upsert: vi.fn() },
      accountabilitySetting: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
      meetingSlot: { findMany: empty() },
      memberEventAttendance: { findMany: empty() },
      resumeScore: { findMany: empty() },
      coverLetterScore: { findMany: empty() },
      videoScore: { findMany: empty() },
      interview: { findMany: empty() },
      interviewSlotAssignment: { findMany: empty() },
      interviewAssignment: { findMany: empty() },
      $transaction: vi.fn(async (ops) => ops)
    }
  };
});

vi.mock('../services/emailNotifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendEmail: vi.fn(async () => ({ success: true }))
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Pam Beesly' };
const staff = [
  { id: 'done', fullName: 'Done Dana', email: 'dana@uc.org', role: 'MEMBER' },
  { id: 'member-1', fullName: 'Pam Beesly', email: 'm@uc.org', role: 'MEMBER' }
];
const cycle = { id: 'cycle-1', name: 'Fall', isActive: true, startDate: null, endDate: null };

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const call = (method, path, body, user = adminUser) =>
  fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
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
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => [adminUser, memberUser].find((u) => u.id === id) || null);
  prisma.user.findMany.mockResolvedValue(staff);
  prisma.recruitingCycle.findFirst.mockResolvedValue(cycle);
  prisma.recruitingCycle.findUnique.mockResolvedValue(cycle);
  // Dana has 3 points (application screen, coffee chats, first round); Pam has 0.5 (GTKUC).
  prisma.resumeScore.findMany.mockResolvedValue([{ evaluatorId: 'done' }]);
  prisma.meetingSlot.findMany.mockResolvedValue([{ memberId: 'member-1' }]);
  prisma.interview.findMany.mockResolvedValue([
    { id: 'cc', interviewType: 'COFFEE_CHAT', startDate: new Date('2020-01-01'), description: null },
    { id: 'r1', interviewType: 'ROUND_ONE', startDate: new Date('2020-01-02'), description: null }
  ]);
  prisma.interviewAssignment.findMany.mockResolvedValue([
    { interviewId: 'cc', userId: 'done' },
    { interviewId: 'r1', userId: 'done' }
  ]);
});

describe('GET /api/admin/accountability', () => {
  it('ranks members by points and says who has met the target', async () => {
    const res = await call('GET', '/admin/accountability');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaderboard.map((m) => [m.id, m.points, m.met])).toEqual([
      ['done', 3, true],
      ['member-1', 0.5, false]
    ]);
    expect(body.config.targetPoints).toBe(3);
    expect(body.config.eventPointTypes).toContain('CASE_BUDDIES');
    expect(body.reminderDefaults.mergeFields).toContain('remainingPoints');
  });
});

describe('PUT /api/admin/accountability/config', () => {
  it('saves new values', async () => {
    const res = await call('PUT', '/admin/accountability/config', { points: { GTKUC: 1 }, targetPoints: 4 });
    expect(res.status).toBe(200);
    expect(prisma.accountabilityPointValue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { type: 'GTKUC', points: 1, updatedById: 'admin-1' } })
    );
  });

  it('answers 400 for a bad value', async () => {
    const res = await call('PUT', '/admin/accountability/config', { points: { GTKUC: -2 } });
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    const res = await call('PUT', '/admin/accountability/config', { points: { GTKUC: 1 } }, memberUser);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/admin/accountability/events/:id/point-type', () => {
  it('tags an event with an event-credited type', async () => {
    prisma.events.update.mockResolvedValue({ id: 'evt-1', pointType: 'WOMENS_NIGHT' });
    const res = await call('PUT', '/admin/accountability/events/evt-1/point-type', { pointType: 'WOMENS_NIGHT' });
    expect(res.status).toBe(200);
    expect(prisma.events.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pointType: 'WOMENS_NIGHT' } }));
  });

  it('clears the tag with null', async () => {
    prisma.events.update.mockResolvedValue({ id: 'evt-1', pointType: null });
    const res = await call('PUT', '/admin/accountability/events/evt-1/point-type', { pointType: null });
    expect(res.status).toBe(200);
    expect(prisma.events.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pointType: null } }));
  });

  it('refuses a type that is not earned by attending an event', async () => {
    const res = await call('PUT', '/admin/accountability/events/evt-1/point-type', { pointType: 'FINAL_ROUND' });
    expect(res.status).toBe(400);
    expect(prisma.events.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/accountability/reminders', () => {
  it('emails only the members still under target, and says who it skipped', async () => {
    const res = await call('POST', '/admin/accountability/reminders', { memberIds: ['done', 'member-1'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: [], skipped: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe('m@uc.org');
    expect(sendEmail.mock.calls[0][1]).toBe('Accountability reminder: 0.5 of 3 points');
  });

  it('refuses an unknown merge field before sending anything', async () => {
    const res = await call('POST', '/admin/accountability/reminders', { message: 'Hi {{nickname}}' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch('{{nickname}}');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('GET /api/member/accountability', () => {
  it("returns the caller's own standing and nobody else's", async () => {
    const res = await call('GET', '/member/accountability', undefined, memberUser);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle).toEqual({ id: 'cycle-1', name: 'Fall' });
    expect(body.standing).toMatchObject({ points: 0.5, remainingPoints: 2.5, met: false });
    expect(body.standing.id).toBeUndefined();
    expect(prisma.meetingSlot.findMany.mock.calls[0][0].where.memberId).toEqual({ in: ['member-1'] });
  });
});
