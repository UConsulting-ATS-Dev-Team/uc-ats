// Building sessions from the availability grid: POST /interviews/:id/slots/generate
// with `sessions`. The slots and their interviewers are written together or not
// at all, and interviewers hear about it only once that write has committed.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { notifyInterviewersBulk } from '../services/interviewerInvites.js';
import interviewSlotsAdminRoutes from './interviewSlotsAdmin.js';

vi.mock('../prismaClient.js', () => {
  // Each model call returns a tagged marker, so the test can see exactly which
  // writes were handed to $transaction as one batch.
  const marker = (name) => vi.fn((args) => ({ op: name, args }));
  return {
    default: {
      interview: { findUnique: vi.fn(), update: marker('interview.update') },
      interviewSlot: { createMany: marker('interviewSlot.createMany'), findMany: vi.fn(async () => []) },
      interviewSlotAssignment: { createMany: marker('interviewSlotAssignment.createMany') },
      user: { findMany: vi.fn() },
      $transaction: vi.fn(async (ops) => ops.map(() => ({ count: 1 }))),
    },
  };
});

vi.mock('../services/interviewerInvites.js', () => ({
  notifyInterviewer: vi.fn(),
  notifyInterviewersBulk: vi.fn(async () => []),
}));

let server;
let port;

const request = (path, body) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const INTERVIEW = {
  id: 'int-1',
  interviewType: 'ROUND_ONE',
  // 9 AM - 5 PM Pacific on October 6.
  startDate: new Date('2026-10-06T16:00:00Z'),
  endDate: new Date('2026-10-07T00:00:00Z'),
  isVirtual: false,
};

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
  prisma.interview.findUnique.mockResolvedValue(INTERVIEW);
});

const nothingWritten = () => {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.interviewSlot.createMany).not.toHaveBeenCalled();
  expect(prisma.interviewSlotAssignment.createMany).not.toHaveBeenCalled();
  expect(notifyInterviewersBulk).not.toHaveBeenCalled();
};

describe('POST /interviews/:id/slots/generate with sessions', () => {
  it('creates the sessions and their interviewers in one transaction, then tells the interviewers', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    prisma.interviewSlot.findMany.mockResolvedValue([{ id: 'existing' }]);

    const res = await request('/interviews/int-1/slots/generate', {
      sessions: [
        {
          label: 'Panel A',
          startTime: '2026-10-06T16:00:00Z',
          endTime: '2026-10-06T17:00:00Z',
          location: 'Kerckhoff 133',
          candidateCapacity: 4,
          groupSize: null,
          interviewerCapacity: 2,
          interviewerIds: ['u1', 'u2', 'u1'],
        },
        { startTime: '2026-10-06T17:00:00Z', endTime: '2026-10-06T18:00:00Z', interviewerIds: ['u2'] },
      ],
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ created: 2, assigned: 3, slots: [{ id: 'existing' }] });

    // Only active members and admins count as interviewers, asked once for everyone.
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1', 'u2'] }, isActive: true, role: { in: ['MEMBER', 'ADMIN'] } },
      select: { id: true },
    });

    // Both writes in a single batch transaction. Inside the 9-5 range, so the
    // interview's dates are left alone.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const batch = prisma.$transaction.mock.calls[0][0];
    expect(batch.map((op) => op.op)).toEqual(['interviewSlot.createMany', 'interviewSlotAssignment.createMany']);

    const slots = prisma.interviewSlot.createMany.mock.calls[0][0].data;
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      interviewId: 'int-1',
      label: 'Panel A',
      location: 'Kerckhoff 133',
      candidateCapacity: 4,
      groupSize: null,
      interviewerCapacity: 2,
      startTime: new Date('2026-10-06T16:00:00Z'),
      endTime: new Date('2026-10-06T17:00:00Z'),
    });
    expect(slots[0].id).toEqual(expect.any(String));
    expect(slots[1].id).not.toBe(slots[0].id);

    const assignments = prisma.interviewSlotAssignment.createMany.mock.calls[0][0].data;
    expect(assignments).toEqual([
      { slotId: slots[0].id, interviewId: 'int-1', userId: 'u1', role: 'INTERVIEWER' },
      { slotId: slots[0].id, interviewId: 'int-1', userId: 'u2', role: 'INTERVIEWER' },
      { slotId: slots[1].id, interviewId: 'int-1', userId: 'u2', role: 'INTERVIEWER' },
    ]);

    // Each assigned interviewer is emailed, and only after the commit.
    expect(notifyInterviewersBulk).toHaveBeenCalledTimes(1);
    expect(notifyInterviewersBulk).toHaveBeenCalledWith([
      { slotId: slots[0].id, userId: 'u1' },
      { slotId: slots[0].id, userId: 'u2' },
      { slotId: slots[1].id, userId: 'u2' },
    ]);
    expect(notifyInterviewersBulk.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.$transaction.mock.invocationCallOrder[0]
    );
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it("widens the interview's range to cover a session outside it, in the same transaction", async () => {
    const res = await request('/interviews/int-1/slots/generate', {
      sessions: [
        // 8 AM Pacific, an hour before the range opens.
        { startTime: '2026-10-06T15:00:00Z', endTime: '2026-10-06T16:00:00Z' },
      ],
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: 1, assigned: 0 });
    // No interviewers means no lookup and no assignment write.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    const batch = prisma.$transaction.mock.calls[0][0];
    expect(batch.map((op) => op.op)).toEqual(['interviewSlot.createMany', 'interview.update']);
    expect(prisma.interview.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { startDate: new Date('2026-10-06T15:00:00Z'), endDate: INTERVIEW.endDate },
    });
  });

  it('refuses an interviewer who is not an active member, and writes nothing', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);

    const res = await request('/interviews/int-1/slots/generate', {
      sessions: [
        { startTime: '2026-10-06T16:00:00Z', endTime: '2026-10-06T17:00:00Z', interviewerIds: ['u1', 'gone'] },
      ],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^1 of the chosen interviewers is not an active member/);
    nothingWritten();
  });

  it('refuses a virtual coffee chat, which has exactly one session', async () => {
    prisma.interview.findUnique.mockResolvedValue({ ...INTERVIEW, isVirtual: true });

    const res = await request('/interviews/int-1/slots/generate', {
      sessions: [{ startTime: '2026-10-06T16:00:00Z', endTime: '2026-10-06T17:00:00Z' }],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exactly one session/);
    nothingWritten();
  });

  it('names the bad row', async () => {
    const res = await request('/interviews/int-1/slots/generate', {
      sessions: [
        { startTime: '2026-10-06T16:00:00Z', endTime: '2026-10-06T17:00:00Z' },
        { startTime: '2026-10-06T16:00:00Z', endTime: '2026-10-06T17:00:00Z' },
        { startTime: '2026-10-06T17:00:00Z', endTime: '2026-10-06T16:00:00Z' },
      ],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Session 3: the end time must be after the start time' });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('answers 404 for an interview that does not exist', async () => {
    prisma.interview.findUnique.mockResolvedValue(null);

    const res = await request('/interviews/nope/slots/generate', {
      sessions: [{ startTime: '2026-10-06T16:00:00Z', endTime: '2026-10-06T17:00:00Z' }],
    });

    expect(res.status).toBe(404);
    nothingWritten();
  });
});
