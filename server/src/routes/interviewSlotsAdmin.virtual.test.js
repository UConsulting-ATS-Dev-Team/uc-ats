// A virtual coffee chat's time, link and existence change only through its own
// panel, which emails the people in it. The generic interview and session
// endpoints would change them silently, so they refuse.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../prismaClient.js', () => ({
  default: {
    interview: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    interviewSlot: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    interviewSlotSignup: { count: vi.fn() },
    application: { groupBy: vi.fn(), findMany: vi.fn() },
    interviewSlotNotification: { groupBy: vi.fn() },
    $transaction: vi.fn((arg) => Promise.all(arg)),
  },
}));
vi.mock('../services/activeCycle.js', () => ({ resolveAdminCycle: vi.fn(async () => ({ id: 'c1', name: 'Fall' })) }));

const prisma = (await import('../prismaClient.js')).default;
const routes = (await import('./interviewSlotsAdmin.js')).default;

let server;
let port;
const call = (path, method, body) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (req, res, next) => {
    req.user = { id: 'admin-1', role: 'ADMIN' };
    next();
  });
  app.use('/api/admin', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.interview.findUnique.mockResolvedValue({ isVirtual: true });
  prisma.interviewSlot.findUnique.mockResolvedValue({
    interview: { isVirtual: true },
    startTime: new Date('2030-01-01T02:00:00Z'),
    endTime: new Date('2030-01-01T02:30:00Z'),
  });
  prisma.interview.update.mockResolvedValue({ id: 'chat-1' });
  prisma.interviewSlot.count.mockResolvedValue(1);
});

describe('generic endpoints and a virtual coffee chat', () => {
  it('will not retime its session', async () => {
    const res = await call('/interviews/slots/slot-v', 'PATCH', { startTime: '2030-01-02T02:00:00Z' });
    expect(res.status).toBe(409);
    expect(prisma.interviewSlot.update).not.toHaveBeenCalled();
  });

  it('will not change its link', async () => {
    const res = await call('/interviews/chat-1', 'PATCH', { location: 'https://example.com/other' });
    expect(res.status).toBe(409);
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it('will not mark it cancelled behind the panel', async () => {
    const res = await call('/interviews/chat-1', 'PATCH', { status: 'CANCELLED' });
    expect(res.status).toBe(409);
  });

  it('will not reschedule it', async () => {
    const res = await call('/interviews/chat-1/reschedule', 'POST', { shiftMinutes: 60 });
    expect(res.status).toBe(409);
    expect(prisma.interviewSlot.findMany).not.toHaveBeenCalled();
  });

  it('will not delete its only session', async () => {
    const res = await call('/interviews/slots/slot-v', 'DELETE');
    expect(res.status).toBe(409);
    expect(prisma.interviewSlot.delete).not.toHaveBeenCalled();
  });

  it('still allows a harmless edit such as the title', async () => {
    const res = await call('/interviews/chat-1', 'PATCH', { title: 'Evening chat' });
    expect(res.status).toBe(200);
    expect(prisma.interview.update).toHaveBeenCalled();
  });

  it('leaves an in-person session editable as before', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue({
      interview: { isVirtual: false },
      startTime: new Date('2030-01-01T17:00:00Z'),
      endTime: new Date('2030-01-01T20:00:00Z'),
    });
    prisma.interviewSlot.update.mockResolvedValue({ id: 'slot-am' });
    const res = await call('/interviews/slots/slot-am', 'PATCH', { endTime: '2030-01-01T21:00:00Z' });
    expect(res.status).toBe(200);
  });
});

describe('scheduling overview with virtual chats', () => {
  it('counts only people still in the round as placed virtually', async () => {
    const signup = (id, application) => ({ id, status: 'CONFIRMED', applicationId: application.id, slotId: 'slot-v', application });
    prisma.interview.findMany.mockResolvedValue([
      {
        id: 'chat-1',
        title: 'Virtual Coffee Chat',
        interviewType: 'COFFEE_CHAT',
        isVirtual: true,
        location: 'https://zoom.us/j/1',
        startDate: new Date('2030-01-01T02:00:00Z'),
        status: 'UPCOMING',
        slots: [
          {
            id: 'slot-v',
            label: null,
            startTime: new Date('2030-01-01T02:00:00Z'),
            endTime: new Date('2030-01-01T02:30:00Z'),
            candidateCapacity: null,
            assignments: [],
            signups: [
              signup('su-1', { id: 'a1', currentRound: '2', status: 'UNDER_REVIEW' }),
              // Advanced to first round since; no longer counted in eligible.
              signup('su-2', { id: 'a2', currentRound: '3', status: 'UNDER_REVIEW' }),
              // Rejected since.
              signup('su-3', { id: 'a3', currentRound: '2', status: 'REJECTED' }),
            ],
          },
        ],
      },
    ]);
    prisma.application.groupBy.mockResolvedValue([{ currentRound: '2', _count: { _all: 5 } }]);
    prisma.application.findMany.mockResolvedValue([]);
    prisma.interviewSlotNotification.groupBy.mockResolvedValue([]);

    const res = await call('/scheduling/overview', 'GET');
    const coffee = (await res.json()).rounds.find((r) => r.round === '2');

    expect(coffee.stats.virtualPlaced).toBe(1);
    expect(coffee.stats.virtualSessions).toBe(1);
    expect(coffee.stats.sessions).toBe(0);
  });
});
