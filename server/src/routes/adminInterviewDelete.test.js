import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRoutes from './admin.js';
import prisma from '../prismaClient.js';
import { cancelInterviewCalendarEvent } from '../services/interviewCalendar.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    interview: { findUnique: vi.fn(), delete: vi.fn() },
    interviewAssignment: { deleteMany: vi.fn() },
    interviewActionItem: { deleteMany: vi.fn() },
    interviewEvaluation: { deleteMany: vi.fn() },
    firstRoundInterviewEvaluation: { deleteMany: vi.fn() },
    $transaction: vi.fn()
  }
}));

vi.mock('../services/interviewCalendar.js', () => ({
  syncInterviewCalendarEvent: vi.fn(),
  cancelInterviewCalendarEvent: vi.fn()
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', fullName: 'Admin User' };
const INTERVIEW = { id: 'interview-1', title: 'Round One', calendarEventId: 'ucatsinterview1' };

describe('DELETE /api/admin/interviews/:id', () => {
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
    prisma.interview.findUnique.mockResolvedValue({ ...INTERVIEW });
    prisma.$transaction.mockResolvedValue([]);
  });

  const del = () => fetch(`http://localhost:${port}/api/admin/interviews/${INTERVIEW.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}` }
  });

  it('keeps the interview when the calendar invite cannot be withdrawn', async () => {
    cancelInterviewCalendarEvent.mockResolvedValue({
      status: 'FAILED',
      error: 'Google Calendar is not configured.',
      calendarEventId: INTERVIEW.calendarEventId
    });

    const res = await del();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not deleted/i);
    expect(body.calendarSync.calendarEventId).toBe(INTERVIEW.calendarEventId);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes the interview once the invite is withdrawn', async () => {
    cancelInterviewCalendarEvent.mockResolvedValue({ status: 'CANCELLED' });

    const res = await del();

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('deletes the interview when there was never an invite', async () => {
    cancelInterviewCalendarEvent.mockResolvedValue({ status: 'NOT_SYNCED' });

    const res = await del();

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
