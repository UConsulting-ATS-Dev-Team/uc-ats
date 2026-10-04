// Nobody but an admin decides who is in a virtual coffee chat. These pin the
// three doors that would otherwise let somebody in or out on their own: a
// candidate changing or cancelling the booking, a member claiming the session,
// and a member leaving it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../prismaClient.js', () => {
  const tx = {
    interviewSlot: { findUnique: vi.fn() },
    interviewSlotAssignment: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  };
  return {
    default: {
      __tx: tx,
      interviewSlotSignup: { findFirst: vi.fn() },
      interviewSlotAssignment: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn((fn) => fn(tx)),
    },
  };
});

let currentUser = { id: 'cand-1', role: 'USER' };
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = currentUser;
    next();
  },
}));
vi.mock('../services/activeCycle.js', () => ({
  resolveCandidateCycle: vi.fn(async () => ({ id: 'c1' })),
  resolveAdminCycle: vi.fn(async () => ({ id: 'c1' })),
}));
vi.mock('../utils/applicationOwnership.js', () => ({
  AmbiguousApplicationError: class extends Error {},
  findOwnApplication: vi.fn(async () => ({ id: 'app-1', status: 'UNDER_REVIEW', currentRound: '2' })),
}));
vi.mock('../services/candidateSchedulingView.js', () => ({
  checkCanBookSlot: vi.fn(async () => null),
  getBookingOptions: vi.fn(),
  getOwnSignups: vi.fn(),
}));
vi.mock('../services/interviewSignups.js', () => ({
  cancelSignup: vi.fn(),
  claimWithFallback: vi.fn(),
  moveSignup: vi.fn(),
}));
vi.mock('../services/interviewSlotComms.js', () => ({
  slotNotificationSubject: vi.fn(),
  slotSubjectFormatter: vi.fn(),
  flushNotifications: vi.fn(async () => {}),
  queueNotifications: vi.fn(async () => []),
}));
vi.mock('../services/emailNotifications.js', () => ({ renderInterviewSlotEmail: vi.fn() }));
vi.mock('../services/interviewerInvites.js', () => ({ notifyInterviewer: vi.fn(async () => {}) }));

const prisma = (await import('../prismaClient.js')).default;
const signups = await import('../services/interviewSignups.js');
const candidateRoutes = (await import('./candidateInterviewSignups.js')).default;
const memberRoutes = (await import('./interviewSlotsMember.js')).default;

let server;
let port;
const call = (path, method, body) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/my-interview-signups', candidateRoutes);
  app.use('/api/member', (req, res, next) => {
    req.user = currentUser;
    next();
  }, memberRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'cand-1', role: 'USER' };
});

const ownedSignup = (isVirtual) => ({ id: 'su-1', slot: { interview: { isVirtual } } });

describe('a candidate in a virtual coffee chat', () => {
  it('cannot switch it to another time', async () => {
    prisma.interviewSlotSignup.findFirst.mockResolvedValue(ownedSignup(true));
    const res = await call('/api/my-interview-signups/su-1', 'PATCH', { slotId: 'slot-morning' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VIRTUAL_CHAT_LOCKED');
    expect(signups.moveSignup).not.toHaveBeenCalled();
  });

  it('cannot cancel it', async () => {
    prisma.interviewSlotSignup.findFirst.mockResolvedValue(ownedSignup(true));
    const res = await call('/api/my-interview-signups/su-1', 'DELETE');
    expect(res.status).toBe(409);
    expect(signups.cancelSignup).not.toHaveBeenCalled();
  });

  it('still cancels an ordinary booking', async () => {
    prisma.interviewSlotSignup.findFirst.mockResolvedValue(ownedSignup(false));
    signups.cancelSignup.mockResolvedValue({ promotions: [] });
    const res = await call('/api/my-interview-signups/su-1', 'DELETE');
    expect(res.status).toBe(200);
    expect(signups.cancelSignup).toHaveBeenCalled();
  });
});

describe('a member and a virtual coffee chat', () => {
  beforeEach(() => {
    currentUser = { id: 'm1', role: 'MEMBER' };
  });

  it('cannot claim the session', async () => {
    prisma.__tx.interviewSlot.findUnique.mockResolvedValue({
      id: 'slot-v',
      interviewId: 'chat-1',
      interview: { id: 'chat-1', cycleId: 'c1', status: 'UPCOMING', isVirtual: true },
    });
    const res = await call('/api/member/interview-slots/slot-v/claim', 'POST');
    expect(res.status).toBe(403);
    expect(prisma.__tx.interviewSlotAssignment.create).not.toHaveBeenCalled();
  });

  it('cannot take themselves off it', async () => {
    prisma.interviewSlotAssignment.findUnique.mockResolvedValue({
      id: 'as-1',
      userId: 'm1',
      removedAt: null,
      slotId: 'slot-v',
      slot: { interview: { isVirtual: true } },
    });
    const res = await call('/api/member/interview-slot-assignments/as-1', 'DELETE');
    expect(res.status).toBe(403);
    expect(prisma.interviewSlotAssignment.update).not.toHaveBeenCalled();
  });

  it('can still leave an ordinary session', async () => {
    prisma.interviewSlotAssignment.findUnique.mockResolvedValue({
      id: 'as-1',
      userId: 'm1',
      removedAt: null,
      slotId: 'slot-1',
      slot: { interview: { isVirtual: false } },
    });
    const res = await call('/api/member/interview-slot-assignments/as-1', 'DELETE');
    expect(res.status).toBe(200);
    expect(prisma.interviewSlotAssignment.update).toHaveBeenCalled();
  });
});
