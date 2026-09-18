// Every way onto or off an interviewer roster has to reach the interviewer's
// calendar - not just the two an admin drives.
//
// The regression this exists for: assigning somebody from the admin roster sent
// an invite, but a member claiming a session themselves, a member dropping out,
// and adopting a whole round's legacy groups all changed the roster in silence.
// The first left an interviewer with no entry, the second left a stale one
// sitting on their calendar, and the third missed the exact moment a roster is
// finalised.
//
// services/interviewerInvites.js is mocked here on purpose: what is under test is
// whether each route asks for the telling, not how the message is built. The
// building has its own tests in services/interviewSlotComms.invites.test.js.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { notifyInterviewer, notifyInterviewersBulk } from '../services/interviewerInvites.js';
import memberRoutes from './interviewSlotsMember.js';
import adminRoutes from './interviewSlotsAdmin.js';

vi.mock('../services/interviewerInvites.js', () => ({
  notifyInterviewer: vi.fn().mockResolvedValue(undefined),
  notifyInterviewersBulk: vi.fn().mockResolvedValue([]),
}));

const tx = {
  interviewSlot: { findUnique: vi.fn(), create: vi.fn() },
  interviewSlotAssignment: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
  interviewSlotSignup: { findFirst: vi.fn(), create: vi.fn() },
};

vi.mock('../prismaClient.js', () => ({
  default: {
    $transaction: vi.fn(),
    interview: { findUnique: vi.fn() },
    interviewSlot: { findUnique: vi.fn() },
    interviewSlotAssignment: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true };
const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true };

let server;
let port;
let actingAs = memberUser;

const request = (path, { method = 'GET', body } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Auth is applied at mount in index.js, not inside these routers, so the test
  // supplies the identity the same way the app does.
  app.use((req, _res, next) => {
    req.user = actingAs;
    next();
  });
  app.use('/api/member', memberRoutes);
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
  actingAs = memberUser;
  prisma.$transaction.mockImplementation((fn) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn)));
});

describe('a member claiming a session themselves', () => {
  beforeEach(() => {
    tx.interviewSlot.findUnique.mockResolvedValue({
      id: 'slot-1',
      interviewId: 'int-1',
      startTime: new Date('2026-10-06T16:00:00.000Z'),
      endTime: new Date('2026-10-06T16:30:00.000Z'),
      interviewerCapacity: 2,
      interview: { id: 'int-1', cycleId: 'cycle-1', status: 'UPCOMING' },
    });
    tx.interviewSlotAssignment.findFirst.mockResolvedValue(null);
    tx.interviewSlotAssignment.count.mockResolvedValue(0);
    tx.interviewSlotAssignment.create.mockResolvedValue({ id: 'asn-1' });
  });

  it('sends them the invite an admin placement would have sent', async () => {
    const res = await request('/api/member/interview-slots/slot-1/claim', { method: 'POST' });

    expect(res.status).toBe(201);
    expect(notifyInterviewer).toHaveBeenCalledWith('slot-1', 'member-1', 'INTERVIEWER_ASSIGNED', {
      selfSignup: true,
    });
  });

  it('says nothing when the claim was refused', async () => {
    // Already staffing it: no new seat, so no new entry.
    tx.interviewSlotAssignment.findFirst.mockResolvedValueOnce({ id: 'asn-existing' });

    const res = await request('/api/member/interview-slots/slot-1/claim', { method: 'POST' });

    expect(res.status).toBe(409);
    expect(notifyInterviewer).not.toHaveBeenCalled();
  });
});

describe('a member dropping out of a session', () => {
  beforeEach(() => {
    prisma.interviewSlotAssignment.findUnique.mockResolvedValue({
      id: 'asn-1',
      userId: 'member-1',
      slotId: 'slot-1',
      removedAt: null,
    });
    prisma.interviewSlotAssignment.update.mockResolvedValue({ id: 'asn-1' });
  });

  it('cancels the calendar entry instead of leaving it sitting there', async () => {
    const res = await request('/api/member/interview-slot-assignments/asn-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(notifyInterviewer).toHaveBeenCalledWith('slot-1', 'member-1', 'INTERVIEWER_REMOVED');
  });

  it('does not re-cancel one that was already dropped', async () => {
    prisma.interviewSlotAssignment.findUnique.mockResolvedValue({
      id: 'asn-1',
      userId: 'member-1',
      slotId: 'slot-1',
      removedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const res = await request('/api/member/interview-slot-assignments/asn-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(notifyInterviewer).not.toHaveBeenCalled();
  });
});

describe('adopting a round of legacy groups into sessions', () => {
  beforeEach(() => {
    actingAs = adminUser;
    prisma.interview.findUnique.mockResolvedValue({
      id: 'int-1',
      startDate: new Date('2026-10-06T16:00:00.000Z'),
      endDate: new Date('2026-10-06T18:00:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      slots: [],
      description: JSON.stringify({
        applicationGroups: [
          { id: 'grp-1', name: 'Group 1', applicationIds: ['app-1'] },
          { id: 'grp-2', name: 'Group 2', applicationIds: ['app-2'] },
        ],
        memberGroups: [{ id: 'mg-1', memberIds: ['member-1', 'member-2'] }],
        groupAssignments: { 'mg-1': ['grp-1', 'grp-2'] },
      }),
    });
    tx.interviewSlot.create.mockImplementation(({ data }) => ({ id: `slot-for-${data.legacyGroupId}` }));
    tx.interviewSlotSignup.findFirst.mockResolvedValue(null);
    tx.interviewSlotSignup.create.mockResolvedValue({ id: 'sig-1' });
    tx.interviewSlotAssignment.create.mockResolvedValue({ id: 'asn-1' });
  });

  it('tells every interviewer it just put on a session', async () => {
    const res = await request('/api/admin/interviews/int-1/adopt-sessions', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(notifyInterviewersBulk).toHaveBeenCalledTimes(1);
    expect(notifyInterviewersBulk).toHaveBeenCalledWith([
      { slotId: 'slot-for-grp-1', userId: 'member-1' },
      { slotId: 'slot-for-grp-1', userId: 'member-2' },
      { slotId: 'slot-for-grp-2', userId: 'member-1' },
      { slotId: 'slot-for-grp-2', userId: 'member-2' },
    ]);
  });

  it('sends one batch after every group has committed, not one per group', async () => {
    // Queueing inside the per-group transaction would re-send on a serialisation
    // retry, which is the rule withSerializableTransaction states outright.
    await request('/api/admin/interviews/int-1/adopt-sessions', { method: 'POST' });

    const [pairs] = notifyInterviewersBulk.mock.calls[0];
    expect(new Set(pairs.map((p) => p.slotId)).size).toBe(2);
  });
});
