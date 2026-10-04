// Interview times are Los Angeles wall-clock times, whatever zone the server
// runs in. Render runs in UTC, and reading hours with getHours() there moved a
// 9 AM first round to 2 AM. These run the routes under TZ=UTC to pin that.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import interviewSlotsAdminRoutes from './interviewSlotsAdmin.js';

vi.mock('../prismaClient.js', () => {
  const interviewSlot = { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() };
  return {
    default: {
      interviewSlot,
      // The virtual coffee chat guard asks first; these are in-person interviews.
      interview: { update: vi.fn(), findUnique: vi.fn(async () => ({ isVirtual: false })) },
      $transaction: vi.fn((arg) => Promise.all(arg)),
    },
  };
});

const ORIGINAL_TZ = process.env.TZ;
let server;
let port;

const request = (path, { method = 'POST', body } = {}) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

beforeAll(async () => {
  process.env.TZ = 'UTC';
  const app = express();
  app.use(express.json());
  // Mounted behind requireAuth + requireAdmin in index.js; the route itself
  // only reads req.user.
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
  process.env.TZ = ORIGINAL_TZ;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /interviews/:id/reschedule', () => {
  it('keeps the Pacific hours when the move crosses a daylight-saving change', async () => {
    // 9-10 AM PST on January 15 is 17:00-18:00 UTC. On October 6, PDT, the
    // same 9-10 AM is 16:00-17:00 UTC.
    prisma.interviewSlot.findMany
      .mockResolvedValueOnce([
        { id: 'slot-1', startTime: new Date('2027-01-15T17:00:00Z'), endTime: new Date('2027-01-15T18:00:00Z') },
      ])
      .mockResolvedValueOnce([
        { id: 'slot-1', startTime: new Date('2026-10-06T16:00:00Z'), endTime: new Date('2026-10-06T17:00:00Z') },
      ]);
    prisma.interviewSlot.update.mockImplementation((args) => args);
    prisma.interview.update.mockResolvedValue({});

    const res = await request('/interviews/int-1/reschedule', { body: { day: '2026-10-06' } });

    expect(res.status).toBe(200);
    const { data } = prisma.interviewSlot.update.mock.calls[0][0];
    expect(data.startTime.toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(data.endTime.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(prisma.interview.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { startDate: new Date('2026-10-06T16:00:00Z'), endDate: new Date('2026-10-06T17:00:00Z') },
    });
  });

  it('rejects a day that is not a date', async () => {
    prisma.interviewSlot.findMany.mockResolvedValueOnce([
      { id: 'slot-1', startTime: new Date('2027-01-15T17:00:00Z'), endTime: new Date('2027-01-15T18:00:00Z') },
    ]);

    const res = await request('/interviews/int-1/reschedule', { body: { day: 'next tuesday' } });

    expect(res.status).toBe(400);
    expect(prisma.interviewSlot.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /interviews/slots/:slotId', () => {
  it('refuses a session that would end before it starts, without saving it', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue({
      startTime: new Date('2026-10-06T16:00:00Z'),
      endTime: new Date('2026-10-06T17:00:00Z'),
    });

    const res = await request('/interviews/slots/slot-1', {
      method: 'PATCH',
      body: { endTime: '2026-10-06T15:00:00Z' },
    });

    expect(res.status).toBe(400);
    expect(prisma.interviewSlot.update).not.toHaveBeenCalled();
  });

  it('saves an edit that only changes the label without reading the times', async () => {
    prisma.interviewSlot.update.mockResolvedValue({ id: 'slot-1', label: 'Room A' });

    const res = await request('/interviews/slots/slot-1', { method: 'PATCH', body: { label: 'Room A' } });

    expect(res.status).toBe(200);
    expect(prisma.interviewSlot.findUnique).not.toHaveBeenCalled();
    expect(prisma.interviewSlot.update).toHaveBeenCalledWith({ where: { id: 'slot-1' }, data: { label: 'Room A' } });
  });
});
