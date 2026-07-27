import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRoutes from './admin.js';
import prisma from '../prismaClient.js';
import { syncInterviewCalendarEvent } from '../services/interviewCalendar.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    interview: { findUnique: vi.fn(), update: vi.fn() }
  }
}));

vi.mock('../services/interviewCalendar.js', () => ({
  syncInterviewCalendarEvent: vi.fn(),
  cancelInterviewCalendarEvent: vi.fn()
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', fullName: 'Admin User' };
const EXISTING = {
  id: 'interview-1',
  title: 'Round One',
  status: 'UPCOMING',
  location: 'Anderson 121',
  startDate: new Date('2026-02-14T17:00:00.000Z'),
  endDate: new Date('2026-02-14T19:30:00.000Z'),
  calendarEventId: 'ucatsinterview1'
};

describe('PATCH /api/admin/interviews/:id', () => {
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
    prisma.interview.findUnique.mockResolvedValue({ ...EXISTING });
    prisma.interview.update.mockImplementation(({ data }) => Promise.resolve({ ...EXISTING, ...data }));
    syncInterviewCalendarEvent.mockResolvedValue({
      status: 'SYNCED',
      calendarEventId: EXISTING.calendarEventId,
      error: null
    });
  });

  const patch = (body) => fetch(`http://localhost:${port}/api/admin/interviews/${EXISTING.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}`
    },
    body: JSON.stringify(body)
  });

  it('persists a time/location change and syncs the same calendar event', async () => {
    const res = await patch({
      startDate: '2026-02-15T18:00:00.000Z',
      endDate: '2026-02-15T20:00:00.000Z',
      location: 'Zoom https://ucla.zoom.us/j/123'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(prisma.interview.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: EXISTING.id },
      data: {
        startDate: new Date('2026-02-15T18:00:00.000Z'),
        endDate: new Date('2026-02-15T20:00:00.000Z'),
        location: 'Zoom https://ucla.zoom.us/j/123'
      }
    }));
    expect(syncInterviewCalendarEvent).toHaveBeenCalledWith(EXISTING.id, { reason: 'schedule updated' });
    // Same provider event, not a second invitation.
    expect(body.calendarSync).toMatchObject({ status: 'SYNCED', calendarEventId: EXISTING.calendarEventId });
  });

  it('still saves the edit and reports the failure when the provider update fails', async () => {
    syncInterviewCalendarEvent.mockResolvedValue({
      status: 'FAILED',
      calendarEventId: EXISTING.calendarEventId,
      error: 'Google Calendar rate limit exceeded. Retry with "Send invites".'
    });

    const res = await patch({ location: 'Kerckhoff 200' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.location).toBe('Kerckhoff 200');
    expect(body.calendarSync).toMatchObject({ status: 'FAILED', calendarEventId: EXISTING.calendarEventId });
  });

  it('saves the edit when calendar sync throws outright', async () => {
    syncInterviewCalendarEvent.mockRejectedValue(new Error('boom'));

    const res = await patch({ location: 'Kerckhoff 200' });

    expect(res.status).toBe(200);
    expect((await res.json()).calendarSync.status).toBe('FAILED');
    expect(prisma.interview.update).toHaveBeenCalledTimes(1);
  });

  it('rejects fields that are not editable here', async () => {
    const res = await patch({ status: 'COMPLETED', cycleId: 'cycle-2' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/status, cycleId/);
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it('rejects an end before the stored start and an invalid date', async () => {
    const inverted = await patch({ endDate: '2026-02-14T16:00:00.000Z' });
    expect(inverted.status).toBe(400);
    expect((await inverted.json()).error).toMatch(/end must be after/i);

    const invalid = await patch({ startDate: 'not-a-date' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/valid date/);

    expect(prisma.interview.update).not.toHaveBeenCalled();
    expect(syncInterviewCalendarEvent).not.toHaveBeenCalled();
  });

  it('refuses to edit a completed interview', async () => {
    prisma.interview.findUnique.mockResolvedValue({ ...EXISTING, status: 'COMPLETED' });

    const res = await patch({ location: 'Kerckhoff 200' });

    expect(res.status).toBe(409);
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it('404s for an unknown interview', async () => {
    prisma.interview.findUnique.mockResolvedValue(null);

    const res = await patch({ location: 'Kerckhoff 200' });

    expect(res.status).toBe(404);
  });
});
