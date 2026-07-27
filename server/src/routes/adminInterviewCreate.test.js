import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRoutes from './admin.js';
import prisma from '../prismaClient.js';
import { syncInterviewCalendarEvent } from '../services/interviewCalendar.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findUnique: vi.fn() },
    interview: { create: vi.fn() }
  }
}));

vi.mock('../services/interviewCalendar.js', () => ({
  syncInterviewCalendarEvent: vi.fn(),
  cancelInterviewCalendarEvent: vi.fn()
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', fullName: 'Admin User' };
const CREATED = { id: 'interview-1', title: 'Round One', cycleId: 'cycle-1' };

describe('POST /api/admin/interviews', () => {
  let server;
  let port;

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
    prisma.user.findUnique.mockResolvedValue(adminUser);
    prisma.recruitingCycle.findUnique.mockResolvedValue({ id: 'cycle-1', name: 'Fall 2026' });
    prisma.interview.create.mockResolvedValue({ ...CREATED });
  });

  const create = () => fetch(`http://localhost:${port}/api/admin/interviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}`
    },
    body: JSON.stringify({
      title: 'Round One',
      interviewType: 'ROUND_ONE',
      startDate: '2026-02-14T17:00:00.000Z',
      endDate: '2026-02-14T19:30:00.000Z',
      location: 'Anderson 121',
      cycleId: 'cycle-1'
    })
  });

  it('returns the created interview even when calendar sync blows up', async () => {
    // A 500 here would push the client into re-creating the interview under a new ID, which the
    // deterministic event ID cannot deduplicate — a genuine duplicate invite.
    syncInterviewCalendarEvent.mockRejectedValue(new Error('sync state write failed'));

    const res = await create();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(CREATED.id);
    expect(body.calendarSync.status).toBe('FAILED');
    expect(body.calendarSync.error).toMatch(/Send invites/);
    expect(prisma.interview.create).toHaveBeenCalledTimes(1);
  });

  it('returns the sync result when the invite is sent', async () => {
    syncInterviewCalendarEvent.mockResolvedValue({ status: 'SYNCED', calendarEventId: 'ucatsinterview1', error: null });

    const res = await create();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calendarSync).toMatchObject({ status: 'SYNCED', calendarEventId: 'ucatsinterview1' });
  });
});
